export type RouteName =
  | 'dashboard'
  | 'run'
  | 'history'
  | 'run-detail'
  | 'library'
  | 'statistics'
  | 'logs'
  | 'settings'
  | 'changelog';

export interface Route {
  name: RouteName;
  params: Record<string, string>;
}

const SIMPLE: Record<string, RouteName> = {
  dashboard: 'dashboard',
  run: 'run',
  history: 'history',
  library: 'library',
  statistics: 'statistics',
  logs: 'logs',
  settings: 'settings',
  changelog: 'changelog',
};

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const qIndex = raw.indexOf('?');
  const path = (qIndex >= 0 ? raw.slice(0, qIndex) : raw).replace(/\/+$/, '');
  const query = Object.fromEntries(new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : ''));
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'history' && segments[1]) {
    return { name: 'run-detail', params: { ...query, id: decodeURIComponent(segments[1]) } };
  }
  const name = SIMPLE[segments[0] ?? ''];
  return { name: name ?? 'dashboard', params: query };
}

export function href(name: Exclude<RouteName, 'run-detail'>): string;
export function href(name: 'run-detail', id: string, tab?: string): string;
export function href(name: RouteName, id?: string, tab?: string): string {
  if (name === 'run-detail') {
    const base = `#/history/${encodeURIComponent(id ?? '')}`;
    return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
  }
  return `#/${name}`;
}

class Router {
  route = $state<Route>(parseHash(typeof location !== 'undefined' ? location.hash : ''));

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('hashchange', () => {
      this.route = parseHash(location.hash);
      window.scrollTo(0, 0);
    });
    if (!location.hash) history.replaceState(null, '', '#/dashboard');
  }

  go(hash: string) {
    if (location.hash === hash) return;
    location.hash = hash;
  }
}

export const router = new Router();
