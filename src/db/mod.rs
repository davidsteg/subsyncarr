//! SQLite persistence (sqlx, WAL). One pool serves both the engine's writes
//! and the dashboard's reads — async I/O means a heavy read never blocks the
//! sync engine, which is what the 1.x two-process split worked around.

mod migrations;

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteAutoVacuum, SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

use crate::models::{EngineTracking, FileResult, FileResultRow, FileStatus, Run, RunRow, SyncMode};
use crate::now_ms;

/// Consecutive failures after which an engine is skipped for a file.
pub const ENGINE_SKIP_THRESHOLD: i64 = 3;

#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

#[derive(Debug, Clone, Copy)]
pub struct SyncCacheEntry {
    pub mtime_ms: Option<f64>,
    pub size_bytes: Option<i64>,
    pub cues_verified: bool,
}

impl SyncCacheEntry {
    /// The cache is only trusted while the file still has exactly the
    /// mtime/size recorded when it was cached — a fresh subtitle dropped at the
    /// same path (e.g. by Bazarr) must not be skipped.
    pub fn matches(&self, mtime_ms: f64, size: i64) -> bool {
        match (self.mtime_ms, self.size_bytes) {
            (Some(m), Some(s)) => (m - mtime_ms).abs() < 0.001 && s == size,
            _ => false,
        }
    }
}

/// Column updates for one file_results row. `None` = leave unchanged.
#[derive(Default)]
pub struct FileUpdate<'a> {
    pub status: Option<FileStatus>,
    pub current_engine: Option<Option<&'a str>>,
    pub video_path: Option<Option<&'a str>>,
    pub sync_mode: Option<SyncMode>,
    pub anchor_path: Option<Option<&'a str>>,
}

#[derive(Debug, Clone, Copy)]
pub enum RunCounter {
    Completed,
    Skipped,
    Failed,
    NotFitting,
    CompletedEngines,
    AnchorsCompleted,
    FollowersCompleted,
}

impl RunCounter {
    fn column(self) -> &'static str {
        match self {
            RunCounter::Completed => "completed",
            RunCounter::Skipped => "skipped",
            RunCounter::Failed => "failed",
            RunCounter::NotFitting => "not_fitting",
            RunCounter::CompletedEngines => "completed_engines",
            RunCounter::AnchorsCompleted => "anchors_completed",
            RunCounter::FollowersCompleted => "followers_completed",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStat {
    pub name: String,
    pub full_path: String,
    pub total: i64,
    pub synced: i64,
    pub skipped: i64,
    pub pending: i64,
    pub progress: i64,
    pub has_children: bool,
}

const LANGUAGE_NAMES: &[(&str, &str)] = &[
    ("en", "English"),
    ("eng", "English"),
    ("fr", "French"),
    ("fre", "French"),
    ("fra", "French"),
    ("de", "German"),
    ("ger", "German"),
    ("deu", "German"),
    ("es", "Spanish"),
    ("spa", "Spanish"),
    ("it", "Italian"),
    ("ita", "Italian"),
    ("pt", "Portuguese"),
    ("por", "Portuguese"),
    ("nl", "Dutch"),
    ("dut", "Dutch"),
    ("nld", "Dutch"),
    ("sv", "Swedish"),
    ("swe", "Swedish"),
    ("no", "Norwegian"),
    ("nor", "Norwegian"),
    ("da", "Danish"),
    ("dan", "Danish"),
    ("fi", "Finnish"),
    ("fin", "Finnish"),
    ("pl", "Polish"),
    ("pol", "Polish"),
    ("cs", "Czech"),
    ("cze", "Czech"),
    ("ces", "Czech"),
    ("sk", "Slovak"),
    ("slo", "Slovak"),
    ("slk", "Slovak"),
    ("hu", "Hungarian"),
    ("hun", "Hungarian"),
    ("ro", "Romanian"),
    ("rum", "Romanian"),
    ("ron", "Romanian"),
    ("tr", "Turkish"),
    ("tur", "Turkish"),
    ("ru", "Russian"),
    ("rus", "Russian"),
    ("uk", "Ukrainian"),
    ("ukr", "Ukrainian"),
    ("ja", "Japanese"),
    ("jpn", "Japanese"),
    ("ko", "Korean"),
    ("kor", "Korean"),
    ("zh", "Chinese"),
    ("chi", "Chinese"),
    ("zho", "Chinese"),
    ("ar", "Arabic"),
    ("ara", "Arabic"),
    ("he", "Hebrew"),
    ("heb", "Hebrew"),
    ("hi", "Hindi"),
    ("hin", "Hindi"),
    ("el", "Greek"),
    ("gre", "Greek"),
    ("ell", "Greek"),
    ("bg", "Bulgarian"),
    ("bul", "Bulgarian"),
    ("hr", "Croatian"),
    ("hrv", "Croatian"),
    ("sr", "Serbian"),
    ("srp", "Serbian"),
    ("sl", "Slovenian"),
    ("slv", "Slovenian"),
    ("et", "Estonian"),
    ("est", "Estonian"),
    ("lv", "Latvian"),
    ("lav", "Latvian"),
    ("lt", "Lithuanian"),
    ("lit", "Lithuanian"),
    ("th", "Thai"),
    ("tha", "Thai"),
    ("vi", "Vietnamese"),
    ("vie", "Vietnamese"),
    ("id", "Indonesian"),
    ("ind", "Indonesian"),
    ("ms", "Malay"),
    ("may", "Malay"),
    ("msa", "Malay"),
    ("fa", "Persian"),
    ("per", "Persian"),
    ("fas", "Persian"),
    ("ca", "Catalan"),
    ("cat", "Catalan"),
];

/// Language token of a subtitle path: the segment between the last two dots
/// (`movie.en.srt` → `en`), if it's a known ISO 639-1/2 code.
pub fn language_of(path: &str) -> Option<&'static str> {
    let lower = path.to_lowercase();
    let stem = lower.strip_suffix(".srt")?;
    let code = stem.rsplit_once('.')?.1;
    LANGUAGE_NAMES.iter().find(|(c, _)| *c == code).map(|(_, n)| *n)
}

/// Upper bound for a prefix range scan: every string starting with `prefix`
/// sorts in `[prefix, prefix_upper)`.
fn prefix_upper(prefix: &str) -> String {
    let mut s = prefix.to_string();
    let last = s.pop().unwrap_or('/');
    s.push(char::from_u32(last as u32 + 1).unwrap_or(char::MAX));
    s
}

impl Db {
    pub async fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .auto_vacuum(SqliteAutoVacuum::Incremental)
            .busy_timeout(Duration::from_secs(15))
            .pragma("cache_size", "-32000")
            .pragma("mmap_size", "268435456")
            .pragma("temp_store", "MEMORY");
        let pool =
            SqlitePoolOptions::new().max_connections(8).min_connections(1).connect_with(opts).await.map_err(|e| {
                anyhow::anyhow!(
                    "Cannot open database at {} ({e}) — ensure the data directory exists and is writable. \
                     If using Docker, check that your volume mount exists and has correct permissions (PUID/PGID).",
                    path.display()
                )
            })?;
        migrations::run(&pool).await?;
        Ok(Db { pool })
    }

