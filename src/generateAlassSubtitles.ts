import { basename, dirname, join } from 'path';
import { execPromise, ProcessingResult } from './helpers';
import { readFileSync, existsSync, renameSync, copyFileSync, unlinkSync } from 'fs';

/**
 * Parse the first cue time from an SRT file and return it in milliseconds.
 * Returns null if the file can't be parsed.
 */
function getFirstCueTimeMs(srtPath: string): number | null {
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
 * Get the maximum allowed subtitle shift in milliseconds from env.
 * Default: 30000ms (30 seconds).
 */
function getMaxShiftMs(): number {
  const envVal = process.env.MAX_SUBTITLE_SHIFT_MS;
  if (envVal) {
    const val = parseInt(envVal, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return 30000; // 30 seconds default
}

export async function generateAlassSubtitles(srtPath: string, videoPath: string): Promise<ProcessingResult> {
  const directory = dirname(srtPath);
  const srtBaseName = basename(srtPath, '.srt');
  const tempPath = join(directory, `${srtBaseName}.alass-tmp.srt`);
  const backupPath = srtPath + '.bak';

  // Get original first cue time BEFORE any processing
  const originalFirstCueMs = getFirstCueTimeMs(srtPath);

  try {
    // Create a backup of the original subtitle file
    copyFileSync(srtPath, backupPath);

    // Run alass, writing to a temp file first
    const command = `alass "${videoPath}" "${srtPath}" "${tempPath}"`;
    console.log(`${new Date().toLocaleString()} Processing: ${command}`);

    try {
      const { stdout, stderr } = await execPromise(command);
      console.log(`${new Date().toLocaleString()} alass completed successfully for: ${basename(srtPath)}`);

      // Verify the temp output file was created
      if (!existsSync(tempPath)) {
        // Restore backup
        renameSync(backupPath, srtPath);
        return {
          success: false,
          message: `alass did not produce output file: ${tempPath}`,
          stdout: stdout || undefined,
          stderr: stderr || undefined,
        };
      }

      // --- SHIFT DETECTION ---
      // Compare the first cue time between original and new subtitle
      if (originalFirstCueMs !== null) {
        const newFirstCueMs = getFirstCueTimeMs(tempPath);
        if (newFirstCueMs !== null) {
          const shiftMs = Math.abs(newFirstCueMs - originalFirstCueMs);
          const maxShiftMs = getMaxShiftMs();

          console.log(
            `${new Date().toLocaleString()} Shift detected: ${shiftMs}ms (max allowed: ${maxShiftMs}ms) for: ${basename(srtPath)}`,
          );

          if (shiftMs > maxShiftMs) {
            // Shift too large — subtitle likely doesn't match this video
            console.log(
              `${new Date().toLocaleString()} Shift too large (${shiftMs}ms > ${maxShiftMs}ms), restoring backup for: ${basename(srtPath)}`,
            );

            // Remove temp file, restore backup
            try { unlinkSync(tempPath); } catch { /* ignore */ }
            renameSync(backupPath, srtPath);

            return {
              success: false,
              message: `Shift too large: ${shiftMs}ms (max: ${maxShiftMs}ms). Subtitle likely does not match this video.`,
              stdout: stdout || undefined,
              stderr: stderr || undefined,
              shiftTooLarge: true,
              originalShiftMs: shiftMs,
            };
          }
        }
      } else {
        console.log(
          `${new Date().toLocaleString()} Could not parse original SRT cue times, skipping shift check for: ${basename(srtPath)}`,
        );
      }

      // Shift is acceptable — replace original with synced version
      renameSync(tempPath, srtPath);

      // Remove backup since sync was successful
      try { unlinkSync(backupPath); } catch { /* ignore */ }

      return {
        success: true,
        message: `Successfully synced: ${basename(srtPath)}`,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };
    } catch (error) {
      // alass command itself failed — restore backup
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes('SIGTERM') || errorMessage.includes('timed out');

      // Restore backup
      try { unlinkSync(tempPath); } catch { /* ignore */ }
      renameSync(backupPath, srtPath);

      const execError = error as { stdout?: string; stderr?: string };
      const stdout = execError.stdout || '';
      const stderr = execError.stderr || '';

      if (isTimeout) {
        return {
          success: false,
          message: `Timeout: alass took longer than allowed timeout for ${basename(srtPath)}`,
          stdout: stdout || undefined,
          stderr: stderr || undefined,
        };
      }

      return {
        success: false,
        message: `Error processing ${basename(srtPath)}: ${errorMessage}`,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };
    }
  } catch (error) {
    // Fatal error (e.g., backup failed) — don't touch the original
    // Try to clean up any temp/backup files
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    try { unlinkSync(backupPath); } catch { /* ignore */ }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Fatal error processing ${basename(srtPath)}: ${errorMessage}`,
    };
  }
}
