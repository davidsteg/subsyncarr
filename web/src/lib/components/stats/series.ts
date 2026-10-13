import type { ClassCounts } from '../../types';

export type ClassKey = 'synced' | 'notFitting' | 'parked' | 'deleted' | 'failed' | 'noVideo';

export interface Series {
  key: ClassKey;
  label: string;
  /** CSS color, theme-aware via custom properties. */
  color: string;
  hint: string;
}

/** Outcome classes in stacking order, bottom to top. */
export const OUTCOMES: Series[] = [
  { key: 'synced', label: 'Synced', color: 'var(--ok)', hint: 'Kept: engines agree, one engine only, or already in sync' },
  { key: 'notFitting', label: 'Not fitting', color: 'var(--warn)', hint: 'Subtitle restored; a strike unless only one engine objected' },
  { key: 'parked', label: 'Parked', color: 'var(--info)', hint: 'Forced subtitle at the strike threshold' },
  { key: 'deleted', label: 'Deleted', color: 'var(--err)', hint: 'Deleted at the strike threshold' },
  { key: 'failed', label: 'Failed', color: 'var(--accent)', hint: 'Engines crashed, timed out or were skipped (no strike)' },
  { key: 'noVideo', label: 'No video', color: 'var(--text-3)', hint: 'No matching video next to the subtitle' },
];

export function classValue(c: ClassCounts, key: ClassKey): number {
  return c[key] ?? 0;
}

/** Fixed categorical slot per engine, so a color always means the same engine. */
const ENGINE_SLOTS: Record<string, number> = { alass: 1, ffsubsync: 2, autosubsync: 3 };

export function engineColor(engine: string): string {
  return `var(--series-${ENGINE_SLOTS[engine] ?? 3})`;
}

export const RESULT_KINDS = [
  { key: 'ok', label: 'Aligned', color: 'var(--ok)' },
  { key: 'shift', label: 'Shift too large', color: 'var(--warn)' },
  { key: 'timeout', label: 'Timeout', color: 'var(--err)' },
  { key: 'error', label: 'Error', color: 'var(--accent)' },
  { key: 'no_output', label: 'No output', color: 'var(--info)' },
  { key: 'skipped', label: 'Skipped', color: 'var(--text-3)' },
] as const;

export const REFERENCE_LABELS: Record<string, string> = {
  audio: 'Audio',
  embedded: 'Embedded track',
  anchor: 'Anchor subtitle',
  unknown: 'Not recorded',
  none: 'No video',
};

/** "+1.5 s", "−20 s", "0 s" — compact signed seconds for axes and tables. */
export function shortSeconds(ms: number | null | undefined, signed = true): string {
  if (ms === null || ms === undefined) return '—';
  const s = ms / 1000;
  const abs = Math.abs(s);
  const v = abs >= 10 ? abs.toFixed(0) : abs >= 1 ? abs.toFixed(1) : abs.toFixed(2);
  const sign = s < 0 ? '−' : signed && s > 0 ? '+' : '';
  return `${sign}${v.replace(/\.0+$|(\.\d*[1-9])0+$/, '$1')} s`;
}
