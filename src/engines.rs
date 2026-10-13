//! Running the external sync engines (alass, ffsubsync, autosubsync).
//!
//! Processes are spawned directly with an argument vector — no shell, so file
//! names with quotes, `$` or backticks are safe — in their own process group,
//! so a timeout or Skip kills ffsubsync's ffmpeg children too instead of
//! leaving them decoding in the background.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::models::EngineResult;
use crate::srt;
use crate::video::srt_stem;

/// Output kept from an engine's stdout/stderr while it runs (the rest is
/// drained and discarded so a chatty engine can never block on a full pipe).
const CAPTURE_LIMIT: usize = 64 * 1024;
/// What gets persisted per engine result.
const PERSIST_LIMIT: usize = 1000;

pub enum Exec {
    Finished { success: bool, code: Option<i32>, stdout: String, stderr: String },
    TimedOut { stdout: String, stderr: String },
    Cancelled,
    SpawnFailed(String),
}

async fn capture<R: AsyncRead + Unpin>(mut r: R) -> String {
    let mut kept = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = CAPTURE_LIMIT.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    String::from_utf8_lossy(&kept).into_owned()
}

fn kill_group(pid: Option<u32>, sig: libc::c_int) {
    if let Some(pid) = pid {
        // SAFETY: plain syscall; pid is our own child's process group.
        unsafe {
            libc::killpg(pid as libc::pid_t, sig);
        }
    }
}

pub async fn exec(bin: &str, args: &[&Path], timeout: Duration, cancel: &CancellationToken) -> Exec {
    let mut cmd = Command::new(bin);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Exec::SpawnFailed(format!("failed to start {bin}: {e}")),
    };
    let pid = child.id();
    let out = tokio::spawn(capture(child.stdout.take().unwrap()));
    let err = tokio::spawn(capture(child.stderr.take().unwrap()));

    enum End {
        Exit(std::io::Result<std::process::ExitStatus>),
        Timeout,
        Cancel,
    }
    let end = tokio::select! {
        s = child.wait() => End::Exit(s),
        _ = tokio::time::sleep(timeout) => End::Timeout,
        _ = cancel.cancelled() => End::Cancel,
    };
    if !matches!(end, End::Exit(_)) {
        kill_group(pid, libc::SIGTERM);
        if tokio::time::timeout(Duration::from_secs(3), child.wait()).await.is_err() {
            kill_group(pid, libc::SIGKILL);
            let _ = child.wait().await;
        }
    }
    let stdout = out.await.unwrap_or_default();
    let stderr = err.await.unwrap_or_default();
    match end {
        End::Exit(Ok(status)) => Exec::Finished { success: status.success(), code: status.code(), stdout, stderr },
        End::Exit(Err(e)) => Exec::SpawnFailed(e.to_string()),
        End::Timeout => Exec::TimedOut { stdout, stderr },
        End::Cancel => Exec::Cancelled,
    }
}

