//! Media server refresh after a run: tell Jellyfin or Plex which folders
//! got new subtitles so they show up without waiting for a library scan.

use std::collections::BTreeSet;

use serde::Deserialize;
use tracing::{info, warn};

use super::{check, PathMap};
use crate::models::Run;
use crate::settings::Integrations;

/// More changed folders than this and a full library refresh is cheaper.
const MAX_TARGETED: usize = 50;

pub fn configured(cfg: &Integrations) -> bool {
    matches!(cfg.media_server.as_str(), "jellyfin" | "plex") && !cfg.media_server_url.is_empty()
}

pub fn wanted(cfg: &Integrations, run: &Run) -> bool {
    configured(cfg) && !run.dry_run && run.completed > 0
}

fn base(cfg: &Integrations) -> &str {
    cfg.media_server_url.trim_end_matches('/')
}

/// Parent folders of the synced subtitles, as the media server sees them.
pub fn folders(map: &PathMap, files: &[String]) -> Vec<String> {
    files
        .iter()
        .filter_map(|f| std::path::Path::new(f).parent())
        .map(|d| map.apply(&d.to_string_lossy()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub async fn refresh(client: &reqwest::Client, cfg: &Integrations, files: &[String]) -> anyhow::Result<()> {
    let dirs = folders(&PathMap::parse_lossy(&cfg.media_path_map), files);
    if dirs.is_empty() {
        return Ok(());
    }
    match cfg.media_server.as_str() {
        "jellyfin" => jellyfin_refresh(client, cfg, &dirs).await,
        "plex" => plex_refresh(client, cfg, &dirs).await,
        _ => Ok(()),
    }
}

/// Check that the server answers and accepts the token.
pub async fn test(client: &reqwest::Client, cfg: &Integrations) -> anyhow::Result<String> {
    match cfg.media_server.as_str() {
        "jellyfin" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "PascalCase")]
            struct Info {
                server_name: Option<String>,
                version: Option<String>,
            }
            let res = jellyfin(client.get(format!("{}/System/Info", base(cfg))), cfg).send().await?;
            let i: Info = check(res).await?.json().await?;
            Ok(format!(
                "Connected to Jellyfin {} ({})",
                i.version.unwrap_or_default(),
                i.server_name.unwrap_or_else(|| "unnamed".into())
            ))
        }
        "plex" => {
            let n = plex_sections(client, cfg).await?.len();
            Ok(format!("Connected to Plex, {n} librar{} found", if n == 1 { "y" } else { "ies" }))
        }
        _ => anyhow::bail!("no media server selected"),
    }
}

// ----------------------------------------------------------------- jellyfin

fn jellyfin(rb: reqwest::RequestBuilder, cfg: &Integrations) -> reqwest::RequestBuilder {
    rb.header("Authorization", format!("MediaBrowser Token=\"{}\"", cfg.media_server_token))
        .header("X-Emby-Token", &cfg.media_server_token)
}

async fn jellyfin_refresh(client: &reqwest::Client, cfg: &Integrations, dirs: &[String]) -> anyhow::Result<()> {
    if dirs.len() > MAX_TARGETED {
        check(jellyfin(client.post(format!("{}/Library/Refresh", base(cfg))), cfg).send().await?).await?;
        info!("Jellyfin: full library refresh requested ({} folders changed)", dirs.len());
        return Ok(());
    }
    let updates: Vec<_> = dirs.iter().map(|d| serde_json::json!({ "Path": d, "UpdateType": "Modified" })).collect();
    let rb =
        client.post(format!("{}/Library/Media/Updated", base(cfg))).json(&serde_json::json!({ "Updates": updates }));
    check(jellyfin(rb, cfg).send().await?).await?;
    info!("Jellyfin: refresh requested for {} folder{}", dirs.len(), if dirs.len() == 1 { "" } else { "s" });
    Ok(())
}

// --------------------------------------------------------------------- plex

#[derive(Debug, Deserialize)]
struct PlexSections {
    #[serde(rename = "MediaContainer")]
    container: PlexContainer,
}

