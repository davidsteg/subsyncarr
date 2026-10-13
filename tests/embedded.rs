//! Embedded subtitle tracks as sync reference: real ffprobe/ffmpeg on a small
//! generated MKV, a fake engine for the alignment. Skipped when ffmpeg is not
//! installed.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use subsyncarr::{config::Config, logbuf::LogBuffer};

fn srt(cues: usize) -> String {
    (0..cues)
        .map(|i| {
            let s = 10 + i * 2;
            format!("{}\n{} --> {}\nLine {i}\n\n", i + 1, ts(s * 1000), ts(s * 1000 + 500))
        })
        .collect()
}

fn ts(ms: usize) -> String {
    format!("00:{:02}:{:02},{:03}", ms / 60_000, ms / 1000 % 60, ms % 1000)
}

fn script(dir: &Path, engine: &str) -> String {
    let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_engine.py");
    let p = dir.join(engine);
    std::fs::write(&p, format!("#!/bin/sh\nexec python3 '{}' {engine} \"$@\"\n", fake.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p.display().to_string()
}

/// An MKV with one full-length and one forced text track, no audio needed.
fn mkv_with_tracks(dir: &Path, name: &str) -> PathBuf {
    let full = dir.join("full.tmp");
    let forced = dir.join("forced.tmp");
    std::fs::write(&full, srt(80)).unwrap();
    std::fs::write(&forced, srt(3)).unwrap();
    let out = dir.join(name);
    let ok = Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-y", "-f", "srt", "-i"])
        .arg(&full)
        .args(["-f", "srt", "-i"])
        .arg(&forced)
        .args([
            "-map",
            "0",
            "-map",
            "1",
            "-c:s",
            "srt",
            "-metadata:s:s:0",
            "language=eng",
            "-disposition:s:1",
            "forced",
        ])
        .arg(&out)
        .status()
        .unwrap()
        .success();
    assert!(ok, "ffmpeg could not build the test video");
    std::fs::remove_file(full).unwrap();
    std::fs::remove_file(forced).unwrap();
    out
}

fn add_sub(dir: &Path, name: &str, cues: usize) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, srt(cues)).unwrap();
    p
}

async fn wait_idle(p: &subsyncarr::processor::Processor) {
    for _ in 0..600 {
        if !p.is_running() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("run did not finish");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn embedded_track_reference() {
    if Command::new("ffmpeg").arg("-version").output().is_err()
        || Command::new("ffprobe").arg("-version").output().is_err()
    {
        eprintln!("ffmpeg/ffprobe not installed — skipping");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let media = tmp.path().join("media");
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = tmp.path().join("engine.log");

    // A video with an embedded track: anchor, follower and a forced sub.
    let movie = media.join("Movie");
    std::fs::create_dir_all(&movie).unwrap();
    let movie_video = mkv_with_tracks(&movie, "Movie.mkv");
    let movie_de = add_sub(&movie, "Movie.de.srt", 40);
    let movie_en = add_sub(&movie, "Movie.en.srt", 30);
    let movie_forced = add_sub(&movie, "Movie.en.forced.srt", 3);

    // Engines disagree against the embedded track: retried against audio.
    let other = media.join("Other");
    std::fs::create_dir_all(&other).unwrap();
    let other_video = mkv_with_tracks(&other, "Other.mkv");
    let other_sub = add_sub(&other, "Other.mismatch.en.srt", 20);

    // No embedded track (not a real video): audio as before.
    let plain = media.join("Plain");
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::write(plain.join("Plain.mkv"), b"not really a video").unwrap();
    let plain_sub = add_sub(&plain, "Plain.en.srt", 20);

    // SAFETY: set before any other thread in this test binary reads the env.
    unsafe {
        std::env::set_var("SCAN_PATHS", media.display().to_string());
        std::env::set_var("DB_PATH", tmp.path().join("data/test.db").display().to_string());
        std::env::set_var("ALASS_BIN", script(&bin, "alass"));
        std::env::set_var("FFSUBSYNC_BIN", script(&bin, "ffsubsync"));
        std::env::set_var("INCLUDE_ENGINES", "alass,ffsubsync");
        std::env::set_var("FAKE_ENGINE_LOG", log.display().to_string());
    }
    let app = subsyncarr::build(Config::from_env(), LogBuffer::new(100)).await.unwrap();
    let st = app.state.clone();
    let run_id = st.processor.start_run(None, None).await.unwrap();
    wait_idle(&st.processor).await;

    let run = st.db.get_run(&run_id).await.unwrap().unwrap();
    assert_eq!(run.total_files, 5);
    assert_eq!(run.completed_engines, run.total_engines, "the audio retry must not inflate progress");
    let (files, _) = st.db.files_paginated(&run_id, 100, 0, None).await.unwrap();
    let status_of =
        |p: &PathBuf| files.iter().find(|f| Path::new(&f.file_path) == p).map(|f| f.status.clone()).unwrap_or_default();

    let calls = std::fs::read_to_string(&log).unwrap();
    let calls_for = |sub: &Path| -> Vec<Vec<String>> {
        let s = sub.display().to_string();
        calls.lines().filter(|l| l.contains(&s)).map(|l| l.split(' ').map(String::from).collect()).collect::<Vec<_>>()
    };
    // Reference argument of a logged call (alass: first non-flag; ffsubsync: first).
    let reference =
        |c: &[String]| -> String { c[1..].iter().find(|a| !a.starts_with("--")).cloned().unwrap_or_default() };
    let is_extracted = |r: &str| r.contains("subsyncarr-ref-") && r.ends_with(".srt");

    // Anchor and forced sub sync against the extracted track; the follower
    // against the synced anchor.
    for sub in [&movie_de, &movie_forced] {
        assert_eq!(status_of(sub), "completed", "{}", sub.display());
        let c = calls_for(sub);
        assert_eq!(c.len(), 2);
        assert!(c.iter().all(|c| is_extracted(&reference(c))), "{c:?}");
    }
    assert!(calls_for(&movie_forced).iter().any(|c| c[0] == "alass" && c[1] == "--no-split"));
    assert_eq!(status_of(&movie_en), "completed");
    assert!(calls_for(&movie_en).iter().all(|c| reference(c).contains(".anchor-ref.srt")));
    assert!(std::fs::read_to_string(&movie_forced).unwrap().contains("00:00:11,500 -->"));

    // Disagreement against the track → second pass against the video.
    let c = calls_for(&other_sub);
    assert_eq!(c.len(), 4, "{c:?}");
    assert!(is_extracted(&reference(&c[0])) && is_extracted(&reference(&c[1])));
    assert_eq!(reference(&c[2]), other_video.display().to_string());
    assert_eq!(reference(&c[3]), other_video.display().to_string());
    assert_eq!(status_of(&other_sub), "not_fitting");

    // No usable track → the video.
    assert_eq!(status_of(&plain_sub), "completed");
    assert!(calls_for(&plain_sub).iter().all(|c| reference(c).ends_with("Plain.mkv")));

    // Extracted tracks never land in the library and are gone after the run.
    assert!(!std::env::temp_dir().join(format!("subsyncarr-ref-{run_id}")).exists());
    assert!(movie_video.exists());
    for e in std::fs::read_dir(&movie).unwrap().flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        assert!(!n.contains("track-"), "leftover {n}");
    }
}