fn clip(s: &str, n: usize) -> Option<String> {
    if s.is_empty() {
        return None;
    }
    Some(s.chars().take(n).collect())
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// `<dir>/<stem>.<engine>.srt` — standard-mode sidecar / autosubsync output.
pub fn sidecar_path(srt_path: &Path, engine: &str) -> PathBuf {
    srt_path.with_file_name(format!("{}.{engine}.srt", srt_stem(srt_path)))
}

pub struct EngineRun {
    pub result: EngineResult,
    pub cancelled: bool,
}

fn fail(message: String, stdout: &str, stderr: &str) -> EngineResult {
    EngineResult {
        success: false,
        message,
        stdout: clip(stdout, PERSIST_LIMIT),
        stderr: clip(stderr, PERSIST_LIMIT),
        ..Default::default()
    }
}

/// alass / ffsubsync: align `srt_path` against `reference` (a video, or a
/// synced anchor subtitle) and install the output in place. The original is
/// backed up first and restored on every failure path; output with no
/// parseable cues or a first-cue shift beyond `max_shift_ms` is rejected.
#[allow(clippy::too_many_arguments)]
pub async fn run_in_place(
    engine: &str,
    bin: &str,
    srt_path: &Path,
    reference: &Path,
    timeout: Duration,
    max_shift_ms: i64,
    no_split: bool,
    cancel: &CancellationToken,
) -> EngineRun {
    let started = Instant::now();
    let name = file_name(srt_path);
    let stem = srt_stem(srt_path);
    let temp = srt_path.with_file_name(format!(".{stem}.{engine}-tmp.srt"));
    let backup = srt_path.with_file_name(format!(".{stem}.srt.bak"));
    let original = std::fs::read(srt_path).ok();

    let done = |mut r: EngineResult, cancelled: bool| {
        r.duration = started.elapsed().as_millis() as i64;
        EngineRun { result: r, cancelled }
    };
    let restore = || {
        let _ = std::fs::remove_file(&temp);
        let _ = std::fs::rename(&backup, srt_path);
    };

    if let Err(e) = std::fs::copy(srt_path, &backup) {
        let _ = std::fs::remove_file(&backup);
        return done(fail(format!("Fatal error processing {name}: {e}"), "", ""), false);
    }

    let args: Vec<&Path> = match engine {
        // --no-split: one global offset. For forced subs, split mode lets alass
        // place each of a handful of sparse cues independently.
        "alass" if no_split => vec![Path::new("--no-split"), reference, srt_path, &temp],
        "alass" => vec![reference, srt_path, &temp],
        _ => vec![reference, Path::new("-i"), srt_path, Path::new("-o"), &temp],
    };
    tracing::debug!("Processing: {bin} {:?}", args);

    match exec(bin, &args, timeout, cancel).await {
        Exec::Cancelled => {
            restore();
            done(fail(format!("Skipped: {name} was cancelled by user"), "", ""), true)
        }
        Exec::TimedOut { stdout, stderr } => {
            restore();
            done(
                fail(format!("Timeout: {engine} took longer than {}s for {name}", timeout.as_secs()), &stdout, &stderr),
                false,
            )
        }
        Exec::SpawnFailed(e) => {
            restore();
            done(fail(format!("Error processing {name}: {e}"), "", ""), false)
        }
        Exec::Finished { success: false, code, stdout, stderr } => {
            restore();
            let tail: String = stderr.chars().take(300).collect();
            let msg = format!(
                "Error processing {name}: {engine} exited with code {}{}",
                code.map_or("?".into(), |c| c.to_string()),
                if tail.is_empty() { String::new() } else { format!(" -- stderr: {tail}") }
            );
            done(fail(msg, &stdout, &stderr), false)
        }
        Exec::Finished { success: true, stdout, stderr, .. } => {
            if !temp.exists() {
                restore();
                return done(fail(format!("{engine} did not produce output file for {name}"), &stdout, &stderr), false);
            }
            let output = std::fs::read(&temp).unwrap_or_default();
            if !srt::has_cues(&output) {
                restore();
                return done(
                    fail(format!("{engine} produced empty or unparseable output for {name}"), &stdout, &stderr),
                    false,
                );
            }
            // Median shift over all cues, not the first cue: alass in split
            // mode often moves only an intro cue, which said nothing about fit.
            if let Some(orig) = &original {
                let shift = srt::subtitle_offset_ms(orig, &output).abs();
                if shift > max_shift_ms {
                    restore();
                    let mut r = fail(
                        format!(
                            "Shift too large: {shift}ms (max: {max_shift_ms}ms). Subtitle likely does not match this video."
                        ),
                        &stdout,
                        &stderr,
                    );
                    r.shift_too_large = true;
                    r.original_shift_ms = Some(shift);
                    return done(r, false);
                }
            }
            if let Err(e) = std::fs::rename(&temp, srt_path) {
                restore();
                return done(
                    fail(format!("Could not install {engine} output for {name}: {e}"), &stdout, &stderr),
                    false,
                );
            }
            let _ = std::fs::remove_file(&backup);
            done(
                EngineResult {
                    success: true,
                    message: format!("Successfully synced: {name}"),
                    stdout: clip(&stdout, PERSIST_LIMIT),
                    stderr: clip(&stderr, PERSIST_LIMIT),
                    ..Default::default()
                },
                false,
            )
        }
    }
}

/// autosubsync writes a sidecar (`<stem>.autosubsync.srt`); the caller reads
/// and removes it.
pub async fn run_autosubsync(
    bin: &str,
    srt_path: &Path,
    video: &Path,
    timeout: Duration,
    skip_if_exists: bool,
    cancel: &CancellationToken,
) -> EngineRun {
    let started = Instant::now();
    let output = sidecar_path(srt_path, "autosubsync");
    let out_name = output.display().to_string();
    let done = |mut r: EngineResult, cancelled: bool| {
        r.duration = started.elapsed().as_millis() as i64;
        EngineRun { result: r, cancelled }
    };
    if skip_if_exists && output.exists() {
        return done(
            EngineResult {
                success: true,
                skipped: true,
                message: format!("Skipping {out_name} - already processed"),
                ..Default::default()
            },
            false,
        );
    }
    match exec(bin, &[video, srt_path, &output], timeout, cancel).await {
        Exec::Cancelled => done(fail(format!("Skipped: {out_name} was cancelled by user"), "", ""), true),
        Exec::TimedOut { stdout, stderr } => {
            done(fail(format!("Timeout: {out_name} took longer than allowed timeout"), &stdout, &stderr), false)
        }
        Exec::SpawnFailed(e) => done(fail(format!("Error processing {out_name}: {e}"), "", ""), false),
        Exec::Finished { success: false, code, stdout, stderr } => done(
            fail(
                format!("Error processing {out_name}: exited with code {}", code.map_or("?".into(), |c| c.to_string())),
                &stdout,
                &stderr,
            ),
            false,
        ),
        Exec::Finished { success: true, stdout, stderr, .. } => done(
            EngineResult {
                success: true,
                message: format!("Successfully processed: {out_name}"),
                stdout: clip(&stdout, PERSIST_LIMIT),
                stderr: clip(&stderr, PERSIST_LIMIT),
                ..Default::default()
            },
            false,
        ),
    }
}
