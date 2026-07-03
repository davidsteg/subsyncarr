# Subsyncarr+ UI Features — Implementation Plan

> **For Hermes:** Implement task-by-task. Each task is self-contained.

**Goal:** 9 UI/backend improvements for Subsyncarr+ v1.3.6

**Architecture:** SPA (HTML/CSS/JS frontend, Express+WS backend, SQLite DB). All UI is in `public/` (index.html, app.js, styles.css). Backend in `src/` (server.ts, database.ts, config.ts).

**Tech Stack:** Vanilla JS, Express, better-sqlite3, WebSocket

---

### Task 1: Hide "Current Run" nav when idle

**Objective:** Only show the "Current Run" sidebar item when `state.isRunning === true`

**Files:** `public/index.html:18`, `public/app.js:33-41,212-217`

**Step 1:** Add `hidden` class to the nav item in HTML:
```html
<button class="nav-item hidden" data-page="run" id="navRun">...Current Run</button>
```

**Step 2:** In `render()` / `updateButtons()`, toggle visibility:
```js
var navRun = document.getElementById('navRun');
if (this.state.isRunning) navRun.classList.remove('hidden');
else navRun.classList.add('hidden');
```

**Step 3:** When `run:started` fires, show it. When `run:completed`/`run:cancelled`, hide it.

---

### Task 2: Settings Page

**Objective:** New page with configurable settings persisted to DB

**Files:** `public/index.html` (new nav item + page), `public/app.js` (new methods), `public/styles.css` (new styles), `src/server.ts` (new API routes), `src/database.ts` (settings table)

**Settings to expose:**
- `MAX_SUBTITLE_SHIFT_MS` (default 30000)
- `CRON_SCHEDULE` (read-only display)
- `INCLUDE_ENGINES` (read-only display)
- `SYNC_RETRY_THRESHOLD_MS` (default 5000)
- `SYNC_MAX_RETRIES` (default 1)
- `CONFIDENCE_THRESHOLD` (new, default 0.7)
- `DRY_RUN` toggle (new, default false)
- Theme preference (already in localStorage, just surface)

**API:** `GET /api/settings` returns current env values. `POST /api/settings` updates runtime config (stored in a `settings` table in SQLite, overrides env vars).

**DB:** New `settings` table: `key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER`

---

### Task 3: Dry-Run & Confidence Scoring

**Objective:** Add `--dry-run` mode that simulates sync without writing files, and confidence threshold that skips low-confidence matches.

**Files:** `src/config.ts`, `src/processingEngine.ts`, `src/coordinator.ts`, `src/generateAlassSubtitles.ts`, `src/generateFfsubsyncSubtitles.ts`

**Dry-Run:** When enabled, engines run normally but the final `renameSync` / `writeFileSync` is skipped. Results are logged as "would sync" with the detected offset.

**Confidence Scoring:** After alass/ffsubsync runs, parse the engine output for confidence indicators:
- alass: uses `--confidence` flag if available, or parse shift magnitude (smaller shift = higher confidence)
- ffsubsync: parse output for confidence score
- If confidence < threshold, mark as `not_fitting` instead of syncing

**Config:** `DRY_RUN=true/false`, `CONFIDENCE_THRESHOLD=0.0-1.0` env vars

---

### Task 4: GPU-Accelerated Docker Images

**Objective:** Add optional CUDA-enabled Dockerfile variant for ffsubsync GPU acceleration

**Files:** `Dockerfile.gpu` (new), `docker-compose.gpu.yaml` (new)

**Approach:** Multi-stage build with `nvidia/cuda:12.4-runtime-ubuntu22.04` base. Install ffsubsync with GPU support (uses CuPy). alass remains CPU-only. Document in README.

---

### Task 5: Cache Dashboard Metrics

**Objective:** Cache `/api/stats` response server-side with 30s TTL to avoid expensive DB queries on every dashboard load

**Files:** `src/server.ts` (cache logic)

**Implementation:** In-memory cache object:
```ts
private statsCache: { data: any; timestamp: number } | null = null;
private STATS_CACHE_TTL_MS = 30_000;
```
On `GET /api/stats`, return cached if fresh, else recompute and cache.

---

### Task 6: Media Detail Page

**Objective:** Click a file in history/folders to see full sync details — all engine results, timestamps, shift values, and a visual waveform comparison

**Files:** `public/index.html` (new page + modal), `public/app.js`, `public/styles.css`, `src/server.ts` (new API)

**API:** `GET /api/media/:filePath(*)` returns:
- All engine_failure_tracking entries for this file
- All file_results across runs for this file
- Shift values from engine outputs
- Language detection

**UI:** Modal/page showing:
- File path, video path
- Per-engine: status, shift detected, duration, last success/failure time
- Timeline of sync attempts across runs
- Simple ASCII/Canvas waveform visualization (optional — can be a placeholder)

---

### Task 7: Minimize Emoji Usage

**Objective:** Replace emojis with text labels and CSS-styled indicators

**Files:** `public/index.html`, `public/app.js`, `public/styles.css`

**Replacements:**
- `🧬` → "SS+" text logo
- `📊` → remove, use text "Dashboard"
- `▶` → CSS triangle
- `📜` → remove
- `📁` → remove
- `🌙` / `☀️` → text "Dark" / "Light"
- `🔍` → "Scanning..."
- `🌐` → "Languages"
- `📋` → "Copy"
- `⏹` → "Stop"
- `📁` in buttons → remove
- `●` / `○` → CSS dot
- `✓` / `⊘` / `✗` / `⚠` → text labels (OK, SK, FAIL, NF)
- `F` in folder rows → CSS folder icon

---

### Task 8: Wrong Subs Recognition

**Objective:** Detect subtitles that don't match the video content using heuristics

**Files:** `src/subtitleValidator.ts` (new), `src/processingEngine.ts`

**Heuristics:**
1. **Shift magnitude:** If detected shift > 60s, likely wrong subs
2. **Cue count mismatch:** If subtitle has 500 cues but video is 2min long, wrong
3. **Language mismatch:** If filename says `.en.srt` but content has non-Latin characters
4. **Timing anomalies:** If first cue starts at 01:00:00 but video is 45min, suspicious
5. **Content sampling:** Sample 5 random cues and check if they contain common subtitle patterns (dialog markers, speaker labels)

**Output:** `wrong_subs_probability` field in file_result, surfaced in UI as warning.

---

### Task 9: Folder Navigation

**Objective:** Make folder rows clickable to drill into subfolders

**Files:** `public/app.js:206-211`, `public/styles.css`, `src/server.ts`, `src/database.ts`

**API:** `GET /api/folders?parent=/media/movies` returns subfolders of that path

**UI:** Click a folder row → fetch subfolders → render breadcrumb + subfolder list. Back button to go up.

**DB:** `getFolderStats(parentPath?: string)` with optional parent filter.

---

## Implementation Order

1. Task 7 (emoji minimization) — touches everything, do first to avoid rework
2. Task 1 (hide Current Run) — simple, high impact
3. Task 5 (cache dashboard) — backend only, quick win
4. Task 2 (settings page) — new page, moderate complexity
5. Task 3 (dry-run + confidence) — backend engine changes
6. Task 9 (folder navigation) — moderate frontend + backend
7. Task 6 (media detail page) — complex, new page + API
8. Task 8 (wrong subs recognition) — new algorithm
9. Task 4 (GPU Docker) — infra, independent

## Verification

After each task: `docker compose build --no-cache && docker compose up -d` then test in browser.
