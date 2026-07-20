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

export interface EngineConfig {
  name: string;
  buildCommand: (videoPath: string, srtPath: string, tempPath: string) => string;
  tempSuffix: string;
}

const ENGINES: Record<string, EngineConfig> = {
  alass: {
    name: 'alass',
    buildCommand: (videoPath, srtPath, tempPath) => `alass "${videoPath}" "${srtPath}" "${tempPath}"`,
    tempSuffix: 'alass-tmp',
  },
  ffsubsync: {
    name: 'ffsubsync',
    buildCommand: (videoPath, srtPath, tempPath) => `ffsubsync "${videoPath}" -i "${srtPath}" -o "${tempPath}"`,
    tempSuffix: 'ffsubsync-tmp',
  },
};

export async function generateEngineSubtitles(
  engineName: string,
  srtPath: string,
  videoPath: string,
  signal?: AbortSignal,
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
    const command = engine.buildCommand(videoPath, srtPath, tempPath);
    console.log(`${new Date().toLocaleString()} Processing: ${command}`);

    try {
      const { stdout, stderr } = await execPromise(command, getEngineTimeoutMs(engineName), signal);
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
      const isTimeout = errorMessage.includes('SIGTERM') || errorMessage.includes('timed out');
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
