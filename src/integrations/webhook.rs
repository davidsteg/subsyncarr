//! Inbound webhooks: Sonarr, Radarr and Bazarr (or anything that can send
//! a path) trigger a sync of specific files instead of waiting for the next
//! scheduled scan.
//!
//! Requests are collected for a short quiet period and then started as one
//! run over just those paths. If a run is already in progress the paths
//! wait for it to finish, so nothing sent is ever dropped.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;
use tracing::{error, info};

use super::PathMap;
use crate::config::ScanConfig;
use crate::processor::{Processor, RunError};

pub const SOURCES: [&str; 4] = ["sonarr", "radarr", "bazarr", "generic"];
pub const DEFAULT_DEBOUNCE: Duration = Duration::from_secs(5);
const BUSY_POLL: Duration = Duration::from_secs(5);

/// What a webhook body asks for.
#[derive(Debug, PartialEq)]
pub enum Request {
    /// Sonarr/Radarr "Test" button.
    Test,
    /// An event that doesn't touch subtitles (Grab, Health, …).
    Ignored(String),
    Paths(Vec<String>),
}

fn str_at<'a>(v: &'a Value, ptr: &str) -> Option<&'a str> {
    v.pointer(ptr).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn join(dir: &str, rel: &str) -> String {
    let sep = if dir.contains('\\') && !dir.contains('/') { '\\' } else { '/' };
    format!("{}{sep}{rel}", dir.trim_end_matches(['/', '\\']))
}

/// A media file's full path from an *arr file object (`path`, or the parent
/// folder plus `relativePath`).
fn arr_file(file: &Value, folder: Option<&str>) -> Option<String> {
    str_at(file, "/path").map(str::to_string).or_else(|| Some(join(folder?, str_at(file, "/relativePath")?)))
}

/// Understand Sonarr / Radarr webhook payloads and the simple
/// `{"path": …}` / `{"paths": […]}` form (Bazarr post-processing, scripts).
pub fn parse(body: &Value) -> Request {
    let mut paths: Vec<String> = Vec::new();
    if let Some(p) = str_at(body, "/path") {
        paths.push(p.to_string());
    }
    if let Some(list) = body.get("paths").and_then(Value::as_array) {
        paths.extend(list.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string));
    }
    if !paths.is_empty() {
        return Request::Paths(paths);
    }

    let Some(event) = str_at(body, "/eventType") else {
        return Request::Ignored("no path in request".into());
    };
    if event == "Test" {
        return Request::Test;
    }
    if !matches!(event, "Download" | "Rename") {
        return Request::Ignored(format!("event {event} needs no sync"));
    }
    // Sonarr
    let series = str_at(body, "/series/path");
    if let Some(f) = body.get("episodeFile") {
        paths.extend(arr_file(f, series));
    }
    for key in ["episodeFiles", "renamedEpisodeFiles"] {
        if let Some(list) = body.get(key).and_then(Value::as_array) {
            paths.extend(list.iter().filter_map(|f| arr_file(f, series)));
        }
    }
    // Radarr
    let movie = str_at(body, "/movie/folderPath");
    if let Some(f) = body.get("movieFile") {
        paths.extend(arr_file(f, movie));
    }
    if let Some(list) = body.get("renamedMovieFiles").and_then(Value::as_array) {
        paths.extend(list.iter().filter_map(|f| arr_file(f, movie)));
    }
    // A rename without file details: sync the whole show / movie folder.
    if paths.is_empty() && event == "Rename" {
        paths.extend(series.or(movie).map(str::to_string));
    }
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        Request::Ignored(format!("{event} event without a file path"))
    } else {
        Request::Paths(paths)
    }
}

fn is_srt(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("srt"))
}

/// Map a path from the sender to local scan roots: a folder, a subtitle, or
/// the subtitles next to a video. Refuses anything outside `SCAN_PATHS` or
/// inside `EXCLUDE_PATHS`.
pub fn resolve(raw: &str, map: &PathMap, scan: &ScanConfig) -> Result<Vec<PathBuf>, String> {
    let mapped = map.apply(raw.trim());
    let path = PathBuf::from(&mapped);
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("{mapped}: not an absolute path"));
    }
    if !scan.include_paths.iter().any(|root| path.starts_with(root)) {
        return Err(format!("{mapped}: outside the scan paths (check the webhook path mapping)"));
    }
    if scan.exclude_paths.iter().any(|ex| path.starts_with(ex)) {
        return Err(format!("{mapped}: excluded"));
    }
    let meta = std::fs::metadata(&path).map_err(|_| format!("{mapped}: not found (check the webhook path mapping)"))?;
    if meta.is_dir() || is_srt(&path) {
        return Ok(vec![path]);
    }
    // A video: its subtitles are `<stem>.srt` and `<stem>.<anything>.srt`.
    let (Some(dir), Some(stem)) = (path.parent(), path.file_stem().map(|s| s.to_string_lossy().into_owned())) else {
        return Ok(Vec::new());
    };
    let dot = format!("{stem}.");
    let mut subs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_srt(p) && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(&dot)))
        .collect();
    subs.sort();
    Ok(subs)
}

/// Handle to the background task that turns webhook paths into runs.
#[derive(Clone)]
pub struct TriggerQueue {
    tx: mpsc::UnboundedSender<Vec<PathBuf>>,
}

impl TriggerQueue {
    pub fn spawn(processor: Arc<Processor>, debounce: Duration) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(worker(rx, processor, debounce));
        TriggerQueue { tx }
    }

    pub fn push(&self, paths: Vec<PathBuf>) {
        if !paths.is_empty() {
            let _ = self.tx.send(paths);
        }
    }
}

