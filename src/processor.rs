//! Run orchestration: scan → group by video → sync each subtitle with the
//! two-engine agreement check → keep, strike or delete. Owns the run
//! lifecycle (start / stop / per-file skip) and reports progress to the DB
//! and the live event bus.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use futures_util::stream::{self, StreamExt};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use tracing::{error, info};

use crate::anchor::{self, VideoGroup};
use crate::config::{Config, ScanConfig};
use crate::db::{Db, FileUpdate, RunCounter};
use crate::decide::{decide_outcome, Alignment, Outcome};
use crate::engines::{self, sidecar_path, EngineRun};
use crate::events::{Event, EventBus};
use crate::models::{EngineResult, FileStatus, Run, ScanProgress, SyncMode};
use crate::runlog::RunLogs;
use crate::scanner::{self, mtime_ms, ScanOptions};
use crate::settings::Settings;
use crate::srt;
use crate::video::{find_matching_video, srt_stem, DirectoryCache};

/// Engines whose reference argument may be a subtitle instead of a video.
const SRT_REFERENCE_CAPABLE: [&str; 2] = ["alass", "ffsubsync"];

#[derive(Debug)]
pub enum RunError {
    AlreadyRunning,
    NotRunning,
    Db(String),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::AlreadyRunning => write!(f, "A run is already in progress"),
            RunError::NotRunning => write!(f, "No run is currently in progress"),
            RunError::Db(e) => write!(f, "database error: {e}"),
        }
    }
}

pub struct ActiveRun {
    pub id: String,
    pub dry_run: bool,
    stop: CancellationToken,
    stop_flag: AtomicBool,
    cancelled_files: Mutex<HashSet<PathBuf>>,
    file_tokens: Mutex<HashMap<PathBuf, CancellationToken>>,
    scan_progress: Mutex<Option<ScanProgress>>,
    marked_cancelled: AtomicBool,
}

impl ActiveRun {
    fn stopped(&self) -> bool {
        self.stop.is_cancelled()
    }

    fn is_cancelled(&self, path: &Path) -> bool {
        self.stopped() || self.cancelled_files.lock().unwrap().contains(path)
    }
}

struct RunCtx {
    run: Arc<ActiveRun>,
    settings: Settings,
    dir_cache: DirectoryCache,
}

#[derive(Clone, Copy, PartialEq)]
enum FileOutcomeKind {
    Completed,
    Other,
}

struct FileOutcome {
    kind: FileOutcomeKind,
    synced_content: Option<Vec<u8>>,
    status_label: &'static str,
}

impl FileOutcome {
    fn other(label: &'static str) -> Self {
        FileOutcome { kind: FileOutcomeKind::Other, synced_content: None, status_label: label }
    }
}

#[derive(Clone)]
struct FileCtx {
    mode: SyncMode,
    video: Option<PathBuf>,
    reference: Option<PathBuf>,
    anchor: Option<PathBuf>,
    anchor_cues: usize,
}

