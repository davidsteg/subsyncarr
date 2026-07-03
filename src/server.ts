import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { ProcessingCoordinator } from './coordinator';
import { StateManager } from './stateManager';
import { Run } from './database';
import { join } from 'path';
import { readFileSync } from 'fs';
import { getScanConfig } from './config';
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

  // Stats cache to avoid expensive DB queries on every dashboard load
  private statsCache: { data: unknown; timestamp: number } | null = null;
  private static readonly STATS_CACHE_TTL_MS = 30_000;

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
        releaseUrl: `https://github.com/davidsteg/subsyncarr/releases/tag/${version}`,
      });
    });

    // Media stats
    this.app.get('/api/stats', (_req, res) => {
      const stats = this.stateManager.getDatabase().getMediaStats();
      res.json(stats);
    });

    // Folder tree with optional sub-path drill-down
    this.app.get('/api/folders', (req, res) => {
      const subPath = req.query.path as string | undefined;
      const folders = this.stateManager.getDatabase().getFolderStats(subPath);
      res.json(folders);
    });

    // Get current status
    // API version info
    this.app.get('/api/version', (req, res) => {
      const fs = require('fs');
      const path = require('path');
      let version = 'unknown';
      try {
        version = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
      } catch {}
      res.json({
        version,
        repo: 'davidsteg/subsyncarr',
        releaseUrl: `https://github.com/davidsteg/subsyncarr/releases/tag/${version}`,
      });
    });

    // Media stats (cached, 30s TTL)
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
      console.log(`[${new Date().toISOString()}] GET /api/status`);
      const currentRun = this.stateManager.getCurrentRun();
      const scanProgress = this.coordinator.getScanProgress();
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 500, 5000);
      const result = currentRun ? this.stateManager.getFileResultsPaginated(currentRun.id, limit, 0) : null;
      res.json({
        currentRun,
        scanProgress,
        files: result?.files || [],
        totalFiles: result?.total || 0,
        isRunning: this.coordinator.isRunning(),
      });
    });

    // Get run history
    this.app.get('/api/history', (req, res) => {
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const includeFiles = req.query.include_files === 'true';
      console.log(`[${new Date().toISOString()}] GET /api/history (limit: ${limit}, include_files: ${includeFiles})`);

      const runs = this.stateManager.getRunHistory(limit);

      if (includeFiles) {
        // Include file results for each run to avoid N+1 queries from the frontend
        const runsWithFiles = runs.map((run) => {
          const fileLimit = 500;
          const result = this.stateManager.getFileResultsPaginated(run.id, fileLimit, 0);
          return { ...run, files: result.files };
        });
        res.json(runsWithFiles);
      } else {
        res.json(runs);
      }
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

    // Get paginated file results for a run
    this.app.get('/api/runs/:id/files', (req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/runs/${req.params.id}/files`);
      const requestedId = req.params.id;
      const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 500, 5000);
      const offset = (page - 1) * limit;

      const currentRun = this.stateManager.getCurrentRun();
      const history = this.stateManager.getRunHistory(1000);
      const run = currentRun?.id === requestedId ? currentRun : history.find((r) => r.id === requestedId);

      if (!run) {
        return res.status(404).json({ error: 'Run not found' });
      }

      const result = this.stateManager.getFileResultsPaginated(requestedId, limit, offset);
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

    // Start a new run
    this.app.post('/api/run/start', async (req, res) => {
      const { paths } = req.body;
      console.log(
        `[${new Date().toISOString()}] POST /api/run/start${paths ? ` (custom paths: ${paths.join(', ')})` : ' (default paths)'}`,
      );

      try {
        if (this.coordinator.isRunning()) {
          console.log(`[${new Date().toISOString()}] Request rejected: Run already in progress`);
          return res.status(409).json({ error: 'A run is already in progress' });
        }

        const config = paths ? { includePaths: paths, excludePaths: [] } : undefined;

        const runId = await this.coordinator.startRun(config);
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
        syncMaxRetries: parseInt(dbSettings['sync_max_retries'] || process.env.SYNC_MAX_RETRIES || '1', 10),
        confidenceThreshold: parseFloat(dbSettings['confidence_threshold'] || process.env.CONFIDENCE_THRESHOLD || '0.7'),
        dryRun: (dbSettings['dry_run'] || process.env.DRY_RUN || 'false') === 'true',
        cronSchedule: process.env.CRON_SCHEDULE || '0 0 * * *',
        includeEngines: process.env.INCLUDE_ENGINES || 'alass,ffsubsync',
        theme: dbSettings['theme'] || 'light',
      });
    });

    this.app.post('/api/settings', (req, res) => {
      const db = this.stateManager.getDatabase();
      const updates = req.body;
      const allowedKeys = [
        'max_subtitle_shift_ms', 'sync_retry_threshold_ms', 'sync_max_retries',
        'confidence_threshold', 'dry_run', 'theme'
      ];
      for (const [key, value] of Object.entries(updates)) {
        if (allowedKeys.includes(key)) {
          db.setSetting(key, String(value));
        }
      }
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
      this.broadcast({ type: 'run:completed', data: run });
    });

    this.stateManager.on('run:cancelled', (run) => {
      console.log(`[${new Date().toISOString()}] Broadcasting run:cancelled to ${this.clients.size} clients`);
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
