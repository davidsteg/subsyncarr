## [1.3.40] — 2026-08-16

### Fixed

- **SRT header broke ffprobe/Jellyfin scans.** Subsyncarr prepended a `# synced:alass <timestamp>` comment line at the top of every synced `.srt`. That line is invalid SRT (files must start with a cue number), so ffprobe and Jellyfin's SubtitleResolver failed on every synced file — causing 88K+ errors per scan and library scans hanging for 9+ hours. `markSrtAsSynced()` now writes clean SRT content with no header. Sync status is tracked solely via the database sync cache (`synced_files` table), which already existed. A migration pass in the scanner strips the legacy header from existing synced files on the next run, rewriting them as valid SRT and updating the cache with the new mtime/size.

## [1.3.39] — 2026-08-03

### Fixed

- **OOM kill under load now that the container runs two Node processes.** The runtime image sets `NODE_OPTIONS=--max-old-space-size=2048` (2 GB heap), but the container is limited to 1.5 GB and, since 1.3.38, runs _two_ Node processes (worker + API reader) — each inheriting the 2 GB cap, plus up to 3 alass/ffsubsync engine subprocesses sharing the same cgroup. Under load the sum exceeds the limit and the kernel OOM-kills the container (the exit-137 "brief outage that self-heals" pattern). The heap caps are now sized to fit the limit:
  - Worker: `--max-old-space-size=896` (was 2048) — plenty for the engine + DB work, leaves headroom for engine subprocesses.
  - API reader: overridden to `--max-old-space-size=256` in `supervisor.sh` (it only answers DB reads and proxies).
    Net: worker 896 MB + reader 256 MB + engines stays inside the 1.5 GB cgroup, so the kernel no longer kills the container mid-run under load.

## [1.3.38] — 2026-07-21

### Changed

- **Split the API and the sync worker into two processes (one container) so heavy dashboard reads can never stall a run.** better-sqlite3 is synchronous, so a big `/api/status` or `/api/history` query used to block the same event loop that drives the engine — the root cause of the ~40–50s freezes observed on a large active run. Now:
  - The **worker** runs the existing single-process server unchanged, bound to `127.0.0.1:$WORKER_PORT` (default 3001) — it stays the sole DB writer and the only process that touches media files, and still owns the engine, cron and cleanup. Its file-handling code is untouched by this change.
  - A new **API process** (`index-api.ts`) serves the public port. It answers the heavy reads (`/api/status`, `/api/history`, `/api/stats`, `/api/folders`, `/api/runs/:id[/files]`) from its own **read-only** SQLite connection — WAL lets it read the worker's committed writes without blocking it — and transparently reverse-proxies everything stateful (control POSTs, the live WebSocket, config/version/settings, the worker log buffer) to the worker. Live updates stay event-driven (the WebSocket is proxied, not re-polled).
  - A small `supervisor.sh` runs both, forwards signals, and exits the container if either dies. Revert to the original single process any time by setting the container command to `node dist/index-server.js`.

### Fixed

- **Added the `(run_id, updated_at)` composite index on `file_results`** (migration v14). The live-run view (`getActiveAndRecentFiles`) filters by `run_id` and orders by `updated_at DESC`; with only the single-column `run_id` index, SQLite had to sort every row for the run (~115k on a large active run), which is what made that query take tens of seconds. The composite lets it walk the index backwards to the `LIMIT` — sub-millisecond. This alone eliminates the freeze; the process split above is defense-in-depth so no future heavy read can reintroduce it.

## [1.3.37] — 2026-07-21

### Fixed

- **Engine child-process output buffer was cut to 512 KB in 1.3.36, risking spurious sync failures.** `execPromise`'s `maxBuffer` caps how much stdout/stderr the engine subprocess may emit before Node kills it and the sync fails. ffsubsync can be very chatty on a long decode, so a 512 KB cap could kill an otherwise-successful run. Restored to 10 MB of headroom. This is independent of how much output is _persisted_ — that's capped separately at 1 KB in the engine wrapper, so the larger process buffer only costs transient memory.
- **Keep/skip decision logging lost its diagnostic detail in the 1.3.36 refactor.** The successful-sync path printed a blanket "✓ Engines agree" even when only one engine actually produced output, and the engine-to-engine millisecond delta (e.g. "alass vs ffsubsync agree (15ms ≤ 5000ms)") disappeared from both the agree and disagree paths. Restored: the log now distinguishes "only one engine produced output — keeping" from a genuine two-engine agreement, and shows the actual delta and threshold on every two-engine decision.
- **`compose.yaml` pinned a Docker image tag that was never built.** 1.3.36 changed it to `davidsteg/subsyncarr:v1.3.36`, but the publish workflow tags images from the bare version tag (`1.3.36`, no `v` prefix) — so `docker compose pull` would fail with "not found". Repointed to `davidsteg/subsyncarr:1.3.37`, matching the image the workflow actually pushes.

