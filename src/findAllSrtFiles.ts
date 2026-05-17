import { readdirSync } from 'fs';
import { extname, join } from 'path';
import { existsSync } from 'fs';
import { ScanConfig } from './config';
import { getOutputPath, getSubtitleFormat, isSyncedSrtSync } from './helpers';
import { DirectoryCache, initDirectoryCache } from './findMatchingVideoFile';

function isAlreadySynced(srtPath: string, engines: string[]): boolean {
  const format = getSubtitleFormat();
  if (format === 'overwrite') {
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

  // Single-phase scan: walk directories and check sync status inline.
  // Yields every 500 files to keep the event loop responsive.
  async function scan(directory: string): Promise<void> {
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
        await scan(fullPath);
      } else if (
        entry.isFile() &&
        extname(entry.name).toLowerCase() === '.srt' &&
        !isEngineOutput(entry.name)
      ) {
        totalScanned++;

        // Yield to event loop every 500 files to keep UI/API responsive
        if (totalScanned % 500 === 0) {
          await yieldToEventLoop();
        }

        // Log progress every 10K files
        if (totalScanned % 10000 === 0) {
          console.log(
            `${new Date().toLocaleString()} Scan progress: ${totalScanned} SRT files checked, ${files.length} need sync, ${skippedCount} already synced`,
          );
        }

        if (isAlreadySynced(fullPath, engines)) {
          skippedCount++;
        } else {
          files.push(fullPath);
        }
      }
    }
  }

  // Scan all included paths
  for (const includePath of config.includePaths) {
    await scan(includePath);
  }

  console.log(
    `${new Date().toLocaleString()} Scan complete: ${totalScanned} SRT files found, ${files.length} need sync, ${skippedCount} already synced`,
  );

  return { files, directoryCache };
}