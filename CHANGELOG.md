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