### Removed

- **Dead code left behind by the 1.3.36 refactor.** `generateAlassSubtitles.ts` and `generateFfsubsyncSubtitles.ts` were superseded by the unified `engineWrapper.ts` but left on disk — two stale copies of the exact logic the dedup was meant to eliminate. Also removed `configResolver.ts`: a 195-line "single source of truth for settings" module that was never imported anywhere (config resolution still runs through `config.ts` / `engineRuntime.ts` / `helpers.ts`). Unifying those three into one resolver is still open work — this just removes the dead scaffold that made it look done.

## [1.3.36] — 2026-07-20

### Changed

- **Extracted the keep-vs-delete decision into a pure `decideOutcome()` function** (`decideOutcome.ts`) with unit tests covering the empty / single-engine / agree / disagree / exact-threshold / negative-shift cases — the most safety-critical logic in the app (it governs subtitle deletion) is now isolated and testable instead of buried inline in the processing loop.
- **Unified the alass and ffsubsync wrappers** into a single `engineWrapper.ts` parameterized by command-builder and temp-suffix, eliminating ~95% duplication (they differed only in the command string). Preserves all 1.3.32 safety behavior: cue-count validation before install, hidden dot-file temp/backup names, and the shift-too-large check.
- **Centralized database migrations** into a versioned `migrations.ts` runner (tracked in a `migrations` table) instead of scattered inline `ALTER TABLE` blocks in `initSchema`. Idempotent on existing databases.
- **Capped persisted engine stdout/stderr to 1 KB** (was effectively unbounded, up to the process buffer) — the source of multi-megabyte API responses on large runs.

## [1.3.32] — 2026-07-20

### Added

- **Anchor-based alignment**: when a video has 2+ subtitle files, only one ("the anchor" — the largest non-forced sub, densest signal for the engines to lock onto) is synced against the video with the full two-engine pipeline. Every other subtitle in the group is then aligned sub-to-sub against the synced anchor (both alass and ffsubsync accept a subtitle as the reference), which takes milliseconds instead of another full video decode. A video with 8 language subs used to mean 16 decodes (2 engines × 8 files) — now just 2. Forced subs, and any follower whose cue count is too sparse relative to the anchor (mislabeled forced subs etc.), fall back to the full video pipeline automatically, since sub-to-sub matching needs enough signal to be reliable. Kill switch: `ANCHOR_ALIGNMENT=false`. Dry runs always use the full pipeline (the fast path needs a temp reference file on disk).
  - Dashboard shows a "Fast Path" stat card (% of completed syncs that went via anchor) once any follower has completed; the run page groups a video's subtitles together with ANCHOR/"via anchor"/forced badges; run history gets an anchors/followers column; media detail timelines show which mode each sync used.

### Fixed

- **A failed engine run could install corrupt output that then passed the two-engine "agreement" check — silently, forever.** Root cause of a live incident: alass/ffsubsync can exit 0 while writing an empty or unparseable output file (malformed input, an encoding they mishandle). The wrappers only checked _if_ the temp file existed, not whether it had usable subtitle content, so a 0-cue file got renamed straight over the original. Downstream, `calculateSubtitleOffset` returns `0` when it can't parse either side — which the agreement check read as "the two engines perfectly agree," so garbage output from one engine sailed through as a confirmed sync. The result: a subtitle with zero valid cues, permanently marked synced (in overwrite mode, the `# synced:` header means it's never looked at again), that Jellyfin/ffprobe then rejects as _"Invalid data found when processing input"_ on every single library scan — reported at ~27,000 errors/day on a 150K-file library.
  - `generateAlassSubtitles.ts` / `generateFfsubsyncSubtitles.ts` now reject any engine output with zero parseable cues before it's ever installed — the original is restored from backup, same as the existing shift-too-large / missing-output failure paths.
  - `processingEngine.ts`'s `alignWithEngine` adds the same check as a second gate right before the agreement comparison, so a sidecar-writing engine (autosubsync) or any other future output path can't produce the same failure mode.
  - **Repair pass for existing damage**: a scan in overwrite mode now also checks already-"synced" files for zero parseable cues (a full-content check, run once per file including on sync-cache hits, since a corrupted file's mtime/size never changes again — that's exactly what made it stick). Any found are deleted so your subtitle manager (Bazarr etc.) resupplies them, instead of staying permanently broken.
