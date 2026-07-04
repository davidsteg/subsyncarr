import { ProcessingEngine } from './processingEngine';
import { StateManager } from './stateManager';
import { ScanConfig } from './config';

export class ProcessingCoordinator {
  private processingPromise: Promise<void> | null = null;
  private enabledEngines: string[];
  private currentRunId: string | null = null;
  private stopRequested: boolean = false;

  constructor(
    private engine: ProcessingEngine,
    private stateManager: StateManager,
  ) {
    this.enabledEngines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];

    // Inject stateManager into engine so it can check skip status
    this.engine.stateManager = this.stateManager;

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.engine.on('log', (message: string) => {
      if (this.currentRunId) {
        this.stateManager.appendLog(this.currentRunId, message);
      }
    });

    this.engine.on('run:files_found', (files: string[]) => {
      // Update the pending run with real file totals
      const totalEngines = files.length * this.enabledEngines.length;
      this.stateManager.getDatabase().updateRun(this.currentRunId!, {
        total_files: files.length,
        total_engines: totalEngines,
      });
      // Batch insert all files in a single transaction — orders of magnitude faster
      this.stateManager.batchAddFiles(this.currentRunId!, files);
      // Re-emit run:started so the frontend gets updated totals. If the run
      // was already cancelled while this scan was in flight, getCurrentRun()
      // returns null — don't broadcast a fake "started" state in that case.
      const run = this.stateManager.getCurrentRun();
      if (run) {
        this.stateManager.emit('run:started', run);
      }
    });

    this.engine.on('file:started', ({ srtPath, videoPath }: { srtPath: string; videoPath: string | null }) => {
      if (this.currentRunId) {
        this.stateManager.updateFileStatus(this.currentRunId, srtPath, 'processing', null, videoPath);
      }
    });

    this.engine.on('file:engine_started', ({ srtPath, engine }: { srtPath: string; engine: string }) => {
      if (this.currentRunId) {
        this.stateManager.updateFileStatus(this.currentRunId, srtPath, 'processing', engine);
      }
    });

    this.engine.on(
      'file:engine_completed',
      ({
        srtPath,
        engine,
        result,
      }: {
        srtPath: string;
        engine: string;
        result: {
          success: boolean;
          duration: number;
          message: string;
          stdout?: string;
          stderr?: string;
          skipped?: boolean;
          offsetMs?: number;
          notFitting?: boolean;
          shiftTooLarge?: boolean;
          originalShiftMs?: number;
        };
      }) => {
        if (this.currentRunId) {
          // Increment counters BEFORE updateFileEngine — it's the one that
          // reads the run row and broadcasts it as `file:updated`. Doing it
          // in the old order meant every live push reflected the run's state
          // from just before this event's own increment, so the UI always
          // showed a stale/lagging count until the next event (or the final
          // run:completed snapshot) caught it up.
          this.stateManager.incrementCompletedEngines(this.currentRunId);
          this.stateManager.incrementEngineStat(this.currentRunId, engine, result.success);
          this.stateManager.updateFileEngine(this.currentRunId, srtPath, engine, result);
        }
      },
    );

    this.engine.on('file:completed', ({ srtPath }: { srtPath: string }) => {
      if (this.currentRunId) {
        this.stateManager.incrementRunCounter(this.currentRunId, 'completed');
        this.stateManager.updateFileStatus(this.currentRunId, srtPath, 'completed', null);
      }
    });

    this.engine.on('file:skipped', ({ srtPath }: { srtPath: string }) => {
      if (this.currentRunId) {
        this.stateManager.incrementRunCounter(this.currentRunId, 'skipped');
        this.stateManager.updateFileStatus(this.currentRunId, srtPath, 'skipped', null);
      }
    });

    this.engine.on('file:no_video', ({ srtPath }: { srtPath: string }) => {
      if (this.currentRunId) {
        this.stateManager.incrementRunCounter(this.currentRunId, 'failed');
        this.stateManager.updateFileStatus(this.currentRunId, srtPath, 'error', null);
      }
    });

    this.engine.on('file:failed', ({ srtPath }: { srtPath: string }) => {
      if (this.currentRunId) {
        this.stateManager.incrementRunCounter(this.currentRunId, 'failed');
        this.stateManager.updateFileStatus(this.currentRunId, srtPath, 'error', null);
      }
    });