async fn worker(mut rx: mpsc::UnboundedReceiver<Vec<PathBuf>>, processor: Arc<Processor>, debounce: Duration) {
    let mut pending: BTreeSet<PathBuf> = BTreeSet::new();
    let mut open = true;
    while open {
        match rx.recv().await {
            Some(p) => pending.extend(p),
            None => break,
        }
        // Wait for a quiet period: Bazarr sends one call per language, an
        // *arr season pack one per episode.
        loop {
            match tokio::time::timeout(debounce, rx.recv()).await {
                Ok(Some(p)) => pending.extend(p),
                Ok(None) => {
                    open = false;
                    break;
                }
                Err(_) => break,
            }
        }
        loop {
            if processor.is_running() {
                // Keep collecting while the current run finishes.
                match tokio::time::timeout(BUSY_POLL, rx.recv()).await {
                    Ok(Some(p)) => pending.extend(p),
                    Ok(None) => tokio::time::sleep(BUSY_POLL).await,
                    Err(_) => {}
                }
                continue;
            }
            let paths: Vec<PathBuf> = std::mem::take(&mut pending).into_iter().collect();
            let n = paths.len();
            match processor.start_run(Some(paths.clone()), None).await {
                Ok(id) => {
                    info!("Webhook: started run {id} for {n} path{}", if n == 1 { "" } else { "s" });
                    break;
                }
                Err(RunError::AlreadyRunning) => pending.extend(paths),
                Err(e) => {
                    error!("Webhook: could not start a run: {e}");
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_simple_paths() {
        assert_eq!(parse(&json!({"path": "/tv/a.srt"})), Request::Paths(vec!["/tv/a.srt".into()]));
        assert_eq!(
            parse(&json!({"paths": ["/a", "/b"], "path": "/c"})),
            Request::Paths(vec!["/c".into(), "/a".into(), "/b".into()])
        );
        assert!(matches!(parse(&json!({})), Request::Ignored(_)));
        assert!(matches!(parse(&Value::Null), Request::Ignored(_)));
    }

    #[test]
    fn parses_sonarr() {
        assert_eq!(parse(&json!({"eventType": "Test"})), Request::Test);
        assert!(matches!(parse(&json!({"eventType": "Grab"})), Request::Ignored(_)));
        let body = json!({
            "eventType": "Download",
            "series": {"path": "/tv/Show"},
            "episodeFile": {"relativePath": "Season 1/Show - S01E01.mkv"},
        });
        assert_eq!(parse(&body), Request::Paths(vec!["/tv/Show/Season 1/Show - S01E01.mkv".into()]));
        let body = json!({
            "eventType": "Download",
            "series": {"path": "/tv/Show"},
            "episodeFile": {"path": "/tv/Show/S01E01.mkv", "relativePath": "S01E01.mkv"},
            "episodeFiles": [{"path": "/tv/Show/S01E01.mkv"}, {"path": "/tv/Show/S01E02.mkv"}],
        });
        assert_eq!(parse(&body), Request::Paths(vec!["/tv/Show/S01E01.mkv".into(), "/tv/Show/S01E02.mkv".into()]));
        assert_eq!(
            parse(&json!({"eventType": "Rename", "series": {"path": "/tv/Show"}})),
            Request::Paths(vec!["/tv/Show".into()])
        );
    }

    #[test]
    fn parses_radarr() {
        let body = json!({
            "eventType": "Download",
            "movie": {"folderPath": "/movies/Film (2020)"},
            "movieFile": {"relativePath": "Film (2020).mkv", "path": "/movies/Film (2020)/Film (2020).mkv"},
        });
        assert_eq!(parse(&body), Request::Paths(vec!["/movies/Film (2020)/Film (2020).mkv".into()]));
    }

    #[test]
    fn resolves_against_the_library() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("media");
        let show = root.join("Show");
        std::fs::create_dir_all(&show).unwrap();
        std::fs::create_dir_all(root.join("Download")).unwrap();
        for f in ["e1.mkv", "e1.en.srt", "e1.de.forced.srt", "e10.en.srt", "e2.mkv"] {
            std::fs::write(show.join(f), b"x").unwrap();
        }
        let scan = ScanConfig { include_paths: vec![root.clone()], exclude_paths: vec![root.join("Download")] };
        let none = PathMap::default();
        let s = |p: &Path| p.to_string_lossy().into_owned();

        assert_eq!(
            resolve(&s(&show.join("e1.mkv")), &none, &scan).unwrap(),
            vec![show.join("e1.de.forced.srt"), show.join("e1.en.srt")]
        );
        assert_eq!(resolve(&s(&show.join("e2.mkv")), &none, &scan).unwrap(), Vec::<PathBuf>::new());
        assert_eq!(resolve(&s(&show.join("e1.en.srt")), &none, &scan).unwrap(), vec![show.join("e1.en.srt")]);
        assert_eq!(resolve(&s(&show), &none, &scan).unwrap(), vec![show.clone()]);
        assert!(resolve(&s(&root.join("Download")), &none, &scan).unwrap_err().contains("excluded"));
        assert!(resolve("/etc/passwd", &none, &scan).unwrap_err().contains("outside"));
        assert!(resolve(&format!("{}/../x", s(&root)), &none, &scan).is_err());
        assert!(resolve(&s(&show.join("gone.mkv")), &none, &scan).unwrap_err().contains("not found"));

        let map = PathMap::parse(&format!("/tv={}", s(&show))).unwrap();
        assert_eq!(resolve("/tv/e1.en.srt", &map, &scan).unwrap(), vec![show.join("e1.en.srt")]);
    }
}
