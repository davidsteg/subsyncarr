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
