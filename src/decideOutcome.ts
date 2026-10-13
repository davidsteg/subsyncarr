/**
 * Pure decision logic for whether a subtitle should be kept, struck, or deleted.
 * No I/O, no side effects — fully testable.
 *
 * Decision matrix:
 * - 0 alignments, at least one engine judged the shift too large → not_fitting (strike)
 * - 0 alignments, engines only errored/timed out/were skipped → failed (no strike:
 *   a crash or timeout says nothing about whether the subtitle fits)
 * - 1 alignment: only one engine produced output → keep (need both to agree on delete)
 * - 2 alignments, within threshold: engines agree → keep
 * - 2 alignments, beyond threshold: engines disagree → not_fitting (strike)
 */

export type Outcome = 'keep' | 'not_fitting' | 'failed';

export interface Alignment {
  engine: string;
  shiftMs: number;
}

/**
 * @param mismatchReports how many engines ran and rejected the result as a
 *   too-large shift (evidence the subtitle belongs to a different cut).
 *   Defaults to 1 so callers that don't track it keep the old behavior.
 */
export function decideOutcome(alignments: Alignment[], agreementThresholdMs: number, mismatchReports = 1): Outcome {
  if (alignments.length === 0) {
    return mismatchReports > 0 ? 'not_fitting' : 'failed';
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
