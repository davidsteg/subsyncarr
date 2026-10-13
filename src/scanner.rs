//! Library scan: a parallel directory walk followed by a parallel sync-status
//! check. Runs on blocking threads (it is all filesystem I/O); network
//! storage benefits most from the parallelism.
//!
//! Sync status comes from the `synced_files` cache (path + mtime + size),
//! loaded into memory once per scan. A cached file is fully read only once —
//! to confirm it has cues and no legacy `# synced:` header — and is then
//! marked verified, so steady-state scans read no subtitle content.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rayon::prelude::*;
use tracing::info;

use crate::config::{ScanConfig, KNOWN_ENGINES};
use crate::db::SyncCacheEntry;
use crate::models::ScanProgress;
use crate::srt;

/// Internal temp files an interrupted run can leave behind. Only one run
/// happens at a time and the scan precedes any processing, so anything
/// matching these during a scan is an orphan.
const TEMP_PATTERNS: [&str; 4] = [".alass-tmp.", ".ffsubsync-tmp.", ".subsyncarr_retry.", ".anchor-ref."];

#[derive(Default, Debug)]
pub struct ScanResult {
    pub files: Vec<PathBuf>,
    pub total_found: usize,
    pub already_synced: usize,
    pub parked: usize,
    pub orphans_removed: usize,
    pub corrupt_removed: usize,
    pub legacy_headers_stripped: usize,
    /// (path, mtime_ms, size) to upsert into the sync cache as verified.
    pub cache_upserts: Vec<(String, f64, i64)>,
    pub cache_removals: Vec<String>,
    pub cancelled: bool,
}

pub struct ScanOptions<'a> {
    pub dry_run: bool,
    pub threads: usize,
    pub cache: &'a HashMap<String, SyncCacheEntry>,
    pub parked: &'a HashMap<String, (f64, i64)>,
    pub cancel: &'a AtomicBool,
    pub progress: &'a (dyn Fn(ScanProgress) + Sync),
}

/// Node-compatible `mtimeMs` (sec * 1e3 + nsec / 1e6) so cache rows written
/// by 1.x keep matching.
pub fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    let t = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6
}

fn is_engine_output(name: &str) -> bool {
    KNOWN_ENGINES.iter().any(|e| name.contains(&format!(".{e}.")))
}

fn is_orphan_temp(name: &str) -> bool {
    TEMP_PATTERNS.iter().any(|p| name.contains(p))
}

fn remove_orphan(path: &Path, label: &str, dry_run: bool) -> bool {
    if dry_run {
        info!("[DRY RUN] Would delete {label}: {}", path.display());
        return false;
    }
    match std::fs::remove_file(path) {
        Ok(()) => {
            info!("Deleted {label}: {}", path.display());
            true
        }
        Err(e) => {
            info!("Failed to delete {label} {}: {e}", path.display());
            false
        }
    }
}

struct Walker<'a> {
    excludes: &'a [PathBuf],
    dry_run: bool,
    cancel: &'a AtomicBool,
    /// (dev, inode) of every directory walked — symlinked directories are
    /// followed, so this guards against loops and double counting.
    visited: Mutex<HashSet<(u64, u64)>>,
    srts: Mutex<Vec<PathBuf>>,
    orphans: AtomicUsize,
}

impl Walker<'_> {
    fn excluded(&self, dir: &Path) -> bool {
        // Whole path components: /media/Download doesn't exclude /media/Downloads2.
        self.excludes.iter().any(|ex| dir.starts_with(ex))
    }

    fn walk_dir(&self, dir: &Path) {
        if self.cancel.load(Ordering::Relaxed) || self.excluded(dir) {
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let Ok(meta) = std::fs::metadata(dir) else {
                return;
            };
            if !self.visited.lock().unwrap().insert((meta.dev(), meta.ino())) {
                return;
            }
        }
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        let mut subdirs = Vec::new();
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(mut ft) = entry.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                // Follow it (debrid/rclone/shared-storage setups); skip dangling links.
                match std::fs::metadata(&path) {
                    Ok(m) => ft = m.file_type(),
                    Err(_) => continue,
                }
            }
            if ft.is_dir() {
                subdirs.push(path);
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".srt.bak") {
                self.orphans
                    .fetch_add(remove_orphan(&path, "orphaned backup file", self.dry_run) as usize, Ordering::Relaxed);
                continue;
            }
            if !name.to_lowercase().ends_with(".srt") {
                continue;
            }
            if is_orphan_temp(&name) {
                self.orphans
                    .fetch_add(remove_orphan(&path, "orphaned temp file", self.dry_run) as usize, Ordering::Relaxed);
                continue;
            }
            if is_engine_output(&name) {
                continue;
            }
            self.srts.lock().unwrap().push(path);
        }
        subdirs.par_iter().for_each(|d| self.walk_dir(d));
    }
}

enum Check {
    NeedsSync,
    Synced,
    Parked,
    Gone,
}

