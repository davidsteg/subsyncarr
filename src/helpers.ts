import { execFile } from 'child_process';
import { basename, dirname, join } from 'path';
import { writeFileSync, openSync, readSync, closeSync, readFileSync } from 'fs';
import { open, readFile } from 'fs/promises';

export type SubtitleFormat = 'standard' | 'overwrite';

/** Parse the start time of an SRT's first cue, in ms. Returns null if unparseable. */
export function getFirstCueTimeMs(srtPath: string): number | null {
  try {
    const content = readFileSync(srtPath, 'utf-8');
    const match = content.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->/m);
    if (!match) return null;
    const [, h, m, s, ms] = match;
    return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms);
  } catch {
    return null;
  }
}

/**
 * Max allowed shift (ms) between an engine's output and the original before
 * it's judged a mismatch. Runtime config (Settings UI, persisted in DB) takes
 * precedence — previously this read only the env var, making the Settings
 * field a silent no-op.
 */
export function getMaxShiftMs(): number {
  try {
    const { getRuntimeCfg } = require('./engineRuntime');
    const cfg = getRuntimeCfg();
    if (cfg.maxSubtitleShiftMs > 0) return cfg.maxSubtitleShiftMs;
  } catch {}
  const envVal = process.env.MAX_SUBTITLE_SHIFT_MS;
  if (envVal) {
    const val = parseInt(envVal, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return 30000;
}

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

export const SYNC_MARKER = '# synced:';
const SYNC_MARKER_BUF = Buffer.from(SYNC_MARKER);

/**
 * Synchronous version of isSyncedSrt — fast for bulk scanning.
 * Reads only the first 100 bytes to check for the sync marker header.
 * Must be called with periodic yields to avoid blocking the event loop.
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

export function markSrtAsSynced(srtPath: string, engine: string, content: string | Buffer): void {
  // Write clean SRT only — no header prepended.
  // The sync marker line (# synced:alass ...) was invalid SRT: it broke
  // ffprobe/Jellyfin's SubtitleResolver, which requires files to start
  // with a cue number. Sync status is now tracked solely via the
  // database sync cache (synced_files table), not via file headers.
  writeFileSync(srtPath, content);
}

/**
 * A file already carrying the "# synced:" marker but with zero parseable
 * cues in its body — evidence that a past run's engine installed empty or
 * unparseable output (the bug the `getFirstCueTimeMs === null` guards in
 * the engine wrappers now prevent going forward). Because the marker makes
 * `isSyncedSrt` report "already synced", a file like this is otherwise never
 * looked at again — it fails ffprobe on every media-server scan forever.
 * Only call on files already confirmed synced; this reads the full file.
 */
export async function isCorruptSyncedSrt(srtPath: string): Promise<boolean> {
  try {
    const content = await readFile(srtPath, 'utf8');
    return !/\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(content);
  } catch {
    return false;
  }
}

/**
 * Strip the legacy `# synced:` header line from a single SRT file.
 * Returns true if the file was rewritten, false if no header was found.
 * The header was invalid SRT and broke ffprobe/Jellyfin's SubtitleResolver.
 */
export function stripLegacySyncHeader(srtPath: string): boolean {
  try {
    const fd = openSync(srtPath, 'r');
    const buf = Buffer.alloc(100);
    const bytesRead = readSync(fd, buf, 0, 100, 0);
    closeSync(fd);
    if (bytesRead <= 0 || !buf.toString('utf8', 0, bytesRead).startsWith(SYNC_MARKER)) {
      return false;
    }
    // Work on raw bytes: decoding as UTF-8 and writing back would mangle
    // subtitles stored in Latin-1/Windows-1252 (common for German subs).
    const content = readFileSync(srtPath);
    const newlinePos = content.indexOf(0x0a);
    if (newlinePos === -1) return false;
    writeFileSync(srtPath, content.subarray(newlinePos + 1));
    return true;
  } catch {
    return false;
  }
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
  /** True when the engine produced output but the shift was too large (subtitle mismatch, not engine failure) */
  shiftTooLarge?: boolean;
  /** The detected shift in ms (only set when shiftTooLarge) */
  originalShiftMs?: number;
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
 * Runtime config (set via the Settings UI, persisted in DB) takes precedence
 * — it already incorporates the per-engine env var as its own default at
 * load time, so a Settings change always wins instead of being silently
 * overridden by a stale ALASS_TIMEOUT_MS / FFSUBSYNC_TIMEOUT_MS / AUTOSUBSYNC_TIMEOUT_MS.
 * Falls back to the env var directly, then SYNC_ENGINE_TIMEOUT_MS / SYNC_TIMEOUT / default.
 */
export function getEngineTimeoutMs(engine: string): number {
  try {
    const { getRuntimeCfg } = require('./engineRuntime');
    const cfg = getRuntimeCfg();
    if (cfg.engineTimeouts[engine] && cfg.engineTimeouts[engine] > 0) {
      return cfg.engineTimeouts[engine];
    }
  } catch {}

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

/**
 * Run an engine binary with an argument array (no shell). Paths are passed
 * verbatim, so filenames containing `$`, backticks, quotes or backslashes
 * reach the engine intact — the old `exec("alass \"${path}\" ...")` form let
 * the shell expand them, the engine got a wrong path, failed, and the
 * subtitle collected not-fitting strikes until it was deleted.
 */
export function execPromise(
  file: string,
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const timeout = timeoutMs ?? getTimeoutMs();
  const label = [file, ...args].join(' ');
  return new Promise((resolve, reject) => {
    // maxBuffer caps the child's *stdout/stderr* — if the engine prints more
    // than this, execFile kills it and the sync fails spuriously. ffsubsync in
    // particular can be very chatty (progress output) on a long decode, so
    // keep generous headroom here. This is unrelated to how much we persist:
    // what lands in the DB is capped separately (stdout?.substring(0, 1000)
    // in engineWrapper), so a large buffer here costs only transient memory.
    const child = execFile(
      file,
      args,
      { timeout, maxBuffer: 1024 * 1024 * 10, env: process.env },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(new Error(`Aborted: ${label}`));
          return;
        }
        if (error) {
          if (error.killed) {
            reject(new Error(`Timed out after ${timeout / 1000}s: ${label}`));
          } else {
            reject(error);
          }
        } else {
          resolve({ stdout, stderr });
        }
      },
    );

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
