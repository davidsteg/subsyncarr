<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let {
    open = $bindable(false),
    title,
    variant = 'modal',
    size = 'md',
    children,
    footer,
    header,
    onclose,
  }: {
    open?: boolean;
    title: string;
    variant?: 'modal' | 'drawer';
    size?: 'sm' | 'md' | 'lg';
    children: Snippet;
    footer?: Snippet;
    header?: Snippet;
    onclose?: () => void;
  } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  // Native <dialog> handles Esc (fires "close"); we also close on backdrop click.
  $effect(() => {
    const el = dialog;
    if (!el) return;
    const onClose = () => {
      if (open) {
        open = false;
        onclose?.();
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (e.target === el) {
        const r = el.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) el.close();
      }
    };
    el.addEventListener('close', onClose);
    el.addEventListener('click', onPointer);
    return () => {
      el.removeEventListener('close', onClose);
      el.removeEventListener('click', onPointer);
    };
  });

  function close() {
    dialog?.close();
  }
</script>

<dialog bind:this={dialog} class="dlg {variant} {size}" aria-labelledby={titleId}>
  {#if open}
    <div class="frame">
      <header class="head">
        <div class="head-text">
          <h2 id={titleId} class="break">{title}</h2>
          {#if header}{@render header()}{/if}
        </div>
        <button class="icon-btn" aria-label="Close dialog" onclick={close}>
          <Icon name="x" />
        </button>
      </header>
      <div class="body">
        {@render children()}
      </div>
      {#if footer}
        <footer class="foot">
          {@render footer()}
        </footer>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  .dlg {
    padding: 0;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-pop);
    max-height: calc(100dvh - 32px);
    overflow: hidden;
  }

  .dlg::backdrop {
    background: var(--backdrop);
  }

  .dlg.modal {
    width: min(100vw - 32px, 520px);
    border-radius: var(--radius-lg);
    margin: auto;
  }

  .dlg.modal.sm {
    width: min(100vw - 32px, 420px);
  }

  .dlg.modal.lg {
    width: min(100vw - 32px, 860px);
  }

  .dlg.drawer {
    margin: 0 0 0 auto;
    height: 100dvh;
    max-height: 100dvh;
    width: min(100vw, 620px);
    max-width: 100vw;
    border-radius: 0;
    border-top: none;
    border-bottom: none;
    border-right: none;
  }

  .dlg.drawer[open] {
    animation: slide-in 0.2s ease;
  }

  .dlg.modal[open] {
    animation: pop-in 0.15s ease;
  }

  @keyframes slide-in {
    from {
      transform: translateX(40px);
      opacity: 0;
    }
  }

  @keyframes pop-in {
    from {
      transform: translateY(6px) scale(0.98);
      opacity: 0;
    }
  }

  .frame {
    display: flex;
    flex-direction: column;
    max-height: inherit;
    height: 100%;
  }

  .dlg.modal .frame {
    max-height: calc(100dvh - 34px);
  }

  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px 16px 12px 20px;
    border-bottom: 1px solid var(--border);
  }

  .head-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .head h2 {
    font-size: 16px;
    padding-top: 6px;
  }

  .body {
    padding: 16px 20px 20px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
  }

  @media (max-width: 520px) {
    .head {
      padding: 12px 10px 10px 14px;
    }
    .body {
      padding: 14px;
    }
    .foot {
      padding: 10px 14px;
    }
  }
</style>
