import EventEmitter from 'events';
import {
  ScanConfig,
  getScanConfig,
  getDryRunConfig,
  getEngineChainConfig,
  getEngineAgreementThresholdMs,
  getNotFittingDeleteThreshold,
  isAnchorAlignmentEnabled,
} from './config';
import { findAllSrtFiles } from './findAllSrtFiles';
import { findMatchingVideoFile, DirectoryCache, clearDirectoryCache } from './findMatchingVideoFile';
import { generateAutosubsyncSubtitles } from './generateAutosubsyncSubtitles';
import { generateEngineSubtitles, EngineOptions } from './engineWrapper';
import { StateManager } from './stateManager';
import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createHash } from 'crypto';
import { getSubtitleFormat, getOutputPath, markSrtAsSynced, isSyncedSrt } from './helpers';
import { calculateSubtitleOffset } from './subtitleOffsetCalculator';
import {
  groupByVideo,
  planAnchor,
  countCues,
  isTooSparseForFastPath,
  isForcedSubtitle,
  VideoGroup,
} from './anchorPlanner';
import { decideOutcome, Alignment } from './decideOutcome';

export type SyncMode = 'anchor' | 'follower' | 'full';

/** How a file should be processed; absent = classic full pipeline. */
interface FileContext {
  mode: SyncMode;
  /** Matched video (already resolved during grouping). */
  videoPath: string | null;
  /** What the engines align against: the video, or a synced anchor srt. */
  referencePath?: string;
  anchorPath?: string;
  anchorCueCount?: number;
}

type FileOutcome =
  | { status: 'completed'; syncedContent: Buffer }
  | { status: 'skipped' | 'not_fitting' | 'failed' | 'no_video' | 'cancelled' };

/** Engines whose reference argument may be a subtitle file instead of a video. */
const SRT_REFERENCE_CAPABLE = new Set(['alass', 'ffsubsync']);

interface EngineRunResult {
  success: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
  skipped?: boolean;
  duration: number;
  shiftTooLarge?: boolean;
  originalShiftMs?: number;
  offsetMs?: number;
}

export class ProcessingEngine extends EventEmitter {
  private cancelledFiles: Set<string> = new Set();
  private abortControllers: Map<string, AbortController> = new Map();
  private maxConcurrent: number;
  private enabledEngines: string[];
  private logBuffer: string[] = [];
  private maxLogBufferSize: number;
  private directoryCache: DirectoryCache | null = null;
  public stateManager?: StateManager;
  private dryRun: boolean = false;
  /**
   * Set when Stop is requested. Unlike `cancelledFiles` (which only covers
   * files already known to the coordinator), this also covers files
   * discovered *after* Stop was clicked — e.g. ones the scan phase finds
   * after the user has already asked to stop. Checked at the top of
   * processFile so nothing gets written or deleted once a stop is pending.
   */
  private stopRequested: boolean = false; // v1.3.19: reset in reset()
  /** Scan progress during file discovery phase (null when not scanning) */
  public scanProgress: { checked: number; total: number; needSync: number; alreadySynced: number } | null = null;

  constructor() {
    super();
    this.maxConcurrent = this.resolveMaxConcurrent();
    this.enabledEngines = process.env.INCLUDE_ENGINES?.split(',') || ['ffsubsync', 'autosubsync', 'alass'];
    this.maxLogBufferSize = parseInt(process.env.LOG_BUFFER_SIZE || '1000', 10);
    const dryRunConfig = getDryRunConfig();
    this.dryRun = dryRunConfig.enabled;
  }

  /** Reads MAX_CONCURRENT_SYNC_TASKS, overridden by the runtime/DB setting if present. */
  private resolveMaxConcurrent(): number {
    let value = parseInt(process.env.MAX_CONCURRENT_SYNC_TASKS || '1', 10);
    try {
      const { getRuntimeCfg } = require('./engineRuntime');
      const cfg = getRuntimeCfg();
      if (cfg.maxConcurrentTasks > 0) value = cfg.maxConcurrentTasks;
    } catch {}
    return value;
  }

  private get subtitleFormat(): string {
    return getSubtitleFormat();
  }

  private log(message: string): void {
    console.log(message);

    // Ring buffer - remove oldest if at capacity
    if (this.logBuffer.length >= this.maxLogBufferSize) {
      this.logBuffer.shift();
    }

    this.logBuffer.push(message);
    this.emit('log', message);
  }

