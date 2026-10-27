<script lang="ts">
  // New-connection picker — port 1:1 từ Database Studio.dc.html dòng 1580-1598
  // (lưới 3 cột, card icon 30 + label; connTypes dòng 5745).
  // Khác prototype: hệ chưa tới phase bị disable (mờ + tooltip) thay vì click được.
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import { CATEGORY_ORDER, SYSTEM_ORDER, systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import type { SystemType } from '$lib/types'
  import { FLAVOR_BRANDS, brandMeta, withFlavorBrands } from '$lib/brand'

  // Flavor brands have their own card: ScyllaDB (Cassandra engine, SPEC-SCYLLADB.md)
  // and Valkey (Redis engine, SPEC-VALKEY.md) create a profile of their engine that
  // starts with that brand.
  const PICKER_ORDER: string[] = withFlavorBrands(SYSTEM_ORDER)

  function pick(key: string) {
    const flavor = FLAVOR_BRANDS[key]
    if (flavor) {
      ui.pickerOpen = false
      ui.formQuick = ui.pickerQuick
      ui.formProfile = connections.makeBlankProfile(flavor.engine as SystemType, flavor.flavor)
      return
    }
    const system = key as SystemType
    if (!systemMeta(system).available) return
    ui.pickerOpen = false
    ui.formQuick = ui.pickerQuick
    ui.formProfile = connections.makeBlankProfile(system)
  }

  function close() {
    ui.pickerOpen = false
    ui.pickerQuick = false
    query = ''
  }

  // Grouped by what the engine is, each with one line on what it is for — reads
  // like a product catalogue, not a list of driver names.
  // four groups, so no section is a lone card
  const GROUP_OF: Record<string, string> = {
    RELATIONAL: 'Relational databases',
    ANALYTICAL: 'Analytics, NoSQL & search',
    'WIDE COLUMN': 'Analytics, NoSQL & search',
    DOCUMENT: 'Analytics, NoSQL & search',
    SEARCH: 'Analytics, NoSQL & search',
    CACHE: 'Analytics, NoSQL & search',
    STREAMING: 'Message brokers & streaming',
    EMBEDDED: 'Embedded / file-based',
  }
  const GROUPS = ['Relational databases', 'Analytics, NoSQL & search', 'Message brokers & streaming', 'Embedded / file-based']
  const DESC: Record<string, string> = {
    postgres: 'Open-source relational database',
    mysql: 'The most widely used open-source SQL database',
    mariadb: 'MySQL-compatible, community driven',
    mssql: 'Microsoft SQL Server and Azure SQL',
    oracle: 'Oracle Database — service name or SID',
    clickhouse: 'Columnar OLAP for fast analytics',
    cassandra: 'Distributed wide-column store (CQL)',
    scylladb: 'High-performance, Cassandra-compatible',
    mongodb: 'JSON document database',
    elasticsearch: 'Full-text search and analytics',
    opensearch: 'Open-source search and analytics, by the OpenSearch Foundation',
    redis: 'In-memory keys, hashes, streams',
    valkey: 'Open-source Redis fork by the Linux Foundation',
    kafka: 'Topics, partitions and consumer groups',
    redpanda: 'Kafka-compatible streaming, no ZooKeeper or JVM',
    ferretdb: 'Open-source MongoDB alternative on PostgreSQL',
    documentdb: 'MongoDB-compatible database service on AWS',
    nats: 'Subjects, JetStream, KV and objects',
    rabbitmq: 'Queues and exchanges (AMQP)',
    sqlite: 'A local database file',
    duckdb: 'In-process analytics on local files',
  }
  let query = $state('')
  const q = $derived(query.trim().toLowerCase())
  const visible = $derived(
    PICKER_ORDER.filter((k) => {
      if (!q) return true
      const m = brandMeta(k)
      return [m.label, k, DESC[k] ?? '', GROUP_OF[m.category ?? ''] ?? ''].some((t) => t.toLowerCase().includes(q))
    }),
  )
  const sections = $derived(
    GROUPS.map((group) => ({
      group,
      // keep the sidebar order of categories inside a group
      keys: CATEGORY_ORDER.flatMap((cat) => (GROUP_OF[cat] === group ? visible.filter((k) => brandMeta(k).category === cat) : [])),
    })).filter((sec) => sec.keys.length),
  )
  const focusOnMount = (node: HTMLInputElement) => node.focus()
</script>

{#if ui.pickerOpen}
  <!-- Backdrop-click does NOT close (use × or Escape) — consistent with the
       connection form, so the New Connection flow isn't dismissed accidentally. -->
  <div
    onkeydown={(e) => e.key === 'Escape' && close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:57"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div onclick={(e) => e.stopPropagation()} role="dialog" aria-label="New Connection" tabindex="-1" class="pk">
      <div class="pk-head">
        <div style="min-width:0;flex:1">
          <div class="pk-title">{ui.pickerQuick ? 'Quick Connect' : 'New Connection'}</div>
          <div class="pk-sub">{ui.pickerQuick ? 'One-off · not saved' : 'Choose database type'}</div>
        </div>
        <span onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0" aria-label="Close picker" class="pk-x">×</span>
      </div>

      <div class="pk-search-row">
        <div class="pk-search">
          <Icon name="search" size={14} />
          <input
            bind:value={query}
            placeholder="Search databases, caches and brokers…"
            aria-label="Search database types"
            spellcheck="false"
            use:focusOnMount
            onkeydown={(e) => {
              if (e.key === 'Enter' && visible.length === 1) pick(visible[0])
            }}
          />
        </div>
      </div>

      <div class="pk-body">
        {#each sections as sec (sec.group)}
          <div class="pk-section">
            <div class="pk-section-title">{sec.group}</div>
            <div class="pk-grid">
              {#each sec.keys as key (key)}
                {@const meta = brandMeta(key)}
                <div
                  onclick={() => pick(key)}
                  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick(key))}
                  role="button"
                  tabindex="0"
                  aria-disabled={!meta.available}
                  class="picker-card"
                  class:off={!meta.available}
                  style="--pk-accent:{meta.accent}"
                  title={meta.available ? meta.label : `${meta.label} — coming soon`}
                >
                  <span class="pk-icon"><SystemIcon system={key} size={26} /></span>
                  <span class="pk-text">
                    <span class="pk-name">{meta.label}</span>
                    <span class="pk-desc">{DESC[key] ?? ''}</span>
                  </span>
                </div>
              {/each}
            </div>
          </div>
        {:else}
          <div class="pk-empty">Nothing matches “{query.trim()}”.</div>
        {/each}
      </div>
      <!-- footer: Close button (same action as the × / Escape) -->
      <div class="pk-foot">
        <span class="pk-hint">{visible.length} type{visible.length === 1 ? '' : 's'}</span>
        <span onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0" class="cfm-btn">Close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .pk {
    /* 1200px: four cards a row, every description in full */
    width: min(calc(var(--px-600) * 2), 94vw);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-14);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    outline: none;
  }
  .pk-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-16) var(--px-20) var(--px-12);
  }
  .pk-title {
    font-size: var(--px-17);
    font-weight: 650;
    color: var(--text);
  }
  .pk-sub {
    font-size: var(--px-12_5);
    color: var(--muted);
    margin-top: var(--px-2);
  }
  .pk-x {
    flex: none;
    width: var(--px-28);
    height: var(--px-28);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-6);
    color: var(--muted);
    font-size: var(--px-20);
    cursor: pointer;
  }
  .pk-x:hover {
    background: var(--hover);
    color: var(--text);
  }
  .pk-search-row {
    flex: none;
    padding: 0 var(--px-20) var(--px-12);
    border-bottom: var(--px-1) solid var(--border);
  }
  .pk-search {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    height: var(--px-34);
    padding: 0 var(--px-12);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    color: var(--muted);
  }
  .pk-search:focus-within {
    border-color: var(--primary);
    box-shadow: 0 0 0 var(--px-3) var(--ring-soft);
    color: var(--primary);
  }
  .pk-search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0 !important;
    outline: 0;
    box-shadow: none !important;
    background: transparent;
    color: var(--text);
    font-size: var(--px-13);
    padding: 0;
  }
  .pk-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--px-14) var(--px-20) var(--px-16);
    display: flex;
    flex-direction: column;
    gap: var(--px-16);
    background: var(--bg);
  }
  .pk-section-title {
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
    margin-bottom: var(--px-8);
  }
  .pk-grid {
    display: grid;
    /* four columns at full width, fewer on a narrow window */
    grid-template-columns: repeat(auto-fill, minmax(min(var(--px-240), 100%), 1fr));
    gap: var(--px-10);
  }
  /* a card per engine: lifts toward you on hover, with its own accent */
  .picker-card {
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-12) var(--px-14);
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-12);
    box-shadow: var(--shadow-xs);
    cursor: pointer;
    min-width: 0;
    outline: none;
    transition:
      transform 0.14s ease,
      box-shadow 0.14s ease,
      border-color 0.14s ease,
      background-color 0.14s ease;
  }
  .picker-card:hover,
  .picker-card:focus-visible {
    transform: translateY(calc(-1 * var(--px-2)));
    box-shadow: var(--shadow-md);
    border-color: color-mix(in srgb, var(--pk-accent) 55%, var(--border2));
    background: color-mix(in srgb, var(--pk-accent) 5%, var(--surface));
  }
  .picker-card:focus-visible {
    box-shadow: var(--shadow-md), 0 0 0 var(--px-3) var(--ring-soft);
  }
  .picker-card:active {
    transform: translateY(0);
    box-shadow: var(--shadow-xs);
  }
  .picker-card.off {
    opacity: 0.45;
    cursor: not-allowed;
    transform: none !important;
  }
  .pk-icon {
    flex: none;
    width: var(--px-42);
    height: var(--px-42);
    border-radius: var(--px-10);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--pk-accent) 12%, var(--panel));
    transition: background-color 0.14s ease;
  }
  .picker-card:hover .pk-icon {
    background: color-mix(in srgb, var(--pk-accent) 20%, var(--panel));
  }
  .pk-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
  }
  .pk-name {
    font-size: var(--px-13_5);
    font-weight: 600;
    color: var(--text);
  }
  .pk-desc {
    font-size: var(--px-11_5);
    color: var(--muted);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .pk-empty {
    padding: var(--px-30);
    text-align: center;
    font-size: var(--px-13);
    color: var(--muted);
  }
  .pk-foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-12) var(--px-20);
    border-top: var(--px-1) solid var(--border);
    background: var(--panel);
  }
  .pk-hint {
    margin-right: auto;
    font-size: var(--px-12);
    color: var(--muted);
  }
  @media (prefers-reduced-motion: reduce) {
    .picker-card {
      transition: none;
    }
    .picker-card:hover {
      transform: none;
    }
  }
</style>
