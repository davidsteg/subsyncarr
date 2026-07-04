import EventEmitter from 'events';
import { ScanConfig, getScanConfig, getSyncRetryConfig, getDryRunConfig, getEngineChainConfig, getEngineAgreementThresholdMs, getNotFittingDeleteThreshold } from './config';
import { findAllSrtFiles } from './findAllSrtFiles';
import { findMatchingVideoFile, DirectoryCache, clearDirectoryCache } from './findMatchingVideoFile';
import { generateFfsubsyncSubtitles } from './generateFfsubsyncSubtitles';
import { generateAutosubsyncSubtitles } from './generateAutosubsyncSubtitles';
import { generateAlassSubtitles } from './generateAlassSubtitles';
import { StateManager } from './stateManager';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { getSubtitleFormat, getOutputPath, markSrtAsSynced, isSyncedSrt } from './helpers';
import { calculateSubtitleOffset } from './subtitleOffsetCalculator';
import { validateSubtitleMatch } from './subtitleValidator';
import { basename, dirname, join } from 'path';

interface EngineRunResult {
  success: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
  skipped?: boolean;
  duration: number;
  shiftTooLarge?: boolean;
  originalShiftMs?: number;
  offsetMs?: number;
}

export class ProcessingEngine extends EventEmitter {
  private cancelledFiles: Set<string> = new Set();
  private abortControllers: Map<string, AbortController> = new Map();
  private maxConcurrent: number;
  private enabledEngines: string[];
  private logBuffer: string[] = [];
  private maxLogBufferSize: number;
  private directoryCache: DirectoryCache | null = null;
  public stateManager?: StateManager;
  private dryRun: boolean = false;
  /**
   * Set when Stop is requested. Unlike `cancelledFiles` (which only covers
   * files already known to the coordinator), this also covers files
   * discovered *after* Stop was clicked — e.g. ones the scan phase finds
   * after the user has already asked to stop. Checked at the top of
   * processFile so nothing gets written or deleted once a stop is pending.
   */
  private stopRequested: boolean = false; // v1.3.19: reset in reset()
  /** Scan progress during file discovery phase (null when not scanning) */
  public scanProgress: { checked: number; total: number; needSync: number; alreadySynced: number } | null = null;

  constructor() {
    super();
    this.maxConcurrent = this.resolveMaxConcurrent();
    this.enabledEngines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
    this.maxLogBufferSize = parseInt(process.env.LOG_BUFFER_SIZE || '1000', 10);
    const dryRunConfig = getDryRunConfig();
    this.dryRun = dryRunConfig.enabled;
  }

  /** Reads MAX_CONCURRENT_SYNC_TASKS, overridden by the runtime/DB setting if present. */
  private resolveMaxConcurrent(): number {
    let value = parseInt(process.env.MAX_CONCURRENT_SYNC_TASKS || '1', 10);
    try {
      const { getRuntimeCfg } = require('./engineRuntime');
      const cfg = getRuntimeCfg();
      if (cfg.maxConcurrentTasks > 0) value = cfg.maxConcurrentTasks;
    } catch {}
    return value;
  }

  private get subtitleFormat(): string {
    return getSubtitleFormat();
  }

  private log(message: string): void {
    console.log(message);

    // Ring buffer - remove oldest if at capacity
    if (this.logBuffer.length >= this.maxLogBufferSize) {
      this.logBuffer.shift();
    }

    this.logBuffer.push(message);
    this.emit('log', message);
  }

  getLogs(): string[] {
    return [...this.logBuffer];
  }

  clearLogs(): void {
    this.logBuffer = [];
  }

