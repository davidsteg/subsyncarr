import type {
  ChangelogEntry,
  ConfigInfo,
  DeepStats,
  FileStatus,
  FolderInfo,
  IntegrationTestResult,
  LibraryFile,
  LogLevelFilter,
  LogsResponse,
  MediaDetail,
  ReviewQueue,
  RunDetailResponse,
  RunFilesResponse,
  RunLogsResponse,
  Run,
  Settings,
  SettingsUpdate,
  SkipStatus,
  Stats,
  StatusResponse,
  Success,
  VersionInfo,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status} ${res.statusText}`;
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      const msg = body.error ?? body.message;
      if (typeof msg === 'string' && msg) return msg;
    } catch {
      /* not JSON */
    }
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

async function request(method: 'GET' | 'POST', path: string, query?: Query, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return res;
}

async function getJson<T>(path: string, query?: Query): Promise<T> {
  const res = await request('GET', path, query);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await request('POST', path, undefined, body ?? {});
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const api = {
  version: () => getJson<VersionInfo>('/api/version'),
  config: () => getJson<ConfigInfo>('/api/config'),
  changelog: () => getJson<ChangelogEntry[]>('/api/changelog'),
  stats: () => getJson<Stats>('/api/stats'),
  deepStats: (opts: { days: number; includeDry?: boolean }) =>
    getJson<DeepStats>('/api/stats/deep', {
      days: opts.days,
      includeDry: opts.includeDry || undefined,
      // Minutes east of UTC, so day buckets start at local midnight.
      tzOffset: -new Date().getTimezoneOffset(),
    }),
  folders: (parent?: string | null) => getJson<FolderInfo[]>('/api/folders', { parent: parent ?? undefined }),
  status: (opts: { brief?: boolean; limit?: number } = {}) =>
    getJson<StatusResponse>('/api/status', { brief: opts.brief, limit: opts.limit }),
  history: (limit = 50) => getJson<Run[]>('/api/history', { limit }),
  run: (id: string, limit = 500) => getJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}`, { limit }),
  runFiles: (id: string, opts: { status?: FileStatus | ''; page?: number; limit?: number } = {}) =>
    getJson<RunFilesResponse>(`/api/runs/${encodeURIComponent(id)}/files`, {
      status: opts.status,
      page: opts.page,
      limit: opts.limit,
    }),
  runLogs: (id: string) => getJson<RunLogsResponse>(`/api/runs/${encodeURIComponent(id)}/logs`),
  logs: (opts: { limit?: number; level?: LogLevelFilter; search?: string; since?: number } = {}) =>
    getJson<LogsResponse>('/api/logs', {
      limit: opts.limit,
      level: opts.level && opts.level !== 'all' ? opts.level : undefined,
      search: opts.search,
      since: opts.since,
    }),
  logsTextUrl: (opts: { level?: LogLevelFilter; search?: string; limit?: number } = {}) =>
    buildUrl('/api/logs', {
      format: 'text',
      limit: opts.limit,
      level: opts.level && opts.level !== 'all' ? opts.level : undefined,
      search: opts.search,
    }),
  startRun: (body: StartRunBody = {}) => postJson<{ runId: string }>('/api/run/start', body),
  stopRun: () => postJson<Success>('/api/run/stop'),
  skipFile: (filePath: string) => postJson<Success>('/api/file/skip', { filePath }),
  skipStatus: () => getJson<SkipStatus>('/api/skip-status'),
  resetSkip: (filePath: string, engine?: string) =>
    postJson<Success>('/api/skip-status/reset', engine ? { filePath, engine } : { filePath }),
  media: (path: string) => getJson<MediaDetail>('/api/media', { path }),
  libraryFiles: (dir: string) => getJson<LibraryFile[]>('/api/library/files', { dir }),
  resyncFile: (filePath: string) => postJson<{ runId: string }>('/api/file/resync', { filePath }),
  offsetFile: (filePath: string, offsetMs: number) => postJson<Success>('/api/file/offset', { filePath, offsetMs }),
  undoFile: (filePath: string) => postJson<{ success: true; undone: string }>('/api/file/undo', { filePath }),
  reviewFile: (filePath: string, reviewed: boolean) => postJson<Success>('/api/file/review', { filePath, reviewed }),
  reviewQueue: (limit = 50) => getJson<ReviewQueue>('/api/quality/review', { limit }),
  settings: () => getJson<Settings>('/api/settings'),
  saveSettings: (update: SettingsUpdate) => postJson<Success>('/api/settings', update),
  testIntegration: (target: 'notify' | 'media') =>
    postJson<IntegrationTestResult>('/api/integrations/test', { target }),
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status ? `${e.message} (HTTP ${e.status})` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface StartRunBody {
  paths?: string[];
  dryRun?: boolean;
  /** Reprocess every subtitle, ignoring the sync cache. */
  fresh?: boolean;
  /** With `fresh`: also clear strikes, engine skips and parked forced subs. */
  resetFailures?: boolean;
}
