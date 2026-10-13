/**
 * Unified engine wrapper — parameterized by command builder and output locator.
 * Eliminates 95% code duplication between alass and ffsubsync wrappers.
 *
 * Both engines follow the same pattern:
 * 1. Backup original SRT
 * 2. Run engine command
 * 3. Validate output (exists, has parseable cues, shift within threshold)
 * 4. Install or restore
 */

import { execPromise, ProcessingResult, getEngineTimeoutMs, getFirstCueTimeMs, getMaxShiftMs } from './helpers';
import { existsSync, copyFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, basename, join } from 'path';

export interface EngineOptions {
  /**
   * Shift all cues by one global offset (alass `--no-split`). Used for forced
   * subs: with only a handful of sparse cues, split mode lets alass place
   * each cue independently, which scatters them across the timeline.
   */
  noSplit?: boolean;
}

export interface EngineConfig {
  name: string;
  /** Binary plus argument array — run without a shell, so paths are never re-parsed. */
  buildCommand: (videoPath: string, srtPath: string, tempPath: string, opts: EngineOptions) => [string, string[]];
  tempSuffix: string;
}

const ENGINES: Record<string, EngineConfig> = {
  alass: {
    name: 'alass',
    buildCommand: (videoPath, srtPath, tempPath, opts) => [
      'alass',
      [...(opts.noSplit ? ['--no-split'] : []), videoPath, srtPath, tempPath],
    ],
    tempSuffix: 'alass-tmp',
  },
  ffsubsync: {
    name: 'ffsubsync',
    buildCommand: (videoPath, srtPath, tempPath) => ['ffsubsync', [videoPath, '-i', srtPath, '-o', tempPath]],
    tempSuffix: 'ffsubsync-tmp',
  },
};

export async function generateEngineSubtitles(
  engineName: string,
  srtPath: string,
  videoPath: string,
  signal?: AbortSignal,
  opts: EngineOptions = {},
): Promise<ProcessingResult> {
  const engine = ENGINES[engineName];
  if (!engine) {
    return { success: false, message: `Unknown engine: ${engineName}` };
  }

  const directory = dirname(srtPath);
  const srtBaseName = basename(srtPath, '.srt');
  const tempPath = join(directory, `.${srtBaseName}.${engine.tempSuffix}.srt`);
  const backupPath = join(directory, `.${srtBaseName}.srt.bak`);
  const originalFirstCueMs = getFirstCueTimeMs(srtPath);

  try {
    copyFileSync(srtPath, backupPath);
    const [bin, args] = engine.buildCommand(videoPath, srtPath, tempPath, opts);
    console.log(`${new Date().toLocaleString()} Processing: ${bin} ${args.join(' ')}`);

    try {
      const { stdout, stderr } = await execPromise(bin, args, getEngineTimeoutMs(engineName), signal);
      console.log(`${new Date().toLocaleString()} ${engineName} completed successfully for: ${basename(srtPath)}`);

      if (!existsSync(tempPath)) {
        renameSync(backupPath, srtPath);
        return {
          success: false,
          message: `${engineName} did not produce output file: ${tempPath}`,
          stdout: stdout?.substring(0, 1000) || undefined,
          stderr: stderr?.substring(0, 1000) || undefined,
        };
      }

      // Validate output has parseable cues
      const newFirstCueMs = getFirstCueTimeMs(tempPath);
      if (newFirstCueMs === null) {
        console.log(
          `${new Date().toLocaleString()} ${engineName} output has no parseable cues, restoring backup for: ${basename(srtPath)}`,
        );
        try {
          unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
        renameSync(backupPath, srtPath);
        return {
          success: false,
          message: `${engineName} produced empty or unparseable output for ${basename(srtPath)}`,
          stdout: stdout?.substring(0, 1000) || undefined,
          stderr: stderr?.substring(0, 1000) || undefined,
        };
      }

      // Check shift threshold
      if (originalFirstCueMs !== null) {
        const shiftMs = Math.abs(newFirstCueMs - originalFirstCueMs);
        const maxShiftMs = getMaxShiftMs();
        console.log(
          `${new Date().toLocaleString()} Shift detected: ${shiftMs}ms (max allowed: ${maxShiftMs}ms) for: ${basename(srtPath)}`,
        );

        if (shiftMs > maxShiftMs) {
          console.log(
            `${new Date().toLocaleString()} Shift too large (${shiftMs}ms > ${maxShiftMs}ms), restoring backup for: ${basename(srtPath)}`,
          );
          try {
            unlinkSync(tempPath);
          } catch {
            /* ignore */
          }
          renameSync(backupPath, srtPath);
          return {
            success: false,
            message: `Shift too large: ${shiftMs}ms (max: ${maxShiftMs}ms). Subtitle likely does not match this video.`,
            stdout: stdout?.substring(0, 1000) || undefined,
            stderr: stderr?.substring(0, 1000) || undefined,
            shiftTooLarge: true,
            originalShiftMs: shiftMs,
          };
        }
      } else {
        console.log(
          `${new Date().toLocaleString()} Could not parse original SRT cue times, skipping shift check for: ${basename(srtPath)}`,
        );
      }

      renameSync(tempPath, srtPath);
      try {
        unlinkSync(backupPath);
      } catch {
        /* ignore */
      }
      return {
        success: true,
        message: `Successfully synced: ${basename(srtPath)}`,
        stdout: stdout?.substring(0, 1000) || undefined,
        stderr: stderr?.substring(0, 1000) || undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes('SIGTERM') || /timed out/i.test(errorMessage);
      try {
        unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
      renameSync(backupPath, srtPath);
      const execError = error as { stdout?: string; stderr?: string };
      const stdout = execError.stdout || '';
      const stderr = execError.stderr || '';
      if (isTimeout) {
        return {
          success: false,
          message: `Timeout: ${engineName} took longer than allowed timeout for ${basename(srtPath)}`,
          stdout: stdout?.substring(0, 1000) || undefined,
          stderr: stderr?.substring(0, 1000) || undefined,
        };
      }
      return {
        success: false,
        message: `Error processing ${basename(srtPath)}: ${errorMessage}${stderr ? ' -- stderr: ' + stderr.substring(0, 300) : ''}`,
        stdout: stdout?.substring(0, 1000) || undefined,
        stderr: stderr?.substring(0, 1000) || undefined,
      };
    }
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(backupPath);
    } catch {
      /* ignore */
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Fatal error processing ${basename(srtPath)}: ${errorMessage}` };
  }
}