    #[cfg(test)]
    pub async fn open_memory() -> anyhow::Result<Self> {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")?;
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await?;
        migrations::run(&pool).await?;
        Ok(Db { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    // ---------------------------------------------------------------- runs

    pub async fn create_run(&self, id: &str, dry_run: bool) -> sqlx::Result<()> {
        sqlx::query(
            "INSERT INTO runs (id, start_time, total_files, total_engines, status, engine_stats, dry_run)
             VALUES (?, ?, 0, 0, 'running', '{}', ?)",
        )
        .bind(id)
        .bind(now_ms())
        .bind(dry_run as i64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_run_totals(&self, id: &str, total_files: i64, total_engines: i64) -> sqlx::Result<()> {
        sqlx::query("UPDATE runs SET total_files = ?, total_engines = ? WHERE id = ?")
            .bind(total_files)
            .bind(total_engines)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn increment_run(&self, id: &str, counter: RunCounter) -> sqlx::Result<()> {
        let col = counter.column();
        sqlx::query(&format!("UPDATE runs SET {col} = COALESCE({col}, 0) + 1 WHERE id = ?"))
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn record_run_engine_stat(&self, id: &str, engine: &str, success: bool) -> sqlx::Result<()> {
        let field = if success { "pass" } else { "fail" };
        // json_set creates missing parents; COALESCE starts a fresh counter.
        let path = format!("$.\"{engine}\".{field}");
        sqlx::query(&format!(
            "UPDATE runs SET engine_stats = json_set(
                CASE WHEN json_valid(engine_stats) THEN engine_stats ELSE '{{}}' END,
                ?1, COALESCE(json_extract(engine_stats, ?1), 0) + 1,
                '$.\"{engine}\".{other}', COALESCE(json_extract(engine_stats, '$.\"{engine}\".{other}'), 0)
             ) WHERE id = ?2",
            other = if success { "fail" } else { "pass" }
        ))
        .bind(path)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn finish_run(&self, id: &str, status: &str) -> sqlx::Result<()> {
        sqlx::query("UPDATE runs SET status = ?, end_time = ? WHERE id = ?")
            .bind(status)
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Runs left `running` by a crash/restart are marked cancelled on startup.
    pub async fn cancel_incomplete_runs(&self) -> sqlx::Result<u64> {
        let r = sqlx::query("UPDATE runs SET status = 'cancelled', end_time = start_time WHERE status = 'running'")
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected())
    }

    pub async fn get_run(&self, id: &str) -> sqlx::Result<Option<Run>> {
        let row: Option<RunRow> =
            sqlx::query_as("SELECT * FROM runs WHERE id = ?").bind(id).fetch_optional(&self.pool).await?;
        Ok(row.map(Into::into))
    }

    pub async fn run_history(&self, limit: i64) -> sqlx::Result<Vec<Run>> {
        let rows: Vec<RunRow> = sqlx::query_as("SELECT * FROM runs ORDER BY start_time DESC LIMIT ?")
            .bind(limit)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    // -------------------------------------------------------- file results

    /// Insert every discovered file for a run in chunked multi-row inserts
    /// inside one transaction.
    pub async fn insert_pending_files(&self, run_id: &str, files: &[String]) -> sqlx::Result<()> {
        let now = now_ms();
        let mut tx = self.pool.begin().await?;
        for chunk in files.chunks(2000) {
            let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(
                "INSERT INTO file_results (run_id, file_path, video_path, status, engines, created_at, updated_at) ",
            );
            qb.push_values(chunk, |mut b, f| {
                b.push_bind(run_id)
                    .push_bind(f)
                    .push("NULL")
                    .push("'pending'")
                    .push("'{}'")
                    .push_bind(now)
                    .push_bind(now);
            });
            qb.build().execute(&mut *tx).await?;
        }
        tx.commit().await
    }

    pub async fn update_file(&self, run_id: &str, path: &str, u: FileUpdate<'_>) -> sqlx::Result<()> {
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("UPDATE file_results SET updated_at = ");
        qb.push_bind(now_ms());
        if let Some(s) = u.status {
            qb.push(", status = ").push_bind(s.as_str());
        }
        if let Some(e) = u.current_engine {
            qb.push(", current_engine = ").push_bind(e);
        }
        if let Some(v) = u.video_path {
            qb.push(", video_path = ").push_bind(v);
        }
        if let Some(m) = u.sync_mode {
            qb.push(", sync_mode = ").push_bind(m.as_str());
        }
        if let Some(a) = u.anchor_path {
            qb.push(", anchor_path = ").push_bind(a);
        }
        qb.push(" WHERE run_id = ").push_bind(run_id).push(" AND file_path = ").push_bind(path);
        qb.build().execute(&self.pool).await?;
        Ok(())
    }

    pub async fn set_file_engine_result(
        &self,
        run_id: &str,
        path: &str,
        engine: &str,
        result: &Value,
    ) -> sqlx::Result<()> {
        sqlx::query(
            "UPDATE file_results SET engines = json_set(
                CASE WHEN json_valid(engines) THEN engines ELSE '{}' END, '$.\"' || ? || '\"', json(?)),
                updated_at = ?
             WHERE run_id = ? AND file_path = ?",
        )
        .bind(engine)
        .bind(result.to_string())
        .bind(now_ms())
        .bind(run_id)
        .bind(path)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn files_paginated(
        &self,
        run_id: &str,
        limit: i64,
        offset: i64,
        status: Option<&str>,
    ) -> sqlx::Result<(Vec<FileResult>, i64)> {
        let (total, rows): (i64, Vec<FileResultRow>) = match status {
            Some(s) => (
                sqlx::query_scalar("SELECT COUNT(*) FROM file_results WHERE run_id = ? AND status = ?")
                    .bind(run_id)
                    .bind(s)
                    .fetch_one(&self.pool)
                    .await?,
                sqlx::query_as(
                    "SELECT * FROM file_results WHERE run_id = ? AND status = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
                )
                .bind(run_id)
                .bind(s)
                .bind(limit)
                .bind(offset)
                .fetch_all(&self.pool)
                .await?,
            ),
            None => (
                sqlx::query_scalar("SELECT COUNT(*) FROM file_results WHERE run_id = ?")
                    .bind(run_id)
                    .fetch_one(&self.pool)
                    .await?,
                sqlx::query_as("SELECT * FROM file_results WHERE run_id = ? ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?")
                    .bind(run_id)
                    .bind(limit)
                    .bind(offset)
                    .fetch_all(&self.pool)
                    .await?,
            ),
        };
        Ok((rows.into_iter().map(Into::into).collect(), total))
    }

    /// Live view: files processing now + the most recently finished ones.
    pub async fn active_and_recent_files(&self, run_id: &str, recent_limit: i64) -> sqlx::Result<Vec<FileResult>> {
        let mut rows: Vec<FileResultRow> = sqlx::query_as(
            "SELECT * FROM file_results WHERE run_id = ? AND status = 'processing' ORDER BY updated_at DESC",
        )
        .bind(run_id)
        .fetch_all(&self.pool)
        .await?;
        let recent: Vec<FileResultRow> = sqlx::query_as(
            "SELECT * FROM file_results WHERE run_id = ? AND status IN ('completed','skipped','error','not_fitting')
             ORDER BY updated_at DESC LIMIT ?",
        )
        .bind(run_id)
        .bind(recent_limit)
        .fetch_all(&self.pool)
        .await?;
        rows.extend(recent);
        Ok(rows.into_iter().map(Into::into).collect())
    }

    // ------------------------------------------------- engine failure tracking

    pub async fn is_engine_skipped(&self, path: &str, engine: &str) -> sqlx::Result<bool> {
        let v: Option<bool> =
            sqlx::query_scalar("SELECT is_skipped FROM engine_failure_tracking WHERE file_path = ? AND engine = ?")
                .bind(path)
                .bind(engine)
                .fetch_optional(&self.pool)
                .await?;
        Ok(v.unwrap_or(false))
    }

    pub async fn record_engine_failure(&self, path: &str, engine: &str) -> sqlx::Result<()> {
        let now = now_ms();
        sqlx::query(
            "INSERT INTO engine_failure_tracking
               (file_path, engine, consecutive_failures, last_failure_time, is_skipped, created_at, updated_at)
             VALUES (?1, ?2, 1, ?3, 0, ?3, ?3)
             ON CONFLICT(file_path, engine) DO UPDATE SET
               consecutive_failures = consecutive_failures + 1,
               last_failure_time = ?3,
               is_skipped = (consecutive_failures + 1) >= ?4,
               updated_at = ?3",
        )
        .bind(path)
        .bind(engine)
        .bind(now)
        .bind(ENGINE_SKIP_THRESHOLD)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_engine_success(&self, path: &str, engine: &str) -> sqlx::Result<()> {
        let now = now_ms();
        sqlx::query(
            "INSERT INTO engine_failure_tracking
               (file_path, engine, consecutive_failures, last_success_time, is_skipped, created_at, updated_at)
             VALUES (?1, ?2, 0, ?3, 0, ?3, ?3)
             ON CONFLICT(file_path, engine) DO UPDATE SET
               consecutive_failures = 0, last_success_time = ?3, is_skipped = 0, updated_at = ?3",
        )
        .bind(path)
        .bind(engine)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn reset_engine_skip(&self, path: &str, engine: Option<&str>) -> sqlx::Result<()> {
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(
            "UPDATE engine_failure_tracking SET consecutive_failures = 0, is_skipped = 0, updated_at = ",
        );
        qb.push_bind(now_ms()).push(" WHERE file_path = ").push_bind(path);
        if let Some(e) = engine {
            qb.push(" AND engine = ").push_bind(e);
        }
        qb.build().execute(&self.pool).await?;
        Ok(())
    }

    pub async fn skipped_engines(&self, path: &str) -> sqlx::Result<Vec<String>> {
        sqlx::query_scalar("SELECT engine FROM engine_failure_tracking WHERE file_path = ? AND is_skipped = 1")
            .bind(path)
            .fetch_all(&self.pool)
            .await
    }

    pub async fn failure_stats(&self) -> sqlx::Result<Value> {
        let total: i64 =
            sqlx::query_scalar("SELECT COUNT(DISTINCT file_path) FROM engine_failure_tracking WHERE is_skipped = 1")
                .fetch_one(&self.pool)
                .await?;
        let rows = sqlx::query(
            "SELECT engine, COUNT(*) AS c FROM engine_failure_tracking WHERE is_skipped = 1 GROUP BY engine",
        )
        .fetch_all(&self.pool)
        .await?;
        let by: BTreeMap<String, i64> = rows.iter().map(|r| (r.get("engine"), r.get("c"))).collect();
        Ok(json!({ "totalSkipped": total, "skippedByEngine": by }))
    }

    /// Everything that keeps a subtitle from syncing: files with not-fitting
    /// strikes, engines permanently skipped per file, and parked forced subs.
    /// Newest first, at most `limit` rows each.
    pub async fn diagnostics(&self, limit: i64) -> sqlx::Result<Value> {
        let strikes = sqlx::query(
            "SELECT file_path, consecutive_strikes, last_strike_time FROM not_fitting_tracking
             WHERE consecutive_strikes > 0 ORDER BY last_strike_time DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let skipped = sqlx::query(
            "SELECT file_path, engine, consecutive_failures, last_failure_time FROM engine_failure_tracking
             WHERE is_skipped = 1 ORDER BY last_failure_time DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        let parked =
            sqlx::query("SELECT file_path, reason, parked_at FROM parked_files ORDER BY parked_at DESC LIMIT ?")
                .bind(limit)
                .fetch_all(&self.pool)
                .await?;
        let (n_strikes, n_skipped, n_parked): (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM not_fitting_tracking WHERE consecutive_strikes > 0),
                    (SELECT COUNT(*) FROM engine_failure_tracking WHERE is_skipped = 1),
                    (SELECT COUNT(*) FROM parked_files)",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(json!({
            "strikes": strikes.iter().map(|r| json!({
                "file_path": r.get::<String, _>("file_path"),
                "consecutive_strikes": r.get::<i64, _>("consecutive_strikes"),
                "last_strike_time": r.get::<Option<i64>, _>("last_strike_time"),
            })).collect::<Vec<_>>(),
            "skippedEngines": skipped.iter().map(|r| json!({
                "file_path": r.get::<String, _>("file_path"),
                "engine": r.get::<String, _>("engine"),
                "consecutive_failures": r.get::<i64, _>("consecutive_failures"),
                "last_failure_time": r.get::<Option<i64>, _>("last_failure_time"),
            })).collect::<Vec<_>>(),
            "parked": parked.iter().map(|r| json!({
                "file_path": r.get::<String, _>("file_path"),
                "reason": r.get::<Option<String>, _>("reason"),
                "parked_at": r.get::<i64, _>("parked_at"),
            })).collect::<Vec<_>>(),
            "totals": { "strikes": n_strikes, "skippedEngines": n_skipped, "parked": n_parked },
        }))
    }

    // ---------------------------------------------------- not-fitting strikes

    pub async fn record_not_fitting_strike(&self, path: &str) -> sqlx::Result<i64> {
        let now = now_ms();
        sqlx::query_scalar(
            "INSERT INTO not_fitting_tracking (file_path, consecutive_strikes, last_strike_time, updated_at)
             VALUES (?1, 1, ?2, ?2)
             ON CONFLICT(file_path) DO UPDATE SET
               consecutive_strikes = consecutive_strikes + 1, last_strike_time = ?2, updated_at = ?2
             RETURNING consecutive_strikes",
        )
        .bind(path)
        .bind(now)
        .fetch_one(&self.pool)
        .await
    }

    pub async fn reset_not_fitting_strikes(&self, path: &str) -> sqlx::Result<()> {
        sqlx::query("DELETE FROM not_fitting_tracking WHERE file_path = ?").bind(path).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn not_fitting_strikes(&self, path: &str) -> sqlx::Result<i64> {
        Ok(sqlx::query_scalar("SELECT consecutive_strikes FROM not_fitting_tracking WHERE file_path = ?")
            .bind(path)
            .fetch_optional(&self.pool)
            .await?
            .unwrap_or(0))
    }

    // ---------------------------------------------------------- sync cache

    /// Whole cache in one query — the scanner looks paths up in memory instead
    /// of issuing one SELECT per file.
    pub async fn load_sync_cache(&self) -> sqlx::Result<HashMap<String, SyncCacheEntry>> {
        let rows = sqlx::query("SELECT file_path, mtime_ms, size_bytes, cues_verified FROM synced_files")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| {
                (
                    r.get::<String, _>("file_path"),
                    SyncCacheEntry {
                        mtime_ms: r.get("mtime_ms"),
                        size_bytes: r.get("size_bytes"),
                        cues_verified: r.get::<Option<i64>, _>("cues_verified").unwrap_or(0) != 0,
                    },
                )
            })
            .collect())
    }

    pub async fn upsert_sync_cache(&self, entries: &[(String, f64, i64)]) -> sqlx::Result<()> {
        let now = now_ms();
        let mut tx = self.pool.begin().await?;
        for chunk in entries.chunks(1000) {
            let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new(
                "INSERT INTO synced_files (file_path, synced_at, mtime_ms, size_bytes, cues_verified) ",
            );
            qb.push_values(chunk, |mut b, (p, m, s)| {
                b.push_bind(p).push_bind(now).push_bind(m).push_bind(s).push("1");
            });
            qb.push(
                " ON CONFLICT(file_path) DO UPDATE SET synced_at = excluded.synced_at, mtime_ms = excluded.mtime_ms,
                  size_bytes = excluded.size_bytes, cues_verified = 1",
            );
            qb.build().execute(&mut *tx).await?;
        }
        tx.commit().await
    }

    pub async fn remove_from_sync_cache(&self, paths: &[String]) -> sqlx::Result<()> {
        let mut tx = self.pool.begin().await?;
        for p in paths {
            sqlx::query("DELETE FROM synced_files WHERE file_path = ?").bind(p).execute(&mut *tx).await?;
        }
        tx.commit().await
    }

    /// Parked files (path → (mtime, size)), loaded once per scan.
    pub async fn load_parked(&self) -> sqlx::Result<HashMap<String, (f64, i64)>> {
        let rows =
            sqlx::query("SELECT file_path, mtime_ms, size_bytes FROM parked_files").fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|r| (r.get("file_path"), (r.get("mtime_ms"), r.get("size_bytes")))).collect())
    }

    pub async fn park_file(&self, path: &str, mtime_ms: f64, size: i64, reason: &str) -> sqlx::Result<()> {
        sqlx::query(
            "INSERT INTO parked_files (file_path, mtime_ms, size_bytes, reason, parked_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(file_path) DO UPDATE SET mtime_ms = ?2, size_bytes = ?3, reason = ?4, parked_at = ?5",
        )
        .bind(path)
        .bind(mtime_ms)
        .bind(size)
        .bind(reason)
        .bind(now_ms())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Record the content hash for a path. Returns true when it differs from
    /// the last recorded one (or none was recorded): per-path failure state
    /// then belongs to a different file, and engine skips, strikes and the
    /// park are cleared.
    pub async fn refresh_fingerprint(&self, path: &str, hash: &str) -> sqlx::Result<bool> {
        let old: Option<String> = sqlx::query_scalar("SELECT content_hash FROM file_fingerprints WHERE file_path = ?")
            .bind(path)
            .fetch_optional(&self.pool)
            .await?;
        if old.as_deref() == Some(hash) {
            return Ok(false);
        }
        let now = now_ms();
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO file_fingerprints (file_path, content_hash, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(file_path) DO UPDATE SET content_hash = ?2, updated_at = ?3",
        )
        .bind(path)
        .bind(hash)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        if old.is_some() {
            sqlx::query("UPDATE engine_failure_tracking SET consecutive_failures = 0, is_skipped = 0, updated_at = ? WHERE file_path = ?")
                .bind(now)
                .bind(path)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM not_fitting_tracking WHERE file_path = ?").bind(path).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM parked_files WHERE file_path = ?").bind(path).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    // ------------------------------------------------------------ settings

    pub async fn all_settings(&self) -> sqlx::Result<HashMap<String, String>> {
        let rows = sqlx::query("SELECT key, value FROM settings").fetch_all(&self.pool).await?;
        Ok(rows.into_iter().map(|r| (r.get("key"), r.get("value"))).collect())
    }

    pub async fn set_settings(&self, kv: &[(String, String)]) -> sqlx::Result<()> {
        let now = now_ms();
        let mut tx = self.pool.begin().await?;
        for (k, v) in kv {
            sqlx::query(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
            )
            .bind(k)
            .bind(v)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
    }

    // ----------------------------------------------------- dashboard reads

    pub async fn media_stats(&self) -> sqlx::Result<Value> {
        // One pass over the tracking table, aggregated per file in SQL.
        let rows = sqlx::query(
            "SELECT file_path,
                    MAX(CASE WHEN last_success_time IS NOT NULL THEN 1 ELSE 0 END) AS synced,
                    MAX(CASE WHEN is_skipped = 1 THEN 1 ELSE 0 END) AS skipped
             FROM engine_failure_tracking GROUP BY file_path",
        )
        .fetch_all(&self.pool)
        .await?;
        let total = rows.len() as i64;
        let mut synced = 0i64;
        let mut skipped = 0i64;
        let mut langs: HashMap<&'static str, i64> = HashMap::new();
        for r in &rows {
            let s: i64 = r.get("synced");
            let k: i64 = r.get("skipped");
            if s == 1 {
                synced += 1;
            } else if k == 1 {
                skipped += 1;
            }
            if let Some(name) = language_of(&r.get::<String, _>("file_path")) {
                *langs.entry(name).or_default() += 1;
            }
        }
        let mut languages: Vec<(&str, i64)> = langs.into_iter().collect();
        languages.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        languages.truncate(10);

        let engines = sqlx::query(
            "SELECT engine, COUNT(*) AS total,
                    SUM(CASE WHEN last_success_time IS NOT NULL THEN 1 ELSE 0 END) AS synced
             FROM engine_failure_tracking GROUP BY engine ORDER BY engine",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|r| {
            let total: i64 = r.get("total");
            let synced: i64 = r.get::<Option<i64>, _>("synced").unwrap_or(0);
            json!({
                "engine": r.get::<String, _>("engine"),
                "total": total,
                "synced": synced,
                "rate": if total > 0 { (synced as f64 / total as f64 * 100.0).round() as i64 } else { 0 },
            })
        })
        .collect::<Vec<_>>();

        let fp = sqlx::query(
            "SELECT SUM(CASE WHEN sync_mode = 'follower' THEN 1 ELSE 0 END) AS followers,
                    SUM(CASE WHEN sync_mode = 'anchor' THEN 1 ELSE 0 END) AS anchors,
                    COUNT(*) AS total
             FROM file_results WHERE status = 'completed'",
        )
        .fetch_one(&self.pool)
        .await?;
        let followers: i64 = fp.get::<Option<i64>, _>("followers").unwrap_or(0);
        let anchors: i64 = fp.get::<Option<i64>, _>("anchors").unwrap_or(0);
        let completed: i64 = fp.get("total");

        Ok(json!({
            "totalFiles": total,
            "syncedFiles": synced,
            "skippedFiles": skipped,
            "syncRate": if total > 0 { (synced as f64 / total as f64 * 100.0).round() as i64 } else { 0 },
            "engines": engines,
            "languages": languages.into_iter().map(|(n, c)| json!({"name": n, "count": c})).collect::<Vec<_>>(),
            "fastPath": {
                "anchors": anchors,
                "followers": followers,
                "completed": completed,
                "followerShare": if completed > 0 { (followers as f64 / completed as f64 * 100.0).round() as i64 } else { 0 },
            },
        }))
    }

    /// Folder tree level under `parent` (or the root), with per-file sync
    /// status rolled up per child folder.
    pub async fn folder_stats(&self, parent: Option<&str>) -> sqlx::Result<Vec<FolderStat>> {
        let parent = parent.map(|p| p.trim_end_matches('/')).filter(|p| !p.is_empty());
        let base = "SELECT file_path,
                    MAX(CASE WHEN last_success_time IS NOT NULL THEN 1 ELSE 0 END) AS synced,
                    MAX(CASE WHEN is_skipped = 1 THEN 1 ELSE 0 END) AS skipped
             FROM engine_failure_tracking";
        let rows = match parent {
            Some(p) => {
                let lo = format!("{p}/");
                let hi = prefix_upper(&lo);
                sqlx::query(&format!("{base} WHERE file_path >= ? AND file_path < ? GROUP BY file_path"))
                    .bind(lo)
                    .bind(hi)
                    .fetch_all(&self.pool)
                    .await?
            }
            None => sqlx::query(&format!("{base} GROUP BY file_path")).fetch_all(&self.pool).await?,
        };

        #[derive(Default)]
        struct Node {
            total: i64,
            synced: i64,
            skipped: i64,
            has_children: bool,
        }
        let mut folders: BTreeMap<String, Node> = BTreeMap::new();
        for r in rows {
            let path: String = r.get("file_path");
            let synced: i64 = r.get("synced");
            let skipped: i64 = if synced == 1 { 0 } else { r.get("skipped") };
            let rel = match parent {
                Some(p) => path.strip_prefix(p).and_then(|s| s.strip_prefix('/')).unwrap_or(&path).to_string(),
                None => path.clone(),
            };
            let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
            if parts.len() < 2 {
                continue; // a file directly in this folder
            }
            let node = folders.entry(parts[0].to_string()).or_default();
            node.total += 1;
            node.synced += synced;
            node.skipped += skipped;
            if parts.len() > 2 {
                node.has_children = true;
            }
        }
        let mut out: Vec<FolderStat> = folders
            .into_iter()
            .map(|(name, n)| FolderStat {
                full_path: match parent {
                    Some(p) => format!("{p}/{name}"),
                    None => format!("/{name}"),
                },
                name,
                total: n.total,
                synced: n.synced,
                skipped: n.skipped,
                pending: n.total - n.synced - n.skipped,
                progress: if n.total > 0 { (n.synced as f64 / n.total as f64 * 100.0).round() as i64 } else { 0 },
                has_children: n.has_children,
            })
            .collect();
        out.sort_by(|a, b| b.total.cmp(&a.total).then(a.name.cmp(&b.name)));
        Ok(out)
    }

    pub async fn media_detail(&self, path: &str) -> sqlx::Result<Value> {
        let tracking: Vec<EngineTracking> = sqlx::query_as(
            "SELECT engine, consecutive_failures, last_failure_time, last_success_time, is_skipped
             FROM engine_failure_tracking WHERE file_path = ? ORDER BY engine",
        )
        .bind(path)
        .fetch_all(&self.pool)
        .await?;
        let rows = sqlx::query(
            "SELECT fr.run_id, fr.status, fr.engines, fr.sync_mode, fr.anchor_path, fr.updated_at,
                    r.start_time AS run_start_time, r.status AS run_status
             FROM file_results fr JOIN runs r ON fr.run_id = r.id
             WHERE fr.file_path = ? ORDER BY r.start_time DESC LIMIT 20",
        )
        .bind(path)
        .fetch_all(&self.pool)
        .await?;
        let history: Vec<Value> = rows
            .into_iter()
            .map(|r| {
                let engines: Value = r
                    .get::<Option<String>, _>("engines")
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_else(|| json!({}));
                json!({
                    "runId": r.get::<String, _>("run_id"),
                    "runStartTime": r.get::<i64, _>("run_start_time"),
                    "runStatus": r.get::<String, _>("run_status"),
                    "fileStatus": r.get::<String, _>("status"),
                    "engines": engines,
                    "syncMode": r.get::<Option<String>, _>("sync_mode"),
                    "anchorPath": r.get::<Option<String>, _>("anchor_path"),
                    "updatedAt": r.get::<i64, _>("updated_at"),
                })
            })
            .collect();
        Ok(json!({
            "filePath": path,
            "notFittingStrikes": self.not_fitting_strikes(path).await?,
            "failureTracking": tracking,
            "syncHistory": history,
        }))
    }

    // ----------------------------------------------------------- retention

    pub async fn delete_old_runs(&self, older_than_days: i64) -> sqlx::Result<u64> {
        let cutoff = now_ms() - older_than_days * 86_400_000;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM file_results WHERE run_id IN (SELECT id FROM runs WHERE start_time < ? AND status != 'running')")
            .bind(cutoff)
            .execute(&mut *tx)
            .await?;
        let r = sqlx::query("DELETE FROM runs WHERE start_time < ? AND status != 'running'")
            .bind(cutoff)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(r.rows_affected())
    }

    /// The legacy `runs.logs` column (logs live in files now) — trimmed for
    /// databases carried over from 1.x.
    pub async fn trim_old_logs(&self, older_than_days: i64, max_len: i64) -> sqlx::Result<u64> {
        let cutoff = now_ms() - older_than_days * 86_400_000;
        let r = sqlx::query(
            "UPDATE runs SET logs = SUBSTR(logs, 1, ?1) || char(10) || '... (log trimmed to save space)'
             WHERE start_time < ?2 AND LENGTH(logs) > ?1",
        )
        .bind(max_len)
        .bind(cutoff)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    pub async fn vacuum(&self) -> sqlx::Result<()> {
        sqlx::query("PRAGMA incremental_vacuum").execute(&self.pool).await?;
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn size_bytes(&self) -> sqlx::Result<i64> {
        let pages: i64 = sqlx::query_scalar("PRAGMA page_count").fetch_one(&self.pool).await?;
        let size: i64 = sqlx::query_scalar("PRAGMA page_size").fetch_one(&self.pool).await?;
        Ok(pages * size)
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_tokens() {
        assert_eq!(language_of("/m/Movie.en.srt"), Some("English"));
        assert_eq!(language_of("/m/Movie.GER.srt"), Some("German"));
        assert_eq!(language_of("/m/Movie.sdh.srt"), None);
        assert_eq!(language_of("/m/Movie.srt"), None);
    }

    #[test]
    fn prefix_bound() {
        assert_eq!(prefix_upper("/media/"), "/media0");
    }

    #[tokio::test]
    async fn run_lifecycle_and_counters() {
        let db = Db::open_memory().await.unwrap();
        db.create_run("r1", true).await.unwrap();
        db.set_run_totals("r1", 2, 4).await.unwrap();
        db.increment_run("r1", RunCounter::Completed).await.unwrap();
        db.record_run_engine_stat("r1", "alass", true).await.unwrap();
        db.record_run_engine_stat("r1", "alass", true).await.unwrap();
        db.record_run_engine_stat("r1", "ffsubsync", false).await.unwrap();
        let run = db.get_run("r1").await.unwrap().unwrap();
        assert_eq!(run.completed, 1);
        assert!(run.dry_run);
        assert_eq!(run.engine_stats["alass"].pass, 2);
        assert_eq!(run.engine_stats["alass"].fail, 0);
        assert_eq!(run.engine_stats["ffsubsync"].fail, 1);
        db.finish_run("r1", "completed").await.unwrap();
        assert_eq!(db.run_history(10).await.unwrap()[0].status, "completed");
    }

    #[tokio::test]
    async fn files_and_engine_json() {
        let db = Db::open_memory().await.unwrap();
        db.create_run("r", false).await.unwrap();
        let files: Vec<String> = (0..4500).map(|i| format!("/m/{i}.srt")).collect();
        db.insert_pending_files("r", &files).await.unwrap();
        db.update_file("r", "/m/1.srt", FileUpdate { status: Some(FileStatus::Processing), ..Default::default() })
            .await
            .unwrap();
        db.set_file_engine_result("r", "/m/1.srt", "alass", &json!({"success": true, "duration": 5})).await.unwrap();
        db.set_file_engine_result("r", "/m/1.srt", "ffsubsync", &json!({"success": false, "duration": 7}))
            .await
            .unwrap();
        let (page, total) = db.files_paginated("r", 10, 0, Some("processing")).await.unwrap();
        assert_eq!(total, 1);
        assert_eq!(page[0].engines["alass"]["success"], json!(true));
        assert_eq!(page[0].engines["ffsubsync"]["duration"], json!(7));
        let (_, all) = db.files_paginated("r", 10, 0, None).await.unwrap();
        assert_eq!(all, 4500);
    }

    #[tokio::test]
    async fn engine_skip_after_three_failures() {
        let db = Db::open_memory().await.unwrap();
        for _ in 0..2 {
            db.record_engine_failure("/a.srt", "alass").await.unwrap();
        }
        assert!(!db.is_engine_skipped("/a.srt", "alass").await.unwrap());
        db.record_engine_failure("/a.srt", "alass").await.unwrap();
        assert!(db.is_engine_skipped("/a.srt", "alass").await.unwrap());
        db.record_engine_success("/a.srt", "alass").await.unwrap();
        assert!(!db.is_engine_skipped("/a.srt", "alass").await.unwrap());
    }

    #[tokio::test]
    async fn fingerprint_resets_state_on_new_content() {
        let db = Db::open_memory().await.unwrap();
        assert!(db.refresh_fingerprint("/a.srt", "h1").await.unwrap());
        for _ in 0..3 {
            db.record_engine_failure("/a.srt", "alass").await.unwrap();
        }
        db.record_not_fitting_strike("/a.srt").await.unwrap();
        db.park_file("/a.srt", 1.0, 2, "forced_not_fitting").await.unwrap();
        assert!(!db.refresh_fingerprint("/a.srt", "h1").await.unwrap());
        assert!(db.is_engine_skipped("/a.srt", "alass").await.unwrap());
        assert!(db.refresh_fingerprint("/a.srt", "h2").await.unwrap());
        assert!(!db.is_engine_skipped("/a.srt", "alass").await.unwrap());
        assert_eq!(db.not_fitting_strikes("/a.srt").await.unwrap(), 0);
        assert!(db.load_parked().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn strikes() {
        let db = Db::open_memory().await.unwrap();
        assert_eq!(db.record_not_fitting_strike("/a.srt").await.unwrap(), 1);
        assert_eq!(db.record_not_fitting_strike("/a.srt").await.unwrap(), 2);
        db.reset_not_fitting_strikes("/a.srt").await.unwrap();
        assert_eq!(db.not_fitting_strikes("/a.srt").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn folders_roll_up() {
        let db = Db::open_memory().await.unwrap();
        db.record_engine_success("/media/tv/Show/S01/e1.en.srt", "alass").await.unwrap();
        db.record_engine_failure("/media/tv/Show/S01/e2.en.srt", "alass").await.unwrap();
        db.record_engine_success("/media/movies/M/m.de.srt", "alass").await.unwrap();
        let root = db.folder_stats(None).await.unwrap();
        assert_eq!(root.len(), 1);
        assert_eq!(root[0].full_path, "/media");
        assert_eq!(root[0].total, 3);
        let media = db.folder_stats(Some("/media")).await.unwrap();
        assert_eq!(media[0].name, "tv");
        assert_eq!(media[0].synced, 1);
        assert_eq!(media[0].pending, 1);
        assert!(media[0].has_children);
        let season = db.folder_stats(Some("/media/tv/Show")).await.unwrap();
        assert_eq!(season[0].name, "S01");
        assert!(!season[0].has_children);
        let stats = db.media_stats().await.unwrap();
        assert_eq!(stats["totalFiles"], json!(3));
        assert_eq!(stats["syncedFiles"], json!(2));
    }

    #[tokio::test]
    async fn sync_cache_roundtrip() {
        let db = Db::open_memory().await.unwrap();
        db.upsert_sync_cache(&[("/a.srt".into(), 1700000000123.4567, 42)]).await.unwrap();
        let c = db.load_sync_cache().await.unwrap();
        let e = c["/a.srt"];
        assert!(e.matches(1700000000123.4567, 42));
        assert!(!e.matches(1700000000124.0, 42));
        assert!(e.cues_verified);
        db.remove_from_sync_cache(&["/a.srt".into()]).await.unwrap();
        assert!(db.load_sync_cache().await.unwrap().is_empty());
    }
}
