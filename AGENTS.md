# AGENTS.md — Subsyncarr

## Project

Subsyncarr is an automated subtitle synchronization tool for Docker. It syncs `.srt` files in place against their matching video file using alass and ffsubsync engines. Fork of johnpc/subsyncarr.

- **Repo:** davidsteg/subsyncarr
- **Language:** TypeScript (Node.js)
- **Build:** `npm run build` (tsc)
- **Tests:** `npm test` (jest)
- **Docker:** `docker build -t davidsteg/subsyncarr:<version> .`
- **Deploy:** `docker kill subsyncarr && docker rm subsyncarr && docker run ...` (no compose plugin)

## Architecture

Two-process split (since v1.3.38):

- **Worker** (`index-server.ts`): runs the sync engine, writes to DB and media files, serves the UI on localhost:3001. Sole writer.
- **API reader** (`index-api.ts`): serves dashboard reads from a read-only SQLite connection (WAL), reverse-proxies control POSTs/WebSocket to the worker. Listens on port 3000.

Both managed by `supervisor.sh` (CMD in Dockerfile).

## Key Components

- `src/processingEngine.ts` — main sync orchestration, concurrency, engine calls, agreement checks
- `src/findAllSrtFiles.ts` — directory walk, sync-status detection, legacy header migration, orphan/corrupt cleanup
- `src/helpers.ts` — SRT parsing, sync marker constants, `markSrtAsSynced()`, `stripLegacySyncHeader()`, `isSyncedSrt()`
- `src/database.ts` — SQLite via better-sqlite3, migrations, sync cache (`synced_files` table), run history, settings
- `src/coordinator.ts` — bridges HTTP API ↔ processing engine, manages run lifecycle
- `src/server.ts` — Express + WebSocket server, REST API, static UI
- `src/config.ts` — env var parsing (SCAN_PATHS, EXCLUDE_PATHS, CRON_SCHEDULE, etc.)
- `src/engineRuntime.ts` — runtime config singleton (timeouts, concurrency from DB settings)
- `src/decideOutcome.ts` — pure function: engine agreement/shift logic
- `src/anchorPlanner.ts` — fast-path: groups subtitles by video, syncs anchor first, followers align sub-to-sub
- `src/subtitleOffsetCalculator.ts` — calculates offset between original and synced subtitles
- `src/stateManager.ts` — run state, log file management, DB lifecycle

## Sync Status Detection

Since v1.3.40, sync status is tracked **solely via the database** (`synced_files` table, keyed by path + mtime + size). No file header is written anymore.

- `markSrtAsSynced()` writes clean SRT content (no header)
- `isSyncedSrt()` still detects old `# synced:` headers for backward compatibility (legacy migration)
- `stripLegacySyncHeader()` strips the old header line from existing files — runs during scan and on startup
- `isSyncedSrtSync()` — synchronous version for bulk scanning
- `isCorruptSyncedSrt()` — detects synced files with zero parseable cues (repair pass deletes them)

**DB-loss risk:** if the DB is lost, all files will be re-synced. Accepted trade-off — simpler than sidecar markers.

## Engine Pipeline

1. Scan: walk directories, check sync status via DB cache → header fallback
2. For each unsynced file: try `DEFAULT_ENGINE`, then `FALLBACK_ENGINE`
3. Agreement check: both engines must agree within `ENGINE_AGREEMENT_THRESHOLD_MS`
4. If shift too large (>30s): restore backup, mark "not fitting" (strike system: 3 strikes → delete)
5. If zero cues in output: reject, restore backup
6. On success: write clean SRT, add to sync cache

## Environment Variables

| Variable                 | Default                        | Description                                       |
| ------------------------ | ------------------------------ | ------------------------------------------------- |
| `SCAN_PATHS`             | `/scan_dir`                    | Comma-separated media paths to scan               |
| `EXCLUDE_PATHS`          | (empty)                        | Comma-separated paths to skip                     |
| `CRON_SCHEDULE`          | `0 0 * * *`                    | Cron schedule for automatic runs                  |
| `DEFAULT_ENGINE`         | `ffsubsync`                    | Primary sync engine                               |
| `FALLBACK_ENGINE`        | `alass`                        | Fallback if primary fails                         |
| `SUBTITLE_FORMAT`        | `standard`                     | `overwrite` or `standard` (both write in place)   |
| `DRY_RUN`                | `false`                        | No writes, just log what would happen             |
| `DB_PATH`                | `/app/data/subsyncarr-plus.db` | SQLite database path                              |
| `INCLUDE_ENGINES`        | `ffsubsync,autosubsync,alass`  | Which engines to enable                           |
| `SYNC_TIMEOUT`           | (seconds)                      | Per-engine timeout                                |
| `SYNC_ENGINE_TIMEOUT_MS` | 300000                         | Per-engine timeout in ms (overrides SYNC_TIMEOUT) |

## Release Workflow

**Every commit is a release. No exceptions.** Every change — code, CSS, docs, config — gets a version bump + CHANGELOG entry + commit + tag push. The GitHub Action builds and publishes automatically.

1. Edit code → `npm run build` → `npm test`
2. Bump version in `CHANGELOG.md` (Keep-a-Changelog format, no "v" prefix)
3. `git commit` → `git push origin master`
4. `git tag <version>` → `git push origin <version>`
5. GitHub Action (`.github/workflows/docker-publish.yml`) builds image, pushes to Docker Hub, creates GitHub Release
6. No `gh` CLI needed — everything via git tag push

## Conventions

- Version: SemVer without "v" prefix (e.g. `1.3.40`, not `v1.3.40`)
- Branch: `master` (not `main`)
- Pre-commit hooks: prettier + eslint (husky) — must pass before commit
- CHANGELOG: `## [version] — YYYY-MM-DD` format
- No German in codebase — all English
