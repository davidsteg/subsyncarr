import EventEmitter from 'events';
import { ScanConfig, getScanConfig } from './config';
import { findAllSrtFiles } from './findAllSrtFiles';
import { findMatchingVideoFile } from './findMatchingVideoFile';
import { generateFfsubsyncSubtitles } from './generateFfsubsyncSubtitles';
import { generateAlassSubtitles } from './generateAlassSubtitles';
import { generateAutosubsyncSubtitles } from './generateAutosubsyncSubtitles';
import { StateManager } from './stateManager';

export class ProcessingEngine extends EventEmitter {
  private cancelledFiles: Set<string> = new Set();
  private maxConcurrent: number;
  private enabledEngines: string[];
  private logBuffer: string[] = [];
  private maxLogBufferSize: number;
  public stateManager?: StateManager;

  constructor() {
    super();
    this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_SYNC_TASKS || '1', 10);
    this.enabledEngines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
    this.maxLogBufferSize = parseInt(process.env.LOG_BUFFER_SIZE || '1000', 10);
  }

  private log(message: string): void {
    console.log(message);

    // Ring buffer - remove oldest if at capacity
    if (this.logBuffer.length >= this.maxLogBufferSize) {
      this.logBuffer.shift(); // Remove oldest
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

    // Build DB-backed isAlreadySynced checker using the enabled engines
    const enabledEngines = this.enabledEngines;
    const isAlreadySynced = this.stateManager
      ? (filePath: string) => this.stateManager!.getDatabase().isFileAlreadySynced(filePath, enabledEngines)
      : undefined;

    const srtFiles = await findAllSrtFiles(scanConfig, isAlreadySynced);
    this.log(`[${new Date().toISOString()}] Found ${srtFiles.length} subtitle files`);

    this.emit('run:files_found', srtFiles);

    // Process with dynamic worker pool instead of fixed batches
    this.log(`[${new Date().toISOString()}] Processing with concurrency: ${this.maxConcurrent}`);
    this.log(`[${new Date().toISOString()}] Enabled engines: ${this.enabledEngines.join(', ')}`);

    const startTime = Date.now();
    let processedCount = 0;
    const totalFiles = srtFiles.length;
    const fileQueue = [...srtFiles]; // copy so shift() doesn't mutate the original

    const processNext = async (): Promise<void> => {
      while (fileQueue.length > 0) {
        const srtPath = fileQueue.shift()!;
        if (this.cancelledFiles.has(srtPath)) continue;
        await this.processFile(srtPath);
        processedCount++;

        // Yield to event loop every 5 files to prevent Express starvation
        if (processedCount % 5 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        // Progress log every 100 files
        if (processedCount % 100 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
          const rate = processedCount / Math.max(1, (Date.now() - startTime) / 1000);
          const remaining =
            rate > 0
              ? ((totalFiles - processedCount) / rate / 60).toFixed(1)
              : '?';
          this.log(
            `[${new Date().toISOString()}] Progress: ${processedCount}/${totalFiles} files (${elapsed}min elapsed, ~${remaining}min remaining, ${rate.toFixed(2)}/s)`,
          );
        }
      }
    };

    // Spawn N workers that pull from the queue — dynamic, not batched
    const workers = Array.from({ length: this.maxConcurrent }, () => processNext());
    await Promise.all(workers);

    const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    this.log(
      `[${new Date().toISOString()}] All files processed: ${processedCount}/${totalFiles} files in ${totalElapsed}min`,
    );
  }

  private async processFile(srtPath: string): Promise<void> {
    const fileName = srtPath.split('/').pop();
    this.log(`[${new Date().toISOString()}] Processing: ${fileName}`);

    // Check if cancelled
    if (this.cancelledFiles.has(srtPath)) {
      this.log(`[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'cancelled' });
      return;
    }

    const videoPath = findMatchingVideoFile(srtPath);

    this.emit('file:started', { srtPath, videoPath });

    if (!videoPath) {
      this.log(`[${new Date().toISOString()}] No matching video found for: ${fileName}`);
      this.emit('file:no_video', { srtPath });
      return;
    }

    this.log(`[${new Date().toISOString()}] Found video: ${videoPath.split('/').pop()}`);

    // Process with each enabled engine
    let anyEngineSucceeded = false;
    let allEnginesSkipped = true;
    for (const engine of this.enabledEngines) {
      // Check cancellation before each engine
      if (this.cancelledFiles.has(srtPath)) {
        this.log(`[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`);
        this.emit('file:skipped', { srtPath, reason: 'cancelled' });
        return;
      }

      // Check if engine should be skipped due to consecutive failures
      if (this.stateManager?.shouldSkipEngine(srtPath, engine)) {
        this.log(`[${new Date().toISOString()}] ⊘ Skipping ${engine} (3+ consecutive failures): ${fileName}`);
        this.emit('file:engine_completed', {
          srtPath,
          engine,
          result: {
            success: false,
            duration: 0,
            message: 'Skipped due to 3+ consecutive failures',
            skipped: true,
          },
        });
        continue; // Skip to next engine (allEnginesSkipped remains true)
      }

      this.log(`[${new Date().toISOString()}] Starting ${engine} for: ${fileName}`);
      this.emit('file:engine_started', { srtPath, engine });

      const startTime = Date.now();
      let result;

      try {
        switch (engine) {
          case 'ffsubsync':
            result = await generateFfsubsyncSubtitles(srtPath, videoPath);
            break;
          case 'autosubsync':
            result = await generateAutosubsyncSubtitles(srtPath, videoPath);
            break;
          case 'alass':
            result = await generateAlassSubtitles(srtPath, videoPath);
            break;
          default:
            continue;
        }

        const duration = Date.now() - startTime;

        // If this engine was skipped (already processed), log and continue
        if (result.skipped) {
          this.log(`[${new Date().toISOString()}] ⊘ ${engine} skipped (already processed): ${fileName}`);
          this.emit('file:engine_completed', {
            srtPath,
            engine,
            result: { ...result, duration },
          });
          continue; // allEnginesSkipped stays true
        }

        // An engine actually ran (not skipped), so not all are skipped
        allEnginesSkipped = false;

        const status = result.success ? '✓' : '✗';
        this.log(
          `[${new Date().toISOString()}] ${status} ${engine} completed (${(duration / 1000).toFixed(1)}s): ${fileName}`,
        );
        if (!result.success) {
          this.log(`[${new Date().toISOString()}]   Error: ${result.message}`);
          // Log stderr if available for debugging
          if (result.stderr) {
            this.log(`[${new Date().toISOString()}]   Stderr: ${result.stderr.substring(0, 500)}`);
          }
        }

        if (result.success) {
          anyEngineSucceeded = true;
          this.emit('file:engine_completed', {
            srtPath,
            engine,
            result: { ...result, duration },
          });
          // Early exit: engine succeeded, skip remaining fallback engines
          break;
        }

        this.emit('file:engine_completed', {
          srtPath,
          engine,
          result: { ...result, duration },
        });
      } catch (error) {
        // Engine attempted to run (not skipped), so not all are skipped
        allEnginesSkipped = false;

        const duration = Date.now() - startTime;
        this.log(`[${new Date().toISOString()}] ✗ ${engine} failed (${(duration / 1000).toFixed(1)}s): ${fileName}`);
        this.log(`[${new Date().toISOString()}]   Error: ${error instanceof Error ? error.message : String(error)}`);

        this.emit('file:engine_completed', {
          srtPath,
          engine,
          result: {
            success: false,
            message: error instanceof Error ? error.message : String(error),
            duration,
          },
        });
      }
    }

    if (anyEngineSucceeded) {
      this.log(`[${new Date().toISOString()}] ✓ Completed successfully for: ${fileName}`);
      this.emit('file:completed', { srtPath });
    } else if (allEnginesSkipped) {
      this.log(`[${new Date().toISOString()}] ⊘ All engines skipped for: ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'all_engines_skipped' });
    } else {
      this.log(`[${new Date().toISOString()}] ✗ All engines failed for: ${fileName}`);
      this.emit('file:failed', { srtPath });
    }
  }

  skipFile(filePath: string): void {
    this.cancelledFiles.add(filePath);
    this.emit('file:skip_requested', { filePath });
  }

  stopAllProcessing(allFiles: string[]): void {
    this.log(`[${new Date().toISOString()}] Stop requested - cancelling all remaining files`);
    allFiles.forEach((file) => this.cancelledFiles.add(file));
  }

  reset(): void {
    this.cancelledFiles.clear();
    this.clearLogs();
  }
}
