<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../lib/components/Icon.svelte';
  import RunStatusBadge from '../lib/components/RunStatusBadge.svelte';
  import FileRow from '../lib/components/FileRow.svelte';
  import RunLogs from '../lib/components/RunLogs.svelte';
  import { api, ApiError, errorText } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { href, router } from '../lib/router.svelte';
  import { dateTime, duration, num } from '../lib/format';
  import { ENGINE_NAMES, type FileStatus, type Run, type RunFilesResponse } from '../lib/types';

  let { id }: { id: string } = $props();

  type Tab = 'all' | 'completed' | 'skipped' | 'error' | 'not_fitting' | 'logs';
  const TABS: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'completed', label: 'Completed' },
    { key: 'skipped', label: 'Skipped' },
    { key: 'error', label: 'Failed' },
    { key: 'not_fitting', label: 'Not fitting' },
    { key: 'logs', label: 'Logs' },
  ];

  function initialTab(): Tab {
    const t = router.route.params.tab;
    return TABS.some((x) => x.key === t) ? (t as Tab) : 'all';
  }

  let run = $state<Run | null>(null);
  let runError = $state<string | null>(null);
  let notFound = $state(false);
  let tab = $state<Tab>(initialTab());
  let page = $state(1);
  let filesResp = $state<RunFilesResponse | null>(null);
  let filesError = $state<string | null>(null);
  let filesLoading = $state(false);
  let seq = 0;

  async function loadRun() {
    try {
      const r = await api.run(id, 1);
      run = r.run;
      runError = null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) notFound = true;
      else runError = errorText(e);
    }
  }

  async function loadFiles(t: Tab, p: number) {
    if (t === 'logs') return;
    const mySeq = ++seq;
    filesLoading = true;
    filesError = null;
    try {
      const status: FileStatus | '' = t === 'all' ? '' : t;
      const r = await api.runFiles(id, { status, page: p, limit: 100 });
      if (mySeq === seq) filesResp = r;
    } catch (e) {
      if (mySeq === seq) filesError = errorText(e);
    } finally {
      if (mySeq === seq) filesLoading = false;
    }
  }

  onMount(() => {
    void loadRun();
    return live.subscribe((ev) => {
      if (ev.type === 'file:updated' && ev.data.runId === id) run = ev.data.run;
      if ((ev.type === 'run:completed' || ev.type === 'run:cancelled') && ev.data.id === id) {
        run = ev.data;
        void loadFiles(tab, page);
      }
    });
  });

  $effect(() => {
    void loadFiles(tab, page);
  });

  function selectTab(t: Tab) {
    if (t === tab) return;
    tab = t;
    page = 1;
    filesResp = null;
    const url = href('run-detail', id, t === 'all' ? undefined : t);
    history.replaceState(null, '', url);
  }

  function onTabKey(e: KeyboardEvent, i: number) {
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(TABS[next].key);
    document.getElementById(`tab-${TABS[next].key}`)?.focus();
  }

  function count(t: Tab): number | null {
    if (!run) return null;
    switch (t) {
      case 'all':
        return run.total_files;
      case 'completed':
        return run.completed;
      case 'skipped':
        return run.skipped;
      case 'error':
        return run.failed;
      case 'not_fitting':
        return run.not_fitting;
      default:
        return null;
    }
  }

  const runDuration = $derived(run ? (run.end_time ? duration(run.end_time - run.start_time) : 'in progress') : '');
</script>

