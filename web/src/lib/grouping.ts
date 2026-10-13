import type { FileResult } from './types';

export interface FileGroup {
  key: string;
  videoPath: string | null;
  files: FileResult[];
  /** Whether to render as a visual group (anchor + followers, or several subs for one video). */
  grouped: boolean;
}

function rank(f: FileResult): number {
  return f.sync_mode === 'anchor' ? 0 : f.sync_mode === 'follower' ? 1 : 2;
}

/** Group files by matched video, preserving first-seen order; anchor first, then followers, then the rest. */
export function groupFiles(files: FileResult[]): FileGroup[] {
  const map = new Map<string, FileGroup>();
  for (const f of files) {
    const key = f.video_path || f.file_path;
    let g = map.get(key);
    if (!g) {
      g = { key, videoPath: f.video_path, files: [], grouped: false };
      map.set(key, g);
    }
    g.files.push(f);
  }
  const out = [...map.values()];
  for (const g of out) {
    // Array.prototype.sort is stable, so "newest first" order is kept within each rank.
    g.files.sort((a, b) => rank(a) - rank(b));
    g.grouped = g.files.length > 1 || g.files.some((f) => f.sync_mode === 'anchor' || f.sync_mode === 'follower');
  }
  return out;
}
