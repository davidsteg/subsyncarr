## [1.3.4] — 2026-07-03

### Fixed
- **Shift-too-large no longer triggers engine failure cascade**: subtitle/video mismatches now reset the failure counter instead of incrementing it, preventing subsequent files from being skipped
- **Stderr included in engine error messages**: alass/ffsubsync parse errors are now visible in logs instead of silent "Command failed"
- **Skip remaining engines on mismatch**: when one engine detects the subtitle doesn't match the video, remaining engines are skipped instead of wasting 6-12s per file

### Changed
- Synced TS source with built JS: backup/restore + first-cue shift detection now in source (not just compiled output)
- `shiftTooLarge` and `originalShiftMs` fields added to `ProcessingResult` type

## [1.3.3] — 2026-07-03
- Fixed alass binary missing from Docker image
