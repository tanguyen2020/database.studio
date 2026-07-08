<script lang="ts">
  // Settings / Preferences (Phase 6 · T3) — Ctrl+, mở. Sections Appearance/Editor/
  // Query/Data/Kafka/Shortcuts. Lưu vào SQLite (app_state) on-change. Reset defaults.
  import { settings } from '$lib/stores/settings.svelte'
  import { ui } from '$lib/stores/ui.svelte'

  const sections = ['Appearance', 'Editor', 'Query', 'Data', 'Kafka', 'Connections', 'Shortcuts'] as const
  let active = $state<(typeof sections)[number]>('Appearance')

  const s = $derived(settings.value)
  function save() {
    settings.save()
  }

  const shortcuts: Array<[string, string]> = [
    ['F5', 'Run query'],
    ['Ctrl+Enter', 'Run statement at cursor'],
    ['Esc', 'Cancel query'],
    ['Ctrl+Shift+F', 'Format SQL'],
    ['Ctrl+Shift+E', 'Explain query'],
    ['Ctrl+T / Ctrl+W', 'New / Close tab'],
    ['Ctrl+Shift+T', 'Restore closed tab'],
    ['Ctrl+Tab', 'Next / Prev tab'],
    ['Ctrl+1..9', 'Jump to tab'],
    ['Ctrl+P', 'Command palette'],
    ['Ctrl+Alt+G/J/R', 'Result: Grid / JSON / Single Row'],
    ['Ctrl+Shift+C', 'Copy result as JSON'],
    ['Ctrl+,', 'Settings'],
  ]
</script>

{#if settings.open}
  <!-- backdrop click does NOT close; use × / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && settings.close()} role="presentation" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:57">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && settings.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-720);max-width:95vw;height:var(--px-460);max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-14) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Settings</span>
        <span onclick={() => settings.reset()} onkeydown={(e) => e.key === 'Enter' && settings.reset()} role="button" tabindex="0" style="font-size:var(--px-11);color:var(--text2);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-9);cursor:pointer">Reset to defaults</span>
        <span onclick={() => settings.close()} onkeydown={(e) => e.key === 'Enter' && settings.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;display:flex;min-height:0">
        <div style="width:var(--px-160);flex:none;border-right:var(--px-1) solid var(--border);background:var(--panel);padding:var(--px-8) var(--px-6);overflow:auto">
          {#each sections as sec (sec)}
            <div onclick={() => (active = sec)} onkeydown={(e) => e.key === 'Enter' && (active = sec)} role="button" tabindex="0" style="padding:var(--px-7) var(--px-12);border-radius:var(--px-6);cursor:pointer;font-size:var(--px-12_5);background:{active === sec ? 'var(--hover)' : 'transparent'};color:{active === sec ? 'var(--text)' : 'var(--text2)'}">{sec}</div>
          {/each}
        </div>
        <div style="flex:1;overflow:auto;padding:var(--px-16) var(--px-20);display:flex;flex-direction:column;gap:var(--px-14)">
          {#if active === 'Appearance'}
            <label class="set-row">Theme
              <select value={ui.theme} onchange={() => ui.toggleTheme()} class="set-inp">
                <option value="dark">Dark</option><option value="light">Light</option>
              </select>
            </label>
            <label class="set-row">Editor font size
              <input type="number" min="10" max="24" bind:value={s.fontSize} onchange={save} class="set-inp" />
            </label>
            <label class="set-row">Font family
              <input bind:value={s.fontFamily} onchange={save} class="set-inp" style="width:var(--px-220)" />
            </label>
          {:else if active === 'Editor'}
            <label class="set-row">Tab size <input type="number" min="2" max="8" bind:value={s.tabSize} onchange={save} class="set-inp" /></label>
            <label class="set-row">Word wrap <input type="checkbox" bind:checked={s.wordWrap} onchange={save} /></label>
            <label class="set-row">Format on save <input type="checkbox" bind:checked={s.formatOnSave} onchange={save} /></label>
            <label class="set-row">Autocomplete delay (ms) <input type="number" min="0" max="1000" bind:value={s.autocompleteDelayMs} onchange={save} class="set-inp" /></label>
          {:else if active === 'Query'}
            <label class="set-row">Default page size <input type="number" min="10" max="10000" bind:value={s.defaultPageSize} onchange={save} class="set-inp" /></label>
            <label class="set-row">Continue on error <input type="checkbox" bind:checked={s.continueOnError} onchange={save} /></label>
            <label class="set-row">Long-running warning (ms) <input type="number" min="1000" bind:value={s.longRunningWarnMs} onchange={save} class="set-inp" /></label>
          {:else if active === 'Data'}
            <label class="set-row">Datetime format <input bind:value={s.datetimeFormat} onchange={save} class="set-inp" style="width:var(--px-170)" /></label>
            <label class="set-row">Timezone
              <select bind:value={s.timezone} onchange={save} class="set-inp"><option value="local">Local</option><option value="utc">UTC</option></select>
            </label>
            <label class="set-row">NULL display text <input bind:value={s.nullText} onchange={save} class="set-inp" /></label>
            <label class="set-row">Stream large exports to file <input type="checkbox" bind:checked={s.streamingIo} onchange={save} /></label>
          {:else if active === 'Kafka'}
            <label class="set-row">Max messages buffer <input type="number" min="50" max="10000" bind:value={s.kafkaMaxMessages} onchange={save} class="set-inp" /></label>
            <label class="set-row">Render throttle (ms) <input type="number" min="0" max="2000" bind:value={s.kafkaThrottleMs} onchange={save} class="set-inp" /></label>
          {:else if active === 'Connections'}
            <label class="set-row">Pool max size <input type="number" min="1" max="64" bind:value={s.poolMaxSize} onchange={save} class="set-inp" /></label>
            <label class="set-row">Idle timeout (s) <input type="number" min="1" max="86400" bind:value={s.poolIdleSecs} onchange={save} class="set-inp" /></label>
            <label class="set-row">Acquire timeout (s) <input type="number" min="1" max="300" bind:value={s.poolAcquireSecs} onchange={save} class="set-inp" /></label>
            <label class="set-row">Connect retry attempts <input type="number" min="1" max="10" bind:value={s.connectRetryAttempts} onchange={save} class="set-inp" /></label>
            <label class="set-row">Retry backoff base (ms) <input type="number" min="10" max="60000" bind:value={s.connectRetryBackoffMs} onchange={save} class="set-inp" /></label>
          {:else}
            <table style="border-collapse:collapse;font-size:var(--px-12);width:100%">
              <tbody>
                {#each shortcuts as [key, act] (key)}
                  <tr><td style="padding:var(--px-4) var(--px-10);color:var(--text2)"><span class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-4);padding:var(--px-1) var(--px-6)">{key}</span></td><td style="padding:var(--px-4) var(--px-10);color:var(--muted)">{act}</td></tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  :global(.set-row) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-12);
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  :global(.set-inp) {
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-4) var(--px-9);
    font-size: var(--px-12);
    color: var(--text);
    outline: none;
    width: var(--px-90);
  }
</style>
