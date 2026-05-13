import { execPromise, ProcessingResult, getOutputPath, getSubtitleFormat, getEngineTimeoutMs } from './helpers';
import { existsSync } from 'fs';

export async function generateAutosubsyncSubtitles(srtPath: string, videoPath: string, signal?: AbortSignal): Promise<ProcessingResult> {
  const outputPath = getOutputPath(srtPath, 'autosubsync');

  if (getSubtitleFormat() !== 'overwrite') {
    const exists = existsSync(outputPath);
    if (exists) {
      return {
        success: true,
        message: `Skipping ${outputPath} - already processed`,
        skipped: true,
      };
    }
  }

  try {
    const command = `autosubsync "${videoPath}" "${srtPath}" "${outputPath}"`;
    console.log(`${new Date().toLocaleString()} Processing: ${command}`);
    const { stdout, stderr } = await execPromise(command, getEngineTimeoutMs('autosubsync'), signal);
    return {
      success: true,
      message: `Successfully processed: ${outputPath}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = errorMessage.includes('SIGTERM') || errorMessage.includes('timed out');
    const isAborted = errorMessage.includes('Aborted');

    // Extract stdout/stderr from error if available
    const execError = error as { stdout?: string; stderr?: string };
    const stdout = execError.stdout || '';
    const stderr = execError.stderr || '';

    if (isAborted) {
      return {
        success: false,
        message: `Skipped: ${outputPath} was cancelled by user`,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };
    }

    if (isTimeout) {
      return {
        success: false,
        message: `Timeout: ${outputPath} took longer than allowed timeout`,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      };
    }

    return {
      success: false,
      message: `Error processing ${outputPath}: ${errorMessage}`,
      stdout: stdout || undefined,
      stderr: stderr || undefined,
    };
  }
}
