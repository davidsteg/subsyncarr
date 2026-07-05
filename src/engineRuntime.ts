// Runtime configuration singleton — bridges DB-persisted settings with engine code.
// Loaded from DB at startup by the coordinator, updated by POST /api/settings.

const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes

export interface RuntimeCfg {
  maxConcurrentTasks: number;
  engineTimeouts: Record<string, number>;
  engineAgreementThresholdMs: number;
  notFittingDeleteThreshold: number;
  maxSubtitleShiftMs: number;
}

function parseTimeout(envVar: string): number {
  const val = process.env[envVar];
  if (val) { const n = parseInt(val, 10); if (!isNaN(n) && n > 0) return n; }
  return 0;
}

function resolveEngineTimeout(engine: string): number {
  const engineEnvMap: Record<string, string> = {
    alass: 'ALASS_TIMEOUT_MS', ffsubsync: 'FFSUBSYNC_TIMEOUT_MS', autosubsync: 'AUTOSUBSYNC_TIMEOUT_MS',
  };
  const envVar = engineEnvMap[engine];
  if (envVar) { const t = parseTimeout(envVar); if (t > 0) return t; }
  const gm = parseTimeout('SYNC_ENGINE_TIMEOUT_MS'); if (gm > 0) return gm;
  const st = process.env.SYNC_TIMEOUT;
  if (st) { const v = parseInt(st, 10); if (!isNaN(v) && v > 0) return v * 1000; }
  return DEFAULT_TIMEOUT_MS;
}

const defaults: RuntimeCfg = {
  maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_SYNC_TASKS || '1', 10),
  engineAgreementThresholdMs: parseInt(process.env.ENGINE_AGREEMENT_THRESHOLD_MS || '5000', 10),
  // Matches the existing "3 consecutive failures" convention used for per-engine skip.
  notFittingDeleteThreshold: parseInt(process.env.NOT_FITTING_DELETE_THRESHOLD || '3', 10),
  maxSubtitleShiftMs: parseInt(process.env.MAX_SUBTITLE_SHIFT_MS || '30000', 10),
  engineTimeouts: {
    alass: resolveEngineTimeout('alass'),
    ffsubsync: resolveEngineTimeout('ffsubsync'),
    autosubsync: resolveEngineTimeout('autosubsync'),
  },
};

let current: RuntimeCfg = {
  maxConcurrentTasks: defaults.maxConcurrentTasks,
  engineAgreementThresholdMs: defaults.engineAgreementThresholdMs,
  notFittingDeleteThreshold: defaults.notFittingDeleteThreshold,
  maxSubtitleShiftMs: defaults.maxSubtitleShiftMs,
  engineTimeouts: { ...defaults.engineTimeouts },
};

export function getRuntimeCfg(): RuntimeCfg { return current; }

export function updateRuntimeCfg(updates: Partial<{maxConcurrentTasks: number; engineAgreementThresholdMs: number; notFittingDeleteThreshold: number; maxSubtitleShiftMs: number; engineTimeouts: Partial<Record<string, number>>}>): void {
  if (updates.maxConcurrentTasks !== undefined && updates.maxConcurrentTasks > 0) current.maxConcurrentTasks = updates.maxConcurrentTasks;
  if (updates.engineAgreementThresholdMs !== undefined && updates.engineAgreementThresholdMs > 0) current.engineAgreementThresholdMs = updates.engineAgreementThresholdMs;
  if (updates.notFittingDeleteThreshold !== undefined && updates.notFittingDeleteThreshold > 0) current.notFittingDeleteThreshold = updates.notFittingDeleteThreshold;
  if (updates.maxSubtitleShiftMs !== undefined && updates.maxSubtitleShiftMs > 0) current.maxSubtitleShiftMs = updates.maxSubtitleShiftMs;
  if (updates.engineTimeouts) {
    const merged = { ...current.engineTimeouts };
    for (const [k, v] of Object.entries(updates.engineTimeouts)) {
      if (v !== undefined) (merged as any)[k] = v;
    }
    current.engineTimeouts = merged;
  }
}

export function loadRuntimeCfgFromDb(getSetting: (key: string) => string | null): void {
  const maxConc = getSetting('max_concurrent_tasks');
  if (maxConc) { const v = parseInt(maxConc, 10); if (!isNaN(v) && v > 0) current.maxConcurrentTasks = v; }
  const agree = getSetting('engine_agreement_threshold_ms');
  if (agree) { const v = parseInt(agree, 10); if (!isNaN(v) && v > 0) current.engineAgreementThresholdMs = v; }
  const notFitting = getSetting('not_fitting_delete_threshold');
  if (notFitting) { const v = parseInt(notFitting, 10); if (!isNaN(v) && v > 0) current.notFittingDeleteThreshold = v; }
  const maxShift = getSetting('max_subtitle_shift_ms');
  if (maxShift) { const v = parseInt(maxShift, 10); if (!isNaN(v) && v > 0) current.maxSubtitleShiftMs = v; }
  for (const engine of ['alass', 'ffsubsync', 'autosubsync']) {
    const timeout = getSetting(`engine_timeout_${engine}`);
    if (timeout) { const v = parseInt(timeout, 10); if (!isNaN(v) && v > 0) current.engineTimeouts[engine] = v; }
  }
}
