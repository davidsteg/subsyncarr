import { api } from './api';
import type { LiveState, Run, ScanProgress, WsEvent, WsMessage } from './types';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

type Listener = (event: WsEvent) => void;

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 10_000;

/** Single shared live state fed by the /ws connection. */
class LiveStore {
  currentRun = $state<Run | null>(null);
  isRunning = $state(false);
  dryRun = $state(false);
  scanProgress = $state<ScanProgress | null>(null);
  connection = $state<ConnectionStatus>('connecting');
  /** Bumped whenever a run finishes, so pages can refresh derived data. */
  runFinishedTick = $state(0);

  #ws: WebSocket | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #listeners = new Set<Listener>();
  #started = false;

  /** True while a run exists but its file list has not been built yet. */
  get isScanning(): boolean {
    return this.isRunning && (!this.currentRun || this.currentRun.total_files === 0);
  }

  start() {
    if (this.#started || typeof window === 'undefined') return;
    this.#started = true;
    // Seed state over HTTP so the UI is correct even before the socket opens.
    api
      .status({ brief: true })
      .then((s) => {
        if (this.connection !== 'open') {
          this.#applyState({
            currentRun: s.currentRun,
            isRunning: s.isRunning,
            dryRun: s.dryRun,
            scanProgress: s.scanProgress,
          });
        }
      })
      .catch(() => {
        /* the socket will retry */
      });
    this.#connect();
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Optimistic placeholder shown between POST /api/run/start and run:started. */
  markStarting(dryRun: boolean) {
    this.isRunning = true;
    this.dryRun = dryRun;
    this.scanProgress = null;
    this.currentRun = {
      id: 'pending',
      start_time: Date.now(),
      end_time: null,
      total_files: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      not_fitting: 0,
      total_engines: 0,
      completed_engines: 0,
      status: 'running',
      engine_stats: {},
      anchors_completed: 0,
      followers_completed: 0,
      dry_run: dryRun,
    };
  }

  #connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    this.connection = this.#attempt === 0 ? 'connecting' : 'reconnecting';

    ws.onopen = () => {
      this.#attempt = 0;
      this.connection = 'open';
    };
    ws.onmessage = (ev) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsMessage;
      } catch {
        return;
      }
      this.#handle(msg);
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  #scheduleReconnect() {
    this.connection = 'reconnecting';
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    const base = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** this.#attempt);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.#attempt++;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, Math.min(delay, MAX_BACKOFF));
  }

  #applyState(s: LiveState) {
    this.currentRun = s.currentRun ?? this.currentRun;
    this.isRunning = s.isRunning;
    this.dryRun = s.dryRun;
    this.scanProgress = s.scanProgress;
  }

  #handle(msg: WsMessage) {
    if (msg.type === 'state') {
      this.#applyState(msg.data);
      return;
    }
    if (msg.type !== 'batch' || !Array.isArray(msg.messages)) return;
    for (const ev of msg.messages) {
      switch (ev.type) {
        case 'run:started':
          this.currentRun = ev.data;
          this.isRunning = true;
          this.dryRun = ev.data.dry_run;
          break;
        case 'run:completed':
        case 'run:cancelled':
          this.currentRun = ev.data;
          this.isRunning = false;
          this.scanProgress = null;
          this.runFinishedTick++;
          break;
        case 'file:updated':
          if (ev.data.run) this.currentRun = ev.data.run;
          break;
        case 'scan:progress':
          this.scanProgress = ev.data;
          break;
      }
      for (const fn of this.#listeners) {
        try {
          fn(ev);
        } catch (e) {
          console.error(e);
        }
      }
    }
  }
}

export const live = new LiveStore();
