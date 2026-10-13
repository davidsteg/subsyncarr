//! SRT parsing helpers: cue timing, cue counting, offset estimation and the
//! legacy `# synced:` header that 1.x wrote at the top of synced files.
//!
//! Everything here works on raw bytes / lossy UTF-8 so non-UTF-8 subtitles
//! (Latin-1, CP1252 — common for older releases) are never re-encoded: the
//! engine pipeline restores and writes files byte-for-byte.

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::LazyLock;

use regex::bytes::Regex as BytesRegex;
use regex::Regex;

/// Header line 1.x prepended to every synced file. Invalid SRT (files must
/// start with a cue number) — it broke ffprobe/Jellyfin. Only detected and
/// stripped now; never written.
pub const LEGACY_SYNC_MARKER: &[u8] = b"# synced:";

static FIRST_CUE: LazyLock<BytesRegex> =
    LazyLock::new(|| BytesRegex::new(r"(?m)^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->").unwrap());
static ANY_CUE: LazyLock<BytesRegex> = LazyLock::new(|| BytesRegex::new(r"\d{2}:\d{2}:\d{2},\d{3}\s*-->").unwrap());
static TIMING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})").unwrap());
static BLOCK_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n").unwrap());

fn ms(h: &[u8], m: &[u8], s: &[u8], f: &[u8]) -> i64 {
    let n = |b: &[u8]| -> i64 { std::str::from_utf8(b).ok().and_then(|x| x.parse().ok()).unwrap_or(0) };
    n(h) * 3_600_000 + n(m) * 60_000 + n(s) * 1000 + n(f)
}

/// Start time (ms) of the first cue, or `None` when nothing parses.
pub fn first_cue_ms(content: &[u8]) -> Option<i64> {
    let c = FIRST_CUE.captures(content)?;
    Some(ms(&c[1], &c[2], &c[3], &c[4]))
}

pub fn first_cue_ms_file(path: &Path) -> Option<i64> {
    std::fs::read(path).ok().and_then(|b| first_cue_ms(&b))
}

/// Cheap cue count: number of `-->` timing arrows.
pub fn count_cues(content: &[u8]) -> usize {
    memchr_count(content, b"-->")
}

fn memchr_count(hay: &[u8], needle: &[u8]) -> usize {
    hay.windows(needle.len()).filter(|w| *w == needle).count()
}

/// True when the content has at least one parseable timing line.
pub fn has_cues(content: &[u8]) -> bool {
    ANY_CUE.is_match(content)
}

pub fn has_legacy_header(content: &[u8]) -> bool {
    content.starts_with(LEGACY_SYNC_MARKER)
}

/// Read only the first bytes of a file and check for the legacy header.
pub fn file_has_legacy_header(path: &Path) -> bool {
    let mut buf = [0u8; 16];
    match File::open(path).and_then(|mut f| f.read(&mut buf)) {
        Ok(n) => has_legacy_header(&buf[..n]),
        Err(_) => false,
    }
}

/// Content with the legacy header line removed, or `None` when absent.
pub fn strip_legacy_header(content: &[u8]) -> Option<&[u8]> {
    if !has_legacy_header(content) {
        return None;
    }
    let nl = content.iter().position(|&b| b == b'\n')?;
    Some(&content[nl + 1..])
}

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    start_ms: i64,
}

