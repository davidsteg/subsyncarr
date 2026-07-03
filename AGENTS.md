# Subsyncarr+ — AI Coding Rules

## Project Overview
Subtitle synchronization tool that scans a media library for `.srt` files, matches them to video files, and syncs using alass (primary) + ffsubsync (fallback). Runs as a Docker container with a web UI on port 30200.

**Path:* `/mnt/raid/misc/subsyncarr-dev/`
_*Container:** `subsyncarr` (image: `misc-subsyncarr`)
**DB:** `/app/data/subsyncarr-plus.db` (SQLite via better-sqlite3)

---

## Architecture

```
index-server.ts (entry point)
  ├── StateManager (DB + log files)
  ├── ProcessingEngine (EventEmitter — file scanning + engine dispatch)
  ├── ProcessingCoordinator (wires engine events → state updates)
  └── SubsyncarrPlusServer (Express + WebSocket)
```

**Data flow:** `ProcessingEngine.processRun()` → scans files → emits `run:files_found` → Coordinator creates run in DB → processes files with worker pool → emits per-file events → Coordinator updates DB → WebSocket broadcasts to UI.

---

## Database (CRITICAL)

- **21 GB, 2.9M rows in `file_results`** — every run inserts ~195K rows
- `engine_failure_tracking` is the source of truth for "already synced" — NOT filesystem checks
- `isFileAlreadySynced(filePath, engines)` checks `last_success_time IS NOT NULL` in `engine_failure_tracking`
- Cleanup runs every 24h (configurable via `RETENTION_KEEP_RUNS_DAYS`, default 30)
- PRAGMAs: `cache_size=-64000`, `mmap_size=268435456`, `journal_mode=WAL`, `synchronous=NORMAL`

### Schema tables
- `runs` — one row per processing run
- `file_results` — one row per SRT file per run (run_id, file_path, status, engines JSON)
- `engine_failure_tracking` — one row per (file_path, engine) pair, tracks consecutive failures, skip status, last success

---

## Engine Behavior

| Engine | Output | Shift Detection | Notes |
|-------|------|----------------|------|
| alass | Overwrites original `.srt` in-place | Yes (First-cue-time comparison) | Creates `.bak` backup, restores on failure |
| ffsubsync | Overwrites original `.srt` in-place | Yes (First-cue-time comparison) | Creates `.bak` backup, restores on failure |
| autosubsync | Writes separate `.autosubsync.srt` | No | Not enabled in production (`INCLUDE_ENGINES=alass,ffsubsync`) |

**Shift guard:** Both alass and ffsubsync parse the first cue time before/after sync. If shift > `MAX_SUBTITLE_SHIFT_MS` (30s), the backup is restored and the engine reports failure.

---

## Key Files

| File | Purpose |
|------|-------|
| `src/index-server.ts` | Entry point — cron scheduling, cleanup, graceful shutdown |
| `src/processingEngine.ts` | File scanning + worker pool + engine dispatch |
| `src/coordinator.ts` | Event wiring between engine and state |
| `src/stateManager.ts` | DB + log file abstraction |
| `src/database.ts` | All SQLite queries, schema, migrations |
| `src/findAllSrtFiles.ts` | Recursive SRT file scanner with exclude-path logic |
| `src/findMatchingVideoFile.ts` | Matches SRT to video by progressive tag stripping |
| `src/generateAlassSubtitles.ts` | alass CLI wrapper with shift detection |
| `src/generateFfsubsyncSubtitles.ts` | ffsubsync CLI wrapper with shift detection |
| `src/generateAutosubsyncSubtitles.ts` | autosubsync CLI wrapper (no shift detection) |
| `src/server.ts` | Express + WebSocket server |
| `src/helpers.ts` | `execPromise` with timeout |
| `src/logFileManager.ts` | Buffered log file writer |
| `src/config.ts` | Scan config + retention config from env vars |
| `public/` | Web UI (vanilla JS, no framework) |
| `compose.yaml` | Docker Compose config |
| `Dockerfile` | Multi-stage build (node:22-bookworm → node:22-slim) |
| `entrypoint.sh` | gosu UID/GID switching |
| `VERSION` | Semantic version (e.g. `0.1.0`) |
| `CHANGELOG.md` | Release notes per version |

---

## Removed / Dead Code

