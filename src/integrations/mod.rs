//! Integrations with the rest of a media stack, all off by default:
//!
//! - [`webhook`]: Sonarr/Radarr/Bazarr call in to sync a file right away.
//! - [`notify`]: a run summary to Apprise, Discord or any JSON endpoint.
//! - [`media`]: a Jellyfin/Plex refresh of the folders a run changed.
//!
//! Notifications and the media refresh listen for finished runs on the
//! event bus, so the processor knows nothing about them.

pub mod media;
pub mod notify;
pub mod webhook;

use std::sync::{Arc, RwLock};
use std::time::Duration;

use tracing::warn;

use crate::db::Db;
use crate::events::EventBus;
use crate::models::{FileStatus, Run};
use crate::settings::Settings;

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!("subsyncarr/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

/// Turn a non-2xx response into an error carrying a short body excerpt.
pub async fn check(res: reqwest::Response) -> anyhow::Result<reqwest::Response> {
    let status = res.status();
    if status.is_success() {
        return Ok(res);
    }
    let body = res.text().await.unwrap_or_default();
    let body: String = body.chars().take(200).collect();
    anyhow::bail!("HTTP {status}{}", if body.is_empty() { String::new() } else { format!(": {body}") })
}

/// Path prefix rewrites, one `from=to` per line (`;` also separates).
/// Used where another container sees the library under a different path.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PathMap(Vec<(String, String)>);

impl PathMap {
    pub fn parse(s: &str) -> Result<Self, String> {
        let mut rules = Vec::new();
        for line in s.split(['\n', ';']).map(str::trim).filter(|l| !l.is_empty()) {
            let (from, to) = line.split_once('=').ok_or_else(|| format!("missing '=' in \"{line}\""))?;
            let (from, to) = (trim_sep(from.trim()), trim_sep(to.trim()));
            if from.is_empty() || to.is_empty() {
                return Err(format!("empty side in \"{line}\""));
            }
            rules.push((from.to_string(), to.to_string()));
        }
        // Longest prefix wins.
        rules.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
        Ok(PathMap(rules))
    }

    /// Lenient variant for values already validated on save.
    pub fn parse_lossy(s: &str) -> Self {
        Self::parse(s).unwrap_or_default()
    }

    pub fn apply(&self, path: &str) -> String {
        for (from, to) in &self.0 {
            let Some(rest) = path.strip_prefix(from.as_str()) else {
                continue;
            };
            if !(rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\')) {
                continue; // /media/tv must not match /media/tvshows
            }
            // Follow the target's separator style (Windows media servers).
            let rest = if to.contains('\\') && !to.contains('/') {
                rest.replace('/', "\\")
            } else if to.contains('/') || !to.contains('\\') {
                rest.replace('\\', "/")
            } else {
                rest.to_string()
            };
            return format!("{to}{rest}");
        }
        path.to_string()
    }
}

fn trim_sep(s: &str) -> &str {
    let t = s.trim_end_matches(['/', '\\']);
    if t.is_empty() {
        &s[..s.len().min(1)]
    } else {
        t
    }
}

/// React to finished runs: notification first (it is what the user sees),
/// then the media server refresh.
pub fn spawn(db: Db, settings: Arc<RwLock<Settings>>, events: &EventBus) {
    let mut rx = events.subscribe_runs();
    tokio::spawn(async move {
        let client = http_client();
        loop {
            let run = match rx.recv().await {
                Ok(r) => r,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            };
            let cfg = settings.read().unwrap().integrations.clone();
            on_run_finished(&client, &db, &cfg, &run).await;
        }
    });
}

async fn on_run_finished(client: &reqwest::Client, db: &Db, cfg: &crate::settings::Integrations, run: &Run) {
    if notify::wanted(cfg, run) {
        let problems = match problem_files(db, &run.id).await {
            Ok(p) => p,
            Err(e) => {
                warn!("Notification: could not load failed files: {e}");
                Vec::new()
            }
        };
        if let Err(e) = notify::send(client, cfg, &notify::Message::run_summary(run, &problems)).await {
            warn!("Notification failed: {e:#}");
        }
    }
    if media::wanted(cfg, run) {
        match db.files_paginated(&run.id, 5000, 0, Some(FileStatus::Completed.as_str())).await {
            Ok((files, _)) => {
                let paths: Vec<String> = files.into_iter().map(|f| f.file_path).collect();
                if let Err(e) = media::refresh(client, cfg, &paths).await {
                    warn!("Media server refresh failed: {e:#}");
                }
            }
            Err(e) => warn!("Media server refresh: could not load synced files: {e}"),
        }
    }
}

/// Failed and not-fitting files of a run, as (path, status).
async fn problem_files(db: &Db, run_id: &str) -> sqlx::Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for status in [FileStatus::Error, FileStatus::NotFitting] {
        let (files, _) = db.files_paginated(run_id, notify::MAX_LISTED as i64, 0, Some(status.as_str())).await?;
        out.extend(files.into_iter().map(|f| (f.file_path, f.status)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_map_rewrites_prefixes() {
        let m = PathMap::parse("/tv=/media/tv\n/data/movies/ = /media/movies ; /data=/srv").unwrap();
        assert_eq!(m.apply("/tv/Show/S01/e1.mkv"), "/media/tv/Show/S01/e1.mkv");
        assert_eq!(m.apply("/tvshows/x.mkv"), "/tvshows/x.mkv");
        assert_eq!(m.apply("/data/movies/Film/f.mkv"), "/media/movies/Film/f.mkv");
        assert_eq!(m.apply("/data/other/f.mkv"), "/srv/other/f.mkv");
        assert_eq!(m.apply("/tv"), "/media/tv");
        assert_eq!(m.apply("/elsewhere/f.mkv"), "/elsewhere/f.mkv");
    }

    #[test]
    fn path_map_follows_target_separators() {
        let m = PathMap::parse("/media=D:\\Media\nE:\\TV=/tv").unwrap();
        assert_eq!(m.apply("/media/Film/f.mkv"), "D:\\Media\\Film\\f.mkv");
        assert_eq!(m.apply("E:\\TV\\Show\\e1.mkv"), "/tv/Show/e1.mkv");
    }

    #[test]
    fn path_map_rejects_bad_lines() {
        assert!(PathMap::parse("").unwrap().0.is_empty());
        assert!(PathMap::parse("/a").is_err());
        assert!(PathMap::parse("=/b").is_err());
    }
}