- **Engine temp/backup/anchor-reference files were regular, visible `.srt` files in the media folder** for the duration of each sync (up to the engine timeout) — media servers watching the folder (Jellyfin, Plex) would pick them up as new subtitle tracks and could ffprobe a still-being-written or already-deleted file. `*-tmp.srt`, `*.srt.bak`, and `*.anchor-ref.srt` are now dot-prefixed (hidden files) so scanners skip them; the orphan-cleanup pass (which already removes leftovers from a killed run) now also recognizes the renamed backup pattern, since `.bak` doesn't carry the `.srt` extension the directory walk otherwise filters on.

## [1.3.31] — 2026-07-05

### Changed

- **Removed the per-engine convergence retry — roughly doubles throughput.** Live-log analysis showed ~90% of engine runs triggered a retry (re-running the engine on its own output = another full video decode) as a quality check. That check predates the two-engine agreement comparison, which is the actual quality gate now — so the second decode bought nothing. Each engine now runs exactly once per file. The `Sync Retry Threshold` / `Max Retries` settings (which were silently non-functional anyway — the engine only ever read env vars, not the DB values the UI saved) are removed from the Settings page.
- **Removed the `validateSubtitleMatch` pre-check** — it read and fully parsed every subtitle just to produce a log line (its event consumer was removed in 1.3.26). Saves one full-file read per file on network storage.

### Fixed

- **`Max Subtitle Shift` setting was a silent no-op** — saved to the DB but the engines only read the `MAX_SUBTITLE_SHIFT_MS` env var. Now wired through the runtime config like the other engine settings; UI changes take effect on the next engine run.
- **ETA was fiction** — it counted every WebSocket event as a file completion and divided by a hardcoded concurrency of 6, showing "4.9h" on a run whose real remainder was ~6 weeks. Now computed from the run's own counters (processed ÷ elapsed), hidden until 10 files have been processed, and formats multi-day estimates as days.
- **Current Run page showed "Processing (0) — None" during active runs** — it fetched the first N files by creation order, which on a large run were processed hours earlier. `/api/status` now returns the files actually being processed plus the most recently finished ones, and the run page refreshes its list on file updates (debounced to one fetch per 2s).

## [1.3.30] — 2026-07-05

### Added

- `SECURITY.md` — documents the app's actual risk profile (no built-in authentication, can delete files) and how to report vulnerabilities via GitHub's private security advisory feature instead of a public issue.
- Auto-created GitHub Releases now get a descriptive title pulled from the tagged commit's message (e.g. "1.3.30 — ..."), instead of just the bare version number.

### Removed

- `.hermes/plans/2026-07-03_ui-features.md` — a one-off implementation plan from a past agent session. All 9 tasks it described are already implemented in the current codebase; kept no ongoing value and risked confusing future readers into thinking there was unfinished work.

## [1.3.29] — 2026-07-05

### Fixed

- **Sync cache could wrongly skip a file that was replaced at the same path.** The `synced_files` DB cache was keyed by path only — if Bazarr (or anything else) dropped in a fresh, unsynced subtitle at a path previously cached as synced, the cache would trust the stale entry and skip it forever, since it short-circuited before ever re-reading the file's actual header. Now stores each cached file's mtime + size and only trusts the cache if they still match a cheap `fs.stat()` (much less costly than reading file content, so the common case — nothing changed — is still fast). Pre-migration rows with no metadata are treated as a one-time cache miss and self-heal. Verified against the exact scenario this fixes (a file re-written at the same path is correctly re-detected as needing sync) plus 7 unit-level cases for the cache logic itself, all passing.

## [1.3.28] — 2026-07-05

### Added

