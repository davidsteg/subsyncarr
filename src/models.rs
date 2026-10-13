//! API / DB data types.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    Anchor,
    Follower,
    Full,
}

impl SyncMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SyncMode::Anchor => "anchor",
            SyncMode::Follower => "follower",
            SyncMode::Full => "full",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStatus {
    Pending,
    Processing,
    Completed,
    Skipped,
    Error,
    NotFitting,
}

impl FileStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            FileStatus::Pending => "pending",
            FileStatus::Processing => "processing",
            FileStatus::Completed => "completed",
            FileStatus::Skipped => "skipped",
            FileStatus::Error => "error",
            FileStatus::NotFitting => "not_fitting",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => FileStatus::Pending,
            "processing" => FileStatus::Processing,
            "completed" => FileStatus::Completed,
            "skipped" => FileStatus::Skipped,
            "error" => FileStatus::Error,
            "not_fitting" => FileStatus::NotFitting,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct EnginePassFail {
    pub pass: i64,
    pub fail: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Run {
    pub id: String,
    pub start_time: i64,
    pub end_time: Option<i64>,
    pub total_files: i64,
    pub completed: i64,
    pub skipped: i64,
    pub failed: i64,
    pub not_fitting: i64,
    pub total_engines: i64,
    pub completed_engines: i64,
    pub status: String,
    pub engine_stats: BTreeMap<String, EnginePassFail>,
    pub anchors_completed: i64,
    pub followers_completed: i64,
    pub dry_run: bool,
}

#[derive(sqlx::FromRow)]
pub struct RunRow {
    pub id: String,
    pub start_time: i64,
    pub end_time: Option<i64>,
    pub total_files: i64,
    pub completed: Option<i64>,
    pub skipped: Option<i64>,
    pub failed: Option<i64>,
    pub not_fitting: Option<i64>,
    pub total_engines: Option<i64>,
    pub completed_engines: Option<i64>,
    pub status: String,
    pub engine_stats: Option<String>,
    pub anchors_completed: Option<i64>,
    pub followers_completed: Option<i64>,
    pub dry_run: Option<i64>,
}

impl From<RunRow> for Run {
    fn from(r: RunRow) -> Self {
        Run {
            id: r.id,
            start_time: r.start_time,
            end_time: r.end_time,
            total_files: r.total_files,
            completed: r.completed.unwrap_or(0),
            skipped: r.skipped.unwrap_or(0),
            failed: r.failed.unwrap_or(0),
            not_fitting: r.not_fitting.unwrap_or(0),
            total_engines: r.total_engines.unwrap_or(0),
            completed_engines: r.completed_engines.unwrap_or(0),
            status: r.status,
            engine_stats: r.engine_stats.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
            anchors_completed: r.anchors_completed.unwrap_or(0),
            followers_completed: r.followers_completed.unwrap_or(0),
            dry_run: r.dry_run.unwrap_or(0) != 0,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineResult {
    pub success: bool,
    pub duration: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub shift_too_large: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_shift_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileResult {
    pub id: i64,
    pub run_id: String,
    pub file_path: String,
    pub video_path: Option<String>,
    pub status: String,
    pub current_engine: Option<String>,
    pub engines: BTreeMap<String, Value>,
    pub sync_mode: Option<String>,
    pub anchor_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(sqlx::FromRow)]
pub struct FileResultRow {
    pub id: i64,
    pub run_id: String,
    pub file_path: String,
    pub video_path: Option<String>,
    pub status: String,
    pub current_engine: Option<String>,
    pub engines: Option<String>,
    pub sync_mode: Option<String>,
    pub anchor_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl From<FileResultRow> for FileResult {
    fn from(r: FileResultRow) -> Self {
        FileResult {
            id: r.id,
            run_id: r.run_id,
            file_path: r.file_path,
            video_path: r.video_path,
            status: r.status,
            current_engine: r.current_engine,
            engines: r.engines.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
            sync_mode: r.sync_mode,
            anchor_path: r.anchor_path,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub checked: usize,
    pub total: usize,
    pub need_sync: usize,
    pub already_synced: usize,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct EngineTracking {
    pub engine: String,
    pub consecutive_failures: i64,
    pub last_failure_time: Option<i64>,
    pub last_success_time: Option<i64>,
    pub is_skipped: bool,
}
