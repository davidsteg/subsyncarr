// Per-run tally of what happened to every subtitle and why. Logged at the end
// of each run (so the run log answers "why wasn't X synced?" without reading
// thousands of lines) and persisted for the /api/diagnostics endpoint.
// Kept free of fs/engine dependencies so it can be unit-tested.

export type FileCategory =
  | 'synced'
  | 'synced_single_engine'
  | 'not_fitting_disagree'
  | 'not_fitting_shift'
  | 'deleted'
  | 'forced_kept'
  | 'forced_parked'
  | 'failed_timeout'
  | 'failed_error'
  | 'failed_engines_skipped'
  | 'no_video'
  | 'cancelled';

const LABELS: Record<FileCategory, string> = {
  synced: 'synced (both engines agree)',
  synced_single_engine: 'synced (only one engine produced output)',
  not_fitting_disagree: 'not fitting: engines disagree (strike)',
  not_fitting_shift: 'not fitting: shift too large (strike)',
  deleted: 'deleted after repeated not-fitting strikes',
  forced_kept: 'forced sub not fitting, kept unchanged',
  forced_parked: 'forced sub parked until the file changes',
  failed_timeout: 'failed: engine timeout (no strike)',
  failed_error: 'failed: engine error (no strike)',
  failed_engines_skipped: 'failed: all engines skipped after 3+ failures',
  no_video: 'no matching video file',
  cancelled: 'cancelled',
};

/** Categories worth listing file-by-file in the summary. */
const PROBLEM_CATEGORIES: FileCategory[] = [
  'deleted',
  'not_fitting_disagree',
  'not_fitting_shift',
  'forced_kept',
  'forced_parked',
  'failed_timeout',
  'failed_error',
  'failed_engines_skipped',
  'no_video',
];

const MAX_SAMPLES = 25;

export interface EngineAttempt {
  engine: string;
  /** 'ok' | 'shift' | 'timeout' | 'skipped' | 'no_output' | 'error' */
  status: string;
  shiftMs?: number;
  detail?: string;
}

/** Classify a failed engine result into a short, greppable reason. */
export function classifyEngineFailure(result: {
  message?: string;
  skipped?: boolean;
  shiftTooLarge?: boolean;
}): string {
  const msg = result.message ?? '';
  if (result.shiftTooLarge) return 'shift';
  if (result.skipped) return 'skipped';
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (/no parseable|did not produce|produced no output|empty or unparseable/i.test(msg)) return 'no_output';
  return 'error';
}

/**
 * Short failure detail for logs: the engine's last stderr line (what actually
 * went wrong) when there is one, else the wrapper's message.
 */
export function failureDetail(message: string, stderr?: string): string {
  const lastLine = (stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return (lastLine || message).slice(0, 200);
}

/** Category for a run where no engine produced an alignment and none reported a mismatch. */
export function failureCategory(attempts: EngineAttempt[]): FileCategory {
  if (attempts.length > 0 && attempts.every((a) => a.status === 'skipped')) return 'failed_engines_skipped';
  if (attempts.some((a) => a.status === 'timeout')) return 'failed_timeout';
  return 'failed_error';
}

/** One-line rendering of the engine attempts, e.g. "alass ✓ +1200ms, ffsubsync ✗ timeout". */
export function formatAttempts(attempts: EngineAttempt[]): string {
  if (attempts.length === 0) return '';
  return attempts
    .map((a) => {
      if (a.status === 'ok')
        return `${a.engine} ✓ ${a.shiftMs !== undefined && a.shiftMs >= 0 ? '+' : ''}${a.shiftMs}ms`;
      const extra = a.detail ? ` (${a.detail})` : '';
      return `${a.engine} ✗ ${a.status}${extra}`;
    })
    .join(', ');
}

export interface RunSummaryJson {
  startedAt: number;
  finishedAt: number | null;
  dryRun: boolean;
  scan: { found: number; needSync: number; alreadySynced: number; parked: number };
  counts: Partial<Record<FileCategory, number>>;
  samples: Partial<Record<FileCategory, string[]>>;
}

export class RunSummary {
  private data: RunSummaryJson;

  constructor(dryRun = false) {
    this.data = {
      startedAt: Date.now(),
      finishedAt: null,
      dryRun,
      scan: { found: 0, needSync: 0, alreadySynced: 0, parked: 0 },
      counts: {},
      samples: {},
    };
  }

  setScan(scan: RunSummaryJson['scan']): void {
    this.data.scan = scan;
  }

  record(category: FileCategory, filePath: string, detail?: string): void {
    this.data.counts[category] = (this.data.counts[category] ?? 0) + 1;
    if (PROBLEM_CATEGORIES.includes(category)) {
      const list = (this.data.samples[category] ??= []);
      if (list.length < MAX_SAMPLES) list.push(detail ? `${filePath} — ${detail}` : filePath);
    }
  }

  count(category: FileCategory): number {
    return this.data.counts[category] ?? 0;
  }

  finish(): RunSummaryJson {
    this.data.finishedAt = Date.now();
    return this.toJSON();
  }

  toJSON(): RunSummaryJson {
    return JSON.parse(JSON.stringify(this.data));
  }

  /** Human-readable block for the run log. */
  format(): string[] {
    const { scan, counts, samples } = this.data;
    const lines: string[] = [];
    lines.push('===== Run summary =====');
    lines.push(
      `Scan: ${scan.found} subtitle(s) found, ${scan.needSync} needed sync, ${scan.alreadySynced} already synced` +
        (scan.parked > 0 ? ` (incl. ${scan.parked} parked forced sub(s))` : ''),
    );
    const order = Object.keys(LABELS) as FileCategory[];
    const nonZero = order.filter((c) => (counts[c] ?? 0) > 0);
    if (nonZero.length === 0) {
      lines.push('No subtitles were processed.');
    }
    for (const c of nonZero) {
      lines.push(`  ${String(counts[c]).padStart(6)}  ${LABELS[c]}`);
    }
    for (const c of PROBLEM_CATEGORIES) {
      const list = samples[c];
      if (!list || list.length === 0) continue;
      const total = counts[c] ?? list.length;
      lines.push(`-- ${LABELS[c]} (${total}${total > list.length ? `, first ${list.length} shown` : ''}):`);
      for (const p of list) lines.push(`   ${p}`);
    }
    lines.push('=======================');
    return lines;
  }
}
