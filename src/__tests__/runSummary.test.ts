import { RunSummary, classifyEngineFailure, failureCategory, formatAttempts, failureDetail } from '../runSummary';

describe('runSummary', () => {
  it('classifies engine failures', () => {
    expect(classifyEngineFailure({ shiftTooLarge: true, message: 'Shift too large' })).toBe('shift');
    expect(classifyEngineFailure({ message: 'Timeout: alass took longer than allowed timeout' })).toBe('timeout');
    expect(classifyEngineFailure({ skipped: true, message: 'Skipped — 3+ consecutive failures' })).toBe('skipped');
    expect(classifyEngineFailure({ message: 'alass produced empty or unparseable output for x.srt' })).toBe(
      'no_output',
    );
    expect(classifyEngineFailure({ message: 'Error processing x.srt: boom' })).toBe('error');
  });

  it('picks the failure category', () => {
    expect(
      failureCategory([
        { engine: 'alass', status: 'skipped' },
        { engine: 'ffsubsync', status: 'skipped' },
      ]),
    ).toBe('failed_engines_skipped');
    expect(
      failureCategory([
        { engine: 'alass', status: 'timeout' },
        { engine: 'ffsubsync', status: 'error' },
      ]),
    ).toBe('failed_timeout');
    expect(failureCategory([{ engine: 'alass', status: 'error' }])).toBe('failed_error');
  });

  it('prefers the last stderr line as failure detail', () => {
    expect(failureDetail('Error processing x', 'Traceback...\nValueError: no audio stream\n')).toBe(
      'ValueError: no audio stream',
    );
    expect(failureDetail('Error processing x', '')).toBe('Error processing x');
  });

  it('formats attempts', () => {
    expect(
      formatAttempts([
        { engine: 'alass', status: 'ok', shiftMs: 1200 },
        { engine: 'ffsubsync', status: 'timeout', detail: 'after 600s' },
      ]),
    ).toBe('alass ✓ +1200ms, ffsubsync ✗ timeout (after 600s)');
  });

  it('counts categories and lists problem files only', () => {
    const s = new RunSummary();
    s.setScan({ found: 10, needSync: 3, alreadySynced: 7, parked: 1 });
    s.record('synced', '/m/a.srt');
    s.record('no_video', '/m/b.srt');
    s.record('failed_timeout', '/m/c.srt', 'alass ✗ timeout');
    const text = s.format().join('\n');
    expect(text).toContain('10 subtitle(s) found, 3 needed sync, 7 already synced (incl. 1 parked');
    expect(text).toMatch(/1 {2}synced \(both engines agree\)/);
    expect(text).toContain('/m/b.srt');
    expect(text).toContain('/m/c.srt — alass ✗ timeout');
    expect(text).not.toContain('/m/a.srt');
    expect(s.finish().counts).toEqual({ synced: 1, no_video: 1, failed_timeout: 1 });
  });
});
