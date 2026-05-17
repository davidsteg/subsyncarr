import { readdirSync } from 'fs';
import { extname, join } from 'path';
import { existsSync } from 'fs';
import { ScanConfig } from './config';
import { getOutputPath, getSubtitleFormat, isSyncedSrtSync } from './helpers';
import { DirectoryCache, initDirectoryCache } from './findMatchingVideoFile';

function isAlreadySynced(srtPath: string, engines: string[]): boolean {
  const format = getSubtitleFormat();
  if (format === 'overwrite') {
    // Sync header check — fast (microseconds per file) with periodic yields
    return isSyncedSrtSync(srtPath);
  }

  return engines.every((engine) => {
    const outputPath = getOutputPath(srtPath, engine);
    return existsSync(outputPath);
  });
}

const ALL_KNOWN_ENGINES = ['ffsubsync', 'autosubsync', 'alass'];

function isEngineOutput(filename: string): boolean {
  return ALL_KNOWN_ENGINES.some((engine) => filename.includes(`.${engine}.`));
}

/** Yield to the event loop so WebSocket, logs, and status updates can process */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function findAllSrtFiles(config: ScanConfig): Promise<{ files: string[]; directoryCache: DirectoryCache }> {
  const engines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
  const files: string[] = [];
  let skippedCount = 0;
  let totalScanned = 0;

  // Initialize directory cache for video file matching (built lazily during processing)
  const directoryCache = initDirectoryCache();

  // Collect all SRT paths first using sync readdir (fast, no per-file I/O yet)
  const srtPaths: string[] = [];

  function collectSrtPaths(directory: string): void {
    // Check if this directory should be excluded
    if (config.excludePaths.some((excludePath) => directory.startsWith(excludePath))) {
      return;
    }

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // Skip directories we can't read (permission errors, etc.)
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

  // Phase 1: Walk directory tree (sync, very fast — just readdir calls)
  for (const includePath of config.includePaths) {
    collectSrtPaths(includePath);
  }

  console.log(
    `${new Date().toLocaleString()} Found ${srtPaths.length} SRT files in directory walk, checking sync status...`,
  );

  // Phase 2: Check sync status with periodic yields to keep event loop responsive
  for (let i = 0; i < srtPaths.length; i++) {
    const srtPath = srtPaths[i];
    totalScanned++;

    // Yield to event loop every 500 files to keep UI/API responsive
    if (totalScanned % 500 === 0) {
      await yieldToEventLoop();
    }

    // Log progress every 10K files
    if (totalScanned % 10000 === 0) {
      console.log(
        `${new Date().toLocaleString()} Scan progress: ${totalScanned}/${srtPaths.length} checked, ${files.length} need sync, ${skippedCount} already synced`,
      );
    }

    if (isAlreadySynced(srtPath, engines)) {
      skippedCount++;
    } else {
      files.push(srtPath);
    }
  }

  console.log(
    `${new Date().toLocaleString()} Scan complete: ${totalScanned} SRT files found, ${files.length} need sync, ${skippedCount} already synced`,
  );

  return { files, directoryCache };
}