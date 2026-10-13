<script lang="ts">
  import ProgressBar from './ProgressBar.svelte';
  import { num, pct } from '../format';
  import type { ScanProgress } from '../types';

  let { progress }: { progress: ScanProgress | null } = $props();
  const value = $derived(progress ? pct(progress.checked, progress.total) : 0);
</script>

<section class="card scan" aria-label="Scan progress">
  <div class="card-head">
    <h3 class="row"><span class="dot pulse info"></span> Scanning library</h3>
    {#if progress && progress.total > 0}
      <span class="tnum muted">{value}%</span>
    {/if}
  </div>
  {#if progress && progress.total > 0}
    <ProgressBar value={value} tone="info" size="lg" label="Scan progress" />
    <div class="figures tnum">
      <span><b>{num(progress.checked)}</b> / {num(progress.total)} checked</span>
      <span><b>{num(progress.needSync)}</b> need sync</span>
      <span><b>{num(progress.alreadySynced)}</b> already synced</span>
    </div>
  {:else}
    <ProgressBar value={0} tone="info" size="lg" label="Scan progress" />
    <p class="muted small figures">Walking directories and building the file list…</p>
  {/if}
</section>

<style>
  .figures {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin-top: 10px;
    color: var(--text-2);
    font-size: 13px;
  }
  .figures b {
    color: var(--text);
    font-weight: 600;
  }
</style>
