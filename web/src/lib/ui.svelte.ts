import { api, errorText } from './api';
import { live } from './live.svelte';
import { href, router } from './router.svelte';
import type { ConfigInfo, ThemeSetting, VersionInfo } from './types';

/* ---------------- Toasts ---------------- */

export type ToastKind = 'success' | 'error' | 'info' | 'warn';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

class ToastStore {
  items = $state<Toast[]>([]);
  #next = 1;

  push(kind: ToastKind, message: string, timeout = kind === 'error' ? 7000 : 3500) {
    const id = this.#next++;
    this.items = [...this.items, { id, kind, message }];
    if (timeout > 0) setTimeout(() => this.dismiss(id), timeout);
  }
  success(message: string) {
    this.push('success', message);
  }
  info(message: string) {
    this.push('info', message);
  }
  error(message: string, e?: unknown) {
    this.push('error', e === undefined ? message : `${message}: ${errorText(e)}`);
  }
  dismiss(id: number) {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();

/* ---------------- Theme ---------------- */

const THEME_KEY = 'subsyncarr-theme';

function readStoredTheme(): ThemeSetting {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage unavailable */
  }
  return 'system';
}

class ThemeStore {
  preference = $state<ThemeSetting>('system');
  systemDark = $state(false);
  resolved = $derived<'light' | 'dark'>(
    this.preference === 'system' ? (this.systemDark ? 'dark' : 'light') : this.preference,
  );

  init() {
    this.preference = readStoredTheme();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    this.systemDark = mq.matches;
    mq.addEventListener('change', (e) => {
      this.systemDark = e.matches;
    });
  }

  set(pref: ThemeSetting) {
    this.preference = pref;
    try {
      localStorage.setItem(THEME_KEY, pref);
    } catch {
      /* storage unavailable */
    }
  }

  toggle() {
    this.set(this.resolved === 'dark' ? 'light' : 'dark');
  }
}

export const theme = new ThemeStore();

/* ---------------- App meta (version / config) ---------------- */

class MetaStore {
  version = $state<VersionInfo | null>(null);
  config = $state<ConfigInfo | null>(null);
  configError = $state<string | null>(null);

  async loadVersion() {
    try {
      this.version = await api.version();
    } catch {
      /* non-critical */
    }
  }

  async loadConfig() {
    try {
      this.config = await api.config();
      this.configError = null;
    } catch (e) {
      this.configError = errorText(e);
    }
  }
}

export const meta = new MetaStore();

/* ---------------- Media detail drawer ---------------- */

class MediaDrawerStore {
  path = $state<string | null>(null);
  open(path: string) {
    this.path = path;
  }
  close() {
    this.path = null;
  }
}

export const mediaDrawer = new MediaDrawerStore();

/* ---------------- Run actions shared by pages ---------------- */

export async function startRun(opts: { paths?: string[]; dryRun?: boolean } = {}) {
  const body: { paths?: string[]; dryRun?: boolean } = {};
  if (opts.paths && opts.paths.length) body.paths = opts.paths;
  if (opts.dryRun) body.dryRun = true;
  const prev = { run: live.currentRun, running: live.isRunning, dry: live.dryRun };
  live.markStarting(!!opts.dryRun);
  router.go(href('run'));
  try {
    await api.startRun(body);
    toasts.success(opts.dryRun ? 'Dry run started' : body.paths ? 'Scan of selected paths started' : 'Full run started');
  } catch (e) {
    live.currentRun = prev.run;
    live.isRunning = prev.running;
    live.dryRun = prev.dry;
    toasts.error('Could not start run', e);
  }
}

export async function stopRun() {
  try {
    await api.stopRun();
    toasts.info('Stop requested — finishing in-flight files');
  } catch (e) {
    toasts.error('Could not stop run', e);
  }
}
