<script lang="ts">
  // DuckDB workspace — the home of a DuckDB connection: what the file holds and
  // how big it is, the attached databases, extensions (install / load / update)
  // and engine settings (SET GLOBAL / RESET). Everything is read from DuckDB's own
  // catalog functions and changed with plain SQL over the normal query path, so
  // what the page shows is what the engine reports.
  import { onMount, untrack } from 'svelte'
  import '$lib/elastic/es.css'
  import '$lib/duckdb/duck.css'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import type { TabState } from '$lib/types'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { duckAttach, duckExport, duckImport } from '$lib/stores/duckdb.svelte'
  import { focusOnMount } from '$lib/elastic/actions'
  import { formatBytes } from '$lib/format/bytes'
  import {
    bool,
    checkpointStatement,
    COMMON_SETTINGS,
    DATABASES_SQL,
    detachStatement,
    EXTENSIONS_SQL,
    extensionStatements,
    extensionStatus,
    importDatabaseStatement,
    LARGEST_TABLES_SQL,
    MEMORY_SQL,
    num,
    OVERVIEW_SQL,
    parseSize,
    resetSettingStatement,
    setSettingStatement,
    SETTINGS_SQL,
    TEMP_FILES_SQL,
    type ExtensionAction,
  } from '$lib/duckdb/sql'
  import { duckRows, duckRun, duckRunAll, errorText } from '$lib/duckdb/run'

  type Section = 'overview' | 'databases' | 'extensions' | 'settings'
  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  const profile = $derived(connections.byId(connId))
  const section = $derived(((tab.state as { section?: Section }).section ?? 'overview') as Section)
  function setSection(s: Section) {
    ;(tab.state as Record<string, unknown>).section = s
    void loadSection(s)
  }

  interface Overview {
    version: string
    platform: string
    database: string
    schema: string
    threads: unknown
    memory_limit: string
    tables: unknown
    views: unknown
    est_rows: unknown
    extensions_loaded: unknown
  }
  interface DbRow {
    name: string
    path: string | null
    type: string
    readonly: unknown
    database_size: string | null
    wal_size: string | null
    block_size: unknown
    total_blocks: unknown
    used_blocks: unknown
    free_blocks: unknown
    memory_usage: string | null
    current: unknown
  }
  interface TableRow {
    database_name: string
    schema_name: string
    table_name: string
    estimated_size: unknown
    column_count: unknown
    index_count: unknown
  }
  interface MemRow {
    tag: string
    memory_usage_bytes: unknown
    temporary_storage_bytes: unknown
  }
  interface ExtRow {
    extension_name: string
    loaded: unknown
    installed: unknown
    install_path: string | null
    description: string | null
    aliases: unknown
    extension_version: string | null
    install_mode: string | null
    installed_from: string | null
  }
  interface SettingRow {
    name: string
    value: string | null
    description: string | null
    input_type: string | null
    scope: string | null
  }

  let overview = $state<Overview | null>(null)
  let databases = $state<DbRow[]>([])
  let largest = $state<TableRow[]>([])
  let memory = $state<MemRow[]>([])
  let tempFiles = $state<{ path: string; size: unknown }[]>([])
  let extensions = $state<ExtRow[] | null>(null)
  let settings = $state<SettingRow[] | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)

  async function loadOverview() {
    loading = true
    try {
      const [o, d, t, m, tf] = await Promise.all([
        duckRows<Overview>(connId, OVERVIEW_SQL),
        duckRows<DbRow>(connId, DATABASES_SQL),
        duckRows<TableRow>(connId, LARGEST_TABLES_SQL),
        duckRows<MemRow>(connId, MEMORY_SQL),
        duckRows<{ path: string; size: unknown }>(connId, TEMP_FILES_SQL).catch(() => []),
      ])
      overview = o[0] ?? null
      databases = d
      largest = t
      memory = m
      tempFiles = tf
      error = null
    } catch (e) {
      error = errorText(e)
    } finally {
      loading = false
    }
  }
  async function loadExtensions() {
    try {
      extensions = await duckRows<ExtRow>(connId, EXTENSIONS_SQL)
    } catch (e) {
      error = errorText(e)
    }
  }
  async function loadSettings() {
    try {
      settings = await duckRows<SettingRow>(connId, SETTINGS_SQL)
    } catch (e) {
      error = errorText(e)
    }
  }
  async function loadSection(s: Section) {
    if (s === 'extensions') await loadExtensions()
    else if (s === 'settings') await loadSettings()
    else await loadOverview()
  }
  let refreshing = $state(false)
  async function refresh() {
    if (refreshing) return
    refreshing = true
    try {
      await Promise.all([loadOverview(), section === 'extensions' ? loadExtensions() : null, section === 'settings' ? loadSettings() : null])
    } finally {
      refreshing = false
    }
  }

  onMount(() => {
    untrack(() => {
      void loadOverview()
      if (section === 'extensions') void loadExtensions()
      if (section === 'settings') void loadSettings()
    })
  })

  // a second "open" from a menu retargets the section
  let lastSection = ''
  $effect(() => {
    const s = section
    if (s !== lastSection) {
      lastSection = s
      untrack(() => {
        if (s === 'extensions' && !extensions) void loadExtensions()
        if (s === 'settings' && !settings) void loadSettings()
      })
    }
  })

  const isMemory = $derived(!profile?.sqlite_path || profile?.sqlite_mode === 'in-memory')
  const readOnly = $derived(profile?.sqlite_mode === 'read-only')
  const current = $derived(databases.find((d) => bool(d.current)))
  const attachedCount = $derived(databases.length)
  const memoryUsed = $derived(memory.reduce((a, m) => a + (num(m.memory_usage_bytes) ?? 0), 0))
  const memoryLimit = $derived(parseSize(overview?.memory_limit))
  const memRows = $derived(memory.filter((m) => (num(m.memory_usage_bytes) ?? 0) > 0 || (num(m.temporary_storage_bytes) ?? 0) > 0))
  const memMax = $derived(Math.max(1, ...memRows.map((m) => num(m.memory_usage_bytes) ?? 0)))
  const loadedCount = $derived(extensions ? extensions.filter((e) => bool(e.loaded)).length : num(overview?.extensions_loaded))

  function fmtCount(v: unknown): string {
    const n = num(v)
    return n === null ? '—' : n.toLocaleString()
  }
  function dbSize(d: DbRow): string {
    // pragma_database_size reports the file size; a new (never checkpointed) file
    // is still all WAL — show both so a "0 bytes" database is not a mystery
    return d.database_size ?? '—'
  }
  function blocksPct(d: DbRow): number | null {
    const total = num(d.total_blocks)
    const used = num(d.used_blocks)
    if (!total || used === null) return null
    return Math.round((used / total) * 100)
  }

  // ---- actions -------------------------------------------------------------
  async function connFor(database: string | null | undefined): Promise<string> {
    if (!database || database === current?.name) return connId
    return ipc.attachDatabase(connId, database)
  }
  async function openTable(t: TableRow) {
    try {
      tabs.openTableViewer(await connFor(t.database_name), t.schema_name, t.table_name)
    } catch (e) {
      toasts.error(errorText(e))
    }
  }
  function profileTable(t: TableRow) {
    tabs.openDuckProfile(connId, {
      kind: 'table',
      schema: t.schema_name,
      table: t.table_name,
      database: t.database_name === current?.name ? null : t.database_name,
    })
  }
  function newQuery(database?: string) {
    tabs.openSqlTab({ connectionId: connId, title: 'DuckDB query', ...(database && database !== current?.name ? { database } : {}) })
  }
  async function afterDatabasesChanged() {
    await loadOverview()
    explorer.invalidate(connId)
    void explorer.loadDatabases(connId, true)
    void explorer.refresh(connId, { kind: 'connection' })
  }
  function attach() {
    duckAttach.show(connId, () => void afterDatabasesChanged())
  }

  let busy = $state<string | null>(null)
  async function checkpoint(db?: string) {
    busy = `checkpoint:${db ?? ''}`
    try {
      await duckRun(connId, checkpointStatement(db ?? null))
      toasts.success(`Checkpoint done${db ? ` · ${db}` : ''} — the WAL was written into the database file`)
      await loadOverview()
    } catch (e) {
      toasts.error(errorText(e))
    } finally {
      busy = null
    }
  }

  let confirm = $state<{ title: string; body: string; sql: string; run: () => Promise<void> } | null>(null)
  let confirmBusy = $state(false)
  let confirmErr = $state<string | null>(null)
  function askDetach(d: DbRow) {
    confirmErr = null
    const sql = detachStatement(d.name)
    confirm = {
      title: `Detach ${d.name}`,
      body: 'The database is closed and removed from this connection. Its file stays on disk; you can attach it again later.',
      sql,
      run: async () => {
        await duckRun(connId, sql)
        toasts.success(`Detached ${d.name}`)
        await afterDatabasesChanged()
      },
    }
  }
  async function runConfirm() {
    if (!confirm || confirmBusy) return
    confirmBusy = true
    confirmErr = null
    try {
      await confirm.run()
      confirm = null
    } catch (e) {
      confirmErr = errorText(e)
    } finally {
      confirmBusy = false
    }
  }

  async function importDatabase() {
    let dir: string | null = null
    if (IS_TAURI) {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const r = await open({ directory: true, title: 'Folder written by EXPORT DATABASE' })
      dir = typeof r === 'string' ? r : null
    } else {
      dir = window.prompt('Folder written by EXPORT DATABASE')
    }
    if (!dir) return
    const sql = importDatabaseStatement(dir)
    confirmErr = null
    confirm = {
      title: 'Import database',
      body: 'Runs the folder’s schema.sql and load.sql into the current database. Objects that already exist with the same names make it fail.',
      sql,
      run: async () => {
        await duckRun(connId, sql)
        toasts.success('Database imported')
        await afterDatabasesChanged()
      },
    }
  }

  // ---- extensions ----------------------------------------------------------
  let extQuery = $state('')
  let extFilter = $state<'all' | 'loaded' | 'installed' | 'available'>('all')
  const extShown = $derived(
    (extensions ?? []).filter((e) => {
      const q = extQuery.trim().toLowerCase()
      if (q && !`${e.extension_name} ${e.description ?? ''}`.toLowerCase().includes(q)) return false
      const st = extensionStatus(e)
      if (extFilter === 'all') return true
      if (extFilter === 'installed') return st !== 'available'
      return st === extFilter
    }),
  )
  function builtIn(e: ExtRow): boolean {
    return (e.install_mode ?? '').toUpperCase() === 'STATICALLY_LINKED' || e.install_path === '(BUILT-IN)'
  }
  async function extAction(e: ExtRow, action: ExtensionAction) {
    busy = `ext:${e.extension_name}`
    try {
      await duckRunAll(connId, extensionStatements(action, e.extension_name))
      const verb = action === 'install' ? 'Installed' : action === 'load' ? 'Loaded' : action === 'update' ? 'Updated' : 'Installed and loaded'
      toasts.success(`${verb} ${e.extension_name}`)
      await loadExtensions()
      void loadOverview()
    } catch (err) {
      toasts.error(`${e.extension_name}: ${errorText(err)}`)
    } finally {
      busy = null
    }
  }

  // ---- settings ------------------------------------------------------------
  let setQuery = $state('')
  let setScope = $state<'common' | 'all'>('common')
  let edits = $state<Record<string, string>>({})
  const settingsShown = $derived.by(() => {
    const all = settings ?? []
    const q = setQuery.trim().toLowerCase()
    let list = q ? all.filter((s) => `${s.name} ${s.description ?? ''}`.toLowerCase().includes(q)) : all
    if (!q && setScope === 'common') {
      const order = new Map(COMMON_SETTINGS.map((n, i) => [n.toLowerCase(), i]))
      list = list.filter((s) => order.has(s.name.toLowerCase())).sort((a, b) => order.get(a.name.toLowerCase())! - order.get(b.name.toLowerCase())!)
    }
    return list
  })
  const pending = $derived(Object.entries(edits).filter(([n, v]) => v !== (settings?.find((s) => s.name === n)?.value ?? '')))
  function isBool(s: SettingRow): boolean {
    return (s.input_type ?? '').toUpperCase() === 'BOOLEAN'
  }
  function editValue(s: SettingRow): string {
    return edits[s.name] ?? s.value ?? ''
  }
  function setEdit(s: SettingRow, v: string) {
    edits = { ...edits, [s.name]: v }
  }
  let applying = $state(false)
  async function applySettings() {
    if (applying || !pending.length) return
    applying = true
    const failed: string[] = []
    for (const [name, value] of pending) {
      try {
        await duckRun(connId, setSettingStatement(name, value))
        const { [name]: _, ...rest } = edits
        edits = rest
      } catch (e) {
        failed.push(`${name}: ${errorText(e)}`)
      }
    }
    applying = false
    await loadSettings()
    void loadOverview()
    if (failed.length) toasts.error(failed.join('\n'))
    else toasts.success('Settings applied')
  }
  async function resetSetting(s: SettingRow) {
    busy = `set:${s.name}`
    try {
      await duckRun(connId, resetSettingStatement(s.name))
      const { [s.name]: _, ...rest } = edits
      edits = rest
      await loadSettings()
      void loadOverview()
      toasts.success(`${s.name} reset to its default`)
    } catch (e) {
      toasts.error(errorText(e))
    } finally {
      busy = null
    }
  }
