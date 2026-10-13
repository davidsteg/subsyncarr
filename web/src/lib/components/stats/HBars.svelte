<script lang="ts">
  import { num } from '../../format';

  interface Row {
    label: string;
    count: number;
    color?: string;
    title?: string;
  }

  let { rows, max = undefined, total = undefined }: { rows: Row[]; max?: number; total?: number } = $props();
  const top = $derived(max ?? Math.max(1, ...rows.map((r) => r.count)));
</script>

<ul class="hbars">
  {#each rows as r (r.label)}
    <li title={r.title}>
      <span class="lbl">{r.label}</span>
      <span class="track">
        {#if r.count > 0}
          <span class="fill" style:width="{Math.max(1.5, (r.count / top) * 100)}%" style:background={r.color ?? 'var(--series-1)'}></span>
        {/if}
      </span>
      <span class="val tnum">
        {num(r.count)}{#if total}<span class="subtle">&nbsp;· {Math.round((r.count / Math.max(1, total)) * 100)}%</span>{/if}
      </span>
    </li>
  {/each}
</ul>

<style>
  .hbars {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  li {
    display: grid;
    grid-template-columns: minmax(70px, 34%) 1fr minmax(64px, auto);
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
  }
  .lbl {
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .track {
    height: 10px;
    border-radius: 0 4px 4px 0;
    position: relative;
  }
  .fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 0 4px 4px 0;
  }
  .val {
    text-align: right;
    white-space: nowrap;
  }
</style>
