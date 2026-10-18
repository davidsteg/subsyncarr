# AGENTS.md — Subsyncarr

## Project

Subsyncarr is an automated subtitle synchronization tool for Docker. It syncs `.srt` files in place against their matching video file using the alass and ffsubsync engines (autosubsync optional). Fork of johnpc/subsyncarr.

- **Repo:** davidsteg/subsyncarr
- **Language:** Rust (backend, single binary), Svelte 5 + TypeScript (web UI in `web/`, embedded into the binary at compile time)
- **Build:** `cd web && npm ci && npm run build`, then `cargo build --release`
- **Tests:** `cargo test` (unit tests in each module, end-to-end pipeline in `tests/pipeline.rs` with a fake engine)
- **Checks:** `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cd web && npm run check`
- **Docker:** `docker build -t davidsteg/subsyncarr:<version> .`
- **Deploy:** `docker kill subsyncarr && docker rm subsyncarr && docker run ...` (no compose plugin)

## Architecture

One process (since 2.0). axum serves the REST API, WebSocket and embedded UI on port 3000. The sync engine runs as tokio tasks in the same process. SQLite is accessed through sqlx (WAL, connection pool), so dashboard reads never block on the engine.

## Key Components

- `src/lib.rs` — wiring (`build`), background jobs (cron, retention cleanup, startup scan), `run()`
- `src/processor.rs` — run lifecycle, concurrency, per-file pipeline, outcome handling (keep / not fitting / failed), parking of forced subs
- `src/scanner.rs` — parallel directory walk (rayon), follows symlinks with loop protection, sync-status classification, orphan/corrupt cleanup, legacy header migration
- `src/engines.rs` — spawning engines (argv, own process group, timeout/cancel kill), backup/restore, output validation
- `src/decide.rs` — pure function: engine agreement → `Outcome`
- `src/anchor.rs` — forced detection, grouping by video, anchor/follower planning
- `src/embedded.rs` — ffprobe/ffmpeg: pick and extract the video's best embedded text subtitle track as sync reference
- `src/video.rs` — video matching with a per-directory listing cache
- `src/srt.rs` — byte-level SRT helpers, offset calculation, timestamp shifting, legacy header handling
- `src/quality.rs` — pure function: alignments + per-cue offsets → sync confidence score
- `src/stats.rs` — pure path classification for statistics (movie/episode, show or movie title, library); `src/db/stats.rs` records decisions and engine runs and aggregates `GET /api/stats/deep`
- `src/manual.rs` — manual offset, undo and folder listing for the library browser
- `src/db/` — `Db` (all queries; quality and undo stack in `manual.rs`, statistics history in `stats.rs`) and `migrations.rs` (versions 1–14 identical to 1.x, 15 matches 1.x PR #1, 16+ are 2.x; 18 cleared the strikes of the old not-fitting rule, 19 adds the statistics history)
- `src/settings.rs` — UI-editable settings, resolved DB → env → default in one place
- `src/config.rs` — env var parsing
- `src/events.rs` — event bus, batches WebSocket updates every 100 ms
- `src/integrations/` — webhooks in (`webhook.rs`: payload parsing, path resolution, debounced trigger queue), notifications (`notify.rs`) and Jellyfin/Plex refresh (`media.rs`); the latter two listen for completed runs on the event bus
- `src/server.rs` — REST + WebSocket handlers (contract in `docs/API.md`)
- `src/logbuf.rs` / `src/runlog.rs` — server log ring buffer (tracing layer) and per-run log files
- `web/src/` — Svelte UI: `pages/`, `lib/components/`, `lib/api.ts`, `lib/live.svelte.ts` (WebSocket store)

## Sync Status Detection

Tracked solely via the database (`synced_files`, keyed by path + mtime + size). Synced files carry no header.

- mtime is stored Node-style (`sec*1000 + nsec/1e6`, float) so 1.x cache rows still match.
- A cached file is read once to verify it has cues and to strip a legacy `# synced:` header, then marked `cues_verified`.
- `file_fingerprints` holds a content hash; a changed file resets engine skips, strikes and parking.

**DB-loss risk:** if the DB is lost, all files will be re-synced. Accepted trade-off.

## Engine Pipeline

1. Scan: walk, skip parked files, check the sync cache, fall back to the legacy header.
2. Group subtitles by video. With anchor alignment on, the largest non-forced subtitle is synced against the video and the others are aligned to it.
   With `EMBEDDED_SUBTITLE_REFERENCE` on, "against the video" means against the video's largest full-length embedded text track (≥ 50 cues, extracted once per video per run to a temp dir) when it has one; if that pass doesn't keep the subtitle, it is re-run against the audio before any strike.
3. Run `DEFAULT_ENGINE` and `FALLBACK_ENGINE`, ffsubsync first when it is in the chain. Both must agree within `ENGINE_AGREEMENT_THRESHOLD_MS`. If ffsubsync's shift is < 250 ms (`decide::NEGLIGIBLE_SHIFT_MS`), the other engine is skipped and the file counts as already in sync.
4. Disagreement with ffsubsync's shift < 1 s (`decide::IN_SYNC_MS`) → already in sync: restore, add to sync cache, no strike.
   Both engines want ≥ 1 s and disagree, or both reject a shift > `MAX_SUBTITLE_SHIFT_MS` → not fitting: restore, strike; at the threshold delete (forced: park instead). Only one engine wants a large shift → restore, no strike. That includes one engine aligning while the other rejects a shift > `MAX_SUBTITLE_SHIFT_MS`; a single engine's output is only installed when the other one crashed or timed out.
   Strikes are collected during the run and recorded when it completes; a stopped or interrupted run records none, and a file whose content changed meanwhile gets none.
5. Both engines failed (crash/timeout) → failed: restore, no strike.
6. Success: install output in place, add to sync cache.

## Environment Variables

See the Configuration table in `README.md`.

## Release Workflow

**Every commit to `master` is a release.** Every change gets a version bump + CHANGELOG entry. Nobody pushes tags by hand: the release workflow tags the version once CI passes on master.

1. Edit code → `cargo fmt` → `cargo clippy --all-targets -- -D warnings` → `cargo test` (and `npm run check && npm run build` in `web/` for UI changes)
2. Bump the version in `Cargo.toml`, `VERSION` and `CHANGELOG.md` (Keep-a-Changelog format, no "v" prefix). An optional short line right under the version heading becomes the GitHub Release title.
3. Commit and merge to `master` (PR or push).
4. `.github/workflows/ci.yml` runs checks and tests on every push and PR.
5. When CI passes on master, `.github/workflows/release.yml` checks that `Cargo.toml`, `VERSION` and `CHANGELOG.md` agree. If the version has no tag yet, it tags the tested commit and calls `.github/workflows/docker-publish.yml`, which creates the GitHub Release from the CHANGELOG section and builds the image, pushing `<version>` to Docker Hub (and `latest` only if it is the highest version tag).
6. The GitHub Release is created right away; the image build runs alongside it.
7. Fallback: run the Release workflow by hand from the Actions tab. It tags master if needed and republishes the current version.

## Conventions

- Version: SemVer without "v" prefix (e.g. `2.0.0`)
- Branch: `master` (not `main`)
- CHANGELOG: `## [version] — YYYY-MM-DD` format
- No German in codebase — all English
