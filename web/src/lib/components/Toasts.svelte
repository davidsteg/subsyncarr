<script lang="ts">
  import Icon, { type IconName } from './Icon.svelte';
  import { toasts, type ToastKind } from '../ui.svelte';

  const icons: Record<ToastKind, IconName> = { success: 'check', error: 'alert', info: 'info', warn: 'alert' };
</script>

<div class="toasts" role="region" aria-label="Notifications" aria-live="polite">
  {#each toasts.items as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
      <Icon name={icons[t.kind]} size={16} />
      <span class="msg break">{t.message}</span>
      <button class="icon-btn" aria-label="Dismiss notification" onclick={() => toasts.dismiss(t.id)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(380px, calc(100vw - 32px));
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 6px 8px 12px;
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 3px solid var(--info);
    box-shadow: var(--shadow-pop);
    font-size: 13.5px;
    animation: in 0.18s ease;
  }

  .toast.success {
    border-left-color: var(--ok);
  }
  .toast.success :global(.icon) {
    color: var(--ok);
  }
  .toast.error {
    border-left-color: var(--err);
  }
  .toast.error > :global(.icon) {
    color: var(--err);
  }
  .toast.warn {
    border-left-color: var(--warn);
  }
  .toast.warn > :global(.icon) {
    color: var(--warn);
  }
  .toast.info > :global(.icon) {
    color: var(--info);
  }

  .msg {
    flex: 1;
    min-width: 0;
  }

  .icon-btn {
    width: 28px;
    height: 28px;
  }

  @keyframes in {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }
</style>