pub struct Processor {
    db: Db,
    cfg: Arc<Config>,
    settings: Arc<RwLock<Settings>>,
    events: EventBus,
    runlogs: RunLogs,
    current: Mutex<Option<Arc<ActiveRun>>>,
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn ps(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

impl Processor {
    pub fn new(
        db: Db,
        cfg: Arc<Config>,
        settings: Arc<RwLock<Settings>>,
        events: EventBus,
        runlogs: RunLogs,
    ) -> Arc<Self> {
        Arc::new(Processor { db, cfg, settings, events, runlogs, current: Mutex::new(None) })
    }

    pub fn current(&self) -> Option<Arc<ActiveRun>> {
        self.current.lock().unwrap().clone()
    }

    pub fn is_running(&self) -> bool {
        self.current.lock().unwrap().is_some()
    }

    pub fn scan_progress(&self) -> Option<ScanProgress> {
        self.current().and_then(|r| *r.scan_progress.lock().unwrap())
    }

    /// Current run as the UI should see it (None once it has been cancelled
    /// and is only winding down).
    pub async fn current_run(&self) -> Option<Run> {
        let run = self.current()?;
        if run.marked_cancelled.load(Ordering::Relaxed) {
            return None;
        }
        self.db.get_run(&run.id).await.ok().flatten()
    }

    fn log(&self, msg: impl AsRef<str>) {
        let msg = msg.as_ref();
        info!(target: "subsyncarr::run", "{msg}");
        self.runlogs.append(format!("[{}] {msg}", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ")));
    }

    // ------------------------------------------------------------ lifecycle

    pub async fn start_run(
        self: &Arc<Self>,
        paths: Option<Vec<PathBuf>>,
        dry_run: Option<bool>,
    ) -> Result<String, RunError> {
        let settings = self.settings.read().unwrap().clone();
        let dry_run = dry_run.unwrap_or(settings.dry_run);
        let id = uuid::Uuid::new_v4().to_string();
        let run = Arc::new(ActiveRun {
            id: id.clone(),
            dry_run,
            stop: CancellationToken::new(),
            stop_flag: AtomicBool::new(false),
            cancelled_files: Mutex::new(HashSet::new()),
            file_tokens: Mutex::new(HashMap::new()),
            scan_progress: Mutex::new(Some(ScanProgress::default())),
            marked_cancelled: AtomicBool::new(false),
        });
        {
            let mut cur = self.current.lock().unwrap();
            if cur.is_some() {
                return Err(RunError::AlreadyRunning);
            }
            *cur = Some(run.clone());
        }
        if let Err(e) = self.db.create_run(&id, dry_run).await {
            *self.current.lock().unwrap() = None;
            return Err(RunError::Db(e.to_string()));
        }
        self.runlogs.start(&id);
        info!(
            "Starting new processing run {id}{}",
            if dry_run { " (DRY RUN — no changes will be written)" } else { "" }
        );
        if let Ok(Some(r)) = self.db.get_run(&id).await {
            self.events.send(Event::RunStarted(r));
        }

        let scan = match paths {
            Some(p) if !p.is_empty() => ScanConfig { include_paths: p, exclude_paths: Vec::new() },
            _ => self.cfg.scan.clone(),
        };
        let this = self.clone();
        tokio::spawn(async move {
            let ctx = Arc::new(RunCtx { run: run.clone(), settings, dir_cache: DirectoryCache::new() });
            if let Err(e) = this.clone().process_run(ctx, scan).await {
                error!("Run {} failed: {e:#}", run.id);
                this.log(format!("Run failed: {e:#}"));
            }
            this.finish(&run).await;
        });
        Ok(id)
    }

    async fn finish(&self, run: &Arc<ActiveRun>) {
        if !run.marked_cancelled.load(Ordering::Relaxed) {
            let _ = self.db.finish_run(&run.id, "completed").await;
            if let Ok(Some(r)) = self.db.get_run(&run.id).await {
                info!(
                    "Run completed - Total: {}, Completed: {}, Skipped: {}, Failed: {}, Not fitting: {}",
                    r.total_files, r.completed, r.skipped, r.failed, r.not_fitting
                );
                self.events.send(Event::RunCompleted(r));
            }
        }
        self.events.send(Event::ScanProgress(None));
        self.runlogs.end();
        *self.current.lock().unwrap() = None;
    }

    pub async fn stop_run(&self) -> Result<(), RunError> {
        let run = self.current().ok_or(RunError::NotRunning)?;
        if run.marked_cancelled.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.log("Stop requested — cancelling all remaining files");
        run.stop_flag.store(true, Ordering::SeqCst);
        run.stop.cancel(); // child tokens kill every in-flight engine
        let _ = self.db.finish_run(&run.id, "cancelled").await;
        if let Ok(Some(r)) = self.db.get_run(&run.id).await {
            self.events.send(Event::RunCancelled(r));
        }
        Ok(())
    }

    pub fn skip_file(&self, path: &Path) {
        info!("Skip requested for: {}", name_of(path));
        if let Some(run) = self.current() {
            run.cancelled_files.lock().unwrap().insert(path.to_path_buf());
            if let Some(t) = run.file_tokens.lock().unwrap().get(path) {
                self.log(format!("Aborting running process for: {}", name_of(path)));
                t.cancel();
            }
        }
    }

    // ------------------------------------------------------------- the run

    async fn process_run(self: Arc<Self>, ctx: Arc<RunCtx>, scan_cfg: ScanConfig) -> anyhow::Result<()> {
        let run = ctx.run.clone();
        self.log("Scanning for subtitle files...");
        self.log(format!(
            "Scan paths: {:?}",
            scan_cfg.include_paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
        ));

        let cache = self.db.load_sync_cache().await?;
        let parked = self.db.load_parked().await?;
        let dry_run = run.dry_run;
        let threads = std::env::var("SCAN_CONCURRENCY").ok().and_then(|v| v.parse().ok()).unwrap_or(32usize).max(1);
        let scan_run = run.clone();
        let events = self.events.clone();
        let scan = tokio::task::spawn_blocking(move || {
            let last = Mutex::new(Instant::now() - Duration::from_secs(1));
            let progress = |p: ScanProgress| {
                *scan_run.scan_progress.lock().unwrap() = Some(p);
                let mut l = last.lock().unwrap();
                if l.elapsed() >= Duration::from_millis(250) || p.checked == p.total {
                    *l = Instant::now();
                    events.send(Event::ScanProgress(Some(p)));
                }
            };
            scanner::scan(
                &scan_cfg,
                &ScanOptions {
                    dry_run,
                    threads,
                    cache: &cache,
                    parked: &parked,
                    cancel: &scan_run.stop_flag,
                    progress: &progress,
                },
            )
        })
        .await?;
        *run.scan_progress.lock().unwrap() = None;
        self.events.send(Event::ScanProgress(None));

        if !scan.cache_upserts.is_empty() {
            self.db.upsert_sync_cache(&scan.cache_upserts).await?;
        }
        if !scan.cache_removals.is_empty() {
            self.db.remove_from_sync_cache(&scan.cache_removals).await?;
        }
        if scan.orphans_removed > 0 {
            self.log(format!(
                "🧹 Removed {} orphaned temp/retry file(s) left over from an interrupted run",
                scan.orphans_removed
            ));
        }
        if scan.corrupt_removed > 0 {
            self.log(format!(
                "🧹 Removed {} corrupted synced subtitle(s) (0 parseable cues) — will be resupplied by your subtitle manager",
                scan.corrupt_removed
            ));
        }
        if scan.legacy_headers_stripped > 0 {
            self.log(format!(
                "🧹 Stripped {} legacy sync header(s) — files are now valid SRT for ffprobe/Jellyfin",
                scan.legacy_headers_stripped
            ));
        }
        if run.stopped() {
            self.log("Run stopped during scan");
            return Ok(());
        }

        let files = scan.files;
        self.log(format!("Found {} subtitle files", files.len()));
        let total_engines = files.len() as i64 * self.cfg.include_engines.len() as i64;
        self.db.set_run_totals(&run.id, files.len() as i64, total_engines).await?;
        let paths: Vec<String> = files.iter().map(|p| ps(p)).collect();
        self.db.insert_pending_files(&run.id, &paths).await?;
        if let Ok(Some(r)) = self.db.get_run(&run.id).await {
            if !run.marked_cancelled.load(Ordering::Relaxed) {
                self.events.send(Event::RunStarted(r));
            }
        }

        let s = &ctx.settings;
        let concurrency = s.max_concurrent_tasks.max(1);
        self.log(format!("Processing with concurrency: {concurrency}"));
        self.log(format!("Engine chain: {} + {}", s.default_engine, s.fallback_engine));
        if dry_run {
            self.log("DRY RUN MODE — no files will be written");
        }

        let anchor_mode = s.anchor_alignment
            && SRT_REFERENCE_CAPABLE.contains(&s.default_engine.as_str())
            && SRT_REFERENCE_CAPABLE.contains(&s.fallback_engine.as_str());
        let groups: Vec<VideoGroup> = if anchor_mode {
            let c = ctx.clone();
            let files = files.clone();
            let groups = tokio::task::spawn_blocking(move || {
                anchor::group_by_video(&files, |p| find_matching_video(p, &c.dir_cache))
            })
            .await?;
            let multi = groups.iter().filter(|g| g.video_path.is_some() && g.files.len() > 1).count();
            self.log(format!(
                "Anchor alignment: {} video groups ({multi} with 2+ subs eligible for the fast path)",
                groups.len()
            ));
            groups
        } else {
            if s.anchor_alignment {
                self.log(format!(
                    "Anchor alignment inactive: engine chain {}+{} — both engines must support subtitle references (alass, ffsubsync)",
                    s.default_engine, s.fallback_engine
                ));
            }
            // One "group" per file, video resolved lazily in process_file.
            files.into_iter().map(|f| VideoGroup { video_path: None, files: vec![f] }).collect()
        };

        let total = groups.len();
        let started = std::sync::atomic::AtomicUsize::new(0);
        stream::iter(groups)
            .for_each_concurrent(concurrency, |group| {
                let this = self.clone();
                let ctx = ctx.clone();
                let n = started.fetch_add(1, Ordering::Relaxed) + 1;
                async move {
                    if ctx.run.stopped() {
                        return;
                    }
                    if anchor_mode {
                        let label = group.video_path.as_deref().map(name_of).unwrap_or_else(|| "(no video)".into());
                        this.log(format!(
                            "Starting group {n}/{total} ({} sub{}): {label}",
                            group.files.len(),
                            if group.files.len() == 1 { "" } else { "s" }
                        ));
                        this.process_group(&ctx, group).await;
                    } else {
                        let file = group.files.into_iter().next().unwrap();
                        this.log(format!("Starting file {n}/{total}: {}", name_of(&file)));
                        this.process_file(&ctx, &file, None).await;
                    }
                }
            })
            .await;

        self.log("All files processed");
        Ok(())
    }

    /// Sync the anchor against the video, then align followers sub-to-sub
    /// against the synced anchor. Forced/sparse subs — and everything when the
    /// anchor fails — take the full pipeline. Dry runs skip the fast path (it
    /// needs a temp reference file on disk).
    async fn process_group(&self, ctx: &RunCtx, group: VideoGroup) {
        let full = |video: Option<PathBuf>| FileCtx {
            mode: SyncMode::Full,
            video,
            reference: None,
            anchor: None,
            anchor_cues: 0,
        };
        let plan = if ctx.run.dry_run {
            None
        } else {
            anchor::plan_anchor(&group, |p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        };
        let Some(plan) = plan else {
            for f in &group.files {
                if ctx.run.stopped() {
                    return;
                }
                self.process_file(ctx, f, Some(full(group.video_path.clone()))).await;
            }
            return;
        };

        let anchor_ctx = FileCtx { mode: SyncMode::Anchor, ..full(group.video_path.clone()) };
        let outcome = self.process_file(ctx, &plan.anchor, Some(anchor_ctx)).await;

        let mut anchor_ref: Option<PathBuf> = None;
        let mut anchor_cues = 0;
        if let (FileOutcomeKind::Completed, Some(content)) = (outcome.kind, outcome.synced_content.as_ref()) {
            // Dot-prefixed so media servers watching the folder don't index it.
            let p = plan.anchor.with_file_name(format!(".{}.anchor-ref.srt", srt_stem(&plan.anchor)));
            match std::fs::write(&p, content) {
                Ok(()) => {
                    anchor_cues = srt::count_cues(content);
                    anchor_ref = Some(p);
                }
                Err(e) => self.log(format!("Could not write anchor reference, falling back to full pipeline: {e}")),
            }
        } else if !plan.followers.is_empty() {
            self.log(format!(
                "Anchor did not sync ({}) — {} follower(s) take the full pipeline: {}",
                outcome.status_label,
                plan.followers.len(),
                name_of(&plan.anchor)
            ));
        }

        for f in &plan.followers {
            if ctx.run.stopped() {
                break;
            }
            let fctx = match &anchor_ref {
                Some(r) => FileCtx {
                    mode: SyncMode::Follower,
                    video: group.video_path.clone(),
                    reference: Some(r.clone()),
                    anchor: Some(plan.anchor.clone()),
                    anchor_cues,
                },
                None => full(group.video_path.clone()),
            };
            self.process_file(ctx, f, Some(fctx)).await;
        }
        for f in &plan.full_pipeline {
            if ctx.run.stopped() {
                break;
            }
            self.log(format!("Forced subtitle — full pipeline: {}", name_of(f)));
            self.process_file(ctx, f, Some(full(group.video_path.clone()))).await;
        }
        if let Some(r) = anchor_ref {
            let _ = std::fs::remove_file(r);
        }
    }

    // ------------------------------------------------------- file reporting

    async fn mark(&self, ctx: &RunCtx, path: &Path, u: FileUpdate<'_>) {
        let p = ps(path);
        if let Err(e) = self.db.update_file(&ctx.run.id, &p, u).await {
            error!("DB update failed for {p}: {e}");
        }
        self.events.send(Event::FileUpdated { run_id: ctx.run.id.clone(), file_path: p });
    }

    async fn finish_file(
        &self,
        ctx: &RunCtx,
        path: &Path,
        status: FileStatus,
        counter: RunCounter,
        mode: Option<(SyncMode, Option<&Path>)>,
    ) {
        let _ = self.db.increment_run(&ctx.run.id, counter).await;
        if status == FileStatus::Completed {
            match mode.map(|m| m.0) {
                Some(SyncMode::Anchor) => {
                    let _ = self.db.increment_run(&ctx.run.id, RunCounter::AnchorsCompleted).await;
                }
                Some(SyncMode::Follower) => {
                    let _ = self.db.increment_run(&ctx.run.id, RunCounter::FollowersCompleted).await;
                }
                _ => {}
            }
        }
        let anchor_str = mode.and_then(|m| m.1).map(ps);
        self.mark(
            ctx,
            path,
            FileUpdate {
                status: Some(status),
                current_engine: Some(None),
                sync_mode: mode.map(|m| m.0),
                anchor_path: mode.map(|_| anchor_str.as_deref()),
                ..Default::default()
            },
        )
        .await;
    }

    async fn skipped(&self, ctx: &RunCtx, path: &Path, why: &str) -> FileOutcome {
        self.log(format!("Skipped ({why}): {}", name_of(path)));
        self.finish_file(ctx, path, FileStatus::Skipped, RunCounter::Skipped, None).await;
        FileOutcome::other("cancelled")
    }

    async fn engine_completed(&self, ctx: &RunCtx, path: &Path, engine: &str, r: &EngineResult) {
        let p = ps(path);
        let _ = self.db.increment_run(&ctx.run.id, RunCounter::CompletedEngines).await;
        let _ = self.db.record_run_engine_stat(&ctx.run.id, engine, r.success).await;
        let v = serde_json::to_value(r).unwrap_or(Value::Null);
        let _ = self.db.set_file_engine_result(&ctx.run.id, &p, engine, &v).await;
        if !r.skipped {
            // shiftTooLarge = subtitle doesn't match the video, not an engine failure.
            let res = if r.success || r.shift_too_large {
                self.db.record_engine_success(&p, engine).await
            } else {
                self.db.record_engine_failure(&p, engine).await
            };
            if let Err(e) = res {
                error!("failure tracking update failed: {e}");
            }
        }
        self.events.send(Event::FileUpdated { run_id: ctx.run.id.clone(), file_path: p });
    }

    // --------------------------------------------------------- one file

    async fn process_file(&self, ctx: &RunCtx, path: &Path, fctx: Option<FileCtx>) -> FileOutcome {
        if ctx.run.stopped() {
            return self.skipped(ctx, path, "run stopped").await;
        }
        if srt::file_has_legacy_header(path) {
            self.log(format!("⊘ Already synced (header): {}", name_of(path)));
            self.finish_file(ctx, path, FileStatus::Skipped, RunCounter::Skipped, None).await;
            return FileOutcome::other("skipped");
        }
        if ctx.run.is_cancelled(path) {
            return self.skipped(ctx, path, "cancelled").await;
        }
        let token = ctx.run.stop.child_token();
        ctx.run.file_tokens.lock().unwrap().insert(path.to_path_buf(), token.clone());
        let out = self.process_file_inner(ctx, path, fctx, &token).await;
        ctx.run.file_tokens.lock().unwrap().remove(path);
        out
    }

    async fn process_file_inner(
        &self,
        ctx: &RunCtx,
        path: &Path,
        fctx: Option<FileCtx>,
        token: &CancellationToken,
    ) -> FileOutcome {
        let name = name_of(path);
        let s = &ctx.settings;
        let video = match &fctx {
            Some(f) => f.video.clone(),
            None => find_matching_video(path, &ctx.dir_cache),
        };
        let mut mode = fctx.as_ref().map_or(SyncMode::Full, |f| f.mode);
        let mut anchor = if mode == SyncMode::Follower { fctx.as_ref().and_then(|f| f.anchor.clone()) } else { None };

        let video_str = video.as_deref().map(ps);
        self.mark(
            ctx,
            path,
            FileUpdate {
                status: Some(FileStatus::Processing),
                current_engine: Some(None),
                video_path: Some(video_str.as_deref()),
                ..Default::default()
            },
        )
        .await;

        let Some(video) = video else {
            self.log(format!("No matching video found for: {name}"));
            self.finish_file(ctx, path, FileStatus::Error, RunCounter::Failed, None).await;
            return FileOutcome::other("no_video");
        };

        // Raw bytes: restored byte-for-byte, never re-encoded.
        let original: Option<Vec<u8>> = std::fs::read(path).ok();
        if original.is_none() {
            self.log("Warning: Could not read original subtitle for offset calculation");
        }

        // Engine-skip, strike and park state are keyed by path. If a new
        // subtitle now sits here (Bazarr upgrade), that state belongs to the
        // old file and is reset so the new one gets a fair run.
        if let (false, Some(bytes)) = (ctx.run.dry_run, original.as_deref()) {
            let hash = sha1_smol::Sha1::from(bytes).digest().to_string();
            if let Err(e) = self.db.refresh_fingerprint(&ps(path), &hash).await {
                error!("fingerprint update failed: {e}");
            }
        }

        let mut reference = video.clone();
        if mode == SyncMode::Follower {
            if let Some(f) = fctx.as_ref().and_then(|f| f.reference.clone().map(|r| (r, f))) {
                let (ref_path, f) = f;
                let cues = original.as_deref().map(srt::count_cues).unwrap_or(0);
                if original.is_some() && anchor::is_too_sparse_for_fast_path(cues, f.anchor_cues) {
                    self.log(format!("Sparse subtitle ({cues} cues) — rerouting to full pipeline: {name}"));
                    mode = SyncMode::Full;
                    anchor = None;
                } else {
                    reference = ref_path;
                    self.log(format!(
                        "Aligning via anchor {}: {name}",
                        f.anchor.as_deref().map(name_of).unwrap_or_default()
                    ));
                }
            }
        }

        let threshold = s.engine_agreement_threshold_ms;
        let chain = [s.default_engine.clone(), s.fallback_engine.clone()];
        self.log(format!("Engine chain: {} + {} (agreement threshold: {threshold}ms)", chain[0], chain[1]));

        // Both engines align the ORIGINAL independently; then their results
        // are compared.
        let mut alignments: Vec<(String, Vec<u8>, i64)> = Vec::new();
        // Engines that ran and rejected their result as a too-large shift —
        // the only evidence besides disagreement that the subtitle doesn't fit.
        let mut mismatch_reports = 0;
        let forced = anchor::is_forced_subtitle(path);
        let no_split = forced && reference == video;
        if forced {
            self.log(format!("Forced subtitle — alass without splits: {name}"));
        }
        for engine in &chain {
            if ctx.run.is_cancelled(path) || token.is_cancelled() {
                self.restore(path, original.as_deref());
                return self.skipped(ctx, path, "cancelled").await;
            }
            if self.db.is_engine_skipped(&ps(path), engine).await.unwrap_or(false) {
                self.log(format!("⊘ Skipping {engine} (3+ consecutive failures): {name}"));
                let r = EngineResult {
                    success: false,
                    skipped: true,
                    message: "Skipped — 3+ consecutive failures".into(),
                    ..Default::default()
                };
                self.engine_completed(ctx, path, engine, &r).await;
                continue;
            }
            self.restore(path, original.as_deref());
            self.log(format!("Starting {engine} for: {name}"));
            self.mark(
                ctx,
                path,
                FileUpdate {
                    status: Some(FileStatus::Processing),
                    current_engine: Some(Some(engine.as_str())),
                    ..Default::default()
                },
            )
            .await;

            let (run, content) = self.align(ctx, engine, path, &reference, original.as_deref(), no_split, token).await;
            if run.cancelled || token.is_cancelled() {
                self.log(format!("Skipped (cancelled during {engine}): {name}"));
                self.restore(path, original.as_deref());
                self.finish_file(ctx, path, FileStatus::Skipped, RunCounter::Skipped, None).await;
                return FileOutcome::other("cancelled");
            }
            self.engine_completed(ctx, path, engine, &run.result).await;
            match content {
                Some(c) => {
                    let shift = run.result.offset_ms.unwrap_or(0);
                    self.log(format!("{engine} aligned (shift {shift}ms): {name}"));
                    alignments.push((engine.clone(), c, shift));
                }
                None => {
                    if run.result.shift_too_large {
                        mismatch_reports += 1;
                    }
                    self.log(format!("{engine} could not align: {}", run.result.message))
                }
            }
        }

        let data: Vec<Alignment> =
            alignments.iter().map(|(e, _, s)| Alignment { engine: e.clone(), shift_ms: *s }).collect();
        let disagreement = if alignments.len() == 2 { (alignments[0].2 - alignments[1].2).abs() } else { 0 };
        let sync_info = (mode, anchor.as_deref());

        match decide_outcome(&data, threshold, mismatch_reports) {
            Outcome::Failed => {
                // Every engine errored, timed out or was skipped: that says
                // nothing about fit, so no strike and never a delete.
                self.log(format!(
                    "✗ No engine could run successfully — leaving subtitle unchanged, will retry next run: {name}"
                ));
                self.restore(path, original.as_deref());
                self.finish_file(ctx, path, FileStatus::Error, RunCounter::Failed, Some(sync_info)).await;
                FileOutcome::other("failed")
            }
            Outcome::NotFitting => {
                if alignments.is_empty() {
                    self.log(format!("✗ No engine could sync: {name}"));
                } else {
                    self.log(format!(
                        "{} vs {} disagree by {disagreement}ms (threshold: {threshold}ms) — subtitle doesn't fit: {name}",
                        alignments[0].0, alignments[1].0
                    ));
                }
                self.handle_not_fitting(ctx, path, original.as_deref()).await;
                self.finish_file(ctx, path, FileStatus::NotFitting, RunCounter::NotFitting, Some(sync_info)).await;
                FileOutcome::other("not_fitting")
            }
            Outcome::Keep => {
                let (engine, content, shift) = alignments.swap_remove(0);
                if data.len() == 1 {
                    self.log(format!(
                        "Only {engine} produced output — keeping (no second engine to corroborate a delete): {name}"
                    ));
                } else {
                    self.log(format!(
                        "✓ {} vs {} agree ({disagreement}ms ≤ {threshold}ms) — subtitle fits: {name}",
                        data[0].engine, data[1].engine
                    ));
                }
                self.commit_sync(ctx, path, &engine, &content, shift, original.as_deref(), mode).await;
                self.finish_file(ctx, path, FileStatus::Completed, RunCounter::Completed, Some(sync_info)).await;
                FileOutcome {
                    kind: FileOutcomeKind::Completed,
                    synced_content: Some(content),
                    status_label: "completed",
                }
            }
        }
    }

    fn restore(&self, path: &Path, original: Option<&[u8]>) {
        if let Some(o) = original {
            let _ = std::fs::write(path, o);
        }
    }

    /// Run one engine and return its aligned content (None when it failed).
    #[allow(clippy::too_many_arguments)]
    async fn align(
        &self,
        ctx: &RunCtx,
        engine: &str,
        path: &Path,
        reference: &Path,
        original: Option<&[u8]>,
        no_split: bool,
        token: &CancellationToken,
    ) -> (EngineRun, Option<Vec<u8>>) {
        let s = &ctx.settings;
        let bin = self.cfg.engine_bins.for_engine(engine);
        let timeout = Duration::from_millis(s.timeout_ms(engine));
        let mut run = match engine {
            "alass" | "ffsubsync" => {
                engines::run_in_place(engine, bin, path, reference, timeout, s.max_subtitle_shift_ms, no_split, token)
                    .await
            }
            "autosubsync" => engines::run_autosubsync(bin, path, reference, timeout, false, token).await,
            other => EngineRun {
                result: EngineResult { message: format!("Unknown engine: {other}"), ..Default::default() },
                cancelled: false,
            },
        };
        if run.cancelled || !run.result.success || run.result.skipped {
            return (run, None);
        }
        let in_place = engine != "autosubsync";
        let out_path = if in_place { path.to_path_buf() } else { sidecar_path(path, engine) };
        let content = std::fs::read(&out_path).ok();
        if !in_place {
            let _ = std::fs::remove_file(&out_path);
        }
        let Some(content) = content else {
            run.result.success = false;
            run.result.message = "Engine reported success but produced no output".into();
            return (run, None);
        };
        // 0 cues must never reach the agreement check: "nothing to compare"
        // reads as offset 0, i.e. a perfect match with a broken engine.
        if srt::count_cues(&content) == 0 {
            run.result.success = false;
            run.result.message = "Engine produced output with no parseable subtitle cues".into();
            return (run, None);
        }
        let shift = original.map(|o| srt::subtitle_offset_ms(o, &content)).unwrap_or(0);
        run.result.offset_ms = Some(shift);
        (run, Some(content))
    }

    #[allow(clippy::too_many_arguments)]
    async fn commit_sync(
        &self,
        ctx: &RunCtx,
        path: &Path,
        engine: &str,
        content: &[u8],
        shift: i64,
        original: Option<&[u8]>,
        mode: SyncMode,
    ) {
        let name = name_of(path);
        if ctx.run.dry_run {
            self.restore(path, original);
            self.log(format!("[DRY RUN] Would sync ({engine}, shift {shift}ms): {name}"));
            return;
        }
        match std::fs::write(path, content) {
            Ok(()) => {
                // Record mtime/size as written so the scan trusts the cache
                // only while the file stays exactly like this.
                if let Ok(m) = std::fs::metadata(path) {
                    let _ = self.db.upsert_sync_cache(&[(ps(path), mtime_ms(&m), m.len() as i64)]).await;
                }
                self.log(format!(
                    "✓ Synced ({engine}{}, shift {shift}ms): {name}",
                    if mode == SyncMode::Follower { ", via anchor" } else { "" }
                ));
                let _ = self.db.reset_not_fitting_strikes(&ps(path)).await;
            }
            Err(e) => self.log(format!("Failed to write synced subtitle {name}: {e}")),
        }
    }

    /// Strike system: delete only after N consecutive not-fitting runs, so a
    /// one-off transient failure never deletes a good subtitle.
    async fn handle_not_fitting(&self, ctx: &RunCtx, path: &Path, original: Option<&[u8]>) {
        let name = name_of(path);
        let threshold = ctx.settings.not_fitting_delete_threshold;
        if ctx.run.dry_run {
            self.restore(path, original);
            self.log(format!("[DRY RUN] Would record not-fitting strike (threshold: {threshold}): {name}"));
            return;
        }
        let p = ps(path);
        let strikes = self.db.record_not_fitting_strike(&p).await.unwrap_or(1);
        if anchor::is_forced_subtitle(path) {
            // Forced subs are never deleted: their sparse cues give audio
            // alignment little to lock onto, so disagreement is weak evidence,
            // and a deleted forced sub just gets re-downloaded and deleted
            // again. Keep it; at the threshold, park it so the scan stops
            // re-decoding the video until the file changes.
            self.restore(path, original);
            if strikes >= threshold {
                if let Ok(m) = std::fs::metadata(path) {
                    let _ = self.db.park_file(&p, mtime_ms(&m), m.len() as i64, "forced_not_fitting").await;
                }
                self.log(format!(
                    "⚠ Forced subtitle didn't fit {strikes} run(s) in a row — keeping it unchanged and parking it until the file changes: {name}"
                ));
            } else {
                self.log(format!(
                    "⚠ Forced subtitle not fitting (strike {strikes}/{threshold}) — keeping it unchanged (forced subs are never deleted): {name}"
                ));
            }
            return;
        }
        if strikes >= threshold {
            match std::fs::remove_file(path) {
                Ok(()) => self.log(format!("🗑 Deleted after {strikes} consecutive not-fitting run(s): {name}")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => self.log(format!("Failed to delete subtitle {name}: {e}")),
            }
            let _ = self.db.reset_not_fitting_strikes(&p).await;
            let _ = self.db.remove_from_sync_cache(&[p]).await;
        } else {
            self.restore(path, original);
            self.log(format!(
                "⚠ Not fitting (strike {strikes}/{threshold}) — keeping subtitle, will retry next run: {name}"
            ));
        }
    }
}
