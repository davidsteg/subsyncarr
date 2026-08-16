import './serverLogBuffer'; // must be first — wraps console.log/warn/error before anything else can log
import { ProcessingEngine } from './processingEngine';
import { StateManager } from './stateManager';
import { ProcessingCoordinator } from './coordinator';
import { SubsyncarrPlusServer } from './server';
import { schedule } from 'node-cron';
import { getRetentionConfig, getScanConfig } from './config';

const DEFAULT_SCAN_PATH = '/scan_dir';

/**
 * Detect the container running with no real SCAN_PATHS configured — the
 * fallback default `/scan_dir` almost never exists in a real deployment, so
 * every scan silently finds 0 files and "completes" doing nothing. This has
 * happened before (e.g. a container restarted via a bare `docker run`/
 * `docker start` that skipped the compose environment: block) and ran
 * unnoticed for over a day, since an empty run looks identical to a healthy
 * one everywhere except the scan path itself.
 */
function isScanPathMisconfigured(): boolean {
  const config = getScanConfig();
  return config.includePaths.length === 1 && config.includePaths[0] === DEFAULT_SCAN_PATH;
}

function warnIfScanPathMisconfigured(loud: boolean): void {
  if (!isScanPathMisconfigured()) return;
  if (loud) {
    console.warn(
      '\n' +
        '='.repeat(78) +
        '\n' +
        `WARNING: SCAN_PATHS is not set — falling back to the default "${DEFAULT_SCAN_PATH}"\n` +
        '='.repeat(78) +
        '\n' +
        'This path almost certainly does not exist in your container. Every scan\n' +
        '(manual or scheduled) will find 0 files and silently "complete" doing\n' +
        'nothing — no errors, just empty runs, possibly for hours or days without\n' +
        'anyone noticing.\n\n' +
        'Fix: set SCAN_PATHS to your actual media mount (e.g. SCAN_PATHS=/media)\n' +
        "in the container's environment and restart. If you use docker-compose,\n" +
        "make sure the container is actually started via 'docker compose up -d'\n" +
        "with your compose file — not a bare 'docker run'/'docker start' that\n" +
        'skips the environment: block.\n' +
        '='.repeat(78),
    );
  } else {
    console.warn(
      `[${new Date().toISOString()}] WARNING: still running with default SCAN_PATHS="${DEFAULT_SCAN_PATH}" — see startup log for details`,
    );
  }
}

async function main() {
  const dbPath = process.env.DB_PATH || '/app/data/subsyncarr-plus.db';
  const port = parseInt(process.env.WEB_PORT || '3000', 10);
  const host = process.env.WEB_HOST || '0.0.0.0';

  console.log(`[${new Date().toISOString()}] Initializing Subsyncarr Plus Server...`);
  warnIfScanPathMisconfigured(true);

  const stateManager = new StateManager(dbPath);

  // Load runtime config overrides from DB (engine timeouts, concurrency)
  try {
    const { loadRuntimeCfgFromDb } = require('./engineRuntime');
    const db = stateManager.getDatabase();
    loadRuntimeCfgFromDb((key: string) => db.getSetting(key));
    console.log(`[${new Date().toISOString()}] Runtime config loaded from DB`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Failed to load runtime config from DB:`, e);
  }
  const engine = new ProcessingEngine();
  const coordinator = new ProcessingCoordinator(engine, stateManager);
  const server = new SubsyncarrPlusServer(coordinator, stateManager);

  // Start HTTP server
  server.start(port, host);

  // Setup cron scheduler for automatic runs
  const cronSchedule = process.env.CRON_SCHEDULE || '0 0 * * *';

  if (cronSchedule !== 'disabled') {
    schedule(cronSchedule, async () => {
      console.log(`[${new Date().toISOString()}] Starting scheduled run (${cronSchedule})`);
      try {
        await coordinator.startRun();
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Scheduled run failed:`, error);
      }
    });

    console.log(`[${new Date().toISOString()}] Scheduled runs: ${cronSchedule}`);
  } else {
    console.log(`[${new Date().toISOString()}] Automatic scheduling disabled`);
  }

  // Setup periodic database cleanup
  const retentionConfig = getRetentionConfig();
  const cleanupIntervalMs = retentionConfig.cleanupIntervalHours * 60 * 60 * 1000;

  setInterval(() => {
    console.log(`[${new Date().toISOString()}] Running database cleanup...`);

    const db = stateManager.getDatabase();
    const logFileManager = stateManager.getLogFileManager();

    // Trim old logs first (database field is now unused but kept for compatibility)
    const trimmed = db.trimOldLogs(retentionConfig.trimLogsDays, retentionConfig.maxLogSizeBytes);
    if (trimmed > 0) {
      console.log(`[${new Date().toISOString()}] Trimmed logs for ${trimmed} runs`);
    }

    // Delete old log files
    const deletedLogFiles = logFileManager.deleteOldLogs(retentionConfig.keepRunsDays);
    if (deletedLogFiles > 0) {
      console.log(`[${new Date().toISOString()}] Deleted ${deletedLogFiles} old log files`);
    }

    // Delete very old runs
    const deleted = db.deleteOldRuns(retentionConfig.keepRunsDays);
    if (deleted > 0) {
      console.log(`[${new Date().toISOString()}] Deleted ${deleted} old runs`);
      db.vacuum(); // Reclaim space
      console.log(`[${new Date().toISOString()}] Database vacuumed`);
    }

    const stats = db.getDatabaseStats();
    console.log(`[${new Date().toISOString()}] Database size: ${(stats.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  }, cleanupIntervalMs);

  // Run cleanup on startup after 5 seconds
  setTimeout(() => {
    console.log(`[${new Date().toISOString()}] Running initial database cleanup...`);
    const db = stateManager.getDatabase();
    const logFileManager = stateManager.getLogFileManager();
    db.trimOldLogs(retentionConfig.trimLogsDays, retentionConfig.maxLogSizeBytes);
    logFileManager.deleteOldLogs(retentionConfig.keepRunsDays);
    db.deleteOldRuns(retentionConfig.keepRunsDays);
    db.vacuum();
  }, 5000);

  // Trigger a scan on startup to strip legacy # synced: headers.
  // The scan in findAllSrtFiles already handles header stripping as part of
  // its normal pass — no need for a separate walk. This runs once, shortly
  // after boot, so headers are cleaned before the next scheduled cron run.
  if (!isScanPathMisconfigured()) {
    setTimeout(async () => {
      console.log(`[${new Date().toISOString()}] Starting startup scan (legacy header cleanup)...`);
      try {
        await coordinator.startRun();
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Startup scan failed:`, error);
      }
    }, 8000);
  }

  // Log memory usage periodically (also re-warns about scan-path
  // misconfiguration, so it can't just scroll off after the startup banner)
  setInterval(
    () => {
      const usage = process.memoryUsage();
      console.log(
        `[${new Date().toISOString()}] Memory: RSS=${(usage.rss / 1024 / 1024).toFixed(1)}MB, Heap=${(usage.heapUsed / 1024 / 1024).toFixed(1)}MB/${(usage.heapTotal / 1024 / 1024).toFixed(1)}MB`,
      );
      warnIfScanPathMisconfigured(false);
    },
    5 * 60 * 1000,
  ); // Every 5 minutes

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log(`[${new Date().toISOString()}] SIGTERM received, shutting down gracefully...`);
    server.close();
    stateManager.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
