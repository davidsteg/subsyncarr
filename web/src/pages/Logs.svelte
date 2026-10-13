<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from '../lib/components/Icon.svelte';
  import { api, errorText } from '../lib/api';
  import { copyText, debounce, num } from '../lib/format';
  import { toasts } from '../lib/ui.svelte';
  import type { LogEntry, LogLevelFilter } from '../lib/types';

  const MAX_LINES = 5000;
  const POLL_MS = 3000;
  const LEVELS: { key: LogLevelFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'log', label: 'Info' },
    { key: 'warn', label: 'Warn' },
    { key: 'error', label: 'Error' },
  ];

  let level = $state<LogLevelFilter>('all');
  let searchInput = $state('');
  let search = $state('');
  let follow = $state(true);
  let entries = $state<LogEntry[]>([]);
  let latestSeq = $state(0);
  let bufferInfo = $state<{ size: number; maxSize: number } | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let box: HTMLDivElement | undefined = $state();
  let reqSeq = 0;

  const applySearch = debounce((v: string) => (search = v.trim()), 300);

  function cap(list: LogEntry[]): LogEntry[] {
    return list.length > MAX_LINES ? list.slice(list.length - MAX_LINES) : list;
  }

  function nearBottom(): boolean {
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  }

  async function scrollToBottom() {
    await tick();
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function reload(lv: LogLevelFilter, q: string) {
    const my = ++reqSeq;
    loading = true;
    try {
      const r = await api.logs({ limit: 1000, level: lv, search: q });
      if (my !== reqSeq) return;
      entries = cap(r.logs);
      latestSeq = r.latestSeq;
      bufferInfo = { size: r.size, maxSize: r.maxSize };
      error = null;
      void scrollToBottom();
    } catch (e) {
      if (my === reqSeq) error = errorText(e);
    } finally {
      if (my === reqSeq) loading = false;
    }
  }

  async function poll() {
    const my = reqSeq;
    try {
      const r = await api.logs({ level, search, since: latestSeq });
      if (my !== reqSeq) return; // filters changed meanwhile
      const stick = nearBottom();
      const fresh = r.logs.filter((l) => l.seq > latestSeq);
      if (fresh.length) entries = cap([...entries, ...fresh]);
      latestSeq = Math.max(latestSeq, r.latestSeq);
      bufferInfo = { size: r.size, maxSize: r.maxSize };
      error = null;
      if (fresh.length && stick) void scrollToBottom();
    } catch (e) {
      error = errorText(e);
    }
  }

  $effect(() => {
    void reload(level, search);
  });

  $effect(() => {
    if (!follow) return;
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  });

  onMount(() => () => applySearch.cancel());

  function fmtTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleString([], {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  function asText(): string {
    return entries.map((e) => `${new Date(e.timestamp).toISOString()} [${e.level.toUpperCase()}] ${e.message}`).join('\n');
  }

  async function copy() {
    if (await copyText(asText())) toasts.success(`Copied ${num(entries.length)} lines`);
    else toasts.error('Copy failed — select the text manually');
  }

  const downloadUrl = $derived(api.logsTextUrl({ level, search, limit: MAX_LINES }));
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Server logs</h1>
      <p class="sub">
        Live output from the subsyncarr process
        {#if bufferInfo}<span class="subtle tnum"> · buffer {num(bufferInfo.size)} / {num(bufferInfo.maxSize)}</span>{/if}
      </p>
    </div>
    <div class="row">
      <button class="btn sm" onclick={copy} disabled={entries.length === 0}><Icon name="copy" size={14} /> Copy</button>
      <a class="btn sm" href={downloadUrl} download="subsyncarr-logs.txt"><Icon name="download" size={14} /> Download</a>
    </div>
  </header>

  <div class="toolbar">
    <div class="segmented" role="group" aria-label="Log level">
      {#each LEVELS as l (l.key)}
        <button aria-pressed={level === l.key} onclick={() => (level = l.key)}>{l.label}</button>
      {/each}
    </div>
    <div class="search grow">
      <Icon name="search" size={15} />
      <input
        class="input"
        type="search"
        placeholder="Search messages…"
        aria-label="Search log messages"
        bind:value={searchInput}
        oninput={() => applySearch(searchInput)}
      />
    </div>
    <label class="switch">
      <input type="checkbox" bind:checked={follow} />
      <span class="track"></span>
      <span>Follow</span>
      {#if follow}<span class="dot pulse ok" aria-hidden="true"></span>{/if}
    </label>
  </div>

  {#if error}
    <div class="banner err" role="alert">
      <Icon name="alert" />
      <div><strong>Could not load logs</strong><p>{error}</p></div>
    </div>
  {/if}

  <div class="logwrap card flush">
    {#if loading && entries.length === 0}
      <div class="pad"><div class="skeleton" style="height: 300px"></div></div>
    {:else if entries.length === 0}
      <div class="empty"><p>{search || level !== 'all' ? 'No log lines match.' : 'No log lines yet.'}</p></div>
    {:else}
      <!-- Scrollable region must be keyboard-focusable so it can be scrolled without a mouse (WCAG 2.1.1). -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="lines" bind:this={box} tabindex="0" role="log" aria-label="Server log lines" aria-live="off">
        {#each entries as e (e.seq)}
          <div class="ln {e.level}">
            <span class="ts">{fmtTime(e.timestamp)}</span>
            <span class="lvl">{e.level === 'log' ? 'INFO' : e.level.toUpperCase()}</span>
            <span class="msg">{e.message}</span>
          </div>
        {/each}
      </div>
    {/if}
    <div class="status small subtle tnum">
      {num(entries.length)} lines{entries.length >= MAX_LINES ? ` (capped at ${num(MAX_LINES)})` : ''}
      {#if follow}· polling every {POLL_MS / 1000}s{/if}
    </div>
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px 14px;
    flex-wrap: wrap;
  }

  .grow {
    flex: 1 1 220px;
  }

  .pad {
    padding: 14px;
  }

  .lines {
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.55;
    height: min(68vh, 900px);
    overflow: auto;
    padding: 8px 0;
    background: var(--surface-2);
  }

  .ln {
    display: grid;
    grid-template-columns: auto 48px 1fr;
    gap: 10px;
    padding: 1px 14px;
    align-items: baseline;
  }

  .ln:hover {
    background: var(--surface-3);
  }

  .ts {
    color: var(--text-3);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .lvl {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-align: center;
    border-radius: 4px;
    padding: 0 4px;
    color: var(--info-text);
    background: var(--info-soft);
  }

  .ln.warn .lvl {
    color: var(--warn-text);
    background: var(--warn-soft);
  }

  .ln.error .lvl {
    color: var(--err-text);
    background: var(--err-soft);
  }

  .ln.error .msg {
    color: var(--err-text);
  }

  .msg {
    white-space: pre-wrap;
    word-break: break-word;
    min-width: 0;
  }

  .status {
    padding: 8px 14px;
    border-top: 1px solid var(--border);
  }

  @media (max-width: 860px) {
    .ln {
      grid-template-columns: 48px 1fr;
      gap: 2px 8px;
      padding: 3px 10px;
    }
    .ts {
      grid-column: 1 / -1;
      font-size: 11px;
    }
  }
</style>
