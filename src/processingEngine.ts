import EventEmitter from 'events';
import { ScanConfig, getScanConfig, getSyncRetryConfig, getDryRunConfig, getEngineChainConfig } from './config';
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
  private confidenceThreshold: number = 0.7;
  /** Scan progress during file discovery phase (null when not scanning) */
  public scanProgress: { checked: number; total: number; needSync: number; alreadySynced: number } | null = null;

  constructor() {
    super();
    this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_SYNC_TASKS || '1', 10);
    this.enabledEngines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
    this.maxLogBufferSize = parseInt(process.env.LOG_BUFFER_SIZE || '1000', 10);
    const dryRunConfig = getDryRunConfig();
    this.dryRun = dryRunConfig.enabled;
    this.confidenceThreshold = dryRunConfig.confidenceThreshold;
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
    const scanConfig = config || getScanConfig();
    this.log(`[${new Date().toISOString()}] Scanning for subtitle files...`);
    this.log(`[${new Date().toISOString()}] Scan paths: ${JSON.stringify(scanConfig.includePaths)}`);

    this.scanProgress = { checked: 0, total: 0, needSync: 0, alreadySynced: 0 };
    const db = this.stateManager?.getDatabase();
    const { files: srtFiles, directoryCache } = await findAllSrtFiles(scanConfig, db,
      (checked, total, needSync, alreadySynced) => {
        this.scanProgress = { checked, total, needSync, alreadySynced };
      }
    );
    this.scanProgress = null;
    this.directoryCache = directoryCache;
    this.log(`[${new Date().toISOString()}] Found ${srtFiles.length} subtitle files`);
    this.emit('run:files_found', srtFiles);

    // Process with concurrency pool — starts next file as soon as one finishes,
    // so a single hanging process doesn't block other slots
    this.log(`[${new Date().toISOString()}] Processing with concurrency: ${this.maxConcurrent}`);
    this.log(`[${new Date().toISOString()}] Enabled engines: ${this.enabledEngines.join(', ')}`);
    if (this.dryRun) {
      this.log(`[${new Date().toISOString()}] DRY RUN MODE — no files will be written`);
    }
    this.log(`[${new Date().toISOString()}] Confidence threshold: ${this.confidenceThreshold}`);

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

  private async runEngine(engine: string, srtPath: string, videoPath: string, signal?: AbortSignal): Promise<{
    success: boolean;
    message: string;
    stdout?: string;
    stderr?: string;
    skipped?: boolean;
    duration: number;
    shiftTooLarge?: boolean;
    originalShiftMs?: number;
  }> {
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
      this.emit('file:suspicious', { srtPath, validation });
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
    const maxShift = parseInt(process.env.MAX_SUBTITLE_SHIFT_MS || '30000', 10);
    const engineChain = [
      { name: engineConfig.defaultEngine, label: 'default' },
      { name: engineConfig.fallbackEngine, label: 'fallback' },
    ];

    this.log(`[${new Date().toISOString()}] Engine chain: ${engineConfig.defaultEngine} → ${engineConfig.fallbackEngine} (max retries: ${retryConfig.maxRetries})`);

    for (const { name: engine, label } of engineChain) {
      if (this.cancelledFiles.has(srtPath)) {
        this.log(`[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`);
        this.emit('file:skipped', { srtPath, reason: 'cancelled' });
        return;
      }

      // Check if engine should be skipped due to consecutive failures
      if (this.stateManager?.shouldSkipEngine(srtPath, engine)) {
        this.log(`[${new Date().toISOString()}] ⊘ Skipping ${engine} (3+ consecutive failures): ${fileName}`);
        this.emit('file:engine_completed', {
          srtPath, engine,
          result: { success: false, duration: 0, message: 'Skipped — 3+ consecutive failures', skipped: true },
        });
        continue;
      }

      this.log(`[${new Date().toISOString()}] [${label}] Starting ${engine} for: ${fileName}`);
      this.emit('file:engine_started', { srtPath, engine });

      // Save original file before engine overwrites it (for fallback restore)
      let originalBackup: string | null = null;
      try { originalBackup = readFileSync(srtPath, 'utf8'); } catch {}

      const result = await this.runEngine(engine, srtPath, videoPath, signal);

      if (signal.aborted) {
        this.log(`[${new Date().toISOString()}] Skipped (cancelled during ${engine}): ${fileName}`);
        this.emit('file:skipped', { srtPath, reason: 'cancelled' });
        return;
      }

      if (result.skipped) {
        this.log(`[${new Date().toISOString()}] ⊘ ${engine} skipped: ${fileName}`);
        this.emit('file:engine_completed', { srtPath, engine, result: { ...result } });
        continue;
      }

      this.log(`[${new Date().toISOString()}] [${label}] ${engine} completed (${(result.duration / 1000).toFixed(1)}s): ${fileName}`);
      if (!result.success) {
        this.log(`[${new Date().toISOString()}]   Error: ${result.message}`);
        if (result.stderr && result.stderr.length > 0) {
          this.log(`[${new Date().toISOString()}]   Stderr: ${result.stderr.substring(0, 500)}`);
        }
        this.emit('file:engine_completed', { srtPath, engine, result: { ...result } });
        // Restore original for fallback
        if (originalBackup && label === 'default') {
          try { writeFileSync(srtPath, originalBackup, 'utf8'); } catch {}
        }
        continue;
      }

      // shiftTooLarge — subtitle fundamentally doesn't match
      if (result.shiftTooLarge) {
        this.log(`[${new Date().toISOString()}] [${label}] ✗ Subtitle doesn't match video (shift too large): ${fileName}`);
        this.emit('file:engine_completed', { srtPath, engine, result: { ...result } });
        // If this is the fallback, delete the file
        if (label === 'fallback') {
          await this.deleteSubtitleFile(srtPath, fileName, engine, result.originalShiftMs ?? 0);
        } else {
          // Restore original for fallback attempt
          if (originalBackup) {
            try { writeFileSync(srtPath, originalBackup, 'utf8'); } catch {}
          }
        }
        continue;
      }

      // --- Retry loop with confidence check ---
      let currentInputContent = result.success ? readFileSync(srtPath, 'utf8') : null;
      let finalContent: string | null = null;
      let finalOffsetMs: number | null = null;

      for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        if (attempt > 0) {
          this.log(`[${new Date().toISOString()}] [${label}] Retry ${attempt}/${retryConfig.maxRetries} with ${engine}...`);
          // Create temp file with last synced content
          const tempSrtPath = this.createTempSrtFile(srtPath, currentInputContent!);
          if (!tempSrtPath) break;

          const retryResult = await this.runEngine(engine, tempSrtPath, videoPath, signal);
          this.cleanupTempFiles(tempSrtPath, engine);

          if (!retryResult.success) {
            this.log(`[${new Date().toISOString()}] [${label}] Retry failed: ${retryResult.message}`);
            this.emit('file:engine_completed', { srtPath, engine, result: { ...retryResult } });
            break;
          }

          // Read retry output
          const retryOutputPath = getOutputPath(tempSrtPath, engine);
          try { currentInputContent = readFileSync(retryOutputPath, 'utf8'); } catch { break; }
        }

        // Calculate confidence from offset (use original vs current)
        if (originalContent && currentInputContent) {
          const offsetMs = calculateSubtitleOffset(originalContent, currentInputContent);
          const confidence = maxShift > 0 ? Math.max(0, 1 - (Math.abs(offsetMs) / maxShift)) : 1;

          this.log(`[${new Date().toISOString()}] [${label}]   Offset: ${offsetMs}ms, Confidence: ${(confidence * 100).toFixed(1)}% (threshold: ${(this.confidenceThreshold * 100).toFixed(0)}%)`);

          if (confidence >= this.confidenceThreshold) {
            finalContent = currentInputContent;
            finalOffsetMs = offsetMs;
            this.log(`[${new Date().toISOString()}] [${label}] ✓ Confidence OK on attempt ${attempt + 1}`);
            break;
          }

          this.log(`[${new Date().toISOString()}] [${label}]   Confidence too low, ${attempt < retryConfig.maxRetries ? 'retrying...' : 'exhausted retries'}`);
        } else {
          // No original content — accept as-is
          finalContent = currentInputContent;
          break;
        }

        if (attempt >= retryConfig.maxRetries) {
          this.log(`[${new Date().toISOString()}] [${label}] ✗ Max retries exhausted`);
        }
      }

      if (finalContent && finalOffsetMs !== null) {
        // SUCCESS — write final content back to srtPath
        try { writeFileSync(srtPath, finalContent, 'utf8'); } catch {}

        if (this.subtitleFormat === 'overwrite') {
          if (this.dryRun) {
            this.log(`[${new Date().toISOString()}] [DRY RUN] Would sync (header-marked): ${fileName}`);
            this.emit('file:engine_completed', { srtPath, engine, result: { ...result, offsetMs: finalOffsetMs, dryRun: true } });
          } else {
            markSrtAsSynced(srtPath, engine, finalContent);
            if (this.stateManager) {
              try { this.stateManager.getDatabase().addFileToSyncCache(srtPath); } catch {}
            }
            this.log(`[${new Date().toISOString()}] Synced (header-marked): ${fileName}`);
            this.emit('file:engine_completed', { srtPath, engine, result: { ...result, offsetMs: finalOffsetMs } });
          }
        } else {
          this.emit('file:engine_completed', { srtPath, engine, result: { ...result, offsetMs: finalOffsetMs } });
        }

        this.log(`[${new Date().toISOString()}] ✓ Completed successfully (${engine}): ${fileName}`);
        this.emit('file:completed', { srtPath });
        return;
      }

      // This engine failed — restore original if default (for fallback to try fresh)
      if (label === 'default' && originalBackup) {
        try { writeFileSync(srtPath, originalBackup, 'utf8'); } catch {}
        this.log(`[${new Date().toISOString()}] [${label}] Restored original file for fallback attempt`);
      }
    }

    // Both engines failed — delete the subtitle
    this.log(`[${new Date().toISOString()}] ✗ All engines exhausted — deleting subtitle: ${fileName}`);
    await this.deleteSubtitleFile(srtPath, fileName, 'none', 0);
    this.emit('file:failed', { srtPath });
  }

  /** Delete a subtitle file that couldn't be synced by any engine. */
  private async deleteSubtitleFile(srtPath: string, fileName: string, lastEngine: string, offsetMs: number): Promise<void> {
    try {
      if (existsSync(srtPath)) {
        unlinkSync(srtPath);
        this.log(`[${new Date().toISOString()}] 🗑 Deleted unsyncable subtitle: ${fileName}`);
      }
    } catch {
      this.log(`[${new Date().toISOString()}] Failed to delete subtitle: ${fileName}`);
    }
    this.emit('file:engine_completed', {
      srtPath, engine: lastEngine,
      result: {
        success: false, duration: 0,
        message: `Deleted — no engine could sync (offset: ${offsetMs}ms)`,
        offsetMs, notFitting: true,
      },
    });
    this.emit('file:not_fitting', { srtPath, engine: lastEngine, offsetMs });
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

  reset(): void {
    this.cancelledFiles.clear();
    this.abortControllers.clear();
    this.clearLogs();
    this.directoryCache = null;
    clearDirectoryCache();
  }
}