pub fn scan(config: &ScanConfig, opts: &ScanOptions) -> ScanResult {
    let pool = rayon::ThreadPoolBuilder::new().num_threads(opts.threads).build().expect("scan pool");
    let walker = Walker {
        excludes: &config.exclude_paths,
        dry_run: opts.dry_run,
        cancel: opts.cancel,
        visited: Mutex::new(HashSet::new()),
        srts: Mutex::new(Vec::new()),
        orphans: AtomicUsize::new(0),
    };
    pool.install(|| config.include_paths.par_iter().for_each(|root| walker.walk_dir(root)));
    let mut srts = walker.srts.into_inner().unwrap();
    srts.sort();
    srts.dedup();
    let orphans_removed = walker.orphans.into_inner();
    let total = srts.len();
    info!("Found {total} SRT files in directory walk, checking sync status...");

    let checked = AtomicUsize::new(0);
    let need = AtomicUsize::new(0);
    let synced = AtomicUsize::new(0);
    let parked = AtomicUsize::new(0);
    let corrupt = AtomicUsize::new(0);
    let stripped = AtomicUsize::new(0);
    let upserts = Mutex::new(Vec::new());
    let removals = Mutex::new(Vec::new());

    let check = |path: &PathBuf| -> Check {
        let key = path.to_string_lossy().into_owned();
        let Ok(meta) = std::fs::metadata(path) else {
            return Check::Gone;
        };
        let (mtime, size) = (mtime_ms(&meta), meta.len() as i64);
        // Parked: a forced sub that repeatedly didn't fit and is kept as is.
        // Skipped until the file changes instead of re-decoding the video.
        if opts.parked.get(&key).is_some_and(|(m, s)| (m - mtime).abs() < 0.001 && *s == size) {
            return Check::Parked;
        }
        let cached = opts.cache.get(&key).filter(|e| e.matches(mtime, size));
        let (is_synced, verified) = match cached {
            Some(e) => (true, e.cues_verified),
            None => (srt::file_has_legacy_header(path), false),
        };
        if !is_synced {
            return Check::NeedsSync;
        }
        if verified {
            return Check::Synced;
        }
        // First sight of this synced file since 2.0: read it once.
        let Ok(content) = std::fs::read(path) else {
            return Check::NeedsSync;
        };
        if !srt::has_cues(&content) {
            // A past run installed empty/unparseable output under the sync
            // marker; it reads as synced forever while media servers reject
            // it. Delete so the subtitle manager resupplies it.
            if opts.dry_run {
                info!("[DRY RUN] Would delete corrupted synced subtitle (0 cues): {}", path.display());
            } else if std::fs::remove_file(path).is_ok() {
                corrupt.fetch_add(1, Ordering::Relaxed);
                removals.lock().unwrap().push(key);
                info!("Deleted corrupted synced subtitle (0 cues): {}", path.display());
            }
            return Check::Gone;
        }
        if let Some(body) = srt::strip_legacy_header(&content) {
            if opts.dry_run || std::fs::write(path, body).is_err() {
                return Check::Synced;
            }
            stripped.fetch_add(1, Ordering::Relaxed);
            info!("Stripped legacy sync header from: {}", path.display());
            if let Ok(m) = std::fs::metadata(path) {
                upserts.lock().unwrap().push((key, mtime_ms(&m), m.len() as i64));
            }
        } else {
            upserts.lock().unwrap().push((key, mtime, size));
        }
        Check::Synced
    };

    let results: Vec<Check> = pool.install(|| {
        srts.par_iter()
            .map(|p| {
                if opts.cancel.load(Ordering::Relaxed) {
                    return Check::Gone;
                }
                let r = check(p);
                match r {
                    Check::NeedsSync => need.fetch_add(1, Ordering::Relaxed),
                    Check::Synced => synced.fetch_add(1, Ordering::Relaxed),
                    Check::Parked => {
                        parked.fetch_add(1, Ordering::Relaxed);
                        synced.fetch_add(1, Ordering::Relaxed)
                    }
                    Check::Gone => 0,
                };
                let n = checked.fetch_add(1, Ordering::Relaxed) + 1;
                if n % 1000 == 0 || n == total {
                    (opts.progress)(ScanProgress {
                        checked: n,
                        total,
                        need_sync: need.load(Ordering::Relaxed),
                        already_synced: synced.load(Ordering::Relaxed),
                    });
                }
                if n % 10_000 == 0 {
                    info!(
                        "Scan progress: {n}/{total} checked, {} need sync, {} already synced",
                        need.load(Ordering::Relaxed),
                        synced.load(Ordering::Relaxed)
                    );
                }
                r
            })
            .collect()
    });

    let cancelled = opts.cancel.load(Ordering::Relaxed);
    let files: Vec<PathBuf> = if cancelled {
        Vec::new()
    } else {
        srts.into_iter().zip(results).filter_map(|(p, r)| matches!(r, Check::NeedsSync).then_some(p)).collect()
    };
    let res = ScanResult {
        files,
        total_found: total,
        already_synced: synced.into_inner(),
        parked: parked.into_inner(),
        orphans_removed,
        corrupt_removed: corrupt.into_inner(),
        legacy_headers_stripped: stripped.into_inner(),
        cache_upserts: upserts.into_inner().unwrap(),
        cache_removals: removals.into_inner().unwrap(),
        cancelled,
    };
    let extra = |n: usize, what: &str| {
        if n > 0 {
            format!(", {n} {what}")
        } else {
            String::new()
        }
    };
    info!(
        "Scan complete: {} SRT files found, {} need sync, {} already synced{}{}{}{}",
        res.total_found,
        res.files.len(),
        res.already_synced,
        extra(res.parked, "parked forced subtitle(s)"),
        extra(res.orphans_removed, "orphaned temp file(s) removed"),
        extra(res.corrupt_removed, "corrupted synced subtitle(s) removed"),
        extra(res.legacy_headers_stripped, "legacy sync header(s) stripped"),
    );
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const GOOD: &[u8] = b"1\n00:00:01,000 --> 00:00:02,000\nhi\n";

    fn run(
        cfg: &ScanConfig,
        cache: &HashMap<String, SyncCacheEntry>,
        parked: &HashMap<String, (f64, i64)>,
    ) -> ScanResult {
        let cancel = AtomicBool::new(false);
        let progress = |_p: ScanProgress| {};
        scan(cfg, &ScanOptions { dry_run: false, threads: 4, cache, parked, cancel: &cancel, progress: &progress })
    }

    fn entry(path: &Path, verified: bool) -> SyncCacheEntry {
        let meta = fs::metadata(path).unwrap();
        SyncCacheEntry { mtime_ms: Some(mtime_ms(&meta)), size_bytes: Some(meta.len() as i64), cues_verified: verified }
    }

    #[test]
    fn classifies_and_repairs() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let s1 = root.join("show/s1");
        fs::create_dir_all(&s1).unwrap();
        fs::create_dir_all(root.join("Download")).unwrap();
        fs::create_dir_all(root.join("Downloads2")).unwrap();
        fs::write(s1.join("e1.en.srt"), GOOD).unwrap(); // needs sync
        fs::write(s1.join("e2.en.srt"), [b"# synced:alass 1\n".as_ref(), GOOD].concat()).unwrap(); // legacy
        fs::write(s1.join("e3.en.srt"), b"# synced:alass 1\n").unwrap(); // corrupt
        fs::write(s1.join(".e4.en.alass-tmp.srt"), GOOD).unwrap(); // orphan
        fs::write(s1.join(".e4.en.srt.bak"), GOOD).unwrap(); // orphan
        fs::write(s1.join("e5.en.ffsubsync.srt"), GOOD).unwrap(); // engine output, ignored
        fs::write(s1.join("e6.en.srt"), GOOD).unwrap(); // cached, unverified
        fs::write(s1.join("e7.en.srt"), GOOD).unwrap(); // cached, verified
        fs::write(s1.join("e8.en.forced.srt"), GOOD).unwrap(); // parked
        fs::write(root.join("Download/x.srt"), GOOD).unwrap(); // excluded
        fs::write(root.join("Downloads2/y.srt"), GOOD).unwrap(); // NOT excluded

        let mut cache = HashMap::new();
        cache.insert(s1.join("e6.en.srt").to_string_lossy().into_owned(), entry(&s1.join("e6.en.srt"), false));
        cache.insert(s1.join("e7.en.srt").to_string_lossy().into_owned(), entry(&s1.join("e7.en.srt"), true));
        let mut parked = HashMap::new();
        let e8 = entry(&s1.join("e8.en.forced.srt"), true);
        parked.insert(
            s1.join("e8.en.forced.srt").to_string_lossy().into_owned(),
            (e8.mtime_ms.unwrap(), e8.size_bytes.unwrap()),
        );

        let cfg = ScanConfig { include_paths: vec![root.to_path_buf()], exclude_paths: vec![root.join("Download")] };
        let r = run(&cfg, &cache, &parked);

        assert_eq!(r.files, vec![root.join("Downloads2/y.srt"), s1.join("e1.en.srt")]);
        assert_eq!(r.orphans_removed, 2);
        assert_eq!(r.corrupt_removed, 1);
        assert_eq!(r.legacy_headers_stripped, 1);
        assert_eq!(r.parked, 1);
        assert_eq!(r.already_synced, 4); // e2, e6, e7, e8
        assert_eq!(fs::read(s1.join("e2.en.srt")).unwrap(), GOOD);
        assert!(!s1.join("e3.en.srt").exists());
        assert_eq!(r.cache_upserts.len(), 2); // e2 after strip, e6 verified
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinks_without_looping() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().join("lib");
        let real = d.path().join("real");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("m.srt"), GOOD).unwrap();
        std::os::unix::fs::symlink(&real, root.join("linked")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        std::os::unix::fs::symlink(real.join("m.srt"), root.join("file-link.srt")).unwrap();
        std::os::unix::fs::symlink(d.path().join("missing"), root.join("dangling")).unwrap();
        let cfg = ScanConfig { include_paths: vec![root.clone()], exclude_paths: vec![] };
        let r = run(&cfg, &HashMap::new(), &HashMap::new());
        assert_eq!(r.files, vec![root.join("file-link.srt"), root.join("linked/m.srt")]);
    }
}
