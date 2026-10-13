<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../lib/components/Icon.svelte';
  import ProgressBar from '../lib/components/ProgressBar.svelte';
  import Dialog from '../lib/components/Dialog.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import ScanProgressCard from '../lib/components/ScanProgressCard.svelte';
  import RunStatusBadge from '../lib/components/RunStatusBadge.svelte';
  import { api, errorText } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { meta, startRun, stopRun } from '../lib/ui.svelte';
  import { href } from '../lib/router.svelte';
  import { dateTime, num, pct, relative } from '../lib/format';
  import type { Stats } from '../lib/types';

  let stats = $state<Stats | null>(null);
  let statsError = $state<string | null>(null);

  let customOpen = $state(false);
  let customPaths = $state('');
  let customDry = $state(false);
  let dryConfirmOpen = $state(false);
  let stopConfirmOpen = $state(false);
  let showAllLangs = $state(false);

  async function loadStats() {
    try {
      stats = await api.stats();
      statsError = null;
    } catch (e) {
      statsError = errorText(e);
    }
  }

  onMount(() => {
    void loadStats();
    void meta.loadConfig();
    const t = setInterval(loadStats, 15_000);
    return () => clearInterval(t);
  });

  // Refresh immediately when a run finishes.
  let lastTick = live.runFinishedTick;
  $effect(() => {
    const tick = live.runFinishedTick;
    if (tick !== lastTick) {
      lastTick = tick;
      void loadStats();
      void meta.loadConfig();
    }
  });

  const pending = $derived(stats ? Math.max(0, stats.totalFiles - stats.syncedFiles - stats.skippedFiles) : 0);
  const langMax = $derived(stats ? Math.max(1, ...stats.languages.map((l) => l.count)) : 1);
  const langTotal = $derived(stats ? stats.languages.reduce((a, l) => a + l.count, 0) : 0);
  const langs = $derived(stats ? (showAllLangs ? stats.languages : stats.languages.slice(0, 10)) : []);

  const parsedPaths = $derived(
    customPaths
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean),
  );

  function submitCustom(e: SubmitEvent) {
    e.preventDefault();
    if (parsedPaths.length === 0) return;
    const paths = parsedPaths;
    const dry = customDry;
    customOpen = false;
    customPaths = '';
    customDry = false;
    void startRun({ paths, dryRun: dry });
  }

  const cfg = $derived(meta.config);
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Dashboard</h1>
      <p class="sub">Subtitle sync status across your library</p>
    </div>
    <div class="row actions">
      {#if live.isRunning}
        <a class="btn" href={href('run')}><span class="dot pulse accent"></span> View live run</a>
        <button class="btn danger" onclick={() => (stopConfirmOpen = true)}>
          <Icon name="stop" size={14} /> Stop
        </button>
      {:else}
        <button class="btn" onclick={() => (customOpen = true)}>
          <Icon name="target" size={16} /> Scan paths…
        </button>
        <button class="btn" onclick={() => (dryConfirmOpen = true)} title="Run a full scan without writing or deleting any files">
          <Icon name="flask" size={16} /> Dry run
        </button>
        <button class="btn primary" onclick={() => startRun()}>
          <Icon name="play" size={14} /> Start full run
        </button>
      {/if}
    </div>
  </header>

  <section class="status-strip card" aria-label="Instance status">
    <div class="strip-item">
      <span class="strip-label"><Icon name="pin" size={14} /> Watching</span>
      {#if cfg}
        {#if cfg.paths.length}
          <span class="paths">
            {#each cfg.paths as p (p)}<code>{p}</code>{/each}
          </span>
        {:else}
          <span class="muted">No paths</span>
        {/if}
        {#if cfg.excludePaths.length}
          <span class="subtle small">excluding {cfg.excludePaths.join(', ')}</span>
        {/if}
      {:else if meta.configError}
        <span class="muted">Unavailable</span>
      {:else}
        <span class="skeleton" style="width: 160px"></span>
      {/if}
    </div>
    <div class="strip-item">
      <span class="strip-label"><Icon name="clock" size={14} /> Schedule</span>
      {#if cfg}
        {#if cfg.schedule?.enabled}
          <span>{cfg.schedule.description || cfg.schedule.cron}</span>
          {#if cfg.schedule.nextRun}
            <span class="subtle small" title={dateTime(cfg.schedule.nextRun)}>
              next {relative(cfg.schedule.nextRun)} · {dateTime(cfg.schedule.nextRun)}
            </span>
          {/if}
        {:else}
          <span>Manual only</span>
        {/if}
      {:else}
        <span class="skeleton" style="width: 120px"></span>
      {/if}
    </div>
    <div class="strip-item">
      <span class="strip-label"><Icon name="activity" size={14} /> State</span>
      {#if live.isRunning && live.currentRun}
        <span class="row">
          <RunStatusBadge status="running" scanning={live.isScanning} />
          {#if live.dryRun}<span class="badge warn">Dry run</span>{/if}
        </span>
      {:else}
        <span class="row"><span class="dot ok"></span> Idle</span>
      {/if}
    </div>
  </section>

  {#if cfg && !cfg.isConfigured}
    <div class="banner err" role="alert">
      <Icon name="alert" />
      <div>
        <strong>No scan path configured</strong>
        <p>
          <code>SCAN_PATHS</code> is not set, so this instance is watching the placeholder default
          {#if cfg.paths.length}(<code>{cfg.paths.join(', ')}</code>){/if}, which almost certainly doesn't exist. Every scan —
          manual or scheduled — will find 0 files and silently do nothing. Set <code>SCAN_PATHS</code> in the container's
          environment and restart.
        </p>
      </div>
    </div>
  {/if}

  {#if live.isScanning}
    <ScanProgressCard progress={live.scanProgress} />
  {/if}

  {#if statsError && !stats}
    <div class="banner err" role="alert">
      <Icon name="alert" />
      <div>
        <strong>Could not load statistics</strong>
        <p>{statsError}</p>
      </div>
      <span class="spacer"></span>
      <button class="btn sm" onclick={loadStats}>Retry</button>
    </div>
  {/if}

  <section class="grid stats" aria-label="Library statistics">
    {#if stats}
      <div class="card stat">
        <span class="label">Total tracked</span>
        <span class="value">{num(stats.totalFiles)}</span>
        <span class="hint">subtitle files</span>
      </div>
      <div class="card stat">
        <span class="label"><span class="dot ok"></span> Synced</span>
        <span class="value">{num(stats.syncedFiles)}</span>
        <ProgressBar value={stats.syncRate} tone="ok" label="Sync rate" />
        <span class="hint">{stats.syncRate}% complete</span>
      </div>
      <div class="card stat">
        <span class="label"><span class="dot warn"></span> Skipped</span>
        <span class="value">{num(stats.skippedFiles)}</span>
        <span class="hint">{pct(stats.skippedFiles, stats.totalFiles)}% of library</span>
      </div>
      <div class="card stat">
        <span class="label"><span class="dot info"></span> Pending</span>
        <span class="value">{num(pending)}</span>
        <span class="hint">{pct(pending, stats.totalFiles)}% of library</span>
      </div>
      {#if stats.fastPath && stats.fastPath.followers > 0}
        <div class="card stat">
          <span class="label"><span class="dot accent"></span> Fast path</span>
          <span class="value">{stats.fastPath.followerShare}%</span>
          <ProgressBar value={stats.fastPath.followerShare} label="Fast path share" />
          <span class="hint">{num(stats.fastPath.followers)} via anchor · {num(stats.fastPath.anchors)} anchors</span>
        </div>
      {/if}
    {:else}
      {#each [1, 2, 3, 4] as i (i)}
        <div class="card stat"><span class="skeleton" style="width: 60%"></span><span class="skeleton" style="height: 28px; width: 40%"></span></div>
      {/each}
    {/if}
  </section>

  {#if stats}
    <div class="grid two">
      <section class="card" aria-labelledby="eng-h">
        <div class="card-head">
          <h2 id="eng-h">Engines</h2>
          <span class="subtle small">files synced per engine</span>
        </div>
        {#if stats.engines.length === 0}
          <p class="muted small">No engine results yet.</p>
        {:else}
          <ul class="bars">
            {#each stats.engines as e (e.engine)}
              <li>
                <div class="bar-head">
                  <span class="mono name">{e.engine}</span>
                  <span class="tnum small muted">{num(e.synced)} / {num(e.total)}</span>
                  <span class="tnum rate">{e.rate}%</span>
                </div>
                <ProgressBar value={e.rate} tone="ok" label="{e.engine} success rate" />
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="card" aria-labelledby="lang-h">
        <div class="card-head">
          <h2 id="lang-h">Languages</h2>
          <span class="subtle small">{num(stats.languages.length)} detected</span>
        </div>
        {#if stats.languages.length === 0}
          <p class="muted small">No language data yet.</p>
        {:else}
          <ul class="langs">
            {#each langs as l (l.name)}
              <li>
                <span class="lang-name truncate" title={l.name}>{l.name || '?'}</span>
                <span class="lang-track"><span style:width="{(l.count / langMax) * 100}%"></span></span>
                <span class="tnum small lang-count">{num(l.count)}</span>
                <span class="tnum small subtle lang-pct">{pct(l.count, langTotal)}%</span>
              </li>
            {/each}
          </ul>
          {#if stats.languages.length > 10}
            <button class="btn ghost sm more" onclick={() => (showAllLangs = !showAllLangs)}>
              {showAllLangs ? 'Show top 10' : `Show all ${stats.languages.length}`}
            </button>
          {/if}
        {/if}
      </section>
    </div>
  {/if}
</div>

<Dialog bind:open={customOpen} title="Scan specific paths">
  <form id="custom-form" onsubmit={submitCustom} class="form">
    <div class="field">
      <label for="custom-paths">Paths <span class="subtle">(one per line)</span></label>
      <textarea
        id="custom-paths"
        class="textarea"
        bind:value={customPaths}
        placeholder={'/media/tv/Some Show\n/media/movies/Some Movie (2024)'}
        spellcheck="false"
      ></textarea>
      <span class="help">Only these directories are scanned. They should live inside your configured scan paths.</span>
    </div>
    <label class="check">
      <input type="checkbox" bind:checked={customDry} />
      <span>Dry run — preview only, don't write or delete files</span>
    </label>
  </form>
  {#snippet footer()}
    <button class="btn" type="button" onclick={() => (customOpen = false)}>Cancel</button>
    <button class="btn primary" type="submit" form="custom-form" disabled={parsedPaths.length === 0}>
      <Icon name="play" size={14} /> Start scan{parsedPaths.length > 1 ? ` (${parsedPaths.length})` : ''}
    </button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={dryConfirmOpen}
  title="Start a dry run?"
  message="Engines will run against every unsynced subtitle, but no files are written or deleted. Useful to preview what a real run would do."
  confirmLabel="Start dry run"
  onconfirm={() => startRun({ dryRun: true })}
/>

<ConfirmDialog
  bind:open={stopConfirmOpen}
  title="Stop the current run?"
  message="Files currently being processed will finish or be abandoned; the rest are left for the next run."
  confirmLabel="Stop run"
  danger
  onconfirm={stopRun}
/>

<style>
  .actions {
    justify-content: flex-end;
  }

  .status-strip {
    display: grid;
    grid-template-columns: 2fr 1.4fr 1fr;
    gap: 14px 24px;
    padding: 14px 20px;
  }

  .strip-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .strip-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-3);
  }

  .paths {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .spacer {
    flex: 1;
  }

  .bars,
  .langs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .bar-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 6px;
  }

  .bar-head .name {
    font-weight: 600;
    flex: 1;
  }

  .bar-head .rate {
    font-weight: 600;
    min-width: 40px;
    text-align: right;
  }

  .langs {
    gap: 7px;
  }

  .langs li {
    display: grid;
    grid-template-columns: minmax(70px, 140px) 1fr auto 38px;
    align-items: center;
    gap: 10px;
  }

  .lang-name {
    font-size: 13px;
  }

  .lang-track {
    height: 8px;
    background: var(--surface-2);
    border-radius: 99px;
    overflow: hidden;
  }

  .lang-track span {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: 99px;
  }

  .lang-count {
    text-align: right;
  }

  .lang-pct {
    text-align: right;
  }

  .more {
    margin-top: 10px;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  @media (max-width: 860px) {
    .status-strip {
      grid-template-columns: 1fr;
      padding: 12px 14px;
    }
    .actions {
      width: 100%;
      justify-content: stretch;
    }
    .actions > :global(*) {
      flex: 1 1 auto;
    }
    .langs li {
      grid-template-columns: minmax(60px, 90px) 1fr auto;
    }
    .lang-pct {
      display: none;
    }
  }
</style>