- **Scan-path misconfiguration sanity check.** Discovered via a real incident: a container restarted (after an OOM-kill) without its `docker-compose` `environment:` block applied, silently fell back to the default `SCAN_PATHS=/scan_dir`, and ran empty "successful" scans every hour for over a day — no errors, just 0-file runs, because an empty run looks identical to a healthy one everywhere except the scan path itself.
  - Server now logs a loud, unmissable warning banner at startup if the resolved scan path is still the `/scan_dir` placeholder, and re-warns (a shorter line) every 5 minutes via the existing memory-heartbeat log so it can't just scroll away.
  - Dashboard now shows a prominent red banner ("No scan path configured...") whenever `/api/config` reports `isConfigured: false`, replacing the easy-to-miss small status dot as the only signal.

## [1.3.27] — 2026-07-04

### Docs

- Added explicit fork attribution: README now states this is a fork of [johnpc/subsyncarr](https://github.com/johnpc/subsyncarr); `package.json` gained a matching `description` and `repository` field. `package.json`'s `name`/`version` are left as-is for now (still `@johnpc/subsyncarr-plus` / `0.1.0`, unused by the app itself — it reads the `VERSION` file, not `package.json`, for `/api/version`).

## [1.3.26] — 2026-07-04

### Removed

- **Dead legacy entry point**: `src/index.ts` + `src/processSrtFile.ts` duplicated the sync pipeline with none of the safety checks (engine-agreement logic, not-fitting strikes, stop handling) added since — a drift risk with no upside, since the real server (`index-server.ts`) has been the only entry point in use. Also removed the unused `start:legacy` npm script.
- **Two unused WebSocket events**: `file:suspicious` (subtitle-validator heuristics still run and log, just no longer emit an event nobody listened for) and `file:cleared` (the `clearCompletedFiles()` method in `stateManager.ts` didn't mutate any state — the visible "clear files" UI behavior comes entirely from `server.ts`'s own separate broadcast — so the method was fully dead code, removed along with its call site).

### Changed

- **Deduplicated** `getFirstCueTimeMs`/`getMaxShiftMs`, previously copy-pasted identically in both `generateAlassSubtitles.ts` and `generateFfsubsyncSubtitles.ts`; now shared from `helpers.ts`.

## [1.3.25] — 2026-07-04

### Changed

- **Orphaned engine temp/retry files are now actively deleted during a scan**, not just excluded from being treated as regular subtitles (1.3.24 only excluded them, leaving them on disk). `*.alass-tmp.srt`, `*.ffsubsync-tmp.srt`, and `*.subsyncarr_retry.srt` are only ever created internally mid-processing — anything matching these patterns found during a scan must be leftover from an earlier, interrupted run (only one run/scan happens at a time, and the scan always runs before the current run creates any temp files of its own), so it's always safe to remove. Respects `DRY_RUN` (logs what would be deleted, deletes nothing). The run log now reports how many were removed.

## [1.3.24] — 2026-07-04

### Fixed

- **Orphaned engine temp/retry files got scanned as regular subtitles.** Discovered via live log inspection after deploying 1.3.23: `*.subsyncarr_retry.srt`, `*.alass-tmp.srt`, and `*.ffsubsync-tmp.srt` are internal files the engines create mid-processing and normally clean up — but a killed or restarted process can leave them behind. `findAllSrtFiles`'s exclusion filter only recognized _finished_ engine output (`.alass.`, `.ffsubsync.`, `.autosubsync.`), not these temp patterns, so any orphaned one would be picked up as a "new" subtitle needing sync on every scan, forever, wasting processing time. Verified against the exact filenames found live plus the existing finished-output patterns.

## [1.3.23] — 2026-07-04

### Changed

- **Now deploys from Docker Hub** — `compose.yaml` pulls `davidsteg/subsyncarr:latest` (private repo) instead of building locally via `build: .`. A GitHub Actions workflow (`.github/workflows/docker-publish.yml`) builds and pushes a multi-arch (amd64/arm64) image on every version tag push.

### Fixed

- **Removed duplicate route registrations** in `server.ts` for `/api/version`, `/api/stats`, and `/api/runs/:id/files` — Express always used the first-registered handler for a given path, silently making the second definition of each dead code.
  - For `/api/stats`, the _live_ handler (the first one) had no caching at all — meaning the 1.3.21 fix that invalidated the stats cache on run completion, and reduced its TTL, was operating on a handler that never actually served a response. Removing the dead duplicate activates that caching for real.
  - For `/api/runs/:id/files`, the live handler had a real bug: it filtered by status _after_ fetching only the first page (500 rows) of results, so a run with more matching files than fit on one page would silently miss results beyond it and report a wrong total. Filtering now happens in SQL (`getFileResultsPaginated` takes an optional `status` param), so both the returned files and the total count are correct regardless of run size. Verified against a 600-file/2-status scenario that reproduces the old bug exactly (100 expected, 0 returned under the old logic; 100/100 under the fix).

## [1.3.22] — 2026-07-03

### Added

- **`GET /api/logs`** — remote access to the server's console output (startup, route access, scheduled cleanup, errors), not just one run's processing log. Backed by a global in-memory ring buffer (`SERVER_LOG_BUFFER_SIZE`, default 5000 entries) that wraps `console.log`/`warn`/`error` process-wide. Supports `limit`, `level`, `search`, `since` (incremental fetch by sequence number), and `format=text` for a plain-text dump. Makes it possible to pull logs over HTTP for remote debugging instead of exporting raw container logs by hand.

## [1.3.21] — 2026-07-03

### Fixed

- **Current Run progress/counts always lagged one event behind live.** Every per-file event handler in the coordinator called `updateFileStatus`/`updateFileEngine` (which reads the run row and broadcasts it as `file:updated`) _before_ incrementing that same event's counter (`completed`/`skipped`/`failed`/`not_fitting`/`completed_engines`). So every live push reflected the run's state from just before its own increment — the UI always showed a stale count until the next event arrived (or the final `run:completed` snapshot caught it up). Reordered so counters increment first in all five handlers.
- **Dashboard media stats (Synced/Skipped/Pending, engine cards) didn't refresh when a run finished.** The 30s server-side stats cache wasn't invalidated on `run:completed`/`run:cancelled`, so the dashboard could keep showing mid-run numbers for up to 30s after a run actually ended — long enough that it looked like it needed a page reload to update. Now invalidates the cache on run completion/cancellation, and the client fetches stats immediately on those events instead of waiting for the next poll.
- **Stats cache/poll mismatch**: the server cached `/api/stats` for 30s while the client polled it every 15s, so roughly half of those polls returned already-stale cached data. Reduced the cache TTL to 12s so every client poll gets genuinely fresh data.

## [1.3.20] — 2026-07-03

### Changed

- **Delete on not-fitting now requires multiple consecutive failed runs, not one.** Previously a subtitle was deleted the first time both engines disagreed (or neither could align it). That risked deleting a subtitle over a one-off transient failure — a half-downloaded video, a network hiccup, an engine crash unrelated to actual fit. Each file now accumulates a "not-fitting" strike per run and is only deleted once it fails to fit `NOT_FITTING_DELETE_THRESHOLD` (default 3) consecutive runs; the streak resets to zero the moment the file fits on any run. Configurable via Settings ("Not-Fitting Delete Threshold") or the new `NOT_FITTING_DELETE_THRESHOLD` env var. `DRY_RUN` never records strikes or deletes.

### Added

- New `not_fitting_tracking` DB table for per-file consecutive-strike counts.

## [1.3.19] — 2026-07-03

### Fixed

- **Stop button no longer reliably stopped a run**: since 1.3.18 creates the run row before scanning starts, `stopRun()` no longer detected "still scanning" — it marked the run cancelled in the DB but the scan and processing continued in the background untouched (writing/deleting files) because nothing was in the file queue yet to cancel. Added `ProcessingEngine.requestStop()`, checked at the top of every file's processing, so files discovered after Stop is clicked are skipped instead of processed.
- **`run:started` could be re-broadcast with null data**: if a run was cancelled while its scan was still in flight, the `run:files_found` handler read `getCurrentRun()!` (already null after cancellation) and force-broadcast it anyway, flipping the UI back to "running" with no run data. Now only re-emits when a run object actually exists.
- **Uncaught exception broke page load for every user**: `app.js` still registered a listener on `#setConfidence`, an element removed from `index.html` along with the Confidence Threshold setting. Since `setupEvents()` ran before `fetchInitialState()`/`fetchConfig()`/`fetchVersion()`/`fetchStats()` in the constructor, this threw and silently skipped all of them, plus every handler registered afterward (folder navigation, media detail modal, mobile menu, search boxes, periodic stats refresh).
- **"Parallel Workers" setting required a server restart**: `ProcessingEngine.maxConcurrent` was only read from runtime config once, at construction. Now refreshed at the start of every run.
- **Per-engine timeout Settings could be silently overridden by a stale env var**: `getEngineTimeoutMs` checked `ALASS_TIMEOUT_MS`/etc. before the Settings-UI value. Reordered so a Settings change always wins, consistent with how dry-run precedence works.

### Changed

- Removed dead code: an unused `_pollScanProgress()` method and a shadowed duplicate `_stopScanPoll()` definition in `app.js`.

## [1.3.16]–[1.3.18] — 2026-07-03

Made outside this session; summarized here for changelog continuity.

### Added

- Engine agreement threshold, per-engine timeouts, and max concurrent tasks are now runtime-configurable from the Settings UI (`src/engineRuntime.ts`), not just via environment variables.
- Scan-progress polling on the Current Run page, so the UI shows live scan progress instead of a static "Starting scan..." placeholder.

### Changed

- The run record is now created before scanning starts (rather than after), so the UI has a run to track from the very beginning of a run.
- Removed the Confidence Threshold setting and its logic — sync fit is judged only by offset limit and engine agreement (see 1.3.12).
- Reverted the sidebar/favicon logo from the 1.3.14 SVG back to the 🧬 emoji.

### Fixed

- `startRun` no longer blocks on a `Promise.race` waiting for the file list; the start request returns immediately and the run's progress streams in via WebSocket.
- A missing `catch` after a `try` in the frontend's `startRun`.

## [1.3.15] — 2026-07-03

### Fixed

- **Folders page showed inflated/wrong sync counts**: `getFolderStats` summed one row per `(file, engine)` pair with no dedup, so a file tracked by 2 engines counted twice toward a folder's total, and its "synced" count depended on how many engines happened to succeed rather than a clean yes/no. Same class of bug as the 1.3.13 dashboard fix, in a separate query that wasn't caught then. Now groups by file first (synced if any engine succeeded, skipped only if flagged skipped and never synced), matching the dashboard's numbers.

## [1.3.14] — 2026-07-03

### Changed

- **Logo**: replaced the 🧬 emoji (browser tab icon and sidebar brand) with an SVG logo, removing the blue background box.

## [1.3.13] — 2026-07-03

### Added

- **Dry Run in the UI**: a "Dry Run" button on the dashboard and a "Dry run — preview only" checkbox in the Scan Specific Path modal launch a run that executes both engines but writes and deletes nothing. A "DRY RUN" badge shows on the Current Run header (backed by real server state via `/api/status` and the WebSocket).

### Fixed

- **Settings dry-run toggle was a no-op**: the engine only read `DRY_RUN` from the environment at startup. `startRun` now resolves the effective mode as explicit request → saved setting → env var, so the toggle (and per-run dry runs) actually take effect.
- **Blank dashboard on load**: stats were only fetched on the 15s interval or when navigating to the dashboard, so the default page sat empty for up to 15s. Now fetched immediately on startup.
- **Garbage language chart**: language codes were truncated (`SUBSTR(file_path, -7, 2)` turned `.ger.srt` into "ge", `.sdh.srt` into "sd"). Now extracts the full code between the last two dots and maps ISO 639-1/639-2 codes to language names, dropping non-language tags (sdh, cd1, forced).
- **Inflated media counts**: "Total Tracked"/"Synced"/"Pending" counted `(file, engine)` rows, roughly doubling the real file count. Now counts `DISTINCT file_path`.
- **History clutter**: empty 0-file runs (accidental no-op starts) are hidden from the history table.

## [1.3.12] — 2026-07-03

### Changed

- **Delete decision now uses two-engine agreement**: both engines run independently on the original subtitle and their aligned outputs are compared by median time-diff. If they agree within `ENGINE_AGREEMENT_THRESHOLD_MS` the subtitle is kept (default engine's alignment); if they disagree — or neither can align it — it is deleted as not fitting the video. Deletion now requires **both** engines to fail to agree.
- Replaced the shift-from-original "confidence" metric, which measured how far a subtitle was moved rather than how well it fit — it deleted large-but-correctly-synced subtitles. A correctly-fixed, badly-out-of-sync subtitle is now kept.

### Fixed

- **Retries now work**: each engine re-runs on its own output until the alignment converges. Previously the retry read from a non-existent `.retry.<engine>.srt` path and always no-op'd.
- **Duplicate run stats**: a deleted file counted 2–3× (emitted `not_fitting` twice and `failed` once). It now emits `file:not_fitting` exactly once.
- **Dry-run is truly non-destructive**: since engines overwrite in place, `DRY_RUN=true` now restores the original after processing so nothing is written or deleted.

### Added

- `ENGINE_AGREEMENT_THRESHOLD_MS` (default `5000`) — max ms the two engines' alignments may differ and still count as a match; surfaced in `/api/settings`.

### Docs

- Corrected the inaccurate "Non Destructive" claim: the tool syncs in place (with a `# synced:` header marker) and deletes subtitles neither engine can align. Added a backup/dry-run warning and documented `DEFAULT_ENGINE`, `FALLBACK_ENGINE`, `ENGINE_AGREEMENT_THRESHOLD_MS`.

## [1.3.11] — 2026-07-03

### Added

- **Engine chain**: configurable default → fallback engine order (`DEFAULT_ENGINE`, `FALLBACK_ENGINE`) with per-engine retries before falling back, then delete.

## [1.3.10] — 2026-07-03

### Fixed

- **72MB history payload**: removed `include_files=true` from initial load, added lazy `/api/runs/:id/files` endpoint (4s → 10ms)
- **engine_stats**: pre-computed per-run engine stats stored in DB instead of parsing from heavy file arrays
- **config endpoint**: was queued behind 72MB history request, now instant

## [1.3.9] — 2026-07-03

### Added

- **ETA**: estimated time remaining during scan (based on avg file processing time)
- **Search/Filter**: filter files in Current Run and History by filename or status
- **Mobile sidebar**: hamburger menu with overlay for phones/small screens

## [1.3.8] — 2026-07-03

### Fixed

- **Current Run rendering**: `showFiles` used before declaration, causing Current Run page to crash

### Changed

- **Concurrency**: 2→6 parallel sync tasks (3× faster scans)
- **Status API**: `?brief=true` returns only counters (0.1KB vs 5MB), dashboard uses it by default
- **Sync cache**: new `synced_files` DB table avoids re-reading 183K SRT headers on every scan

## [1.3.7] — 2026-07-03

### Fixed

- **incrementRunField**: removed `updated_at` from UPDATE query (column doesn't exist in `runs` table — all counter increments were silently failing)
- **Favicon**: restored 🧬 emoji in browser tab
- **Logo**: removed blue background box from sidebar brand logo

## [1.3.6] — 2026-07-03

### Added

- **Settings page**: max shift, retry threshold, max retries, confidence threshold, dry-run toggle, theme selector
- **Dry-Run mode**: simulates sync without writing files (DRY_RUN env var)
- **Confidence scoring**: shift-based confidence threshold skips low-confidence matches
- **Media detail page**: per-file sync history, engine status, offset visualization bars
- **Wrong subs detection**: 6 heuristics (cue density, language mismatch, timing anomalies, etc.)
- **GPU Docker image**: CUDA-accelerated ffsubsync via Dockerfile.gpu
- **Folder drill-down**: clickable folder rows with breadcrumb navigation

### Changed

- **Emoji-free UI**: all emojis replaced with CSS SVG icons and text labels
- **Current Run nav**: hidden when idle, auto-navigates to dashboard on completion
- **Dashboard cache**: 30s TTL on /api/stats to reduce DB load
- **History table headers**: OK/SK/FAIL/NF/FF/AU/AL text labels

## [1.3.5] — 2026-07-03

### Added

- **Dark/light mode** toggle with localStorage persistence
- **Version display** in sidebar with GitHub release link
- **Media stats dashboard**: total/synced/skipped/pending, engine breakdown, language distribution
- **Folder navigation** with per-folder sync progress bars
- **Multi-page layout**: Dashboard, Current Run, History, Folders
- **Scan progress bar** during file discovery phase
- `/api/version`, `/api/stats`, `/api/folders` endpoints

### Changed

- Complete UI rewrite: sidebar navigation, cards, clean typography
- Responsive layout with mobile-friendly breakpoints
- Real-time scan progress in dashboard banner

## [1.3.4] — 2026-07-03

- shiftTooLarge no longer cascades engine failures
- Stderr in engine error messages
- Skip remaining engines on mismatch
