import { existsSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';

type VideoExtension = '.mkv' | '.mp4' | '.avi' | '.mov';
const VIDEO_EXTENSIONS: VideoExtension[] = ['.mkv', '.mp4', '.avi', '.mov'];

/**
 * Cache of directory → Set of filenames for fast video file lookup.
 * Avoids repeated readdir+stat calls for files in the same directory.
 */
export class DirectoryCache {
  private cache = new Map<string, Map<string, string>>();

  /**
   * Get or build the filename → full path map for a directory.
   * Returns a Map where keys are lowercase filenames for case-insensitive lookup.
   */
  private getDirectoryMap(directory: string): Map<string, string> {
    let dirMap = this.cache.get(directory);
    if (dirMap) return dirMap;

    dirMap = new Map();
    try {
      const entries = readdirSync(directory);
      for (const entry of entries) {
        const fullPath = join(directory, entry);
        try {
          if (statSync(fullPath).isFile()) {
            dirMap.set(entry.toLowerCase(), fullPath);
          }
        } catch {
          // Skip files that can't be stat'd
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    this.cache.set(directory, dirMap);
    return dirMap;
  }

  /**
   * Check if a file exists in the directory cache.
   */
  existsSync(filePath: string): boolean {
    const directory = dirname(filePath);
    const fileName = basename(filePath);
    const dirMap = this.getDirectoryMap(directory);
    return dirMap.has(fileName.toLowerCase());
  }

  /**
   * Get the actual file path (with correct case) from the cache.
   */
  getFilePath(directory: string, fileName: string): string | null {
    const dirMap = this.getDirectoryMap(directory);
    return dirMap.get(fileName.toLowerCase()) ?? null;
  }

  /**
   * Pre-populate the cache for a directory.
   */
  prePopulate(directory: string): void {
    this.getDirectoryMap(directory);
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.cache.clear();
  }
}

// Global directory cache instance — shared across all file processing
let globalCache: DirectoryCache | null = null;

/**
 * Get or create the global directory cache.
 * Call initDirectoryCache() before processing starts to enable caching.
 */
export function getDirectoryCache(): DirectoryCache | null {
  return globalCache;
}

/**
 * Initialize the global directory cache for video file matching.
 */
export function initDirectoryCache(): DirectoryCache {
  globalCache = new DirectoryCache();
  return globalCache;
}

/**
 * Clear the global directory cache.
 */
export function clearDirectoryCache(): void {
  if (globalCache) {
    globalCache.clear();
  }
  globalCache = null;
}

export function findMatchingVideoFile(srtPath: string, cache?: DirectoryCache | null): string | null {
  const directory = dirname(srtPath);
  const srtBaseName = basename(srtPath, '.srt');

  // Try exact match first
  for (const ext of VIDEO_EXTENSIONS) {
    const videoFileName = `${srtBaseName}${ext}`;
    if (cache) {
      const result = cache.getFilePath(directory, videoFileName);
      if (result) return result;
    } else {
      const possibleVideoPath = join(directory, videoFileName);
      if (existsSync(possibleVideoPath)) {
        return possibleVideoPath;
      }
    }
  }

  // Progressive tag removal - split by dots and try removing one segment at a time
  const segments = srtBaseName.split('.');
  while (segments.length > 1) {
    segments.pop(); // Remove the last segment
    const baseNameToTry = segments.join('.');

    for (const ext of VIDEO_EXTENSIONS) {
      const videoFileName = `${baseNameToTry}${ext}`;
      if (cache) {
        const result = cache.getFilePath(directory, videoFileName);
        if (result) return result;
      } else {
        const possibleVideoPath = join(directory, `${baseNameToTry}${ext}`);
        if (existsSync(possibleVideoPath)) {
          return possibleVideoPath;
        }
      }
    }
  }

  return null;
}
