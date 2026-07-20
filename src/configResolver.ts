/**
 * Unified configuration resolver — single source of truth for all settings.
 * Resolution order: DB (runtime config) → env var → hardcoded default.
 *
 * Previously, settings were scattered across config.ts, engineRuntime.ts,
 * and helpers.ts with inconsistent resolution paths. This module centralizes
 * all setting lookups so the UI and engine code share one truth.
 */

export interface ResolvedConfig {
  // Scan paths
  scanPaths: string[];
  excludePaths: string[];

  // Engine chain
  defaultEngine: string;
  fallbackEngine: string;
  enabledEngines: string[];

  // Timing & thresholds
  engineAgreementThresholdMs: number;
  notFittingDeleteThreshold: number;
  maxSubtitleShiftMs: number;
  maxConcurrentTasks: number;

  // Engine-specific timeouts (ms)
  engineTimeouts: Record<string, number>;

  // Behavior flags
  anchorAlignmentEnabled: boolean;
  dryRun: boolean;
  subtitleFormat: 'standard' | 'overwrite';

  // Retention
  retentionKeepRunsDays: number;
  retentionTrimLogsDays: number;
  retentionMaxLogSizeBytes: number;
  retentionCleanupIntervalHours: number;
}

/**
 * Load all settings from DB via the provided getter.
 * Returns partial config — missing keys fall back to env/default at resolve time.
 */
export function loadFromDb(getSetting: (key: string) => string | null): Partial<ResolvedConfig> {
  const cfg: Partial<ResolvedConfig> = {};

  const maxConc = getSetting('max_concurrent_tasks');
  if (maxConc) {
    const v = parseInt(maxConc, 10);
    if (!isNaN(v) && v > 0) cfg.maxConcurrentTasks = v;
  }

  const agree = getSetting('engine_agreement_threshold_ms');
  if (agree) {
    const v = parseInt(agree, 10);
    if (!isNaN(v) && v > 0) cfg.engineAgreementThresholdMs = v;
  }

  const notFitting = getSetting('not_fitting_delete_threshold');
  if (notFitting) {
    const v = parseInt(notFitting, 10);
    if (!isNaN(v) && v > 0) cfg.notFittingDeleteThreshold = v;
  }

  const maxShift = getSetting('max_subtitle_shift_ms');
  if (maxShift) {
    const v = parseInt(maxShift, 10);
    if (!isNaN(v) && v > 0) cfg.maxSubtitleShiftMs = v;
  }

  for (const engine of ['alass', 'ffsubsync', 'autosubsync']) {
    const timeout = getSetting(`engine_timeout_${engine}`);
    if (timeout) {
      const v = parseInt(timeout, 10);
      if (!isNaN(v) && v > 0) cfg.engineTimeouts = { ...(cfg.engineTimeouts || {}), [engine]: v };
    }
  }

  return cfg;
}

/**
 * Resolve a single setting with priority: dbValue > envValue > defaultValue.
 * Accepts string, number, null, or undefined for dbValue.
 */
function resolveInt(dbValue: string | number | null | undefined, envKey: string, defaultValue: number): number {
  if (dbValue !== null && dbValue !== undefined) {
    const v = typeof dbValue === 'number' ? dbValue : parseInt(dbValue, 10);
    if (!isNaN(v) && v > 0) return v;
  }
  const envVal = process.env[envKey];
  if (envVal) {
    const v = parseInt(envVal, 10);
    if (!isNaN(v) && v > 0) return v;
  }
  return defaultValue;
}

function resolveString(dbValue: string | null | undefined, envKey: string, defaultValue: string): string {
  if (dbValue !== null && dbValue !== undefined && dbValue.length > 0) return dbValue;
  return process.env[envKey] || defaultValue;
}

function resolveBool(dbValue: string | undefined, envKey: string, defaultValue: boolean): boolean {
  if (dbValue !== undefined) return dbValue !== 'false' && dbValue !== '0';
  const envVal = process.env[envKey];
  if (envVal !== undefined) return envVal !== 'false' && envVal !== '0';
  return defaultValue;
}

/**
 * Resolve the full configuration object.
 * Call this once at startup or when settings change.
 */
