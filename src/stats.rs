//! Path classification for the statistics history: what kind of media a
//! subtitle belongs to, which show or movie, and which library. Pure
//! functions, so a stored row never needs the file system to be grouped.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

static EPISODE_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(^|[^a-z0-9])(s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{2,3})([^0-9]|$)").unwrap());
static SEASON_DIR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(season|series|staffel|saison|temporada)[ ._-]*\d+$|^s\d{1,2}$|^specials$").unwrap()
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaInfo {
    /// `episode` or `movie`.
    pub kind: &'static str,
    /// Show folder for episodes, movie folder for movies.
    pub title: Option<String>,
    pub language: Option<&'static str>,
    pub forced: bool,
}

fn dir_name(p: &Path) -> Option<String> {
    p.file_name().map(|n| n.to_string_lossy().into_owned())
}

pub fn classify(path: &str) -> MediaInfo {
    let p = Path::new(path);
    let file = dir_name(p).unwrap_or_default();
    let parent = p.parent();
    let parent_name = parent.and_then(dir_name);
    let in_season_dir = parent_name.as_deref().is_some_and(|n| SEASON_DIR.is_match(n));
    let episode = in_season_dir || EPISODE_NAME.is_match(&file);
    let title = if in_season_dir { parent.and_then(Path::parent).and_then(dir_name) } else { parent_name };
    MediaInfo {
        kind: if episode { "episode" } else { "movie" },
        title: title.filter(|t| !t.is_empty()),
        language: crate::db::language_of(path),
        forced: crate::anchor::is_forced_subtitle(p),
    }
}

/// The scan path a subtitle lives under (the longest match), for the
/// per-library breakdown.
pub fn library_of(path: &str, roots: &[PathBuf]) -> Option<String> {
    roots
        .iter()
        .filter(|r| Path::new(path).starts_with(r))
        .max_by_key(|r| r.as_os_str().len())
        .map(|r| r.display().to_string())
}

/// Nearest-rank percentile of an ascending slice.
pub fn percentile(sorted: &[i64], p: f64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episodes_by_name_or_season_folder() {
        let e = classify("/media/TV/The Office (US)/Season 02/The Office - S02E03 - Office Olympics.en.srt");
        assert_eq!(e.kind, "episode");
        assert_eq!(e.title.as_deref(), Some("The Office (US)"));
        assert_eq!(e.language, Some("English"));
        assert!(!e.forced);

        let e = classify("/media/TV/Show/Show.1x05.de.forced.srt");
        assert_eq!(e.kind, "episode");
        assert_eq!(e.title.as_deref(), Some("Show"));
        assert!(e.forced);

        let e = classify("/media/TV/Show/Specials/Pilot.srt");
        assert_eq!((e.kind, e.title.as_deref()), ("episode", Some("Show")));
    }

    #[test]
    fn movies_take_their_folder() {
        let m = classify("/media/Movies/Heat (1995)/Heat (1995).fr.srt");
        assert_eq!(m.kind, "movie");
        assert_eq!(m.title.as_deref(), Some("Heat (1995)"));
        assert_eq!(m.language, Some("French"));
        // A resolution or year is not an episode marker.
        assert_eq!(classify("/m/1917 (2019)/1917.2019.1080p.x264.srt").kind, "movie");
    }

    #[test]
    fn library_is_the_longest_root() {
        let roots = vec![PathBuf::from("/media"), PathBuf::from("/media/TV")];
        assert_eq!(library_of("/media/TV/a/b.srt", &roots).as_deref(), Some("/media/TV"));
        assert_eq!(library_of("/media/Movies/a.srt", &roots).as_deref(), Some("/media"));
        assert_eq!(library_of("/other/a.srt", &roots), None);
        // Whole components only.
        assert_eq!(library_of("/media/TV Shows/a.srt", &[PathBuf::from("/media/TV")]), None);
    }

    #[test]
    fn nearest_rank_percentiles() {
        let v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        assert_eq!(percentile(&v, 50.0), Some(5));
        assert_eq!(percentile(&v, 90.0), Some(9));
        assert_eq!(percentile(&v, 100.0), Some(10));
        assert_eq!(percentile(&v, 0.0), Some(1));
        assert_eq!(percentile(&[], 50.0), None);
    }
}