  async processRun(config?: ScanConfig): Promise<void> {
    // Refresh from runtime config each run — a Settings change now takes
    // effect on the next run instead of requiring a server restart.
    this.maxConcurrent = this.resolveMaxConcurrent();

    const scanConfig = config || getScanConfig();
    this.log(`[${new Date().toISOString()}] Scanning for subtitle files...`);
    this.log(`[${new Date().toISOString()}] Scan paths: ${JSON.stringify(scanConfig.includePaths)}`);

    this.scanProgress = { checked: 0, total: 0, needSync: 0, alreadySynced: 0 };
    const db = this.stateManager?.getDatabase();
    const { files: srtFiles, directoryCache, orphanedTempFilesRemoved } = await findAllSrtFiles(scanConfig, db,
      (checked, total, needSync, alreadySynced) => {
        this.scanProgress = { checked, total, needSync, alreadySynced };
      },
      this.dryRun,
    );
    this.scanProgress = null;
    this.directoryCache = directoryCache;
    if (orphanedTempFilesRemoved > 0) {
      this.log(`[${new Date().toISOString()}] 🧹 Removed ${orphanedTempFilesRemoved} orphaned temp/retry file(s) left over from an interrupted run`);
    }
    this.log(`[${new Date().toISOString()}] Found ${srtFiles.length} subtitle files`);
    this.emit('run:files_found', srtFiles);

    // Process with concurrency pool — starts next file as soon as one finishes,
    // so a single hanging process doesn't block other slots
    this.log(`[${new Date().toISOString()}] Processing with concurrency: ${this.maxConcurrent}`);
    this.log(`[${new Date().toISOString()}] Enabled engines: ${this.enabledEngines.join(', ')}`);
    if (this.dryRun) {
      this.log(`[${new Date().toISOString()}] DRY RUN MODE — no files will be written`);
    }

    const retryConfig = getSyncRetryConfig();
    this.log(
      `[${new Date().toISOString()}] Sync retry: threshold=${retryConfig.thresholdMs}ms, maxRetries=${retryConfig.maxRetries}`,
    );

    await this.processWithConcurrency(srtFiles);

    // Clean up directory cache after processing
    this.directoryCache = null;
    clearDirectoryCache();

    this.log(`[${new Date().toISOString()}] All files processed`);
  }

  /**
   * Process files with a concurrency pool. Unlike batch processing (Promise.all per batch),
   * this starts the next file as soon as one slot frees up, so a single hanging process
   * only blocks its own slot — not the entire batch.
   */
  private async processWithConcurrency(files: string[]): Promise<void> {
    let nextIndex = 0;
    let completedCount = 0;
    const total = files.length;

    const processNext = async (): Promise<void> => {
      while (nextIndex < files.length) {
        const fileIndex = nextIndex++;
        const file = files[fileIndex];
        completedCount++;
        this.log(
          `[${new Date().toISOString()}] Starting file ${completedCount}/${total}: ${file.split('/').pop()!}`,
        );
        await this.processFile(file);
      }
    };

    // Start up to maxConcurrent workers
    const workers = [];
    for (let i = 0; i < Math.min(this.maxConcurrent, files.length); i++) {
      workers.push(processNext());
    }

    await Promise.all(workers);
  }

  private async runEngine(engine: string, srtPath: string, videoPath: string, signal?: AbortSignal): Promise<EngineRunResult> {
    const startTime = Date.now();
    try {
      let result;
      switch (engine) {
        case 'ffsubsync':
          result = await generateFfsubsyncSubtitles(srtPath, videoPath, signal);
          break;
        case 'autosubsync':
          result = await generateAutosubsyncSubtitles(srtPath, videoPath, signal);
          break;
        case 'alass':
          result = await generateAlassSubtitles(srtPath, videoPath, signal);
          break;
        default:
          return { success: false, message: `Unknown engine: ${engine}`, duration: 0 };
      }
      const duration = Date.now() - startTime;
      return { ...result, duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        duration,
      };
    }
  }

