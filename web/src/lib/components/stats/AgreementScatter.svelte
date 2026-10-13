<script lang="ts">
  import { shortSeconds } from './series';

  let {
    points,
    engines,
    thresholdMs,
  }: { points: [number, number, boolean][]; engines: [string, string]; thresholdMs: number } = $props();

  let width = $state(0);
  const PAD = 44;
  const size = $derived(Math.max(160, Math.min(width, 420)));
  const plot = $derived(size - PAD - 8);

  // Symmetric log scale: 0 and ±0.25 s stay apart while ±60 s still fits.
  const SOFT = 250;
  const f = (v: number) => Math.sign(v) * Math.log10(1 + Math.abs(v) / SOFT);
  const maxAbs = $derived(Math.max(thresholdMs * 1.5, 2000, ...points.map((p) => Math.max(Math.abs(p[0]), Math.abs(p[1])))));
  const fmax = $derived(f(maxAbs) * 1.04);
  const sx = (v: number) => PAD + ((f(v) + fmax) / (2 * fmax)) * plot;
  const sy = (v: number) => 8 + (1 - (f(v) + fmax) / (2 * fmax)) * plot;

  const ticks = $derived.by(() => {
    const out = [0];
    for (const t of [1000, 5000, 30_000, 120_000, 600_000, 3_600_000]) {
      if (t <= maxAbs) out.push(t, -t);
    }
    return out;
  });

  // Band where the engines agree: |a − b| ≤ threshold.
  const band = $derived.by(() => {
    const xs: number[] = [];
    const n = 60;
    for (let i = 0; i <= n; i++) {
      const u = -fmax + (2 * fmax * i) / n;
      xs.push(Math.sign(u) * (10 ** Math.abs(u) - 1) * SOFT);
    }
    const clamp = (v: number) => Math.max(-maxAbs * 1.2, Math.min(maxAbs * 1.2, v));
    const upper = xs.map((v) => `${sx(v)},${sy(clamp(v + thresholdMs))}`);
    const lower = xs.reverse().map((v) => `${sx(v)},${sy(clamp(v - thresholdMs))}`);
    return [...upper, ...lower].join(' ');
  });
</script>

<div class="chart" bind:clientWidth={width}>
  {#if width > 0}
    <svg
      width={size}
      height={size}
      role="img"
      aria-label="Shift proposed by {engines[0]} against {engines[1]} for each subtitle"
    >
      <defs>
        <clipPath id="plot-clip"><rect x={PAD} y="8" width={plot} height={plot} /></clipPath>
      </defs>
      <g clip-path="url(#plot-clip)">
        <polygon class="band" points={band} />
      </g>
      {#each ticks as t (t)}
        <line class="grid" class:zero={t === 0} x1={sx(t)} x2={sx(t)} y1="8" y2={8 + plot} />
        <line class="grid" class:zero={t === 0} x1={PAD} x2={PAD + plot} y1={sy(t)} y2={sy(t)} />
        <text class="axis" x={sx(t)} y={size - 22} text-anchor="middle">{shortSeconds(t, false).replace(' s', 's')}</text>
        <text class="axis" x={PAD - 5} y={sy(t) + 3.5} text-anchor="end">{shortSeconds(t, false).replace(' s', 's')}</text>
      {/each}
      <line class="diag" x1={sx(-maxAbs)} y1={sy(-maxAbs)} x2={sx(maxAbs)} y2={sy(maxAbs)} />
      <g clip-path="url(#plot-clip)">
        {#each points as p, i (i)}
          <circle class="pt" class:kept={p[2]} cx={sx(p[0])} cy={sy(p[1])} r="3.5">
            <title>{engines[0]} {shortSeconds(p[0])} · {engines[1]} {shortSeconds(p[1])} · {p[2] ? 'kept' : 'not kept'}</title>
          </circle>
        {/each}
      </g>
      <text class="title" x={PAD + plot / 2} y={size - 4} text-anchor="middle">{engines[0]} shift →</text>
      <text class="title" transform="translate(11 {8 + plot / 2}) rotate(-90)" text-anchor="middle">{engines[1]} shift →</text>
    </svg>
  {/if}
  <div class="legend small">
    <span><i class="dot-sw kept"></i> Kept</span>
    <span><i class="dot-sw"></i> Not kept</span>
    <span><i class="band-sw"></i> Within {shortSeconds(thresholdMs, false)} of each other</span>
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
    overflow: visible;
  }
  .grid {
    stroke: var(--border);
    stroke-width: 1;
  }
  .grid.zero {
    stroke: var(--border-strong);
  }
  .diag {
    stroke: var(--text-3);
    stroke-dasharray: 3 4;
  }
  .band {
    fill: color-mix(in srgb, var(--ok) 12%, transparent);
  }
  .axis {
    font-size: 10px;
    fill: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .title {
    font-size: 11px;
    fill: var(--text-2);
    font-weight: 550;
  }
  .pt {
    fill: var(--err);
    fill-opacity: 0.75;
    stroke: var(--surface);
    stroke-width: 1;
  }
  .pt.kept {
    fill: var(--ok);
    fill-opacity: 0.55;
  }
  .pt:hover {
    fill-opacity: 1;
    r: 5;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    color: var(--text-2);
    margin-top: 6px;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot-sw {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--err);
    display: inline-block;
  }
  .dot-sw.kept {
    background: var(--ok);
  }
  .band-sw {
    width: 14px;
    height: 9px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--ok) 20%, transparent);
    display: inline-block;
  }
</style>
