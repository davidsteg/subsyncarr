<script lang="ts">
  import type { QualityLevel } from '../types';

  let {
    score,
    level = null,
    flagged = false,
  }: { score: number | null | undefined; level?: QualityLevel | null; flagged?: boolean } = $props();

  const lv = $derived<QualityLevel | null>(
    level ?? (score === null || score === undefined ? null : score >= 80 ? 'good' : score >= 50 ? 'fair' : 'weak'),
  );
  const tone = $derived(lv === 'good' ? 'ok' : lv === 'fair' ? 'info' : 'warn');
  const label = $derived(lv === 'good' ? 'Good' : lv === 'fair' ? 'Fair' : 'Weak');
</script>

{#if score !== null && score !== undefined && lv}
  <span
    class="badge {tone} qb"
    title="Sync confidence {score}/100{flagged ? ' · needs review' : ''}"
    aria-label="Sync confidence {score} of 100, {label}{flagged ? ', needs review' : ''}"
  >
    <span class="tnum">{score}</span>
    {label}{#if flagged}<span aria-hidden="true"> · review</span>{/if}
  </span>
{/if}

<style>
  .qb {
    gap: 4px;
    white-space: nowrap;
  }

  .qb .tnum {
    font-weight: 700;
  }
</style>
