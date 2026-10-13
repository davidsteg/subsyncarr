<script lang="ts">
  import { seconds, signedSeconds } from '../format';
  import type { EngineResult } from '../types';

  let { engines }: { engines: Record<string, EngineResult> | null | undefined } = $props();

  const entries = $derived(Object.entries(engines ?? {}));
</script>

{#if entries.length}
  <span class="badges">
    {#each entries as [name, r] (name)}
      {@const kind = r.success ? 'ok' : r.skipped ? 'skip' : 'fail'}
      <span class="eng {kind}" title={r.message || undefined}>
        <b>{r.success ? 'OK' : r.skipped ? 'SKIP' : 'FAIL'}</b>
        {name}
        {#if r.duration}<span class="subtle">{seconds(r.duration)}</span>{/if}
        {#if r.offsetMs !== undefined && r.offsetMs !== null}<span class="subtle">Δ {signedSeconds(r.offsetMs)}</span>{/if}
        {#if r.shiftTooLarge}<span class="subtle">shift too large</span>{/if}
      </span>
    {/each}
  </span>
{/if}

<style>
  .badges {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
  }
</style>
