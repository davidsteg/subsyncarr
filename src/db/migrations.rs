//! Versioned schema migrations, tracked in the same `migrations` table the
//! 1.x TypeScript app used — an existing `subsyncarr-plus.db` upgrades in
//! place (versions 1–14 are already applied there and are skipped).

use sqlx::{Row, SqlitePool};
use tracing::info;

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static [&'static str],
    /// Columns to add only if missing: (table, column, definition).
    add_columns: &'static [(&'static str, &'static str, &'static str)],
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "create_runs_table",
        sql: &["CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            start_time INTEGER NOT NULL,
            end_time INTEGER,
            total_files INTEGER NOT NULL,
            completed INTEGER DEFAULT 0,
            skipped INTEGER DEFAULT 0,
            failed INTEGER DEFAULT 0,
            not_fitting INTEGER DEFAULT 0,
            total_engines INTEGER DEFAULT 0,
            completed_engines INTEGER DEFAULT 0,
            status TEXT NOT NULL,
            logs TEXT DEFAULT '',
            engine_stats TEXT DEFAULT '{}'
        )"],
        add_columns: &[],
    },
    Migration {
        version: 2,
        name: "create_file_results_table",
        sql: &[
            "CREATE TABLE IF NOT EXISTS file_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                video_path TEXT,
                status TEXT NOT NULL,
                current_engine TEXT,
                engines TEXT DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(run_id) REFERENCES runs(id)
            )",
            "CREATE INDEX IF NOT EXISTS idx_file_results_run ON file_results(run_id)",
            "CREATE INDEX IF NOT EXISTS idx_file_results_status ON file_results(status)",
        ],
        add_columns: &[],
    },
    Migration { version: 3, name: "add_logs_column", sql: &[], add_columns: &[("runs", "logs", "TEXT DEFAULT ''")] },
    Migration {
        version: 4,
        name: "add_engine_counters",
        sql: &[],
        add_columns: &[
            ("runs", "total_engines", "INTEGER DEFAULT 0"),
            ("runs", "completed_engines", "INTEGER DEFAULT 0"),
        ],
    },
    Migration {
        version: 5,
        name: "add_not_fitting_column",
        sql: &[],
        add_columns: &[("runs", "not_fitting", "INTEGER DEFAULT 0")],
    },
    Migration {
        version: 6,
        name: "add_engine_stats_column",
        sql: &[],
        add_columns: &[("runs", "engine_stats", "TEXT DEFAULT '{}'")],
    },
    Migration {
        version: 7,
        name: "add_anchor_counters",
        sql: &[],
        add_columns: &[
            ("runs", "anchors_completed", "INTEGER DEFAULT 0"),
            ("runs", "followers_completed", "INTEGER DEFAULT 0"),
        ],
    },
    Migration {
        version: 8,
        name: "add_sync_mode_to_file_results",
        sql: &[],
        add_columns: &[("file_results", "sync_mode", "TEXT"), ("file_results", "anchor_path", "TEXT")],
    },
    Migration {
        version: 9,
        name: "create_synced_files_table",
        sql: &["CREATE TABLE IF NOT EXISTS synced_files (file_path TEXT PRIMARY KEY, synced_at INTEGER NOT NULL)"],
        add_columns: &[],
    },
    Migration {
        version: 10,
        name: "add_mtime_to_synced_files",
        sql: &[],
        add_columns: &[("synced_files", "mtime_ms", "REAL"), ("synced_files", "size_bytes", "INTEGER")],
    },
    Migration {
        version: 11,
        name: "create_settings_table",
        sql: &["CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"],
        add_columns: &[],
    },
    Migration {
        version: 12,
        name: "create_engine_failure_tracking_table",
        sql: &[
            "CREATE TABLE IF NOT EXISTS engine_failure_tracking (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                engine TEXT NOT NULL,
                consecutive_failures INTEGER DEFAULT 0,
                last_failure_time INTEGER,
                last_success_time INTEGER,
                is_skipped BOOLEAN DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(file_path, engine)
            )",
            "CREATE INDEX IF NOT EXISTS idx_failure_tracking_file ON engine_failure_tracking(file_path)",
            "CREATE INDEX IF NOT EXISTS idx_failure_tracking_skipped ON engine_failure_tracking(is_skipped)",
        ],
        add_columns: &[],
    },
    Migration {
        version: 13,
        name: "create_not_fitting_tracking_table",
        sql: &["CREATE TABLE IF NOT EXISTS not_fitting_tracking (
            file_path TEXT PRIMARY KEY,
            consecutive_strikes INTEGER NOT NULL DEFAULT 0,
            last_strike_time INTEGER,
            updated_at INTEGER NOT NULL
        )"],
        add_columns: &[],
    },
    Migration {
        version: 14,
        name: "add_file_results_run_updated_index",
        sql: &["CREATE INDEX IF NOT EXISTS idx_file_results_run_updated ON file_results(run_id, updated_at)"],
        add_columns: &[],
    },
    // Same as 1.3.42 (sync-audit fixes), so a DB from either line upgrades.
    Migration {
        version: 15,
        name: "create_file_fingerprints_and_parked_files",
        sql: &[
            // Content hash per path: engine-skip / strike state is reset when a
            // new subtitle replaces the old one at the same path.
            "CREATE TABLE IF NOT EXISTS file_fingerprints (
                file_path TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            // Subtitles that repeatedly didn't fit but must not be deleted
            // (forced subs). Skipped by the scan while mtime/size match.
            "CREATE TABLE IF NOT EXISTS parked_files (
                file_path TEXT PRIMARY KEY,
                mtime_ms REAL NOT NULL,
                size_bytes INTEGER NOT NULL,
                reason TEXT,
                parked_at INTEGER NOT NULL
            )",
        ],
        add_columns: &[],
    },
    // ---- 2.0 (Rust) ----
    Migration {
        version: 16,
        name: "rust_rewrite_indexes_and_columns",
        sql: &[
            // Every per-file UPDATE is keyed by (run_id, file_path). With only
            // the run_id index each one scanned the whole run (180k rows on a
            // full library run) — O(n²) over a run.
            "CREATE INDEX IF NOT EXISTS idx_file_results_run_path ON file_results(run_id, file_path)",
            // Paginated per-status listings in run detail.
            "CREATE INDEX IF NOT EXISTS idx_file_results_run_status ON file_results(run_id, status, created_at)",
            // Media detail joins file history by path.
            "CREATE INDEX IF NOT EXISTS idx_file_results_path ON file_results(file_path)",
            "CREATE INDEX IF NOT EXISTS idx_runs_start ON runs(start_time)",
        ],
        add_columns: &[
            ("runs", "dry_run", "INTEGER DEFAULT 0"),
            // Set once a cached synced file has been fully read and confirmed
            // to have cues and no legacy header, so steady-state scans read
            // zero file content.
            ("synced_files", "cues_verified", "INTEGER DEFAULT 0"),
        ],
    },
    Migration {
        version: 17,
        name: "sync_quality_and_subtitle_backups",
        sql: &[
            // Confidence of the sync currently on disk. score is NULL when
            // only a manual offset is known (file synced before 2.1).
            "CREATE TABLE IF NOT EXISTS sync_quality (
                file_path TEXT PRIMARY KEY,
                score INTEGER,
                level TEXT,
                details TEXT,
                source TEXT NOT NULL,
                manual_offset_ms INTEGER NOT NULL DEFAULT 0,
                reviewed INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            )",
            "CREATE INDEX IF NOT EXISTS idx_sync_quality_review ON sync_quality(reviewed, score)",
            // Undo stack for manual re-sync / offset changes: the file as it
            // was before each action.
            "CREATE TABLE IF NOT EXISTS subtitle_backups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                content BLOB NOT NULL,
                action TEXT NOT NULL,
                offset_ms INTEGER,
                quality TEXT,
                after_hash TEXT,
                created_at INTEGER NOT NULL
            )",
            "CREATE INDEX IF NOT EXISTS idx_subtitle_backups_path ON subtitle_backups(file_path, id)",
        ],
        add_columns: &[("file_results", "quality_score", "INTEGER")],
    },
];

async fn has_column(pool: &SqlitePool, table: &str, column: &str) -> sqlx::Result<bool> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})")).fetch_all(pool).await?;
    Ok(rows.iter().any(|r| r.get::<String, _>("name") == column))
}

pub async fn run(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    )
    .execute(pool)
    .await?;
    let current: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM migrations").fetch_one(pool).await?;

    for m in MIGRATIONS.iter().filter(|m| m.version > current) {
        info!("Running migration {}: {}", m.version, m.name);
        let mut tx = pool.begin().await?;
        for stmt in m.sql {
            sqlx::query(stmt).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        for (table, column, def) in m.add_columns {
            if !has_column(pool, table, column).await? {
                sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {column} {def}")).execute(pool).await?;
            }
        }
        sqlx::query("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)")
            .bind(m.version)
            .bind(m.name)
            .bind(crate::now_ms())
            .execute(pool)
            .await?;
    }
    Ok(())
}
