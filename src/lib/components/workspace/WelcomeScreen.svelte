<script lang="ts">
  // Start screen — what the editor area shows when no tab is open (the desktop app
  // always opens this way). A welcome banner with the two things people do first
  // and a glance at their setup, connections as cards (engine colour, environment,
  // state, a one-click query), a quick-start column and the engines it works with.
  import AppLogo from '$lib/components/AppLogo.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { palette } from '$lib/stores/palette.svelte'
  import { SYSTEM_ORDER, envMeta, systemMeta } from '$lib/systems'
  import type { ProfilePublic } from '$lib/types'
  import { opensWorkspace } from '$lib/stream/workspace-systems'

  let { pane = 0 }: { pane?: 0 | 1 } = $props()

  const profiles = $derived(connections.profiles)
  const hasConnections = $derived(profiles.length > 0)
  const connectedCount = $derived(profiles.filter((p) => p.connected).length)
  const engineCount = $derived(new Set(profiles.map((p) => p.system)).size)
  // open connections first, then the rest in list order
  const recent = $derived([...profiles].sort((a, b) => Number(!!b.connected) - Number(!!a.connected)).slice(0, 8))

  // engines that open a query console (SQL / CQL / mongosh)
  const QUERY_SYSTEMS = ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'sqlite', 'duckdb', 'clickhouse', 'cassandra', 'mongodb']
  const ENV_VAR: Record<string, string> = { production: 'prod', staging: 'stg', development: 'dev', local: 'local' }
  const envKey = (env: string | null | undefined) => ENV_VAR[env ?? 'development'] ?? 'dev'

  const greeting = (() => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  })()

  async function openConnection(p: ProfilePublic) {
    connections.select(p.id)
    if (!p.connected && !(await connections.connect(p.id))) return
    // Redis · Kafka · NATS · RabbitMQ have no object tree — their workspace is the view
    if (opensWorkspace(p.system)) tabs.openStreamWorkspace(p.id)
  }
  async function queryOn(p: ProfilePublic) {
    connections.select(p.id)
    if (!p.connected && !(await connections.connect(p.id))) return
    tabs.openQueryConsole({ connectionId: p.id, useSelection: false })
  }

  const SHORTCUTS: [string, string][] = [
    ['Ctrl+T', 'New query tab'],
    ['Ctrl+P', 'Command palette'],
    ['Ctrl+Shift+N', 'New connection'],
    ['F5', 'Run query'],
    ['Ctrl+Shift+F', 'Format SQL'],
  ]
  const STEPS: { icon: 'plus' | 'table' | 'query'; title: string; text: string }[] = [
    { icon: 'plus', title: 'Connect', text: 'Add a database, cache or message broker — over SSH or TLS when you need it.' },
    { icon: 'table', title: 'Explore', text: 'Browse schemas, open table data, design tables and compare databases.' },
    { icon: 'query', title: 'Query', text: 'Write SQL with autocomplete, run it, then export or edit the results.' },
  ]
</script>

