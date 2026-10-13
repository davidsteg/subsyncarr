//! Embedded text subtitle tracks as sync reference.
//!
//! A text track muxed into the video (MKV, MP4) is timed to that exact video,
//! so aligning sub-to-sub against it is faster than decoding audio and works
//! for forced subs, whose handful of cues give audio alignment little to lock
//! onto. Bitmap tracks (PGS, VobSub) carry no timing text an engine can read
//! and are ignored.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::engines::{exec, Exec};
use crate::srt;

const TEXT_CODECS: [&str; 7] = ["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"];
/// Titles that mark a sparse or off-timeline track even without a forced flag.
const SKIP_TITLE_WORDS: [&str; 4] = ["forced", "sign", "song", "commentary"];
/// Tracks extracted per video (all in one ffmpeg pass).
const MAX_CANDIDATES: usize = 8;
/// A reference with fewer cues is likely a partial track; use the audio.
pub const MIN_REFERENCE_CUES: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub struct Track {
    pub index: u64,
    pub language: Option<String>,
    pub title: Option<String>,
}

impl std::fmt::Display for Track {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "#{}", self.index)?;
        match (&self.language, &self.title) {
            (Some(l), Some(t)) => write!(f, " ({l}, \"{t}\")"),
            (Some(l), None) => write!(f, " ({l})"),
            (None, Some(t)) => write!(f, " (\"{t}\")"),
            (None, None) => Ok(()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Reference {
    pub path: PathBuf,
    pub track: Track,
    pub cues: usize,
}

/// Full-length text tracks from `ffprobe -of json` output, in stream order.
pub fn candidate_tracks(probe_json: &str) -> Vec<Track> {
    let Ok(v) = serde_json::from_str::<Value>(probe_json) else {
        return Vec::new();
    };
    let Some(streams) = v.get("streams").and_then(Value::as_array) else {
        return Vec::new();
    };
    let flag = |s: &Value, k: &str| s.pointer(&format!("/disposition/{k}")).and_then(Value::as_i64) == Some(1);
    let tag = |s: &Value, k: &str| {
        s.get("tags")
            .and_then(Value::as_object)
            .and_then(|t| t.iter().find(|(name, _)| name.eq_ignore_ascii_case(k)))
            .and_then(|(_, v)| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(String::from)
    };
    streams
        .iter()
        .filter(|s| s.get("codec_type").and_then(Value::as_str) == Some("subtitle"))
        .filter(|s| s.get("codec_name").and_then(Value::as_str).is_some_and(|c| TEXT_CODECS.contains(&c)))
        .filter(|s| !flag(s, "forced") && !flag(s, "comment"))
        .filter_map(|s| {
            let title = tag(s, "title");
            let lower = title.as_deref().unwrap_or_default().to_lowercase();
            if SKIP_TITLE_WORDS.iter().any(|w| lower.contains(w)) {
                return None;
            }
            Some(Track { index: s.get("index")?.as_u64()?, language: tag(s, "language"), title })
        })
        .take(MAX_CANDIDATES)
        .collect()
}

fn stderr_tail(stderr: &str) -> String {
    let t = stderr.trim();
    let tail: String = t.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
    if tail.is_empty() {
        String::new()
    } else {
        format!(": {tail}")
    }
}

fn exec_error(tool: &str, e: Exec) -> String {
    match e {
        Exec::Finished { code, stderr, .. } => {
            format!("{tool} exited with code {}{}", code.map_or("?".into(), |c| c.to_string()), stderr_tail(&stderr))
        }
        Exec::TimedOut { .. } => format!("{tool} timed out"),
        Exec::Cancelled => "cancelled".into(),
        Exec::SpawnFailed(e) => e,
    }
}

/// Probe `video`, extract every candidate text track into `dir` in one pass
/// and return the one with the most cues. `Err` says why the audio is used.
pub async fn extract_reference(
    ffprobe: &str,
    ffmpeg: &str,
    video: &Path,
    dir: &Path,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Reference, String> {
    let probe_args = [
        "-v",
        "error",
        "-select_streams",
        "s",
        "-show_entries",
        "stream=index,codec_name,codec_type:stream_tags=language,title:stream_disposition=forced,comment",
        "-of",
        "json",
    ];
    let mut args: Vec<&Path> = probe_args.iter().map(Path::new).collect();
    args.push(video);
    let tracks = match exec(ffprobe, &args, timeout, cancel).await {
        Exec::Finished { success: true, stdout, .. } => candidate_tracks(&stdout),
        other => return Err(exec_error("ffprobe", other)),
    };
    if tracks.is_empty() {
        return Err("no full-length text subtitle track".into());
    }

    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let outputs: Vec<PathBuf> = tracks.iter().map(|t| dir.join(format!("track-{}.srt", t.index))).collect();
    let maps: Vec<String> = tracks.iter().map(|t| format!("0:{}", t.index)).collect();
    let mut owned: Vec<&Path> = ["-nostdin", "-v", "error", "-y", "-i"].iter().map(Path::new).collect();
    owned.push(video);
    for (map, out) in maps.iter().zip(&outputs) {
        owned.extend([Path::new("-map"), Path::new(map), Path::new("-c:s"), Path::new("srt"), out.as_path()]);
    }
    let extracted = exec(ffmpeg, &owned, timeout, cancel).await;
    let ok = matches!(extracted, Exec::Finished { success: true, .. });

    let mut best: Option<Reference> = None;
    for (track, path) in tracks.into_iter().zip(outputs) {
        let cues = if ok { std::fs::read(&path).map(|b| srt::count_cues(&b)).unwrap_or(0) } else { 0 };
        if best.as_ref().map_or(true, |b| cues > b.cues) {
            if let Some(old) = best.replace(Reference { path, track, cues }) {
                let _ = std::fs::remove_file(old.path);
            }
        } else {
            let _ = std::fs::remove_file(path);
        }
    }
    if !ok {
        if let Some(b) = best {
            let _ = std::fs::remove_file(b.path);
        }
        return Err(exec_error("ffmpeg", extracted));
    }
    match best {
        Some(b) if b.cues >= MIN_REFERENCE_CUES => Ok(b),
        Some(b) => {
            let _ = std::fs::remove_file(&b.path);
            Err(format!("largest text track {} has only {} cues (need {MIN_REFERENCE_CUES})", b.track, b.cues))
        }
        None => Err("no text subtitle track could be extracted".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_full_length_text_tracks() {
        let json = r#"{"streams":[
            {"index":2,"codec_name":"hdmv_pgs_subtitle","codec_type":"subtitle","disposition":{"forced":0}},
            {"index":3,"codec_name":"subrip","codec_type":"subtitle","disposition":{"forced":1},"tags":{"language":"eng"}},
            {"index":4,"codec_name":"ass","codec_type":"subtitle","disposition":{"forced":0},"tags":{"title":"Signs & Songs"}},
            {"index":5,"codec_name":"subrip","codec_type":"subtitle","disposition":{"forced":0,"comment":1}},
            {"index":6,"codec_name":"subrip","codec_type":"subtitle","disposition":{"forced":0},"tags":{"language":"eng","title":"SDH"}},
            {"index":7,"codec_name":"mov_text","codec_type":"subtitle","tags":{"LANGUAGE":"ger"}}
        ]}"#;
        let t = candidate_tracks(json);
        assert_eq!(t.iter().map(|t| t.index).collect::<Vec<_>>(), vec![6, 7]);
        assert_eq!(t[0].to_string(), "#6 (eng, \"SDH\")");
        assert_eq!(t[1].language.as_deref(), Some("ger"));
    }

    #[test]
    fn bad_probe_output_means_no_tracks() {
        assert!(candidate_tracks("").is_empty());
        assert!(candidate_tracks("{}").is_empty());
        assert!(candidate_tracks(r#"{"streams":[{"codec_type":"subtitle","codec_name":"subrip"}]}"#).is_empty());
    }
}
