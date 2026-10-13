<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../lib/components/Icon.svelte';
  import { api, errorText } from '../lib/api';
  import { codeSegments } from '../lib/format';
  import { meta } from '../lib/ui.svelte';
  import type { ChangelogEntry } from '../lib/types';

  let entries = $state<ChangelogEntry[] | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      entries = await api.changelog();
    } catch (e) {
      error = errorText(e);
    }
  });

  function sectionTone(title: string): string {
    const t = title.toLowerCase();
    if (t.startsWith('add')) return 'ok';
    if (t.startsWith('fix')) return 'info';
    if (t.startsWith('remov') || t.startsWith('deprecat') || t.startsWith('security')) return 'err';
    if (t.startsWith('change')) return 'accent';
    return '';
  }
</script>

<div class="page narrow">
  <header class="page-head">
    <div>
      <h1>Changelog</h1>
      <p class="sub">Latest releases</p>
    </div>
    {#if meta.version}
      <a class="btn sm" href={meta.version.releaseUrl} target="_blank" rel="noopener noreferrer">
        All releases <Icon name="external" size={13} />
      </a>
    {/if}
  </header>

  {#if error}
    <div class="banner err" role="alert"><Icon name="alert" /><div><strong>Could not load changelog</strong><p>{error}</p></div></div>
  {:else if entries === null}
    <div class="card"><div class="skeleton" style="height: 240px"></div></div>
  {:else if entries.length === 0}
    <div class="card"><div class="empty"><p>No changelog available.</p></div></div>
  {:else}
    <ol class="timeline">
      {#each entries as e, i (e.version)}
        <li>
          <span class="node" class:current={meta.version?.version === e.version || (i === 0 && !meta.version)}></span>
          <article class="card entry">
            <header class="entry-head">
              <h2 class="mono">{e.version}</h2>
              {#if meta.version?.version === e.version}<span class="badge accent">Installed</span>{/if}
              <span class="spacer"></span>
              <time class="subtle small tnum">{e.date}</time>
            </header>
            {#each e.sections as s (s.title)}
              <section class="sec">
                <h3><span class="badge {sectionTone(s.title)}">{s.title}</span></h3>
                <ul>
                  {#each s.items as item, j (j)}
                    <li>
                      {#each codeSegments(item) as seg, k (k)}{#if seg.code}<code>{seg.text}</code>{:else}{seg.text}{/if}{/each}
                    </li>
                  {/each}
                </ul>
              </section>
            {/each}
          </article>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .narrow {
    max-width: 900px;
  }

  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .timeline > li {
    position: relative;
    padding-left: 26px;
  }

  .timeline > li::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 24px;
    bottom: -14px;
    width: 1px;
    background: var(--border-strong);
  }

  .timeline > li:last-child::before {
    display: none;
  }

  .node {
    position: absolute;
    left: 0;
    top: 18px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    border: 2px solid var(--border-strong);
    background: var(--bg);
  }

  .node.current {
    border-color: var(--accent);
    background: var(--accent);
  }

  .entry-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  .entry-head h2 {
    font-size: 16px;
  }

  .spacer {
    flex: 1;
  }

  .sec {
    margin-top: 12px;
  }

  .sec h3 {
    margin-bottom: 6px;
  }

  .sec ul {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .sec li::marker {
    color: var(--text-3);
  }

  @media (max-width: 860px) {
    .timeline > li {
      padding-left: 20px;
    }
  }
</style>
