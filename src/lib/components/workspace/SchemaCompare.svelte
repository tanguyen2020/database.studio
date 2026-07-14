<script lang="ts">
  // Schema Compare (Phase 5 · T9) — port dòng 1353-1430. Chọn SOURCE/TARGET
  // (cùng system), diff cấu trúc (tables/columns), filter, migration SQL.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { splitStatements } from '$lib/sql/statements'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import SearchSelect from '$lib/components/SearchSelect.svelte'
  import {
    compareSchemas,
    diffCounts,
    genMigration,
    lineDiff,
    objectKey,
    columnKey,
    type CmpIndex,
    type CmpRoutine,
    type CmpTable,
    type ObjectDiff,
    type ObjectKind,
    type SchemaSnapshot,
  } from '$lib/compare/diff'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  // Every relational connection is selectable (item 2) — not only already-open ones;
  // a picked-but-closed connection is opened on demand in compare(). Non-relational
  // systems (Redis/Kafka/NATS) have no schema to compare, so they're excluded.
  const RELATIONAL = ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse', 'oracle']
  const options = $derived(connections.profiles.filter((p) => RELATIONAL.includes(p.system)))
  type CmpState = { srcConn?: string | null; tgtConn?: string | null; srcDb?: string | null; tgtDb?: string | null; presetTick?: number }
  const st0 = untrack(() => tab.state) as CmpState
  let srcConn = $state<string | null>(st0.srcConn ?? null)
  let tgtConn = $state<string | null>(st0.tgtConn ?? null)
  let mode = $state<'diff' | 'sync'>('diff')
  let showIdentical = $state(false)
  let filter = $state<'all' | 'different' | 'src_only' | 'tgt_only'>('all')
  let selected = $state<Set<string>>(new Set())
  let diffs = $state<ObjectDiff[]>([])
  let warn = $state<string | null>(null)
  let loading = $state(false)

  const srcProfile = $derived(connections.byId(srcConn))
  const tgtProfile = $derived(connections.byId(tgtConn))

  // Compare two databases — of different connections OR two databases within the
  // SAME connection (item 6). Picking a database attaches an internal sub-connection.
  let srcDb = $state<string | null>(st0.srcDb ?? null)
  let tgtDb = $state<string | null>(st0.tgtDb ?? null)
  let srcDbs = $state<string[]>([])
  let tgtDbs = $state<string[]>([])

  // Searchable dropdown option lists (connections + databases).
  const connOptions = $derived([
    { value: null as string | null, label: '—' },
    ...options.map((o) => ({ value: o.id as string | null, label: `${o.name} (${o.system})` })),
  ])
  const srcDbOptions = $derived([
    { value: null as string | null, label: srcProfile?.database || '(current)' },
    ...srcDbs.map((d) => ({ value: d as string | null, label: d })),
  ])
  const tgtDbOptions = $derived([
    { value: null as string | null, label: tgtProfile?.database || '(current)' },
    ...tgtDbs.map((d) => ({ value: d as string | null, label: d })),
  ])

  // Re-apply a new preset when the singleton tab is reopened (openSchemaCompare
  // bumps presetTick) — e.g. "Compare Databases…" from a database node.
  let lastTick = st0.presetTick ?? 0
  $effect(() => {
    const s = tab.state as CmpState
    if ((s.presetTick ?? 0) !== lastTick) {
      lastTick = s.presetTick ?? 0
      untrack(() => {
        srcConn = s.srcConn ?? null
        tgtConn = s.tgtConn ?? null
        srcDb = s.srcDb ?? null
        tgtDb = s.tgtDb ?? null
      })
    }
  })

  async function loadDbs(connId: string, system: string): Promise<string[]> {
    try {
      if (system === 'postgres' || system === 'mssql') return (await ipc.listDatabases(connId)).map((d) => d.name)
      if (system === 'mysql' || system === 'mariadb' || system === 'clickhouse' || system === 'oracle')
        return (await ipc.listSchemas(connId)).map((s) => s.name) // Oracle: schemas = users
      return []
    } catch {
      return []
    }
  }
  $effect(() => {
    const c = srcConn
    const sys = srcProfile?.system
    if (c && sys) untrack(() => void loadDbs(c, sys).then((d) => { srcDbs = d }))
    else srcDbs = []
  })
  $effect(() => {
    const c = tgtConn
    const sys = tgtProfile?.system
    if (c && sys) untrack(() => void loadDbs(c, sys).then((d) => { tgtDbs = d }))
    else tgtDbs = []
  })
  /** Resolve a connection+database pick to the (sub-)connection id to snapshot. */
  async function resolveId(connId: string, db: string | null): Promise<string> {
    return db ? await ipc.attachDatabase(connId, db) : connId
  }

  async function snapshot(connId: string): Promise<SchemaSnapshot> {
    const schemas = await ipc.listSchemas(connId).catch(() => [])
    const schema = schemas.find((s) => s.is_default)?.name ?? schemas[0]?.name ?? 'public'
    const tbls = await ipc.listTables(connId, schema).catch(() => [])
    const tables: CmpTable[] = []
    const indexes: CmpIndex[] = []
    // Per-table introspection is best-effort: a failure on one object must not wipe
    // the whole comparison (why some engines showed nothing before).
    for (const t of tbls.filter((x) => x.kind !== 'system')) {
      const cols = await ipc.listColumns(connId, schema, t.name).catch(() => [])
      tables.push({
        name: t.name,
        kind: (t.kind === 'view' ? 'view' : 'table') as 'table' | 'view',
        columns: cols.map((c) => ({ name: c.name, type: c.data_type, nullable: c.nullable, pk: c.is_pk })),
      })
      if (t.kind !== 'view') {
        // secondary indexes (skip the primary key — that's part of the table itself)
        const ix = await ipc.listIndexes(connId, schema, t.name).catch(() => [])
        for (const i of ix) if (!i.primary) indexes.push({ name: i.name, table: t.name, columns: i.columns, unique: i.unique })
      }
    }
    // ClickHouse: list_indexes returns nothing (its data-skipping indexes live in
    // system.data_skipping_indices) — pull them from the Index Scanner so the
    // comparison covers them. CH-only branch; every other engine is unaffected.
    if (connections.byId(connId)?.system === 'clickhouse') {
      const scan = await ipc.scanIndexes(connId, schema).catch(() => null)
      for (const i of scan?.indexes ?? []) {
        if (!i.primary) indexes.push({ name: i.name, table: i.table, columns: i.columns, unique: i.unique })
      }
    }
    // procedures / functions / triggers — compared by real DDL text.
    const routines: CmpRoutine[] = []
    const rs = await ipc.listRoutines(connId, schema).catch(() => [])
    for (const r of rs) {
      const kind: CmpRoutine['kind'] = r.kind === 'procedure' ? 'procedure' : 'function'
      const ddl = await ipc.objectDefinition(connId, schema, kind, r.name).catch(() => '')
      routines.push({ name: r.name, kind, ddl })
    }
    const tgs = await ipc.listTriggers(connId, schema).catch(() => [])
    for (const tg of tgs) {
      const ddl = await ipc.objectDefinition(connId, schema, 'trigger', tg.name).catch(() => '')
      routines.push({ name: tg.name, kind: 'trigger', ddl, table: tg.table })
    }
    const sequences = (await ipc.listSequences(connId, schema).catch(() => [])).map((s) => s.name)
    return { tables, routines, sequences, indexes }
  }

  /** Open a picked connection if it isn't already connected (item 2 — pick any
   *  relational connection, connect on demand). Returns false if it can't connect. */
  async function ensureConnected(id: string): Promise<boolean> {
    const p = connections.byId(id)
    if (!p) return false
    if (p.connected) return true
    return await connections.connect(id)
  }

  async function compare() {
    warn = null
    diffs = []
    if (!srcConn || !tgtConn) return
    if (srcProfile?.system !== tgtProfile?.system) {
      warn = `Cannot compare across engines: ${srcProfile?.system} vs ${tgtProfile?.system}. Pick two connections of the SAME type.`
      return
    }
    if (srcConn === tgtConn && (srcDb ?? '') === (tgtDb ?? '')) {
      warn = 'Source and target are the same database — pick two different databases (or connections).'
      return
    }
    loading = true
    try {
      if (!(await ensureConnected(srcConn)) || !(await ensureConnected(tgtConn))) {
        warn = 'Could not connect to the selected source/target connection.'
        return
      }
      const [srcId, tgtId] = await Promise.all([resolveId(srcConn, srcDb), resolveId(tgtConn, tgtDb)])
      const [s, t] = await Promise.all([snapshot(srcId), snapshot(tgtId)])
      diffs = compareSchemas(s, t)
      // pre-select every non-identical object AND every changed column
      const keys = diffs.filter((d) => d.status !== 'identical').map(objectKey)
      for (const d of diffs) {
        for (const c of d.columns) if (c.status !== 'identical') keys.push(columnKey(d.name, c.name))
      }
      selected = new Set(keys)
    } catch (e) {
      warn = String(e)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void srcConn
    void tgtConn
    void srcDb
    void tgtDb
    untrack(() => void compare())
  })

  const counts = $derived(diffCounts(diffs))
  // A diff row passes the current show-identical + status filter.
  function vis(d: ObjectDiff): boolean {
    if (!showIdentical && d.status === 'identical') return false
    return filter === 'all' || d.status === filter
  }
  // Indexes + triggers nest UNDER their owning table (idxTable); they are NOT shown
  // as their own top-level groups. Views/procedures/functions/sequences are schema-
  // level (no parent table) → their own groups.
  const indexDiffs = $derived(diffs.filter((d) => d.kind === 'index'))
  const triggerDiffs = $derived(diffs.filter((d) => d.kind === 'trigger'))
  const tableIndexes = (table: string) => indexDiffs.filter((d) => d.idxTable === table)
  const tableTriggers = (table: string) => triggerDiffs.filter((d) => d.idxTable === table)
  // A table shows if it itself changed OR any of its indexes/triggers changed.
  function tableVisible(t: ObjectDiff): boolean {
    return vis(t) || tableIndexes(t.name).some(vis) || tableTriggers(t.name).some(vis)
  }
  const KIND_GROUPS: { kind: ObjectKind; label: string }[] = [
    { kind: 'table', label: 'Tables' },
    { kind: 'view', label: 'Views' },
    { kind: 'procedure', label: 'Stored Procedures' },
    { kind: 'function', label: 'Functions' },
    { kind: 'sequence', label: 'Sequences' },
  ]
  // Per-type colour + glyph (matches the Object Explorer) so each object kind is easy
  // to tell apart at a glance. `column` is used for the nested Columns.
  const KIND_COLOR: Record<string, string> = {
    table: 'var(--hex-5b9bd5)', // blue
    view: 'var(--hex-b48ead)', // purple
    procedure: 'var(--hex-e8923a)', // orange
    function: 'var(--hex-e8c547)', // yellow
    trigger: 'var(--hex-e06c75)', // red
    index: 'var(--hex-56b6c2)', // cyan (was muted grey → now distinct)
    column: 'var(--hex-98c379)', // green (was muted → now distinct)
    sequence: 'var(--hex-d19a66)', // amber
  }
  const KIND_GLYPH: Record<string, string> = {
    table: '▦',
    view: '◫',
    procedure: '⚙',
    function: 'ƒ',
    trigger: '⚡',
    sequence: '#',
    index: '⌗',
    column: '▸',
  }
  const kindColor = (k: string) => KIND_COLOR[k] ?? 'var(--text2)'
  const kindGlyph = (k: string) => KIND_GLYPH[k] ?? '•'
  const grouped = $derived(
    KIND_GROUPS.map((g) => ({
      ...g,
      items: diffs.filter((d) => d.kind === g.kind && (g.kind === 'table' ? tableVisible(d) : vis(d))),
    })).filter((g) => g.items.length > 0),
  )
  let collapsedGroups = $state<Set<ObjectKind>>(new Set())
  function toggleGroupOpen(kind: ObjectKind) {
    const next = new Set(collapsedGroups)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    collapsedGroups = next
  }
  function groupAllSelected(items: ObjectDiff[]): boolean {
    return items.length > 0 && items.every((d) => selected.has(objectKey(d)))
  }
  function toggleGroup(items: ObjectDiff[]) {
    toggleKeys(items.map(objectKey))
  }
  // Select-all over an arbitrary list of selection keys (folder headers: columns,
  // indexes, triggers of a table) — "check nhanh".
  function keysAllSelected(keys: string[]): boolean {
    return keys.length > 0 && keys.every((k) => selected.has(k))
  }
  function toggleKeys(keys: string[]) {
    const all = keysAllSelected(keys)
    const next = new Set(selected)
    for (const k of keys) {
      if (all) next.delete(k)
      else next.add(k)
    }
    selected = next
  }
  const migration = $derived(srcProfile ? genMigration(diffs, srcProfile.system, selected) : '')

  function swap() {
    ;[srcConn, tgtConn] = [tgtConn, srcConn]
    ;[srcDb, tgtDb] = [tgtDb, srcDb]
  }
  function toggleSel(name: string) {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    selected = next
  }
  // Auto-expanded tree: a key present here is COLLAPSED (default = everything open),
  // so tables + their Columns/Indexes/Triggers folders show without manual clicking.
  let collapsedRows = $state<Set<string>>(new Set())
  const isRowOpen = (key: string) => !collapsedRows.has(key)
  function toggleRow(key: string) {
    const next = new Set(collapsedRows)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    collapsedRows = next
  }

  function openMigration() {
    if (!tgtConn) return
    const t = tabs.openSqlTab({ connectionId: tgtConn, title: 'Migration', query: migration })
    if (tgtDb) { t.state.database = tgtDb; tabs.schedulePersist() } // run against the chosen target DB
  }

  // Execute the migration directly against the TARGET (per-dialect: `migration`
  // is generated from the source system, which equals the target's — compare is
  // same-system). Runs each statement in order, stops on the first error.
  let executing = $state(false)
  const hasSql = (s: string) => s.split('\n').some((l) => l.trim() && !l.trim().startsWith('--'))
  async function execMigration() {
    if (!tgtConn || !migration.trim()) return
    if (!confirm(`Execute this migration against TARGET (${tgtProfile?.name}${tgtDb ? ` · ${tgtDb}` : ''})? This modifies the target database.`)) return
    executing = true
    try {
      const tid = await resolveId(tgtConn, tgtDb)
      const stmts = splitStatements(migration, tgtProfile?.system).map((s) => s.sql).filter(hasSql)
      if (stmts.length === 0) {
        toasts.error('Nothing to execute')
        return
      }
      let done = 0
      for (const sql of stmts) {
        const res = await ipc.execStatement(tid, sql, 0)
        if (!res.ok) {
          toasts.error(res.error?.message ?? 'Migration statement failed', tgtProfile?.system)
          break
        }
        done++
      }
      toasts.success(`Executed ${done}/${stmts.length} statement(s) on ${tgtProfile?.name}`, tgtProfile?.system)
      await compare() // re-diff to show convergence
    } catch (e) {
      toasts.error(String(e), tgtProfile?.system)
    } finally {
      executing = false
    }
  }

  // T19 — side-by-side DDL diff panel (routine/trigger) + prev/next điều hướng.
  let selDiff = $state<ObjectDiff | null>(null)
  // Persistent row selection highlight (independent of the DDL modal, which closes
  // and would otherwise clear any selection). Any clicked diff row stays highlighted.
  let selRow = $state<string | null>(null)
  const ddlDiffs = $derived(diffs.filter((d) => (d.srcDdl != null || d.tgtDdl != null) && vis(d)))
  const ddlLines = $derived(selDiff ? lineDiff(selDiff.tgtDdl ?? '', selDiff.srcDdl ?? '') : [])
  function stepDiff(delta: number) {
    if (!ddlDiffs.length) return
    const i = selDiff ? ddlDiffs.findIndex((d) => d.kind === selDiff!.kind && d.name === selDiff!.name) : -1
    const next = (i + delta + ddlDiffs.length) % ddlDiffs.length
    selDiff = ddlDiffs[next]
  }

  const statusMeta: Record<string, { label: string; color: string; icon: string }> = {
    identical: { label: 'Identical', color: '#6b7486', icon: '●' },
    different: { label: 'Different', color: '#f0a020', icon: '≠' },
    src_only: { label: 'Src only', color: '#27AE60', icon: '＋' },
    tgt_only: { label: 'Tgt only', color: '#e06c75', icon: '－' },
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- toolbar -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-11_5);font-weight:700">Structure</span>
    <span style="font-size:var(--px-10_5);color:var(--muted);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-7)">tables · views · columns — data is not compared</span>
    <span style="font-size:var(--px-11);color:var(--muted);font-weight:600">SOURCE</span>
    <SearchSelect bind:value={srcConn} options={connOptions} title="Source connection" placeholder="— pick connection —" />
    {#if srcDbs.length}
      <SearchSelect bind:value={srcDb} options={srcDbOptions} title="Source database" />
    {/if}
    <span onclick={swap} onkeydown={(e) => e.key === 'Enter' && swap()} role="button" tabindex="0" title="Swap" style="cursor:pointer;color:var(--text2);font-size:var(--px-15)">⇄</span>
    <span style="font-size:var(--px-11);color:var(--muted);font-weight:600">TARGET</span>
    <SearchSelect bind:value={tgtConn} options={connOptions} title="Target connection" placeholder="— pick connection —" />
    {#if tgtDbs.length}
      <SearchSelect bind:value={tgtDb} options={tgtDbOptions} title="Target database" />
    {/if}
    <div style="display:flex;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden;margin-left:var(--px-8)">
      <span onclick={() => (mode = 'diff')} onkeydown={(e) => e.key === 'Enter' && (mode = 'diff')} role="button" tabindex="0" style="padding:var(--px-5) var(--px-13);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{mode === 'diff' ? 'var(--primary)' : 'transparent'};color:{mode === 'diff' ? 'var(--hex-fff)' : 'var(--text2)'}">Diff</span>
      <span onclick={() => (mode = 'sync')} onkeydown={(e) => e.key === 'Enter' && (mode = 'sync')} role="button" tabindex="0" style="padding:var(--px-5) var(--px-13);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{mode === 'sync' ? 'var(--primary)' : 'transparent'};color:{mode === 'sync' ? 'var(--hex-fff)' : 'var(--text2)'};border-left:var(--px-1) solid var(--border)">Sync Script</span>
    </div>
  </div>

  {#if warn}
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--px-10);color:var(--muted);padding:var(--px-30)">
      <span style="font-size:var(--px-26);color:#f0a020">⚠</span>
      <div style="font-size:var(--px-13);max-width:var(--px-420);text-align:center;line-height:1.5">{warn}</div>
    </div>
  {:else if !srcConn || !tgtConn}
    <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:var(--px-12_5)">Pick SOURCE and TARGET (same engine type) to compare.</div>
  {:else if loading}
    <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:var(--px-12_5)">Comparing…</div>
  {:else if mode === 'diff'}
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-14);padding:var(--px-8) var(--px-14);border-bottom:var(--px-1) solid var(--border)">
      <span style="font-size:var(--px-11_5);font-weight:700;color:var(--hex-fff);background:#27AE60;border-radius:var(--px-4);padding:var(--px-2) var(--px-8)">＋ {counts.add} add</span>
      <span style="font-size:var(--px-11_5);font-weight:700;color:var(--hex-fff);background:#f0a020;border-radius:var(--px-4);padding:var(--px-2) var(--px-8)">≠ {counts.changed} changed</span>
      <span style="font-size:var(--px-11_5);font-weight:700;color:var(--hex-fff);background:#e06c75;border-radius:var(--px-4);padding:var(--px-2) var(--px-8)">－ {counts.del} delete</span>
      <select bind:value={filter} style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);font-size:var(--px-11);color:var(--text)">
        <option value="all">All</option>
        <option value="different">Different</option>
        <option value="src_only">Src only</option>
        <option value="tgt_only">Tgt only</option>
      </select>
      <div style="margin-left:auto;display:flex;align-items:center;gap:var(--px-10)">
        <label style="display:flex;align-items:center;gap:var(--px-6);font-size:var(--px-11_5);color:var(--text2);cursor:pointer">
          <input type="checkbox" bind:checked={showIdentical} /> Show identical
        </label>
        <span onclick={() => compare()} onkeydown={(e) => e.key === 'Enter' && compare()} role="button" tabindex="0" title="Re-run the comparison (re-read both schemas)" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-11);cursor:pointer;font-weight:600;color:var(--text2);opacity:{loading ? 0.6 : 1};pointer-events:{loading ? 'none' : 'auto'}">⟳ Refresh</span>
        <!-- item 1/2 — Execute (and Open in editor) are available in the Diff view too,
             acting on the selected objects' migration, same as the Sync Script view. -->
        <span onclick={openMigration} onkeydown={(e) => e.key === 'Enter' && openMigration()} role="button" tabindex="0" title="Open the migration in a SQL editor tab" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-11);cursor:pointer;font-weight:600;opacity:{selected.size ? 1 : 0.5};pointer-events:{selected.size ? 'auto' : 'none'}">Open script</span>
        <span onclick={execMigration} onkeydown={(e) => e.key === 'Enter' && execMigration()} role="button" tabindex="0" title="Run this migration on the target now" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-13);cursor:pointer;font-weight:600;opacity:{executing || !selected.size ? 0.6 : 1};pointer-events:{executing || !selected.size ? 'none' : 'auto'}">{executing ? 'Executing…' : 'Execute'}</span>
      </div>
    </div>
    <div style="flex:1;overflow:auto;min-height:0">
      <div style="display:flex;font-size:var(--px-10);color:var(--muted);font-weight:700;text-transform:uppercase;border-bottom:var(--px-1) solid var(--border2);position:sticky;top:0;background:var(--header)">
        <span style="flex:1;padding:var(--px-7) var(--px-14)">Origin · {srcProfile?.name}</span>
        <span style="flex:1;padding:var(--px-7) var(--px-14)">Target · {tgtProfile?.name}</span>
      </div>
      <!-- a folder header under a table (Columns / Indexes / Triggers) with a
           select-all checkbox for its items ("check nhanh") + per-type colour -->
      {#snippet folderRow(fkey: string, label: string, kind: string, keys: string[])}
        {@const fopen = isRowOpen(fkey)}
        <div
          onclick={() => toggleRow(fkey)}
          onkeydown={(e) => e.key === 'Enter' && toggleRow(fkey)}
          role="button"
          tabindex="0"
          style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-5) var(--px-14) var(--px-5) var(--px-40);background:var(--header);border-top:var(--px-1) solid var(--border2);border-bottom:var(--px-1) solid var(--border2);box-shadow:inset var(--px-3) 0 0 {kindColor(kind)};cursor:pointer"
        >
          <span class="mono" style="width:var(--px-10);color:{kindColor(kind)};font-size:var(--px-9)">{fopen ? '▾' : '▸'}</span>
          <input type="checkbox" title="Select all in {label}" checked={keysAllSelected(keys)} onchange={() => toggleKeys(keys)} onclick={(e) => e.stopPropagation()} />
          <span class="mono" style="font-size:var(--px-12);color:{kindColor(kind)}">{kindGlyph(kind)}</span>
          <span style="font-size:var(--px-11);font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:{kindColor(kind)}">{label}</span>
          <span class="mono" style="font-size:var(--px-9_5);font-weight:700;color:{kindColor(kind)};opacity:.75">{keys.length}</span>
        </div>
      {/snippet}
      <!-- a nested index/trigger row shown UNDER its table folder (checkbox + status;
           a trigger is clickable → side-by-side DDL diff) -->
      {#snippet nestedObj(d: ObjectDiff)}
        {@const sm = statusMeta[d.status]}
        {@const hasDdl = d.srcDdl != null || d.tgtDdl != null}
        {@const nk = objectKey(d)}
        <div
          class="cmp-row cmp-panel"
          class:sel={selRow === nk}
          style="display:flex;align-items:stretch;border-bottom:var(--px-1) solid var(--border);cursor:pointer"
          onclick={() => { selRow = nk; if (hasDdl) selDiff = d }}
          onkeydown={(e) => e.key === 'Enter' && (selRow = nk, hasDdl && (selDiff = d))}
          role="button"
          tabindex="0"
          title={hasDdl ? 'View DDL diff' : ''}
        >
          <div style="flex:1;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-4) var(--px-14) var(--px-4) var(--px-80);box-shadow:inset var(--px-3) 0 0 {sm.color};font-size:var(--px-11_5)">
            <input type="checkbox" checked={selected.has(nk)} onchange={() => toggleSel(nk)} onclick={(e) => e.stopPropagation()} />
            <span class="mono" style="font-size:var(--px-10);color:{kindColor(d.kind)}">{kindGlyph(d.kind)}</span>
            <span class="mono" style="color:{d.status === 'tgt_only' ? 'var(--muted)' : 'var(--text2)'}">{d.status === 'tgt_only' ? '—' : d.name}</span>
          </div>
          <div style="flex:1;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-4) var(--px-14);font-size:var(--px-11_5)">
            <span class="mono" style="color:{d.status === 'src_only' ? 'var(--muted)' : 'var(--text2)'}">{d.status === 'src_only' ? '—' : d.name}</span>
            <span style="margin-left:auto;font-size:var(--px-9_5);font-weight:700;color:var(--hex-fff);background:{sm.color};border-radius:var(--px-4);padding:var(--px-1) var(--px-6)">{sm.icon}</span>
          </div>
        </div>
      {/snippet}
      {#each grouped as group (group.kind)}
        {@const gkey = `grp:${group.kind}`}
        {@const gOpen = !collapsedGroups.has(group.kind)}
        <!-- object-type group header (Tables / Views / Stored Procedures / …) with a
             select-all checkbox for the whole group -->
        <div style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-14);background:var(--hover);border-top:var(--px-1) solid var(--border2);border-bottom:var(--px-1) solid var(--border2);box-shadow:inset var(--px-3) 0 0 {kindColor(group.kind)};position:sticky;top:var(--px-30);z-index:2">
          <span onclick={() => toggleGroupOpen(group.kind)} onkeydown={(e) => e.key === 'Enter' && toggleGroupOpen(group.kind)} role="button" tabindex="0" class="mono" style="width:var(--px-10);color:{kindColor(group.kind)};font-size:var(--px-10);cursor:pointer">{gOpen ? '▾' : '▸'}</span>
          <input type="checkbox" title="Select all in this group" checked={groupAllSelected(group.items)} onchange={() => toggleGroup(group.items)} />
          <span class="mono" style="font-size:var(--px-13);color:{kindColor(group.kind)}">{kindGlyph(group.kind)}</span>
          <span style="font-size:var(--px-12);font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:{kindColor(group.kind)}">{group.label}</span>
          <span class="mono" style="font-size:var(--px-10);font-weight:700;color:{kindColor(group.kind)};opacity:.75">{group.items.length}</span>
        </div>
        {#if gOpen}
          {#each group.items as d (gkey + ':' + d.name + ':' + (d.idxTable ?? ''))}
            {@const sm = statusMeta[d.status]}
            {@const hasDdl = d.srcDdl != null || d.tgtDdl != null}
            {@const dkey = objectKey(d)}
            {@const colChanges = d.columns.filter((c) => c.status !== 'identical')}
            {@const colRows = showIdentical ? d.columns : colChanges}
            {@const tblIdx = d.kind === 'table' ? tableIndexes(d.name).filter(vis) : []}
            {@const tblTrg = d.kind === 'table' ? tableTriggers(d.name).filter(vis) : []}
            {@const childCount = tblIdx.length + tblTrg.length}
            {@const colKeys = colChanges.map((c) => columnKey(d.name, c.name))}
            {@const hasChildren = colRows.length > 0 || childCount > 0}
            {@const expandable = hasDdl || hasChildren}
            {@const isOpen = isRowOpen(dkey)}
            <div
              class="cmp-row"
              class:sel={selRow === dkey}
              style="display:flex;align-items:stretch;border-bottom:var(--px-1) solid var(--border);cursor:pointer"
              onclick={() => { selRow = dkey; if (hasDdl) selDiff = d; else if (hasChildren) toggleRow(dkey) }}
              onkeydown={(e) => e.key === 'Enter' && (selRow = dkey, hasDdl ? (selDiff = d) : hasChildren && toggleRow(dkey))}
              role="button"
              tabindex="0"
              title={hasDdl ? 'View DDL diff' : hasChildren ? 'Show columns / indexes / triggers' : ''}
            >
              <div style="flex:1;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-14) var(--px-7) var(--px-26);box-shadow:inset var(--px-3) 0 0 {sm.color}">
                <span class="mono" style="width:var(--px-10);color:var(--muted);font-size:var(--px-9)">{hasChildren && !hasDdl ? (isOpen ? '▾' : '▸') : ''}</span>
                <!-- every object is selectable (including drops / tgt_only) -->
                <input type="checkbox" checked={selected.has(dkey)} onchange={() => toggleSel(dkey)} onclick={(e) => e.stopPropagation()} />
                <span class="mono" style="font-size:var(--px-11);color:{kindColor(d.kind)}">{kindGlyph(d.kind)}</span>
                <span class="mono" style="font-size:var(--px-12_5);font-weight:600;color:{d.status === 'tgt_only' ? 'var(--muted)' : 'var(--text)'}">{d.status === 'tgt_only' ? '—' : d.name}</span>
                {#if colChanges.length}<span style="font-size:var(--px-9_5);color:var(--warn)">{colChanges.length} col Δ</span>{/if}
                {#if childCount}<span style="font-size:var(--px-9_5);color:var(--muted)">{tblIdx.length} idx · {tblTrg.length} trg</span>{/if}
              </div>
              <div style="flex:1;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-14)">
                <span class="mono" style="font-size:var(--px-12_5);font-weight:600;color:{d.status === 'src_only' ? 'var(--muted)' : 'var(--text)'}">{d.status === 'src_only' ? '—' : d.name}</span>
                <span style="margin-left:auto;font-size:var(--px-10);font-weight:700;color:var(--hex-fff);background:{sm.color};border-radius:var(--px-4);padding:var(--px-1) var(--px-7)">{sm.icon} {sm.label}</span>
              </div>
            </div>
            {#if isOpen && !hasDdl}
              <!-- table children as folders: Columns / Indexes / Triggers (only
                   non-empty folders shown — no empty database defaults). -->
              {#if colRows.length}
                {@const fkey = dkey + ':columns'}
                {@render folderRow(fkey, 'Columns', 'column', colKeys)}
                {#if isRowOpen(fkey)}
                  {#each colRows as c (c.name)}
                    {@const csm = statusMeta[c.status]}
                    {@const ck = columnKey(d.name, c.name)}
                    {@const changed = c.status !== 'identical'}
                    <div
                      class="cmp-row cmp-panel"
                      class:sel={selRow === ck}
                      style="display:flex;align-items:stretch;border-bottom:var(--px-1) solid var(--border);font-size:var(--px-11_5);cursor:pointer"
                      onclick={() => (selRow = ck)}
                      onkeydown={(e) => e.key === 'Enter' && (selRow = ck)}
                      role="button"
                      tabindex="0"
                    >
                      <div class="mono" style="flex:1;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-4) var(--px-14) var(--px-4) var(--px-80);box-shadow:inset var(--px-3) 0 0 {csm.color}">
                        <!-- each column is checkable (only changed columns drive the migration) -->
                        <input type="checkbox" checked={selected.has(ck)} disabled={!changed} onchange={() => toggleSel(ck)} onclick={(e) => e.stopPropagation()} />
                        <span class="mono" style="color:{kindColor('column')};font-size:var(--px-10)">{kindGlyph('column')}</span>
                        <span style="color:{c.status === 'tgt_only' ? 'var(--muted)' : 'var(--text2)'}">{c.status === 'tgt_only' ? '—' : c.name}</span>
                        {#if c.srcType}<span style="color:var(--muted)">{c.srcType}</span>{/if}
                      </div>
                      <div class="mono" style="flex:1;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-4) var(--px-14)">
                        <span style="color:{c.status === 'src_only' ? 'var(--muted)' : 'var(--text2)'}">{c.status === 'src_only' ? '—' : c.name}</span>
                        {#if c.tgtType}<span style="color:var(--muted)">{c.tgtType}</span>{/if}
                        <span style="margin-left:auto;color:{csm.color};font-weight:700">{csm.icon}</span>
                      </div>
                    </div>
                  {/each}
                {/if}
              {/if}
              {#if tblIdx.length}
                {@const fkey = dkey + ':indexes'}
                {@render folderRow(fkey, 'Indexes', 'index', tblIdx.map(objectKey))}
                {#if isRowOpen(fkey)}
                  {#each tblIdx as ix (objectKey(ix))}{@render nestedObj(ix)}{/each}
                {/if}
              {/if}
              {#if tblTrg.length}
                {@const fkey = dkey + ':triggers'}
                {@render folderRow(fkey, 'Triggers', 'trigger', tblTrg.map(objectKey))}
                {#if isRowOpen(fkey)}
                  {#each tblTrg as tg (objectKey(tg))}{@render nestedObj(tg)}{/each}
                {/if}
              {/if}
            {/if}
          {/each}
        {/if}
      {/each}
    </div>
  {:else}
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-8) var(--px-14);border-bottom:var(--px-1) solid var(--border)">
      <span style="font-size:var(--px-11_5);color:var(--muted)">Migration to sync TARGET ({tgtProfile?.name}) to SOURCE — {selected.size} object(s) selected</span>
      <span onclick={() => compare()} onkeydown={(e) => e.key === 'Enter' && compare()} role="button" tabindex="0" title="Re-run the comparison (re-read both schemas)" style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600;color:var(--text2);opacity:{loading ? 0.6 : 1};pointer-events:{loading ? 'none' : 'auto'}">⟳ Refresh</span>
      <span onclick={openMigration} onkeydown={(e) => e.key === 'Enter' && openMigration()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">Open in editor</span>
      <span onclick={execMigration} onkeydown={(e) => e.key === 'Enter' && execMigration()} role="button" tabindex="0" title="Run this migration on the target now" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-5) var(--px-14);cursor:pointer;font-weight:600;opacity:{executing ? 0.6 : 1}">{executing ? 'Executing…' : 'Execute'}</span>
    </div>
    <div style="flex:1;overflow:auto;background:var(--bg)">
      <!-- syntax-coloured migration (keywords / strings / comments) for readability -->
      <pre class="selectable mono" style="margin:0;padding:var(--px-16) var(--px-18);font-size:var(--px-12_5);line-height:1.6;white-space:pre;color:var(--text)">{#each highlightSql(migration) as t}<span style="color:{sqlTokenColor(t.kind)}">{t.text}</span>{/each}</pre>
    </div>
  {/if}

  <!-- T19 — side-by-side DDL diff panel (routine/trigger) -->
  {#if selDiff}
    <div onkeydown={(e) => e.key === 'Escape' && (selDiff = null)} role="presentation" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:56">
      <div onclick={(e) => e.stopPropagation()} onkeydown={() => {}} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-900);max-width:96vw;height:80vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-12);box-shadow:0 var(--px-30) var(--px-70) rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden">
        <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-12) var(--px-16);border-bottom:var(--px-1) solid var(--border)">
          <span class="mono" style="font-size:var(--px-8);font-weight:700;color:var(--muted);border:var(--px-1) solid var(--border2);border-radius:var(--px-3);padding:var(--px-1) var(--px-4)">{selDiff.kind}</span>
          <span class="mono" style="font-size:var(--px-14);font-weight:700">{selDiff.name}</span>
          <span style="font-size:var(--px-10);font-weight:700;color:var(--hex-fff);background:{statusMeta[selDiff.status].color};border-radius:var(--px-4);padding:var(--px-1) var(--px-7)">{statusMeta[selDiff.status].icon} {statusMeta[selDiff.status].label}</span>
          <span onclick={() => stepDiff(-1)} onkeydown={(e) => e.key === 'Enter' && stepDiff(-1)} role="button" tabindex="0" title="Previous" style="margin-left:auto;cursor:pointer;color:var(--text2);font-size:var(--px-14);padding:0 var(--px-6)">◀ Prev</span>
          <span onclick={() => stepDiff(1)} onkeydown={(e) => e.key === 'Enter' && stepDiff(1)} role="button" tabindex="0" title="Next" style="cursor:pointer;color:var(--text2);font-size:var(--px-14);padding:0 var(--px-6)">Next ▶</span>
          <span onclick={() => (selDiff = null)} onkeydown={(e) => e.key === 'Enter' && (selDiff = null)} role="button" tabindex="0" style="cursor:pointer;color:var(--muted);font-size:var(--px-20);margin-left:var(--px-6)">×</span>
        </div>
        <div style="flex:none;display:flex;font-size:var(--px-10);color:var(--muted);font-weight:700;text-transform:uppercase;border-bottom:var(--px-1) solid var(--border2)">
          <span style="flex:1;padding:var(--px-6) var(--px-14)">Target · {tgtProfile?.name}</span>
          <span style="flex:1;padding:var(--px-6) var(--px-14);border-left:var(--px-1) solid var(--border)">Source · {srcProfile?.name}</span>
        </div>
        <div style="flex:1;overflow:auto;background:var(--bg)">
          {#each ddlLines as l, i (i)}
            <div style="display:flex;font-size:var(--px-12);line-height:1.55">
              <div class="mono" style="flex:1;padding:0 var(--px-14);white-space:pre-wrap;background:{l.type === 'del' ? 'rgba(224,108,117,.16)' : 'transparent'};color:{l.type === 'del' ? '#e06c75' : 'var(--text2)'}">{l.type !== 'add' ? l.text : ''}</div>
              <div class="mono" style="flex:1;padding:0 var(--px-14);white-space:pre-wrap;border-left:var(--px-1) solid var(--border);background:{l.type === 'add' ? 'rgba(39,174,96,.16)' : 'transparent'};color:{l.type === 'add' ? '#27AE60' : 'var(--text2)'}">{l.type !== 'del' ? l.text : ''}</div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* Diff rows: hover + selected feedback using the SAME primary tints as the
     Explorer tree (var(--hover) reads too faint on the light surface). Additive —
     base backgrounds unchanged (nested rows keep --panel via .cmp-panel; table
     rows stay transparent) so the existing look is preserved. */
  .cmp-panel {
    background: var(--panel);
  }
  .cmp-row:not(.sel):hover {
    background: color-mix(in srgb, var(--primary) 9%, transparent);
  }
  .cmp-row.sel {
    /* 16% blue fill — the diff rows already carry a left status bar, so no extra
       accent bar (it would sit under that bar and read as a conflict). */
    background: var(--rgba-91-124-255-_16);
  }
  .cmp-row.sel:hover {
    background: color-mix(in srgb, var(--primary) 22%, transparent);
  }
</style>
