// Global in-memory ring buffer of everything the server console.logs — not
// just per-run processing logs (those already have their own file-backed
// history via LogFileManager / GET /api/runs/:id/logs). This captures
// startup messages, route access logs, scheduled-cleanup output, and errors
// from anywhere in the process, so it can be fetched remotely via
// GET /api/logs instead of requiring someone to pull raw container/stdout
// logs and paste them in by hand.
//
// Import this module FIRST in index-server.ts (before anything else that
// might log) so nothing is missed. Resets on restart, same convention as
// ProcessingEngine's own per-run log buffer.

export interface ServerLogEntry {
  seq: number;
  timestamp: number;
  level: 'log' | 'warn' | 'error';
  message: string;
}

const MAX_ENTRIES = parseInt(process.env.SERVER_LOG_BUFFER_SIZE || '5000', 10);

const buffer: ServerLogEntry[] = [];
let seqCounter = 0;

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function record(level: ServerLogEntry['level'], args: unknown[]): void {
  const message = args.map(formatArg).join(' ');
  buffer.push({ seq: ++seqCounter, timestamp: Date.now(), level, message });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

console.log = (...args: unknown[]) => {
  originalLog(...args);
  record('log', args);
};
console.warn = (...args: unknown[]) => {
  originalWarn(...args);
  record('warn', args);
};
console.error = (...args: unknown[]) => {
  originalError(...args);
  record('error', args);
};

export interface GetLogsOptions {
  limit?: number;
  level?: 'all' | 'log' | 'warn' | 'error';
  search?: string;
  since?: number;
}

/** Fetch recent buffered log entries, newest last (same order as they were logged). */
export function getRecentServerLogs(opts: GetLogsOptions = {}): ServerLogEntry[] {
  let entries: ServerLogEntry[] = buffer;

  if (opts.since !== undefined) {
    entries = entries.filter((e) => e.seq > opts.since!);
  }
  if (opts.level && opts.level !== 'all') {
    entries = entries.filter((e) => e.level === opts.level);
  }
  if (opts.search) {
    const q = opts.search.toLowerCase();
    entries = entries.filter((e) => e.message.toLowerCase().includes(q));
  }

  const limit = opts.limit && opts.limit > 0 ? opts.limit : 500;
  return entries.slice(-limit);
}

export function getServerLogBufferInfo(): { size: number; maxSize: number; latestSeq: number } {
  return { size: buffer.length, maxSize: MAX_ENTRIES, latestSeq: seqCounter };
}
