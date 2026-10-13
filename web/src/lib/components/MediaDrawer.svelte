<script lang="ts">
  import { untrack } from 'svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import StatusTag from './StatusTag.svelte';
  import ModeChip from './ModeChip.svelte';
  import EngineBadges from './EngineBadges.svelte';
  import OffsetChart from './OffsetChart.svelte';
  import QualityBadge from './QualityBadge.svelte';
  import { api } from '../api';
  import { basename, dateTime, num, signedSeconds } from '../format';
  import { live } from '../live.svelte';
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

  // A re-sync started here is a run: reload when any run finishes.
  let lastTick = untrack(() => live.runFinishedTick);
  $effect(() => {
    const t = live.runFinishedTick;
    if (t === lastTick) return;
    lastTick = t;
    const p = untrack(() => mediaDrawer.path);
    if (p) void load(p);
  });

  const NUDGES = [
    { ms: -1000, label: '−1 s' },
    { ms: -100, label: '−0.1 s' },
    { ms: 100, label: '+0.1 s' },
    { ms: 1000, label: '+1 s' },
  ];
  let custom = $state<number | null>(null);

  async function act(key: string, fn: (path: string) => Promise<string | void>, failure: string) {
    if (!detail) return;
    const path = detail.filePath;
    busy = key;
    try {
      const msg = await fn(path);
      if (msg) toasts.success(msg);
      await load(path);
    } catch (e) {
      toasts.error(failure, e);
    } finally {
      busy = null;
    }
  }

  const resync = () =>
    act(
      'resync',
      async (p) => {
        await api.resyncFile(p);
        return 'Re-sync started. This drawer refreshes when it finishes.';
      },
      'Could not start re-sync',
    );

  const shift = (ms: number) =>
    act(
      'offset',
      async (p) => {
        await api.offsetFile(p, ms);
        return `Shifted ${signedSeconds(ms)}`;
      },
      'Could not shift subtitle',
    );

  function applyCustom(e: SubmitEvent) {
    e.preventDefault();
    if (custom === null || !Number.isFinite(custom) || custom === 0) return;
    void shift(Math.round(custom * 1000)).then(() => (custom = null));
  }

  const undo = () =>
    act(
      'undo',
      async (p) => {
        const r = await api.undoFile(p);
        return r.undone === 'offset' ? 'Shift undone' : 'Re-sync undone';
      },
      'Could not undo',
    );

  const setReviewed = (reviewed: boolean) =>
    act(
      'review',
      async (p) => {
        await api.reviewFile(p, reviewed);
      },
      'Could not update review state',
    );

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
  const lastUndo = $derived(detail?.undo[0] ?? null);
  const undoLabel = $derived(
    !lastUndo
      ? 'Undo'
      : lastUndo.action === 'offset' && lastUndo.offsetMs !== null
        ? `Undo shift ${signedSeconds(lastUndo.offsetMs)}`
        : 'Undo re-sync',
  );
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
          <h3 class="section-title">Sync quality</h3>
          {#if detail.quality && detail.quality.score !== null && (detail.quality.needsReview || detail.quality.reviewed)}
            <button class="btn xs" disabled={busy !== null} onclick={() => setReviewed(!detail?.quality?.reviewed)}>
              <Icon name="check" size={12} />
              {detail.quality.reviewed ? 'Unmark reviewed' : 'Mark reviewed'}
            </button>
          {/if}
        </div>
        {#if !detail.quality || detail.quality.score === null}
          <p class="muted small">No confidence score yet. One is recorded the next time this subtitle is synced.</p>
        {:else}
          {@const q = detail.quality}
          <div class="q-top">
            <QualityBadge score={q.score} level={q.level} flagged={q.needsReview} />
            {#if q.needsReview}
              <span class="small warn-text">Weak sync. Worth a listen, then shift, re-sync or mark it reviewed.</span>
            {:else if q.reviewed}
              <span class="small subtle">Reviewed</span>
            {/if}
          </div>
          {#if q.details}
            <dl class="meta small">
              <div><dt>Engines aligned</dt><dd class="tnum">{q.details.enginesAligned}</dd></div>
              {#if q.details.disagreementMs !== null}
                <div><dt>Engine gap</dt><dd class="tnum">{num(q.details.disagreementMs)} ms</dd></div>
              {/if}
              <div><dt>Shift</dt><dd class="tnum">{signedSeconds(q.details.shiftMs)}</dd></div>
              <div><dt>Offset spread</dt><dd class="tnum">{num(q.details.spreadMs)} ms</dd></div>
              <div><dt>Cues</dt><dd class="tnum">{num(q.details.cues)}</dd></div>
            </dl>
            {#if q.details.factors.length}
              <ul class="factors small">
                {#each q.details.factors as f (f.label)}
                  <li><span>{f.label}</span><span class="tnum subtle">−{f.penalty}</span></li>
                {/each}
              </ul>
            {/if}
          {/if}
        {/if}
        {#if detail.quality && detail.quality.manualOffsetMs !== 0}
          <p class="small subtle note">Shifted {signedSeconds(detail.quality.manualOffsetMs)} by hand since the last sync.</p>
        {/if}
      </section>

      <section>
        <h3 class="section-title sec-head">Adjust</h3>
        <div class="adjust">
          <button
            class="btn sm"
            disabled={busy !== null || live.isRunning}
            title={live.isRunning ? 'Available once the current run has finished' : 'Run both engines on this subtitle again'}
            onclick={resync}
          >
            <Icon name="refresh" size={14} /> Re-sync now
          </button>
          <button class="btn sm" disabled={busy !== null || !lastUndo} onclick={undo}>{undoLabel}</button>
        </div>
        <div class="nudge" role="group" aria-label="Shift all cues">
          <span class="small subtle">Shift</span>
          {#each NUDGES as n (n.ms)}
            <button class="btn xs" disabled={busy !== null} onclick={() => shift(n.ms)}>{n.label}</button>
          {/each}
          <form class="custom" onsubmit={applyCustom}>
            <input
              class="input"
              type="number"
              step="0.05"
              placeholder="± seconds"
              aria-label="Custom shift in seconds"
              bind:value={custom}
            />
            <button class="btn xs" type="submit" disabled={busy !== null || !custom}>Apply</button>
          </form>
        </div>
        <p class="small subtle note">
          Shifts are written to the file straight away and the next scan keeps them. Undo goes back up to
          10 changes.
        </p>
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
                    <QualityBadge score={h.qualityScore} />
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

  .q-top {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .warn-text {
    color: var(--warn-text);
  }

  .factors {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .factors li {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 10px;
    border-top: 1px solid var(--border);
  }

  .factors li:first-child {
    border-top: none;
  }

  .note {
    margin: 8px 0 0;
  }

  .adjust,
  .nudge {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .nudge {
    margin-top: 10px;
  }

  .custom {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .custom .input {
    width: 110px;
    height: 28px;
  }

  .tl-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
</style>
