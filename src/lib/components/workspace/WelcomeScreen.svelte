<script lang="ts">
  // Start screen — what the editor area shows when no tab is open (the desktop app
  // always opens this way). Replaces the bare "No tabs open" line: the app mark, the
  // three things people do first, their connections one click away, and the
  // shortcuts worth knowing.
  import AppLogo from '$lib/components/AppLogo.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { palette } from '$lib/stores/palette.svelte'
  import { SYSTEM_ORDER, systemMeta } from '$lib/systems'
  import type { ProfilePublic } from '$lib/types'

  let { pane = 0 }: { pane?: 0 | 1 } = $props()

  const hasConnections = $derived(connections.profiles.length > 0)
  // open connections first, then the rest in list order
  const recent = $derived(
    [...connections.profiles].sort((a, b) => Number(!!b.connected) - Number(!!a.connected)).slice(0, 6),
  )

  async function openConnection(p: ProfilePublic) {
    connections.select(p.id)
    if (!p.connected) await connections.connect(p.id)
  }

  const SHORTCUTS: [string, string][] = [
    ['Ctrl+T', 'New query tab'],
    ['Ctrl+P', 'Command palette'],
    ['Ctrl+Shift+N', 'New connection'],
    ['F5', 'Run query'],
  ]
</script>

<div class="wl">
  <div class="wl-inner">
    <div class="wl-hero">
      <AppLogo size={52} />
      <div>
        <h1>Database Studio</h1>
        <p>
          {hasConnections
            ? 'Pick up where you left off, or start something new.'
            : 'One place for your SQL databases, document stores, caches and message brokers.'}
        </p>
      </div>
    </div>

    <div class="wl-actions">
      <button class="wl-card primary" onclick={() => (ui.pickerOpen = true)}>
        <span class="wl-ic"><Icon name="plus" size={18} /></span>
        <span class="wl-ct">
          <span class="wl-title">New connection</span>
          <span class="wl-sub">Add a database or broker</span>
        </span>
      </button>
      {#if hasConnections}
        <button class="wl-card" onclick={() => tabs.openSqlTab({ pane })}>
          <span class="wl-ic"><Icon name="query" size={18} /></span>
          <span class="wl-ct">
            <span class="wl-title">New query</span>
            <span class="wl-sub">Open an empty SQL editor</span>
          </span>
        </button>
      {/if}
      <button class="wl-card" onclick={() => (palette.open = true)}>
        <span class="wl-ic"><Icon name="search" size={18} /></span>
        <span class="wl-ct">
          <span class="wl-title">Search everything</span>
          <span class="wl-sub">Tables, connections and commands</span>
        </span>
      </button>
    </div>

    {#if hasConnections}
      <section>
        <h2>Connections</h2>
        <div class="wl-list">
          {#each recent as p (p.id)}
            <button class="wl-row" onclick={() => openConnection(p)} title={p.connected ? `Show ${p.name}` : `Connect to ${p.name}`}>
              <SystemIcon system={p.system} size={18} />
              <span class="wl-row-name">{p.name}</span>
              <!-- engine name, not the host/IP: the start screen is often on a shared or projected display -->
              <span class="wl-row-meta">{systemMeta(p.system).label}</span>
              <span class="wl-dot" class:on={p.connected} title={p.connected ? 'Connected' : 'Not connected'}></span>
            </button>
          {/each}
        </div>
      </section>
    {:else}
      <section>
        <h2>Works with</h2>
        <div class="wl-engines">
          {#each SYSTEM_ORDER as sys (sys)}
            <button class="wl-engine" onclick={() => (ui.pickerOpen = true)} title={`Connect to ${systemMeta(sys).label}`}>
              <SystemIcon system={sys} size={22} />
              <span>{systemMeta(sys).label}</span>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <section>
      <h2>Shortcuts</h2>
      <div class="wl-keys">
        {#each SHORTCUTS as [k, label] (k)}
          <div class="wl-key"><kbd>{k}</kbd><span>{label}</span></div>
        {/each}
      </div>
    </section>
  </div>
</div>

<style>
  .wl {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    justify-content: center;
    background: var(--bg);
  }
  .wl-inner {
    width: 100%;
    max-width: var(--px-720);
    padding: var(--px-56) var(--px-30) var(--px-40);
    display: flex;
    flex-direction: column;
    gap: var(--px-28);
  }
  .wl-hero {
    display: flex;
    align-items: center;
    gap: var(--px-16);
  }
  h1 {
    margin: 0;
    font-size: var(--px-22);
    font-weight: 650;
    letter-spacing: -0.015em;
    color: var(--text);
  }
  .wl-hero p {
    margin: var(--px-4) 0 0;
    font-size: var(--px-13_5);
    color: var(--text2);
  }
  h2 {
    margin: 0 0 var(--px-10);
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--muted);
  }
  .wl-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--px-200), 1fr));
    gap: var(--px-12);
  }
  .wl-card {
    display: flex;
    align-items: center;
    gap: var(--px-12);
    text-align: left;
    padding: var(--px-14) var(--px-16);
    border-radius: var(--px-10);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-family: var(--font-main);
  }
  .wl-card:hover {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
    background: color-mix(in srgb, var(--primary) 4%, var(--surface));
  }
  .wl-ic {
    flex: none;
    width: var(--px-34);
    height: var(--px-34);
    border-radius: var(--px-8);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .wl-card.primary .wl-ic {
    color: var(--hex-fff);
    background: var(--primary);
  }
  .wl-ct {
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    min-width: 0;
  }
  .wl-title {
    font-size: var(--px-13_5);
    font-weight: 600;
  }
  .wl-sub {
    font-size: var(--px-12);
    color: var(--muted);
  }
  .wl-list {
    display: flex;
    flex-direction: column;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
    overflow: hidden;
  }
  .wl-row {
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-10) var(--px-14);
    border: none;
    border-bottom: var(--px-1) solid var(--border);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    text-align: left;
    font-family: var(--font-main);
  }
  .wl-row:last-child {
    border-bottom: none;
  }
  .wl-row:hover {
    background: color-mix(in srgb, var(--primary) 6%, transparent);
  }
  .wl-row-name {
    font-size: var(--px-13);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wl-row-meta {
    margin-left: auto;
    font-size: var(--px-12);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wl-dot {
    flex: none;
    width: var(--px-7);
    height: var(--px-7);
    border-radius: 50%;
    background: var(--border2);
  }
  .wl-dot.on {
    background: var(--success);
  }
  .wl-engines {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--px-130), 1fr));
    gap: var(--px-8);
  }
  .wl-engine {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    font-family: var(--font-main);
    font-size: var(--px-12_5);
    font-weight: 500;
  }
  .wl-engine:hover {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
  }
  .wl-keys {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--px-200), 1fr));
    gap: var(--px-8) var(--px-20);
  }
  .wl-key {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  kbd {
    font-family: var(--font-main);
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--text);
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-bottom-width: var(--px-2);
    border-radius: var(--px-5);
    padding: var(--px-2) var(--px-7);
    white-space: nowrap;
  }
</style>
