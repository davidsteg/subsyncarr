<script lang="ts">
  import Dialog from './Dialog.svelte';
  import RunLogs from './RunLogs.svelte';

  let { open = $bindable(false), runId, title }: { open?: boolean; runId: string | null; title: string } = $props();
</script>

<Dialog bind:open {title} size="lg">
  {#if runId}
    <RunLogs {runId} />
  {/if}
</Dialog>
