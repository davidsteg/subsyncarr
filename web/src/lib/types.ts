// Types mirroring docs/API.md. Timestamps are Unix epoch milliseconds.

export type RunStatus = 'running' | 'completed' | 'cancelled';
export type FileStatus = 'pending' | 'processing' | 'completed' | 'skipped' | 'error' | 'not_fitting';
export type SyncMode = 'anchor' | 'follower' | 'full';
export type EngineName = 'alass' | 'ffsubsync' | 'autosubsync';

export const ENGINE_NAMES: readonly EngineName[] = ['ffsubsync', 'autosubsync', 'alass'];

export interface EngineStat {
  pass: number;
  fail: number;
}

export interface Run {
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
  engine_stats: Record<string, EngineStat>;
  anchors_completed: number;
  followers_completed: number;
  dry_run: boolean;
}

export interface EngineResult {
  success: boolean;
  duration: number;
  message: string;
  stdout?: string;
  stderr?: string;
  skipped?: boolean;
  offsetMs?: number;
  shiftTooLarge?: boolean;
  originalShiftMs?: number;
}

export interface FileResult {
  id: number;
  run_id: string;
  file_path: string;
  video_path: string | null;
  status: FileStatus;
  current_engine: string | null;
  engines: Record<string, EngineResult>;
  sync_mode: SyncMode | null;
  anchor_path: string | null;
  created_at: number;
  updated_at: number;
}

export interface ScanProgress {
  checked: number;
  total: number;
  needSync: number;
  alreadySynced: number;
}

export interface VersionInfo {
  version: string;
  repo: string;
  releaseUrl: string;
}

export interface ScheduleInfo {
  enabled: boolean;
  cron: string;
  description: string;
  nextRun: number | null;
}

export interface ConfigInfo {
  paths: string[];
  excludePaths: string[];
  isConfigured: boolean;
  schedule: ScheduleInfo;
}

export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  sections: ChangelogSection[];
}

export interface EngineStats {
  engine: string;
  total: number;
  synced: number;
  rate: number;
}

export interface LanguageStat {
  name: string;
  count: number;
}

export interface FastPathStats {
  anchors: number;
  followers: number;
  completed: number;
  followerShare: number;
}

export interface Stats {
  totalFiles: number;
  syncedFiles: number;
  skippedFiles: number;
  syncRate: number;
  engines: EngineStats[];
  languages: LanguageStat[];
  fastPath: FastPathStats;
}

export interface FolderInfo {
  name: string;
  fullPath: string;
  total: number;
  synced: number;
  skipped: number;
  pending: number;
  progress: number;
  hasChildren: boolean;
}

export interface StatusResponse {
  currentRun: Run | null;
  scanProgress: ScanProgress | null;
  files: FileResult[];
  totalFiles: number;
  isRunning: boolean;
  dryRun: boolean;
}

export interface RunDetailResponse {
  run: Run;
  files: FileResult[];
  totalFiles: number;
}

export interface RunFilesResponse {
  files: FileResult[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface RunLogsResponse {
  logs: string;
}

export type LogLevel = 'log' | 'warn' | 'error';
export type LogLevelFilter = 'all' | LogLevel;

export interface LogEntry {
  seq: number;
  timestamp: number;
  level: LogLevel;
  message: string;
}

export interface LogsResponse {
  size: number;
  maxSize: number;
  latestSeq: number;
  logs: LogEntry[];
}

export interface SkipStatus {
  totalSkipped: number;
  skippedByEngine: Record<string, number>;
}

export interface FailureTracking {
  engine: string;
  consecutive_failures: number;
  last_failure_time: number | null;
  last_success_time: number | null;
  is_skipped: boolean;
}

export interface SyncHistoryEntry {
  runId: string;
  runStartTime: number;
  runStatus: RunStatus;
  fileStatus: FileStatus;
  engines: Record<string, EngineResult>;
  syncMode: SyncMode | null;
  anchorPath: string | null;
  updatedAt: number;
}

export interface MediaDetail {
  filePath: string;
  notFittingStrikes: number;
  failureTracking: FailureTracking[];
  syncHistory: SyncHistoryEntry[];
}

export type ThemeSetting = 'light' | 'dark' | 'system';

export interface Settings {
  maxSubtitleShiftMs: number;
  engineAgreementThresholdMs: number;
  notFittingDeleteThreshold: number;
  engineTimeouts: Record<EngineName, number>;
  maxConcurrentTasks: number;
  defaultEngine: EngineName;
  fallbackEngine: EngineName;
  dryRun: boolean;
  anchorAlignment: boolean;
  cronSchedule: string;
  includeEngines: string | string[];
  theme: ThemeSetting | string;
}

export interface SettingsUpdate {
  max_subtitle_shift_ms?: number;
  engine_agreement_threshold_ms?: number;
  not_fitting_delete_threshold?: number;
  engine_timeout_alass?: number;
  engine_timeout_ffsubsync?: number;
  engine_timeout_autosubsync?: number;
  max_concurrent_tasks?: number;
  default_engine?: EngineName;
  fallback_engine?: EngineName;
  dry_run?: boolean;
  anchor_alignment?: boolean;
  theme?: ThemeSetting;
}

export interface Success {
  success: true;
}

// WebSocket protocol
export interface LiveState {
  currentRun: Run | null;
  isRunning: boolean;
  dryRun: boolean;
  scanProgress: ScanProgress | null;
}

export type WsEvent =
  | { type: 'run:started'; data: Run }
  | { type: 'run:completed'; data: Run }
  | { type: 'run:cancelled'; data: Run }
  | { type: 'file:updated'; data: { runId: string; filePath: string; run: Run } }
  | { type: 'scan:progress'; data: ScanProgress | null };

export type WsMessage = { type: 'state'; data: LiveState } | { type: 'batch'; messages: WsEvent[] };
