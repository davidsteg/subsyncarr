<script lang="ts">
  import Icon from '../lib/components/Icon.svelte';
  import ProgressBar from '../lib/components/ProgressBar.svelte';
  import QualityBadge from '../lib/components/QualityBadge.svelte';
  import { api, errorText } from '../lib/api';
  import { basename, num } from '../lib/format';
  import { live } from '../lib/live.svelte';
  import { mediaDrawer } from '../lib/ui.svelte';
  import type { FolderInfo, LibraryFile, ReviewQueue } from '../lib/types';

  const STORAGE_KEY = 'subsyncarr-library-path';

  function storedPath(): string | null {
    try {
      return sessionStorage.getItem(STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }

  let parent = $state<string | null>(storedPath());
  let folders = $state<FolderInfo[] | null>(null);
  let error = $state<string | null>(null);
  let files = $state<LibraryFile[]>([]);
  let review = $state<ReviewQueue | null>(null);
  let loading = $state(false);
  let seq = 0;

  async function load(p: string | null) {
    const my = ++seq;
    loading = true;
    error = null;
    try {
      const [r, f, q] = await Promise.all([
        api.folders(p),
        p ? api.libraryFiles(p) : Promise.resolve([]),
        p ? Promise.resolve(null) : api.reviewQueue(20).catch(() => null),
      ]);
      if (my === seq) {
        folders = r;
        files = f;
        review = q;
      }
    } catch (e) {
      if (my === seq) error = errorText(e);
    } finally {
      if (my === seq) loading = false;
    }
  }

  $effect(() => {
    const p = parent;
    try {
      if (p) sessionStorage.setItem(STORAGE_KEY, p);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    void load(p);
  });

  // Quality and undo state change after a run or a change made in the drawer.
  let lastTick = live.runFinishedTick;
  let drawerWasOpen = false;
  $effect(() => {
    const tick = live.runFinishedTick;
    const open = mediaDrawer.path !== null;
    const closed = drawerWasOpen && !open;
    drawerWasOpen = open;
    if (tick !== lastTick || closed) {
      lastTick = tick;
      void load(parent);
    }
  });

  function dirOf(path: string): string {
    return path.slice(0, path.lastIndexOf('/')) || '/';
  }

  const crumbs = $derived.by(() => {
    if (!parent) return [];
    const parts = parent.split('/').filter(Boolean);
    return parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }));
  });

  function tone(f: FolderInfo): 'ok' | 'accent' | 'warn' {
    if (f.progress >= 100) return 'ok';
    if (f.progress >= 50) return 'accent';
    return 'warn';
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Library</h1>
      <p class="sub">Sync coverage per folder. Open a subtitle to re-sync or shift it.</p>
    </div>
    <button class="icon-btn" aria-label="Refresh folders" title="Refresh" onclick={() => load(parent)}>
      <Icon name="refresh" />
    </button>
  </header>

  <nav class="crumbs" aria-label="Folder path">
    <ol>
      <li>
        {#if parent}
          <button class="crumb" onclick={() => (parent = null)}>Root</button>
        {:else}
          <span class="crumb current" aria-current="location">Root</span>
        {/if}
      </li>
      {#each crumbs as c, i (c.path)}
        <li>
          <Icon name="chevron-right" size={14} class="sep" />
          {#if i === crumbs.length - 1}
            <span class="crumb current truncate" aria-current="location" title={c.path}>{c.name}</span>
          {:else}
            <button class="crumb truncate" title={c.path} onclick={() => (parent = c.path)}>{c.name}</button>
          {/if}
        </li>
      {/each}
    </ol>
  </nav>

  {#if error}
    <div class="banner err" role="alert">
      <Icon name="alert" />
      <div><strong>Could not load folders</strong><p>{error}</p></div>
    </div>
  {:else if folders === null}
    <div class="card"><div class="skeleton" style="height: 200px"></div></div>
  {:else if folders.length === 0 && files.length === 0}
    <div class="card">
      <div class="empty">
        <Icon name="folder" size={32} />
        {#if parent}
          <h3>No subfolders here</h3>
          <p>This folder has no tracked subfolders.</p>
          <button class="btn" onclick={() => (parent = null)}>Back to root</button>
        {:else}
          <h3>No folder data yet</h3>
          <p>Folder coverage is built from the sync database. It appears after the first run has scanned your library.</p>
        {/if}
      </div>
    </div>
  {:else}
    {#if review && review.total > 0}
      <section class="card flush review" aria-labelledby="review-title">
        <div class="review-head">
          <Icon name="alert" size={16} />
          <h2 id="review-title" class="section-title">
            {num(review.total)} weak sync{review.total === 1 ? '' : 's'} to review
          </h2>
        </div>
        <ul class="files">
          {#each review.files as r (r.filePath)}
            <li>
              <button class="file-row" onclick={() => mediaDrawer.open(r.filePath)}>
                <QualityBadge score={r.quality.score} level={r.quality.level} />
                <span class="fname truncate" title={r.filePath}>{basename(r.filePath)}</span>
                <span class="subtle small truncate dir">{dirOf(r.filePath)}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if review.total > review.files.length}
          <p class="small subtle more">Showing the {review.files.length} weakest.</p>
        {/if}
      </section>
    {/if}

    {#if files.length > 0}
      <section class="card flush" class:dim={loading} aria-labelledby="files-title">
        <h2 id="files-title" class="section-title files-title">Subtitles in this folder</h2>
        <ul class="files">
          {#each files as f (f.filePath)}
            <li>
              <button class="file-row" onclick={() => mediaDrawer.open(f.filePath)}>
                <Icon name="file" size={16} />
                <span class="fname truncate" title={f.filePath}>{f.name}</span>
                <span class="tags">
                  {#if f.quality?.manualOffsetMs}
                    <span class="chip" title="Shifted by hand">{f.quality.manualOffsetMs > 0 ? '+' : ''}{(f.quality.manualOffsetMs / 1000).toFixed(2)} s</span>
                  {/if}
                  <QualityBadge score={f.quality?.score} level={f.quality?.level} flagged={f.quality?.needsReview} />
                  {#if f.synced}
                    <span class="badge ok">Synced</span>
                  {:else}
                    <span class="badge">Not synced</span>
                  {/if}
                </span>
                <span class="chev"><Icon name="chevron-right" size={16} /></span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if folders.length > 0}
    <div class="card flush" class:dim={loading}>
      <div class="list-head small subtle" aria-hidden="true">
        <span>Folder</span>
        <span>Coverage</span>
        <span class="r">Synced</span>
        <span class="r">Pending</span>
        <span class="r">Skipped</span>
        <span></span>
      </div>
      <ul class="folders">
        {#each folders as f (f.fullPath)}
          <li>
            {#snippet content()}
              <span class="fname">
                <Icon name="folder" size={16} />
                <span class="truncate" title={f.fullPath}>{f.name}</span>
              </span>
              <span class="cov">
                <ProgressBar value={f.progress} tone={tone(f)} label="{f.name} sync coverage" />
                <span class="tnum small pct">{Math.round(f.progress)}%</span>
              </span>
              <span class="r tnum"><span class="m-label">Synced </span>{num(f.synced)}<span class="subtle"> / {num(f.total)}</span></span>
              <span class="r tnum"><span class="m-label">Pending </span>{num(f.pending)}</span>
              <span class="r tnum"><span class="m-label">Skipped </span>{num(f.skipped)}</span>
              <span class="chev"><Icon name="chevron-right" size={16} /></span>
            {/snippet}
            <button class="frow clickable" onclick={() => (parent = f.fullPath)}>
              {@render content()}
            </button>
          </li>
        {/each}
      </ul>
    </div>
    {/if}
  {/if}
</div>

<style>
  .crumbs ol {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    margin: 0;
    padding: 0;
    min-width: 0;
  }

  .crumbs li {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    max-width: 100%;
  }

  .crumbs :global(.sep) {
    color: var(--text-3);
  }

  .crumb {
    appearance: none;
    border: none;
    background: none;
    font: inherit;
    font-weight: 550;
    color: var(--accent-text);
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    max-width: 260px;
  }

  button.crumb:hover {
    background: var(--surface-2);
  }

  .crumb.current {
    color: var(--text);
    cursor: default;
  }

  .dim {
    opacity: 0.6;
    transition: opacity 0.15s;
  }

  .list-head,
  .frow {
    display: grid;
    grid-template-columns: minmax(0, 2.2fr) minmax(120px, 1.6fr) 110px 80px 80px 20px;
    align-items: center;
    gap: 14px;
    padding: 10px 18px;
  }

  .list-head {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    font-size: 11.5px;
    border-bottom: 1px solid var(--border);
  }

  .r {
    text-align: right;
  }

  .folders {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .folders li + li {
    border-top: 1px solid var(--border);
  }

  .frow {
    width: 100%;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
  }

  .frow.clickable {
    cursor: pointer;
  }

  .frow.clickable:hover {
    background: var(--surface-2);
  }

  .fname {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 550;
    min-width: 0;
  }

  .fname :global(.icon) {
    color: var(--text-3);
  }

  .cov {
    display: grid;
    grid-template-columns: 1fr 38px;
    align-items: center;
    gap: 8px;
  }

  .pct {
    text-align: right;
    color: var(--text-2);
  }

  .chev {
    color: var(--text-3);
    display: flex;
  }

  .m-label {
    display: none;
  }

  .review-head,
  .files-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 12px 18px;
    border-bottom: 1px solid var(--border);
  }

  .review-head {
    color: var(--warn-text);
  }

  .review-head .section-title {
    margin: 0;
  }

  .files {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .files li + li {
    border-top: 1px solid var(--border);
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 18px;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    min-width: 0;
  }

  .file-row:hover {
    background: var(--surface-2);
  }

  .file-row :global(.icon) {
    color: var(--text-3);
    flex-shrink: 0;
  }

  .file-row .fname {
    font-weight: 550;
    flex: 1;
    min-width: 0;
  }

  .file-row .dir {
    max-width: 40%;
  }

  .tags {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-shrink: 0;
  }

  .more {
    margin: 0;
    padding: 8px 18px 12px;
  }

  @media (max-width: 860px) {
    .list-head {
      display: none;
    }
    .frow {
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      grid-template-areas:
        'name name name chev'
        'cov cov cov cov'
        'syn pen skp .';
      gap: 6px 12px;
      padding: 12px 14px;
    }
    .fname {
      grid-area: name;
    }
    .cov {
      grid-area: cov;
    }
    .frow > :nth-child(3) {
      grid-area: syn;
      text-align: left;
    }
    .frow > :nth-child(4) {
      grid-area: pen;
      text-align: left;
    }
    .frow > :nth-child(5) {
      grid-area: skp;
      text-align: left;
    }
    .chev {
      grid-area: chev;
    }
    .file-row {
      flex-wrap: wrap;
      padding: 10px 14px;
    }
    .file-row .fname {
      flex-basis: calc(100% - 60px);
    }
    .file-row .dir {
      max-width: 100%;
      flex-basis: 100%;
    }
    .m-label {
      display: inline;
      color: var(--text-3);
      font-size: 12px;
    }
    .frow > .r {
      font-size: 12.5px;
    }
  }
</style>
