<script lang="ts">
  import { num } from '../../format';

  interface Seg {
    key: string;
    label: string;
    count: number;
    color: string;
  }

  let { segs, height = 10 }: { segs: Seg[]; height?: number } = $props();
  const total = $derived(segs.reduce((a, s) => a + s.count, 0));
</script>

<div class="seg" style:height="{height}px" role="img" aria-label={segs.map((s) => `${s.label} ${s.count}`).join(', ')}>
  {#each segs as s (s.key)}
    {#if s.count > 0}
      <span
        style:flex-grow={s.count}
        style:background={s.color}
        title="{s.label}: {num(s.count)} ({Math.round((s.count / Math.max(1, total)) * 100)}%)"
      ></span>
    {/if}
  {/each}
</div>

<style>
  .seg {
    display: flex;
    gap: 2px;
    width: 100%;
    min-width: 60px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
  }
  span {
    flex-basis: 0;
    min-width: 2px;
  }
</style>
