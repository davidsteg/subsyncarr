# Subsyncarr HTTP / WebSocket API

All endpoints are served by the single `subsyncarr` binary on `WEB_HOST:WEB_PORT`
(default `0.0.0.0:3000`). JSON in, JSON out. Timestamps are Unix epoch
**milliseconds**. Paths are absolute container paths.

Compared to the 1.x TypeScript server the shapes are identical except that
`Run.engine_stats` and `FileResult.engines` are now real JSON objects instead of
JSON-encoded strings, and scan progress is pushed over the WebSocket.

## Types

```ts
type RunStatus = 'running' | 'completed' | 'cancelled';
type FileStatus = 'pending' | 'processing' | 'completed' | 'skipped' | 'error' | 'not_fitting';
type SyncMode = 'anchor' | 'follower' | 'full';

interface Run {
  id: string;
  start_time: number;
  end_time: number | null;
  total_files: number;
  completed: number;
  skipped: number;
  failed: number;
  not_fitting: number;
  total_engines: number;
  completed_engines: number;
  status: RunStatus;
  engine_stats: Record<string, { pass: number; fail: number }>;
  anchors_completed: number;
  followers_completed: number;
  dry_run: boolean;
}

interface EngineResult {
  success: boolean;
  duration: number; // ms
  message: string;
  stdout?: string;
  stderr?: string;
  skipped?: boolean;
  offsetMs?: number;
  shiftTooLarge?: boolean;
  originalShiftMs?: number;
  framerateScale?: number; // ffsubsync's framerate scale factor
}

interface FileResult {
  id: number;
  run_id: string;
  file_path: string;
  video_path: string | null;
  status: FileStatus;
  current_engine: string | null;
  engines: Record<string, EngineResult>;
  sync_mode: SyncMode | null;
  anchor_path: string | null;
  quality_score: number | null; // set once the file is kept
  created_at: number;
  updated_at: number;
}

interface SyncQuality {
  score: number | null;           // 0–100; null when only a manual offset is known
  level: 'good' | 'fair' | 'weak' | null; // good ≥ 80, weak < 50
  details: {
    score: number;
    level: 'good' | 'fair' | 'weak';
    enginesAligned: number;
    disagreementMs: number | null;
    shiftMs: number;
    spreadMs: number;             // p90 − p10 of per-cue offsets
    splitPoints: number;          // jumps > 1 s between neighbouring cue offsets
    cues: number;
    factors: { label: string; penalty: number }[];
  } | null;
  source: 'run' | 'resync' | 'offset';
  manualOffsetMs: number;         // sum of manual shifts since the last sync
  reviewed: boolean;
  needsReview: boolean;           // weak and not reviewed
  updatedAt: number;
}

interface ScanProgress {
  checked: number;
  total: number;
  needSync: number;
  alreadySynced: number;
}
```