  /**
   * Create a temporary SRT file for retry attempts.
   * Returns the path to the temp file, or null on failure.
   */
  private createTempSrtFile(srtPath: string, content: string): string | null {
    const directory = dirname(srtPath);
    const srtBaseName = basename(srtPath, '.srt');
    const tempPath = join(directory, `${srtBaseName}.subsyncarr_retry.srt`);
    try {
      writeFileSync(tempPath, content, 'utf8');
      return tempPath;
    } catch (error) {
      this.log(`[${new Date().toISOString()}] Failed to create temp file: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Clean up temporary retry files.
   */
  private cleanupTempFiles(tempSrtPath: string | null, engine: string): void {
    if (tempSrtPath && existsSync(tempSrtPath)) {
      try {
        unlinkSync(tempSrtPath);
      } catch {
        // Ignore cleanup errors
      }
    }
    // Also clean up the engine output for the temp file
    if (tempSrtPath) {
      const tempOutputPath = getOutputPath(tempSrtPath, engine);
      if (existsSync(tempOutputPath)) {
        try {
          unlinkSync(tempOutputPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  private async processFile(srtPath: string): Promise<void> {
    const fileName = srtPath.split('/').pop()!;

    // Run was stopped (possibly mid-scan) — skip without touching the file at all
    if (this.stopRequested) {
      this.log(`[${new Date().toISOString()}] Skipped (run stopped): ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'cancelled' });
      return;
    }

    // Skip already-synced files (overwrite mode)
    if (this.subtitleFormat === 'overwrite' && (await isSyncedSrt(srtPath))) {
      this.log(`[${new Date().toISOString()}] ⊘ Already synced (header): ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'already_synced' });
      return;
    }

    // Check if cancelled
    if (this.cancelledFiles.has(srtPath)) {
      this.log(`[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'cancelled' });
      return;
    }

    // Create an AbortController for this file so skip can kill running processes
    const abortController = new AbortController();
    this.abortControllers.set(srtPath, abortController);

