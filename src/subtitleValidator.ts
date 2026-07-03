import { readFileSync, statSync } from 'fs';

export interface SubtitleValidationResult {
  isSuspicious: boolean;
  probability: number;  // 0.0 - 1.0, higher = more likely wrong
  reasons: string[];
  metrics: {
    cueCount: number;
    firstCueMs: number | null;
    lastCueMs: number | null;
    durationMs: number | null;
    hasNonLatinChars: boolean;
    languageHint: string | null;
    avgCueLength: number;
  };
}

/**
 * Validate whether a subtitle file likely matches its video.
 * Uses multiple heuristics to detect wrong/mismatched subtitles.
 */
export function validateSubtitleMatch(srtPath: string, videoPath: string | null): SubtitleValidationResult {
  const reasons: string[] = [];
  let probability = 0;
  let cueCount = 0;
  let firstCueMs: number | null = null;
  let lastCueMs: number | null = null;
  let durationMs: number | null = null;
  let hasNonLatinChars = false;
  let languageHint: string | null = null;
  let avgCueLength = 0;

  try {
    const content = readFileSync(srtPath, 'utf-8');
    const lines = content.split('\n');

    // Parse cues
    const cueTimestamps: Array<{ start: number; end: number; text: string }> = [];
    let i = 0;
    while (i < lines.length) {
      // Skip index line
      while (i < lines.length && !lines[i].includes('-->')) i++;
      if (i >= lines.length) break;

      const timeMatch = lines[i].match(/(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})/);
      if (timeMatch) {
        const startMs = parseInt(timeMatch[1]) * 3600000 + parseInt(timeMatch[2]) * 60000 + parseInt(timeMatch[3]) * 1000 + parseInt(timeMatch[4]);
        const endMs = parseInt(timeMatch[5]) * 3600000 + parseInt(timeMatch[6]) * 60000 + parseInt(timeMatch[7]) * 1000 + parseInt(timeMatch[8]);
        i++;
        let text = '';
        while (i < lines.length && lines[i].trim() !== '') {
          text += lines[i] + '\n';
          i++;
        }
        cueTimestamps.push({ start: startMs, end: endMs, text: text.trim() });
      } else {
        i++;
      }
    }

    cueCount = cueTimestamps.length;

    if (cueCount > 0) {
      firstCueMs = cueTimestamps[0].start;
      lastCueMs = cueTimestamps[cueTimestamps.length - 1].end;
      durationMs = lastCueMs - firstCueMs;

      // Heuristic 1: Cue count vs duration mismatch
      // A 2-minute video shouldn't have 500 cues
      if (durationMs !== null) {
        const durationMin = durationMs / 60000;
        const cuesPerMin = cueCount / Math.max(1, durationMin);
        if (cuesPerMin > 30) {
          probability += 0.3;
          reasons.push(`High cue density: ${cuesPerMin.toFixed(0)} cues/min (suspicious for ${durationMin.toFixed(1)}min content)`);
        }
        if (cuesPerMin < 0.5 && durationMin > 5) {
          probability += 0.2;
          reasons.push(`Very low cue density: ${cuesPerMin.toFixed(1)} cues/min for ${durationMin.toFixed(1)}min content`);
        }
      }

      // Heuristic 2: First cue starts very late
      if (firstCueMs !== null && firstCueMs > 600000) { // > 10 minutes
        probability += 0.15;
        reasons.push(`First cue starts at ${(firstCueMs/60000).toFixed(1)}min — unusually late`);
      }

      // Heuristic 3: Language mismatch from filename
      const fileName = srtPath.split('/').pop() || '';
      const langMatch = fileName.match(/\.([a-z]{2,3})\.srt$/i);
      if (langMatch) {
        languageHint = langMatch[1].toLowerCase();
        // Check if content has non-Latin characters when filename suggests Latin language
        const latinLangs = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'no', 'da', 'fi', 'pl', 'cs', 'sk', 'hu', 'ro', 'tr'];
        if (latinLangs.includes(languageHint)) {
          const allText = cueTimestamps.map(c => c.text).join(' ');
          const nonLatinCount = (allText.match(/[^\x00-\x7F\u00C0-\u024F\s\d.,!?;:'"()-]/g) || []).length;
          if (nonLatinCount > allText.length * 0.1) {
            hasNonLatinChars = true;
            probability += 0.4;
            reasons.push(`Filename suggests ${languageHint} but content has ${nonLatinCount} non-Latin characters`);
          }
        }
      }

      // Heuristic 4: Average cue text length anomaly
      const totalTextLen = cueTimestamps.reduce((sum, c) => sum + c.text.length, 0);
      avgCueLength = cueCount > 0 ? totalTextLen / cueCount : 0;
      if (avgCueLength > 200) {
        probability += 0.1;
        reasons.push(`Unusually long cues (avg ${avgCueLength.toFixed(0)} chars)`);
      }
      if (avgCueLength < 5 && cueCount > 10) {
        probability += 0.15;
        reasons.push(`Suspiciously short cues (avg ${avgCueLength.toFixed(0)} chars) — possible binary/encoded content`);
      }

      // Heuristic 5: Check for common subtitle patterns
      const sampleText = cueTimestamps.slice(0, Math.min(10, cueTimestamps.length)).map(c => c.text).join(' ');
      const hasDialogMarkers = /[-–—]/.test(sampleText) || /^[A-Z]+:/.test(sampleText);
      const hasMusicMarkers = /[♪♫#]/.test(sampleText) || /\[.*\]/.test(sampleText);
      if (!hasDialogMarkers && !hasMusicMarkers && cueCount > 5) {
        probability += 0.05;
        reasons.push('No dialog or music markers found in first 10 cues');
      }
    } else {
      probability = 0.8;
      reasons.push('No parseable cues found');
    }

    // Heuristic 6: Video duration check (if video path provided)
    if (videoPath) {
      try {
        const videoStats = statSync(videoPath);
        // Can't get video duration from stat, but we can check if file exists
        // For actual duration we'd need ffprobe — skip for now
      } catch {
        // Video file not accessible
      }
    }
  } catch {
    probability = 0.9;
    reasons.push('Could not read subtitle file');
  }

  return {
    isSuspicious: probability >= 0.5,
    probability: Math.min(1, probability),
    reasons,
    metrics: {
      cueCount,
      firstCueMs,
      lastCueMs,
      durationMs,
      hasNonLatinChars,
      languageHint,
      avgCueLength,
    },
  };
}
