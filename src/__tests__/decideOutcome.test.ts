import { decideOutcome, Alignment } from '../decideOutcome';

describe('decideOutcome', () => {
  const threshold = 5000; // 5 seconds

  it('returns not_fitting when no alignments', () => {
    expect(decideOutcome([], threshold)).toBe('not_fitting');
  });

  it('returns keep when only one alignment', () => {
    const alignments: Alignment[] = [{ engine: 'alass', shiftMs: 1000 }];
    expect(decideOutcome(alignments, threshold)).toBe('keep');
  });

  it('returns keep when engines agree (within threshold)', () => {
    const alignments: Alignment[] = [
      { engine: 'alass', shiftMs: 1000 },
      { engine: 'ffsubsync', shiftMs: 2000 },
    ];
    expect(decideOutcome(alignments, threshold)).toBe('keep');
  });

  it('returns keep when engines agree exactly', () => {
    const alignments: Alignment[] = [
      { engine: 'alass', shiftMs: 1500 },
      { engine: 'ffsubsync', shiftMs: 1500 },
    ];
    expect(decideOutcome(alignments, threshold)).toBe('keep');
  });

  it('returns not_fitting when engines disagree (beyond threshold)', () => {
    const alignments: Alignment[] = [
      { engine: 'alass', shiftMs: 1000 },
      { engine: 'ffsubsync', shiftMs: 8000 },
    ];
    expect(decideOutcome(alignments, threshold)).toBe('not_fitting');
  });

  it('returns keep at exact threshold boundary', () => {
    const alignments: Alignment[] = [
      { engine: 'alass', shiftMs: 0 },
      { engine: 'ffsubsync', shiftMs: 5000 },
    ];
    expect(decideOutcome(alignments, threshold)).toBe('keep');
  });

  it('returns not_fitting just beyond threshold', () => {
    const alignments: Alignment[] = [
      { engine: 'alass', shiftMs: 0 },
      { engine: 'ffsubsync', shiftMs: 5001 },
    ];
    expect(decideOutcome(alignments, threshold)).toBe('not_fitting');
  });

  it('handles negative shifts', () => {
    const alignments: Alignment[] = [
      { engine: 'alass', shiftMs: -1000 },
      { engine: 'ffsubsync', shiftMs: 1000 },
    ];
    expect(decideOutcome(alignments, threshold)).toBe('keep');
  });

  it('handles large negative disagreement', () => {
    const alignments: Alignment[] = [
      { engine: 'alass', shiftMs: -5000 },
      { engine: 'ffsubsync', shiftMs: 5000 },
    ];
    expect(decideOutcome(alignments, threshold)).toBe('not_fitting');
  });
});
