import { exec } from 'child_process';
import { basename, dirname, join } from 'path';
import { writeFileSync, openSync, readSync, closeSync } from 'fs';
import { open } from 'fs/promises';

export type SubtitleFormat = 'standard' | 'overwrite';

export function getSubtitleFormat(): SubtitleFormat {
  const format = process.env.SUBTITLE_FORMAT || 'standard';
  if (format === 'overwrite' || process.env.OVERWRITE_SUBTITLES === 'true') return 'overwrite';
  return 'standard';
}

export function getOutputPath(srtPath: string, engine: string): string {
  const directory = dirname(srtPath);
  const srtBaseName = basename(srtPath, '.srt');
  return join(directory, `${srtBaseName}.${engine}.srt`);
}

const SYNC_MARKER = '# synced:';
const SYNC_MARKER_BUF = Buffer.from(SYNC_MARKER);

/**
 * Synchronous version of isSyncedSrt — much faster for bulk scanning.
 * Reads only the first 100 bytes to check for the sync marker header.
 */
export function isSyncedSrtSync(srtPath: string): boolean {
  try {
    const fd = openSync(srtPath, 'r');
    const buf = Buffer.alloc(100);
    const bytesRead = readSync(fd, buf, 0, 100, 0);
    closeSync(fd);
    if (bytesRead < SYNC_MARKER_BUF.length) return false;
    return buf.toString('utf8', 0, bytesRead).startsWith(SYNC_MARKER);
  } catch {
    return false;
  }
}

export async function isSyncedSrt(srtPath: string): Promise<boolean> {
  try {
    const fd = await open(srtPath, 'r');
    const buf = Buffer.alloc(100);
    await fd.read(buf, 0, 100, 0);
    await fd.close();
    return buf.toString('utf8').startsWith(SYNC_MARKER);
  } catch {
    return false;
  }
}

export function markSrtAsSynced(srtPath: string, engine: string, content: string): void {
  const marker = `${SYNC_MARKER}${engine} ${Date.now()}\n`;
  writeFileSync(srtPath, marker + content, 'utf8');
}

export interface ProcessingResult {
  success: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
  skipped?: boolean;
  /** Offset in ms between original and synced subtitles (if calculated) */
  offsetMs?: number;
  /** True when the subtitle doesn't fit the media (offset too large even after retry) */
  notFitting?: boolean;
}

function getTimeoutMs(): number {
  // Support both SYNC_TIMEOUT (seconds) and SYNC_ENGINE_TIMEOUT_MS (milliseconds)
  const seconds = process.env.SYNC_TIMEOUT;
  if (seconds) {
    const val = parseInt(seconds, 10);
    if (!isNaN(val) && val > 0) return val * 1000;
  }
  const ms = process.env.SYNC_ENGINE_TIMEOUT_MS;
  if (ms) {
    const val = parseInt(ms, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return 300000; // 5 minutes default (was 30 min — too long for hanging processes)
}

/**
 * Get timeout for a specific sync engine.
 * Per-engine env vars take precedence: ALASS_TIMEOUT_MS, FFSUBSYNC_TIMEOUT_MS, AUTOSUBSYNC_TIMEOUT_MS
 * Falls back to the general SYNC_ENGINE_TIMEOUT_MS / SYNC_TIMEOUT / default.
 */
export function getEngineTimeoutMs(engine: string): number {
  const engineEnvMap: Record<string, string> = {
    alass: 'ALASS_TIMEOUT_MS',
    ffsubsync: 'FFSUBSYNC_TIMEOUT_MS',
    autosubsync: 'AUTOSUBSYNC_TIMEOUT_MS',
  };
  const envVar = engineEnvMap[engine];
  if (envVar && process.env[envVar]) {
    const val = parseInt(process.env[envVar]!, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return getTimeoutMs();
}

export function execPromise(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const timeout = timeoutMs ?? getTimeoutMs();
  return new Promise((resolve, reject) => {
    const child = exec(command, { timeout, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (signal?.aborted) {
        reject(new Error(`Aborted: ${command}`));
        return;
      }
      if (error) {
        if (error.killed) {
          reject(new Error(`Timed out after ${timeout / 1000}s: ${command}`));
        } else {
          reject(error);
        }
      } else {
        resolve({ stdout, stderr });
      }
    });

    // Kill the child process if abort signal fires (e.g. user clicked Skip)
    if (signal) {
      if (signal.aborted) {
        child.kill('SIGTERM');
      } else {
        const onAbort = () => {
          child.kill('SIGTERM');
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}
