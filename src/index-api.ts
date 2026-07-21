// Public-facing API process (one half of the two-process split; see
// supervisor.sh and index-worker semantics in the Dockerfile).
//
// Why this exists: better-sqlite3 is synchronous, so a heavy dashboard query
// used to block the same event loop that drives the sync engine — a big
// /api/status or /api/history read could stall an active run for tens of
// seconds. This process serves those heavy reads from its OWN read-only
// SQLite connection (WAL lets it read the worker's committed writes without
// blocking the worker), and reverse-proxies everything stateful — control
// POSTs, the live WebSocket, and the worker-local log buffer — to the worker.
//
// The worker runs the unchanged single-process server (index-server.js) on an
// internal, localhost-only port; it remains the sole writer and the only
// process that touches media files.

import './serverLogBuffer'; // wrap console.* before anything logs
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { join } from 'path';
import { StateManager } from './stateManager';

const dbPath = process.env.DB_PATH || '/app/data/subsyncarr-plus.db';
const port = parseInt(process.env.WEB_PORT || '3000', 10);
const host = process.env.WEB_HOST || '0.0.0.0';
const workerPort = parseInt(process.env.WORKER_PORT || '3001', 10);
const WORKER_HTTP = `http://127.0.0.1:${workerPort}`;
const WORKER_WS = `ws://127.0.0.1:${workerPort}/ws`;

// Read-only DB view — no migrations, no incomplete-run cleanup (worker's job).
const stateManager = new StateManager(dbPath, { skipInit: true });
const db = stateManager.getDatabase();

const app = express();
app.use(express.json());

// Runtime state (isRunning / dryRun / scanProgress / the current run object)
// lives in the worker's memory, not the DB. Poll the worker's cheap brief
// status once a second and cache it, so our local /api/status can report it
// without a per-request round-trip.
let runtime: {
  currentRun: unknown | null;
  isRunning: boolean;
  dryRun: boolean;
  scanProgress: unknown | null;
} = { currentRun: null, isRunning: false, dryRun: false, scanProgress: null };

async function pollRuntime(): Promise<void> {
  try {
    const r = await fetch(`${WORKER_HTTP}/api/status?brief=true`);
    if (!r.ok) return;
    const d = (await r.json()) as {
      currentRun: unknown;
      isRunning: boolean;
      dryRun: boolean;
      scanProgress: unknown;
    };
    runtime = {
      currentRun: d.currentRun ?? null,
      isRunning: !!d.isRunning,
      dryRun: !!d.dryRun,
      scanProgress: d.scanProgress ?? null,
    };
  } catch {
    // worker briefly unreachable (starting up / restarting) — keep last known
  }
}
setInterval(pollRuntime, 1000);
void pollRuntime();

// Small cache for the media-stats aggregate (same intent as the worker's own
// stats cache — it's a full-table scan). Kept short so the dashboard stays live.
let statsCache: { data: unknown; ts: number } | null = null;
const STATS_TTL_MS = 10_000;

// ---- Heavy reads served locally (the ones that used to block the worker) ----

app.get('/api/status', (req, res) => {
  const brief = req.query.brief === 'true';
  const currentRun = runtime.currentRun as { id: string; total_files: number } | null;
  let files: unknown[] = [];
  let totalFiles = 0;
  if (!brief && currentRun) {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 1000);
    try {
      files = db.getActiveAndRecentFiles(currentRun.id, limit);
      totalFiles = currentRun.total_files;
    } catch {
      files = [];
    }
  }
  res.json({
    currentRun,
    scanProgress: runtime.scanProgress,
    files,
    totalFiles,
    isRunning: runtime.isRunning,
    dryRun: runtime.dryRun,
  });
});

app.get('/api/stats', (_req, res) => {
  const now = Date.now();
  if (statsCache && now - statsCache.ts < STATS_TTL_MS) return res.json(statsCache.data);
  try {
    const stats = db.getMediaStats();
    statsCache = { data: stats, ts: now };
    res.json(stats);
  } catch {
    res.json({});
  }
});

app.get('/api/folders', (req, res) => {
  const parent = req.query.parent as string | undefined;
  try {
    res.json(db.getFolderStats(parent || undefined));
  } catch {
    res.json([]);
  }
});

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 50;
  try {
    res.json(db.getRunHistory(limit));
  } catch {
    res.json([]);
  }
});

app.get('/api/runs/:id/files', (req, res) => {
  const requestedId = req.params.id;
  const rawStatus = req.query.status as string | undefined;
  const status =
    rawStatus && ['pending', 'processing', 'completed', 'skipped', 'error', 'not_fitting'].includes(rawStatus)
      ? rawStatus
      : undefined;
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 500, 5000);
  const offset = (page - 1) * limit;

  try {
    if (!db.getRun(requestedId)) return res.status(404).json({ error: 'Run not found' });
    const result = db.getFileResultsPaginated(requestedId, limit, offset, status);
    res.json({ ...result, page, limit, totalPages: Math.ceil(result.total / limit) });
  } catch {
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/runs/:id', (req, res) => {
  const requestedId = req.params.id;
  try {
    const run = db.getRun(requestedId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 500, 5000);
    const result = db.getFileResultsPaginated(requestedId, limit, 0);
    res.json({ run, files: result.files, totalFiles: result.total });
  } catch {
    res.status(500).json({ error: 'query failed' });
  }
});

// ---- Everything else proxies to the worker ----
// Control POSTs (start/stop/skip/settings/reset/clear), plus the reads whose
// source of truth is the worker's process (config, version, settings, the
// worker-local log buffer, per-run log files, media/skip-status detail).
async function proxy(req: express.Request, res: express.Response): Promise<void> {
  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const upstream = await fetch(`${WORKER_HTTP}${req.originalUrl}`, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.set('content-type', ct);
    res.send(text);
  } catch {
    res.status(502).json({ error: 'worker unavailable' });
  }
}
app.all('/api/*', proxy);

// Static UI last, so /api/* is matched first.
app.use(express.static(join(__dirname, '../public')));

const server = createServer(app);

// ---- WebSocket: transparently proxy the browser <-> worker so live updates
// stay event-driven (no re-polling), sourced from the worker's real broadcasts.
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (client) => {
  const upstream = new WebSocket(WORKER_WS);
  const pending: string[] = [];

  upstream.on('open', () => {
    for (const m of pending) upstream.send(m);
    pending.length = 0;
  });
  upstream.on('message', (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data.toString());
  });
  upstream.on('close', () => {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  });
  upstream.on('error', () => {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  });

  client.on('message', (data) => {
    const msg = data.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
    else pending.push(msg);
  });
  client.on('close', () => {
    try {
      upstream.close();
    } catch {
      /* ignore */
    }
  });
});

server.listen(port, host, () => {
  console.log(`[${new Date().toISOString()}] API server on http://${host}:${port} — proxying control to ${WORKER_HTTP}`);
});

process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] SIGTERM received, API server shutting down...`);
  server.close();
  stateManager.close();
  process.exit(0);
});