</script>

<div class="es-page dk-page" data-testid="duckdb-home">
  <header class="es-header">
    <span class="dk-logo" aria-hidden="true"><SystemIcon system="duckdb" size={26} /></span>
    <div style="min-width:0">
      <div class="es-title">{profile?.name ?? 'DuckDB'}</div>
      <div class="es-sub" style="display:flex;gap:var(--px-8);align-items:center;flex-wrap:wrap">
        <span>{overview ? `DuckDB ${overview.version}` : 'DuckDB'}{overview?.platform ? ` · ${overview.platform}` : ''}</span>
        {#if isMemory}
          <span class="es-badge accent">In-memory</span>
        {:else}
          <span class="dk-path" style="max-width:var(--px-420)" title={profile?.sqlite_path}><bdi dir="ltr">{profile?.sqlite_path}</bdi></span>
        {/if}
        {#if readOnly}<span class="es-badge yellow">Read-only</span>{/if}
      </div>
    </div>
    <div class="es-header-actions">
      <button class="eg-btn" onclick={() => newQuery()}><Icon name="query" size={13} /> New query</button>
      {#if !readOnly}
        <button class="eg-btn" onclick={() => duckImport.show(connId, { schema: overview?.schema || 'main' })}><Icon name="upload" size={13} /> Import file</button>
      {/if}
      <button class="eg-btn" onclick={attach}><Icon name="link" size={13} /> Attach database</button>
      <button class="eg-btn" onclick={refresh} aria-busy={refreshing} title="Re-read everything from DuckDB">
        <span class:es-spin={refreshing} style="display:inline-flex"><Icon name="refresh" size={13} /></span>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  </header>

  <nav class="es-tabs" aria-label="DuckDB sections">
    <button class="es-tab" class:on={section === 'overview'} onclick={() => setSection('overview')}><Icon name="chart" size={13} /> Overview</button>
    <button class="es-tab" class:on={section === 'databases'} onclick={() => setSection('databases')}>
      <Icon name="database" size={13} /> Databases <span class="es-count">{attachedCount}</span>
    </button>
    <button class="es-tab" class:on={section === 'extensions'} onclick={() => setSection('extensions')}>
      <Icon name="puzzle" size={13} /> Extensions {#if loadedCount !== null}<span class="es-count">{loadedCount} loaded</span>{/if}
    </button>
    <button class="es-tab" class:on={section === 'settings'} onclick={() => setSection('settings')}><Icon name="sliders" size={13} /> Settings</button>
  </nav>

  <div class="es-body">
    {#if error}
      <div class="es-callout danger" style="margin-bottom:var(--px-14)" role="alert">
        <Icon name="warning" size={14} />
        <div style="min-width:0;flex:1"><b>DuckDB could not answer.</b> <span style="white-space:pre-wrap">{error}</span></div>
        <button class="eg-btn" onclick={refresh}>Retry</button>
      </div>
    {/if}

    {#if section === 'overview'}
      <div class="es-stats" data-testid="duckdb-stats">
        <div class="es-stat">
          <div class="es-stat-label">Database file</div>
          <div class="es-stat-value">{isMemory ? 'In memory' : current ? dbSize(current) : '—'}</div>
          <div class="es-stat-hint">{current?.wal_size && !isMemory ? `WAL ${current.wal_size}` : isMemory ? 'nothing is written to disk' : ' '}</div>
        </div>
        <div class="es-stat">
          <div class="es-stat-label">Memory</div>
          <div class="es-stat-value">{formatBytes(memoryUsed)}</div>
          <div class="es-stat-hint">of {overview?.memory_limit ?? '—'} limit</div>
          {#if memoryLimit}
            <div class="dk-meter blue" style="margin-top:var(--px-6)"><span style="width:{Math.min(100, (memoryUsed / memoryLimit) * 100)}%"></span></div>
          {/if}
        </div>
        <div class="es-stat">
          <div class="es-stat-label">Threads</div>
          <div class="es-stat-value">{overview ? String(overview.threads) : '—'}</div>
          <div class="es-stat-hint">worker threads</div>
        </div>
        <div class="es-stat">
          <div class="es-stat-label">Tables</div>
          <div class="es-stat-value">{fmtCount(overview?.tables)}</div>
          <div class="es-stat-hint">{fmtCount(overview?.views)} {num(overview?.views) === 1 ? 'view' : 'views'}</div>
        </div>
        <div class="es-stat">
          <div class="es-stat-label">Rows</div>
          <div class="es-stat-value">{fmtCount(overview?.est_rows)}</div>
          <div class="es-stat-hint">estimated, all tables</div>
        </div>
        <div class="es-stat">
          <div class="es-stat-label">Databases</div>
          <div class="es-stat-value">{attachedCount}</div>
          <div class="es-stat-hint">{fmtCount(overview?.extensions_loaded)} {num(overview?.extensions_loaded) === 1 ? 'extension' : 'extensions'} loaded</div>
        </div>
      </div>

      <div class="dk-grid" style="margin-top:var(--px-16)">
        <section class="es-card" aria-label="Largest tables">
          <div class="es-card-h">
            <Icon name="table" size={14} />
            <span class="es-card-title">Largest tables</span>
            <span class="es-help" style="margin:0 0 0 auto">estimated rows</span>
          </div>
          {#if largest.length}
            <table class="es-table">
              <thead><tr><th>Table</th><th class="num">Rows</th><th class="num">Cols</th><th></th></tr></thead>
              <tbody>
                {#each largest as t (`${t.database_name}.${t.schema_name}.${t.table_name}`)}
                  <tr>
                    <td style="max-width:var(--px-240)">
                      <span class="es-link es-ellipsis" role="button" tabindex="0" title="Open data" onclick={() => openTable(t)} onkeydown={(e) => e.key === 'Enter' && openTable(t)}>
                        {t.table_name}
                      </span>
                      <div class="es-help" style="margin:0">{t.database_name === current?.name ? t.schema_name : `${t.database_name}.${t.schema_name}`}</div>
                    </td>
                    <td class="num">{fmtCount(t.estimated_size)}</td>
                    <td class="num">{fmtCount(t.column_count)}</td>
                    <td style="text-align:right;white-space:nowrap">
                      <button class="eg-btn" onclick={() => profileTable(t)} title="Column statistics (SUMMARIZE)"><Icon name="chart" size={12} /> Profile</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <div class="es-empty">
              <div class="es-empty-title">No tables yet</div>
              Import a CSV, Parquet, JSON or Excel file to create one.
              {#if !readOnly}
                <div style="margin-top:var(--px-12)"><button class="eg-btn primary" onclick={() => duckImport.show(connId)}><Icon name="upload" size={13} /> Import file</button></div>
              {/if}
            </div>
          {/if}
        </section>

        <section class="es-card" aria-label="Memory by component">
          <div class="es-card-h">
            <Icon name="cpu" size={14} />
            <span class="es-card-title">Memory by component</span>
            <span class="es-help" style="margin:0 0 0 auto">{formatBytes(memoryUsed)} in use</span>
          </div>
          <div class="es-card-b" style="display:flex;flex-direction:column;gap:var(--px-8)">
            {#each memRows as m (m.tag)}
              <div style="display:grid;grid-template-columns:minmax(0,var(--px-160)) 1fr var(--px-80);gap:var(--px-10);align-items:center;font-size:var(--px-12)">
                <span class="es-ellipsis" title={m.tag}>{m.tag.toLowerCase().replace(/_/g, ' ')}</span>
                <div class="dk-meter"><span style="width:{((num(m.memory_usage_bytes) ?? 0) / memMax) * 100}%"></span></div>
                <span style="text-align:right;font-variant-numeric:tabular-nums">{formatBytes(num(m.memory_usage_bytes) ?? 0)}</span>
              </div>
            {:else}
              <div class="es-help" style="margin:0">Nothing is held in memory right now.</div>
            {/each}
            {#if tempFiles.length}
              <div class="es-callout warn" style="margin-top:var(--px-6)">
                <Icon name="info" size={14} />
                <div>{tempFiles.length} temporary file(s) spilled to disk ({formatBytes(tempFiles.reduce((a, f) => a + (num(f.size) ?? 0), 0))}) — a query needed more than the memory limit.</div>
              </div>
            {/if}
          </div>
        </section>

        <section class="es-card" aria-label="Work with files">
          <div class="es-card-h">
            <Icon name="file" size={14} />
            <span class="es-card-title">Work with files</span>
          </div>
          <div class="es-card-b" style="display:flex;flex-direction:column;gap:var(--px-10)">
            <p class="es-help" style="margin:0">DuckDB reads CSV, Parquet, JSON and Excel files directly — query them in place or load them into a table.</p>
            <div class="es-toolbar">
              {#if !readOnly}
                <button class="eg-btn primary" onclick={() => duckImport.show(connId, { schema: overview?.schema || 'main' })}><Icon name="upload" size={13} /> Import a file…</button>
              {/if}
              <button class="eg-btn" onclick={() => duckExport.show(connId, { kind: 'database', database: null })}><Icon name="download" size={13} /> Export database…</button>
              {#if !readOnly}
                <button class="eg-btn" onclick={importDatabase}><Icon name="folder" size={13} /> Import database…</button>
              {/if}
            </div>
            {#if !isMemory && !readOnly}
              <div style="display:flex;align-items:center;gap:var(--px-10);padding-top:var(--px-8);border-top:var(--px-1) solid var(--border)">
                <div style="flex:1;min-width:0">
                  <div style="font-size:var(--px-12_5);font-weight:600">Checkpoint</div>
                  <div class="es-help" style="margin:0">Writes the write-ahead log into the database file{current?.wal_size ? ` (WAL ${current.wal_size})` : ''}.</div>
                </div>
                <button class="eg-btn" disabled={busy === 'checkpoint:'} onclick={() => checkpoint()}><Icon name="check" size={13} /> Checkpoint</button>
              </div>
            {/if}
          </div>
        </section>
      </div>
    {:else if section === 'databases'}
      <section class="es-card">
        <div class="es-card-h">
          <Icon name="database" size={14} />
          <span class="es-card-title">Databases on this connection</span>
          <div class="es-toolbar" style="margin-left:auto">
            <button class="eg-btn primary" onclick={attach}><Icon name="link" size={13} /> Attach database…</button>
          </div>
        </div>
        <table class="es-table" data-testid="duckdb-databases">
          <thead>
            <tr><th>Name</th><th>Type</th><th>File</th><th>Access</th><th class="num">Size</th><th class="num">WAL</th><th>Blocks used</th><th></th></tr>
          </thead>
          <tbody>
            {#each databases as d (d.name)}
              {@const pct = blocksPct(d)}
              <tr>
                <td>
                  <span style="font-weight:600">{d.name}</span>
                  {#if bool(d.current)}<span class="es-badge accent" style="margin-left:var(--px-6)">current</span>{/if}
                </td>
                <td>{d.type}</td>
                <td style="max-width:var(--px-300)"><div class="dk-path" title={d.path ?? 'in memory'}><bdi dir="ltr">{d.path ?? 'in memory'}</bdi></div></td>
                <td>{#if bool(d.readonly)}<span class="es-badge yellow">read-only</span>{:else}<span class="es-badge green">read-write</span>{/if}</td>
                <td class="num">{dbSize(d)}</td>
                <td class="num">{d.wal_size ?? '—'}</td>
                <td style="min-width:var(--px-120)">
                  {#if pct !== null}
                    <div style="display:flex;align-items:center;gap:var(--px-8)"><div class="dk-meter" style="flex:1"><span style="width:{pct}%"></span></div><span class="es-help" style="margin:0">{pct}%</span></div>
                  {:else}
                    <span class="es-help" style="margin:0">—</span>
                  {/if}
                </td>
                <td style="text-align:right;white-space:nowrap">
                  <button class="eg-btn" onclick={() => newQuery(d.name)} title="New query in {d.name}"><Icon name="query" size={12} /> Query</button>
                  {#if !bool(d.readonly) && d.path}
                    <button class="eg-btn" disabled={busy === `checkpoint:${d.name}`} onclick={() => checkpoint(d.name)} title="Write the WAL into the file">Checkpoint</button>
                  {/if}
                  <button class="eg-btn" onclick={() => duckExport.show(connId, { kind: 'database', database: bool(d.current) ? null : d.name })} title="EXPORT DATABASE to a folder">
                    <Icon name="download" size={12} /> Export
                  </button>
                  {#if !bool(d.current)}
                    <button class="eg-btn ds-danger-outline" onclick={() => askDetach(d)} title="Close this database (the file is kept)"><Icon name="unlink" size={12} /> Detach</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div class="es-card-b es-help" style="margin:0">
          Attach other DuckDB files (or SQLite databases) to query and join across them. Attached databases stay open until you detach them or close the connection.
        </div>
      </section>
    {:else if section === 'extensions'}
      <div class="es-toolbar" style="margin-bottom:var(--px-12)">
        <div style="position:relative;flex:0 1 var(--px-340)">
          <input class="es-input" style="width:100%" placeholder="Search extensions…" bind:value={extQuery} aria-label="Search extensions" />
        </div>
        <div class="es-seg" role="group" aria-label="Filter extensions">
          {#each [['all', 'All'], ['loaded', 'Loaded'], ['installed', 'Installed'], ['available', 'Not installed']] as [id, label] (id)}
            <button class:on={extFilter === id} onclick={() => (extFilter = id as typeof extFilter)}>{label}</button>
          {/each}
        </div>
        <span class="es-help" style="margin:0 0 0 auto">{extShown.length} of {extensions?.length ?? 0}</span>
      </div>
      <div class="es-callout" style="margin-bottom:var(--px-12)">
        <Icon name="info" size={14} />
        <div>Built-in extensions are compiled into Database Studio. <b>Install</b> downloads an extension from the official DuckDB repository (needs internet); <b>Load</b> activates it for this connection.</div>
      </div>
      <section class="es-card">
        <table class="es-table" data-testid="duckdb-extensions">
          <thead><tr><th>Extension</th><th>Status</th><th>Version</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {#each extShown as e (e.extension_name)}
              {@const st = extensionStatus(e)}
              <tr data-ext={e.extension_name}>
                <td style="max-width:var(--px-420)">
                  <div style="font-weight:600;font-family:var(--font-mono);font-size:var(--px-12_5)">{e.extension_name}</div>
                  <div class="es-help es-ellipsis" style="margin:0" title={e.description ?? ''}>{e.description ?? ''}</div>
                </td>
                <td>
                  {#if st === 'loaded'}<span class="es-badge green">Loaded</span>
                  {:else if st === 'installed'}<span class="es-badge accent">Installed</span>
                  {:else}<span class="es-badge">Not installed</span>{/if}
                </td>
                <td class="mono" style="font-size:var(--px-12)">{e.extension_version || '—'}</td>
                <td>{builtIn(e) ? 'built-in' : (e.install_mode ?? '').toLowerCase().replace(/_/g, ' ') || '—'}</td>
                <td style="text-align:right;white-space:nowrap">
                  {#if busy === `ext:${e.extension_name}`}
                    <span class="es-help" style="margin:0"><span class="es-spin"><Icon name="refresh" size={12} /></span> working…</span>
                  {:else if st === 'available'}
                    <button class="eg-btn primary" onclick={() => extAction(e, 'install-load')}>Install & load</button>
                  {:else if st === 'installed'}
                    <button class="eg-btn primary" onclick={() => extAction(e, 'load')}>Load</button>
                    {#if !builtIn(e)}<button class="eg-btn" onclick={() => extAction(e, 'update')}>Update</button>{/if}
                  {:else if !builtIn(e)}
                    <button class="eg-btn" onclick={() => extAction(e, 'update')}>Update</button>
                  {/if}
                </td>
              </tr>
            {:else}
              <tr><td colspan="5"><div class="es-empty">{extensions ? 'No extension matches.' : 'Loading extensions…'}</div></td></tr>
            {/each}
          </tbody>
        </table>
      </section>
    {:else}
      <div class="es-toolbar" style="margin-bottom:var(--px-12)">
        <input class="es-input" style="flex:0 1 var(--px-340)" placeholder="Search settings…" bind:value={setQuery} aria-label="Search settings" />
        <div class="es-seg" role="group" aria-label="Which settings">
          <button class:on={setScope === 'common'} onclick={() => (setScope = 'common')}>Common</button>
          <button class:on={setScope === 'all'} onclick={() => (setScope = 'all')}>All ({settings?.length ?? 0})</button>
        </div>
        <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
          {#if pending.length}<span class="es-help" style="margin:0">{pending.length} unsaved change(s)</span>{/if}
          <button class="eg-btn" disabled={!pending.length || applying} onclick={() => (edits = {})}>Discard</button>
          <button class="eg-btn primary" disabled={!pending.length || applying} onclick={applySettings}>{applying ? 'Applying…' : 'Apply'}</button>
        </div>
      </div>
      <div class="es-callout" style="margin-bottom:var(--px-12)">
        <Icon name="info" size={14} />
        <div>Changes apply with <code>SET GLOBAL</code> to this DuckDB instance while it is open. They are not stored in the database file.</div>
      </div>
      <section class="es-card">
        <table class="es-table" data-testid="duckdb-settings">
          <thead><tr><th style="width:var(--px-240)">Setting</th><th>Value</th><th>Type</th><th></th></tr></thead>
          <tbody>
            {#each settingsShown as s (s.name)}
              {@const changed = edits[s.name] !== undefined && edits[s.name] !== (s.value ?? '')}
              <tr class:sel={changed} data-setting={s.name}>
                <td style="max-width:var(--px-420)">
                  <div style="font-family:var(--font-mono);font-size:var(--px-12_5);font-weight:600">{s.name}</div>
                  <div class="es-help" style="margin:0">{s.description ?? ''}</div>
                </td>
                <td style="min-width:var(--px-200)">
                  {#if isBool(s)}
                    <label class="dk-check">
                      <input type="checkbox" checked={editValue(s) === 'true'} onchange={(e) => setEdit(s, (e.currentTarget as HTMLInputElement).checked ? 'true' : 'false')} aria-label={s.name} />
                      {editValue(s) === 'true' ? 'on' : 'off'}
                    </label>
                  {:else}
                    <input class="es-input mono" style="width:100%" value={editValue(s)} oninput={(e) => setEdit(s, (e.currentTarget as HTMLInputElement).value)} aria-label={s.name} spellcheck="false" />
                  {/if}
                </td>
                <td><span class="es-badge">{(s.input_type ?? '').toLowerCase()}</span></td>
                <td style="text-align:right;white-space:nowrap">
                  <button class="eg-btn" disabled={busy === `set:${s.name}`} onclick={() => resetSetting(s)} title="RESET GLOBAL {s.name}">Reset</button>
                </td>
              </tr>
            {:else}
              <tr><td colspan="4"><div class="es-empty">{settings ? 'No setting matches.' : 'Loading settings…'}</div></td></tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  </div>
</div>

{#if confirm}
  <div class="es-modal-back dk-modal" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label={confirm.title} tabindex="-1" use:focusOnMount
      onkeydown={(e) => e.key === 'Escape' && !confirmBusy && (confirm = null)} style="width:min(var(--px-520),94vw)">
      <div class="es-modal-h"><span class="es-card-title">{confirm.title}</span></div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-10)">
        <div style="font-size:var(--px-13);line-height:1.5">{confirm.body}</div>
        <pre class="mono" style="margin:0;padding:var(--px-8) var(--px-10);background:var(--panel);border-radius:var(--px-6);font-size:var(--px-12);white-space:pre-wrap;word-break:break-all">{confirm.sql}</pre>
        {#if confirmErr}<div class="es-callout danger" role="alert"><div style="white-space:pre-wrap">{confirmErr}</div></div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="cfm-btn" disabled={confirmBusy} onclick={() => (confirm = null)}>Cancel</button>
        <button class="cfm-btn primary" disabled={confirmBusy} onclick={runConfirm}>{confirmBusy ? 'Working…' : 'Confirm'}</button>
      </div>
    </div>
  </div>
{/if}
