import { readdirSync } from 'fs';
import { extname, join } from 'path';
import { existsSync } from 'fs';
import { ScanConfig } from './config';
import { getOutputPath, getSubtitleFormat, isSyncedSrt } from './helpers';
import { DirectoryCache, initDirectoryCache } from './findMatchingVideoFile';

const ALL_KNOWN_ENGINES = ['ffsubsync', 'autosubsync', 'alass'];

function isEngineOutput(filename: string): boolean {
  return ALL_KNOWN_ENGINES.some((engine) => filename.includes(`.${engine}.`));
}

/** Concurrency limit for async file checks — pipelines I/O on network storage */
const CHECK_CONCURRENCY = 20;

export async function findAllSrtFiles(config: ScanConfig): Promise<{ files: string[]; directoryCache: DirectoryCache }> {
  const engines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
  const format = getSubtitleFormat();

  // Initialize directory cache for video file matching (built lazily during processing)
  const directoryCache = initDirectoryCache();

  // Phase 1: Walk directory tree synchronously (fast — just readdir calls, ~5 seconds for 197K files)
  const srtPaths: string[] = [];

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
      } else if (
        entry.isFile() &&
        extname(entry.name).toLowerCase() === '.srt' &&
        !isEngineOutput(entry.name)
      ) {
        srtPaths.push(fullPath);
      }
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
      // Async header check — pipelines I/O on network storage
      isSynced = await isSyncedSrt(srtPath);
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

    // Log progress every 10K files
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
    `${new Date().toLocaleString()} Scan complete: ${srtPaths.length} SRT files found, ${files.length} need sync, ${skippedCount} already synced`,
  );

  return { files, directoryCache };
}