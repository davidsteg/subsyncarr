<script lang="ts">
  import type { FileStatus } from '../types';

  let { status }: { status: FileStatus } = $props();

  const map: Record<FileStatus, { label: string; tone: string }> = {
    pending: { label: 'Pending', tone: '' },
    processing: { label: 'Syncing', tone: 'info' },
    completed: { label: 'OK', tone: 'ok' },
    skipped: { label: 'Skipped', tone: 'warn' },
    error: { label: 'Failed', tone: 'err' },
    not_fitting: { label: 'Not fitting', tone: 'err' },
  };
  const m = $derived(map[status] ?? { label: status, tone: '' });
</script>

<span class="badge {m.tone}">
  {#if status === 'processing'}<span class="dot pulse info"></span>{/if}
  {m.label}
</span>
