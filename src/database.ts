import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface Run {
  id: string;
  start_time: number;
  end_time: number | null;
  total_files: number;
  completed: number;
  skipped: number;
  failed: number;
  not_fitting: number;
  total_engines: number;
  completed_engines: number;
  status: 'running' | 'completed' | 'cancelled';
  logs: string;
  engine_stats: string;
}

export interface FileResult {
  id: number;
  run_id: string;
  file_path: string;
  video_path: string | null;
  status: 'pending' | 'processing' | 'completed' | 'skipped' | 'error' | 'not_fitting';
  current_engine: string | null;
  engines: string; // JSON stringified { ffsubsync?: {...}, autosubsync?: {...}, alass?: {...} }
  created_at: number;
  updated_at: number;
}

export interface EngineFailureTracking {
  id: number;
  file_path: string;
  engine: string;
  consecutive_failures: number;
  last_failure_time: number | null;
  last_success_time: number | null;
  is_skipped: boolean;
  created_at: number;
  updated_at: number;
}

export class SubsyncarrPlusDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore — will fail on db open if truly inaccessible
    }
    try {
      this.db = new Database(dbPath);
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 'SQLITE_CANTOPEN') {
        throw new Error(
          `Cannot open database at ${dbPath} — ensure the data directory exists and is writable. ` +
            `If using Docker, check that your volume mount target exists and has correct permissions (PUID/PGID).`,
        );
      }
      throw err;
    }
    this.initSchema();
  }

  private initSchema() {
    // Optimize SQLite for throughput during bulk operations
    this.db.pragma('cache_size = -64000'); // 64MB cache for bulk workloads
    this.db.pragma('mmap_size = 268435456'); // 256MB mmap — OS page-cache reads
    this.db.pragma('journal_mode = WAL'); // Better concurrency
    this.db.pragma('synchronous = NORMAL'); // Safe with WAL, much faster writes
    this.db.pragma('temp_store = MEMORY'); // Keep temp data in memory
    this.db.pragma('auto_vacuum = INCREMENTAL'); // Reclaim space gradually

    this.db.exec(`
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

    // Migration: Add logs column if it doesn't exist
    const columns = this.db.pragma('table_info(runs)') as Array<{ name: string }>;
    const hasLogsColumn = columns.some((col) => col.name === 'logs');
    if (!hasLogsColumn) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN logs TEXT DEFAULT ''`);
    }

    // Migration: Add total_engines and completed_engines columns if they don't exist
    const hasTotalEnginesColumn = columns.some((col) => col.name === 'total_engines');
    if (!hasTotalEnginesColumn) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN total_engines INTEGER DEFAULT 0`);
    }
    const hasCompletedEnginesColumn = columns.some((col) => col.name === 'completed_engines');
    if (!hasCompletedEnginesColumn) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN completed_engines INTEGER DEFAULT 0`);
    }

    // Migration: Add not_fitting column if it doesn't exist
    const hasNotFittingColumn = columns.some((col) => col.name === 'not_fitting');
    if (!hasNotFittingColumn) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN not_fitting INTEGER DEFAULT 0`);
    }

    // Migration: Add engine_stats column if it doesn't exist
    const hasEngineStatsColumn = columns.some((col) => col.name === 'engine_stats');
    if (!hasEngineStatsColumn) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN engine_stats TEXT DEFAULT '{}'`);
    }

    // Migration: Create synced_files cache table — avoids re-scanning 183K SRT headers
    const syncedFilesTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='synced_files'")
      .all();
    if (syncedFilesTable.length === 0) {
      this.db.exec(`
        CREATE TABLE synced_files (
          file_path TEXT PRIMARY KEY,
          synced_at INTEGER NOT NULL
        )
      `);
    }

    // Migration: Create settings table for runtime configuration
    const settingsTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
      .all();
    if (settingsTable.length === 0) {
      this.db.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    // Migration: Create engine_failure_tracking table
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='engine_failure_tracking'")
      .all();
    if (tables.length === 0) {
      this.db.exec(`
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
  }

  // Run methods
  createRun(id: string, totalFiles: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO runs (id, start_time, total_files, status)
      VALUES (?, ?, ?, 'running')
    `);
    stmt.run(id, Date.now(), totalFiles);
  }

  updateRun(id: string, updates: Partial<Run>): void {
    const fields = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(', ');
    const values = Object.values(updates);
    this.db.prepare(`UPDATE runs SET ${fields} WHERE id = ?`).run(...values, id);
  }

  /**
   * Atomically increment a numeric column on a run.
   * Uses SQL `SET field = field + 1` to avoid read-then-write race and overhead.
   */
  // v1.3.7 fix: removed updated_at

  updateEngineStats(runId: string, engineStats: string): void {
    this.db.prepare('UPDATE runs SET engine_stats = ? WHERE id = ?').run(engineStats, runId);
  }

  incrementRunField(id: string, field: 'completed' | 'skipped' | 'failed' | 'not_fitting' | 'completed_engines'): void {
    this.db.prepare(`UPDATE runs SET ${field} = ${field} + 1 WHERE id = ?`).run(id);
  }

  getRun(id: string): Run | null {
    const result = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return result ? (result as Run) : null;
  }

  getRunHistory(limit: number = 50): Run[] {
    return this.db
      .prepare(
        `
      SELECT * FROM runs
      ORDER BY start_time DESC
      LIMIT ?
    `,
      )
      .all(limit) as Run[];
  }

  /**
   * Delete old runs and their associated file results
   */
  deleteOldRuns(olderThanDays: number): number {
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    // Use transaction for atomicity
    const deleteFiles = this.db.prepare(
      'DELETE FROM file_results WHERE run_id IN (SELECT id FROM runs WHERE start_time < ?)',
    );
    const deleteRuns = this.db.prepare('DELETE FROM runs WHERE start_time < ?');

    const transaction = this.db.transaction(() => {
      deleteFiles.run(cutoffTime);
      const result = deleteRuns.run(cutoffTime);
      return result.changes;
    });

    return transaction();
  }

  /**
   * Trim logs for runs older than specified days, keeping only summary
   */
  trimOldLogs(olderThanDays: number, maxLogLength: number = 1000): number {
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    const stmt = this.db.prepare(`
      UPDATE runs
      SET logs = SUBSTR(logs, 1, ?) || '\n... (log trimmed to save space)'
      WHERE start_time < ? AND LENGTH(logs) > ?
    `);

    const result = stmt.run(maxLogLength, cutoffTime, maxLogLength);
    return result.changes;
  }

  /**
   * Vacuum database to reclaim space after deletions
   */
  vacuum(): void {
    this.db.pragma('incremental_vacuum');
  }

  /**
   * Get database file size statistics
   */
  getDatabaseStats(): { sizeBytes: number; pageCount: number; pageSize: number } {
    const pageCount = this.db.pragma('page_count', { simple: true }) as number;
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;

    return {
      pageCount,
      pageSize,
      sizeBytes: pageCount * pageSize,
    };
  }

  // File methods
  createFileResult(runId: string, filePath: string, videoPath: string | null): void {
    const stmt = this.db.prepare(`
      INSERT INTO file_results
        (run_id, file_path, video_path, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `);
    const now = Date.now();
    stmt.run(runId, filePath, videoPath, now, now);
  }

  /**
   * Batch insert file results in a single transaction.
   * Orders of magnitude faster than individual inserts for large file counts.
   */
  batchCreateFileResults(runId: string, files: string[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO file_results
        (run_id, file_path, video_path, status, created_at, updated_at)
      VALUES (?, ?, NULL, 'pending', ?, ?)
    `);
    const now = Date.now();
    const insertMany = this.db.transaction(() => {
      for (const filePath of files) {
        stmt.run(runId, filePath, now, now);
      }
    });
    insertMany();
  }

  updateFileResult(runId: string, filePath: string, updates: Partial<FileResult>): void {
    const updatesWithTimestamp = { ...updates, updated_at: Date.now() };
    const fields = Object.keys(updatesWithTimestamp)
      .map((k) => `${k} = ?`)
      .join(', ');
    const values = Object.values(updatesWithTimestamp);
    this.db
      .prepare(
        `
      UPDATE file_results
      SET ${fields}
      WHERE run_id = ? AND file_path = ?
    `,
      )
      .run(...values, runId, filePath);
  }

  getFileResults(runId: string): FileResult[] {
    return this.db
      .prepare(
        `
      SELECT * FROM file_results
      WHERE run_id = ?
      ORDER BY created_at ASC
    `,
      )
      .all(runId) as FileResult[];
  }

  getFileResult(runId: string, filePath: string): FileResult | null {
    return this.db
      .prepare('SELECT * FROM file_results WHERE run_id = ? AND file_path = ?')
      .get(runId, filePath) as FileResult | null;
  }

  getFileResultsPaginated(runId: string, limit: number, offset: number): { files: FileResult[]; total: number } {
    const total = (
      this.db.prepare('SELECT COUNT(*) as count FROM file_results WHERE run_id = ?').get(runId) as { count: number }
    ).count;
    const files = this.db
      .prepare('SELECT * FROM file_results WHERE run_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?')
      .all(runId, limit, offset) as FileResult[];
    return { files, total };
  }

  // Engine failure tracking methods
  getEngineFailureTracking(filePath: string, engine: string): EngineFailureTracking | null {
    return this.db
      .prepare(
        `SELECT * FROM engine_failure_tracking
         WHERE file_path = ? AND engine = ?`,
      )
      .get(filePath, engine) as EngineFailureTracking | null;
  }

  getAllSkippedEngines(filePath: string): string[] {
    const results = this.db
      .prepare(
        `SELECT engine FROM engine_failure_tracking
         WHERE file_path = ? AND is_skipped = 1`,
      )
      .all(filePath) as Array<{ engine: string }>;
    return results.map((r) => r.engine);
  }

  recordEngineFailure(filePath: string, engine: string): void {
    const existing = this.getEngineFailureTracking(filePath, engine);
    const now = Date.now();

    if (existing) {
      const newFailureCount = existing.consecutive_failures + 1;
      const isSkipped = newFailureCount >= 3;

      this.db
        .prepare(
          `
        UPDATE engine_failure_tracking
        SET consecutive_failures = ?,
            last_failure_time = ?,
            is_skipped = ?,
            updated_at = ?
        WHERE file_path = ? AND engine = ?
      `,
        )
        .run(newFailureCount, now, isSkipped ? 1 : 0, now, filePath, engine);
    } else {
      this.db
        .prepare(
          `
        INSERT INTO engine_failure_tracking
          (file_path, engine, consecutive_failures, last_failure_time,
           is_skipped, created_at, updated_at)
        VALUES (?, ?, 1, ?, 0, ?, ?)
      `,
        )
        .run(filePath, engine, now, now, now);
    }
  }

  recordEngineSuccess(filePath: string, engine: string): void {
    const existing = this.getEngineFailureTracking(filePath, engine);
    const now = Date.now();

    if (existing) {
      this.db
        .prepare(
          `
        UPDATE engine_failure_tracking
        SET consecutive_failures = 0,
            last_success_time = ?,
            is_skipped = 0,
            updated_at = ?
        WHERE file_path = ? AND engine = ?
      `,
        )
        .run(now, now, filePath, engine);
    } else {
      this.db
        .prepare(
          `
        INSERT INTO engine_failure_tracking
          (file_path, engine, consecutive_failures, last_success_time,
           is_skipped, created_at, updated_at)
        VALUES (?, ?, 0, ?, 0, ?, ?)
      `,
        )
        .run(filePath, engine, now, now, now);
    }
  }

  resetEngineSkipStatus(filePath: string, engine?: string): void {
    const now = Date.now();

    if (engine) {
      // Reset specific engine for specific file
      this.db
        .prepare(
          `
        UPDATE engine_failure_tracking
        SET consecutive_failures = 0,
            is_skipped = 0,
            updated_at = ?
        WHERE file_path = ? AND engine = ?
      `,
        )
        .run(now, filePath, engine);
    } else {
      // Reset all engines for specific file
      this.db
        .prepare(
          `
        UPDATE engine_failure_tracking
        SET consecutive_failures = 0,
            is_skipped = 0,
            updated_at = ?
        WHERE file_path = ?
      `,
        )
        .run(now, filePath);
    }
  }

  getFailureTrackingStats(): {
    totalSkipped: number;
    skippedByEngine: Record<string, number>;
  } {
    const totalSkipped = this.db
      .prepare('SELECT COUNT(DISTINCT file_path) as count FROM engine_failure_tracking WHERE is_skipped = 1')
      .get() as { count: number };

    const byEngine = this.db
      .prepare('SELECT engine, COUNT(*) as count FROM engine_failure_tracking WHERE is_skipped = 1 GROUP BY engine')
      .all() as Array<{ engine: string; count: number }>;

    const skippedByEngine: Record<string, number> = {};
    byEngine.forEach((row) => {
      skippedByEngine[row.engine] = row.count;
    });

    return { totalSkipped: totalSkipped.count, skippedByEngine };
  }

  // Media stats queries
  getMediaStats() {
    const totalFiles = this.db.prepare('SELECT COUNT(*) as count FROM engine_failure_tracking').get() as {
      count: number;
    };

    const syncedFiles = this.db
      .prepare('SELECT COUNT(*) as count FROM engine_failure_tracking WHERE last_success_time IS NOT NULL')
      .get() as { count: number };

    const skippedCount = this.db
      .prepare('SELECT COUNT(*) as count FROM engine_failure_tracking WHERE is_skipped = 1')
      .get() as { count: number };

    // File counts by engine success
    const engineStats = this.db
      .prepare(
        'SELECT engine, COUNT(*) as total, SUM(CASE WHEN last_success_time IS NOT NULL THEN 1 ELSE 0 END) as synced FROM engine_failure_tracking GROUP BY engine',
      )
      .all() as Array<{ engine: string; total: number; synced: number }>;

    // Language distribution (parse from filename: .en.srt, .ger.srt, etc.)
    const langStats = this.db
      .prepare(
        "SELECT SUBSTR(file_path, -7, 2) as lang, COUNT(*) as count FROM engine_failure_tracking WHERE file_path LIKE '%.__srt' OR file_path LIKE '%.___.srt' OR file_path LIKE '%.____.srt' GROUP BY lang ORDER BY count DESC LIMIT 20",
      )
      .all() as Array<{ lang: string; count: number }>;

    // Filter to only real language codes (2 lowercase letters)
    const realLangs = langStats.filter((l) => /^[a-z]{2}$/.test(l.lang));

    return {
      totalFiles: totalFiles.count,
      syncedFiles: syncedFiles.count,
      skippedFiles: skippedCount.count,
      syncRate: totalFiles.count > 0 ? Math.round((syncedFiles.count / totalFiles.count) * 100) : 0,
      engines: engineStats.map((e) => ({ ...e, rate: e.total > 0 ? Math.round((e.synced / e.total) * 100) : 0 })),
      languages: realLangs.slice(0, 10),
    };
  }

  // Folder tree with progress stats — accepts optional sub-path for drill-down
  getFolderStats(parentPath?: string) {
    // Get all distinct folder paths with their file counts and sync stats
    let query = `SELECT 
        file_path,
        CASE WHEN last_success_time IS NOT NULL THEN 1 ELSE 0 END as synced,
        CASE WHEN is_skipped = 1 THEN 1 ELSE 0 END as skipped
       FROM engine_failure_tracking`;
    const params: string[] = [];
    
    if (parentPath) {
      query += ` WHERE file_path LIKE ?`;
      params.push(parentPath + '/%');
    }
    
    const rows = this.db.prepare(query).all(...params) as Array<{ file_path: string; synced: number; skipped: number }>;
    
    interface FolderNode {
      total: number;
      synced: number;
      skipped: number;
      children: Record<string, FolderNode>;
    }

    // Build folder tree from file paths
    const folders: Record<string, FolderNode> = {};

    for (const row of rows) {
      let relativePath = row.file_path;
      if (parentPath && relativePath.startsWith(parentPath + '/')) {
        relativePath = relativePath.substring(parentPath.length + 1);
      }
      const parts = relativePath.split('/').filter(Boolean);
      // Skip filename (last element)
      let current = folders;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!current[part]) {
          current[part] = { total: 0, synced: 0, skipped: 0, children: {} };
        }
        current[part].total++;
        current[part].synced += row.synced;
        current[part].skipped += row.skipped;
        current = current[part].children;
      }
    }
    // Convert to sorted array
    const result = Object.entries(folders)
      .map(([name, data]) => ({
        name,
        fullPath: parentPath ? parentPath + '/' + name : '/' + name,
        total: data.total,
        synced: data.synced,
        skipped: data.skipped,
        pending: data.total - data.synced - data.skipped,
        progress: data.total > 0 ? Math.round((data.synced / data.total) * 100) : 0,
        hasChildren: Object.keys(data.children).length > 0,
      }))
      .sort((a, b) => b.total - a.total);

    return result;
  }

  // === Synced files cache ===
  // Speeds up findAllSrtFiles by skipping the header read for files we already know are synced.

  isFileInSyncCache(filePath: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM synced_files WHERE file_path = ?').get(filePath);
    return !!row;
  }

  addFileToSyncCache(filePath: string): void {
    this.db.prepare('INSERT OR REPLACE INTO synced_files (file_path, synced_at) VALUES (?, ?)').run(filePath, Date.now());
  }

  // Settings methods
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?'
    ).run(key, value, now, value, now);
  }

  getAllSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{ key: string; value: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  // Get detailed info for a specific media file
  getMediaDetail(filePath: string) {
    // Engine failure tracking for this file
    const failureTracking = this.db.prepare(
      'SELECT * FROM engine_failure_tracking WHERE file_path = ?'
    ).all(filePath) as EngineFailureTracking[];

    // Recent file_results across runs for this file
    const fileResults = this.db.prepare(
      `SELECT fr.*, r.start_time as run_start_time, r.status as run_status
       FROM file_results fr
       JOIN runs r ON fr.run_id = r.id
       WHERE fr.file_path = ?
       ORDER BY r.start_time DESC
       LIMIT 20`
    ).all(filePath) as Array<FileResult & { run_start_time: number; run_status: string }>;

    // Parse engines JSON for each result to extract shift/offset info
    const syncHistory = fileResults.map(fr => {
      let engines: Record<string, any> = {};
      try { engines = JSON.parse(fr.engines); } catch(e) {}
      return {
        runId: fr.run_id,
        runStartTime: fr.run_start_time,
        runStatus: fr.run_status,
        fileStatus: fr.status,
        engines,
        updatedAt: fr.updated_at,
      };
    });

    return {
      filePath,
      failureTracking,
      syncHistory,
    };
  }

  close() {
    this.db.close();
  }
}