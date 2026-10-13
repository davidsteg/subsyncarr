<script lang="ts">
  import { dateOnly, signedSeconds } from '../format';
  import type { SyncHistoryEntry } from '../types';

  let { history }: { history: SyncHistoryEntry[] } = $props();

  interface Point {
    key: string;
    engine: string;
    date: string;
    when: number;
    offset: number;
  }

  const points = $derived.by<Point[]>(() => {
    const out: Point[] = [];
    for (const h of history) {
      for (const [engine, r] of Object.entries(h.engines ?? {})) {
        if (typeof r.offsetMs === 'number' && Number.isFinite(r.offsetMs)) {
          out.push({
            key: `${h.runId}:${engine}`,
            engine,
            date: dateOnly(h.runStartTime),
            when: h.runStartTime,
            offset: r.offsetMs,
          });
        }
      }
    }
    return out;
  });

  let width = $state(0);
  const ROW = 26;
  const TOP = 18;
  const LABEL_W = $derived(width < 420 ? 90 : 160);
  const VALUE_W = 62;
  const trackX = $derived(LABEL_W);
  const trackW = $derived(Math.max(60, width - LABEL_W - VALUE_W));
  const mid = $derived(trackX + trackW / 2);
  const maxAbs = $derived(Math.max(1000, ...points.map((p) => Math.abs(p.offset))));
  const height = $derived(TOP + points.length * ROW + 4);

  function x(ms: number): number {
    return mid + (ms / maxAbs) * (trackW / 2 - 2);
  }

  function tone(ms: number): 'ok' | 'warn' | 'err' {
    const a = Math.abs(ms);
    return a <= 5000 ? 'ok' : a <= 30000 ? 'warn' : 'err';
  }

  const guides = $derived([5000, 30000].filter((g) => g < maxAbs));
</script>

{#if points.length === 0}
  <p class="muted small">No offset data recorded for this file yet.</p>
{:else}
  <div class="chart" bind:clientWidth={width}>
    {#if width > 0}
      <svg {width} {height} role="img" aria-label="Subtitle offset per engine per run">
        <!-- axis labels -->
        <text class="axis" x={trackX} y="11" text-anchor="start">−{(maxAbs / 1000).toFixed(1)}s</text>
        <text class="axis" x={mid} y="11" text-anchor="middle">0</text>
        <text class="axis" x={trackX + trackW} y="11" text-anchor="end">+{(maxAbs / 1000).toFixed(1)}s</text>

        {#each guides as g (g)}
          <line class="guide" x1={x(g)} x2={x(g)} y1={TOP - 2} y2={height - 2} />
          <line class="guide" x1={x(-g)} x2={x(-g)} y1={TOP - 2} y2={height - 2} />
        {/each}
        <line class="zero" x1={mid} x2={mid} y1={TOP - 4} y2={height} />

        {#each points as p, i (p.key)}
          {@const y = TOP + i * ROW}
          {@const x0 = Math.min(mid, x(p.offset))}
          {@const w = Math.max(2, Math.abs(x(p.offset) - mid))}
          <g class="bar-row {tone(p.offset)}">
            <title>{p.engine} · {new Date(p.when).toLocaleString()} · offset {signedSeconds(p.offset)}</title>
            <rect class="hit" x="0" y={y} width={width} height={ROW} />
            <text class="label" x="0" y={y + ROW / 2 + 4}>
              <tspan class="eng-name">{p.engine}</tspan>
              {#if width >= 420}<tspan class="date" dx="6">{p.date}</tspan>{/if}
            </text>
            <rect class="bar" x={x0} y={y + 7} width={w} height={ROW - 14} rx="3" />
            <text class="value" x={width} y={y + ROW / 2 + 4} text-anchor="end">{signedSeconds(p.offset)}</text>
          </g>
        {/each}
      </svg>
    {/if}
  </div>
  <div class="legend small">
    <span><i class="sw ok"></i> ≤ 5s</span>
    <span><i class="sw warn"></i> ≤ 30s</span>
    <span><i class="sw err"></i> &gt; 30s</span>
    <span class="subtle">Bars left of zero = subtitles moved earlier</span>
  </div>
{/if}

<style>
  .chart {
    width: 100%;
    min-width: 0;
  }

  svg {
    display: block;
    overflow: visible;
    font-family: var(--sans);
  }

  .axis {
    font-size: 10.5px;
    fill: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .zero {
    stroke: var(--border-strong);
    stroke-width: 1;
  }

  .guide {
    stroke: var(--border);
    stroke-dasharray: 3 3;
  }

  .hit {
    fill: transparent;
  }

  .bar-row:hover .hit {
    fill: var(--surface-2);
  }

  .label {
    font-size: 12px;
    fill: var(--text);
  }

  .date {
    fill: var(--text-3);
    font-size: 11px;
  }

  .value {
    font-size: 12px;
    fill: var(--text-2);
    font-variant-numeric: tabular-nums;
  }

  .ok .bar {
    fill: var(--ok);
  }
  .warn .bar {
    fill: var(--warn);
  }
  .err .bar {
    fill: var(--err);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 10px;
    color: var(--text-2);
    align-items: center;
  }

  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .sw {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    display: inline-block;
  }
  .sw.ok {
    background: var(--ok);
  }
  .sw.warn {
    background: var(--warn);
  }
  .sw.err {
    background: var(--err);
  }
</style>
