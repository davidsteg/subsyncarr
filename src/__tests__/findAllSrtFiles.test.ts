import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findAllSrtFiles } from '../findAllSrtFiles';
import { findMatchingVideoFile } from '../findMatchingVideoFile';
import { SubsyncarrPlusDatabase } from '../database';

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHi\n';

describe('findAllSrtFiles', () => {
  let root: string;
  let db: SubsyncarrPlusDatabase;
  const savedFormat = process.env.SUBTITLE_FORMAT;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'subsyncarr-scan-'));
    db = new SubsyncarrPlusDatabase(join(root, 'db', 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    if (savedFormat === undefined) delete process.env.SUBTITLE_FORMAT;
    else process.env.SUBTITLE_FORMAT = savedFormat;
  });

  it('follows symlinked directories and excludes only whole path components', async () => {
    const media = join(root, 'media');
    const real = join(root, 'elsewhere', 'Movie');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'Movie.en.srt'), SRT);
    mkdirSync(media);
    symlinkSync(real, join(media, 'Movie'));
    mkdirSync(join(media, 'Download'));
    writeFileSync(join(media, 'Download', 'x.srt'), SRT);
    mkdirSync(join(media, 'Downloads2'));
    writeFileSync(join(media, 'Downloads2', 'y.srt'), SRT);

    const { files } = await findAllSrtFiles({ includePaths: [media], excludePaths: [join(media, 'Download')] }, db);
    expect(files.sort()).toEqual([join(media, 'Downloads2', 'y.srt'), join(media, 'Movie', 'Movie.en.srt')]);
  });

  it('uses the sync cache in standard mode too', async () => {
    process.env.SUBTITLE_FORMAT = 'standard';
    const p = join(root, 'Movie.en.srt');
    writeFileSync(p, SRT);
    const s = statSync(p);
    db.addFileToSyncCache(p, s.mtimeMs, s.size);
    const { files } = await findAllSrtFiles({ includePaths: [root], excludePaths: [] }, db);
    expect(files).toEqual([]);
  });

  it('skips parked files until they change', async () => {
    const p = join(root, 'Movie.en.forced.srt');
    writeFileSync(p, SRT);
    const s = statSync(p);
    db.parkFile(p, s.mtimeMs, s.size, 'forced_not_fitting');
    expect((await findAllSrtFiles({ includePaths: [root], excludePaths: [] }, db)).files).toEqual([]);

    writeFileSync(p, SRT + '\n2\n00:00:03,000 --> 00:00:04,000\nNew\n');
    expect((await findAllSrtFiles({ includePaths: [root], excludePaths: [] }, db)).files).toEqual([p]);
  });
});

describe('findMatchingVideoFile', () => {
  it('matches .m4v and .ts videos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subsyncarr-video-'));
    try {
      writeFileSync(join(dir, 'Movie.m4v'), '');
      writeFileSync(join(dir, 'Show.S01E01.ts'), '');
      expect(findMatchingVideoFile(join(dir, 'Movie.en.forced.srt'))).toBe(join(dir, 'Movie.m4v'));
      expect(findMatchingVideoFile(join(dir, 'Show.S01E01.de.srt'))).toBe(join(dir, 'Show.S01E01.ts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
