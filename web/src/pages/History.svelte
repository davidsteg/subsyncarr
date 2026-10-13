<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../lib/components/Icon.svelte';
  import RunStatusBadge from '../lib/components/RunStatusBadge.svelte';
  import RunLogsDialog from '../lib/components/RunLogsDialog.svelte';
  import { api, errorText } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { href } from '../lib/router.svelte';
  import { dateTime, duration, num } from '../lib/format';
  import { ENGINE_NAMES, type EngineName, type Run } from '../lib/types';

  const ENGINE_ABBR: Record<EngineName, string> = { ffsubsync: 'FFS', autosubsync: 'AUTO', alass: 'ALS' };

  let runs = $state<Run[] | null>(null);
  let error = $state<string | null>(null);
  let filter = $state('');
  let logsRun = $state<Run | null>(null);
  let logsOpen = $state(false);

  async function load() {
    try {
      const all = await api.history(100);
      // Hide accidental/no-op starts: 0 files and nothing processed.
      runs = all.filter((r) => r.total_files > 0 || r.completed + r.skipped + r.failed + r.not_fitting > 0 || r.status === 'running');
      error = null;
    } catch (e) {
      error = errorText(e);
    }
  }

  onMount(() => {
    void load();
    return live.subscribe((ev) => {
      if (ev.type === 'run:started' || ev.type === 'run:completed' || ev.type === 'run:cancelled') void load();
    });
  });

  const filtered = $derived.by(() => {
    if (!runs) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter(
      (r) =>
        dateTime(r.start_time).toLowerCase().includes(q) ||
        r.status.includes(q) ||
        String(r.total_files).includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.dry_run && 'dry run'.includes(q)),
    );
  });

  function runDuration(r: Run): string {
    if (!r.end_time) return r.status === 'running' ? 'running' : '—';
    return duration(r.end_time - r.start_time);
  }

  function openLogs(r: Run) {
    logsRun = r;
    logsOpen = true;
  }
</script>