#[derive(Debug, Deserialize)]
struct PlexContainer {
    #[serde(rename = "Directory", default)]
    directories: Vec<PlexSection>,
}

#[derive(Debug, Deserialize)]
pub struct PlexSection {
    key: String,
    #[serde(rename = "Location", default)]
    locations: Vec<PlexLocation>,
}

#[derive(Debug, Deserialize)]
struct PlexLocation {
    path: String,
}

fn plex(rb: reqwest::RequestBuilder, cfg: &Integrations) -> reqwest::RequestBuilder {
    rb.header("X-Plex-Token", &cfg.media_server_token).header("Accept", "application/json")
}

async fn plex_sections(client: &reqwest::Client, cfg: &Integrations) -> anyhow::Result<Vec<PlexSection>> {
    let res = plex(client.get(format!("{}/library/sections", base(cfg))), cfg).send().await?;
    let s: PlexSections = check(res).await?.json().await?;
    Ok(s.container.directories)
}

fn under(dir: &str, root: &str) -> bool {
    let root = root.trim_end_matches(['/', '\\']);
    dir.strip_prefix(root).is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '\\']))
}

/// Section key for each folder; folders outside every library are dropped.
fn plex_targets<'a>(sections: &'a [PlexSection], dirs: &'a [String]) -> Vec<(&'a str, &'a str)> {
    dirs.iter()
        .filter_map(|d| {
            sections
                .iter()
                .find(|s| s.locations.iter().any(|l| under(d, &l.path)))
                .map(|s| (s.key.as_str(), d.as_str()))
        })
        .collect()
}

async fn plex_refresh(client: &reqwest::Client, cfg: &Integrations, dirs: &[String]) -> anyhow::Result<()> {
    let sections = plex_sections(client, cfg).await?;
    let targets = plex_targets(&sections, dirs);
    if targets.len() < dirs.len() {
        warn!(
            "Plex: {} folder(s) are outside every Plex library — check the media server path mapping",
            dirs.len() - targets.len()
        );
    }
    let url = |key: &str| format!("{}/library/sections/{key}/refresh", base(cfg));
    if targets.len() > MAX_TARGETED {
        let keys: BTreeSet<&str> = targets.iter().map(|(k, _)| *k).collect();
        for key in &keys {
            check(plex(client.get(url(key)), cfg).send().await?).await?;
        }
        info!("Plex: full refresh requested for {} librar{}", keys.len(), if keys.len() == 1 { "y" } else { "ies" });
        return Ok(());
    }
    for (key, dir) in &targets {
        check(plex(client.get(url(key)).query(&[("path", dir)]), cfg).send().await?).await?;
    }
    if !targets.is_empty() {
        info!("Plex: refresh requested for {} folder{}", targets.len(), if targets.len() == 1 { "" } else { "s" });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_are_deduped_and_mapped() {
        let map = PathMap::parse("/media=/data").unwrap();
        let files = vec![
            "/media/Show/S01/e1.en.srt".to_string(),
            "/media/Show/S01/e1.de.srt".to_string(),
            "/media/Film/f.en.srt".to_string(),
        ];
        assert_eq!(folders(&map, &files), vec!["/data/Film".to_string(), "/data/Show/S01".to_string()]);
    }

    #[test]
    fn plex_matches_sections_by_location() {
        let json = r#"{"MediaContainer":{"Directory":[
            {"key":"1","Location":[{"path":"/data/movies"}]},
            {"key":"2","Location":[{"path":"/data/tv/"},{"path":"/data/anime"}]}
        ]}}"#;
        let s: PlexSections = serde_json::from_str(json).unwrap();
        let dirs = vec!["/data/movies/Film".to_string(), "/data/anime/X/S1".to_string(), "/data/tvshows/Y".to_string()];
        assert_eq!(
            plex_targets(&s.container.directories, &dirs),
            vec![("1", "/data/movies/Film"), ("2", "/data/anime/X/S1")]
        );
    }
}