## REST

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/version` | `{ version, repo, releaseUrl }` |
| GET | `/api/config` | `{ paths: string[], excludePaths: string[], isConfigured: boolean, schedule: { enabled, cron, description, nextRun: number \| null } }` |
| GET | `/api/changelog` | `[{ version, date, sections: [{ title, items: string[] }] }]` (latest 10) |
| GET | `/api/stats` | `{ totalFiles, syncedFiles, skippedFiles, syncRate, engines: [{ engine, total, synced, rate }], languages: [{ name, count }], fastPath: { anchors, followers, completed, followerShare } }` |
| GET | `/api/folders?parent=/media/tv` | `[{ name, fullPath, total, synced, skipped, pending, progress, hasChildren }]` sorted by total desc |
| GET | `/api/status?brief=true\|false&limit=100` | `{ currentRun: Run \| null, scanProgress: ScanProgress \| null, files: FileResult[], totalFiles, isRunning, dryRun }` — `files` (non-brief only) = currently processing + most recently finished, newest first |
| GET | `/api/history?limit=50` | `Run[]` newest first |
| GET | `/api/runs/:id?limit=500` | `{ run: Run, files: FileResult[], totalFiles }` or 404 |
| GET | `/api/runs/:id/files?status=&page=1&limit=500` | `{ files: FileResult[], total, page, limit, totalPages }` |
| GET | `/api/runs/:id/logs` | `{ logs: string }` |
| GET | `/api/logs?limit=500&level=all\|log\|warn\|error&search=&since=<seq>&format=text` | `{ size, maxSize, latestSeq, logs: [{ seq, timestamp, level, message }] }` (or `text/plain` with `format=text`) |
| POST | `/api/run/start` | body `{ paths?: string[], dryRun?: boolean }` → `{ runId }`; `409` if a run is active |
| POST | `/api/run/stop` | `{ success: true }` |
| POST | `/api/file/skip` | body `{ filePath }` → `{ success: true }` |
| GET | `/api/diagnostics?limit=200` | `{ lastRunSummary: { runId, startedAt, finishedAt, dryRun, scan: { found, needSync, alreadySynced, parked }, counts: Record<Category, number>, samples: Record<Category, string[]> } \| null, strikes: [{ file_path, consecutive_strikes, last_strike_time }], skippedEngines: [{ file_path, engine, consecutive_failures, last_failure_time }], parked: [{ file_path, reason, parked_at }], totals: { strikes, skippedEngines, parked } }`. `Category` is one of `synced, synced_single_engine, not_fitting_disagree, not_fitting_shift, deleted, forced_kept, forced_parked, failed_timeout, failed_error, failed_engines_skipped, no_video, cancelled`; `samples` lists up to 25 problem files per category |
| GET | `/api/skip-status` | `{ totalSkipped, skippedByEngine: Record<string, number> }` |
| POST | `/api/skip-status/reset` | body `{ filePath, engine? }` → `{ success: true }` |
| GET | `/api/media?path=<abs path>` (also `/api/media/<abs path>`) | `{ filePath, notFittingStrikes, failureTracking: [{ engine, consecutive_failures, last_failure_time, last_success_time, is_skipped }], syncHistory: [{ runId, runStartTime, runStatus, fileStatus, engines: Record<string, EngineResult>, syncMode, anchorPath, qualityScore, updatedAt }], quality: SyncQuality \| null, undo: [{ action, offsetMs, createdAt }] }` (`undo` newest first) |
| GET | `/api/library/files?dir=<abs dir>` | `[{ name, filePath, sizeBytes, synced, quality: SyncQuality \| null, undoSteps }]` — `.srt` files directly in `dir` (must be inside `SCAN_PATHS`, else `[]`) |
| POST | `/api/file/resync` | body `{ filePath }` → `{ runId }` — one-file run past the sync cache; resets engine skips, never strikes or deletes; `409` if a run is active |
| POST | `/api/file/offset` | body `{ filePath, offsetMs }` (non-zero, within ±600000) → `{ success: true }` — shifts every cue in place, counts as reviewed; `409` while an engine is working on the file |
| POST | `/api/file/undo` | body `{ filePath }` → `{ success: true, undone: 'resync' \| 'offset' }`; `404` nothing to undo, `409` file changed on disk since |
| POST | `/api/file/review` | body `{ filePath, reviewed?: boolean }` → `{ success: true }`; `404` without a quality record |
| GET | `/api/quality/review?limit=50` | `{ total, files: [{ filePath, quality: SyncQuality }] }` — weak, unreviewed syncs, weakest first |
| GET | `/api/settings` | `{ maxSubtitleShiftMs, engineAgreementThresholdMs, notFittingDeleteThreshold, engineTimeouts: { alass, ffsubsync, autosubsync }, maxConcurrentTasks, defaultEngine, fallbackEngine, dryRun, anchorAlignment, embeddedSubtitleReference, cronSchedule, includeEngines, theme, integrations: { webhookEnabled, webhookToken, webhookPathMap, notifyUrl, notifyKind, notifyOn, mediaServer, mediaServerUrl, mediaServerToken, mediaPathMap } }` |
| POST | `/api/settings` | body: any of `max_subtitle_shift_ms, engine_agreement_threshold_ms, not_fitting_delete_threshold, engine_timeout_alass, engine_timeout_ffsubsync, engine_timeout_autosubsync, max_concurrent_tasks, default_engine, fallback_engine, dry_run, anchor_alignment, embedded_subtitle_reference, theme, webhook_enabled, webhook_token, webhook_path_map, notify_url, notify_kind (apprise\|discord\|json), notify_on (always\|changes\|issues), media_server (none\|jellyfin\|plex), media_server_url, media_server_token, media_path_map` (string or number/bool values; text keys may be empty to clear) → `{ success: true }` |
| POST | `/api/integrations/test` | body `{ target: "notify" \| "media" }` → `{ ok: true, message }`; `502` with `{ error }` if the endpoint failed. Uses the saved settings |
| POST | `/api/webhook/:source` (`sonarr`, `radarr`, `bazarr`, `generic`; also `/api/webhook`) | Token as `?token=`, `X-Api-Key`, `Authorization: Bearer` or Basic-auth password. Body: a Sonarr/Radarr webhook payload, `{ path }`, `{ paths }`, a form with `path`, or `?path=`. → `{ ok: true, queued: string[], errors: string[] }`, `{ ok: true, ignored }` for events needing no sync, or `{ ok: true, message }` for a Test event. `403` when disabled, `401` bad token, `404` unknown source, `422` when no path resolved. Queued paths start a run after a 5 s quiet period |

## WebSocket `/ws`

On connect the server sends one message:

```json
{ "type": "state", "data": { "currentRun": Run | null, "isRunning": bool, "dryRun": bool, "scanProgress": ScanProgress | null } }
```

After that, events are coalesced and flushed every 100 ms as

```json
{ "type": "batch", "messages": [ ... ] }
```

where each message is one of:

- `{ "type": "run:started",   "data": Run }`
- `{ "type": "run:completed", "data": Run }`
- `{ "type": "run:cancelled", "data": Run }`
- `{ "type": "file:updated",  "data": { "runId", "filePath", "run": Run } }`
- `{ "type": "scan:progress", "data": ScanProgress | null }`

Within one batch, repeated `file:updated` / `scan:progress` messages are
collapsed so only the latest `run` snapshot is sent.
