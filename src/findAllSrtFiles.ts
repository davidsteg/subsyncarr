import { readdirSync, unlinkSync } from 'fs';
import { stat } from 'fs/promises';
import { extname, join } from 'path';
import { existsSync } from 'fs';
import { ScanConfig } from './config';
import { getOutputPath, getSubtitleFormat, isSyncedSrt, isCorruptSyncedSrt } from './helpers';
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
const TEMP_FILE_PATTERNS = ['.alass-tmp.', '.ffsubsync-tmp.', '.subsyncarr_retry.', '.anchor-ref.'];

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
): Promise<{ files: string[]; directoryCache: DirectoryCache; orphanedTempFilesRemoved: number; corruptedSyncedFilesRemoved: number }> {
  const engines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
  const format = getSubtitleFormat();

  // Initialize directory cache for video file matching (built lazily during processing)
  const directoryCache = initDirectoryCache();

  // Phase 1: Walk directory tree synchronously (fast — just readdir calls, ~5 seconds for 197K files)
  const srtPaths: string[] = [];
  let orphanedTempFilesRemoved = 0;

  function removeOrphan(fullPath: string, label: string): void {
    if (dryRun) {
      console.log(`${new Date().toLocaleString()} [DRY RUN] Would delete ${label}: ${fullPath}`);
      return;
    }
    try {
      unlinkSync(fullPath);
      orphanedTempFilesRemoved++;
      console.log(`${new Date().toLocaleString()} Deleted ${label}: ${fullPath}`);
    } catch (err) {
      console.log(`${new Date().toLocaleString()} Failed to delete ${label} ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
      if (!entry.isFile()) continue;

      // Engine backups (`.name.srt.bak`) don't end in `.srt`, so they'd never
      // be seen by the `.srt`-only check below — a crashed/killed run can
      // leave one behind just as easily as a `-tmp.srt` file.
      if (entry.name.endsWith('.srt.bak')) {
        removeOrphan(fullPath, 'orphaned backup file');
        continue;
      }

      if (extname(entry.name).toLowerCase() !== '.srt') {
        continue;
      }

      if (isOrphanedTempFile(entry.name)) {
        removeOrphan(fullPath, 'orphaned temp file');
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
  let corruptedSyncedFilesRemoved = 0;

  async function checkFile(srtPath: string): Promise<void> {
    let isSynced: boolean;

    if (format === 'overwrite') {
      // Check DB cache first, but only trust it if the file's mtime/size
      // still match what was recorded — a cheap stat() call, much less
      // costly than reading file content, so this still avoids the header
      // read for the common case where nothing changed.
      let fileStat: { mtimeMs: number; size: number } | null = null;
      try {
        const s = await stat(srtPath);
        fileStat = { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        fileStat = null;
      }

      if (db && fileStat && db.isFileInSyncCache(srtPath, fileStat.mtimeMs, fileStat.size)) {
        isSynced = true;
      } else {
        // Async header check — pipelines I/O on network storage
        isSynced = await isSyncedSrt(srtPath);
        // Cache result (with current mtime/size) to avoid future header reads
        if (isSynced && db && fileStat) {
          db.addFileToSyncCache(srtPath, fileStat.mtimeMs, fileStat.size);
        }
      }

      // Repair pass: a past run could have installed empty/unparseable
      // engine output under the sync marker (see the engine wrappers' cue
      // validation, added to prevent this going forward) — that file reads
      // as "already synced" forever and is never looked at again, while
      // Jellyfin/ffprobe rejects it on every library scan. Delete it here so
      // it drops out of the cache and gets resupplied instead of staying
      // permanently broken. Runs on cache hits too, since a corrupted file's
      // mtime/size never changes once broken — that's exactly what makes it
      // stick in the cache.
      if (isSynced) {
        const corrupt = await isCorruptSyncedSrt(srtPath);
        if (corrupt) {
          isSynced = false;
          if (dryRun) {
            console.log(`${new Date().toLocaleString()} [DRY RUN] Would delete corrupted synced subtitle (0 cues): ${srtPath}`);
          } else {
            try {
              unlinkSync(srtPath);
              corruptedSyncedFilesRemoved++;
              console.log(`${new Date().toLocaleString()} Deleted corrupted synced subtitle (0 cues): ${srtPath}`);
              if (db) db.removeFileFromSyncCache(srtPath);
            } catch (err) {
              console.log(`${new Date().toLocaleString()} Failed to delete corrupted subtitle ${srtPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          completedCount++;
          // File is gone (or dry-run pretends it is) — nothing to sync or skip.
          return;
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
      (orphanedTempFilesRemoved > 0 ? `, ${orphanedTempFilesRemoved} orphaned temp file(s) removed` : '') +
      (corruptedSyncedFilesRemoved > 0 ? `, ${corruptedSyncedFilesRemoved} corrupted synced subtitle(s) removed` : ''),
  );

  return { files, directoryCache, orphanedTempFilesRemoved, corruptedSyncedFilesRemoved };
}