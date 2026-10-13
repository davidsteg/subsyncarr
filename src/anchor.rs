//! Anchor-based alignment planning: group subtitles by their matched video,
//! pick one "anchor" per video (synced against the video), and align the rest
//! sub-to-sub against the synced anchor — milliseconds instead of a full
//! audio decode per file. Pure logic, unit-tested.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct VideoGroup {
    pub video_path: Option<PathBuf>,
    pub files: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnchorPlan {
    pub anchor: PathBuf,
    pub followers: Vec<PathBuf>,
    pub full_pipeline: Vec<PathBuf>,
}

/// Forced-subtitle detection. Bazarr writes `Movie.en.forced.srt`, but Plex,
/// Jellyfin and hand-named files also use `Movie.forced.en.srt`,
/// `Movie.en.forced.default.srt`, or `foreign` instead of `forced`. Any of the
/// last three dot-separated tags before the extension counts; the title
/// further left is ignored, so `The.Forced.Marriage.2020.en.srt` is not forced.
pub fn is_forced_subtitle(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let segments: Vec<&str> = name.split('.').collect();
    if segments.len() < 3 {
        return false;
    }
    let tags = &segments[1..segments.len() - 1];
    tags[tags.len().saturating_sub(3)..]
        .iter()
        .any(|t| t.eq_ignore_ascii_case("forced") || t.eq_ignore_ascii_case("foreign"))
}

/// Group by matched video, keeping order of first appearance.
pub fn group_by_video(files: &[PathBuf], resolve: impl Fn(&Path) -> Option<PathBuf>) -> Vec<VideoGroup> {
    let mut index: HashMap<Option<PathBuf>, usize> = HashMap::new();
    let mut groups: Vec<VideoGroup> = Vec::new();
    for f in files {
        let video = resolve(f);
        let i = *index.entry(video.clone()).or_insert_with(|| {
            groups.push(VideoGroup { video_path: video, files: Vec::new() });
            groups.len() - 1
        });
        groups[i].files.push(f.clone());
    }
    groups
}

/// Largest non-forced subtitle becomes the anchor (size is a cheap proxy for
/// cue density). `None` when the fast path can't apply: no video, a single
/// file, or only forced subs (sparse cues must never anchor).
pub fn plan_anchor(group: &VideoGroup, size_of: impl Fn(&Path) -> u64) -> Option<AnchorPlan> {
    if group.video_path.is_none() || group.files.len() < 2 {
        return None;
    }
    let mut anchor: Option<(&PathBuf, u64)> = None;
    for c in group.files.iter().filter(|f| !is_forced_subtitle(f)) {
        let s = size_of(c);
        if anchor.map_or(true, |(_, best)| s > best) {
            anchor = Some((c, s));
        }
    }
    let anchor = anchor?.0.clone();
    let mut followers = Vec::new();
    let mut full_pipeline = Vec::new();
    for f in &group.files {
        if *f == anchor {
            continue;
        }
        if is_forced_subtitle(f) {
            full_pipeline.push(f.clone());
        } else {
            followers.push(f.clone());
        }
    }
    Some(AnchorPlan { anchor, followers, full_pipeline })
}

/// Safety net for mislabeled sparse subs: tiny cue counts (absolute or
/// relative to the anchor) take the full video pipeline.
pub fn is_too_sparse_for_fast_path(follower_cues: usize, anchor_cues: usize) -> bool {
    follower_cues < 25 || (anchor_cues > 0 && (follower_cues as f64) < anchor_cues as f64 * 0.2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn forced_detection() {
        assert!(is_forced_subtitle(&p("/m/Movie.en.forced.srt")));
        assert!(is_forced_subtitle(&p("/m/Movie.EN.FORCED.srt")));
        assert!(!is_forced_subtitle(&p("/m/Movie.en.srt")));
        assert!(!is_forced_subtitle(&p("/m/forced/Movie.en.srt")));
        assert!(is_forced_subtitle(&p("/m/Movie.forced.en.srt")));
        assert!(is_forced_subtitle(&p("/m/Movie.en.forced.default.srt")));
        assert!(is_forced_subtitle(&p("/m/Movie.en.foreign.srt")));
        assert!(!is_forced_subtitle(&p("/m/The.Forced.Marriage.2020.en.srt")));
        assert!(!is_forced_subtitle(&p("/m/forced.srt")));
    }

    #[test]
    fn groups_keep_order() {
        let files = vec![p("/a/x.en.srt"), p("/b/y.en.srt"), p("/a/x.de.srt"), p("/c/z.srt")];
        let groups = group_by_video(&files, |f| {
            let s = f.to_string_lossy();
            if s.starts_with("/a") {
                Some(p("/a/x.mkv"))
            } else if s.starts_with("/b") {
                Some(p("/b/y.mkv"))
            } else {
                None
            }
        });
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].files, vec![p("/a/x.en.srt"), p("/a/x.de.srt")]);
        assert_eq!(groups[2].video_path, None);
    }

    #[test]
    fn plan_picks_largest_non_forced() {
        let g = VideoGroup {
            video_path: Some(p("/a/x.mkv")),
            files: vec![p("/a/x.en.srt"), p("/a/x.de.srt"), p("/a/x.en.forced.srt")],
        };
        let plan = plan_anchor(&g, |f| match f.to_string_lossy().as_ref() {
            "/a/x.en.srt" => 100,
            "/a/x.de.srt" => 300,
            _ => 9999,
        })
        .unwrap();
        assert_eq!(plan.anchor, p("/a/x.de.srt"));
        assert_eq!(plan.followers, vec![p("/a/x.en.srt")]);
        assert_eq!(plan.full_pipeline, vec![p("/a/x.en.forced.srt")]);
    }

    #[test]
    fn plan_none_cases() {
        let single = VideoGroup { video_path: Some(p("/v.mkv")), files: vec![p("/v.srt")] };
        assert!(plan_anchor(&single, |_| 1).is_none());
        let no_video = VideoGroup { video_path: None, files: vec![p("/a.srt"), p("/b.srt")] };
        assert!(plan_anchor(&no_video, |_| 1).is_none());
        let all_forced =
            VideoGroup { video_path: Some(p("/v.mkv")), files: vec![p("/v.en.forced.srt"), p("/v.de.forced.srt")] };
        assert!(plan_anchor(&all_forced, |_| 1).is_none());
    }

    #[test]
    fn sparse() {
        assert!(is_too_sparse_for_fast_path(10, 0));
        assert!(is_too_sparse_for_fast_path(100, 1000));
        assert!(!is_too_sparse_for_fast_path(300, 1000));
        assert!(!is_too_sparse_for_fast_path(30, 0));
    }
}
