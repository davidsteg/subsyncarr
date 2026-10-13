<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../lib/components/Icon.svelte';
  import ProgressBar from '../lib/components/ProgressBar.svelte';
  import ScanProgressCard from '../lib/components/ScanProgressCard.svelte';
  import RunStatusBadge from '../lib/components/RunStatusBadge.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import FileRow from '../lib/components/FileRow.svelte';
  import { api } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { startRun, stopRun, toasts } from '../lib/ui.svelte';
  import { href } from '../lib/router.svelte';
  import { basename, dateTime, duration, eta, num, pct } from '../lib/format';
  import { groupFiles } from '../lib/grouping';
  import type { FileResult } from '../lib/types';

  const VISIBLE = new Set(['processing', 'completed', 'skipped', 'error', 'not_fitting']);

  let files = $state<FileResult[]>([]);
  let loaded = $state(false);
  let filter = $state('');
  let now = $state(Date.now());
  let stopOpen = $state(false);
  let skipping = $state<Set<string>>(new Set());

  let lastFetch = 0;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  async function fetchFiles() {
    lastFetch = Date.now();
    try {
      const s = await api.status({ limit: 200 });
      files = s.files ?? [];
    } catch {
      /* transient — next event retries */
    } finally {
      loaded = true;
    }
  }

  /** At most one fetch per 2s, trailing call guaranteed. */
  function scheduleFetch() {
    if (pendingTimer) return;
    const wait = Math.max(0, 2000 - (Date.now() - lastFetch));
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void fetchFiles();
    }, wait);
  }

  onMount(() => {
    void fetchFiles();
    const unsub = live.subscribe((ev) => {
      if (ev.type === 'file:updated') scheduleFetch();
      else if (ev.type === 'run:started') {
        files = [];
        scheduleFetch();
      } else if (ev.type === 'run:completed' || ev.type === 'run:cancelled') scheduleFetch();
    });
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => {
      unsub();
      clearInterval(tick);
      if (pendingTimer) clearTimeout(pendingTimer);
    };
  });

  const run = $derived(live.currentRun);
  const isActive = $derived(run?.status === 'running' && live.isRunning);
  const scanning = $derived(!!run && run.status === 'running' && run.total_files === 0);
  const processed = $derived(run ? run.completed + run.skipped + run.failed + run.not_fitting : 0);
  const progress = $derived(run ? pct(run.completed_engines, run.total_engines) : 0);
  const elapsed = $derived(run ? (run.end_time ?? now) - run.start_time : 0);

  const etaText = $derived.by(() => {
    if (!run || !isActive || !run.total_files || processed < 10 || elapsed <= 0) return null;
    const remaining = Math.max(0, run.total_files - processed);
    return eta(remaining * (elapsed / processed));
  });

  const visibleFiles = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return files.filter((f) => {
      if (!VISIBLE.has(f.status)) return false;
      if (run && run.id !== 'pending' && f.run_id !== run.id) return false;
      if (!q) return true;
      return (
        basename(f.file_path).toLowerCase().includes(q) ||
        f.status.includes(q) ||
        (f.video_path ?? '').toLowerCase().includes(q)
      );
    });
  });

  const groups = $derived(groupFiles(visibleFiles));
  const processingCount = $derived(visibleFiles.filter((f) => f.status === 'processing').length);

  async function skip(path: string) {
    skipping = new Set([...skipping, path]);
    try {
      await api.skipFile(path);
      toasts.info(`Skipping ${basename(path)}`);
      scheduleFetch();
    } catch (e) {
      toasts.error('Could not skip file', e);
    } finally {
      const next = new Set(skipping);
      next.delete(path);
      skipping = next;
    }
  }
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>
        Live run
        {#if run}
          <RunStatusBadge status={run.status} scanning={scanning} size="lg" />
          {#if run.dry_run || (isActive && live.dryRun)}
            <span class="badge warn lg" title="No files are written or deleted in this run">Dry run</span>
          {/if}
        {/if}
      </h1>
      {#if run && run.id !== 'pending'}
        <p class="sub">
          Started {dateTime(run.start_time)} · {isActive ? 'running for' : 'took'}
          <span class="tnum">{duration(elapsed)}</span>
          {#if !isActive}
            · <a href={href('run-detail', run.id)}>Open in history</a>
          {/if}
        </p>
      {/if}
    </div>
    <div class="row">
      {#if isActive}
        <button class="btn danger" onclick={() => (stopOpen = true)}><Icon name="stop" size={14} /> Stop run</button>
      {:else}
        <button class="btn primary" onclick={() => startRun()}><Icon name="play" size={14} /> Start full run</button>
      {/if}
    </div>
  </header>

  {#if !run}
    <div class="card">
      <div class="empty">
        <Icon name="activity" size={32} />
        <h3>No run yet</h3>
        <p>Start a run from here or the dashboard. Progress streams in live while it runs.</p>
      </div>
    </div>
  {:else if scanning}
    <ScanProgressCard progress={live.scanProgress} />
  {:else}
    <section class="card" aria-label="Run progress">
      <div class="counters">
        <div class="counter ok"><span class="k">OK</span><span class="v">{num(run.completed)}</span></div>
        <div class="counter warn"><span class="k">Skipped</span><span class="v">{num(run.skipped)}</span></div>
        <div class="counter err"><span class="k">Failed</span><span class="v">{num(run.failed)}</span></div>
        <div class="counter err"><span class="k">Not fitting</span><span class="v">{num(run.not_fitting)}</span></div>
        <div class="counter"><span class="k">Total</span><span class="v">{num(run.total_files)}</span></div>
        {#if run.anchors_completed > 0 || run.followers_completed > 0}
          <div class="counter accent">
            <span class="k">Fast path</span>
            <span class="v">{num(run.anchors_completed)}<span class="subtle"> / </span>{num(run.followers_completed)}</span>
            <span class="subtle small">anchors / via anchor</span>
          </div>
        {/if}
      </div>
      <div class="prog">
        <ProgressBar value={progress} size="lg" tone={isActive ? 'accent' : run.status === 'completed' ? 'ok' : 'warn'} label="Run progress" />
        <div class="prog-meta tnum small">
          <span>{num(processed)} / {num(run.total_files)} files</span>
          <span class="muted">{num(run.completed_engines)} / {num(run.total_engines)} engine passes · {progress}%</span>
          {#if etaText}
            <span class="eta"><Icon name="clock" size={13} /> ETA {etaText}</span>
          {/if}
        </div>
      </div>
    </section>

    <section class="card flush" aria-labelledby="act-h">
      <div class="card-head act-head">
        <h2 id="act-h">
          Activity
          {#if processingCount > 0}<span class="badge info">{processingCount} processing</span>{/if}
        </h2>
        <div class="search">
          <Icon name="search" size={15} />
          <input class="input" type="search" placeholder="Filter files…" aria-label="Filter files" bind:value={filter} />
        </div>
      </div>
      {#if !loaded}
        <div class="list-pad"><div class="skeleton" style="height: 48px"></div></div>
      {:else if groups.length === 0}
        <div class="empty">
          <p>{filter ? 'No files match the filter.' : 'No files processed yet.'}</p>
        </div>
      {:else}
        <div class="groups">
          {#each groups as g (g.key)}
            {#if g.grouped}
              <div class="group">
                <div class="group-head" title={g.videoPath ?? undefined}>
                  <Icon name="file" size={14} />
                  <span class="truncate">{g.videoPath ? basename(g.videoPath) : 'No video matched'}</span>
                  <span class="subtle tnum">({g.files.length})</span>
                </div>
                {#each g.files as f (f.id)}
                  <FileRow file={f} indent={f.sync_mode === 'follower'} onskip={skip} skipping={skipping.has(f.file_path)} />
                {/each}
              </div>
            {:else}
              {#each g.files as f (f.id)}
                <FileRow file={f} onskip={skip} skipping={skipping.has(f.file_path)} />
              {/each}
            {/if}
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<ConfirmDialog
  bind:open={stopOpen}
  title="Stop the current run?"
  message="Files currently being processed will finish or be abandoned; the rest are left for the next run."
  confirmLabel="Stop run"
  danger
  onconfirm={stopRun}
/>

<style>
  .counters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px;
    margin-bottom: 18px;
  }

  .counter {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-left: 3px solid var(--border-strong);
    min-width: 0;
  }

  .counter.ok {
    border-left-color: var(--ok);
  }
  .counter.warn {
    border-left-color: var(--warn);
  }
  .counter.err {
    border-left-color: var(--err);
  }
  .counter.accent {
    border-left-color: var(--accent);
  }

  .counter .k {
    font-size: 12px;
    color: var(--text-2);
    font-weight: 550;
  }

  .counter .v {
    font-size: 22px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }

  .prog-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin-top: 8px;
    align-items: center;
  }

  .eta {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
    color: var(--accent-text);
    margin-left: auto;
  }

  .act-head {
    margin-bottom: 12px;
  }

  .act-head h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .act-head .search {
    width: min(280px, 100%);
  }

  .list-pad {
    padding: 14px 18px;
  }

  .group {
    border-top: 1px solid var(--border);
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 18px 2px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
    min-width: 0;
  }

  @media (max-width: 860px) {
    .counters {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .eta {
      margin-left: 0;
    }
    .group-head {
      padding: 8px 14px 2px;
    }
    .act-head .search {
      width: 100%;
    }
  }
</style>