{#snippet engineCell(r: Run, engine: string)}
  {@const s = r.engine_stats?.[engine]}
  {#if !s || s.pass + s.fail === 0}
    <span class="subtle">–</span>
  {:else}
    <span class="pf">
      {#if s.pass > 0}<span class="pass" title="{s.pass} passed">{num(s.pass)}</span>{/if}
      {#if s.pass > 0 && s.fail > 0}<span class="subtle">/</span>{/if}
      {#if s.fail > 0}<span class="fail" title="{s.fail} failed">{num(s.fail)}</span>{/if}
    </span>
  {/if}
{/snippet}

{#snippet countLink(r: Run, n: number, tab: string, tone: string)}
  {#if n > 0}
    <a class="count {tone}" href={href('run-detail', r.id, tab)}>{num(n)}</a>
  {:else}
    <span class="subtle">0</span>
  {/if}
{/snippet}

<div class="page">
  <header class="page-head">
    <div>
      <h1>History</h1>
      <p class="sub">Past runs, newest first</p>
    </div>
    <div class="row">
      <div class="search">
        <Icon name="search" size={15} />
        <input class="input" type="search" placeholder="Filter runs…" aria-label="Filter runs" bind:value={filter} />
      </div>
      <button class="icon-btn" aria-label="Refresh history" title="Refresh" onclick={load}><Icon name="refresh" /></button>
    </div>
  </header>

  {#if error}
    <div class="banner err" role="alert">
      <Icon name="alert" />
      <div><strong>Could not load history</strong><p>{error}</p></div>
    </div>
  {/if}

  {#if runs === null && !error}
    <div class="card"><div class="skeleton" style="height: 160px"></div></div>
  {:else if runs && filtered.length === 0}
    <div class="card">
      <div class="empty">
        <Icon name="history" size={32} />
        <h3>{runs.length === 0 ? 'No runs yet' : 'No runs match'}</h3>
        <p>{runs.length === 0 ? 'Completed and cancelled runs show up here.' : 'Try a different filter.'}</p>
      </div>
    </div>
  {:else if runs}
    <div class="card flush desktop">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Status</th>
              <th class="r">Files</th>
              <th class="r">OK</th>
              <th class="r"><abbr title="Anchors / followers (fast path)">A / F</abbr></th>
              <th class="r">Skipped</th>
              <th class="r">Failed</th>
              <th class="r"><abbr title="Not fitting">NF</abbr></th>
              {#each ENGINE_NAMES as e (e)}<th class="r"><abbr title="{e} pass / fail">{ENGINE_ABBR[e]}</abbr></th>{/each}
              <th class="r">Duration</th>
              <th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as r (r.id)}
              <tr>
                <td>
                  <a href={href('run-detail', r.id)} class="start">{dateTime(r.start_time)}</a>
                </td>
                <td>
                  <span class="row nowrap">
                    <RunStatusBadge status={r.status} />
                    {#if r.dry_run}<span class="badge warn">Dry</span>{/if}
                  </span>
                </td>
                <td class="r">{num(r.total_files)}</td>
                <td class="r">{@render countLink(r, r.completed, 'completed', 'ok')}</td>
                <td class="r">
                  {#if r.anchors_completed || r.followers_completed}
                    {num(r.anchors_completed)}<span class="subtle"> / </span>{num(r.followers_completed)}
                  {:else}<span class="subtle">–</span>{/if}
                </td>
                <td class="r">{@render countLink(r, r.skipped, 'skipped', 'warn')}</td>
                <td class="r">{@render countLink(r, r.failed, 'error', 'err')}</td>
                <td class="r">{@render countLink(r, r.not_fitting, 'not_fitting', 'err')}</td>
                {#each ENGINE_NAMES as e (e)}<td class="r">{@render engineCell(r, e)}</td>{/each}
                <td class="r">{runDuration(r)}</td>
                <td class="r">
                  <span class="row nowrap end">
                    <button class="btn xs" onclick={() => openLogs(r)}>Logs</button>
                    <a class="icon-btn sm" href={href('run-detail', r.id)} aria-label="Open run from {dateTime(r.start_time)}">
                      <Icon name="chevron-right" size={16} />
                    </a>
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <ul class="cards mobile">
      {#each filtered as r (r.id)}
        <li class="card run-card">
          <div class="rc-head">
            <a href={href('run-detail', r.id)} class="start">{dateTime(r.start_time)}</a>
            <RunStatusBadge status={r.status} />
            {#if r.dry_run}<span class="badge warn">Dry</span>{/if}
          </div>
          <dl class="rc-grid tnum">
            <div><dt>Files</dt><dd>{num(r.total_files)}</dd></div>
            <div><dt>OK</dt><dd>{@render countLink(r, r.completed, 'completed', 'ok')}</dd></div>
            <div><dt>Skipped</dt><dd>{@render countLink(r, r.skipped, 'skipped', 'warn')}</dd></div>
            <div><dt>Failed</dt><dd>{@render countLink(r, r.failed, 'error', 'err')}</dd></div>
            <div><dt>Not fitting</dt><dd>{@render countLink(r, r.not_fitting, 'not_fitting', 'err')}</dd></div>
            <div><dt>Duration</dt><dd>{runDuration(r)}</dd></div>
            {#if r.anchors_completed || r.followers_completed}
              <div><dt title="Anchors / followers">Fast path</dt><dd>{num(r.anchors_completed)} / {num(r.followers_completed)}</dd></div>
            {/if}
            {#each ENGINE_NAMES as e (e)}
              {#if r.engine_stats?.[e] && r.engine_stats[e].pass + r.engine_stats[e].fail > 0}
                <div><dt>{e}</dt><dd>{@render engineCell(r, e)}</dd></div>
              {/if}
            {/each}
          </dl>
          <div class="rc-actions">
            <button class="btn sm" onclick={() => openLogs(r)}>Logs</button>
            <a class="btn sm" href={href('run-detail', r.id)}>Details <Icon name="chevron-right" size={14} /></a>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<RunLogsDialog bind:open={logsOpen} runId={logsRun?.id ?? null} title={logsRun ? `Logs · ${dateTime(logsRun.start_time)}` : 'Logs'} />

<style>
  .search {
    width: min(260px, 100%);
  }

  .nowrap {
    flex-wrap: nowrap;
  }

  .end {
    justify-content: flex-end;
  }

  .start {
    color: var(--text);
    font-weight: 550;
  }

  .start:hover {
    color: var(--accent-text);
  }

  .count {
    font-weight: 600;
  }
  .count.ok {
    color: var(--ok-text);
  }
  .count.warn {
    color: var(--warn-text);
  }
  .count.err {
    color: var(--err-text);
  }

  .pf {
    display: inline-flex;
    gap: 3px;
  }

  .pass {
    color: var(--ok-text);
    font-weight: 600;
  }

  .fail {
    color: var(--err-text);
    font-weight: 600;
  }

  abbr {
    text-decoration: none;
    cursor: help;
  }

  .table :global(th),
  .table :global(td) {
    padding-left: 8px;
    padding-right: 8px;
  }

  .icon-btn.sm {
    width: 28px;
    height: 28px;
  }

  .mobile {
    display: none;
  }

  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    flex-direction: column;
    gap: 10px;
  }

  .rc-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .rc-head .start {
    flex: 1 1 auto;
  }

  .rc-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px 10px;
    margin: 0;
  }

  .rc-grid div {
    min-width: 0;
  }

  .rc-grid dt {
    font-size: 11.5px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rc-grid dd {
    margin: 0;
    font-weight: 550;
  }

  .rc-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }

  @media (max-width: 860px) {
    .desktop {
      display: none;
    }
    .mobile {
      display: flex;
    }
    .search {
      flex: 1;
      width: auto;
    }
    .page-head > .row {
      width: 100%;
      flex-wrap: nowrap;
    }
  }
</style>
