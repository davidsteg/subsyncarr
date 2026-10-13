import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProcessingEngine } from '../processingEngine';
import { StateManager } from '../stateManager';

// Fake alass/ffsubsync: shift every timestamp by $FAKE_<ENGINE>_SHIFT_MS, or
// exit 1 when it is "fail". Each call's argv is appended to $FAKE_ARGS_LOG.
const FAKE_ENGINE = `#!/usr/bin/env python3
import os, re, sys
name = os.path.basename(sys.argv[0])
args = sys.argv[1:]
with open(os.environ['FAKE_ARGS_LOG'], 'a') as f:
    f.write(name + '\\t' + '\\t'.join(args) + '\\n')
mode = os.environ.get('FAKE_' + name.upper() + '_SHIFT_MS', '0')
if mode == 'fail':
    sys.exit(1)
if name == 'alass':
    pos = [a for a in args if not a.startswith('--')]
    inp, out = pos[1], pos[2]
else:
    inp, out = args[args.index('-i') + 1], args[args.index('-o') + 1]
shift = int(mode)
def sh(m):
    h, mi, s, ms = map(int, m.groups())
    t = max(0, ((h * 60 + mi) * 60 + s) * 1000 + ms + shift)
    return '%02d:%02d:%02d,%03d' % (t // 3600000, t // 60000 % 60, t // 1000 % 60, t % 1000)
data = open(inp, 'rb').read().decode('latin-1')
first_only = os.environ.get('FAKE_FIRST_CUE_ONLY') == '1'
out_data = re.sub(r'(\\d{2}):(\\d{2}):(\\d{2}),(\\d{3})', sh, data, count=2 if first_only else 0)
open(out, 'wb').write(out_data.encode('latin-1'))
`;

function srt(n: number, text = 'Line'): string {
  const cues: string[] = [];
  for (let i = 1; i <= n; i++) {
    const s = 10 + i * 5;
    cues.push(
      `${i}\n00:00:${String(s % 60).padStart(2, '0')},000 --> 00:00:${String(s % 60).padStart(2, '0')},900\n${text} ${i}`,
    );
  }
  return cues.join('\n\n') + '\n';
}

