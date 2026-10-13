<script lang="ts">
  import type { RunStatus } from '../types';

  let { status, scanning = false, size }: { status: RunStatus; scanning?: boolean; size?: 'lg' } = $props();

  const label = $derived(scanning ? 'Scanning' : status === 'running' ? 'Running' : status === 'completed' ? 'Completed' : 'Cancelled');
  const tone = $derived(scanning ? 'info' : status === 'running' ? 'accent' : status === 'completed' ? 'ok' : 'warn');
</script>

<span class="badge {tone}" class:lg={size === 'lg'}>
  {#if status === 'running'}<span class="dot pulse {tone}"></span>{/if}
  {label}
</span>
