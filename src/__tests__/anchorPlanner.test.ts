import { isForcedSubtitle } from '../anchorPlanner';

describe('isForcedSubtitle', () => {
  it.each([
    '/tv/Show/Show.S01E01.en.forced.srt',
    '/movies/Movie (2020)/Movie (2020).forced.en.srt',
    '/movies/Movie/Movie.en.forced.default.srt',
    '/movies/Movie/Movie.de.FORCED.srt',
    '/movies/Movie/Movie.en.foreign.srt',
    '/movies/Movie/Movie.forced.srt',
  ])('detects %s as forced', (p) => {
    expect(isForcedSubtitle(p)).toBe(true);
  });

  it.each([
    '/movies/Movie/Movie.en.srt',
    '/movies/Movie/Movie.en.sdh.srt',
    '/movies/Forced Entry/Forced.Entry.1975.en.srt',
    '/movies/The.Forced.Marriage.2020.en.hi.srt',
  ])('does not treat %s as forced', (p) => {
    expect(isForcedSubtitle(p)).toBe(false);
  });
});
