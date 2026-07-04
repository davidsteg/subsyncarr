import { readdirSync, unlinkSync } from 'fs';
import { extname, join } from 'path';
import { existsSync } from 'fs';
import { ScanConfig } from './config';
import { getOutputPath, getSubtitleFormat, isSyncedSrt } from './helpers';
import { DirectoryCache, initDirectoryCache } from './findMatchingVideoFile';
import { SubsyncarrPlusDatabase } from './database';

const ALL_KNOWN_ENGINES = ['ffsubsync', 'autosubsync', 'alass'];

// Internal temp/retry files the engines create mid-processing. These end in
// .srt (so the engines can operate on them) and should always be cleaned up
// (cleanupTempFiles / rename-back-to-original) before a run finishes — but a
// killed or restarted process can leave them orphaned on disk. A scan can
// safely delete any of these it finds: only one run/scan happens at a time,
// and the scan phase always runs before the current run creates any temp
// files of its own, so anything matching these patterns must be leftover
// from an earlier, interrupted run.
const TEMP_FILE_PATTERNS = ['.alass-tmp.', '.ffsubsync-tmp.', '.subsyncarr_retry.'];

function isFinishedEngineOutput(filename: string): boolean {
  return ALL_KNOWN_ENGINES.some((engine) => filename.includes(`.${engine}.`));
}

function isOrphanedTempFile(filename: string): boolean {
  return TEMP_FILE_PATTERNS.some((pattern) => filename.includes(pattern));
}

/** Concurrency limit for async file checks — pipelines I/O on network storage */
const CHECK_CONCURRENCY = 20;

export async function findAllSrtFiles(
  config: ScanConfig,
  db?: SubsyncarrPlusDatabase,
  onProgress?: (checked: number, total: number, needSync: number, alreadySynced: number) => void,
  dryRun?: boolean,
): Promise<{ files: string[]; directoryCache: DirectoryCache; orphanedTempFilesRemoved: number }> {
  const engines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
  const format = getSubtitleFormat();

  // Initialize directory cache for video file matching (built lazily during processing)
  const directoryCache = initDirectoryCache();

  // Phase 1: Walk directory tree synchronously (fast — just readdir calls, ~5 seconds for 197K files)
  const srtPaths: string[] = [];
  let orphanedTempFilesRemoved = 0;

  function collectSrtPaths(directory: string): void {
    if (config.excludePaths.some((excludePath) => directory.startsWith(excludePath))) {
      return;
    }

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        collectSrtPaths(fullPath);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.srt') {
        continue;
      }

      if (isOrphanedTempFile(entry.name)) {
        if (dryRun) {
          console.log(`${new Date().toLocaleString()} [DRY RUN] Would delete orphaned temp file: ${fullPath}`);
        } else {
          try {
            unlinkSync(fullPath);
            orphanedTempFilesRemoved++;
            console.log(`${new Date().toLocaleString()} Deleted orphaned temp file: ${fullPath}`);
          } catch (err) {
            console.log(`${new Date().toLocaleString()} Failed to delete orphaned temp file ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        continue;
      }

      if (isFinishedEngineOutput(entry.name)) {
        continue;
      }

      srtPaths.push(fullPath);
    }
  }

  for (const includePath of config.includePaths) {
    collectSrtPaths(includePath);
  }

  console.log(
    `${new Date().toLocaleString()} Found ${srtPaths.length} SRT files in directory walk, checking sync status...`,
  );

  // Phase 2: Check sync status with controlled concurrency
  // Uses async I/O to pipeline requests on network storage (50 concurrent reads)
  const files: string[] = [];
  let skippedCount = 0;
  let completedCount = 0;

  async function checkFile(srtPath: string): Promise<void> {
    let isSynced: boolean;

    if (format === 'overwrite') {
      // Check DB cache first — instant, no I/O
      if (db && db.isFileInSyncCache(srtPath)) {
        isSynced = true;
      } else {
        // Async header check — pipelines I/O on network storage
        isSynced = await isSyncedSrt(srtPath);
        // Cache result to avoid future header reads
        if (isSynced && db) {
          db.addFileToSyncCache(srtPath);
        }
      }
    } else {
      // Standard mode: check if engine output files exist
      isSynced = engines.every((engine) => {
        const outputPath = getOutputPath(srtPath, engine);
        return existsSync(outputPath);
      });
    }

    completedCount++;
    if (isSynced) {
      skippedCount++;
    } else {
      files.push(srtPath);
    }

    // Report progress via callback (every 1K for UI) + console log (every 10K)
    if (onProgress && completedCount % 1000 === 0) {
      onProgress(completedCount, srtPaths.length, files.length, skippedCount);
    }
    if (completedCount % 10000 === 0) {
      console.log(
        `${new Date().toLocaleString()} Scan progress: ${completedCount}/${srtPaths.length} checked, ${files.length} need sync, ${skippedCount} already synced`,
      );
    }
  }

  // Process files in batches with controlled concurrency
  let nextIndex = 0;

  async function processBatch(): Promise<void> {
    while (nextIndex < srtPaths.length) {
      const file = srtPaths[nextIndex++];
      await checkFile(file);
    }
  }

  // Start CHECK_CONCURRENCY workers
  const workerCount = Math.min(CHECK_CONCURRENCY, srtPaths.length);
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(processBatch());
  }

  await Promise.all(workers);

  console.log(
    `${new Date().toLocaleString()} Scan complete: ${srtPaths.length} SRT files found, ${files.length} need sync, ${skippedCount} already synced` +
      (orphanedTempFilesRemoved > 0 ? `, ${orphanedTempFilesRemoved} orphaned temp file(s) removed` : ''),
  );

  return { files, directoryCache, orphanedTempFilesRemoved };
}