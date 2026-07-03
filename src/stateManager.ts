import EventEmitter from 'events';
import { SubsyncarrPlusDatabase, Run, FileResult } from './database';
import { randomUUID } from 'crypto';
import { LogFileManager } from './logFileManager';
import * as path from 'path';

export class StateManager extends EventEmitter {
  private db: SubsyncarrPlusDatabase;
  private currentRunId: string | null = null;
  private logFileManager: LogFileManager;

  constructor(dbPath: string) {
    super();
    this.db = new SubsyncarrPlusDatabase(dbPath);

    // Create log file manager in same directory as database
    const logDir = path.join(path.dirname(dbPath), 'logs');
    this.logFileManager = new LogFileManager(logDir);

    this.handleIncompleteRuns();
  }

  private handleIncompleteRuns(): void {
    // Find any runs that are still marked as 'running' from a previous session
    const history = this.db.getRunHistory(100);
    const incompleteRuns = history.filter((run) => run.status === 'running');

    incompleteRuns.forEach((run) => {
      console.log(`[${new Date().toISOString()}] Found incomplete run from previous session: ${run.id}`);
      this.db.updateRun(run.id, {
        status: 'cancelled',
        end_time: Date.now(),
      });
      console.log(`[${new Date().toISOString()}] Marked run ${run.id} as cancelled`);
    });
  }

  // Run management
  startRun(totalFiles: number, enabledEngines: string[] = ['ffsubsync', 'autosubsync', 'alass']): string {
    const runId = randomUUID();
    this.db.createRun(runId, totalFiles);

    // Set the total number of engines that will run (total_files * enabled_engines)
    const totalEngines = totalFiles * enabledEngines.length;
    this.db.updateRun(runId, { total_engines: totalEngines });

    this.currentRunId = runId;

    // Start log file for this run
    this.logFileManager.startRun(runId);

    const run = this.db.getRun(runId)!;
    this.emit('run:started', run);
    return runId;
  }

  completeRun(runId: string): void {
    this.db.updateRun(runId, {
      end_time: Date.now(),
      status: 'completed',
    });

    // End log file for this run
    this.logFileManager.endRun(runId);

    if (this.currentRunId === runId) {
      this.currentRunId = null;
    }

    const run = this.db.getRun(runId)!;
    this.emit('run:completed', run);
  }

  cancelRun(runId: string): void {
    this.db.updateRun(runId, {
      end_time: Date.now(),
      status: 'cancelled',
    });

    // End log file for this run
    this.logFileManager.endRun(runId);

    if (this.currentRunId === runId) {
      this.currentRunId = null;
    }

    const run = this.db.getRun(runId)!;
    this.emit('run:cancelled', run);
  }

  incrementRunCounter(runId: string, field: 'completed' | 'skipped' | 'failed'): void {
    const run = this.db.getRun(runId)!;
    this.db.updateRun(runId, {
      [field]: run[field] + 1,
    });
  }

  incrementCompletedEngines(runId: string): void {
    const run = this.db.getRun(runId)!;
    this.db.updateRun(runId, {
      completed_engines: run.completed_engines + 1,
    });
  }

  // File management
  addFile(runId: string, filePath: string, videoPath: string | null): void {
    this.db.createFileResult(runId, filePath, videoPath);
    this.emitFileUpdate(runId, filePath);
  }

  addFileBatch(runId: string, files: Array<{ filePath: string; videoPath: string | null }>): void {
    this.db.createFileResultsBatch(runId, files);
    // Emit updates for first 200 files so the WebSocket gets initial state
    const batchSize = Math.min(files.length, 200);
    for (let i = 0; i < batchSize; i++) {
      this.emitFileUpdate(runId, files[i].filePath);
    }
  }

  updateFileStatus(runId: string, filePath: string, status: FileResult['status'], currentEngine?: string | null): void {
    const updates: Partial<FileResult> = { status };
    if (currentEngine !== undefined) {
      updates.current_engine = currentEngine;
    }

    this.db.updateFileResult(runId, filePath, updates);
    this.emitFileUpdate(runId, filePath);
  }

  updateFileEngine(
    runId: string,
    filePath: string,
    engine: string,
    result: {
      success: boolean;
      duration: number;
      message: string;
      stdout?: string;
      stderr?: string;
      skipped?: boolean;
    },
  ): void {
    const file = this.db.getFileResult(runId, filePath);

    if (file) {
      const engines = JSON.parse(file.engines);
      // Strip stdout/stderr to keep DB lean — message field already has the summary
      const { stdout, stderr, ...leanResult } = result;
      engines[engine] = leanResult;

      this.db.updateFileResult(runId, filePath, {
        engines: JSON.stringify(engines),
      });

      // Update failure tracking
      if (result.skipped) {
        // Skipped engines don't affect failure count
      } else if (result.success) {
        this.db.recordEngineSuccess(filePath, engine);
      } else {
        this.db.recordEngineFailure(filePath, engine);
      }

      this.emitFileUpdate(runId, filePath);
    }
  }

  private emitFileUpdate(runId: string, filePath: string): void {
    const file = this.db.getFileResult(runId, filePath);
    if (file) {
      const run = this.db.getRun(runId);
      this.emit('file:updated', { file, run });
    }
  }

  clearCompletedFiles(): void {
    if (!this.currentRunId) {
      return;
    }

    const deleted = this.db.deleteFileResultsByStatus(this.currentRunId, ['completed', 'skipped', 'error']);
    if (deleted > 0) {
      console.log(`[${new Date().toISOString()}] Cleared ${deleted} completed/skipped/error files from run ${this.currentRunId}`);
    }
  }

  // Query methods
  getCurrentRun(): Run | null {
    return this.currentRunId ? this.db.getRun(this.currentRunId) : null;
  }

  getRunById(runId: string): Run | null {
    return this.db.getRun(runId);
  }

  getRunHistory(limit?: number, offset?: number): Run[] {
    return this.db.getRunHistory(limit, offset);
  }

  getHistoryWithStats(limit?: number, offset?: number) {
    return this.db.getHistoryWithStats(limit, offset);
  }

  getFileResults(runId: string, limit?: number, offset?: number): FileResult[] {
    return this.db.getFileResults(runId, limit, offset);
  }

  getFileCount(runId: string): number {
    return this.db.getFileCount(runId);
  }

  getEngineStats(runId: string) {
    return this.db.getEngineStats(runId);
  }

  appendLog(runId: string, logMessage: string): void {
    // Write to log file instead of database
    this.logFileManager.appendLog(runId, logMessage);
  }

  getRunLogs(runId: string): string {
    // Read logs from file
    return this.logFileManager.readLog(runId);
  }

  getDatabase(): SubsyncarrPlusDatabase {
    return this.db;
  }

  getLogFileManager(): LogFileManager {
    return this.logFileManager;
  }

  // Engine skip logic methods
  getSkippedEngines(filePath: string): string[] {
    return this.db.getAllSkippedEngines(filePath);
  }

  shouldSkipEngine(filePath: string, engine: string): boolean {
    const tracking = this.db.getEngineFailureTracking(filePath, engine);
    return tracking ? tracking.is_skipped : false;
  }

  resetSkipStatus(filePath: string, engine?: string): void {
    this.db.resetEngineSkipStatus(filePath, engine);
  }

  getFailureStats() {
    return this.db.getFailureTrackingStats();
  }

  close() {
    this.logFileManager.close();
    this.db.close();
  }
}
