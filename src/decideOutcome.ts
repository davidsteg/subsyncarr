/**
 * Pure decision logic for whether a subtitle should be kept, struck, or deleted.
 * No I/O, no side effects — fully testable.
 *
 * Decision matrix:
 * - 0 alignments: neither engine could sync → not_fitting (strike)
 * - 1 alignment: only one engine produced output → keep (need both to agree on delete)
 * - 2 alignments, within threshold: engines agree → keep
 * - 2 alignments, beyond threshold: engines disagree → not_fitting (strike)
 */

export type Outcome = 'keep' | 'not_fitting';

export interface Alignment {
  engine: string;
  shiftMs: number;
}

export function decideOutcome(alignments: Alignment[], agreementThresholdMs: number): Outcome {
  if (alignments.length === 0) {
    return 'not_fitting';
  }

  if (alignments.length === 1) {
    return 'keep';
  }

  // Both engines produced output — compare shifts
  const [first, second] = alignments;
  const disagreementMs = Math.abs(first.shiftMs - second.shiftMs);

  if (disagreementMs <= agreementThresholdMs) {
    return 'keep';
  }

  return 'not_fitting';
}