  getLogs(): string[] {
    return [...this.logBuffer];
  }

  clearLogs(): void {
    this.logBuffer = [];
  }

  async processRun(config?: ScanConfig): Promise<void> {
    // Refresh from runtime config each run — a Settings change now takes
    // effect on the next run instead of requiring a server restart.
    this.maxConcurrent = this.resolveMaxConcurrent();

    const scanConfig = config || getScanConfig();
    this.log(`[${new Date().toISOString()}] Scanning for subtitle files...`);
    this.log(`[${new Date().toISOString()}] Scan paths: ${JSON.stringify(scanConfig.includePaths)}`);

    this.scanProgress = { checked: 0, total: 0, needSync: 0, alreadySynced: 0 };
    const db = this.stateManager?.getDatabase();
    const {
      files: srtFiles,
      directoryCache,
      orphanedTempFilesRemoved,
      corruptedSyncedFilesRemoved,
      legacyHeadersStripped,
    } = await findAllSrtFiles(
      scanConfig,
      db,
      (checked, total, needSync, alreadySynced) => {
        this.scanProgress = { checked, total, needSync, alreadySynced };
      },
      this.dryRun,
    );
    this.scanProgress = null;
    this.directoryCache = directoryCache;
    if (orphanedTempFilesRemoved > 0) {
      this.log(
        `[${new Date().toISOString()}] 🧹 Removed ${orphanedTempFilesRemoved} orphaned temp/retry file(s) left over from an interrupted run`,
      );
    }
    if (corruptedSyncedFilesRemoved > 0) {
      this.log(
        `[${new Date().toISOString()}] 🧹 Removed ${corruptedSyncedFilesRemoved} corrupted synced subtitle(s) (0 parseable cues) — will be resupplied by your subtitle manager`,
      );
    }
    if (legacyHeadersStripped > 0) {
      this.log(
        `[${new Date().toISOString()}] 🧹 Stripped ${legacyHeadersStripped} legacy sync header(s) — files are now valid SRT for ffprobe/Jellyfin`,
      );
    }
    this.log(`[${new Date().toISOString()}] Found ${srtFiles.length} subtitle files`);
    this.emit('run:files_found', srtFiles);

    // Process with concurrency pool — starts next file as soon as one finishes,
    // so a single hanging process doesn't block other slots
    this.log(`[${new Date().toISOString()}] Processing with concurrency: ${this.maxConcurrent}`);
    this.log(`[${new Date().toISOString()}] Enabled engines: ${this.enabledEngines.join(', ')}`);
    if (this.dryRun) {
      this.log(`[${new Date().toISOString()}] DRY RUN MODE — no files will be written`);
    }

    const chain = getEngineChainConfig();
    const anchorMode =
      isAnchorAlignmentEnabled() &&
      SRT_REFERENCE_CAPABLE.has(chain.defaultEngine) &&
      SRT_REFERENCE_CAPABLE.has(chain.fallbackEngine);

    if (anchorMode) {
      const groups = groupByVideo(srtFiles, (p) => findMatchingVideoFile(p, this.directoryCache));
      const multi = groups.filter((g) => g.videoPath !== null && g.files.length > 1).length;
      this.log(
        `[${new Date().toISOString()}] Anchor alignment: ${groups.length} video groups (${multi} with 2+ subs eligible for the fast path)`,
      );
      await this.processGroupsWithConcurrency(groups);
    } else {
      if (isAnchorAlignmentEnabled()) {
        this.log(
          `[${new Date().toISOString()}] Anchor alignment inactive: engine chain ${chain.defaultEngine}+${chain.fallbackEngine} — both engines must support subtitle references (alass, ffsubsync)`,
        );
      }
      await this.processWithConcurrency(srtFiles);
    }

    // Clean up directory cache after processing
    this.directoryCache = null;
    clearDirectoryCache();

    this.log(`[${new Date().toISOString()}] All files processed`);
  }

