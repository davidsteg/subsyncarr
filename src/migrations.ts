/**
 * Migration runner — centralized, versioned database migrations.
 * Replaces scattered ALTER TABLE statements in initSchema().
 *
 * Each migration is a function that takes the database and runs the SQL.
 * Migrations are tracked in a `migrations` table to avoid re-running.
 */

import Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  run: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_runs_table',
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
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
        );
      `);
    },
  },
  {
    version: 2,
    name: 'create_file_results_table',
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_results (
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
        );

        CREATE INDEX IF NOT EXISTS idx_file_results_run
          ON file_results(run_id);
        CREATE INDEX IF NOT EXISTS idx_file_results_status
          ON file_results(status);
      `);
    },
  },
  {
    version: 3,
    name: 'add_logs_column',
    run: (db) => {
      const columns = db.pragma('table_info(runs)') as Array<{ name: string }>;
      if (!columns.some((col) => col.name === 'logs')) {
        db.exec(`ALTER TABLE runs ADD COLUMN logs TEXT DEFAULT ''`);
      }
    },
  },
  {
    version: 4,
    name: 'add_engine_counters',
    run: (db) => {
      const columns = db.pragma('table_info(runs)') as Array<{ name: string }>;
      if (!columns.some((col) => col.name === 'total_engines')) {
        db.exec(`ALTER TABLE runs ADD COLUMN total_engines INTEGER DEFAULT 0`);
      }
      if (!columns.some((col) => col.name === 'completed_engines')) {
        db.exec(`ALTER TABLE runs ADD COLUMN completed_engines INTEGER DEFAULT 0`);
      }
    },
  },
  {
    version: 5,
    name: 'add_not_fitting_column',
    run: (db) => {
      const columns = db.pragma('table_info(runs)') as Array<{ name: string }>;
      if (!columns.some((col) => col.name === 'not_fitting')) {
        db.exec(`ALTER TABLE runs ADD COLUMN not_fitting INTEGER DEFAULT 0`);
      }
    },
  },
  {
    version: 6,
    name: 'add_engine_stats_column',
    run: (db) => {
      const columns = db.pragma('table_info(runs)') as Array<{ name: string }>;
      if (!columns.some((col) => col.name === 'engine_stats')) {
        db.exec(`ALTER TABLE runs ADD COLUMN engine_stats TEXT DEFAULT '{}'`);
      }
    },
  },
  {
    version: 7,
    name: 'add_anchor_counters',
    run: (db) => {
      const columns = db.pragma('table_info(runs)') as Array<{ name: string }>;
      if (!columns.some((col) => col.name === 'anchors_completed')) {
        db.exec(`ALTER TABLE runs ADD COLUMN anchors_completed INTEGER DEFAULT 0`);
      }
      if (!columns.some((col) => col.name === 'followers_completed')) {
        db.exec(`ALTER TABLE runs ADD COLUMN followers_completed INTEGER DEFAULT 0`);
      }
    },
  },
  {
    version: 8,
    name: 'add_sync_mode_to_file_results',
    run: (db) => {
      const frColumns = db.pragma('table_info(file_results)') as Array<{ name: string }>;
      if (!frColumns.some((col) => col.name === 'sync_mode')) {
        db.exec(`ALTER TABLE file_results ADD COLUMN sync_mode TEXT`);
      }
      if (!frColumns.some((col) => col.name === 'anchor_path')) {
        db.exec(`ALTER TABLE file_results ADD COLUMN anchor_path TEXT`);
      }
    },
  },
  {
    version: 9,
    name: 'create_synced_files_table',
    run: (db) => {
      const syncedFilesTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='synced_files'")
        .all();
      if (syncedFilesTable.length === 0) {
        db.exec(`
          CREATE TABLE synced_files (
            file_path TEXT PRIMARY KEY,
            synced_at INTEGER NOT NULL
          )
        `);
      }
    },
  },
  {
    version: 10,
    name: 'add_mtime_to_synced_files',
    run: (db) => {
      const syncedFilesColumns = db.pragma('table_info(synced_files)') as Array<{ name: string }>;
      if (!syncedFilesColumns.some((c) => c.name === 'mtime_ms')) {
        db.exec(`ALTER TABLE synced_files ADD COLUMN mtime_ms REAL`);
      }
      if (!syncedFilesColumns.some((c) => c.name === 'size_bytes')) {
        db.exec(`ALTER TABLE synced_files ADD COLUMN size_bytes INTEGER`);
      }
    },
  },
  {
    version: 11,
    name: 'create_settings_table',
    run: (db) => {
      const settingsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").all();
      if (settingsTable.length === 0) {
        db.exec(`
          CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `);
      }
    },
  },
  {
    version: 12,
    name: 'create_engine_failure_tracking_table',
    run: (db) => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='engine_failure_tracking'")
        .all();
      if (tables.length === 0) {
        db.exec(`
          CREATE TABLE engine_failure_tracking (
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
          );

          CREATE INDEX idx_failure_tracking_file ON engine_failure_tracking(file_path);
          CREATE INDEX idx_failure_tracking_skipped ON engine_failure_tracking(is_skipped);
        `);
      }
    },
  },
  {
    version: 13,
    name: 'create_not_fitting_tracking_table',
    run: (db) => {
      const notFittingTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='not_fitting_tracking'")
        .all();
      if (notFittingTable.length === 0) {
        db.exec(`
          CREATE TABLE not_fitting_tracking (
            file_path TEXT PRIMARY KEY,
            consecutive_strikes INTEGER NOT NULL DEFAULT 0,
            last_strike_time INTEGER,
            updated_at INTEGER NOT NULL
          );
        `);
      }
    },
  },
  {
    version: 14,
    name: 'add_file_results_run_updated_index',
    run: (db) => {
      // The live-view query (getActiveAndRecentFiles) filters by run_id and
      // ORDERs BY updated_at DESC. With only the single-column idx_file_results_run,
      // SQLite had to collect every row for the run and sort them — ~115k rows
      // on a large active run, which blocked the synchronous event loop for
      // ~40-50s per dashboard poll. This composite lets it walk the index
      // backwards and stop at LIMIT, turning that query from seconds into
      // sub-millisecond.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_file_results_run_updated
          ON file_results(run_id, updated_at);
      `);
    },
  },
  {
    version: 15,
    name: 'create_file_fingerprints_and_parked_files',
    run: (db) => {
      // file_fingerprints: content hash per subtitle path, so engine-skip and
      // not-fitting strike state (both keyed by path only) can be reset when a
      // new subtitle replaces the old one at the same path.
      // parked_files: subtitles that repeatedly didn't fit but must not be
      // deleted (forced subs). Skipped by the scan while mtime/size match.
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_fingerprints (
          file_path TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS parked_files (
          file_path TEXT PRIMARY KEY,
          mtime_ms REAL NOT NULL,
          size_bytes INTEGER NOT NULL,
          reason TEXT,
          parked_at INTEGER NOT NULL
        );
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  // Get current migration version
  const currentVersion =
    (db.prepare('SELECT MAX(version) as max_version FROM migrations').get() as { max_version: number | null })
      ?.max_version ?? 0;

  // Run pending migrations
  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      console.log(`[${new Date().toISOString()}] Running migration ${migration.version}: ${migration.name}`);
      migration.run(db);
      db.prepare('INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
    }
  }
}
