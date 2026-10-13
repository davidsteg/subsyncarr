<script lang="ts">
  let {
    value,
    tone = 'accent',
    size = 'md',
    label,
  }: { value: number; tone?: 'accent' | 'ok' | 'warn' | 'err' | 'info'; size?: 'md' | 'lg'; label?: string } =
    $props();
  const clamped = $derived(Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)));
</script>

<div
  class="progress {tone === 'accent' ? '' : tone}"
  class:lg={size === 'lg'}
  role="progressbar"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(clamped)}
  aria-label={label}
>
  <span style:width="{clamped}%"></span>
</div>