    this.engine.on(
      'file:not_fitting',
      ({ srtPath }: { srtPath: string; engine: string; offsetMs: number }) => {
        if (this.currentRunId) {
          this.stateManager.incrementRunCounter(this.currentRunId, 'not_fitting');
          this.stateManager.updateFileStatus(this.currentRunId, srtPath, 'not_fitting', null);
        }
      },
    );
  }

  async startRun(config?: ScanConfig, options?: { dryRun?: boolean }): Promise<string> {
    if (this.processingPromise) {
      console.log(`[${new Date().toISOString()}] Cannot start run: Another run is already in progress`);
      throw new Error('A run is already in progress');
    }

    // Resolve effective dry-run: explicit request wins, else the saved
    // setting, else the DRY_RUN env var. This also makes the Settings toggle
    // actually take effect (the engine no longer reads env only at startup).
    let dryRun: boolean;
    if (options?.dryRun !== undefined) {
      dryRun = options.dryRun;
    } else {
      const dbVal = this.stateManager.getDatabase().getSetting('dry_run');
      dryRun = dbVal !== null ? dbVal === 'true' : (process.env.DRY_RUN || 'false') === 'true';
    }
    this.engine.setDryRun(dryRun);

    console.log(`[${new Date().toISOString()}] Starting new processing run${dryRun ? ' (DRY RUN — no changes will be written)' : ''}...`);
    this.engine.reset();
    this.stopRequested = false;

    // Create run record immediately so the UI has a run to track from the start
    const runId = this.stateManager.createPendingRun();
    this.currentRunId = runId;
    const run = this.stateManager.getCurrentRun()!;
    this.stateManager.emit('run:started', run);

    // Start scanning + processing in the background
    const processPromise = this.engine.processRun(config);

    this.processingPromise = processPromise
      .then(() => {
        if (this.stopRequested) {
          console.log(`[${new Date().toISOString()}] Stop was requested during scan. Cancelling run: ${runId}`);
          this.stopRun();
        }
      })
      .finally(() => {
        this.processingPromise = null;
        const r = this.stateManager.getCurrentRun();
        if (r && r.status === 'running') {
          console.log(
            `[${new Date().toISOString()}] Run completed - Total: ${r.total_files}, Completed: ${r.completed}, Skipped: ${r.skipped}, Failed: ${r.failed}`,
          );
          this.stateManager.completeRun(r.id);
        }
        this.currentRunId = null;
      });
    this.processingPromise.catch(() => {});

    console.log(`[${new Date().toISOString()}] Run created with ID: ${runId} (scanning...)`);
    return runId;
  }

  skipFile(filePath: string): void {
    const fileName = filePath.split('/').pop();
    console.log(`[${new Date().toISOString()}] Skip requested for: ${fileName}`);
    this.engine.skipFile(filePath);
  }

  stopRun(): void {
    console.log(`[${new Date().toISOString()}] Stop run requested`);

    // Covers files not yet known to the coordinator too — since a run row
    // now exists from the moment startRun() is called (before scanning even
    // begins), getCurrentRun() below is rarely null anymore, so this can't
    // rely solely on the "queue stop" branch to catch a stop during the scan
    // phase. Without this, files the scan discovers after Stop is clicked
    // would still be processed (and possibly deleted) normally.
    this.engine.requestStop();

    const run = this.stateManager.getCurrentRun();
    if (!run) {
      if (this.isRunning()) {
        console.log(`[${new Date().toISOString()}] No run active yet (still scanning). Queuing stop...`);
        this.stopRequested = true;
        return;
      }
      throw new Error('No run is currently in progress');
    }

    // Get all files already known and cancel them (aborts any in-flight engine process)
    const files = this.stateManager.getFileResults(run.id);
    const allFilePaths = files.map((f) => f.file_path);
    this.engine.stopAllProcessing(allFilePaths);

    // Mark run as cancelled
    this.stateManager.cancelRun(run.id);
  }

  getScanProgress(): { checked: number; total: number; needSync: number; alreadySynced: number } | null {
    return this.engine.scanProgress;
  }

  isRunning(): boolean {
    return this.processingPromise !== null;
  }

  isDryRun(): boolean {
    return this.engine.isDryRun();
  }
}