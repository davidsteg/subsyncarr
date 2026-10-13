<script lang="ts">
  import Icon, { type IconName } from './Icon.svelte';
  import { router, href, type RouteName } from '../router.svelte';
  import { live } from '../live.svelte';
  import { meta, theme } from '../ui.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  interface NavItem {
    name: Exclude<RouteName, 'run-detail'>;
    label: string;
    icon: IconName;
    match?: RouteName[];
  }

  const items: NavItem[] = [
    { name: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { name: 'run', label: 'Live run', icon: 'activity' },
    { name: 'history', label: 'History', icon: 'history', match: ['history', 'run-detail'] },
    { name: 'library', label: 'Library', icon: 'folder' },
    { name: 'logs', label: 'Server logs', icon: 'terminal' },
    { name: 'settings', label: 'Settings', icon: 'settings' },
    { name: 'changelog', label: 'Changelog', icon: 'changelog' },
  ];

  function isActive(item: NavItem): boolean {
    return (item.match ?? [item.name]).includes(router.route.name);
  }

  const connLabel = $derived(
    live.connection === 'open' ? 'Connected' : live.connection === 'connecting' ? 'Connecting…' : 'Reconnecting…',
  );

  const runLabel = $derived.by(() => {
    if (!live.isRunning) return 'Idle';
    if (live.isScanning) return 'Scanning';
    return live.dryRun ? 'Dry run in progress' : 'Run in progress';
  });

  // Close drawer on navigation
  $effect(() => {
    void router.route;
    open = false;
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (open && e.key === 'Escape') open = false;
  }}
/>

<header class="topbar">
  <button class="icon-btn" aria-label="Open navigation" aria-expanded={open} aria-controls="sidebar" onclick={() => (open = true)}>
    <Icon name="menu" size={20} />
  </button>
  <a class="brand" href={href('dashboard')}>
    <span class="logo"><Icon name="logo" size={16} /></span>
    Subsyncarr
  </a>
  {#if live.isRunning}
    <a class="top-live" href={href('run')} aria-label="Run in progress — open live run">
      <span class="dot pulse accent"></span>
    </a>
  {/if}
  <span class="spacer"></span>
  <button
    class="icon-btn"
    aria-label={theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
    onclick={() => theme.toggle()}
  >
    <Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} />
  </button>
</header>

{#if open}
  <button class="backdrop" aria-label="Close navigation" tabindex="-1" onclick={() => (open = false)}></button>
{/if}

<nav id="sidebar" class="sidebar" class:open aria-label="Main">
  <div class="side-head">
    <a class="brand" href={href('dashboard')}>
      <span class="logo"><Icon name="logo" size={16} /></span>
      Subsyncarr
    </a>
    <button class="icon-btn close" aria-label="Close navigation" onclick={() => (open = false)}>
      <Icon name="x" />
    </button>
  </div>

  <ul class="nav">
    {#each items as item (item.name)}
      <li>
        <a
          href={href(item.name)}
          class:active={isActive(item)}
          aria-current={isActive(item) ? 'page' : undefined}
        >
          <Icon name={item.icon} />
          <span class="truncate">{item.label}</span>
          {#if item.name === 'run' && live.isRunning}
            <span class="dot pulse accent" title="Run in progress"></span>
            <span class="sr-only">(active)</span>
          {/if}
        </a>
      </li>
    {/each}
  </ul>

  <div class="side-foot">
    <div class="status-line">
      <span class="dot {live.isRunning ? 'accent pulse' : 'ok'}"></span>
      <span>{runLabel}</span>
    </div>
    <div class="status-line subtle">
      <span class="dot {live.connection === 'open' ? 'ok' : 'warn'}"></span>
      <span>{connLabel}</span>
    </div>
    <div class="foot-row">
      {#if meta.version}
        <a class="version" href={meta.version.releaseUrl} target="_blank" rel="noopener noreferrer" title="Release notes on GitHub">
          v{meta.version.version}
          <Icon name="external" size={12} />
        </a>
      {:else}
        <span class="version subtle">—</span>
      {/if}
      <button
        class="icon-btn"
        aria-label={theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={theme.resolved === 'dark' ? 'Light theme' : 'Dark theme'}
        onclick={() => theme.toggle()}
      >
        <Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} />
      </button>
    </div>
  </div>
</nav>

<style>
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    width: var(--sidebar-w);
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 16px 12px;
    z-index: 40;
  }

  .side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 6px 18px;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    font-weight: 700;
    font-size: 15.5px;
    letter-spacing: -0.01em;
    color: var(--text);
  }

  .brand:hover {
    text-decoration: none;
  }

  .logo {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--accent);
    color: var(--accent-fg);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .close {
    display: none;
  }

  .nav {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    color: var(--text-2);
    font-weight: 550;
  }

  .nav a:hover {
    background: var(--surface-2);
    color: var(--text);
    text-decoration: none;
  }

  .nav a.active {
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .nav a .dot {
    margin-left: auto;
  }

  .side-foot {
    margin-top: auto;
    border-top: 1px solid var(--border);
    padding: 14px 6px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12.5px;
  }

  .status-line {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-2);
  }

  .foot-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }

  .version {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-2);
  }

  .topbar {
    display: none;
  }

  .backdrop {
    display: none;
  }

  @media (max-width: 860px) {
    .topbar {
      display: flex;
      align-items: center;
      gap: 6px;
      position: sticky;
      top: 0;
      height: var(--topbar-h);
      padding: 0 8px;
      background: color-mix(in srgb, var(--surface) 92%, transparent);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      z-index: 30;
    }

    .top-live {
      display: inline-flex;
      padding: 8px;
    }

    .sidebar {
      width: min(280px, 85vw);
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      visibility: hidden;
      box-shadow: var(--shadow-pop);
    }

    .sidebar.open {
      transform: none;
      visibility: visible;
    }

    .close {
      display: inline-flex;
    }

    .foot-row .icon-btn {
      display: none;
    }

    .backdrop {
      display: block;
      position: fixed;
      inset: 0;
      background: var(--backdrop);
      border: none;
      z-index: 35;
      cursor: default;
    }
  }
</style>
