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
  framerateScale?: number;
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
  quality_score: number | null;
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
  qualityScore: number | null;
  updatedAt: number;
}

export type QualityLevel = 'good' | 'fair' | 'weak';

export interface QualityFactor {
  label: string;
  penalty: number;
}

export interface QualityDetails {
  score: number;
  level: QualityLevel;
  enginesAligned: number;
  disagreementMs: number | null;
  shiftMs: number;
  spreadMs: number;
  splitPoints: number;
  cues: number;
  factors: QualityFactor[];
}

export interface SyncQuality {
  /** null when only a manual offset is known (synced before scoring existed). */
  score: number | null;
  level: QualityLevel | null;
  details: QualityDetails | null;
  source: 'run' | 'resync' | 'offset';
  manualOffsetMs: number;
  reviewed: boolean;
  needsReview: boolean;
  updatedAt: number;
}

export interface UndoStep {
  action: 'resync' | 'offset';
  offsetMs: number | null;
  createdAt: number;
}

export interface MediaDetail {
  filePath: string;
  notFittingStrikes: number;
  failureTracking: FailureTracking[];
  syncHistory: SyncHistoryEntry[];
  quality: SyncQuality | null;
  /** Newest first. */
  undo: UndoStep[];
}

export interface LibraryFile {
  name: string;
  filePath: string;
  sizeBytes: number;
  synced: boolean;
  quality: SyncQuality | null;
  undoSteps: number;
}

export interface ReviewQueue {
  total: number;
  files: { filePath: string; quality: SyncQuality }[];
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
  embeddedSubtitleReference: boolean;
  cronSchedule: string;
  includeEngines: string | string[];
  theme: ThemeSetting | string;
  integrations?: Integrations;
}

export type NotifyKind = 'apprise' | 'discord' | 'json';
export type NotifyOn = 'always' | 'changes' | 'issues';
export type MediaServer = 'none' | 'jellyfin' | 'plex';

export interface Integrations {
  webhookEnabled: boolean;
  webhookToken: string;
  webhookPathMap: string;
  notifyUrl: string;
  notifyKind: NotifyKind;
  notifyOn: NotifyOn;
  mediaServer: MediaServer;
  mediaServerUrl: string;
  mediaServerToken: string;
  mediaPathMap: string;
}

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
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
  embedded_subtitle_reference?: boolean;
  theme?: ThemeSetting;
  webhook_enabled?: boolean;
  webhook_token?: string;
  webhook_path_map?: string;
  notify_url?: string;
  notify_kind?: NotifyKind;
  notify_on?: NotifyOn;
  media_server?: MediaServer;
  media_server_url?: string;
  media_server_token?: string;
  media_path_map?: string;
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

// Deep statistics (GET /api/stats/deep)
export interface ClassCounts {
  total: number;
  synced: number;
  notFitting: number;
  failed: number;
  deleted: number;
  parked: number;
  noVideo: number;
  avgQuality: number | null;
}

export interface Spread {
  p10: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export interface HistogramBucket {
  label: string;
  lo: number | null;
  hi: number | null;
  count: number;
}

export type EngineResultKind = 'ok' | 'shift' | 'timeout' | 'skipped' | 'no_output' | 'error';

export interface EngineDeepStats {
  engine: string;
  runs: number;
  results: Partial<Record<EngineResultKind, number>>;
  byReference: Record<string, Partial<Record<EngineResultKind, number>>>;
  totalMs: number;
  durationMs: Spread;
  shiftMs: Spread;
  absShiftMs: Spread;
  shiftHistogram: HistogramBucket[];
  framerateScaled: number;
}

export interface AgreementPair {
  engines: [string, string];
  pairs: number;
  withinThreshold: number;
  absDiffMs: Spread;
  biasMs: number | null;
  histogram: HistogramBucket[];
  onlyFirstMoves: number;
  onlySecondMoves: number;
  /** [shift of engines[0], shift of engines[1], kept] */
  scatter: [number, number, boolean][];
  worst: { filePath: string; ts: number; category: string; a: number; b: number }[];
}

export interface StatsRun {
  runId: string;
  start: number;
  end: number;
  status: string | null;
  durationMs: number;
  decisions: number;
  synced: number;
  notFitting: number;
  failed: number;
  deleted: number;
  parked: number;
  noVideo: number;
  avgQuality: number | null;
  engineMs: number;
  filesPerHour: number | null;
  dryRun: boolean;
  manual: boolean;
}

export type BreakdownRow = ClassCounts & { key: string };

export interface DeepStats {
  window: {
    days: number;
    from: number;
    to: number;
    bucketMs: number;
    firstRecord: number | null;
    includeDryRuns: boolean;
  };
  totals: Omit<ClassCounts, 'total' | 'avgQuality'> & {
    decisions: number;
    files: number;
    keepRate: number | null;
    avgQuality: number | null;
    categories: Record<string, number>;
  };
  throughput: { filesPerHour: number | null; runMs: number };
  timeline: (ClassCounts & { t: number; medianDisagreementMs: number | null })[];
  runs: StatsRun[];
  engines: EngineDeepStats[];
  agreement: { thresholdMs: number; pairs: AgreementPair[] };
  quality: {
    histogram: { label: string; lo: number; count: number }[];
    levels: { weak: number; fair: number; good: number };
    unscored: number;
    needsReview: number;
    reviewed: number;
    average: number | null;
    weakBelow: number;
    goodFrom: number;
  };
  strikes: {
    threshold: number;
    distribution: { strikes: number; count: number }[];
    parked: number;
    skippedEngineFiles: number;
    skippedByEngine: Record<string, number>;
  };
  breakdowns: Record<'language' | 'forced' | 'kind' | 'reference' | 'mode' | 'library' | 'titles', BreakdownRow[]>;
  orphans: { count: number; truncated: boolean; items: { filePath: string; lastSeen: number }[] };
}
