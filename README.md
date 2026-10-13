# Subsyncarr

Subsyncarr keeps the subtitles in your media library in sync with their videos. It runs as a Docker container, scans your library on a schedule, and aligns each `.srt` in place with [alass](https://github.com/kaegi/alass), [ffsubsync](https://github.com/smacke/ffsubsync) and optionally [autosubsync](https://github.com/oseiskar/autosubsync).

This is a fork of [johnpc/subsyncarr](https://github.com/johnpc/subsyncarr). Since 2.0 it is a single Rust binary with an embedded Svelte web UI.

## Features

- **In-place sync.** Each subtitle is aligned against its video and overwritten. Already-synced files are tracked in SQLite (path, mtime and size), so files are left byte-for-byte clean for Plex, Jellyfin and ffprobe.
- **Two-engine agreement check.** The default and fallback engines run independently. The result is kept only if they agree within `ENGINE_AGREEMENT_THRESHOLD_MS`.
- **Three outcomes, not two.**
  - **Synced:** the engines agree.
  - **Not fitting:** the engines disagree, or the shift is larger than `MAX_SUBTITLE_SHIFT_MS`. The subtitle probably belongs to another release. This earns a strike, and after `NOT_FITTING_DELETE_THRESHOLD` consecutive strikes the subtitle is deleted.
  - **Failed:** the engines crashed or timed out. No strike is recorded and the file is never touched.
- **Forced subtitles are never deleted.** `*.forced.srt` and `*.foreign.srt` are aligned with a single global offset (`alass --no-split`). When they don't fit they are restored and parked until the file changes.
- **Fast path for multi-language releases.** The largest subtitle of a video is synced against the audio. The other languages are aligned to it subtitle-to-subtitle, which takes milliseconds instead of minutes.
- **Change detection.** A content hash per file means that replacing a subtitle (for example via Bazarr) clears its strikes, engine skips and parking.
- **Engine safety.** Engines are started without a shell, so odd file names are safe. Each runs in its own process group, so a timeout or Skip also kills ffmpeg children.
- **Integrations.** Sonarr, Radarr and Bazarr can trigger a sync of new files right away, run summaries go to Apprise or Discord, and Jellyfin or Plex refresh the folders that changed. All off by default.
- **Sync confidence.** Every kept sync gets a 0–100 score from engine agreement, how many engines aligned, offset spread and split points, cue count, shift size and framerate correction. Syncs scoring below 50 are flagged for review on the Library page.
- **Manual fixes from the library.** Open any subtitle in the Library to re-sync it on demand or shift every cue by a fixed offset. Each change is written in place, kept by later scans, and can be undone (the last 10 changes per file).
- **Live web UI.** Dashboard, live run view with per-file progress, run history, library browser, server logs, settings and changelog. Light and dark themes, and it works on a phone.
- **Low footprint.** One process with no runtime dependencies besides the engines, using about 15 MB of RAM when idle.

> **Note:** Subsyncarr overwrites `.srt` files in place and deletes subtitles that repeatedly fail to fit their video. Keep a backup of subtitles you can't re-download, and run with `DRY_RUN=true` (or the **Dry run** button) first to see what would happen.

## Quick start

```yaml
services:
  subsyncarr:
    image: davidsteg/subsyncarr:latest
    container_name: subsyncarr
    ports:
      - "3000:3000"
    volumes:
      - /path/to/media:/media
      - ./data:/app/data
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Europe/Berlin
      - SCAN_PATHS=/media
      - CRON_SCHEDULE=0 0 * * *
    restart: unless-stopped
```

Then open `http://<host>:3000`.

```bash
docker run -d --name subsyncarr -p 3000:3000 \
  -v /path/to/media:/media -v ./data:/app/data \
  -e PUID=1000 -e PGID=1000 -e SCAN_PATHS=/media \
  davidsteg/subsyncarr:latest
```

## Configuration

Settings marked with ✎ can also be changed in the web UI. A value saved there takes precedence over the environment variable.

| Variable | Default | Description |
| --- | --- | --- |
| `SCAN_PATHS` | `/scan_dir` | Comma-separated directories to scan. Must be mounted. |
| `EXCLUDE_PATHS` | | Comma-separated directories to skip, matched by whole path component. |
| `CRON_SCHEDULE` | `0 0 * * *` | When to run automatically, or `disabled`. |
| `STARTUP_SCAN` | `true` | Run once when the container starts. |
| `INCLUDE_ENGINES` | `ffsubsync,autosubsync,alass` | Engines to use. |
| `DEFAULT_ENGINE` ✎ | `alass` | Primary engine. Its alignment is kept when both agree. |
| `FALLBACK_ENGINE` ✎ | `ffsubsync` | Second engine for the agreement check. |
| `ENGINE_AGREEMENT_THRESHOLD_MS` ✎ | `5000` | Maximum disagreement between the two engines. |
| `MAX_SUBTITLE_SHIFT_MS` ✎ | `30000` | Larger shifts mean the subtitle doesn't belong to this video. |
| `NOT_FITTING_DELETE_THRESHOLD` ✎ | `3` | Consecutive not-fitting runs before a subtitle is deleted. |
| `MAX_CONCURRENT_SYNC_TASKS` ✎ | `1` | Videos processed in parallel. Each engine decodes audio, so watch memory. |
| `ANCHOR_ALIGNMENT` ✎ | `true` | Use the multi-language fast path. |
| `EMBEDDED_SUBTITLE_REFERENCE` ✎ | `true` | Sync against a full-length text subtitle track inside the video instead of the audio when there is one; falls back to the audio when it doesn't fit. |
| `DRY_RUN` ✎ | `false` | Run engines but write and delete nothing. |
| `SYNC_ENGINE_TIMEOUT_MS` ✎ | `300000` | Per-engine timeout. `SYNC_TIMEOUT` (seconds) is also accepted. |
| `ALASS_TIMEOUT_MS`, `FFSUBSYNC_TIMEOUT_MS`, `AUTOSUBSYNC_TIMEOUT_MS` ✎ | | Per-engine overrides. |
| `SCAN_CONCURRENCY` | `32` | Threads used to walk the library. Lower it on spinning disks. |
| `WEB_HOST` / `WEB_PORT` | `0.0.0.0` / `3000` | Where the UI listens. |
| `DB_PATH` | `/app/data/subsyncarr-plus.db` | SQLite database. Run logs go to `logs/` next to it. |
| `SERVER_LOG_BUFFER_SIZE` | `5000` | Lines kept for the Server logs page and `/api/logs`. |
| `RETENTION_KEEP_RUNS_DAYS` | `30` | Delete runs older than this. |
| `RETENTION_TRIM_LOGS_DAYS` | `7` | Trim stored logs of older runs. |
| `RETENTION_CLEANUP_INTERVAL_HOURS` | `24` | How often cleanup and `VACUUM` run. |
| `LOG_LEVEL` | `subsyncarr=info` | `tracing` filter for container logs, for example `subsyncarr=debug`. |
| `ALASS_BIN`, `FFSUBSYNC_BIN`, `AUTOSUBSYNC_BIN` | name on `PATH` | Engine executables. |
| `FFPROBE_BIN`, `FFMPEG_BIN` | name on `PATH` | Used to find and extract embedded subtitle tracks. |
| `PUID` / `PGID` | `1000` | User and group that own the written files. |
| `TZ` | | Time zone for the schedule and the UI. |

`SUBTITLE_FORMAT`, `SYNC_FORMAT=standard` and `NODE_OPTIONS` from 1.x are no longer used. Subsyncarr always syncs in place and logs a warning if they are set.

### File naming

Subtitles are matched to the video in the same folder by name. Language and flag tags are removed one at a time from the end:

```txt
Movie (2024).mkv
Movie (2024).en.srt            → Movie (2024).mkv
Movie (2024).de.forced.srt     → Movie (2024).mkv (forced: never deleted)
Show/S01E01.mkv
Show/S01E01.en.sdh.srt         → S01E01.mkv
```

Supported video extensions: mkv, mp4, avi, mov, m4v, ts, m2ts, webm, wmv, mpg, mpeg.

## Integrations

Everything here is set on the **Settings** page and is off until you turn it on.

### Webhooks (Sonarr, Radarr, Bazarr)

Turn on **Sync on webhook** and set a token. The page then shows the URLs to paste:

- **Sonarr / Radarr:** Settings → Connect → Webhook, method `POST`, URL `http://subsyncarr:3000/api/webhook/sonarr?token=<token>` (or `/radarr`), triggers *On Import* and *On Upgrade*. Subtitles next to the imported video are synced, and *Test* answers with a success.
- **Bazarr:** Settings → Subtitles → Custom Post-Processing, command:

  ```bash
  curl -fsS -X POST -G "http://subsyncarr:3000/api/webhook/bazarr?token=<token>" --data-urlencode "path={{subtitles}}"
  ```

- **Anything else:** `POST /api/webhook` with `{"path": "/media/..."}` or `{"paths": [...]}`. A path can be a subtitle, a video (its subtitles are synced) or a folder.

Calls are collected for 5 seconds and then synced as one run. If a run is already going, they wait for it. Paths must be inside `SCAN_PATHS` and outside `EXCLUDE_PATHS`. If the other app sees your library under a different path, add a path mapping such as `/tv=/media/tv`.

### Notifications

Set a URL and format:

- **Apprise API** (`http://apprise:8000/notify/<key>`): reaches Telegram, ntfy, Gotify, Pushover, email and many more.
- **Discord webhook** (`https://discord.com/api/webhooks/...`).
- **Generic JSON:** posts `{ event, title, body, level, run, problems: [{ path, status }] }`.

By default a message is sent when a run synced, failed or rejected something. You can also choose every run or failures only.

### Media server refresh

Pick Jellyfin (API key from Dashboard → API Keys) or Plex (`X-Plex-Token`). After a run that synced subtitles, only the changed folders are refreshed (more than 50 → a full library refresh). If the media server mounts the library elsewhere, add a path mapping such as `/media=/data`. Dry runs never trigger a refresh.

## Upgrading from 1.x

The 2.0 image reads the existing `subsyncarr-plus.db` and migrates it in place. History, the sync cache, engine skips and strikes are all kept, so nothing is re-synced. Mount the same `/app/data` volume and keep the same environment variables. The container now runs as a user named `subsyncarr` instead of `node`. `PUID` and `PGID` still decide ownership.

## API

The web UI uses a JSON API that you can also script against. Endpoints and WebSocket messages are documented in [docs/API.md](docs/API.md). Examples:

```bash
curl -X POST localhost:3000/api/run/start -H 'content-type: application/json' -d '{"paths":["/media/Movies/Alien (1979)"]}'
curl "localhost:3000/api/logs?level=error&format=text"
curl localhost:3000/api/diagnostics   # why subtitles aren't syncing
```

## Troubleshooting

Every run log starts with the settings in effect, has one `▶ <outcome>: <file> | <engine results>` line per subtitle (for example `▶ failed_timeout: Movie.en.srt | alass ✗ timeout (…), ffsubsync ✓ +1200ms`), and ends with a summary that counts subtitles by outcome and lists the problem files. `GET /api/diagnostics` returns that summary together with every file that has strikes, a permanently skipped engine or a parked forced sub.

- **Nothing is processed.** Check the Dashboard. If it says `SCAN_PATHS` is not configured, set it to your mounted media directory.
- **Permission denied writing subtitles.** Set `PUID`/`PGID` to the owner of your media files (`id -u`, `id -g`).
- **Container killed for memory.** Lower `MAX_CONCURRENT_SYNC_TASKS`. ffsubsync decodes audio with ffmpeg and can use several hundred MB per file.
- **An engine is always skipped for a file.** After 3 failures an engine is skipped for that file. Replace the subtitle, or reset it from the Library page or via `POST /api/skip-status/reset`.

## Development

```bash
cd web && npm ci && npm run build && cd ..   # builds web/dist, embedded at compile time
cargo test
cargo run                                    # SCAN_PATHS=... DB_PATH=./data/dev.db
cd web && npm run dev                        # UI with hot reload, proxies /api and /ws to :3000
```

## License

See [LICENSE](LICENSE).
