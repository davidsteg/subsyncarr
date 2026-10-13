<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../lib/components/Icon.svelte';
  import StackedTimeline from '../lib/components/stats/StackedTimeline.svelte';
  import AgreementScatter from '../lib/components/stats/AgreementScatter.svelte';
  import HBars from '../lib/components/stats/HBars.svelte';
  import SegBar from '../lib/components/stats/SegBar.svelte';
  import {
    OUTCOMES,
    RESULT_KINDS,
    REFERENCE_LABELS,
    engineColor,
    shortSeconds,
  } from '../lib/components/stats/series';
  import { api, errorText } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { mediaDrawer } from '../lib/ui.svelte';
  import { href } from '../lib/router.svelte';
  import { basename, dateOnly, dateTime, duration, num, relative } from '../lib/format';
  import type { BreakdownRow, ClassCounts, DeepStats } from '../lib/types';

  const WINDOWS = [
    { days: 7, label: '7 days' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 365, label: '1 year' },
    { days: 0, label: 'All' },
  ];

  function stored<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  }
  function store(key: string, v: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  }

  let days = $state(stored('stats.days', 30));
  let includeDry = $state(stored('stats.dry', false));
  let data = $state<DeepStats | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);
  let pairIndex = $state(0);
  let dim = $state<keyof DeepStats['breakdowns']>('language');
  let showAllRuns = $state(false);
  let showAllWorst = $state(false);

  async function load() {
    loading = true;
    try {
      data = await api.deepStats({ days, includeDry });
      error = null;
      if (pairIndex >= (data.agreement.pairs.length || 1)) pairIndex = 0;
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }

  function setDays(d: number) {
    days = d;
    store('stats.days', d);
    void load();
  }

  onMount(() => {
    void load();
  });

  let lastTick = live.runFinishedTick;
  $effect(() => {
    const tick = live.runFinishedTick;
    if (tick !== lastTick) {
      lastTick = tick;
      void load();
    }
  });

  const t = $derived(data?.totals);
  const pair = $derived(data?.agreement.pairs[pairIndex] ?? null);
  const windowLabel = $derived(WINDOWS.find((w) => w.days === days)?.label ?? `${days} days`);

  const DIMS: { key: keyof DeepStats['breakdowns']; label: string; col: string }[] = [
    { key: 'language', label: 'Language', col: 'Language' },
    { key: 'forced', label: 'Forced', col: 'Type' },
    { key: 'kind', label: 'Movie / episode', col: 'Kind' },
    { key: 'reference', label: 'Reference', col: 'Synced against' },
    { key: 'mode', label: 'Sync mode', col: 'Mode' },
    { key: 'library', label: 'Library', col: 'Scan path' },
    { key: 'titles', label: 'Problem titles', col: 'Show or movie' },
  ];
  const dimInfo = $derived(DIMS.find((d) => d.key === dim) ?? DIMS[0]);

  function keyLabel(k: string): string {
    if (dim === 'reference') return REFERENCE_LABELS[k] ?? k;
    if (dim === 'kind') return k === 'episode' ? 'Episodes' : k === 'movie' ? 'Movies' : k;
    if (dim === 'forced') return k === 'forced' ? 'Forced' : 'Regular';
    if (dim === 'mode') return { full: 'Full pipeline', anchor: 'Anchor', follower: 'Follower (via anchor)', none: '—' }[k] ?? k;
    return k;
  }

  function segsOf(c: ClassCounts) {
    return OUTCOMES.map((o) => ({ key: o.key, label: o.label, count: c[o.key], color: o.color }));
  }

  function keepRate(c: ClassCounts): string {
    const base = c.total - c.noVideo;
    return base > 0 ? `${Math.round((c.synced / base) * 100)}%` : '—';
  }

  function share(part: number, total: number): string {
    return total > 0 ? `${Math.round((part / total) * 100)}%` : '—';
  }

  const CATEGORY_LABELS: Record<string, string> = {
    synced: 'Synced, engines agree',
    synced_single_engine: 'Synced, one engine only',
    already_in_sync: 'Already in sync, left unchanged',
    not_fitting_disagree: 'Not fitting: engines disagree',
    not_fitting_shift: 'Not fitting: shift too large',
    not_fitting_unconfirmed: 'Not fitting: one engine only (no strike)',
    forced_kept: 'Forced, not fitting, kept',
    forced_parked: 'Forced, parked',
    deleted: 'Deleted at the strike threshold',
    failed_timeout: 'Failed: timeout',
    failed_error: 'Failed: engine error',
    failed_engines_skipped: 'Failed: all engines skipped',
    no_video: 'No matching video',
  };
  const CATEGORY_COLORS: Record<string, string> = {
    synced: 'var(--ok)',
    synced_single_engine: 'color-mix(in srgb, var(--ok) 55%, var(--surface))',
    already_in_sync: 'color-mix(in srgb, var(--ok) 35%, var(--surface))',
    not_fitting_disagree: 'var(--warn)',
    not_fitting_shift: 'color-mix(in srgb, var(--warn) 60%, var(--surface))',
    not_fitting_unconfirmed: 'color-mix(in srgb, var(--warn) 45%, var(--surface))',
    forced_kept: 'color-mix(in srgb, var(--warn) 35%, var(--surface))',
    forced_parked: 'var(--info)',
    deleted: 'var(--err)',
    failed_timeout: 'var(--accent)',
    failed_error: 'color-mix(in srgb, var(--accent) 60%, var(--surface))',
    failed_engines_skipped: 'color-mix(in srgb, var(--accent) 35%, var(--surface))',
    no_video: 'var(--text-3)',
  };
  const categoryRows = $derived(
    t
      ? Object.keys(CATEGORY_LABELS)
          .filter((k) => (t.categories[k] ?? 0) > 0)
          .map((k) => ({ label: CATEGORY_LABELS[k], count: t.categories[k], color: CATEGORY_COLORS[k] }))
      : [],
  );

  const qualityRows = $derived(
    data
      ? data.quality.histogram.map((b) => ({
          label: b.label,
          count: b.count,
          color: b.lo >= data!.quality.goodFrom ? 'var(--ok)' : b.lo >= data!.quality.weakBelow ? 'var(--warn)' : 'var(--err)',
        }))
      : [],
  );

  const timelineBuckets = $derived(
    data ? data.timeline.map((b) => ({ ...b }) as unknown as { t: number; [k: string]: number | null }) : [],
  );
  const disagreementBuckets = $derived(
    data ? data.timeline.filter((b) => b.medianDisagreementMs !== null) : [],
  );
  const disagreementMax = $derived(Math.max(1, ...disagreementBuckets.map((b) => b.medianDisagreementMs ?? 0)));

  const runs = $derived(data ? (showAllRuns ? data.runs : data.runs.slice(0, 12)) : []);
  const worst = $derived(pair ? (showAllWorst ? pair.worst : pair.worst.slice(0, 8)) : []);

  function refRate(e: DeepStats['engines'][number], ref: string): { ok: number; total: number } {
    const r = e.byReference[ref] ?? {};
    const total = Object.entries(r)
      .filter(([k]) => k !== 'skipped')
      .reduce((a, [, v]) => a + (v ?? 0), 0);
    return { ok: r.ok ?? 0, total };
  }
</script>

<div class="page viz">
  <header class="page-head">
    <div>
      <h1>Statistics</h1>
      <p class="sub">How well syncing works across your library, and where it doesn't</p>
    </div>
    <div class="row controls">
      <div class="segmented" role="group" aria-label="Time window">
        {#each WINDOWS as w (w.days)}
          <button type="button" aria-pressed={days === w.days} onclick={() => setDays(w.days)}>{w.label}</button>
        {/each}
      </div>
      <label class="check small">
        <input
          type="checkbox"
          bind:checked={includeDry}
          onchange={() => {
            store('stats.dry', includeDry);
            void load();
          }}
        />
        <span>Include dry runs</span>
      </label>
      <button class="icon-btn" aria-label="Refresh" title="Refresh" onclick={load} disabled={loading}>
        <Icon name="refresh" size={16} />
      </button>
    </div>
  </header>

  {#if error && !data}
    <div class="banner err" role="alert">
      <Icon name="alert" />
      <div>
        <strong>Could not load statistics</strong>
        <p>{error}</p>
      </div>
      <span class="spacer"></span>
      <button class="btn sm" onclick={load}>Retry</button>
    </div>
  {/if}

  {#if !data}
    {#if !error}
      <section class="grid stats">
        {#each [1, 2, 3, 4] as i (i)}
          <div class="card stat"><span class="skeleton" style="width: 60%"></span><span class="skeleton" style="height: 28px; width: 40%"></span></div>
        {/each}
      </section>
    {/if}
  {:else if t && t.decisions === 0}
    <div class="card empty-card">
      <Icon name="chart" size={28} />
      <h2>No sync decisions in the last {windowLabel.toLowerCase()}</h2>
      <p class="muted">
        Statistics are recorded for every subtitle a run decides on. Start a run, or pick a longer window.
        {#if data.window.firstRecord}The earliest record is from {dateOnly(data.window.firstRecord)}.{/if}
      </p>
    </div>
  {:else if t}
    <section class="grid stats kpis" aria-label="Totals">
      <div class="card stat">
        <span class="label">Decisions</span>
        <span class="value">{num(t.decisions)}</span>
        <span class="hint">{num(t.files)} distinct subtitles</span>
      </div>
      <div class="card stat">
        <span class="label"><span class="dot ok"></span> Keep rate</span>
        <span class="value">{t.keepRate !== null ? `${t.keepRate}%` : '—'}</span>
        <span class="hint">{num(t.synced)} synced, not counting missing videos</span>
      </div>
      <div class="card stat">
        <span class="label">Avg confidence</span>
        <span class="value">{t.avgQuality ?? '—'}</span>
        <span class="hint">of synced subtitles, 0–100</span>
      </div>
      <div class="card stat">
        <span class="label"><span class="dot warn"></span> Not fitting</span>
        <span class="value">{num(t.notFitting + t.parked + t.deleted)}</span>
        <span class="hint">{num(t.deleted)} deleted · {num(t.parked)} parked</span>
      </div>
      <div class="card stat">
        <span class="label"><span class="dot err"></span> Failed</span>
        <span class="value">{num(t.failed)}</span>
        <span class="hint">crash, timeout or skipped, no strike</span>
      </div>
      <div class="card stat">
        <span class="label">Throughput</span>
        <span class="value">{data.throughput.filesPerHour !== null ? num(Math.round(data.throughput.filesPerHour)) : '—'}</span>
        <span class="hint">subtitles per hour of run time</span>
      </div>
    </section>

    <section class="card" aria-labelledby="trend-h">
      <div class="card-head">
        <h2 id="trend-h">Outcomes over time</h2>
        <span class="subtle small">per {data.window.bucketMs > 86_400_000 ? 'week' : 'day'} · last {windowLabel.toLowerCase()}</span>
      </div>
      <StackedTimeline
        buckets={timelineBuckets}
        series={OUTCOMES}
        bucketMs={data.window.bucketMs}
        label="Subtitle outcomes per {data.window.bucketMs > 86_400_000 ? 'week' : 'day'}"
      />
    </section>

    <div class="grid two">
      <section class="card" aria-labelledby="cat-h">
        <div class="card-head">
          <h2 id="cat-h">Why</h2>
          <span class="subtle small">every outcome by its reason</span>
        </div>
        <HBars rows={categoryRows} total={t.decisions} />
      </section>

      <section class="card" aria-labelledby="dis-h">
        <div class="card-head">
          <h2 id="dis-h">Engine disagreement over time</h2>
          <span class="subtle small">median gap between the two engines' shifts</span>
        </div>
        {#if disagreementBuckets.length === 0}
          <p class="muted small">No subtitle got a shift from both engines in this window.</p>
        {:else}
          <ul class="spark" aria-label="Median disagreement per period">
            {#each disagreementBuckets as b (b.t)}
              {@const v = b.medianDisagreementMs ?? 0}
              <li title="{dateOnly(b.t)}: median {shortSeconds(v, false)}">
                <span
                  class="spark-bar"
                  class:over={v > data.agreement.thresholdMs}
                  style:height="{Math.max(2, (v / disagreementMax) * 100)}%"
                ></span>
              </li>
            {/each}
          </ul>
          <div class="spark-axis small subtle">
            <span>{dateOnly(disagreementBuckets[0].t)}</span>
            <span>peak {shortSeconds(disagreementMax, false)} · threshold {shortSeconds(data.agreement.thresholdMs, false)}</span>
            <span>{dateOnly(disagreementBuckets[disagreementBuckets.length - 1].t)}</span>
          </div>
        {/if}
      </section>
    </div>

    <section class="card" aria-labelledby="agree-h">
      <div class="card-head">
        <h2 id="agree-h">Engine agreement</h2>
        {#if data.agreement.pairs.length > 1}
          <div class="segmented" role="group" aria-label="Engine pair">
            {#each data.agreement.pairs as p, i (p.engines.join('+'))}
              <button type="button" aria-pressed={pairIndex === i} onclick={() => (pairIndex = i)}>
                {p.engines[0]} vs {p.engines[1]}
              </button>
            {/each}
          </div>
        {:else}
          <span class="subtle small">subtitles where both engines proposed a shift</span>
        {/if}
      </div>
      {#if !pair}
        <p class="muted small">No subtitle got a shift from both engines in this window.</p>
      {:else}
        <div class="agree">
          <div>
            <AgreementScatter points={pair.scatter} engines={pair.engines} thresholdMs={data.agreement.thresholdMs} />
            {#if pair.scatter.length < pair.pairs}
              <p class="subtle small">Showing {num(pair.scatter.length)} of {num(pair.pairs)} subtitles, evenly sampled.</p>
            {/if}
          </div>
          <div class="agree-side">
            <dl class="kv">
              <div>
                <dt>Compared</dt>
                <dd>{num(pair.pairs)}</dd>
              </div>
              <div>
                <dt>Within {shortSeconds(data.agreement.thresholdMs, false)}</dt>
                <dd>{share(pair.withinThreshold, pair.pairs)}</dd>
              </div>
              <div>
                <dt>Median gap</dt>
                <dd>{shortSeconds(pair.absDiffMs.p50, false)}</dd>
              </div>
              <div>
                <dt>90th percentile gap</dt>
                <dd>{shortSeconds(pair.absDiffMs.p90, false)}</dd>
              </div>
              <div title="Median of {pair.engines[0]} minus {pair.engines[1]}. Far from zero means one engine is systematically ahead.">
                <dt>Bias ({pair.engines[0]} − {pair.engines[1]})</dt>
                <dd>{shortSeconds(pair.biasMs)}</dd>
              </div>
              <div title="Moves the subtitle by 2 s or more while the other engine moves it by less than 0.5 s">
                <dt>Only {pair.engines[0]} moves it</dt>
                <dd>{num(pair.onlyFirstMoves)}</dd>
              </div>
              <div title="Moves the subtitle by 2 s or more while the other engine moves it by less than 0.5 s">
                <dt>Only {pair.engines[1]} moves it</dt>
                <dd>{num(pair.onlySecondMoves)}</dd>
              </div>
            </dl>
            <h3 class="section-title">Gap between the engines</h3>
            <HBars
              rows={pair.histogram.map((h) => ({
                label: h.label,
                count: h.count,
                color: h.hi !== null && h.hi <= data!.agreement.thresholdMs ? 'var(--ok)' : 'var(--warn)',
              }))}
              total={pair.pairs}
            />
          </div>
        </div>

        {#if pair.worst.length}
          <h3 class="section-title">Largest disagreements</h3>
          <div class="table-wrap">
            <table class="table compact">
              <thead>
                <tr>
                  <th>Subtitle</th>
                  <th class="r">{pair.engines[0]}</th>
                  <th class="r">{pair.engines[1]}</th>
                  <th class="r">Gap</th>
                  <th>Outcome</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {#each worst as w (w.filePath)}
                  <tr class="clickable" onclick={() => mediaDrawer.open(w.filePath)}>
                    <td class="path" title={w.filePath}>{basename(w.filePath)}</td>
                    <td class="r">{shortSeconds(w.a)}</td>
                    <td class="r">{shortSeconds(w.b)}</td>
                    <td class="r"><strong>{shortSeconds(Math.abs(w.a - w.b), false)}</strong></td>
                    <td>{CATEGORY_LABELS[w.category] ?? w.category}</td>
                    <td class="subtle" title={dateTime(w.ts)}>{relative(w.ts)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if pair.worst.length > 8}
            <button class="btn sm ghost more" onclick={() => (showAllWorst = !showAllWorst)}>
              {showAllWorst ? 'Show fewer' : `Show all ${pair.worst.length}`}
            </button>
          {/if}
        {/if}
      {/if}
    </section>

    <section aria-labelledby="eng-h">
      <h2 id="eng-h" class="block-title">Engines</h2>
      {#if data.engines.length === 0}
        <p class="muted small">No engine runs in this window.</p>
      {/if}
      <div class="grid two">
        {#each data.engines as e (e.engine)}
          <article class="card">
            <div class="card-head">
              <h3><i class="eng-sw" style:background={engineColor(e.engine)}></i>{e.engine}</h3>
              <span class="subtle small">{num(e.runs)} runs · {duration(e.totalMs)} total</span>
            </div>
            <SegBar
              height={12}
              segs={RESULT_KINDS.map((k) => ({ key: k.key, label: k.label, count: e.results[k.key] ?? 0, color: k.color }))}
            />
            <ul class="legend-row small">
              {#each RESULT_KINDS as k (k.key)}
                {#if (e.results[k.key] ?? 0) > 0}
                  <li><i class="sw" style:background={k.color}></i>{k.label} {num(e.results[k.key] ?? 0)} <span class="subtle">({share(e.results[k.key] ?? 0, e.runs)})</span></li>
                {/if}
              {/each}
            </ul>
            <dl class="kv four">
              <div><dt>Median time</dt><dd>{shortSeconds(e.durationMs.p50, false)}</dd></div>
              <div><dt>90th pct</dt><dd>{shortSeconds(e.durationMs.p90, false)}</dd></div>
              <div><dt>99th pct</dt><dd>{shortSeconds(e.durationMs.p99, false)}</dd></div>
              <div><dt>Slowest</dt><dd>{shortSeconds(e.durationMs.max, false)}</dd></div>
              <div><dt>Median shift</dt><dd>{shortSeconds(e.shiftMs.p50)}</dd></div>
              <div><dt>Typical |shift|</dt><dd>{shortSeconds(e.absShiftMs.p50, false)}</dd></div>
              <div><dt>90th pct |shift|</dt><dd>{shortSeconds(e.absShiftMs.p90, false)}</dd></div>
              <div title="ffsubsync stretched the timeline to fix a framerate mismatch"><dt>Framerate fixes</dt><dd>{num(e.framerateScaled)}</dd></div>
            </dl>
            <h4 class="section-title">Proposed shifts</h4>
            <HBars
              rows={e.shiftHistogram.map((h) => ({ label: h.label, count: h.count, color: engineColor(e.engine) }))}
            />
            {#if Object.keys(e.byReference).length > 0}
              <h4 class="section-title">Aligned, by reference</h4>
              <ul class="ref-list small">
                {#each Object.keys(e.byReference) as ref (ref)}
                  {@const r = refRate(e, ref)}
                  {#if r.total > 0}
                    <li>
                      <span>{REFERENCE_LABELS[ref] ?? ref}</span>
                      <span class="tnum">{share(r.ok, r.total)} <span class="subtle">of {num(r.total)}</span></span>
                    </li>
                  {/if}
                {/each}
              </ul>
            {/if}
          </article>
        {/each}
      </div>
    </section>

    <section class="card flush" aria-labelledby="bd-h">
      <div class="card-head">
        <h2 id="bd-h">Breakdown</h2>
        <div class="segmented" role="group" aria-label="Group by">
          {#each DIMS as d (d.key)}
            <button type="button" aria-pressed={dim === d.key} onclick={() => (dim = d.key)}>{d.label}</button>
          {/each}
        </div>
      </div>
      {#if dim === 'titles'}
        <p class="subtle small pad">Shows and movies with the most subtitles that didn't sync.</p>
      {/if}
      {#if data.breakdowns[dim].length === 0}
        <p class="muted small pad">Nothing to show.</p>
      {:else}
        <div class="table-wrap">
          <table class="table compact">
            <thead>
              <tr>
                <th>{dimInfo.col}</th>
                <th class="r">Decisions</th>
                <th class="bar-col">Outcomes</th>
                <th class="r">Kept</th>
                <th class="r"><abbr title="Not fitting (strike)">NF</abbr></th>
                <th class="r">Deleted</th>
                <th class="r">Failed</th>
                <th class="r"><abbr title="Average confidence of kept syncs">Conf.</abbr></th>
              </tr>
            </thead>
            <tbody>
              {#each data.breakdowns[dim] as row (row.key)}
                {@const r = row as BreakdownRow}
                <tr>
                  <td class="path" title={r.key}>{keyLabel(r.key)}</td>
                  <td class="r">{num(r.total)}</td>
                  <td class="bar-col"><SegBar segs={segsOf(r)} /></td>
                  <td class="r">{keepRate(r)}</td>
                  <td class="r">{num(r.notFitting + r.parked)}</td>
                  <td class="r">{num(r.deleted)}</td>
                  <td class="r">{num(r.failed)}</td>
                  <td class="r">{r.avgQuality ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <div class="grid two">
      <section class="card" aria-labelledby="q-h">
        <div class="card-head">
          <h2 id="q-h">Confidence of synced subtitles</h2>
          <span class="subtle small">now, across the library</span>
        </div>
        <HBars rows={qualityRows} />
        <dl class="kv four">
          <div><dt>Average</dt><dd>{data.quality.average ?? '—'}</dd></div>
          <div><dt>Good</dt><dd>{num(data.quality.levels.good)}</dd></div>
          <div><dt>Weak</dt><dd>{num(data.quality.levels.weak)}</dd></div>
          <div>
            <dt>To review</dt>
            <dd><a href={href('library')}>{num(data.quality.needsReview)}</a></dd>
          </div>
        </dl>
        {#if data.quality.unscored > 0}
          <p class="subtle small">{num(data.quality.unscored)} subtitles only have a manual offset and no score.</p>
        {/if}
      </section>

      <section class="card" aria-labelledby="s-h">
        <div class="card-head">
          <h2 id="s-h">Strikes</h2>
          <span class="subtle small">now · delete at {data.strikes.threshold}</span>
        </div>
        {#if data.strikes.distribution.length === 0}
          <p class="muted small">No subtitle has a not-fitting strike.</p>
        {:else}
          <HBars
            rows={data.strikes.distribution.map((d) => ({
              label: `${d.strikes} of ${data!.strikes.threshold}`,
              count: d.count,
              color: d.strikes + 1 >= data!.strikes.threshold ? 'var(--err)' : 'var(--warn)',
              title: d.strikes + 1 >= data!.strikes.threshold ? 'One more not-fitting run deletes these (forced subs are parked)' : undefined,
            }))}
          />
        {/if}
        <dl class="kv four">
          <div><dt>Parked forced</dt><dd>{num(data.strikes.parked)}</dd></div>
          <div title="Files where an engine is skipped after 3 consecutive failures">
            <dt>Engine skipped</dt>
            <dd>{num(data.strikes.skippedEngineFiles)}</dd>
          </div>
          {#each Object.entries(data.strikes.skippedByEngine) as [eng, n] (eng)}
            <div><dt>{eng} skipped</dt><dd>{num(n)}</dd></div>
          {/each}
        </dl>
      </section>
    </div>

    <section class="card flush" aria-labelledby="runs-h">
      <div class="card-head">
        <h2 id="runs-h">Runs</h2>
        <span class="subtle small">{num(data.runs.length)} in this window</span>
      </div>
      <div class="table-wrap">
        <table class="table compact">
          <thead>
            <tr>
              <th>Started</th>
              <th class="r">Decided</th>
              <th class="bar-col">Outcomes</th>
              <th class="r">Kept</th>
              <th class="r"><abbr title="Average confidence of kept syncs">Conf.</abbr></th>
              <th class="r">Duration</th>
              <th class="r"><abbr title="Subtitles decided per hour">Per hour</abbr></th>
              <th class="r"><abbr title="Time spent in the engines, summed over parallel tasks">Engine time</abbr></th>
            </tr>
          </thead>
          <tbody>
            {#each runs as r (r.runId)}
              <tr>
                <td>
                  {#if r.status}
                    <a href={href('run-detail', r.runId)}>{dateTime(r.start)}</a>
                  {:else}
                    <span title="Run no longer in history">{dateTime(r.start)}</span>
                  {/if}
                  {#if r.dryRun}<span class="chip warn">dry</span>{/if}
                  {#if r.manual}<span class="chip info">manual</span>{/if}
                </td>
                <td class="r">{num(r.decisions)}</td>
                <td class="bar-col">
                  <SegBar segs={segsOf({ ...r, total: r.decisions, avgQuality: r.avgQuality })} />
                </td>
                <td class="r">{keepRate({ ...r, total: r.decisions })}</td>
                <td class="r">{r.avgQuality ?? '—'}</td>
                <td class="r">{duration(r.durationMs)}</td>
                <td class="r">{r.filesPerHour !== null ? num(Math.round(r.filesPerHour)) : '—'}</td>
                <td class="r">{duration(r.engineMs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if data.runs.length > 12}
        <button class="btn sm ghost more pad" onclick={() => (showAllRuns = !showAllRuns)}>
          {showAllRuns ? 'Show fewer' : `Show all ${data.runs.length}`}
        </button>
      {/if}
    </section>

    <section class="card" aria-labelledby="o-h">
      <div class="card-head">
        <h2 id="o-h">Subtitles without a video</h2>
        <span class="subtle small">
          {num(data.orphans.count)}{data.orphans.truncated ? '+' : ''} still on disk · all time
        </span>
      </div>
      {#if data.orphans.count === 0}
        <p class="muted small">Every subtitle found a matching video.</p>
      {:else}
        <ul class="orphans">
          {#each data.orphans.items as o (o.filePath)}
            <li>
              <button class="link" onclick={() => mediaDrawer.open(o.filePath)} title={o.filePath}>
                <span class="o-name">{basename(o.filePath)}</span>
                <span class="o-dir subtle">{o.filePath.slice(0, o.filePath.length - basename(o.filePath).length)}</span>
              </button>
              <span class="subtle small" title={dateTime(o.lastSeen)}>{relative(o.lastSeen)}</span>
            </li>
          {/each}
        </ul>
        {#if data.orphans.count > data.orphans.items.length}
          <p class="subtle small">Showing the {data.orphans.items.length} most recent.</p>
        {/if}
      {/if}
    </section>

    <p class="subtle small foot">
      Recorded for every subtitle a run decided on{data.window.firstRecord
        ? `, since ${dateOnly(data.window.firstRecord)}`
        : ''}. Kept for <code>RETENTION_KEEP_STATS_DAYS</code> (default 365). Confidence, strikes and orphans reflect the
      library now.
    </p>
  {/if}
</div>

<style>
  .viz {
    --series-1: #2a78d6;
    --series-2: #eb6834;
    --series-3: #1baf7a;
  }
  :global(:root[data-theme='dark']) .viz {
    --series-1: #3987e5;
    --series-2: #d95926;
    --series-3: #199e70;
  }

  .kpis {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }

  .controls {
    gap: 12px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .spacer {
    flex: 1;
  }

  .empty-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 8px;
    padding: 40px 20px;
    color: var(--text-2);
  }

  .block-title {
    font-size: 15px;
    margin: 6px 0 10px;
  }

  .section-title {
    margin: 16px 0 8px;
  }

  .agree {
    display: grid;
    grid-template-columns: minmax(0, 420px) minmax(0, 1fr);
    gap: 24px;
    align-items: start;
  }

  .agree-side {
    min-width: 0;
  }

  .kv {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 10px 16px;
    margin: 0;
  }

  .kv.four {
    margin-top: 14px;
  }

  .kv div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .kv dt {
    font-size: 11.5px;
    color: var(--text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .kv dd {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .spark {
    list-style: none;
    margin: 0;
    padding: 0;
    height: 120px;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    border-bottom: 1px solid var(--border);
  }

  .spark li {
    flex: 1;
    height: 100%;
    display: flex;
    align-items: flex-end;
    min-width: 2px;
  }

  .spark-bar {
    width: 100%;
    background: var(--series-1);
    border-radius: 3px 3px 0 0;
  }

  .spark-bar.over {
    background: var(--warn);
  }

  .spark-axis {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 6px;
  }

  .eng-sw,
  .sw {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 3px;
    margin-right: 6px;
  }

  .legend-row {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    color: var(--text-2);
  }

  .legend-row li {
    display: inline-flex;
    align-items: center;
  }

  .ref-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .ref-list li {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }

  .table.compact td,
  .table.compact th {
    padding: 8px 12px;
  }

  .path {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bar-col {
    width: 22%;
    min-width: 110px;
  }

  .pad {
    padding: 0 18px 14px;
    margin: 0;
  }

  .more {
    margin: 8px 0 0;
  }

  .card.flush .more {
    margin: 8px 18px 14px;
  }

  .orphans {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .orphans li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
  }

  .orphans li:last-child {
    border-bottom: none;
  }

  .link {
    appearance: none;
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .link:hover .o-name {
    color: var(--accent-text);
    text-decoration: underline;
  }

  .o-name,
  .o-dir {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .o-dir {
    font-size: 11.5px;
    font-family: var(--mono);
  }

  .foot {
    margin: 4px 2px 0;
  }

  @media (max-width: 860px) {
    .agree {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