  /**
   * Process files with a concurrency pool. Unlike batch processing (Promise.all per batch),
   * this starts the next file as soon as one slot frees up, so a single hanging process
   * only blocks its own slot — not the entire batch.
   */
  private async processWithConcurrency(files: string[]): Promise<void> {
    let nextIndex = 0;
    let completedCount = 0;
    const total = files.length;

    const processNext = async (): Promise<void> => {
      while (nextIndex < files.length) {
        const fileIndex = nextIndex++;
        const file = files[fileIndex];
        completedCount++;
        this.log(`[${new Date().toISOString()}] Starting file ${completedCount}/${total}: ${file.split('/').pop()!}`);
        await this.processFile(file);
      }
    };

    // Start up to maxConcurrent workers
    const workers = [];
    for (let i = 0; i < Math.min(this.maxConcurrent, files.length); i++) {
      workers.push(processNext());
    }

    await Promise.all(workers);
  }

  /** Same worker-pool pattern as processWithConcurrency, but the unit of work is a video group. */
  private async processGroupsWithConcurrency(groups: VideoGroup[]): Promise<void> {
    let nextIndex = 0;
    let startedCount = 0;
    const total = groups.length;

    const processNext = async (): Promise<void> => {
      while (nextIndex < groups.length) {
        if (this.stopRequested) return;
        const group = groups[nextIndex++];
        startedCount++;
        const label = group.videoPath ? group.videoPath.split('/').pop()! : '(no video)';
        this.log(
          `[${new Date().toISOString()}] Starting group ${startedCount}/${total} (${group.files.length} sub${group.files.length === 1 ? '' : 's'}): ${label}`,
        );
        await this.processGroup(group);
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(this.maxConcurrent, groups.length); i++) {
      workers.push(processNext());
    }
    await Promise.all(workers);
  }

  /**
   * Process one video's subtitles: sync the anchor against the video with the
   * full two-engine pipeline, then align the remaining subs against the
   * synced anchor (sub-to-sub — milliseconds instead of a video decode each).
   * Forced/sparse subs, and everything when the anchor fails, fall back to
   * the full pipeline. Dry runs skip the fast path entirely: it would need a
   * temp reference file on disk, and dry run promises to write nothing.
   */
  private async processGroup(group: VideoGroup): Promise<void> {
    const plan = this.dryRun
      ? null
      : planAnchor(group, (p) => {
          try {
            return statSync(p).size;
          } catch {
            return 0;
          }
        });

    if (!plan) {
      for (const file of group.files) {
        if (this.stopRequested) return;
        await this.processFile(file, { mode: 'full', videoPath: group.videoPath });
      }
      return;
    }

    const anchorOutcome = await this.processFile(plan.anchor, { mode: 'anchor', videoPath: group.videoPath });

    let anchorRefPath: string | null = null;
    let anchorCueCount = 0;
    if (anchorOutcome.status === 'completed') {
      // Write a clean copy (no "# synced:" marker line) as the reference —
      // engine SRT parsers shouldn't have to tolerate our bookkeeping header.
      // Dot-prefixed so media servers watching this directory don't index it
      // as an extra subtitle track while it sits on disk for the group's
      // followers.
      anchorRefPath = join(dirname(plan.anchor), `.${basename(plan.anchor, '.srt')}.anchor-ref.srt`);
      try {
        writeFileSync(anchorRefPath, anchorOutcome.syncedContent);
        anchorCueCount = countCues(anchorOutcome.syncedContent.toString('utf8'));
      } catch (err) {
        this.log(
          `[${new Date().toISOString()}] Could not write anchor reference, falling back to full pipeline: ${err instanceof Error ? err.message : String(err)}`,
        );
        anchorRefPath = null;
      }
    } else if (plan.followers.length > 0) {
      this.log(
        `[${new Date().toISOString()}] Anchor did not sync (${anchorOutcome.status}) — ${plan.followers.length} follower(s) take the full pipeline: ${plan.anchor.split('/').pop()}`,
      );
    }

    try {
      for (const follower of plan.followers) {
        if (this.stopRequested) return;
        if (anchorRefPath) {
          await this.processFile(follower, {
            mode: 'follower',
            videoPath: group.videoPath,
            referencePath: anchorRefPath,
            anchorPath: plan.anchor,
            anchorCueCount,
          });
        } else {
          await this.processFile(follower, { mode: 'full', videoPath: group.videoPath });
        }
      }
      for (const file of plan.fullPipeline) {
        if (this.stopRequested) return;
        this.log(`[${new Date().toISOString()}] Forced subtitle — full pipeline: ${file.split('/').pop()}`);
        await this.processFile(file, { mode: 'full', videoPath: group.videoPath });
      }
    } finally {
      if (anchorRefPath) {
        try {
          unlinkSync(anchorRefPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async runEngine(
    engine: string,
    srtPath: string,
    videoPath: string,
    signal?: AbortSignal,
    opts: EngineOptions = {},
  ): Promise<EngineRunResult> {
    const startTime = Date.now();
    try {
      let result;
      if (engine === 'alass' || engine === 'ffsubsync') {
        // Use unified wrapper for in-place engines
        result = await generateEngineSubtitles(engine, srtPath, videoPath, signal, opts);
      } else if (engine === 'autosubsync') {
        // autosubsync writes to sidecar, keep original wrapper
        result = await generateAutosubsyncSubtitles(srtPath, videoPath, signal);
      } else {
        return { success: false, message: `Unknown engine: ${engine}`, duration: 0 };
      }
      const duration = Date.now() - startTime;
      return { ...result, duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        duration,
      };
    }
  }

  private async processFile(srtPath: string, ctx?: FileContext): Promise<FileOutcome> {
    const fileName = srtPath.split('/').pop()!;

    // Run was stopped (possibly mid-scan) — skip without touching the file at all
    if (this.stopRequested) {
      this.log(`[${new Date().toISOString()}] Skipped (run stopped): ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'cancelled' });
      return { status: 'cancelled' };
    }

    // Skip already-synced files (overwrite mode)
    if (this.subtitleFormat === 'overwrite' && (await isSyncedSrt(srtPath))) {
      this.log(`[${new Date().toISOString()}] ⊘ Already synced (header): ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'already_synced' });
      return { status: 'skipped' };
    }

    // Check if cancelled
    if (this.cancelledFiles.has(srtPath)) {
      this.log(`[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'cancelled' });
      return { status: 'cancelled' };
    }

    // Create an AbortController for this file so skip can kill running processes
    const abortController = new AbortController();
    this.abortControllers.set(srtPath, abortController);

    try {
      return await this.processFileInner(srtPath, fileName, abortController.signal, ctx);
    } finally {
      this.abortControllers.delete(srtPath);
    }
  }

  private async processFileInner(
    srtPath: string,
    fileName: string,
    signal: AbortSignal,
    ctx?: FileContext,
  ): Promise<FileOutcome> {
    const videoPath = ctx !== undefined ? ctx.videoPath : findMatchingVideoFile(srtPath, this.directoryCache);
    let mode: SyncMode = ctx?.mode ?? 'full';
    let anchorPath = mode === 'follower' ? ctx?.anchorPath ?? null : null;

    this.emit('file:started', { srtPath, videoPath });

    if (!videoPath) {
      this.log(`[${new Date().toISOString()}] No matching video found for: ${fileName}`);
      this.emit('file:no_video', { srtPath });
      return { status: 'no_video' };
    }

    // Read the original subtitle. The raw bytes are what gets restored on
    // failure — decoding to a UTF-8 string and writing that back would
    // permanently mangle Latin-1/Windows-1252 subs (umlauts become U+FFFD)
    // even when the sync itself fails. The decoded string is only for
    // analysis (cue counts, offsets).
    let originalBytes: Buffer | null = null;
    let originalContent: string | null = null;
    try {
      originalBytes = readFileSync(srtPath);
      originalContent = originalBytes.toString('utf8');
    } catch {
      this.log(`[${new Date().toISOString()}] Warning: Could not read original subtitle for offset calculation`);
    }

    // Engine-skip and not-fitting state are keyed by path. If a new subtitle
    // now sits at this path (Bazarr upgrade/replacement), that state belongs
    // to the old file: reset it so the new one gets a fair run instead of
    // inheriting permanent engine skips and being deleted for old strikes.
    if (!this.dryRun && originalBytes !== null && this.stateManager) {
      try {
        const db = this.stateManager.getDatabase();
        const hash = createHash('sha1').update(originalBytes).digest('hex');
        if (db.refreshFileFingerprint(srtPath, hash)) {
          this.stateManager.resetSkipStatus(srtPath);
          db.resetNotFittingStrikes(srtPath);
          db.unparkFile(srtPath);
        }
      } catch {}
    }

    // What the engines align against: the synced anchor for followers, the video otherwise.
    let referencePath = videoPath;
    if (mode === 'follower' && ctx?.referencePath) {
      // Sparse safety net: a follower with too few cues (mislabeled forced
      // sub etc.) gives sub-to-sub matching too little signal — reroute it to
      // the full video pipeline instead of risking a bad alignment.
      const cueCount = originalContent !== null ? countCues(originalContent) : 0;
      if (originalContent !== null && isTooSparseForFastPath(cueCount, ctx.anchorCueCount ?? 0)) {
        this.log(
          `[${new Date().toISOString()}] Sparse subtitle (${cueCount} cues) — rerouting to full pipeline: ${fileName}`,
        );
        mode = 'full';
        anchorPath = null;
      } else {
        referencePath = ctx.referencePath;
        this.log(`[${new Date().toISOString()}] Aligning via anchor ${ctx.anchorPath?.split('/').pop()}: ${fileName}`);
      }
    }

    const engineConfig = getEngineChainConfig();
    const agreementThresholdMs = getEngineAgreementThresholdMs();

    // Both engines run independently on the ORIGINAL subtitle. We then compare
    // the two aligned outputs: if they land on the same alignment (within the
    // agreement threshold) the subtitle fits its reference and we keep it; if
    // they disagree — or neither can produce output — the subtitle doesn't
    // fit and gets a not-fitting strike. Deletion therefore requires BOTH
    // engines to fail to agree, on repeated runs.
    const engineChain = [engineConfig.defaultEngine, engineConfig.fallbackEngine];
    this.log(
      `[${new Date().toISOString()}] Engine chain: ${engineChain.join(' + ')} (agreement threshold: ${agreementThresholdMs}ms)`,
    );

    const alignments: { engine: string; content: string; bytes: Buffer; shiftMs: number }[] = [];
    // Engines that ran and rejected their result as a too-large shift — the
    // only evidence (besides disagreement) that the subtitle doesn't fit.
    let mismatchReports = 0;
    // Forced subs: a handful of sparse cues, so keep alass to one global
    // offset instead of letting split mode scatter them.
    const forced = isForcedSubtitle(srtPath);
    const engineOpts: EngineOptions = forced && referencePath === videoPath ? { noSplit: true } : {};
    if (forced) {
      this.log(`[${new Date().toISOString()}] Forced subtitle — alass without splits: ${fileName}`);
    }

    for (const engine of engineChain) {
      if (this.cancelledFiles.has(srtPath) || signal.aborted) {
        this.log(`[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`);
        this.emit('file:skipped', { srtPath, reason: 'cancelled' });
        return { status: 'cancelled' };
      }

      // Skip engines that have failed on this file 3+ times in a row
      if (this.stateManager?.shouldSkipEngine(srtPath, engine)) {
        this.log(`[${new Date().toISOString()}] ⊘ Skipping ${engine} (3+ consecutive failures): ${fileName}`);
        this.emit('file:engine_completed', {
          srtPath,
          engine,
          result: { success: false, duration: 0, message: 'Skipped — 3+ consecutive failures', skipped: true },
        });
        continue;
      }

      // Always align from the pristine original so the two engines are comparable.
      if (originalBytes !== null) {
        try {
          writeFileSync(srtPath, originalBytes);
        } catch {}
      }

      this.log(`[${new Date().toISOString()}] Starting ${engine} for: ${fileName}`);
      this.emit('file:engine_started', { srtPath, engine });

      const aligned = await this.alignWithEngine(engine, srtPath, referencePath, originalContent, signal, engineOpts);

      if (aligned.cancelled) {
        this.log(`[${new Date().toISOString()}] Skipped (cancelled during ${engine}): ${fileName}`);
        this.emit('file:skipped', { srtPath, reason: 'cancelled' });
        return { status: 'cancelled' };
      }

      this.emit('file:engine_completed', { srtPath, engine, result: aligned.result });

      if (aligned.success && aligned.content !== null && aligned.bytes !== null) {
        this.log(`[${new Date().toISOString()}] ${engine} aligned (shift ${aligned.shiftMs}ms): ${fileName}`);
        alignments.push({ engine, content: aligned.content, bytes: aligned.bytes, shiftMs: aligned.shiftMs });
      } else {
        if (aligned.result.shiftTooLarge) mismatchReports++;
        this.log(`[${new Date().toISOString()}] ${engine} could not align: ${aligned.result.message}`);
      }
    }

    // --- Keep vs. delete decision (pure function) ---
    const alignmentData: Alignment[] = alignments.map((a) => ({ engine: a.engine, shiftMs: a.shiftMs }));
    const outcome = decideOutcome(alignmentData, agreementThresholdMs, mismatchReports);

    // Disagreement between the two engines, as the difference of each engine's
    // shift-vs-original. For a constant global shift (the overwhelming common
    // case) this equals a direct content-to-content comparison; it only
    // diverges under non-constant warping. Only meaningful with 2 alignments.
    const disagreementMs = alignments.length === 2 ? Math.abs(alignments[0].shiftMs - alignments[1].shiftMs) : 0;

    if (outcome === 'failed') {
      // Every engine errored, timed out or was skipped — that says nothing
      // about whether the subtitle fits, so no strike (and never a delete).
      // Previously this counted as "not fitting" and a file whose engines
      // kept timing out (large remux, slow NAS) was deleted after 3 runs.
      this.log(
        `[${new Date().toISOString()}] ✗ No engine could run successfully — leaving subtitle unchanged, will retry next run: ${fileName}`,
      );
      if (originalBytes !== null) {
        try {
          writeFileSync(srtPath, originalBytes);
        } catch {}
      }
      this.emit('file:failed', { srtPath });
      return { status: 'failed' };
    }

    if (outcome === 'not_fitting') {
      if (alignments.length === 0) {
        this.log(`[${new Date().toISOString()}] ✗ No engine could sync: ${fileName}`);
      } else {
        this.log(
          `[${new Date().toISOString()}] ${alignments[0].engine} vs ${alignments[1].engine} disagree by ${disagreementMs}ms ` +
            `(threshold: ${agreementThresholdMs}ms) — subtitle doesn't fit: ${fileName}`,
        );
      }
      await this.handleNotFitting(
        srtPath,
        fileName,
        alignments.length > 0 ? `${alignments[0].engine}/${alignments[1].engine}` : 'none',
        disagreementMs,
        originalBytes,
        mode,
        anchorPath,
      );
      return { status: 'not_fitting' };
    }

    // Keep. Two paths reach here: only one engine produced output (can't
    // corroborate a delete, so keep), or both agreed within threshold.
    const winner = alignments[0];
    if (alignments.length === 1) {
      this.log(
        `[${new Date().toISOString()}] Only ${winner.engine} produced output — keeping (no second engine to corroborate a delete): ${fileName}`,
      );
    } else {
      this.log(
        `[${new Date().toISOString()}] ✓ ${alignments[0].engine} vs ${alignments[1].engine} agree (${disagreementMs}ms ≤ ${agreementThresholdMs}ms) — subtitle fits: ${fileName}`,
      );
    }
    this.commitSync(srtPath, fileName, winner.engine, winner.bytes, winner.shiftMs, originalBytes, mode, anchorPath);
    return { status: 'completed', syncedContent: winner.bytes };
  }

  /**
   * Run one engine on the given subtitle and return its aligned output.
   * No per-engine convergence retry: it used to re-run the engine on its own
   * output (another full video decode, triggered by ~90% of real files) as a
   * quality check — but the two-engine agreement comparison downstream is
   * the actual quality gate now, so that second decode bought nothing.
   */
  private async alignWithEngine(
    engine: string,
    srtPath: string,
    referencePath: string,
    originalContent: string | null,
    signal: AbortSignal,
    opts: EngineOptions = {},
  ): Promise<{
    success: boolean;
    content: string | null;
    bytes: Buffer | null;
    shiftMs: number;
    cancelled: boolean;
    result: EngineRunResult;
  }> {
    const result = await this.runEngine(engine, srtPath, referencePath, signal, opts);

    if (signal.aborted) {
      return { success: false, content: null, bytes: null, shiftMs: 0, cancelled: true, result };
    }
    if (result.skipped || !result.success) {
      // Includes shiftTooLarge — this engine judges the subtitle unfit.
      return { success: false, content: null, bytes: null, shiftMs: 0, cancelled: false, result };
    }

    const bytes = this.readEngineOutput(engine, srtPath);
    if (bytes === null) {
      return {
        success: false,
        content: null,
        bytes: null,
        shiftMs: 0,
        cancelled: false,
        result: { ...result, success: false, message: 'Engine reported success but produced no output' },
      };
    }

    // Belt-and-suspenders: the alass/ffsubsync wrappers already reject
    // empty/unparseable output before it ever reaches here, but this also
    // covers sidecar-writing engines (autosubsync). Content with 0 cues must
    // never reach the agreement check below — calculateSubtitleOffset treats
    // "nothing to compare" as offset 0, which used to read as a perfect
    // match between a real engine and a broken one and let corrupt output
    // through as "agreement".
    const content = bytes.toString('utf8');
    if (countCues(content) === 0) {
      return {
        success: false,
        content: null,
        bytes: null,
        shiftMs: 0,
        cancelled: false,
        result: { ...result, success: false, message: 'Engine produced output with no parseable subtitle cues' },
      };
    }

    const shiftMs = originalContent ? calculateSubtitleOffset(originalContent, content) : 0;
    return { success: true, content, bytes, shiftMs, cancelled: false, result: { ...result, offsetMs: shiftMs } };
  }

  /** Read an engine's synced output. alass/ffsubsync overwrite in place; others write a sidecar. */
  private readEngineOutput(engine: string, inputPath: string): Buffer | null {
    const inPlace = engine === 'alass' || engine === 'ffsubsync';
    const outputPath = inPlace ? inputPath : getOutputPath(inputPath, engine);
    try {
      const content = readFileSync(outputPath);
      if (!inPlace) {
        try {
          unlinkSync(outputPath);
        } catch {
          /* ignore */
        }
      }
      return content;
    } catch {
      return null;
    }
  }

  /** Persist a successful sync and emit completion. Honors dry-run and overwrite/standard modes. */
  private commitSync(
    srtPath: string,
    fileName: string,
    engine: string,
    content: Buffer,
    shiftMs: number,
    originalBytes: Buffer | null,
    syncMode: SyncMode = 'full',
    anchorPath: string | null = null,
  ): void {
    if (this.dryRun) {
      // Engines already overwrote srtPath in place; undo that so dry-run leaves files untouched.
      if (originalBytes !== null) {
        try {
          writeFileSync(srtPath, originalBytes);
        } catch {}
      }
      this.log(`[${new Date().toISOString()}] [DRY RUN] Would sync (${engine}, shift ${shiftMs}ms): ${fileName}`);
      this.emit('file:completed', { srtPath, syncMode, anchorPath });
      return;
    }

    try {
      // Both formats write in place (alass/ffsubsync overwrite the input), so
      // both record the result in the sync cache. Standard mode used to skip
      // this and instead look for `.<engine>.srt` sidecars that are never
      // written — every file was re-synced on every run.
      markSrtAsSynced(srtPath, engine, content);
      if (this.stateManager) {
        // Record the mtime/size of the file as it now sits on disk (after
        // the write above), so a later scan can trust the cache only for
        // as long as the file matches this exact state.
        try {
          const s = statSync(srtPath);
          this.stateManager.getDatabase().addFileToSyncCache(srtPath, s.mtimeMs, s.size);
        } catch {}
      }
      this.log(
        `[${new Date().toISOString()}] ✓ Synced (${engine}${syncMode === 'follower' ? ', via anchor' : ''}, shift ${shiftMs}ms): ${fileName}`,
      );
      // Break any not-fitting streak — the file synced fine this run.
      if (this.stateManager) {
        try {
          this.stateManager.getDatabase().resetNotFittingStrikes(srtPath);
        } catch {}
      }
    } catch {
      this.log(`[${new Date().toISOString()}] Failed to write synced subtitle: ${fileName}`);
    }
    this.emit('file:completed', { srtPath, syncMode, anchorPath });
  }

  /**
   * Handle a subtitle that didn't fit this run (both engines disagree, or
   * neither could align it). Doesn't delete immediately — tracks consecutive
   * not-fitting strikes per file across runs, only deleting once the
   * configurable threshold is reached, so a one-off transient failure (a
   * half-downloaded video, a network hiccup, an engine crash) doesn't delete
   * a subtitle that might sync fine on a later run.
   */
  private async handleNotFitting(
    srtPath: string,
    fileName: string,
    lastEngine: string,
    offsetMs: number,
    originalBytes: Buffer | null,
    syncMode: SyncMode = 'full',
    anchorPath: string | null = null,
  ): Promise<void> {
    const threshold = getNotFittingDeleteThreshold();

    if (this.dryRun) {
      // Restore the original the engines overwrote; dry-run touches nothing, including strike counts.
      if (originalBytes !== null) {
        try {
          writeFileSync(srtPath, originalBytes);
        } catch {}
      }
      this.log(
        `[${new Date().toISOString()}] [DRY RUN] Would record not-fitting strike (threshold: ${threshold}): ${fileName}`,
      );
      this.emit('file:not_fitting', { srtPath, engine: lastEngine, offsetMs, syncMode, anchorPath });
      return;
    }

    const strikes = this.stateManager?.getDatabase().recordNotFittingStrike(srtPath) ?? 1;

    if (isForcedSubtitle(srtPath)) {
      // Forced subs are never deleted. Their sparse cues (only the foreign-
      // language lines) give audio alignment very little to lock onto, so
      // engines disagreeing is weak evidence of a wrong subtitle — and a
      // deleted forced sub just gets re-downloaded and deleted again. Keep
      // the original; once the strike threshold is reached, park it so the
      // scan stops re-decoding the video every run until the file changes.
      if (originalBytes !== null) {
        try {
          writeFileSync(srtPath, originalBytes);
        } catch {}
      }
      if (strikes >= threshold && this.stateManager) {
        try {
          const s = statSync(srtPath);
          this.stateManager.getDatabase().parkFile(srtPath, s.mtimeMs, s.size, 'forced_not_fitting');
        } catch {}
        this.log(
          `[${new Date().toISOString()}] ⚠ Forced subtitle didn't fit ${strikes} run(s) in a row — keeping it unchanged and parking it until the file changes: ${fileName}`,
        );
      } else {
        this.log(
          `[${new Date().toISOString()}] ⚠ Forced subtitle not fitting (strike ${strikes}/${threshold}) — keeping it unchanged (forced subs are never deleted): ${fileName}`,
        );
      }
      this.emit('file:not_fitting', { srtPath, engine: lastEngine, offsetMs, syncMode, anchorPath });
      return;
    }

    if (strikes >= threshold) {
      try {
        if (existsSync(srtPath)) {
          unlinkSync(srtPath);
          this.log(
            `[${new Date().toISOString()}] 🗑 Deleted after ${strikes} consecutive not-fitting run(s): ${fileName}`,
          );
        }
      } catch {
        this.log(`[${new Date().toISOString()}] Failed to delete subtitle: ${fileName}`);
      }
      if (this.stateManager) {
        try {
          this.stateManager.getDatabase().resetNotFittingStrikes(srtPath);
        } catch {}
      }
    } else {
      // Not enough strikes yet — restore the original and retry on the next run.
      if (originalBytes !== null) {
        try {
          writeFileSync(srtPath, originalBytes);
        } catch {}
      }
      this.log(
        `[${new Date().toISOString()}] ⚠ Not fitting (strike ${strikes}/${threshold}) — keeping subtitle, will retry next run: ${fileName}`,
      );
    }

    this.emit('file:not_fitting', { srtPath, engine: lastEngine, offsetMs, syncMode, anchorPath });
  }

  /** Enable/disable dry-run for the next run (no files written or deleted). */
  setDryRun(enabled: boolean): void {
    this.dryRun = enabled;
  }

  isDryRun(): boolean {
    return this.dryRun;
  }

  skipFile(filePath: string): void {
    this.cancelledFiles.add(filePath);
    // Kill any running process for this file immediately
    const controller = this.abortControllers.get(filePath);
    if (controller) {
      this.log(`[${new Date().toISOString()}] Aborting running process for: ${filePath.split('/').pop()!}`);
      controller.abort();
    }
    this.emit('file:skip_requested', { filePath });
  }

  stopAllProcessing(allFiles: string[]): void {
    this.log(`[${new Date().toISOString()}] Stop requested - cancelling all remaining files`);
    allFiles.forEach((file) => {
      this.cancelledFiles.add(file);
      const controller = this.abortControllers.get(file);
      if (controller) {
        controller.abort();
      }
    });
  }

  /**
   * Request a full stop, covering files not yet known to the coordinator too
   * (e.g. still being discovered by the directory scan). `stopAllProcessing`
   * only cancels files already in the DB/queue at the moment Stop is
   * clicked — without this, a stop during a long scan would leave every
   * file the scan finds afterward to be processed (and possibly deleted)
   * normally, with the UI showing the run as cancelled the whole time.
   */
  requestStop(): void {
    this.stopRequested = true;
    this.log(`[${new Date().toISOString()}] Stop requested — remaining and newly discovered files will be skipped`);
  }

  reset(): void {
    this.cancelledFiles.clear();
    this.abortControllers.clear();
    this.stopRequested = false;
    this.clearLogs();
    this.directoryCache = null;
    clearDirectoryCache();
  }
}