    try {
      await this.processFileInner(srtPath, fileName, abortController.signal);
    } finally {
      this.abortControllers.delete(srtPath);
    }
  }

  private async processFileInner(srtPath: string, fileName: string, signal: AbortSignal): Promise<void> {
    const videoPath = findMatchingVideoFile(srtPath, this.directoryCache);

    this.emit('file:started', { srtPath, videoPath });

    // Validate subtitle match before processing
    const validation = validateSubtitleMatch(srtPath, videoPath);
    if (validation.isSuspicious) {
      this.log(`[${new Date().toISOString()}] Suspicious subtitle detected (${(validation.probability * 100).toFixed(0)}%): ${fileName}`);
      validation.reasons.forEach(r => this.log(`[${new Date().toISOString()}]   Reason: ${r}`));
    }

    if (!videoPath) {
      this.log(`[${new Date().toISOString()}] No matching video found for: ${fileName}`);
      this.emit('file:no_video', { srtPath });
      return;
    }

    this.log(`[${new Date().toISOString()}] Found video: ${videoPath.split('/').pop()}`);

    // Read original subtitle content for offset calculation
    let originalContent: string | null = null;
    try {
      originalContent = readFileSync(srtPath, 'utf8');
    } catch {
      this.log(`[${new Date().toISOString()}] Warning: Could not read original subtitle for offset calculation`);
    }

    const engineConfig = getEngineChainConfig();
    const retryConfig = getSyncRetryConfig();
    const agreementThresholdMs = getEngineAgreementThresholdMs();

    // Both engines run independently on the ORIGINAL subtitle. We then compare
    // the two aligned outputs: if they land on the same alignment (within the
    // agreement threshold) the subtitle fits the video and we keep it; if they
    // disagree — or neither can produce output — the subtitle doesn't fit and
    // is deleted. Deletion therefore requires BOTH engines to fail to agree.
    const engineChain = [engineConfig.defaultEngine, engineConfig.fallbackEngine];
    this.log(
      `[${new Date().toISOString()}] Engine chain: ${engineChain.join(' + ')} ` +
        `(agreement threshold: ${agreementThresholdMs}ms, max retries: ${retryConfig.maxRetries})`,
    );

    const alignments: { engine: string; content: string; shiftMs: number }[] = [];

    for (const engine of engineChain) {
      if (this.cancelledFiles.has(srtPath) || signal.aborted) {
        this.log(`[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`);
        this.emit('file:skipped', { srtPath, reason: 'cancelled' });
        return;
      }

      // Skip engines that have failed on this file 3+ times in a row
      if (this.stateManager?.shouldSkipEngine(srtPath, engine)) {
        this.log(`[${new Date().toISOString()}] ⊘ Skipping ${engine} (3+ consecutive failures): ${fileName}`);
        this.emit('file:engine_completed', {
          srtPath, engine,
          result: { success: false, duration: 0, message: 'Skipped — 3+ consecutive failures', skipped: true },
        });
        continue;
      }

      // Always align from the pristine original so the two engines are comparable.
      if (originalContent !== null) {
        try { writeFileSync(srtPath, originalContent, 'utf8'); } catch {}
      }

      this.log(`[${new Date().toISOString()}] Starting ${engine} for: ${fileName}`);
      this.emit('file:engine_started', { srtPath, engine });

      const aligned = await this.alignWithEngine(engine, srtPath, videoPath, originalContent, retryConfig, signal);

      if (aligned.cancelled) {
        this.log(`[${new Date().toISOString()}] Skipped (cancelled during ${engine}): ${fileName}`);
        this.emit('file:skipped', { srtPath, reason: 'cancelled' });
        return;
      }

      this.emit('file:engine_completed', { srtPath, engine, result: aligned.result });

      if (aligned.success && aligned.content !== null) {
        this.log(`[${new Date().toISOString()}] ${engine} aligned (shift ${aligned.shiftMs}ms): ${fileName}`);
        alignments.push({ engine, content: aligned.content, shiftMs: aligned.shiftMs });
      } else {
        this.log(`[${new Date().toISOString()}] ${engine} could not align: ${aligned.result.message}`);
      }
    }

    // --- Keep vs. delete decision ---
    if (alignments.length === 0) {
      // Neither engine produced a usable alignment → subtitle doesn't fit (this run).
      this.log(`[${new Date().toISOString()}] ✗ No engine could sync: ${fileName}`);
      await this.handleNotFitting(srtPath, fileName, 'none', 0, originalContent);
      return;
    }

    if (alignments.length === 1) {
      // Only one engine produced output; the other errored or judged it unfit.
      // Deleting requires BOTH engines to agree it doesn't fit, so keep this one.
      const only = alignments[0];
      this.log(
        `[${new Date().toISOString()}] Only ${only.engine} produced output — keeping (no second engine to corroborate a delete): ${fileName}`,
      );
      this.commitSync(srtPath, fileName, only.engine, only.content, only.shiftMs, originalContent);
      return;
    }

    // Both engines produced output — compare how far apart their alignments are.
    const [first, second] = alignments;
    const disagreementMs = Math.abs(calculateSubtitleOffset(first.content, second.content));
    this.log(
      `[${new Date().toISOString()}] ${first.engine} vs ${second.engine} disagree by ${disagreementMs}ms ` +
        `(threshold: ${agreementThresholdMs}ms): ${fileName}`,
    );

    if (disagreementMs <= agreementThresholdMs) {
      // Engines agree → the subtitle fits. Keep the default engine's alignment.
      this.log(`[${new Date().toISOString()}] ✓ Engines agree — subtitle fits: ${fileName}`);
      this.commitSync(srtPath, fileName, first.engine, first.content, first.shiftMs, originalContent);
    } else {
      // Engines disagree → the subtitle doesn't fit this video (this run).
      this.log(`[${new Date().toISOString()}] ✗ Engines disagree — subtitle doesn't fit: ${fileName}`);
      await this.handleNotFitting(srtPath, fileName, `${first.engine}/${second.engine}`, disagreementMs, originalContent);
    }
  }

  /**
   * Run one engine on the given subtitle and return its aligned output.
   * Retries feed the engine its own previous output until the alignment stops
   * moving (converges within the retry threshold) or maxRetries is reached.
   */
  private async alignWithEngine(
    engine: string,
    srtPath: string,
    videoPath: string,
    originalContent: string | null,
    retryConfig: { thresholdMs: number; maxRetries: number },
    signal: AbortSignal,
  ): Promise<{ success: boolean; content: string | null; shiftMs: number; cancelled: boolean; result: EngineRunResult }> {
    const result = await this.runEngine(engine, srtPath, videoPath, signal);

    if (signal.aborted) {
      return { success: false, content: null, shiftMs: 0, cancelled: true, result };
    }
    if (result.skipped || !result.success) {
      // Includes shiftTooLarge — this engine judges the subtitle unfit.
      return { success: false, content: null, shiftMs: 0, cancelled: false, result };
    }

    let content = this.readEngineOutput(engine, srtPath);
    if (content === null) {
      return {
        success: false, content: null, shiftMs: 0, cancelled: false,
        result: { ...result, success: false, message: 'Engine reported success but produced no output' },
      };
    }

    // Re-run the engine on its own output until the alignment stabilizes.
    for (let attempt = 1; attempt <= retryConfig.maxRetries; attempt++) {
      if (this.cancelledFiles.has(srtPath) || signal.aborted) break;

      const tempPath = this.createTempSrtFile(srtPath, content);
      if (!tempPath) break;

      const retry = await this.runEngine(engine, tempPath, videoPath, signal);
      const retryContent = retry.success ? this.readEngineOutput(engine, tempPath) : null;
      this.cleanupTempFiles(tempPath, engine);

      if (!retryContent) break;

      const delta = Math.abs(calculateSubtitleOffset(content, retryContent));
      content = retryContent;
      this.log(`[${new Date().toISOString()}] [retry ${attempt}/${retryConfig.maxRetries}] ${engine} moved a further ${delta}ms`);
      if (delta <= retryConfig.thresholdMs) break; // converged
    }

    const shiftMs = originalContent ? calculateSubtitleOffset(originalContent, content) : 0;
    return { success: true, content, shiftMs, cancelled: false, result: { ...result, offsetMs: shiftMs } };
  }

  /** Read an engine's synced output. alass/ffsubsync overwrite in place; others write a sidecar. */
  private readEngineOutput(engine: string, inputPath: string): string | null {
    const inPlace = engine === 'alass' || engine === 'ffsubsync';
    const outputPath = inPlace ? inputPath : getOutputPath(inputPath, engine);
    try {
      const content = readFileSync(outputPath, 'utf8');
      if (!inPlace) {
        try { unlinkSync(outputPath); } catch { /* ignore */ }
      }
      return content;
    } catch {
      return null;
    }
  }

  /** Persist a successful sync and emit completion. Honors dry-run and overwrite/standard modes. */
  private commitSync(
    srtPath: string,
    fileName: string,
    engine: string,
    content: string,
    shiftMs: number,
    originalContent: string | null,
  ): void {
    if (this.dryRun) {
      // Engines already overwrote srtPath in place; undo that so dry-run leaves files untouched.
      if (originalContent !== null) {
        try { writeFileSync(srtPath, originalContent, 'utf8'); } catch {}
      }
      this.log(`[${new Date().toISOString()}] [DRY RUN] Would sync (${engine}, shift ${shiftMs}ms): ${fileName}`);
      this.emit('file:completed', { srtPath });
      return;
    }

    try {
      if (this.subtitleFormat === 'overwrite') {
        markSrtAsSynced(srtPath, engine, content);
        if (this.stateManager) {
          try { this.stateManager.getDatabase().addFileToSyncCache(srtPath); } catch {}
        }
      } else {
        writeFileSync(srtPath, content, 'utf8');
      }
      this.log(`[${new Date().toISOString()}] ✓ Synced (${engine}, shift ${shiftMs}ms): ${fileName}`);
      // Break any not-fitting streak — the file synced fine this run.
      if (this.stateManager) {
        try { this.stateManager.getDatabase().resetNotFittingStrikes(srtPath); } catch {}
      }
    } catch {
      this.log(`[${new Date().toISOString()}] Failed to write synced subtitle: ${fileName}`);
    }
    this.emit('file:completed', { srtPath });
  }

  /**
   * Handle a subtitle that didn't fit this run (both engines disagree, or
   * neither could align it). Doesn't delete immediately — tracks consecutive
   * not-fitting strikes per file across runs, only deleting once the
   * configurable threshold is reached, so a one-off transient failure (a
   * half-downloaded video, a network hiccup, an engine crash) doesn't delete
   * a subtitle that might sync fine on a later run.
   */
  private async handleNotFitting(
    srtPath: string,
    fileName: string,
    lastEngine: string,
    offsetMs: number,
    originalContent: string | null,
  ): Promise<void> {
    const threshold = getNotFittingDeleteThreshold();

    if (this.dryRun) {
      // Restore the original the engines overwrote; dry-run touches nothing, including strike counts.
      if (originalContent !== null) {
        try { writeFileSync(srtPath, originalContent, 'utf8'); } catch {}
      }
      this.log(`[${new Date().toISOString()}] [DRY RUN] Would record not-fitting strike (threshold: ${threshold}): ${fileName}`);
      this.emit('file:not_fitting', { srtPath, engine: lastEngine, offsetMs });
      return;
    }

    const strikes = this.stateManager?.getDatabase().recordNotFittingStrike(srtPath) ?? 1;

    if (strikes >= threshold) {
      try {
        if (existsSync(srtPath)) {
          unlinkSync(srtPath);
          this.log(`[${new Date().toISOString()}] 🗑 Deleted after ${strikes} consecutive not-fitting run(s): ${fileName}`);
        }
      } catch {
        this.log(`[${new Date().toISOString()}] Failed to delete subtitle: ${fileName}`);
      }
      if (this.stateManager) {
        try { this.stateManager.getDatabase().resetNotFittingStrikes(srtPath); } catch {}
      }
    } else {
      // Not enough strikes yet — restore the original and retry on the next run.
      if (originalContent !== null) {
        try { writeFileSync(srtPath, originalContent, 'utf8'); } catch {}
      }
      this.log(`[${new Date().toISOString()}] ⚠ Not fitting (strike ${strikes}/${threshold}) — keeping subtitle, will retry next run: ${fileName}`);
    }

    this.emit('file:not_fitting', { srtPath, engine: lastEngine, offsetMs });
  }

  /** Enable/disable dry-run for the next run (no files written or deleted). */
  setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  skipFile(filePath: string): void {
    this.cancelledFiles.add(filePath);
    // Kill any running process for this file immediately
    const controller = this.abortControllers.get(filePath);
    if (controller) {
      this.log(`[${new Date().toISOString()}] Aborting running process for: ${filePath.split('/').pop()!}`);
      controller.abort();
    }
    this.emit('file:skip_requested', { filePath });
  }

  stopAllProcessing(allFiles: string[]): void {
    this.log(`[${new Date().toISOString()}] Stop requested - cancelling all remaining files`);
    allFiles.forEach((file) => {
      this.cancelledFiles.add(file);
      const controller = this.abortControllers.get(file);
      if (controller) {
        controller.abort();
      }
    });
  }

  /**
   * Request a full stop, covering files not yet known to the coordinator too
   * (e.g. still being discovered by the directory scan). `stopAllProcessing`
   * only cancels files already in the DB/queue at the moment Stop is
   * clicked — without this, a stop during a long scan would leave every
   * file the scan finds afterward to be processed (and possibly deleted)
   * normally, with the UI showing the run as cancelled the whole time.
   */
  requestStop(): void {
    this.stopRequested = true;
    this.log(`[${new Date().toISOString()}] Stop requested — remaining and newly discovered files will be skipped`);
  }

  reset(): void {
    this.cancelledFiles.clear();
    this.abortControllers.clear();
    this.stopRequested = false;
    this.clearLogs();
    this.directoryCache = null;
    clearDirectoryCache();
  }
}