<div class="page">
  <nav class="crumbs small" aria-label="Breadcrumb">
    <a href={href('history')}><Icon name="chevron-left" size={14} /> History</a>
  </nav>

  {#if notFound}
    <div class="card">
      <div class="empty">
        <Icon name="alert" size={32} />
        <h3>Run not found</h3>
        <p>This run may have been pruned from the database.</p>
        <a class="btn" href={href('history')}>Back to history</a>
      </div>
    </div>
  {:else}
    <header class="page-head">
      <div>
        <h1>
          Run {run ? dateTime(run.start_time) : ''}
          {#if run}
            <RunStatusBadge status={run.status} size="lg" />
            {#if run.dry_run}<span class="badge warn lg">Dry run</span>{/if}
          {/if}
        </h1>
        <p class="sub mono small break">{id}</p>
      </div>
      {#if run?.status === 'running' && live.currentRun?.id === id}
        <a class="btn" href={href('run')}><span class="dot pulse accent"></span> Live view</a>
      {/if}
    </header>

    {#if runError}
      <div class="banner err" role="alert"><Icon name="alert" /><div><strong>Could not load run</strong><p>{runError}</p></div></div>
    {/if}

    {#if run}
      <section class="card summary" aria-label="Run summary">
        <dl class="sum-grid tnum">
          <div><dt>Files</dt><dd>{num(run.total_files)}</dd></div>
          <div><dt>OK</dt><dd class="ok">{num(run.completed)}</dd></div>
          <div><dt>Skipped</dt><dd class="warn">{num(run.skipped)}</dd></div>
          <div><dt>Failed</dt><dd class="err">{num(run.failed)}</dd></div>
          <div><dt>Not fitting</dt><dd class="err">{num(run.not_fitting)}</dd></div>
          <div><dt>Anchors / followers</dt><dd>{num(run.anchors_completed)} / {num(run.followers_completed)}</dd></div>
          <div><dt>Duration</dt><dd>{runDuration}</dd></div>
          <div><dt>Ended</dt><dd class="small-dd">{run.end_time ? dateTime(run.end_time) : '—'}</dd></div>
        </dl>
        <div class="eng-row">
          {#each ENGINE_NAMES as e (e)}
            {@const s = run.engine_stats?.[e]}
            {#if s && s.pass + s.fail > 0}
              <span class="eng-stat">
                <span class="mono">{e}</span>
                <span class="pass tnum">{num(s.pass)} pass</span>
                <span class="fail tnum">{num(s.fail)} fail</span>
              </span>
            {/if}
          {/each}
          {#each Object.keys(run.engine_stats ?? {}).filter((k) => !(ENGINE_NAMES as readonly string[]).includes(k)) as e (e)}
            {@const s = run.engine_stats[e]}
            <span class="eng-stat">
              <span class="mono">{e}</span>
              <span class="pass tnum">{num(s.pass)} pass</span>
              <span class="fail tnum">{num(s.fail)} fail</span>
            </span>
          {/each}
        </div>
      </section>
    {/if}

    <section class="card flush">
      <div class="tabs" role="tablist" aria-label="Files by status">
        {#each TABS as t, i (t.key)}
          {@const c = count(t.key)}
          <button
            id="tab-{t.key}"
            role="tab"
            aria-selected={tab === t.key}
            aria-controls="tabpanel"
            tabindex={tab === t.key ? 0 : -1}
            onclick={() => selectTab(t.key)}
            onkeydown={(e) => onTabKey(e, i)}
          >
            {t.label}
            {#if c !== null}<span class="count">{num(c)}</span>{/if}
          </button>
        {/each}
      </div>

      <div id="tabpanel" role="tabpanel" aria-labelledby="tab-{tab}" class="panel">
        {#if tab === 'logs'}
          <div class="pad"><RunLogs runId={id} /></div>
        {:else if filesError}
          <div class="pad">
            <div class="banner err" role="alert"><Icon name="alert" /><div><strong>Could not load files</strong><p>{filesError}</p></div></div>
          </div>
        {:else if !filesResp}
          <div class="pad"><div class="skeleton" style="height: 120px"></div></div>
        {:else if filesResp.files.length === 0}
          <div class="empty"><p>No files in this category.</p></div>
        {:else}
          <div class="files" class:dim={filesLoading}>
            {#each filesResp.files as f (f.id)}
              <FileRow file={f} showTime />
            {/each}
          </div>
          {#if filesResp.totalPages > 1}
            <nav class="pager" aria-label="Pagination">
              <button class="btn sm" disabled={page <= 1 || filesLoading} onclick={() => (page = page - 1)}>
                <Icon name="chevron-left" size={14} /> Previous
              </button>
              <span class="tnum small muted">
                Page {num(filesResp.page)} of {num(filesResp.totalPages)} · {num(filesResp.total)} files
              </span>
              <button class="btn sm" disabled={page >= filesResp.totalPages || filesLoading} onclick={() => (page = page + 1)}>
                Next <Icon name="chevron-right" size={14} />
              </button>
            </nav>
          {:else}
            <p class="foot small subtle tnum">{num(filesResp.total)} files</p>
          {/if}
        {/if}
      </div>
    </section>
  {/if}
</div>

<style>
  .crumbs a {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--text-2);
  }

  .sum-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 12px 16px;
    margin: 0;
  }

  .sum-grid dt {
    font-size: 12px;
    color: var(--text-3);
  }

  .sum-grid dd {
    margin: 0;
    font-size: 18px;
    font-weight: 650;
  }

  .sum-grid dd.small-dd {
    font-size: 13px;
    font-weight: 550;
    padding-top: 4px;
  }

  dd.ok {
    color: var(--ok-text);
  }
  dd.warn {
    color: var(--warn-text);
  }
  dd.err {
    color: var(--err-text);
  }

  .eng-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }

  .eng-row:empty {
    display: none;
  }

  .eng-stat {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    font-size: 12.5px;
  }

  .pass {
    color: var(--ok-text);
  }

  .fail {
    color: var(--err-text);
  }

  .tabs {
    padding: 0 10px;
  }

  .pad {
    padding: 16px 18px;
  }

  .files {
    transition: opacity 0.15s;
  }

  .files.dim {
    opacity: 0.55;
  }

  .files :global(.file-row:first-child) {
    border-top: none;
  }

  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 18px;
    border-top: 1px solid var(--border);
    flex-wrap: wrap;
  }

  .foot {
    padding: 10px 18px;
    border-top: 1px solid var(--border);
  }

  @media (max-width: 860px) {
    .pad {
      padding: 14px;
    }
    .sum-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .pager {
      padding: 10px 14px;
    }
  }
</style>