fn parse_entries(content: &str) -> Vec<Entry> {
    // A UTF-8 BOM in front of the first cue number would make that cue fail
    // to parse and shift the positional pairing by one.
    let cleaned: String = content
        .trim_start_matches('\u{feff}')
        .replace('\r', "")
        .lines()
        .filter(|l| !l.starts_with("# synced:"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = Vec::new();
    for block in BLOCK_SPLIT.split(cleaned.trim()) {
        let mut lines = block.trim().lines();
        let (Some(idx), Some(timing)) = (lines.next(), lines.next()) else {
            continue;
        };
        if idx.trim().parse::<i64>().is_err() {
            continue;
        }
        let Some(c) = TIMING.captures(timing) else {
            continue;
        };
        let b = |i: usize| c[i].as_bytes();
        out.push(Entry { start_ms: ms(b(1), b(2), b(3), b(4)) });
    }
    out
}

fn median(values: &mut [i64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_unstable();
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        values[mid] as f64
    } else {
        (values[mid - 1] + values[mid]) as f64 / 2.0
    }
}

/// Median start-time shift (ms) between original and synced content, matching
/// cues by position. Positive = synced is later. 0 when either side is empty.
pub fn subtitle_offset_ms(original: &[u8], synced: &[u8]) -> i64 {
    let a = parse_entries(&String::from_utf8_lossy(original));
    let b = parse_entries(&String::from_utf8_lossy(synced));
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let mut offsets: Vec<i64> = a
        .iter()
        .zip(b.iter())
        .filter(|(x, y)| x.start_ms > 0 || y.start_ms > 0)
        .map(|(x, y)| y.start_ms - x.start_ms)
        .collect();
    median(&mut offsets).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIG: &str = "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n\n3\n00:00:05,500 --> 00:00:06,000\n!\n";
    const SHIFTED: &str = "1\n00:00:03,000 --> 00:00:04,000\nHello\n\n2\n00:00:05,000 --> 00:00:06,000\nWorld\n\n3\n00:00:07,500 --> 00:00:08,000\n!\n";

    #[test]
    fn first_cue() {
        assert_eq!(first_cue_ms(ORIG.as_bytes()), Some(1000));
        assert_eq!(first_cue_ms(b"garbage"), None);
        assert_eq!(first_cue_ms(b"1\n01:02:03,004 --> 01:02:04,000\nx"), Some(3_723_004));
    }

    #[test]
    fn counts_cues() {
        assert_eq!(count_cues(ORIG.as_bytes()), 3);
        assert_eq!(count_cues(b""), 0);
        assert!(has_cues(ORIG.as_bytes()));
        assert!(!has_cues(b"# synced:alass 123\n"));
    }

    #[test]
    fn offset_positive_and_negative() {
        assert_eq!(subtitle_offset_ms(ORIG.as_bytes(), SHIFTED.as_bytes()), 2000);
        assert_eq!(subtitle_offset_ms(SHIFTED.as_bytes(), ORIG.as_bytes()), -2000);
        assert_eq!(subtitle_offset_ms(ORIG.as_bytes(), ORIG.as_bytes()), 0);
    }

    #[test]
    fn offset_empty_is_zero() {
        assert_eq!(subtitle_offset_ms(b"", SHIFTED.as_bytes()), 0);
        assert_eq!(subtitle_offset_ms(ORIG.as_bytes(), b"nothing"), 0);
    }

    #[test]
    fn offset_handles_crlf_and_header() {
        let crlf = SHIFTED.replace('\n', "\r\n");
        let with_header = format!("# synced:alass 1\n{ORIG}");
        assert_eq!(subtitle_offset_ms(with_header.as_bytes(), crlf.as_bytes()), 2000);
    }

    #[test]
    fn offset_median_even() {
        let a = "1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:02,000 --> 00:00:03,000\nb\n";
        let b = "1\n00:00:02,000 --> 00:00:03,000\na\n\n2\n00:00:04,000 --> 00:00:05,000\nb\n";
        assert_eq!(subtitle_offset_ms(a.as_bytes(), b.as_bytes()), 1500);
    }

    #[test]
    fn offset_ignores_bom() {
        let bom = format!("\u{feff}{ORIG}");
        assert_eq!(subtitle_offset_ms(bom.as_bytes(), SHIFTED.as_bytes()), 2000);
    }

    #[test]
    fn legacy_header() {
        let with = b"# synced:alass 123\n1\n00:00:01,000 --> 00:00:02,000\nx\n";
        assert!(has_legacy_header(with));
        assert_eq!(strip_legacy_header(with).unwrap(), b"1\n00:00:01,000 --> 00:00:02,000\nx\n");
        assert!(strip_legacy_header(ORIG.as_bytes()).is_none());
    }

    #[test]
    fn non_utf8_survives() {
        let latin1: Vec<u8> = b"1\n00:00:01,000 --> 00:00:02,000\ncaf\xe9\n".to_vec();
        assert_eq!(first_cue_ms(&latin1), Some(1000));
        assert_eq!(count_cues(&latin1), 1);
    }
}
