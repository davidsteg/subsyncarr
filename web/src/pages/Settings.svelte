<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../lib/components/Icon.svelte';
  import { api, errorText } from '../lib/api';
  import { theme, toasts } from '../lib/ui.svelte';
  import type {
    EngineName,
    MediaServer,
    NotifyKind,
    NotifyOn,
    Settings,
    SettingsUpdate,
    ThemeSetting,
  } from '../lib/types';

  interface Form {
    maxShift: number;
    agreement: number;
    notFitting: number;
    anchorAlignment: boolean;
    embeddedReference: boolean;
    defaultEngine: EngineName;
    fallbackEngine: EngineName;
    timeoutAlass: number;
    timeoutFfsubsync: number;
    timeoutAutosubsync: number;
    workers: number;
    dryRun: boolean;
    theme: ThemeSetting;
    webhookEnabled: boolean;
    webhookToken: string;
    webhookPathMap: string;
    notifyUrl: string;
    notifyKind: NotifyKind;
    notifyOn: NotifyOn;
    mediaServer: MediaServer;
    mediaServerUrl: string;
    mediaServerToken: string;
    mediaPathMap: string;
  }

  const ENGINES: EngineName[] = ['alass', 'ffsubsync', 'autosubsync'];
  const DEFAULT_TIMEOUT_MS = 300_000;

  let settings = $state<Settings | null>(null);
  let form = $state<Form | null>(null);
  let initial = $state<string>('');
  let error = $state<string | null>(null);
  let saving = $state(false);
  let testing = $state<'notify' | 'media' | null>(null);
  const WEBHOOK_SOURCES = ['sonarr', 'radarr'] as const;

  function toTheme(v: string | undefined): ThemeSetting {
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  }

  function toEngine(v: string | undefined, fallback: EngineName): EngineName {
    return (ENGINES as string[]).includes(v ?? '') ? (v as EngineName) : fallback;
  }

  function secs(ms: number | undefined): number {
    return Math.round((ms || DEFAULT_TIMEOUT_MS) / 1000);
  }

  function fromSettings(s: Settings): Form {
    return {
      maxShift: s.maxSubtitleShiftMs ?? 30000,
      agreement: s.engineAgreementThresholdMs ?? 5000,
      notFitting: s.notFittingDeleteThreshold ?? 3,
      anchorAlignment: !!s.anchorAlignment,
      embeddedReference: s.embeddedSubtitleReference ?? true,
      defaultEngine: toEngine(s.defaultEngine, 'ffsubsync'),
      fallbackEngine: toEngine(s.fallbackEngine, 'alass'),
      timeoutAlass: secs(s.engineTimeouts?.alass),
      timeoutFfsubsync: secs(s.engineTimeouts?.ffsubsync),
      timeoutAutosubsync: secs(s.engineTimeouts?.autosubsync),
      workers: s.maxConcurrentTasks || 1,
      dryRun: !!s.dryRun,
      theme: toTheme(s.theme),
      webhookEnabled: !!s.integrations?.webhookEnabled,
      webhookToken: s.integrations?.webhookToken ?? '',
      webhookPathMap: s.integrations?.webhookPathMap ?? '',
      notifyUrl: s.integrations?.notifyUrl ?? '',
      notifyKind: s.integrations?.notifyKind ?? 'apprise',
      notifyOn: s.integrations?.notifyOn ?? 'changes',
      mediaServer: s.integrations?.mediaServer ?? 'none',
      mediaServerUrl: s.integrations?.mediaServerUrl ?? '',
      mediaServerToken: s.integrations?.mediaServerToken ?? '',
      mediaPathMap: s.integrations?.mediaPathMap ?? '',
    };
  }

  function isHttpUrl(v: string): boolean {
    if (!/^https?:\/\//.test(v)) return false;
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  }

  function pathMapOk(v: string): boolean {
    return v
      .split(/[\n;]/)
      .map((l) => l.trim())
      .filter(Boolean)
      .every((l) => {
        const i = l.indexOf('=');
        return i > 0 && l.slice(i + 1).trim() !== '' && l.slice(0, i).trim() !== '';
      });
  }

  function newToken() {
    if (!form) return;
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    form.webhookToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function webhookUrl(source: string): string {
    const q = form?.webhookToken ? `?token=${encodeURIComponent(form.webhookToken)}` : '';
    return `${location.origin}/api/webhook/${source}${q}`;
  }

  const bazarrCommand = $derived(
    `curl -fsS -X POST -G "${webhookUrl('bazarr')}" --data-urlencode "path={{subtitles}}"`,
  );

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.success('Copied to clipboard');
    } catch (e) {
      toasts.error('Could not copy', e);
    }
  }

  async function test(target: 'notify' | 'media') {
    testing = target;
    try {
      const r = await api.testIntegration(target);
      toasts.success(r.message);
    } catch (e) {
      toasts.error(target === 'notify' ? 'Test notification failed' : 'Media server test failed', e);
    } finally {
      testing = null;
    }
  }

  async function load() {
    try {
      const s = await api.settings();
      settings = s;
      form = fromSettings(s);
      initial = JSON.stringify(form);
      error = null;
    } catch (e) {
      error = errorText(e);
    }
  }

  onMount(load);

  const dirty = $derived(form !== null && JSON.stringify(form) !== initial);

  const problems = $derived.by(() => {
    const p: string[] = [];
    if (!form) return p;
    const f = form;
    const isInt = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
    if (!isInt(f.maxShift) || f.maxShift < 1000 || f.maxShift > 120000) p.push('Max subtitle shift must be 1,000–120,000 ms');
    if (!isInt(f.agreement) || f.agreement < 500 || f.agreement > 60000) p.push('Agreement threshold must be 500–60,000 ms');
    if (!isInt(f.notFitting) || f.notFitting < 1 || f.notFitting > 10) p.push('Not-fitting threshold must be 1–10 runs');
    for (const [k, v] of [
      ['alass', f.timeoutAlass],
      ['ffsubsync', f.timeoutFfsubsync],
      ['autosubsync', f.timeoutAutosubsync],
    ] as const) {
      if (!isInt(v) || v < 10 || v > 600) p.push(`${k} timeout must be 10–600 s`);
    }
    if (!isInt(f.workers) || f.workers < 1 || f.workers > 24) p.push('Parallel workers must be 1–24');
    if (f.notifyUrl.trim() && !isHttpUrl(f.notifyUrl.trim())) p.push('Notification URL must start with http:// or https://');
    if (f.mediaServer !== 'none' && !isHttpUrl(f.mediaServerUrl.trim())) p.push('Media server URL must start with http:// or https://');
    if (!pathMapOk(f.webhookPathMap)) p.push('Webhook path mapping: use one "from=to" per line');
    if (!pathMapOk(f.mediaPathMap)) p.push('Media server path mapping: use one "from=to" per line');
    return p;
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!form || !dirty || problems.length) return;
    const f = form;
    const body: SettingsUpdate = {
      max_subtitle_shift_ms: Math.round(f.maxShift),
      engine_agreement_threshold_ms: Math.round(f.agreement),
      not_fitting_delete_threshold: Math.round(f.notFitting),
      anchor_alignment: f.anchorAlignment,
      embedded_subtitle_reference: f.embeddedReference,
      default_engine: f.defaultEngine,
      fallback_engine: f.fallbackEngine,
      engine_timeout_alass: Math.round(f.timeoutAlass * 1000),
      engine_timeout_ffsubsync: Math.round(f.timeoutFfsubsync * 1000),
      engine_timeout_autosubsync: Math.round(f.timeoutAutosubsync * 1000),
      max_concurrent_tasks: Math.round(f.workers),
      dry_run: f.dryRun,
      theme: f.theme,
      webhook_enabled: f.webhookEnabled,
      webhook_token: f.webhookToken.trim(),
      webhook_path_map: f.webhookPathMap.trim(),
      notify_url: f.notifyUrl.trim(),
      notify_kind: f.notifyKind,
      notify_on: f.notifyOn,
      media_server: f.mediaServer,
      media_server_url: f.mediaServerUrl.trim(),
      media_server_token: f.mediaServerToken.trim(),
      media_path_map: f.mediaPathMap.trim(),
    };
    saving = true;
    try {
      await api.saveSettings(body);
      initial = JSON.stringify(form);
      theme.set(f.theme);
      toasts.success('Settings saved');
    } catch (err) {
      toasts.error('Could not save settings', err);
    } finally {
      saving = false;
    }
  }

  function revert() {
    if (initial) form = JSON.parse(initial) as Form;
  }

  const includeEngines = $derived(
    settings ? (Array.isArray(settings.includeEngines) ? settings.includeEngines.join(', ') : settings.includeEngines) : '',
  );