- `src/index.ts` — legacy entry point (ran all engines sequentially, no early-exit)
- `src/processSrtFile.ts` — legacy per-file processor (replaced by `ProcessingEngine.processFile()`)
- `bin/` directory — never existed, removed from Dockerfile
- `start:legacy` script in package.json — removed

---

## Coding Rules

1. **Think step-by-step before writing complex logic** — trace the data flow, consider edge cases, and reason about the full impact before touching any file. This project has a 21 GB database and processes 195K files — mistakes are expensive.

2. **Always use `docker compose`** — never raw `docker run` or `docker stop/rm`. The compose file is the single source of truth for container configuration.

3. **Maintain versioning** — bump `VERSION`, update `CHANGELOG.md`, and tag the image in `compose.yaml` before every deploy.

4. **Build after every release** — run `docker compose build` then `docker compose up -d` to deploy changes.

5. **DB is the source of truth for sync state** — never use filesystem checks to determine if a file was already processed. Use `engine_failure_tracking.last_success_time`.

6. **Test with real data** — the media library at `/mnt/venus/media` is mounted read-write. Be careful with destructive operations.

---

## Pitfalls

1. **`isAlreadySynced` was completely broken** — it checked for `.alass.srt` / `.ffsubsync.srt` files that never get created (those engines overwrite in-place). Fixed by using `engine_failure_tracking.last_success_time` instead. The `findAllSrtFiles` function now accepts an optional `isAlreadySynced` callback.

2. **`exclude_PATHS` used naive `startsWith`** — `/media/Download` would also match `/media/Downloads`. Fixed with `path.relative()` comparison in `isExcluded()`.

3. **Cron comment was wrong** — compose.yaml said "daily at midnight" but `CRON_SCHEDULE=0 * * * *` runs every hour. Fixed comment to "Run every hour".

4. **DB grows unbounded without the isAlreadySynced fix** — every hourly run inserts 195K rows. After the fix, subsequent runs find 0 files and insert 0 rows.

5. **`generateAutosubsyncSubtitles` has no shift detection** — if autosubsync is ever enabled, it could silently corrupt subtitles. Add shift detection before enabling.

---

## Versioning & Release Process

1. **Bump version** in `VERSION` file (semver: `MAJOR.MINOR.PATCH`)
2. **Update `CHANGELOG.md`** with all changes under the new version header
3. **Update image tag** in `compose.yaml` (`image: misc-subsyncarr:X.Y.Z`)
4. **Build and deploy** with docker compose (see below)

## Build & Deploy

**Always use `docker compose` — never raw `docker run`.**

```bash
cd /mnt/raid/misc/subsyncarr-dev

# Build the image (picks up version tag from compose.yaml)
docker compose build

# Deploy (recreates container if image changed)
docker compose up -d

# Check status
docker compose ps
docker compose logs --tail 20
```

---

## Environment Variables

| Variable | Default | Notes |
|----------|--------|------|
| `SCAN_PATHS` | `/scan_dir` | Comma-separated paths to scan |
| `EXCLUDE_PATHS` | — | Comma-separated paths to exclude |
| `INCLUDE_ENGINES` | `alass,ffsubsync` | Engines to use (autosubsync not enabled) |
| `MAX_CONCURRENT_SYNC_TASKS` | `2` | Worker pool size |
| `MAX_SUBTITLE_SHIFT_MS` | `30000` | Max allowed shift before rejecting |
| `SYNC_ENGINE_TIMEOUT_MS` | `600000` | 10 min per engine call |
| `CRON_SCHEDULE` | `0 * * * *` | Every hour |
| `DB_PATH` | `/app/data/subsyncarr-plus.db` | |
| `WEB_PORT` | `3000` | |
| `PUID` / `PGID` | `3000` / `0` | File ownership for /media |
| `RETENTION_KEEP_RUNS_DAYS` | `30` | |
| `RETENTION_TRIM_LOGS_DAYS` | `7` | |
| `RETENTION_CLEANUP_INTERVAL_HOURS` | `24` | |

---

## UI

- Vanilla JS SPA at `http://<host>:30200`
- WebSocket at `/ws` for live updates
- REST API at `/api/*`
- Dark/light theme toggle persisted in localStorage
- File cards color-coded by status (processing/completed/skipped/error)
