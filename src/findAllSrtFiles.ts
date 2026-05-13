import { readdir } from 'fs/promises';
import { extname, join } from 'path';
import { existsSync } from 'fs';
import { ScanConfig } from './config';
import { getOutputPath, getSubtitleFormat, isSyncedSrtSync } from './helpers';
import { DirectoryCache, initDirectoryCache } from './findMatchingVideoFile';

function isAlreadySynced(srtPath: string, engines: string[]): boolean {
  const format = getSubtitleFormat();
  if (format === 'overwrite') {
    // In overwrite mode, check the sync marker header directly
    // This is much faster than deferring to processFile for 197K+ files
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

export async function findAllSrtFiles(config: ScanConfig): Promise<{ files: string[]; directoryCache: DirectoryCache }> {
  const engines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
  const files: string[] = [];
  let skippedCount = 0;

  // Initialize directory cache for video file matching
  const directoryCache = initDirectoryCache();

  async function scan(directory: string): Promise<void> {
    // Check if this directory should be excluded
    if (config.excludePaths.some((excludePath) => directory.startsWith(excludePath))) {
      return;
    }

    const entries = await readdir(directory, { withFileTypes: true });

    // Pre-populate directory cache for video file matching
    directoryCache.prePopulate(directory);

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (
        entry.isFile() &&
        extname(entry.name).toLowerCase() === '.srt' &&
        !isEngineOutput(entry.name)
      ) {
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

  if (skippedCount > 0) {
    console.log(`${new Date().toLocaleString()} Skipped ${skippedCount} already-synced SRT files`);
  }

  return { files, directoryCache };
}
