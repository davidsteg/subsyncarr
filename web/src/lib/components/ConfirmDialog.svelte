<script lang="ts">
  import Dialog from './Dialog.svelte';

  let {
    open = $bindable(false),
    title,
    message,
    confirmLabel = 'Confirm',
    danger = false,
    onconfirm,
  }: {
    open?: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onconfirm: () => void;
  } = $props();
</script>

<Dialog bind:open {title} size="sm">
  <p class="muted">{message}</p>
  {#snippet footer()}
    <button class="btn" onclick={() => (open = false)}>Cancel</button>
    <button
      class="btn {danger ? 'danger' : 'primary'}"
      onclick={() => {
        open = false;
        onconfirm();
      }}
    >
      {confirmLabel}
    </button>
  {/snippet}
</Dialog>
