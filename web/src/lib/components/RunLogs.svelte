<script lang="ts">
  import Icon from './Icon.svelte';
  import { api, errorText } from '../api';
  import { copyText } from '../format';
  import { toasts } from '../ui.svelte';

  let { runId }: { runId: string } = $props();

  let logs = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function load(id: string) {
    loading = true;
    error = null;
    try {
      const r = await api.runLogs(id);
      logs = r.logs ?? '';
    } catch (e) {
      error = errorText(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load(runId);
  });

  async function copy() {
    if (await copyText(logs ?? '')) toasts.success('Logs copied to clipboard');
    else toasts.error('Copy failed — select the text manually');
  }
</script>

<div class="run-logs">
  <div class="bar">
    <span class="subtle small">{logs ? `${logs.split('\n').length.toLocaleString()} lines` : ''}</span>
    <span class="row">
      <button class="btn sm" onclick={() => load(runId)} disabled={loading}><Icon name="refresh" size={14} /> Reload</button>
      <button class="btn sm" onclick={copy} disabled={!logs}><Icon name="copy" size={14} /> Copy</button>
    </span>
  </div>
  {#if error}
    <div class="banner err" role="alert"><Icon name="alert" /><div><strong>Could not load logs</strong><p>{error}</p></div></div>
  {:else if logs === null}
    <div class="skeleton" style="height: 240px"></div>
  {:else if logs.trim() === ''}
    <p class="muted small">No logs recorded for this run.</p>
  {:else}
    <!-- Scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre class="logbox" tabindex="0" aria-label="Run log output">{logs}</pre>
  {/if}
</div>

<style>
  .run-logs {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
