import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { ProcessingCoordinator } from './coordinator';
import { StateManager } from './stateManager';
import { Run } from './database';
import { join } from 'path';
import { readFileSync } from 'fs';
import { getScanConfig } from './config';
import { getRecentServerLogs, getServerLogBufferInfo } from './serverLogBuffer';
import cronstrue from 'cronstrue';
import parseExpression from 'cron-parser';

export class SubsyncarrPlusServer {
  private app = express();
  private httpServer = createServer(this.app);
  private wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
  private clients: Set<WebSocket> = new Set();

  // Batched broadcast: collect updates and send in batches every 100ms
  private broadcastQueue: unknown[] = [];
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BROADCAST_INTERVAL_MS = 100;

  // Stats cache to avoid expensive DB queries on every dashboard load.
  // Kept below the client's 15s dashboard poll interval (app.js) so every
  // poll actually surfaces fresh data instead of roughly half of them
  // hitting a still-stale cache entry.
  private statsCache: { data: unknown; timestamp: number } | null = null;
  private static readonly STATS_CACHE_TTL_MS = 12_000;

  constructor(
    private coordinator: ProcessingCoordinator,
    private stateManager: StateManager,
  ) {
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.static(join(__dirname, '../public')));
  }

  private setupRoutes() {
    // Get configuration status
    this.app.get('/api/config', (req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/config`);
      const config = getScanConfig();
      const isDefaultPath = config.includePaths.length === 1 && config.includePaths[0] === '/scan_dir';

      // Get cron schedule info
      const cronSchedule = process.env.CRON_SCHEDULE || '0 0 * * *';
      let scheduleDescription = '';
      let nextRun = null;

      if (cronSchedule !== 'disabled') {
        try {
          scheduleDescription = cronstrue.toString(cronSchedule);
          const interval = parseExpression.parse(cronSchedule);
          nextRun = interval.next().toDate().getTime();
        } catch (error) {
          console.error('Error parsing cron schedule:', error);
          scheduleDescription = cronSchedule;
        }
      }

      res.json({
        paths: config.includePaths,
        excludePaths: config.excludePaths,
        isConfigured: !isDefaultPath,
        schedule: {
          enabled: cronSchedule !== 'disabled',
          cron: cronSchedule,
          description: scheduleDescription,
          nextRun: nextRun,
        },
      });
    });

    // API version info
    this.app.get('/api/version', (_req, res) => {
      let version = 'unknown';
      try {
        version = readFileSync(join(__dirname, '..', 'VERSION'), 'utf8').trim();
      } catch {}
      res.json({
        version,
        repo: 'davidsteg/subsyncarr',
        releaseUrl: `https://github.com/davidsteg/subsyncarr/releases/tag/${version}`,
      });
    });

    // Media stats (cached; TTL kept below the client's poll interval so every poll gets fresh data)
    this.app.get('/api/stats', (req, res) => {
      const now = Date.now();
      if (this.statsCache && (now - this.statsCache.timestamp) < SubsyncarrPlusServer.STATS_CACHE_TTL_MS) {
        return res.json(this.statsCache.data);
      }
      const stats = this.stateManager.getDatabase().getMediaStats();
      this.statsCache = { data: stats, timestamp: now };
      res.json(stats);
    });

    // Folder tree with progress (optional ?parent= path for drill-down)
    this.app.get('/api/folders', (req, res) => {
      const parent = req.query.parent as string | undefined;
      const folders = this.stateManager.getDatabase().getFolderStats(parent || undefined);
      res.json(folders);
    });

    this.app.get('/api/status', (req, res) => {
      const brief = req.query.brief === 'true';
      if (!brief) console.log(`[${new Date().toISOString()}] GET /api/status`);
      const currentRun = this.stateManager.getCurrentRun();
      const scanProgress = this.coordinator.getScanProgress();
      let files: any[] = [];
      let totalFiles = 0;
      if (!brief && currentRun) {
        const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 1000);
        const result = this.stateManager.getFileResultsPaginated(currentRun.id, limit, 0);
        files = result?.files || [];
        totalFiles = result?.total || 0;
      }
      res.json({
        currentRun: brief && currentRun ? {
          id: currentRun.id,
          start_time: currentRun.start_time,
          total_files: currentRun.total_files,
          completed: currentRun.completed,
          skipped: currentRun.skipped,
          failed: currentRun.failed,
          not_fitting: currentRun.not_fitting,
          total_engines: currentRun.total_engines,
          completed_engines: currentRun.completed_engines,
          status: currentRun.status,
        } : currentRun,
        scanProgress,
        files,
        totalFiles,
        isRunning: this.coordinator.isRunning(),
        dryRun: this.coordinator.isDryRun(),
      });
    });

    // Get run history
    this.app.get('/api/history', (req, res) => {
      const limit = parseInt(req.query.limit as string, 10) || 50;
      console.log(`[${new Date().toISOString()}] GET /api/history (limit: ${limit})`);

      const runs = this.stateManager.getRunHistory(limit);
      res.json(runs);
    });

    // Get specific run details (latest files only — use paginated endpoint for full list)
    this.app.get('/api/runs/:id', (req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/runs/${req.params.id}`);
      const currentRun = this.stateManager.getCurrentRun();
      const requestedId = req.params.id;

      let run: Run | null = null;
      if (currentRun && currentRun.id === requestedId) {
        run = currentRun;
      } else {
        const history = this.stateManager.getRunHistory(1000);
        run = history.find((r) => r.id === requestedId) || null;
      }

      if (!run) {
        return res.status(404).json({ error: 'Run not found' });
      }

      const limit = Math.min(parseInt(req.query.limit as string, 10) || 500, 5000);
      const result = this.stateManager.getFileResultsPaginated(requestedId, limit, 0);
      res.json({
        run,
        files: result.files,
        totalFiles: result.total,
      });
    });

    // Get paginated file results for a run, optionally filtered by status.
    // Filtering happens in SQL (see getFileResultsPaginated) so total/totalPages
    // reflect the true count for that status, not just the first page fetched.
    this.app.get('/api/runs/:id/files', (req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/runs/${req.params.id}/files`);
      const requestedId = req.params.id;
      const rawStatus = req.query.status as string | undefined;
      const status = rawStatus && ['pending', 'processing', 'completed', 'skipped', 'error', 'not_fitting'].includes(rawStatus)
        ? rawStatus
        : undefined;
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 500, 5000);
      const offset = (page - 1) * limit;

      const currentRun = this.stateManager.getCurrentRun();
      const history = this.stateManager.getRunHistory(1000);
      const run = currentRun?.id === requestedId ? currentRun : history.find((r) => r.id === requestedId);

      if (!run) {
        return res.status(404).json({ error: 'Run not found' });
      }

      const result = this.stateManager.getFileResultsPaginated(requestedId, limit, offset, status);
      res.json({
        ...result,
        page,
        limit,
        totalPages: Math.ceil(result.total / limit),
      });
    });

    // Get logs for a specific run
    this.app.get('/api/runs/:id/logs', (req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/runs/${req.params.id}/logs`);
      const requestedId = req.params.id;

      // Check if run exists (current or historical)
      const currentRun = this.stateManager.getCurrentRun();
      const history = this.stateManager.getRunHistory(1000);
      const run = currentRun?.id === requestedId ? currentRun : history.find((r) => r.id === requestedId);

      if (!run) {
        return res.status(404).json({ error: 'Run not found' });
      }

      // Read logs from file
      const logs = this.stateManager.getRunLogs(requestedId);
      res.json({ logs });
    });

    // Global server logs — everything the process has console.log/warn/error'd
    // (startup, route access, scheduled cleanup, errors), not just one run's
    // processing output. Meant for remote debugging without needing to pull
    // raw container/stdout logs by hand.
    this.app.get('/api/logs', (req, res) => {
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 500, 5000);
      const level = (['all', 'log', 'warn', 'error'].includes(req.query.level as string)
        ? (req.query.level as 'all' | 'log' | 'warn' | 'error')
        : 'all');
      const search = req.query.search as string | undefined;
      const since = req.query.since !== undefined ? parseInt(req.query.since as string, 10) : undefined;

      const entries = getRecentServerLogs({ limit, level, search, since: isNaN(since as number) ? undefined : since });

      if (req.query.format === 'text') {
        const text = entries
          .map((e) => `[${new Date(e.timestamp).toISOString()}] ${e.level.toUpperCase()}: ${e.message}`)
          .join('\n');
        res.type('text/plain').send(text);
      } else {
        res.json({ ...getServerLogBufferInfo(), logs: entries });
      }
    });

    // Start a new run
    this.app.post('/api/run/start', async (req, res) => {
      const { paths, dryRun } = req.body;
      console.log(
        `[${new Date().toISOString()}] POST /api/run/start${paths ? ` (custom paths: ${paths.join(', ')})` : ' (default paths)'}${dryRun ? ' [DRY RUN]' : ''}`,
      );

      try {
        if (this.coordinator.isRunning()) {
          console.log(`[${new Date().toISOString()}] Request rejected: Run already in progress`);
          return res.status(409).json({ error: 'A run is already in progress' });
        }

        const config = paths ? { includePaths: paths, excludePaths: [] } : undefined;

        // Explicit dryRun:true forces a dry run; otherwise fall back to the
        // saved setting / DRY_RUN env inside the coordinator.
        const runId = await this.coordinator.startRun(config, { dryRun: dryRun === true ? true : undefined });
        res.json({ runId });
      } catch (error) {
        console.log(
          `[${new Date().toISOString()}] Error starting run: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Stop current run
    this.app.post('/api/run/stop', (_req, res) => {
      console.log(`[${new Date().toISOString()}] POST /api/run/stop`);
      try {
        this.coordinator.stopRun();
        res.json({ success: true });
      } catch (error) {
        console.log(
          `[${new Date().toISOString()}] Error stopping run: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Skip a file
    this.app.post('/api/file/skip', (req, res) => {
      const { filePath } = req.body;

      if (!filePath) {
        console.log(`[${new Date().toISOString()}] POST /api/file/skip - Missing filePath`);
        return res.status(400).json({ error: 'filePath required' });
      }

      console.log(`[${new Date().toISOString()}] POST /api/file/skip - ${filePath.split('/').pop()}`);
      this.coordinator.skipFile(filePath);
      res.json({ success: true });
    });

    // Clear completed files
    this.app.post('/api/files/clear', (req, res) => {
      console.log(`[${new Date().toISOString()}] POST /api/files/clear`);
      this.stateManager.clearCompletedFiles();

      // Broadcast updated state to all clients
      const currentRun = this.stateManager.getCurrentRun();
      this.broadcast({
        type: 'files:cleared',
        data: {
          currentRun,
          files: [],
        },
      });

      res.json({ success: true });
    });

    // Get skip status statistics
    this.app.get('/api/skip-status', (_req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/skip-status`);
      const stats = this.stateManager.getFailureStats();
      res.json(stats);
    });

    // Get skip status for specific file
    this.app.get('/api/skip-status/:filePath(*)', (req, res) => {
      const filePath = decodeURIComponent(req.params.filePath);
      console.log(`[${new Date().toISOString()}] GET /api/skip-status/${filePath.split('/').pop()}`);

      const skippedEngines = this.stateManager.getSkippedEngines(filePath);
      res.json({ filePath, skippedEngines });
    });

    // Reset skip status for a file
    this.app.post('/api/skip-status/reset', (req, res) => {
      const { filePath, engine } = req.body;

      if (!filePath) {
        return res.status(400).json({ error: 'filePath required' });
      }

      console.log(
        `[${new Date().toISOString()}] POST /api/skip-status/reset - ${filePath.split('/').pop()}${engine ? ` (${engine})` : ' (all engines)'}`,
      );

      this.stateManager.resetSkipStatus(filePath, engine);
      res.json({ success: true });
    });

    // Media detail — full sync history for a specific file
    this.app.get('/api/media/:filePath(*)', (req, res) => {
      const filePath = decodeURIComponent(req.params.filePath);
      console.log(`[${new Date().toISOString()}] GET /api/media/${filePath.split('/').pop()}`);
      const detail = this.stateManager.getDatabase().getMediaDetail(filePath);
      res.json(detail);
    });

    // Settings API
    this.app.get('/api/settings', (req, res) => {
      const dbSettings = this.stateManager.getDatabase().getAllSettings();
      res.json({
        maxSubtitleShiftMs: parseInt(dbSettings['max_subtitle_shift_ms'] || process.env.MAX_SUBTITLE_SHIFT_MS || '30000', 10),
        syncRetryThresholdMs: parseInt(dbSettings['sync_retry_threshold_ms'] || process.env.SYNC_RETRY_THRESHOLD_MS || '5000', 10),
        syncMaxRetries: parseInt(dbSettings['sync_max_retries'] || process.env.SYNC_MAX_RETRIES || '2', 10),
        engineAgreementThresholdMs: parseInt(dbSettings['engine_agreement_threshold_ms'] || process.env.ENGINE_AGREEMENT_THRESHOLD_MS || '5000', 10),
        notFittingDeleteThreshold: parseInt(dbSettings['not_fitting_delete_threshold'] || process.env.NOT_FITTING_DELETE_THRESHOLD || '3', 10),
        engineTimeouts: {
          alass: parseInt(dbSettings['engine_timeout_alass'] || process.env.ALASS_TIMEOUT_MS || '300000', 10),
          ffsubsync: parseInt(dbSettings['engine_timeout_ffsubsync'] || process.env.FFSUBSYNC_TIMEOUT_MS || '300000', 10),
          autosubsync: parseInt(dbSettings['engine_timeout_autosubsync'] || process.env.AUTOSUBSYNC_TIMEOUT_MS || '300000', 10),
        },
        maxConcurrentTasks: parseInt(dbSettings['max_concurrent_tasks'] || process.env.MAX_CONCURRENT_SYNC_TASKS || '1', 10),
        defaultEngine: process.env.DEFAULT_ENGINE || 'alass',
        fallbackEngine: process.env.FALLBACK_ENGINE || 'ffsubsync',
        dryRun: (dbSettings['dry_run'] || process.env.DRY_RUN || 'false') === 'true',
        cronSchedule: process.env.CRON_SCHEDULE || '0 0 * * *',
        includeEngines: process.env.INCLUDE_ENGINES || 'alass,ffsubsync',
        theme: dbSettings['theme'] || 'light',
      });
    });

    this.app.post('/api/settings', (req, res) => {
      const db = this.stateManager.getDatabase();
      const updates_raw = req.body;
      const allowedKeys = [
        'max_subtitle_shift_ms', 'sync_retry_threshold_ms', 'sync_max_retries',
        'default_engine', 'fallback_engine', 'dry_run', 'theme',
        'engine_timeout_alass', 'engine_timeout_ffsubsync', 'engine_timeout_autosubsync',
        'max_concurrent_tasks', 'engine_agreement_threshold_ms', 'not_fitting_delete_threshold'
      ];
      for (const [key, value] of Object.entries(updates_raw)) {
        if (allowedKeys.includes(key)) {
          db.setSetting(key, String(value));
        }
      }
      // Update runtime config for engine code (timeouts, concurrency)
      try {
        const { updateRuntimeCfg } = require('./engineRuntime');
        const updates: any = {};
        if (updates_raw['max_concurrent_tasks']) updates.maxConcurrentTasks = parseInt(updates_raw['max_concurrent_tasks'], 10);
        if (updates_raw['engine_agreement_threshold_ms']) updates.engineAgreementThresholdMs = parseInt(updates_raw['engine_agreement_threshold_ms'], 10);
        if (updates_raw['not_fitting_delete_threshold']) updates.notFittingDeleteThreshold = parseInt(updates_raw['not_fitting_delete_threshold'], 10);
        const timeouts: any = {};
        if (updates_raw['engine_timeout_alass']) timeouts.alass = parseInt(updates_raw['engine_timeout_alass'], 10);
        if (updates_raw['engine_timeout_ffsubsync']) timeouts.ffsubsync = parseInt(updates_raw['engine_timeout_ffsubsync'], 10);
        if (updates_raw['engine_timeout_autosubsync']) timeouts.autosubsync = parseInt(updates_raw['engine_timeout_autosubsync'], 10);
        if (Object.keys(timeouts).length > 0) updates.engineTimeouts = timeouts;
        if (Object.keys(updates).length > 0) updateRuntimeCfg(updates);
      } catch (e) { console.error('Failed to update runtime config:', e); }
      // Invalidate stats cache when settings change
      this.statsCache = null;
      res.json({ success: true });
    });
  }

  private setupWebSocket() {
    // Ping clients every 30s to keep connections alive through proxies/load balancers
    const pingInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(pingInterval);
    });

    this.wss.on('connection', (ws) => {
      console.log(`[${new Date().toISOString()}] WebSocket client connected (total: ${this.clients.size + 1})`);
      this.clients.add(ws);

      // Send initial state (without file list to avoid OOM with large libraries)
      const currentRun = this.stateManager.getCurrentRun();
      ws.send(
        JSON.stringify({
          type: 'state',
          data: {
            currentRun,
            isRunning: this.coordinator.isRunning(),
            dryRun: this.coordinator.isDryRun(),
          },
        }),
      );

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[${new Date().toISOString()}] WebSocket client disconnected (total: ${this.clients.size})`);
      });
    });

    // Broadcast state changes to all clients
    this.stateManager.on('run:started', (run) => {
      console.log(`[${new Date().toISOString()}] Broadcasting run:started to ${this.clients.size} clients`);
      this.broadcast({ type: 'run:started', data: run });
    });

    this.stateManager.on('run:completed', (run) => {
      console.log(`[${new Date().toISOString()}] Broadcasting run:completed to ${this.clients.size} clients`);
      // Dashboard media stats (synced/skipped/pending counts) are cached for
      // 30s — without this, they'd keep showing mid-run numbers for up to
      // that long after the run actually finished.
      this.statsCache = null;
      this.broadcast({ type: 'run:completed', data: run });
    });

    this.stateManager.on('run:cancelled', (run) => {
      console.log(`[${new Date().toISOString()}] Broadcasting run:cancelled to ${this.clients.size} clients`);
      this.statsCache = null;
      this.broadcast({ type: 'run:cancelled', data: run });
    });

    this.stateManager.on('file:updated', ({ runId, filePath, run }) => {
      this.broadcast({ type: 'file:updated', data: { runId, filePath, run } });
    });
  }

  private broadcast(message: unknown) {
    this.broadcastQueue.push(message);

    // If no timer is running, start one to flush the batch
    if (!this.broadcastTimer) {
      this.broadcastTimer = setTimeout(() => {
        this.flushBroadcastQueue();
      }, SubsyncarrPlusServer.BROADCAST_INTERVAL_MS);
    }
  }

  private flushBroadcastQueue() {
    this.broadcastTimer = null;

    if (this.broadcastQueue.length === 0) return;

    // Batch all queued messages into a single WebSocket message
    const batch = this.broadcastQueue;
    this.broadcastQueue = [];

    const data = JSON.stringify({ type: 'batch', messages: batch });
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  start(port: number = 3000, host: string = '0.0.0.0') {
    this.httpServer.listen(port, host, () => {
      console.log(`[${new Date().toISOString()}] Subsyncarr Plus UI available at http://${host}:${port}`);
    });
  }

  close() {
    // Flush any remaining broadcast messages before closing
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.flushBroadcastQueue();

    this.httpServer.close();
    this.wss.close();
  }
}