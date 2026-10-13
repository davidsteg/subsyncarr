//! Process configuration from environment variables. Read once at startup;
//! values the UI can change live in [`crate::settings`] instead.

use std::path::{Path, PathBuf};

use tracing::warn;

pub const DEFAULT_SCAN_PATH: &str = "/scan_dir";
pub const KNOWN_ENGINES: [&str; 3] = ["alass", "ffsubsync", "autosubsync"];
const DEFAULT_TIMEOUT_MS: u64 = 300_000;

#[derive(Debug, Clone)]
pub struct ScanConfig {
    pub include_paths: Vec<PathBuf>,
    pub exclude_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct Retention {
    pub keep_runs_days: i64,
    /// Statistics history (one small row per decision), kept longer than runs.
    pub keep_stats_days: i64,
    pub trim_logs_days: i64,
    pub max_log_size_bytes: i64,
    pub cleanup_interval_hours: u64,
}

/// Env-provided defaults for the settings the UI can override.
#[derive(Debug, Clone)]
pub struct SettingDefaults {
    pub default_engine: String,
    pub fallback_engine: String,
    pub engine_agreement_threshold_ms: i64,
    pub not_fitting_delete_threshold: i64,
    pub max_subtitle_shift_ms: i64,
    pub max_concurrent_tasks: usize,
    pub dry_run: bool,
    pub anchor_alignment: bool,
    pub embedded_subtitle_reference: bool,
    pub engine_timeouts_ms: [(String, u64); 3],
}

#[derive(Debug, Clone)]
pub struct Config {
    pub scan: ScanConfig,
    pub cron_schedule: String,
    pub db_path: PathBuf,
    pub web_host: String,
    pub web_port: u16,
    pub include_engines: Vec<String>,
    pub retention: Retention,
    pub server_log_buffer_size: usize,
    pub startup_scan: bool,
    pub defaults: SettingDefaults,
    pub engine_bins: EngineBins,
}

#[derive(Debug, Clone)]
pub struct EngineBins {
    pub alass: String,
    pub ffsubsync: String,
    pub autosubsync: String,
    pub ffmpeg: String,
    pub ffprobe: String,
}

impl EngineBins {
    pub fn for_engine(&self, engine: &str) -> &str {
        match engine {
            "alass" => &self.alass,
            "ffsubsync" => &self.ffsubsync,
            _ => &self.autosubsync,
        }
    }
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn env_pos<T: std::str::FromStr + PartialOrd + Default>(key: &str) -> Option<T> {
    env(key).and_then(|v| v.parse::<T>().ok()).filter(|v| *v > T::default())
}

fn env_bool(key: &str, default: bool) -> bool {
    match env(key).as_deref() {
        Some("true") | Some("1") | Some("yes") => true,
        Some("false") | Some("0") | Some("no") => false,
        _ => default,
    }
}

fn valid_path(p: &str) -> bool {
    p.starts_with('/') && !p.contains("..")
}

fn path_list(key: &str) -> Vec<PathBuf> {
    env(key)
        .map(|v| {
            v.split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .filter(|p| {
                    let ok = valid_path(p);
                    if !ok {
                        warn!("Invalid path in {key}: {p}");
                    }
                    ok
                })
                .map(|p| {
                    let t = p.trim_end_matches('/');
                    PathBuf::from(if t.is_empty() { "/" } else { t })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Per-engine timeout: engine-specific env, then SYNC_ENGINE_TIMEOUT_MS, then
/// SYNC_TIMEOUT (seconds), then 5 minutes.
fn engine_timeout(engine: &str) -> u64 {
    let specific = format!("{}_TIMEOUT_MS", engine.to_uppercase());
    env_pos::<u64>(&specific)
        .or_else(|| env_pos::<u64>("SYNC_ENGINE_TIMEOUT_MS"))
        .or_else(|| env_pos::<u64>("SYNC_TIMEOUT").map(|s| s * 1000))
        .unwrap_or(DEFAULT_TIMEOUT_MS)
}

impl Config {
    pub fn from_env() -> Self {
        let mut include_paths = path_list("SCAN_PATHS");
        if include_paths.is_empty() {
            include_paths.push(PathBuf::from(DEFAULT_SCAN_PATH));
        }
        let exclude_paths = path_list("EXCLUDE_PATHS");

        // 1.x had SUBTITLE_FORMAT=standard|overwrite, but both wrote in place;
        // "standard" only broke sync detection. Subtitles are always synced in
        // place and tracked in the DB now.
        if env("SUBTITLE_FORMAT").or_else(|| env("SYNC_FORMAT")).is_some_and(|f| f != "overwrite") {
            warn!("SUBTITLE_FORMAT is no longer used: subtitles are always synced in place");
        }

        let include_engines: Vec<String> = env("INCLUDE_ENGINES")
            .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_else(|| KNOWN_ENGINES.iter().map(|s| s.to_string()).collect());

        Config {
            scan: ScanConfig { include_paths, exclude_paths },
            cron_schedule: env("CRON_SCHEDULE").unwrap_or_else(|| "0 0 * * *".into()),
            db_path: PathBuf::from(env("DB_PATH").unwrap_or_else(|| "/app/data/subsyncarr-plus.db".into())),
            web_host: env("WEB_HOST").unwrap_or_else(|| "0.0.0.0".into()),
            web_port: env_pos("WEB_PORT").unwrap_or(3000),
            include_engines,
            retention: Retention {
                keep_runs_days: env_pos("RETENTION_KEEP_RUNS_DAYS").unwrap_or(30),
                keep_stats_days: env_pos("RETENTION_KEEP_STATS_DAYS").unwrap_or(365),
                trim_logs_days: env_pos("RETENTION_TRIM_LOGS_DAYS").unwrap_or(7),
                max_log_size_bytes: env_pos("RETENTION_MAX_LOG_SIZE").unwrap_or(10_000),
                cleanup_interval_hours: env_pos("RETENTION_CLEANUP_INTERVAL_HOURS").unwrap_or(24),
            },
            server_log_buffer_size: env_pos("SERVER_LOG_BUFFER_SIZE").unwrap_or(5000),
            startup_scan: env_bool("STARTUP_SCAN", true),
            defaults: SettingDefaults {
                default_engine: env("DEFAULT_ENGINE").unwrap_or_else(|| "alass".into()),
                fallback_engine: env("FALLBACK_ENGINE").unwrap_or_else(|| "ffsubsync".into()),
                engine_agreement_threshold_ms: env_pos("ENGINE_AGREEMENT_THRESHOLD_MS").unwrap_or(5000),
                not_fitting_delete_threshold: env_pos("NOT_FITTING_DELETE_THRESHOLD").unwrap_or(3),
                max_subtitle_shift_ms: env_pos("MAX_SUBTITLE_SHIFT_MS").unwrap_or(30_000),
                max_concurrent_tasks: env_pos("MAX_CONCURRENT_SYNC_TASKS").unwrap_or(1),
                dry_run: env_bool("DRY_RUN", false),
                anchor_alignment: env_bool("ANCHOR_ALIGNMENT", true),
                embedded_subtitle_reference: env_bool("EMBEDDED_SUBTITLE_REFERENCE", true),
                engine_timeouts_ms: [
                    ("alass".into(), engine_timeout("alass")),
                    ("ffsubsync".into(), engine_timeout("ffsubsync")),
                    ("autosubsync".into(), engine_timeout("autosubsync")),
                ],
            },
            engine_bins: EngineBins {
                alass: env("ALASS_BIN").unwrap_or_else(|| "alass".into()),
                ffsubsync: env("FFSUBSYNC_BIN").unwrap_or_else(|| "ffsubsync".into()),
                autosubsync: env("AUTOSUBSYNC_BIN").unwrap_or_else(|| "autosubsync".into()),
                ffmpeg: env("FFMPEG_BIN").unwrap_or_else(|| "ffmpeg".into()),
                ffprobe: env("FFPROBE_BIN").unwrap_or_else(|| "ffprobe".into()),
            },
        }
    }

    /// True when SCAN_PATHS was never set: the `/scan_dir` placeholder almost
    /// never exists, so every scan would silently find nothing.
    pub fn is_scan_path_misconfigured(&self) -> bool {
        self.scan.include_paths.len() == 1 && self.scan.include_paths[0] == Path::new(DEFAULT_SCAN_PATH)
    }

    pub fn schedule_enabled(&self) -> bool {
        self.cron_schedule != "disabled"
    }
}
