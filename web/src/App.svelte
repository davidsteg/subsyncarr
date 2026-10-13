<script lang="ts">
  import { onMount } from 'svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
  import Toasts from './lib/components/Toasts.svelte';
  import MediaDrawer from './lib/components/MediaDrawer.svelte';
  import Dashboard from './pages/Dashboard.svelte';
  import LiveRun from './pages/LiveRun.svelte';
  import History from './pages/History.svelte';
  import RunDetail from './pages/RunDetail.svelte';
  import Library from './pages/Library.svelte';
  import Logs from './pages/Logs.svelte';
  import Settings from './pages/Settings.svelte';
  import Changelog from './pages/Changelog.svelte';
  import { router } from './lib/router.svelte';
  import { live } from './lib/live.svelte';
  import { meta, theme } from './lib/ui.svelte';

  let navOpen = $state(false);

  const titles: Record<string, string> = {
    dashboard: 'Dashboard',
    run: 'Live run',
    history: 'History',
    'run-detail': 'Run',
    library: 'Library',
    logs: 'Server logs',
    settings: 'Settings',
    changelog: 'Changelog',
  };

  theme.init();

  onMount(() => {
    live.start();
    void meta.loadVersion();
    void meta.loadConfig();
  });

  $effect(() => {
    document.documentElement.setAttribute('data-theme', theme.resolved);
  });

  $effect(() => {
    const prefix = live.isRunning ? '● ' : '';
    document.title = `${prefix}${titles[router.route.name] ?? 'Subsyncarr'} · Subsyncarr`;
  });
</script>

<button class="skip-link" onclick={() => document.getElementById('main')?.focus()}>Skip to content</button>

<Sidebar bind:open={navOpen} />

<main id="main" tabindex="-1">
  {#key router.route.name === 'run-detail' ? `run-${router.route.params.id}` : router.route.name}
    {#if router.route.name === 'dashboard'}
      <Dashboard />
    {:else if router.route.name === 'run'}
      <LiveRun />
    {:else if router.route.name === 'history'}
      <History />
    {:else if router.route.name === 'run-detail'}
      <RunDetail id={router.route.params.id} />
    {:else if router.route.name === 'library'}
      <Library />
    {:else if router.route.name === 'logs'}
      <Logs />
    {:else if router.route.name === 'settings'}
      <Settings />
    {:else if router.route.name === 'changelog'}
      <Changelog />
    {/if}
  {/key}
</main>

<MediaDrawer />
<Toasts />

<style>
  main {
    margin-left: var(--sidebar-w);
    min-height: 100vh;
    min-width: 0;
    outline: none;
    position: relative;
  }

  .skip-link {
    position: absolute;
    left: 8px;
    top: -40px;
    z-index: 200;
    background: var(--accent);
    color: var(--accent-fg);
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    border: none;
    font: inherit;
    cursor: pointer;
  }

  .skip-link:focus {
    top: 8px;
  }

  @media (max-width: 860px) {
    main {
      margin-left: 0;
      min-height: calc(100vh - var(--topbar-h));
    }
  }
</style>
