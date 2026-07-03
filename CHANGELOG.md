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
