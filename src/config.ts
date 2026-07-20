export interface ScanConfig {
  includePaths: string[];
  excludePaths: string[];
}

export interface RetentionConfig {
  keepRunsDays: number; // Keep complete runs for N days
  trimLogsDays: number; // Trim logs after N days
  maxLogSizeBytes: number; // Max size for trimmed logs
  cleanupIntervalHours: number; // How often to run cleanup
}

function validatePath(path: string): boolean {
  // Add any path validation logic you need
  return path.startsWith('/') && !path.includes('..');
}

export function getScanConfig(): ScanConfig {
  const scanPaths = process.env.SCAN_PATHS?.split(',').filter(Boolean) || ['/scan_dir'];
  const excludePaths = process.env.EXCLUDE_PATHS?.split(',').filter(Boolean) || [];

  // Validate paths
  const validIncludePaths = scanPaths.filter((path) => {
    const isValid = validatePath(path);
    if (!isValid) {
      console.warn(`${new Date().toLocaleString()} Invalid include path: ${path}`);
    }
    return isValid;
  });

  const validExcludePaths = excludePaths.filter((path) => {
    const isValid = validatePath(path);
    if (!isValid) {
      console.warn(`${new Date().toLocaleString()} Invalid exclude path: ${path}`);
    }
    return isValid;
  });

  if (validIncludePaths.length === 0) {
    console.warn(`${new Date().toLocaleString()} No valid scan paths provided, defaulting to /scan_dir`);
    validIncludePaths.push('/scan_dir');
  }

  console.log(`${new Date().toLocaleString()} Scan configuration:`, {
    includePaths: validIncludePaths,
    excludePaths: validExcludePaths,
  });

  return {
    includePaths: validIncludePaths,
    excludePaths: validExcludePaths,
  };
}

export interface EngineChainConfig {
  /** Primary engine to use (default: alass) */
  defaultEngine: string;
  /** Fallback engine if default fails (default: ffsubsync) */
  fallbackEngine: string;
}

export function getEngineChainConfig(): EngineChainConfig {
  return {
    defaultEngine: process.env.DEFAULT_ENGINE || 'alass',
    fallbackEngine: process.env.FALLBACK_ENGINE || 'ffsubsync',
  };
}

/**
 * Max time difference (ms) allowed between the two engines' aligned outputs for
 * the subtitle to count as "fitting" the video. If both engines independently
 * land within this distance of each other, the subtitle is kept; if they
 * disagree by more, it's judged unfit and deleted. Default: 5000 (5s).
 */
export function getEngineAgreementThresholdMs(): number {
  // Runtime config (set via UI) takes precedence over env var
  try {
    const { getRuntimeCfg } = require('./engineRuntime');
    const cfg = getRuntimeCfg();
    if (cfg.engineAgreementThresholdMs > 0) return cfg.engineAgreementThresholdMs;
  } catch {}
  const val = parseInt(process.env.ENGINE_AGREEMENT_THRESHOLD_MS || '', 10);
  if (!isNaN(val) && val > 0) return val;
  return 5000;
}

/**
 * Number of consecutive runs a subtitle must fail to fit (both engines
 * disagree, or neither can align it) before it's actually deleted. Protects
 * against deleting a subtitle over a one-off transient failure — a
 * half-downloaded video, a network hiccup, an engine crash unrelated to
 * actual fit. Default: 3, matching the existing per-engine failure-skip
 * convention.
 */
export function getNotFittingDeleteThreshold(): number {
  try {
    const { getRuntimeCfg } = require('./engineRuntime');
    const cfg = getRuntimeCfg();
    if (cfg.notFittingDeleteThreshold > 0) return cfg.notFittingDeleteThreshold;
  } catch {}
  const val = parseInt(process.env.NOT_FITTING_DELETE_THRESHOLD || '', 10);
  if (!isNaN(val) && val > 0) return val;
  return 3;
}

/**
 * Anchor-based alignment: sync one sub per video against the video, then
 * align that video's other subs against the synced anchor (sub-to-sub, no
 * video decode). Enabled by default; ANCHOR_ALIGNMENT=false is the kill
 * switch if it ever misbehaves on real data.
 */
export function isAnchorAlignmentEnabled(): boolean {
  return (process.env.ANCHOR_ALIGNMENT || 'true') !== 'false';
}

export interface DryRunConfig {
  enabled: boolean;
}

export function getDryRunConfig(): DryRunConfig {
  return {
    enabled: (process.env.DRY_RUN || 'false') === 'true',
  };
}

export function getRetentionConfig(): RetentionConfig {
  return {
    keepRunsDays: parseInt(process.env.RETENTION_KEEP_RUNS_DAYS || '30', 10),
    trimLogsDays: parseInt(process.env.RETENTION_TRIM_LOGS_DAYS || '7', 10),
    maxLogSizeBytes: parseInt(process.env.RETENTION_MAX_LOG_SIZE || '10000', 10),
    cleanupIntervalHours: parseInt(process.env.RETENTION_CLEANUP_INTERVAL_HOURS || '24', 10),
  };
}