</script>

<div class="page">
  <header class="page-head">
    <div>
      <h1>Settings</h1>
      <p class="sub">Stored in the database; changes apply to the next files processed.</p>
    </div>
  </header>

  {#if error}
    <div class="banner err" role="alert">
      <Icon name="alert" />
      <div><strong>Could not load settings</strong><p>{error}</p></div>
      <span class="spacer"></span>
      <button class="btn sm" onclick={load}>Retry</button>
    </div>
  {:else if !form}
    <div class="card"><div class="skeleton" style="height: 240px"></div></div>
  {:else}
    <form class="settings" onsubmit={save}>
      <section class="card" aria-labelledby="h-quality">
        <div class="card-head"><h2 id="h-quality">Sync quality</h2></div>
        <div class="fields">
          <div class="field">
            <label for="s-maxshift">Max subtitle shift</label>
            <div class="input-suffix">
              <input id="s-maxshift" class="input" type="number" min="1000" max="120000" step="1000" bind:value={form.maxShift} />
              <span>ms</span>
            </div>
            <span class="help">Maximum allowed subtitle offset before rejecting a sync (default: 30000).</span>
          </div>
          <div class="field">
            <label for="s-agree">Engine agreement threshold</label>
            <div class="input-suffix">
              <input id="s-agree" class="input" type="number" min="500" max="60000" step="500" bind:value={form.agreement} />
              <span>ms</span>
            </div>
            <span class="help">Max disagreement between engines before a subtitle counts as not fitting (default: 5000).</span>
          </div>
          <div class="field">
            <label for="s-nf">Not-fitting delete threshold</label>
            <div class="input-suffix">
              <input id="s-nf" class="input" type="number" min="1" max="10" step="1" bind:value={form.notFitting} />
              <span>runs</span>
            </div>
            <span class="help">
              Consecutive runs a subtitle must fail to fit before it's deleted — protects against a one-off transient failure
              (default: 3).
            </span>
          </div>
          <div class="field">
            <span class="label" id="l-anchor">Anchor alignment</span>
            <label class="switch">
              <input type="checkbox" bind:checked={form.anchorAlignment} aria-labelledby="l-anchor" />
              <span class="track"></span>
              <span>{form.anchorAlignment ? 'Enabled' : 'Disabled'}</span>
            </label>
            <span class="help">
              Fast path: when a video has several subtitles, sync one (the anchor) against the audio and align the others to it
              sub-to-sub. Much faster on multi-language libraries.
            </span>
          </div>
          <div class="field">
            <span class="label" id="l-embedded">Embedded subtitle tracks</span>
            <label class="switch">
              <input type="checkbox" bind:checked={form.embeddedReference} aria-labelledby="l-embedded" />
              <span class="track"></span>
              <span>{form.embeddedReference ? 'Enabled' : 'Disabled'}</span>
            </label>
            <span class="help">
              When the video has a full-length text subtitle track (e.g. SRT or ASS in an MKV), sync against it instead of the
              audio, falling back to the audio when it doesn't fit. Faster, and much more reliable for forced subtitles.
              Needs alass or ffsubsync for both engines.
            </span>
          </div>
        </div>
      </section>

      <section class="card" aria-labelledby="h-engines">
        <div class="card-head"><h2 id="h-engines">Engines</h2></div>
        <div class="fields">
          <div class="field">
            <label for="s-default">Default engine</label>
            <select id="s-default" class="select" bind:value={form.defaultEngine}>
              {#each ENGINES as e (e)}<option value={e}>{e}</option>{/each}
            </select>
            <span class="help">Primary engine, tried first with retries.</span>
          </div>
          <div class="field">
            <label for="s-fallback">Fallback engine</label>
            <select id="s-fallback" class="select" bind:value={form.fallbackEngine}>
              {#each ENGINES as e (e)}<option value={e}>{e}</option>{/each}
            </select>
            <span class="help">
              Used if the default exhausts all retries.
              {#if form.fallbackEngine === form.defaultEngine}<strong class="warn-text">Same as default — no real fallback.</strong>{/if}
            </span>
          </div>
          <div class="field">
            <label for="s-t-alass">alass timeout</label>
            <div class="input-suffix">
              <input id="s-t-alass" class="input" type="number" min="10" max="600" step="10" bind:value={form.timeoutAlass} />
              <span>s</span>
            </div>
            <span class="help">Max time allowed for alass per file (default: 300).</span>
          </div>
          <div class="field">
            <label for="s-t-ffs">ffsubsync timeout</label>
            <div class="input-suffix">
              <input id="s-t-ffs" class="input" type="number" min="10" max="600" step="10" bind:value={form.timeoutFfsubsync} />
              <span>s</span>
            </div>
            <span class="help">Max time allowed for ffsubsync per file (default: 300).</span>
          </div>
          <div class="field">
            <label for="s-t-auto">autosubsync timeout</label>
            <div class="input-suffix">
              <input id="s-t-auto" class="input" type="number" min="10" max="600" step="10" bind:value={form.timeoutAutosubsync} />
              <span>s</span>
            </div>
            <span class="help">Max time allowed for autosubsync per file (default: 300).</span>
          </div>
          <div class="field">
            <label for="s-workers">Parallel workers</label>
            <input id="s-workers" class="input" type="number" min="1" max="24" step="1" bind:value={form.workers} />
            <span class="help">Number of files processed in parallel, 1–24 (default: 1).</span>
          </div>
        </div>
      </section>

      <section class="card" aria-labelledby="h-behaviour">
        <div class="card-head"><h2 id="h-behaviour">Behaviour</h2></div>
        <div class="fields">
          <div class="field">
            <span class="label" id="l-dry">Dry-run mode</span>
            <label class="switch">
              <input type="checkbox" bind:checked={form.dryRun} aria-labelledby="l-dry" />
              <span class="track"></span>
              <span>{form.dryRun ? 'On — nothing is written' : 'Off'}</span>
            </label>
            <span class="help">Simulate syncs without writing or deleting any files.</span>
          </div>
          <div class="field">
            <label for="s-theme">Theme</label>
            <select id="s-theme" class="select" bind:value={form.theme}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <span class="help">Applied on save. "System" follows your OS preference.</span>
          </div>
        </div>
      </section>

      <section class="card" aria-labelledby="h-webhooks">
        <div class="card-head"><h2 id="h-webhooks">Webhooks</h2></div>
        <div class="fields">
          <div class="field">
            <span class="label" id="l-webhook">Sync on webhook</span>
            <label class="switch">
              <input type="checkbox" bind:checked={form.webhookEnabled} aria-labelledby="l-webhook" />
              <span class="track"></span>
              <span>{form.webhookEnabled ? 'Enabled' : 'Disabled'}</span>
            </label>
            <span class="help">
              Let Sonarr, Radarr and Bazarr trigger an immediate sync of the files they just imported or downloaded, instead of
              waiting for the next scheduled scan.
            </span>
          </div>
          <div class="field">
            <label for="s-wh-token">Token</label>
            <div class="inline">
              <input id="s-wh-token" class="input mono" type="text" autocomplete="off" bind:value={form.webhookToken} />
              <button type="button" class="btn" onclick={newToken}>Generate</button>
            </div>
            <span class="help">
              Required on every webhook call when set (<code>?token=</code>, <code>X-Api-Key</code> or the Basic-auth password).
              Recommended.
            </span>
          </div>
          <div class="field">
            <label for="s-wh-map">Path mapping</label>
            <textarea
              id="s-wh-map"
              class="textarea short"
              placeholder="/tv=/media/tv"
              spellcheck="false"
              bind:value={form.webhookPathMap}
            ></textarea>
            <span class="help">
              One <code>from=to</code> per line, when Sonarr/Radarr/Bazarr see the library under a different path than Subsyncarr.
            </span>
          </div>
        </div>
        {#if form.webhookEnabled}
          <div class="fields hooks">
            {#each WEBHOOK_SOURCES as src (src)}
              <div class="field">
                <label for={`s-wh-${src}`}>{src === 'sonarr' ? 'Sonarr' : 'Radarr'} webhook URL</label>
                <div class="inline">
                  <input id={`s-wh-${src}`} class="input mono" type="text" readonly value={webhookUrl(src)} />
                  <button type="button" class="btn" onclick={() => copy(webhookUrl(src))}>Copy</button>
                </div>
                <span class="help">
                  Settings → Connect → Webhook, method POST, triggers <em>On Import</em> and <em>On Upgrade</em>.
                </span>
              </div>
            {/each}
            <div class="field wide">
              <label for="s-wh-bazarr">Bazarr post-processing command</label>
              <div class="inline">
                <input id="s-wh-bazarr" class="input mono" type="text" readonly value={bazarrCommand} />
                <button type="button" class="btn" onclick={() => copy(bazarrCommand)}>Copy</button>
              </div>
              <span class="help">Settings → Subtitles → Custom Post-Processing. Syncs each subtitle right after download.</span>
            </div>
          </div>
          {#if dirty}<p class="small muted">Save to activate changes to the webhook settings.</p>{/if}
        {/if}
      </section>

      <section class="card" aria-labelledby="h-notify">
        <div class="card-head">
          <h2 id="h-notify">Notifications</h2>
          <button
            type="button"
            class="btn sm"
            disabled={!form.notifyUrl.trim() || dirty || testing !== null}
            title={dirty ? 'Save first' : undefined}
            onclick={() => test('notify')}
          >
            {testing === 'notify' ? 'Sending…' : 'Send test'}
          </button>
        </div>
        <div class="fields">
          <div class="field">
            <label for="s-n-url">URL</label>
            <input
              id="s-n-url"
              class="input mono"
              type="url"
              placeholder="http://apprise:8000/notify/subsyncarr"
              bind:value={form.notifyUrl}
            />
            <span class="help">Where to send a summary after each run. Leave empty to turn notifications off.</span>
          </div>
          <div class="field">
            <label for="s-n-kind">Format</label>
            <select id="s-n-kind" class="select" bind:value={form.notifyKind}>
              <option value="apprise">Apprise API</option>
              <option value="discord">Discord webhook</option>
              <option value="json">Generic JSON</option>
            </select>
            <span class="help">
              Apprise reaches Telegram, ntfy, Gotify, Pushover, email and more. Generic JSON posts the full run summary.
            </span>
          </div>
          <div class="field">
            <label for="s-n-on">Notify when</label>
            <select id="s-n-on" class="select" bind:value={form.notifyOn}>
              <option value="changes">A run synced or failed something</option>
              <option value="issues">A run had failures</option>
              <option value="always">Every run finishes</option>
            </select>
            <span class="help">Failed and not-fitting files are listed by name.</span>
          </div>
        </div>
      </section>

      <section class="card" aria-labelledby="h-media">
        <div class="card-head">
          <h2 id="h-media">Media server</h2>
          <button
            type="button"
            class="btn sm"
            disabled={form.mediaServer === 'none' || dirty || testing !== null}
            title={dirty ? 'Save first' : undefined}
            onclick={() => test('media')}
          >
            {testing === 'media' ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        <div class="fields">
          <div class="field">
            <label for="s-m-kind">Refresh after sync</label>
            <select id="s-m-kind" class="select" bind:value={form.mediaServer}>
              <option value="none">Off</option>
              <option value="jellyfin">Jellyfin</option>
              <option value="plex">Plex</option>
            </select>
            <span class="help">Refreshes the folders a run changed so synced subtitles show up right away.</span>
          </div>
          {#if form.mediaServer !== 'none'}
            <div class="field">
              <label for="s-m-url">Server URL</label>
              <input
                id="s-m-url"
                class="input mono"
                type="url"
                placeholder={form.mediaServer === 'plex' ? 'http://plex:32400' : 'http://jellyfin:8096'}
                bind:value={form.mediaServerUrl}
              />
            </div>
            <div class="field">
              <label for="s-m-token">{form.mediaServer === 'plex' ? 'Plex token' : 'API key'}</label>
              <input id="s-m-token" class="input mono" type="password" autocomplete="off" bind:value={form.mediaServerToken} />
              <span class="help">
                {form.mediaServer === 'plex'
                  ? 'Your X-Plex-Token.'
                  : 'Jellyfin Dashboard → API Keys.'}
              </span>
            </div>
            <div class="field">
              <label for="s-m-map">Path mapping</label>
              <textarea
                id="s-m-map"
                class="textarea short"
                placeholder="/media=/data"
                spellcheck="false"
                bind:value={form.mediaPathMap}
              ></textarea>
              <span class="help">One <code>from=to</code> per line, when the media server sees the library under a different path.</span>
            </div>
          {/if}
        </div>
      </section>

      <section class="card" aria-labelledby="h-env">
        <div class="card-head">
          <h2 id="h-env">Environment</h2>
          <span class="badge">Read-only</span>
        </div>
        <div class="fields">
          <div class="field">
            <label for="s-cron">Cron schedule</label>
            <input id="s-cron" class="input mono" type="text" readonly value={settings?.cronSchedule ?? ''} />
            <span class="help">Set via the <code>CRON_SCHEDULE</code> environment variable.</span>
          </div>
          <div class="field">
            <label for="s-eng">Enabled engines</label>
            <input id="s-eng" class="input mono" type="text" readonly value={includeEngines} />
            <span class="help">Set via the <code>INCLUDE_ENGINES</code> environment variable.</span>
          </div>
        </div>
      </section>

      <div class="savebar" class:dirty>
        {#if problems.length}
          <span class="problems small" role="alert"><Icon name="alert" size={14} /> {problems[0]}</span>
        {:else if dirty}
          <span class="small muted">Unsaved changes</span>
        {:else}
          <span class="small subtle">All changes saved</span>
        {/if}
        <span class="spacer"></span>
        <button type="button" class="btn" disabled={!dirty || saving} onclick={revert}>Discard</button>
        <button type="submit" class="btn primary" disabled={!dirty || saving || problems.length > 0}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  {/if}
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
    gap: 20px 24px;
  }

  .spacer {
    flex: 1;
  }

  .inline {
    display: flex;
    gap: 8px;
  }

  .inline .btn {
    flex: none;
  }

  .textarea.short {
    min-height: 64px;
  }

  .fields.hooks {
    margin-top: 20px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }

  .field.wide {
    grid-column: 1 / -1;
  }

  .card > p.small {
    margin: 12px 0 0;
  }

  .warn-text {
    color: var(--warn-text);
    font-weight: 600;
  }

  .savebar {
    position: sticky;
    bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    z-index: 5;
  }

  .savebar.dirty {
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
    box-shadow: var(--shadow-pop);
  }

  .problems {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--err-text);
  }
</style>
