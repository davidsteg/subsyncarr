<script lang="ts">
  import { basename } from '../format';
  import type { SyncMode } from '../types';

  let {
    mode,
    filePath,
    anchorPath = null,
    showAnchor = false,
  }: { mode: SyncMode | null; filePath: string; anchorPath?: string | null; showAnchor?: boolean } = $props();

  const isForced = $derived(mode === 'full' && filePath.toLowerCase().includes('.forced.'));
</script>

{#if mode === 'anchor'}
  <span class="chip accent" title="Synced against the video; sibling subtitles align to this one">Anchor</span>
{:else if mode === 'follower'}
  <span class="chip info" title={anchorPath ? `Aligned to anchor: ${anchorPath}` : 'Aligned sub-to-sub against the anchor'}>
    via anchor{#if showAnchor && anchorPath}: {basename(anchorPath)}{/if}
  </span>
{:else if isForced}
  <span class="chip warn" title="Forced subtitles always go through the full engine pipeline">forced – full pipeline</span>
{/if}
