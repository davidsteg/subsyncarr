<script lang="ts">
  import { num } from '../../format';
  import type { Series } from './series';

  interface Bucket {
    t: number;
    [key: string]: number | null;
  }

  let {
    buckets,
    series,
    bucketMs,
    label,
  }: { buckets: Bucket[]; series: Series[]; bucketMs: number; label: string } = $props();

  let width = $state(0);
  let hover = $state<number | null>(null);
  const H = 180;
  const PAD_L = 40;
  const PAD_B = 22;
  const PAD_T = 8;

  const totals = $derived(buckets.map((b) => series.reduce((a, s) => a + ((b[s.key] as number) ?? 0), 0)));
  const max = $derived(niceMax(Math.max(1, ...totals)));
  const plotW = $derived(Math.max(10, width - PAD_L - 4));
  const slot = $derived(buckets.length ? plotW / buckets.length : plotW);
  const barW = $derived(Math.max(2, Math.min(28, slot - 2)));
  const ticks = $derived([0, max / 2, max]);
  const labelEvery = $derived(Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 70)))));

  function niceMax(v: number): number {
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function y(v: number): number {
    return PAD_T + (H - PAD_T - PAD_B) * (1 - v / max);
  }

  function dateLabel(t: number): string {
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function rangeLabel(t: number): string {
    if (bucketMs <= 86_400_000) return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return `${dateLabel(t)} – ${dateLabel(t + bucketMs - 86_400_000)}`;
  }

  const active = $derived(hover !== null ? buckets[hover] : null);
</script>

<div class="chart" bind:clientWidth={width}>
  {#if width > 0}
    <svg {width} height={H} role="img" aria-label={label} onpointerleave={() => (hover = null)}>
      {#each ticks as t (t)}
        <line class="grid" x1={PAD_L} x2={width} y1={y(t)} y2={y(t)} />
        <text class="axis" x={PAD_L - 6} y={y(t) + 3.5} text-anchor="end">{num(Math.round(t))}</text>
      {/each}
      {#each buckets as b, i (b.t)}
        {@const x = PAD_L + i * slot + (slot - barW) / 2}
        <g class:dim={hover !== null && hover !== i}>
          {#each series as s, si (s.key)}
            {@const below = series.slice(0, si).reduce((a, p) => a + ((b[p.key] as number) ?? 0), 0)}
            {@const v = (b[s.key] as number) ?? 0}
            {#if v > 0}
              <rect
                x={x}
                y={y(below + v) + 1}
                width={barW}
                height={Math.max(1, y(below) - y(below + v) - 1)}
                rx={Math.min(3, barW / 3)}
                fill={s.color}
              />
            {/if}
          {/each}
        </g>
        {#if i % labelEvery === 0}
          <text class="axis" x={PAD_L + i * slot + slot / 2} y={H - 6} text-anchor="middle">{dateLabel(b.t)}</text>
        {/if}
        <rect
          class="hit"
          x={PAD_L + i * slot}
          y={0}
          width={slot}
          height={H - PAD_B}
          role="presentation"
          onpointerenter={() => (hover = i)}
        />
      {/each}
    </svg>
  {/if}
  <div class="readout small" aria-live="polite">
    {#if active}
      <strong>{rangeLabel(active.t)}</strong>
      {#each series as s (s.key)}
        {#if (active[s.key] as number) > 0}
          <span><i class="sw" style:background={s.color}></i>{s.label} {num(active[s.key] as number)}</span>
        {/if}
      {/each}
    {:else}
      {#each series as s (s.key)}
        <span title={s.hint}><i class="sw" style:background={s.color}></i>{s.label}</span>
      {/each}
    {/if}
  </div>
</div>

<style>
  .chart {
    width: 100%;
    min-width: 0;
  }
  svg {
    display: block;
    font-family: var(--sans);
  }
  .grid {
    stroke: var(--border);
    stroke-width: 1;
  }
  .axis {
    font-size: 10.5px;
    fill: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .hit {
    fill: transparent;
  }
  .dim {
    opacity: 0.45;
  }
  .readout {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    min-height: 20px;
    margin-top: 6px;
    color: var(--text-2);
  }
  .readout span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
  }
  .sw {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    display: inline-block;
  }
</style>
