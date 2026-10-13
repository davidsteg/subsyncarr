<script lang="ts">
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import StatusTag from './StatusTag.svelte';
  import ModeChip from './ModeChip.svelte';
  import EngineBadges from './EngineBadges.svelte';
  import OffsetChart from './OffsetChart.svelte';
  import { api } from '../api';
  import { basename, dateTime, num } from '../format';
  import { mediaDrawer, toasts } from '../ui.svelte';
  import { href } from '../router.svelte';
  import type { FailureTracking, MediaDetail } from '../types';

  let detail = $state<MediaDetail | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let loadSeq = 0;

  let open = $state(false);

  $effect(() => {
    open = mediaDrawer.path !== null;
  });

  $effect(() => {
    const p = mediaDrawer.path;
    if (p) void load(p);
  });

  async function load(path: string) {
    const seq = ++loadSeq;
    loading = true;
    error = null;
    if (detail?.filePath !== path) detail = null;
    try {
      const d = await api.media(path);
      if (seq === loadSeq) detail = d;
    } catch (e) {
      if (seq === loadSeq) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  async function reset(engine?: string) {
    if (!detail) return;
    busy = engine ?? '*';
    try {
      await api.resetSkip(detail.filePath, engine);
      toasts.success(engine ? `Skip status reset for ${engine}` : 'Skip status reset for all engines');
      await load(detail.filePath);
    } catch (e) {
      toasts.error('Reset failed', e);
    } finally {
      busy = null;
    }
  }

  function engineState(ft: FailureTracking): { label: string; tone: string } {
    if (ft.is_skipped) return { label: 'Skipped', tone: 'warn' };
    if (ft.last_success_time) return { label: 'OK', tone: 'ok' };
    return { label: 'Pending', tone: 'info' };
  }

  const title = $derived(basename(mediaDrawer.path) || 'Media detail');
  const anySkipped = $derived(detail?.failureTracking.some((f) => f.is_skipped || f.consecutive_failures > 0) ?? false);
</script>

<Dialog bind:open {title} variant="drawer" onclose={() => mediaDrawer.close()}>
  {#snippet header()}
    {#if mediaDrawer.path}
      <p class="path mono subtle break">{mediaDrawer.path}</p>
    {/if}
  {/snippet}

  {#if loading && !detail}
    <div class="stack">
      <div class="skeleton" style="height: 60px"></div>
      <div class="skeleton" style="height: 120px"></div>
      <div class="skeleton" style="height: 160px"></div>
    </div>
  {:else if error}
    <div class="banner err" role="alert">
      <Icon name="alert" />
      <div>
        <strong>Could not load media detail</strong>
        <p>{error}</p>
      </div>
    </div>
  {:else if detail}
    <div class="stack">
      <section class="summary">
        <div class="kv">
          <span class="subtle small">Not-fitting strikes</span>
          <span class="tnum strong" class:warn={detail.notFittingStrikes > 0}>{num(detail.notFittingStrikes)}</span>
        </div>
        <div class="kv">
          <span class="subtle small">Runs touching this file</span>
          <span class="tnum strong">{num(detail.syncHistory.length)}</span>
        </div>
      </section>

      <section>
        <div class="sec-head">
          <h3 class="section-title">Engine status</h3>
          {#if detail.failureTracking.length > 0}
            <button class="btn sm" disabled={busy !== null || !anySkipped} onclick={() => reset()}>
              <Icon name="refresh" size={14} /> Reset all
            </button>
          {/if}
        </div>
        {#if detail.failureTracking.length === 0}
          <p class="muted small">No engine failures tracked for this file.</p>
        {:else}
          <ul class="engines">
            {#each detail.failureTracking as ft (ft.engine)}
              {@const st = engineState(ft)}
              <li>
                <div class="eng-top">
                  <span class="eng-name">{ft.engine}</span>
                  <span class="badge {st.tone}">{st.label}</span>
                  <span class="spacer"></span>
                  <button
                    class="btn xs"
                    disabled={busy !== null || (!ft.is_skipped && ft.consecutive_failures === 0)}
                    aria-label="Reset skip status for {ft.engine}"
                    onclick={() => reset(ft.engine)}
                  >
                    Reset skip
                  </button>
                </div>
                <dl class="meta small">
                  <div><dt>Consecutive failures</dt><dd class="tnum">{num(ft.consecutive_failures)}</dd></div>
                  <div><dt>Last OK</dt><dd>{ft.last_success_time ? dateTime(ft.last_success_time) : 'Never'}</dd></div>
                  <div><dt>Last failure</dt><dd>{ft.last_failure_time ? dateTime(ft.last_failure_time) : 'Never'}</dd></div>
                </dl>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section>
        <h3 class="section-title sec-head">Offsets</h3>
        <OffsetChart history={detail.syncHistory} />
      </section>

      <section>
        <h3 class="section-title sec-head">Sync history</h3>
        {#if detail.syncHistory.length === 0}
          <p class="muted small">This file has not been part of any recorded run.</p>
        {:else}
          <ol class="timeline">
            {#each detail.syncHistory as h (h.runId + h.updatedAt)}
              <li>
                <span class="tl-dot {h.fileStatus}"></span>
                <div class="tl-body">
                  <div class="row">
                    <a class="small" href={href('run-detail', h.runId)} onclick={() => mediaDrawer.close()}>{dateTime(h.runStartTime)}</a>
                    <StatusTag status={h.fileStatus} />
                    <ModeChip mode={h.syncMode} filePath={detail.filePath} anchorPath={h.anchorPath} showAnchor />
                  </div>
                  <EngineBadges engines={h.engines} />
                </div>
              </li>
            {/each}
          </ol>
        {/if}
      </section>
    </div>
  {/if}
</Dialog>

<style>
  .path {
    font-size: 12px;
    margin: 0;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .kv {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
  }

  .strong {
    font-size: 20px;
    font-weight: 650;
  }

  .strong.warn {
    color: var(--warn-text);
  }

  .sec-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }

  .engines {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .engines li {
    padding: 10px 12px;
    border-top: 1px solid var(--border);
  }

  .engines li:first-child {
    border-top: none;
  }

  .eng-top {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .eng-name {
    font-weight: 600;
    font-family: var(--mono);
    font-size: 13px;
  }

  .spacer {
    flex: 1;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 18px;
    margin: 6px 0 0;
    color: var(--text-2);
  }

  .meta div {
    display: flex;
    gap: 5px;
  }

  .meta dt {
    color: var(--text-3);
  }

  .meta dd {
    margin: 0;
  }

  .timeline {
    list-style: none;
    margin: 0;
    padding: 0 0 0 4px;
    position: relative;
  }

  .timeline li {
    display: flex;
    gap: 12px;
    position: relative;
    padding-bottom: 14px;
  }

  .timeline li::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 14px;
    bottom: 0;
    width: 1px;
    background: var(--border);
  }

  .timeline li:last-child::before {
    display: none;
  }

  .tl-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-top: 6px;
    flex-shrink: 0;
    background: var(--text-3);
  }

  .tl-dot.completed {
    background: var(--ok);
  }
  .tl-dot.error,
  .tl-dot.not_fitting {
    background: var(--err);
  }
  .tl-dot.skipped {
    background: var(--warn);
  }
  .tl-dot.processing {
    background: var(--info);
  }

  .tl-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
</style>
