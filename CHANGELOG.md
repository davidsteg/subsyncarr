# Changelog

## [1.3.2] — 2026-07-03

### Fixed
- **`isAlreadySynced` was completely broken** — checked for `.alass.srt` / `.ffsubsync.srt` files that never exist (engines overwrite in-place). Replaced with DB-backed check using `engine_failure_tracking.last_success_time`. Every hourly run was reprocessing the entire 195K-file library.
- **`EXCLUDE_PATHS` used naive `startsWith`** — `/media/Download` also matched `/media/Downloads`. Fixed with `path.relative()` comparison.
- **Cron comment was wrong** — compose.yaml said "daily at midnight" but `CRON_SCHEDULE=0 * * * *` runs every hour. Fixed comment.

### Changed
- `findAllSrtFiles()` now accepts optional `isAlreadySynced` callback (injected by `ProcessingEngine`)
- `SubsyncarrPlusDatabase.isFileAlreadySynced()` added — queries `engine_failure_tracking` for `last_success_time IS NOT NULL`

### Added
- Version badge in UI header linking to GitHub releases
- `VERSION` file and `CHANGELOG.md` for release tracking
- `AGENTS.md` with full project rules for AI coding
- `docker compose` support (plugin v5.3.0 installed on host)

### Removed
- `src/index.ts` — legacy entry point (sequential engine execution, no early-exit)
- `src/processSrtFile.ts` — legacy per-file processor
- `bin/` directory reference from Dockerfile (never existed)
- `start:legacy` script from package.json