describe('ProcessingEngine outcomes', () => {
  let root: string;
  let media: string;
  let state: StateManager;
  let argsLog: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'subsyncarr-engine-'));
    media = join(root, 'media');
    mkdirSync(media);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    for (const name of ['alass', 'ffsubsync']) {
      writeFileSync(join(bin, name), FAKE_ENGINE);
      chmodSync(join(bin, name), 0o755);
    }
    argsLog = join(root, 'args.log');
    writeFileSync(argsLog, '');
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.FAKE_ARGS_LOG = argsLog;
    process.env.DEFAULT_ENGINE = 'alass';
    process.env.FALLBACK_ENGINE = 'ffsubsync';
    process.env.SUBTITLE_FORMAT = 'overwrite';
    process.env.NOT_FITTING_DELETE_THRESHOLD = '3';
    state = new StateManager(join(root, 'data', 'test.db'));
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    state.close();
    rmSync(root, { recursive: true, force: true });
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  let logs: string[] = [];

  async function run(): Promise<ProcessingEngine> {
    const engine = new ProcessingEngine();
    engine.stateManager = state;
    logs = [];
    engine.on('log', (m: string) => logs.push(m));
    await engine.processRun({ includePaths: [media], excludePaths: [] });
    return engine;
  }

  it('syncs a file whose name contains shell metacharacters', async () => {
    const dir = join(media, 'Ca$h `Movie` "Quote"');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Ca$h.mkv'), '');
    const sub = join(dir, 'Ca$h.en.srt');
    writeFileSync(sub, srt(30));
    process.env.FAKE_ALASS_SHIFT_MS = '1000';
    process.env.FAKE_FFSUBSYNC_SHIFT_MS = '1200';
    await run();
    expect(readFileSync(sub, 'utf8')).toContain('00:00:16,000 --> 00:00:16,900');
  });

  it('judges the shift by the median cue, not by a single moved first cue', async () => {
    writeFileSync(join(media, 'Movie.mkv'), '');
    const sub = join(media, 'Movie.en.srt');
    writeFileSync(sub, srt(30));
    // Both engines move only the first cue by 60s (beyond the 30s limit).
    process.env.FAKE_FIRST_CUE_ONLY = '1';
    process.env.FAKE_ALASS_SHIFT_MS = '60000';
    process.env.FAKE_FFSUBSYNC_SHIFT_MS = '60000';
    await run();
    expect(readFileSync(sub, 'utf8')).toMatch(/^1\n00:01:15,000 --> 00:01:15,900/);
  });

  it('never deletes a subtitle when the engines only crash or time out', async () => {
    writeFileSync(join(media, 'Movie.mkv'), '');
    const sub = join(media, 'Movie.en.srt');
    const latin1 = Buffer.from(srt(30, 'Grüße'), 'latin1');
    writeFileSync(sub, latin1);
    process.env.FAKE_ALASS_SHIFT_MS = 'fail';
    process.env.FAKE_FFSUBSYNC_SHIFT_MS = 'fail';
    for (let i = 0; i < 4; i++) await run();
    expect(existsSync(sub)).toBe(true);
    // Original bytes restored untouched — no UTF-8 round-trip mangling.
    expect(readFileSync(sub).equals(latin1)).toBe(true);
    expect(state.getDatabase().getNotFittingStrikes(sub)).toBe(0);
  });

  it('logs a decision line per file and a run summary with reasons', async () => {
    writeFileSync(join(media, 'Movie.mkv'), '');
    writeFileSync(join(media, 'Movie.en.srt'), srt(30));
    writeFileSync(join(media, 'Orphan.en.srt'), srt(30));
    process.env.FAKE_ALASS_SHIFT_MS = '1000';
    process.env.FAKE_FFSUBSYNC_SHIFT_MS = 'fail';
    const engine = await run();
    const text = logs.join('\n');
    expect(text).toMatch(/▶ synced_single_engine: Movie\.en\.srt \| alass ✓ \+1000ms, ffsubsync ✗ error/);
    expect(text).toMatch(/▶ no_video: Orphan\.en\.srt/);
    expect(text).toContain('Effective config: format=overwrite');
    expect(text).toContain('===== Run summary =====');
    expect(engine.lastRunSummary?.counts).toEqual({ synced_single_engine: 1, no_video: 1 });
    expect(JSON.parse(state.getDatabase().getSetting('last_run_summary')!).counts.no_video).toBe(1);
    expect(state.getDatabase().getDiagnostics().totals).toEqual({ strikes: 0, skippedEngines: 0, parked: 0 });
  });

  it('still deletes a regular subtitle after repeated disagreement', async () => {
    writeFileSync(join(media, 'Movie.mkv'), '');
    const sub = join(media, 'Movie.en.srt');
    writeFileSync(sub, srt(30));
    process.env.FAKE_ALASS_SHIFT_MS = '0';
    process.env.FAKE_FFSUBSYNC_SHIFT_MS = '20000';
    for (let i = 0; i < 3; i++) await run();
    expect(existsSync(sub)).toBe(false);
  });

  it('keeps forced subs, runs alass without splits, and parks them at the threshold', async () => {
    writeFileSync(join(media, 'Movie.mkv'), '');
    const sub = join(media, 'Movie.en.forced.srt');
    const original = srt(4);
    writeFileSync(sub, original);
    process.env.FAKE_ALASS_SHIFT_MS = '0';
    process.env.FAKE_FFSUBSYNC_SHIFT_MS = '20000';
    for (let i = 0; i < 3; i++) await run();
    expect(readFileSync(sub, 'utf8')).toBe(original);
    expect(readFileSync(argsLog, 'utf8')).toMatch(/^alass\t--no-split\t/m);

    // Parked: a fourth run must not invoke the engines again.
    writeFileSync(argsLog, '');
    await run();
    expect(readFileSync(argsLog, 'utf8')).toBe('');
  });

  it('gives a replaced subtitle at the same path a fresh strike count', async () => {
    writeFileSync(join(media, 'Movie.mkv'), '');
    const sub = join(media, 'Movie.en.srt');
    writeFileSync(sub, srt(30));
    process.env.FAKE_ALASS_SHIFT_MS = '0';
    process.env.FAKE_FFSUBSYNC_SHIFT_MS = '20000';
    await run();
    await run();
    expect(state.getDatabase().getNotFittingStrikes(sub)).toBe(2);

    // Bazarr drops in a different subtitle at the same path.
    writeFileSync(sub, srt(31));
    await run();
    expect(existsSync(sub)).toBe(true);
    expect(state.getDatabase().getNotFittingStrikes(sub)).toBe(1);
  });
});
