import { readdir } from 'fs/promises';
import { basename, dirname, extname, join, normalize, relative } from 'path';
import { ScanConfig } from './config';

/**
 * Check whether a directory is excluded.
 * Uses normalized relative-path comparison so /media/Download doesn't also match /media/Downloads.
 */
function isExcluded(directory: string, excludePaths: string[]): boolean {
  const normalized = normalize(directory);
  for (const excludePath of excludePaths) {
    const normalizedExclude = normalize(excludePath);
    if (normalized === normalizedExclude) return true;
    // Check if directory is a subdirectory of the excluded path
    const rel = relative(normalizedExclude, normalized);
    if (rel !== '' && !rel.startsWith('..') && !normalize(rel).startsWith('..')) return true;
  }
  return false;
}

export async function findAllSrtFiles(
  config: ScanConfig,
  isAlreadySynced?: (filePath: string) => boolean | Promise<boolean>,
): Promise<string[]> {
  const files: string[] = [];
  let skippedCount = 0;

  async function scan(directory: string): Promise<void> {
    if (isExcluded(directory, config.excludePaths)) {
      return;
    }

    const entries = await readdir(directory, { withFileTypes: true });
    let dirFileCount = 0;

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (
        entry.isFile() &&
        extname(entry.name).toLowerCase() === '.srt' &&
        !entry.name.includes('.ffsubsync.') &&
        !entry.name.includes('.alass.') &&
        !entry.name.includes('.autosubsync.')
      ) {
        if (isAlreadySynced && (await isAlreadySynced(fullPath))) {
          skippedCount++;
        } else {
          files.push(fullPath);
        }
        dirFileCount++;
        // Yield to the event loop every 200 files to keep Express responsive
        if (dirFileCount % 200 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
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

  return files;
}
