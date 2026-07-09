<script lang="ts">
  // Objects tab — a pinned, non-closable singleton (see tabs.openObjectsTab) that
  // lists the tables of one database: # · Table Name · Data Length · Rows. Rows
  // select (blue) on click and highlight on hover; each row carries the SAME full
  // context menu the Object Explorer shows on a table (shared TableContextMenu).
  // Double-clicking a database name in the Explorer opens/retargets this tab; the
  // content refreshes when the target database changes. Data comes from the same
  // `list_tables` API the Explorer tree uses (no duplicate query).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import TableContextMenu from '$lib/components/explorer/TableContextMenu.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { systemMeta } from '$lib/systems'
  import { formatBytes } from '$lib/format/bytes'
  import type { SystemType, TabState, TableInfo } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const connId = $derived(tab.connectionId)
  const database = $derived((tab.state as { database?: string }).database ?? '')
  const schema = $derived((tab.state as { schema?: string | null }).schema ?? null)
  const profile = $derived(connections.byId(connId))
  const accent = $derived(systemMeta(tab.systemType).accent)
  // Systems where a "database" IS a schema (MySQL/MariaDB/ClickHouse) bind generated
  // SQL tabs to that schema-database; for PG/MSSQL the tab's connection already
  // targets the right database, so no extra binding is needed.
  const systemIsSchemaDb = $derived(
    tab.systemType === 'mysql' || tab.systemType === 'mariadb' || tab.systemType === 'clickhouse',
  )

  let rows = $state<TableInfo[]>([])
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let selIndex = $state<number | null>(null)
  let hoverIndex = $state<number | null>(null)
  // Guard against duplicate requests: re-loading only happens when the target
  // (connection, database, schema) actually changes — double-clicking the same
  // database again just re-activates the tab without re-fetching.
  let loadedKey = ''

  $effect(() => {
    const key = `${connId ?? ''}::${database}::${schema ?? ''}`
    if (key === loadedKey) return
    loadedKey = key
    untrack(() => void load(connId, database, schema))
  })

  async function load(cid: string | null, _db: string, sch: string | null) {
    selIndex = null
    if (!cid) {
      rows = []
      error = null
      return
    }
    loading = true
    error = null
    try {
      let list: TableInfo[]
      if (sch) {
        list = (await ipc.listTables(cid, sch)).map((t) => ({ ...t, schema: t.schema || sch }))
      } else {
        // No explicit schema (PG/MSSQL database) → every schema of the connection.
        const schemas = await ipc.listSchemas(cid)
        const perSchema = await Promise.all(
          schemas.map((s) =>
            ipc
              .listTables(cid, s.name)
              .then((ts) => ts.map((t) => ({ ...t, schema: t.schema || s.name })))
              .catch(() => [] as TableInfo[]),
          ),
        )
        list = perSchema.flat()
      }
      // Objects grid lists base tables (views/system objects excluded).
      rows = list.filter((t) => t.kind === 'table')
    } catch (e) {
      // Database disconnected / dropped while the tab is open → empty state, no crash.
      error = String(e)
      rows = []
    } finally {
      loading = false
    }
  }

  // Refresh rule: always re-query the backend (list_tables bypasses any cache),
  // show a spinning indicator, and guard against double-clicks. It does NOT touch
  // `loadedKey` — the target hasn't changed, so the dup-guard stays intact.
  async function refresh() {
    if (refreshing || !connId) return
    refreshing = true
    try {
      await load(connId, database, schema)
    } finally {
      refreshing = false
    }
  }

  // Double-clicking a row opens the table's data (same as the Explorer tree).
  function openRow(t: TableInfo) {
    if (connId) tabs.openTableViewer(connId, t.schema || schema || database, t.name)
  }

  // Row background: selected (blue, matches Result Grid --grid-select) > hovered >
  // zebra (odd rows tinted) for readability.
  function rowBg(i: number): string {
    if (selIndex === i) return 'var(--grid-select)'
    if (hoverIndex === i) return 'var(--hover)'
    return i % 2 === 1 ? 'var(--surface)' : 'transparent'
  }
  // Cell text colour: selected rows go white (on the blue selection); otherwise use
  // the per-column colour passed in.
  const cellColor = (i: number, base: string) => (selIndex === i ? 'var(--hex-fff)' : base)

  const GRID = 'display:grid;grid-template-columns:var(--px-56) 1fr var(--px-160) var(--px-110);align-items:center'
  // vertical column separator — gives the grid visible cell borders (a real table)
  const SEP = 'border-right:var(--px-1) solid var(--border)'
  // Result Grid's typographic rule (rule chung): JetBrains Mono via .mono + 12px +
  // tabular figures so numbers line up. Applied at the table root (inherited).
  const GRID_FONT = 'font-size:var(--px-12);font-variant-numeric:tabular-nums;font-feature-settings:\'tnum\' 1,\'zero\' 1'
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0;background:var(--bg)">
  <!-- header: connection + database (colored); the tab title already says "Objects" -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-9);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:{accent}"></span>
    <div style="display:flex;align-items:baseline;gap:var(--px-7);min-width:0" title={`${profile?.name ?? ''}${database ? ` / ${database}` : ''}${schema && schema !== database ? ` / ${schema}` : ''}`}>
      <span style="font-size:var(--px-13);font-weight:600;color:var(--text);white-space:nowrap">{profile?.name ?? '—'}</span>
      {#if database}
        <span style="font-size:var(--px-12);color:var(--muted)">/</span>
        <span class="mono" style="font-size:var(--px-13);font-weight:700;color:{accent};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{database}</span>
      {/if}
      {#if schema && schema !== database}
        <span style="font-size:var(--px-12);color:var(--muted)">/</span>
        <span class="mono" style="font-size:var(--px-13);font-weight:700;color:{accent};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{schema}</span>
      {/if}
    </div>
    <div style="margin-left:auto;display:flex;gap:var(--px-10);align-items:center">
      {#if rows.length}<span class="mono" style="font-size:var(--px-11);color:var(--muted)">{rows.length} table{rows.length === 1 ? '' : 's'}</span>{/if}
      <span
        onclick={refresh}
        onkeydown={(e) => e.key === 'Enter' && refresh()}
        role="button"
        tabindex="0"
        aria-busy={refreshing}
        aria-label="Refresh objects"
        title="Refresh"
        style="display:inline-flex;align-items:center;gap:var(--px-5);font-size:var(--px-12);font-weight:600;color:var(--text2);cursor:{refreshing ? 'default' : 'pointer'};opacity:{refreshing ? 0.6 : 1}"
      ><span class="refresh-glyph" class:spinning={refreshing}>⟳</span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
    </div>
  </div>

  <div style="flex:1;overflow:auto;min-height:0">
    {#if loading && rows.length === 0}
      <div style="padding:var(--px-24);color:var(--muted);font-size:var(--px-12_5)">Loading…</div>
    {:else if !connId}
      <div style="padding:var(--px-24);color:var(--muted);font-size:var(--px-12_5)">Not connected — this database is unavailable.</div>
    {:else if error && rows.length === 0}
      <div style="padding:var(--px-24);display:flex;flex-direction:column;gap:var(--px-6)">
        <span style="color:var(--muted);font-size:var(--px-12_5)">No tables to show{database ? ` for ${database}` : ''}.</span>
        <span class="mono" style="color:var(--muted);font-size:var(--px-11)">{error}</span>
      </div>
    {:else if rows.length === 0}
      <div style="padding:var(--px-24);color:var(--muted);font-size:var(--px-12_5)">This database has no tables.</div>
    {:else}
     <div role="table" aria-label="Database objects" class="mono" style="{GRID_FONT};border:var(--px-1) solid var(--border2);margin:var(--px-10)">
      <!-- header row (sticky) — same typographic treatment as the Result Grid header -->
      <div role="row" style="{GRID};position:sticky;top:0;z-index:1;background:var(--header);border-bottom:var(--px-1) solid var(--border2);font-weight:600;color:var(--text2)">
        <span role="columnheader" style="padding:var(--px-6) var(--px-10);text-align:right;{SEP}">#</span>
        <span role="columnheader" style="padding:var(--px-6) var(--px-12);{SEP}">Table Name</span>
        <span role="columnheader" style="padding:var(--px-6) var(--px-12);text-align:right;{SEP}">Data Length</span>
        <span role="columnheader" style="padding:var(--px-6) var(--px-12);text-align:right">Rows</span>
      </div>
      {#each rows as t, i (t.schema + '.' + t.name)}
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            <div
              role="row"
              tabindex="0"
              aria-selected={selIndex === i}
              onclick={() => (selIndex = i)}
              ondblclick={() => openRow(t)}
              onkeydown={(e) => {
                if (e.key === 'Enter') openRow(t)
                else selIndex = i
              }}
              onmouseenter={() => (hoverIndex = i)}
              onmouseleave={() => (hoverIndex === i ? (hoverIndex = null) : null)}
              style="{GRID};cursor:default;border-bottom:var(--px-1) solid var(--border);background:{rowBg(i)};outline:none"
            >
              <span role="cell" class="mono" style="padding:var(--px-5) var(--px-10);text-align:right;font-size:var(--px-10_5);color:{cellColor(i, 'var(--muted)')};{SEP}">{i + 1}</span>
              <span role="cell" class="mono" style="padding:var(--px-5) var(--px-12);color:{cellColor(i, 'var(--text)')};font-weight:{selIndex === i ? 600 : 500};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;{SEP}">{t.name}</span>
              <span role="cell" class="mono" style="padding:var(--px-5) var(--px-12);text-align:right;color:{cellColor(i, 'var(--syntax-number)')};{SEP}">{formatBytes(t.data_length)}</span>
              <span role="cell" class="mono" style="padding:var(--px-5) var(--px-12);text-align:right;color:{cellColor(i, 'var(--syntax-number)')}">{t.row_estimate != null ? t.row_estimate.toLocaleString() : '—'}</span>
            </div>
          </ContextMenu.Trigger>
          {#if connId}
            <TableContextMenu
              {connId}
              schema={t.schema || schema || database}
              table={t.name}
              system={tab.systemType as SystemType}
              locked={t.locked}
              engine={t.engine}
              database={systemIsSchemaDb ? t.schema || database : undefined}
              onRefresh={refresh}
            />
          {/if}
        </ContextMenu.Root>
      {/each}
     </div>
    {/if}
  </div>
</div>

<style>
  .refresh-glyph {
    display: inline-block;
    line-height: 1;
  }
  .refresh-glyph.spinning {
    animation: objects-refresh-spin 0.7s linear infinite;
  }
  @keyframes objects-refresh-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
