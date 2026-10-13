//! Matching a subtitle to its video: exact base name first, then progressively
//! dropping dot-separated tags (`Movie.en.sdh.srt` → `Movie.en.sdh`, `Movie.en`,
//! `Movie`). Directory listings are cached per run so a season folder with 40
//! subtitles is read once, not 40 times.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Containers ffmpeg (and so alass/ffsubsync) can decode.
pub const VIDEO_EXTENSIONS: [&str; 11] =
    ["mkv", "mp4", "avi", "mov", "m4v", "ts", "m2ts", "webm", "wmv", "mpg", "mpeg"];

type DirMap = Arc<HashMap<String, PathBuf>>;

#[derive(Default)]
pub struct DirectoryCache {
    dirs: Mutex<HashMap<PathBuf, DirMap>>,
}

impl DirectoryCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn dir_map(&self, dir: &Path) -> DirMap {
        if let Some(m) = self.dirs.lock().unwrap().get(dir) {
            return m.clone();
        }
        let mut map = HashMap::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for entry in rd.flatten() {
                let is_file = match entry.file_type() {
                    Ok(t) if t.is_file() => true,
                    Ok(t) if t.is_symlink() => std::fs::metadata(entry.path()).map(|m| m.is_file()).unwrap_or(false),
                    _ => false,
                };
                if is_file {
                    map.insert(entry.file_name().to_string_lossy().to_lowercase(), entry.path());
                }
            }
        }
        let map = Arc::new(map);
        self.dirs.lock().unwrap().insert(dir.to_path_buf(), map.clone());
        map
    }

    /// Case-insensitive lookup returning the on-disk path.
    pub fn get(&self, dir: &Path, file_name: &str) -> Option<PathBuf> {
        self.dir_map(dir).get(&file_name.to_lowercase()).cloned()
    }
}

/// File name without a trailing `.srt` (case-insensitive).
pub fn srt_stem(srt: &Path) -> String {
    let name = srt.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if name.len() > 4 && name[name.len() - 4..].eq_ignore_ascii_case(".srt") {
        name[..name.len() - 4].to_string()
    } else {
        name
    }
}

pub fn find_matching_video(srt: &Path, cache: &DirectoryCache) -> Option<PathBuf> {
    let dir = srt.parent()?;
    let stem = srt_stem(srt);
    let mut segments: Vec<&str> = stem.split('.').collect();
    loop {
        let base = segments.join(".");
        for ext in VIDEO_EXTENSIONS {
            if let Some(p) = cache.get(dir, &format!("{base}.{ext}")) {
                return Some(p);
            }
        }
        if segments.len() <= 1 {
            return None;
        }
        segments.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn matches_exact_and_progressive() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("Movie (2020).MKV"), b"").unwrap();
        fs::write(d.path().join("Show.S01E01.mp4"), b"").unwrap();
        let cache = DirectoryCache::new();
        assert_eq!(
            find_matching_video(&d.path().join("Movie (2020).en.forced.srt"), &cache),
            Some(d.path().join("Movie (2020).MKV"))
        );
        assert_eq!(
            find_matching_video(&d.path().join("Show.S01E01.srt"), &cache),
            Some(d.path().join("Show.S01E01.mp4"))
        );
        assert_eq!(find_matching_video(&d.path().join("Other.en.srt"), &cache), None);
    }

    #[test]
    fn stem() {
        assert_eq!(srt_stem(Path::new("/a/b.en.SRT")), "b.en");
        assert_eq!(srt_stem(Path::new("/a/b.en.srt")), "b.en");
    }
}