<div class="wl">
  <div class="wl-inner">
    <!-- welcome banner -->
    <header class="wl-hero">
      <div class="wl-hero-main">
        <AppLogo size={56} />
        <div class="wl-hero-text">
          <span class="wl-eyebrow">{greeting}</span>
          <h1>Database Studio</h1>
          <p>
            {hasConnections
              ? 'Pick up where you left off, or start something new.'
              : 'One place for your SQL databases, document stores, caches and message brokers.'}
          </p>
        </div>
      </div>
      <div class="wl-cta">
        <button class="wl-btn primary" onclick={() => (ui.pickerOpen = true)}>
          <Icon name="plus" size={15} />New connection
        </button>
        {#if hasConnections}
          <button class="wl-btn" onclick={() => tabs.openSqlTab({ pane })}>
            <Icon name="query" size={15} />New query
          </button>
        {/if}
        <button class="wl-btn ghost" onclick={() => (palette.open = true)} title="Tables, connections and commands">
          <Icon name="search" size={15} />Search everything<kbd>Ctrl+P</kbd>
        </button>
      </div>
      {#if hasConnections}
        <div class="wl-stats">
          <div class="wl-stat"><b>{profiles.length}</b><span>connection{profiles.length === 1 ? '' : 's'}</span></div>
          <div class="wl-stat"><b class="on">{connectedCount}</b><span>connected now</span></div>
          <div class="wl-stat"><b>{engineCount}</b><span>engine{engineCount === 1 ? '' : 's'}</span></div>
        </div>
      {/if}
    </header>

    <div class="wl-grid">
      <!-- connections -->
      <section class="wl-main">
        {#if hasConnections}
          <div class="wl-sec-head">
            <h2>Connections</h2>
            {#if profiles.length > recent.length}<span class="wl-more">{profiles.length - recent.length} more in the sidebar</span>{/if}
          </div>
          <div class="wl-cards">
            {#each recent as p (p.id)}
              {@const m = systemMeta(p.system)}
              <div class="wl-conn" style="--acc:{m.accent}">
                <button class="wl-conn-open" onclick={() => openConnection(p)} title={p.connected ? `Show ${p.name}` : `Connect to ${p.name}`}>
                  <span class="wl-conn-ic"><SystemIcon system={p.system} size={22} /></span>
                  <span class="wl-conn-text">
                    <span class="wl-conn-name">{p.name}</span>
                    <!-- engine name, not the host/IP: the start screen is often on a shared or projected display -->
                    <span class="wl-conn-meta">
                      {m.label}
                      <span class="wl-env" style="background:var(--env-{envKey(p.env)}-bg);color:var(--env-{envKey(p.env)}-fg)">{envMeta(p.env).label}</span>
                    </span>
                  </span>
                  <span class="wl-state" class:on={p.connected}>{p.connected ? 'Connected' : 'Offline'}</span>
                </button>
                {#if QUERY_SYSTEMS.includes(p.system)}
                  <button class="wl-conn-q" onclick={() => queryOn(p)} title={`New query on ${p.name}`} aria-label={`New query on ${p.name}`}>
                    <Icon name="query" size={14} />
                  </button>
                {/if}
              </div>
            {/each}
            <button class="wl-conn wl-add" onclick={() => (ui.pickerOpen = true)}>
              <Icon name="plus" size={18} />
              <span>Add connection</span>
            </button>
          </div>
        {:else}
          <h2>Get started in three steps</h2>
          <div class="wl-steps">
            {#each STEPS as s, i (s.title)}
              <div class="wl-step">
                <span class="wl-step-n">{i + 1}</span>
                <span class="wl-step-ic"><Icon name={s.icon} size={16} /></span>
                <b>{s.title}</b>
                <span>{s.text}</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- side column -->
      <aside class="wl-side">
        <div class="wl-panel">
          <h2>Keyboard shortcuts</h2>
          <div class="wl-keys">
            {#each SHORTCUTS as [k, label] (k)}
              <div class="wl-key"><span>{label}</span><kbd>{k}</kbd></div>
            {/each}
          </div>
        </div>
        {#if hasConnections}
          <div class="wl-panel wl-tip">
            <span class="wl-tip-ic"><Icon name="sliders" size={15} /></span>
            <div>
              <b>Tip</b>
              <span>Right-click a table in the Explorer for Open Data, Design Table, Generate Scripts and more.</span>
            </div>
          </div>
        {/if}
      </aside>
    </div>

    <!-- engines -->
    <section class="wl-works">
      <h2>Works with</h2>
      <div class="wl-engines">
        {#each SYSTEM_ORDER as sys (sys)}
          <button class="wl-engine" onclick={() => (ui.pickerOpen = true)} title={`Connect to ${systemMeta(sys).label}`}>
            <SystemIcon system={sys} size={20} />
            <span>{systemMeta(sys).label}</span>
          </button>
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
    /* top-aligned: a stretched column would squeeze its blocks to the window height */
    align-items: flex-start;
    background: var(--bg);
    font-family: var(--font-main);
  }
  .wl-inner > * {
    flex-shrink: 0;
  }
  .wl-inner {
    width: 100%;
    max-width: calc(var(--px-520) * 2);
    padding: var(--px-30) var(--px-30) var(--px-40);
    display: flex;
    flex-direction: column;
    gap: var(--px-24);
  }
  h2 {
    margin: 0 0 var(--px-12);
    font-size: var(--px-13);
    font-weight: 650;
    color: var(--text);
  }

  /* ---- banner ---------------------------------------------------------- */
  .wl-hero {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: var(--px-20);
    padding: var(--px-28) var(--px-30);
    border-radius: var(--px-16);
    border: var(--px-1) solid color-mix(in srgb, var(--primary) 18%, var(--border));
    background:
      radial-gradient(120% 140% at 100% 0%, color-mix(in srgb, var(--primary) 16%, transparent) 0%, transparent 55%),
      linear-gradient(135deg, color-mix(in srgb, var(--primary) 7%, var(--surface)) 0%, var(--surface) 70%);
    box-shadow: var(--shadow-sm);
  }
  .wl-hero-main {
    display: flex;
    align-items: center;
    gap: var(--px-18);
  }
  .wl-hero-text {
    display: flex;
    flex-direction: column;
    gap: var(--px-3);
  }
  .wl-eyebrow {
    font-size: var(--px-12_5);
    font-weight: 600;
    color: var(--primary);
  }
  h1 {
    margin: 0;
    font-size: var(--px-28);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
    line-height: 1.15;
  }
  .wl-hero p {
    margin: 0;
    font-size: var(--px-14);
    color: var(--text2);
  }
  .wl-cta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-10);
  }
  .wl-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--px-8);
    height: var(--px-38);
    padding: 0 var(--px-16);
    border-radius: var(--px-10);
    border: var(--px-1) solid var(--border2);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-main);
    font-size: var(--px-13_5);
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--shadow-xs);
    transition: transform 0.12s, box-shadow 0.12s, border-color 0.12s, background 0.12s;
  }
  .wl-btn:hover {
    transform: translateY(calc(var(--px-1) * -1));
    box-shadow: var(--shadow-sm);
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border2));
  }
  .wl-btn.primary {
    background: var(--primary);
    border-color: var(--primary);
    color: var(--hex-fff);
  }
  .wl-btn.primary:hover {
    filter: brightness(0.93);
  }
  .wl-btn.ghost {
    background: transparent;
    box-shadow: none;
    color: var(--text2);
  }
  .wl-btn kbd,
  .wl-key kbd {
    font-family: var(--font-main);
    font-size: var(--px-11);
    font-weight: 500;
    padding: var(--px-1) var(--px-6);
    border-radius: var(--px-5);
    border: var(--px-1) solid var(--border);
    background: var(--panel);
    color: var(--text2);
  }
  .wl-stats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-28);
    padding-top: var(--px-16);
    border-top: var(--px-1) solid color-mix(in srgb, var(--primary) 14%, var(--border));
  }
  .wl-stat {
    display: flex;
    align-items: baseline;
    gap: var(--px-7);
    font-size: var(--px-13);
    color: var(--text2);
  }
  .wl-stat b {
    font-size: var(--px-22);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .wl-stat b.on {
    color: var(--sacc-green);
  }

  /* ---- two columns ------------------------------------------------------ */
  /* side column sits next to the cards and wraps under them when the editor
     area is narrow (flex-wrap: no breakpoint needed) */
  .wl-grid {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-24);
    align-items: flex-start;
  }
  .wl-main {
    flex: 999 1 var(--px-520);
    min-width: 0;
  }
  .wl-side {
    flex: 1 1 var(--px-268);
  }
  .wl-sec-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .wl-more {
    font-size: var(--px-12);
    color: var(--muted);
  }
  .wl-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--px-240), 1fr));
    gap: var(--px-12);
  }
  .wl-conn {
    position: relative;
    display: flex;
    border-radius: var(--px-12);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-xs);
    transition: transform 0.14s, box-shadow 0.14s, border-color 0.14s;
  }
  .wl-conn:hover {
    transform: translateY(calc(var(--px-2) * -1));
    box-shadow: var(--shadow-md);
    border-color: color-mix(in srgb, var(--acc, var(--primary)) 55%, var(--border));
  }
  .wl-conn-open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-14);
    border: none;
    background: transparent;
    text-align: left;
    color: var(--text);
    font-family: var(--font-main);
    cursor: pointer;
    border-radius: var(--px-12);
  }
  .wl-conn-ic {
    flex: none;
    width: var(--px-42);
    height: var(--px-42);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-10);
    background: color-mix(in srgb, var(--acc) 13%, var(--surface));
    border: var(--px-1) solid color-mix(in srgb, var(--acc) 26%, transparent);
  }
  .wl-conn-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
  }
  .wl-conn-name {
    font-size: var(--px-14);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wl-conn-meta {
    display: flex;
    align-items: center;
    gap: var(--px-7);
    font-size: var(--px-12);
    color: var(--muted);
  }
  .wl-env {
    font-size: var(--px-9_5);
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: var(--px-1) var(--px-6);
    border-radius: var(--px-4);
  }
  .wl-state {
    position: absolute;
    top: var(--px-10);
    right: var(--px-12);
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
    font-size: var(--px-11);
    font-weight: 500;
    color: var(--muted);
  }
  .wl-state::before {
    content: '';
    width: var(--px-6);
    height: var(--px-6);
    border-radius: 50%;
    background: var(--border2);
  }
  .wl-state.on {
    color: var(--sacc-green);
  }
  .wl-state.on::before {
    background: var(--sacc-green);
  }
  .wl-conn-q {
    position: absolute;
    right: var(--px-10);
    bottom: var(--px-10);
    width: var(--px-28);
    height: var(--px-28);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-8);
    border: var(--px-1) solid var(--border2);
    background: var(--raised);
    color: var(--text2);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s, color 0.12s, border-color 0.12s;
  }
  .wl-conn:hover .wl-conn-q,
  .wl-conn-q:focus-visible {
    opacity: 1;
  }
  .wl-conn-q:hover {
    color: var(--primary);
    border-color: var(--primary);
  }
  .wl-add {
    align-items: center;
    justify-content: center;
    gap: var(--px-8);
    min-height: var(--px-70);
    border-style: dashed;
    border-color: var(--border2);
    background: transparent;
    box-shadow: none;
    color: var(--text2);
    font-family: var(--font-main);
    font-size: var(--px-13);
    font-weight: 600;
    cursor: pointer;
  }
  .wl-add:hover {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 5%, transparent);
  }

  /* first run: three steps */
  .wl-steps {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--px-180), 1fr));
    gap: var(--px-12);
  }
  .wl-step {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--px-6);
    padding: var(--px-16);
    border-radius: var(--px-12);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
    font-size: var(--px-12_5);
    color: var(--text2);
    line-height: 1.45;
  }
  .wl-step b {
    font-size: var(--px-14);
    color: var(--text);
  }
  .wl-step-n {
    position: absolute;
    top: var(--px-12);
    right: var(--px-14);
    font-size: var(--px-22);
    font-weight: 700;
    color: color-mix(in srgb, var(--primary) 30%, transparent);
  }
  .wl-step-ic {
    width: var(--px-34);
    height: var(--px-34);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-9);
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }

  /* ---- side column ------------------------------------------------------ */
  .wl-side {
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
  }
  .wl-panel {
    padding: var(--px-16);
    border-radius: var(--px-12);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
  }
  .wl-keys {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
  }
  .wl-key {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--px-10);
    padding: var(--px-5) 0;
    font-size: var(--px-13);
    color: var(--text2);
  }
  .wl-tip {
    display: flex;
    gap: var(--px-12);
    background: color-mix(in srgb, var(--primary) 5%, var(--surface));
    border-color: color-mix(in srgb, var(--primary) 18%, var(--border));
  }
  .wl-tip > div {
    display: flex;
    flex-direction: column;
    gap: var(--px-3);
    font-size: var(--px-12_5);
    line-height: 1.45;
    color: var(--text2);
  }
  .wl-tip b {
    color: var(--text);
    font-size: var(--px-13);
  }
  .wl-tip-ic {
    flex: none;
    width: var(--px-30);
    height: var(--px-30);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-8);
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }

  /* ---- engines ---------------------------------------------------------- */
  .wl-works h2 {
    color: var(--muted);
    font-weight: 600;
    font-size: var(--px-12);
  }
  .wl-engines {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-8);
  }
  .wl-engine {
    display: inline-flex;
    align-items: center;
    gap: var(--px-7);
    height: var(--px-34);
    padding: 0 var(--px-12);
    border-radius: var(--px-20);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
    color: var(--text2);
    font-family: var(--font-main);
    font-size: var(--px-12_5);
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.12s, color 0.12s;
  }
  .wl-engine:hover {
    color: var(--text);
    border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  }
  @media (prefers-reduced-motion: reduce) {
    .wl-btn,
    .wl-conn {
      transition: none;
    }
    .wl-btn:hover,
    .wl-conn:hover {
      transform: none;
    }
  }
</style>
