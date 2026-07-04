import { execPromise, ProcessingResult, getEngineTimeoutMs, getFirstCueTimeMs, getMaxShiftMs } from './helpers';
import { existsSync, copyFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, basename, join } from 'path';

export async function generateAlassSubtitles(
  srtPath: string,
  videoPath: string,
  signal?: AbortSignal,
): Promise<ProcessingResult> {
  const directory = dirname(srtPath);
  const srtBaseName = basename(srtPath, '.srt');
  const tempPath = join(directory, `${srtBaseName}.alass-tmp.srt`);
  const backupPath = srtPath + '.bak';
  const originalFirstCueMs = getFirstCueTimeMs(srtPath);

  try {
    copyFileSync(srtPath, backupPath);
    const command = `alass "${videoPath}" "${srtPath}" "${tempPath}"`;
    console.log(`${new Date().toLocaleString()} Processing: ${command}`);

    try {
      const { stdout, stderr } = await execPromise(command, getEngineTimeoutMs('alass'), signal);
      console.log(`${new Date().toLocaleString()} alass completed successfully for: ${basename(srtPath)}`);

      if (!existsSync(tempPath)) {
        renameSync(backupPath, srtPath);
        return { success: false, message: `alass did not produce output file: ${tempPath}`, stdout: stdout || undefined, stderr: stderr || undefined };
      }

      if (originalFirstCueMs !== null) {
        const newFirstCueMs = getFirstCueTimeMs(tempPath);
        if (newFirstCueMs !== null) {
          const shiftMs = Math.abs(newFirstCueMs - originalFirstCueMs);
          const maxShiftMs = getMaxShiftMs();
          console.log(`${new Date().toLocaleString()} Shift detected: ${shiftMs}ms (max allowed: ${maxShiftMs}ms) for: ${basename(srtPath)}`);

          if (shiftMs > maxShiftMs) {
            console.log(`${new Date().toLocaleString()} Shift too large (${shiftMs}ms > ${maxShiftMs}ms), restoring backup for: ${basename(srtPath)}`);
            try { unlinkSync(tempPath); } catch { /* ignore */ }
            renameSync(backupPath, srtPath);
            return { success: false, message: `Shift too large: ${shiftMs}ms (max: ${maxShiftMs}ms). Subtitle likely does not match this video.`, stdout: stdout || undefined, stderr: stderr || undefined, shiftTooLarge: true, originalShiftMs: shiftMs };
          }
        }
      } else {
        console.log(`${new Date().toLocaleString()} Could not parse original SRT cue times, skipping shift check for: ${basename(srtPath)}`);
      }

      renameSync(tempPath, srtPath);
      try { unlinkSync(backupPath); } catch { /* ignore */ }
      return { success: true, message: `Successfully synced: ${basename(srtPath)}`, stdout: stdout || undefined, stderr: stderr || undefined };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes('SIGTERM') || errorMessage.includes('timed out');
      try { unlinkSync(tempPath); } catch { /* ignore */ }
      renameSync(backupPath, srtPath);
      const execError = error as { stdout?: string; stderr?: string };
      const stdout = execError.stdout || '';
      const stderr = execError.stderr || '';
      if (isTimeout) {
        return { success: false, message: `Timeout: alass took longer than allowed timeout for ${basename(srtPath)}`, stdout: stdout || undefined, stderr: stderr || undefined };
      }
      return { success: false, message: `Error processing ${basename(srtPath)}: ${errorMessage}${stderr ? ' -- stderr: ' + stderr.substring(0, 300) : ''}`, stdout: stdout || undefined, stderr: stderr || undefined };
    }
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    try { unlinkSync(backupPath); } catch { /* ignore */ }
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Fatal error processing ${basename(srtPath)}: ${errorMessage}` };
  }
}