export function resolveConfig(dbConfig: Partial<ResolvedConfig>): ResolvedConfig {
  // Parse scan paths
  const scanPathsStr = dbConfig.scanPaths || process.env.SCAN_PATHS || '/scan_dir';
  const scanPaths = typeof scanPathsStr === 'string' ? scanPathsStr.split(',').filter(Boolean) : scanPathsStr;

  const excludePathsStr = dbConfig.excludePaths || process.env.EXCLUDE_PATHS || '';
  const excludePaths =
    typeof excludePathsStr === 'string' ? excludePathsStr.split(',').filter(Boolean) : excludePathsStr;

  // Parse enabled engines
  const enabledEnginesStr = dbConfig.enabledEngines || process.env.INCLUDE_ENGINES || 'ffsubsync,autosubsync,alass';
  const enabledEngines =
    typeof enabledEnginesStr === 'string'
      ? enabledEnginesStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : enabledEnginesStr;

  // Parse engine timeouts
  const engineTimeouts: Record<string, number> = {};
  if (dbConfig.engineTimeouts) {
    for (const [engine, timeout] of Object.entries(dbConfig.engineTimeouts)) {
      engineTimeouts[engine] = resolveInt(timeout?.toString(), `ENGINE_TIMEOUT_${engine.toUpperCase()}`, 300000);
    }
  }
  // Fill missing engines with env defaults
  for (const engine of ['alass', 'ffsubsync', 'autosubsync'] as const) {
    if (!engineTimeouts[engine]) {
      const envKey = `${engine.toUpperCase()}_TIMEOUT_MS`;
      engineTimeouts[engine] = resolveInt(undefined, envKey, 300000);
    }
  }

  // Generic timeout fallback
  const genericTimeout = process.env.SYNC_ENGINE_TIMEOUT_MS || process.env.SYNC_TIMEOUT;
  if (genericTimeout) {
    const v = parseInt(genericTimeout, 10);
    if (!isNaN(v)) {
      const timeoutMs = genericTimeout.includes('MS') ? v : v * 1000;
      for (const engine of Object.keys(engineTimeouts)) {
        if (!dbConfig.engineTimeouts?.[engine]) {
          engineTimeouts[engine] = timeoutMs;
        }
      }
    }
  }

  return {
    scanPaths,
    excludePaths,
    defaultEngine: resolveString(dbConfig.defaultEngine || process.env.DEFAULT_ENGINE, 'DEFAULT_ENGINE', 'alass'),
    fallbackEngine: resolveString(
      dbConfig.fallbackEngine || process.env.FALLBACK_ENGINE,
      'FALLBACK_ENGINE',
      'ffsubsync',
    ),
    enabledEngines,
    engineAgreementThresholdMs: resolveInt(dbConfig.engineAgreementThresholdMs, 'ENGINE_AGREEMENT_THRESHOLD_MS', 5000),
    notFittingDeleteThreshold: resolveInt(dbConfig.notFittingDeleteThreshold, 'NOT_FITTING_DELETE_THRESHOLD', 3),
    maxSubtitleShiftMs: resolveInt(dbConfig.maxSubtitleShiftMs, 'MAX_SUBTITLE_SHIFT_MS', 30000),
    maxConcurrentTasks: resolveInt(dbConfig.maxConcurrentTasks, 'MAX_CONCURRENT_SYNC_TASKS', 1),
    engineTimeouts,
    anchorAlignmentEnabled: resolveBool(process.env.ANCHOR_ALIGNMENT, 'ANCHOR_ALIGNMENT', true),
    dryRun: resolveBool(process.env.DRY_RUN, 'DRY_RUN', false),
    subtitleFormat: resolveString(
      process.env.SUBTITLE_FORMAT || process.env.OVERWRITE_SUBTITLES,
      'SUBTITLE_FORMAT',
      'standard',
    ) as 'standard' | 'overwrite',
    retentionKeepRunsDays: resolveInt(process.env.RETENTION_KEEP_RUNS_DAYS, 'RETENTION_KEEP_RUNS_DAYS', 30),
    retentionTrimLogsDays: resolveInt(process.env.RETENTION_TRIM_LOGS_DAYS, 'RETENTION_TRIM_LOGS_DAYS', 7),
    retentionMaxLogSizeBytes: resolveInt(process.env.RETENTION_MAX_LOG_SIZE, 'RETENTION_MAX_LOG_SIZE', 10000),
    retentionCleanupIntervalHours: resolveInt(
      process.env.RETENTION_CLEANUP_INTERVAL_HOURS,
      'RETENTION_CLEANUP_INTERVAL_HOURS',
      24,
    ),
  };
}
