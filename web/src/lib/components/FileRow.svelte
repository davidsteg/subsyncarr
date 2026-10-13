<script lang="ts">
  import Icon from './Icon.svelte';
  import StatusTag from './StatusTag.svelte';
  import ModeChip from './ModeChip.svelte';
  import EngineBadges from './EngineBadges.svelte';
  import { basename, dateTime } from '../format';
  import { mediaDrawer } from '../ui.svelte';
  import type { FileResult } from '../types';

  let {
    file,
    indent = false,
    onskip,
    skipping = false,
    showTime = false,
  }: {
    file: FileResult;
    indent?: boolean;
    onskip?: (path: string) => void;
    skipping?: boolean;
    showTime?: boolean;
  } = $props();
</script>

<div class="file-row {file.status}" class:indent>
  <div class="line">
    <StatusTag status={file.status} />
    <ModeChip mode={file.sync_mode} filePath={file.file_path} anchorPath={file.anchor_path} />
    <button class="name" title={file.file_path} onclick={() => mediaDrawer.open(file.file_path)}>
      <span class="truncate">{basename(file.file_path)}</span>
    </button>
    {#if file.status === 'processing' && file.current_engine}
      <span class="subtle small cur">{file.current_engine}…</span>
    {/if}
    {#if showTime}
      <span class="subtle small time tnum">{dateTime(file.updated_at)}</span>
    {/if}
    {#if onskip && file.status === 'processing'}
      <button
        class="btn xs danger-outline"
        disabled={skipping}
        aria-label="Skip {basename(file.file_path)}"
        onclick={() => onskip(file.file_path)}
      >
        <Icon name="skip" size={12} /> Skip
      </button>
    {/if}
  </div>
  {#if Object.keys(file.engines ?? {}).length}
    <div class="engines"><EngineBadges engines={file.engines} /></div>
  {/if}
</div>

<style>
  .file-row {
    padding: 9px 18px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  :global(.group-head) + .file-row {
    border-top: none;
  }

  .file-row.indent {
    padding-left: 42px;
    position: relative;
  }

  .file-row.indent::before {
    content: '';
    position: absolute;
    left: 26px;
    top: 0;
    bottom: 50%;
    width: 9px;
    border-left: 1px solid var(--border-strong);
    border-bottom: 1px solid var(--border-strong);
    border-bottom-left-radius: 4px;
  }

  .file-row.processing {
    background: color-mix(in srgb, var(--info-soft) 45%, transparent);
  }

  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .name {
    appearance: none;
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    font-weight: 550;
    color: var(--text);
    cursor: pointer;
    min-width: 0;
    flex: 1;
    text-align: left;
    display: flex;
  }

  .name:hover {
    color: var(--accent-text);
    text-decoration: underline;
  }

  .cur,
  .time {
    white-space: nowrap;
  }

  .engines {
    min-width: 0;
  }

  @media (max-width: 860px) {
    .file-row {
      padding: 9px 14px;
    }
    .file-row.indent {
      padding-left: 30px;
    }
    .file-row.indent::before {
      left: 16px;
    }
    .line {
      flex-wrap: wrap;
    }
    .name {
      flex-basis: 100%;
      order: 5;
    }
    .time {
      display: none;
    }
  }
</style>
