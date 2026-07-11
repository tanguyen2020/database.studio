<script lang="ts">
  // Object Explorer — port 1:1 từ Database Studio.dc.html:
  //  - header "Explorer" + icon hệ + tên connection + ⟳ (dòng 137-142)
  //  - node row: pad 6+depth*15, chev 10px/9px, glyph mono 15px/12px màu map C
  //    (dòng 145-152 + 4717-4726), name 12.5px weight 500/700, meta mono 10px
  //  - bottom toolbar 6 nút + expand/collapse (dòng 155-166)
  // Cây per-dialect (PG tách Proc/Func + Sequences; MySQL/MariaDB ẩn Sequences;
  // MSSQL Schemas/TVF/Scalar; SQLite file → main → Tables 🔒/Views/Triggers).
  // Introspection lazy qua explorer store (IPC thật).
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import * as ipc from '$lib/ipc'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import RedisExplorer from '$lib/components/explorer/RedisExplorer.svelte'
  import MongoExplorer from '$lib/components/explorer/MongoExplorer.svelte'
  import TableContextMenu from '$lib/components/explorer/TableContextMenu.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { chTtl } from '$lib/stores/chttl.svelte'
  import { importWizard } from '$lib/stores/import.svelte'
  import { exportWizard } from '$lib/stores/export.svelte'
  import { copyWizard } from '$lib/stores/copy.svelte'
  import { testDataWizard } from '$lib/stores/testdata.svelte'
  import { execRoutineWizard } from '$lib/stores/execroutine.svelte'
  import { chCreateWizard } from '$lib/stores/chcreate.svelte'
  import { natsAddWizard } from '$lib/stores/natsAdd.svelte'
  import { natsCreateStream } from '$lib/stores/natsCreateStream.svelte'
  import { kafkaTopicWizard } from '$lib/stores/kafkaTopic.svelte'
  import { properties, type PropTarget } from '$lib/stores/properties.svelte'
  import { newDatabaseWizard } from '$lib/stores/newdatabase.svelte'
  import { genRenameRoutine } from '$lib/sql/routines'
  import { scriptsWizard } from '$lib/stores/scripts.svelte'
  import { collationWizard } from '$lib/stores/collation.svelte'
  import { backupWizard } from '$lib/stores/backup.svelte'
  import * as chops from '$lib/sql/chops'
  import { toasts } from '$lib/stores/toast.svelte'
  import { quoteIdent, qualified, selectStarSql } from '$lib/sql/dialect'
  import { genAlterTable, genCreate, genDelete, genDrop, genDropDatabase, genForeignKey, genInsert, genRename, genRenameDatabase, genSelect, genTruncate, genUpdate } from '$lib/sql/ddl'
  import { generateScript, type DbObject, type ScriptMode } from '$lib/sql/scripts'
  import { genCreateIndex, genDropIndex, genAlterIndex } from '$lib/sql/indexes'
  import { createTemplate, type CreateKind } from '$lib/sql/create-templates'
  import {
    createTemplate as cassCreateTemplate,
    dropStatement as cassDropStmt,
    type CassCreateKind,
    type CassDropKind,
  } from '$lib/sql/cassandra'
  import { partitionOps, supportsPartitioning } from '$lib/sql/partitions'
  import { addPartitionWizard } from '$lib/stores/addpartition.svelte'
  import { truncateWizard } from '$lib/stores/truncate.svelte'
  import { buildExportSelect } from '$lib/export/query'
  import { kafkaTopicRows, natsStreamRows, filterStreamRows, filterTopicRows } from '$lib/stream/explorer'
  import { toAlterStatement, type AlterKind } from '$lib/sql/alter'
  import { objectFilterMatch } from '$lib/explorer/filter'
  import { autofocus } from '$lib/actions/autofocus'
  import { toSqlInsert } from '$lib/export/rows'
  import type { ColumnInfo, PartitionInfo, RoutineInfo, TableInfo } from '$lib/types'
  import { untrack, type Snippet } from 'svelte'

  const selected = $derived(connections.selected)
  const cache = $derived(selected ? explorer.cache[selected.id] : undefined)
  const isSqlite = $derived(selected?.system === 'sqlite')
  const isMssql = $derived(selected?.system === 'mssql')
  const isPg = $derived(selected?.system === 'postgres')
  // ClickHouse (clickhouseTree): Databases → Tables/Views — không có
  // Procs/Triggers/Sequences; Dictionaries/Functions/engine badge → Phase 5
  const isClickhouse = $derived(selected?.system === 'clickhouse')
  // MySQL/MariaDB expose each database as a schema node (SCHEMATA) — show it with
  // the DataGrip-style database folder icon, not the plain schema glyph.
  const schemaIsDatabase = $derived(selected?.system === 'mysql' || selected?.system === 'mariadb')
  // Systems whose schema-tree nodes ARE databases (double-clicking one opens the
  // Objects tab): MySQL/MariaDB (SCHEMATA) and ClickHouse. For PG/MSSQL the schema
  // nodes are schemas — their database nodes are the current-DB header / foreign-DB
  // nodes, handled separately below.
  const schemaNodeIsDatabase = $derived(
    selected?.system === 'mysql' || selected?.system === 'mariadb' || selected?.system === 'clickhouse',
  )
  const showRoutines = $derived(!isSqlite && !isClickhouse)
  const showTriggers = $derived(!isClickhouse)
  // AUDIT-4 item 2 — PG/MSSQL bind one DB per connection; the tree nests schemas
  // under a current-database header, and lists other databases separately.
  const pgMssqlMultiDb = $derived(
    (selected?.system === 'postgres' || selected?.system === 'mssql') && (cache?.databases?.length ?? 0) > 0,
  )
  // schema tree depth offset: SQLite nests under a file node; PG/MSSQL nest under
  // the current-database header node (see relational branch).
  const base = $derived(isSqlite || pgMssqlMultiDb ? 1 : 0)

  let expanded = $state<Set<string>>(new Set())
  let treeSel = $state<string | null>(null)

  // Schema-wide index list (the "Indexes" folder) — loaded on demand via
  // scan_indexes (same source as the Index Scanner), cached per conn+schema.
  let schemaIndexes = $state<Record<string, ipc.IndexScanRow[]>>({})
  let schemaIndexLoading = $state<Set<string>>(new Set())
  const idxKey = (connId: string, schema: string) => `${connId}:${schema}`
  async function loadSchemaIndexes(connId: string, schema: string, force = false) {
    const k = idxKey(connId, schema)
    if (!force && (schemaIndexes[k] || schemaIndexLoading.has(k))) return
    schemaIndexLoading = new Set(schemaIndexLoading).add(k)
    try {
      const res = await ipc.scanIndexes(connId, schema)
      schemaIndexes = { ...schemaIndexes, [k]: res.indexes }
    } catch {
      schemaIndexes = { ...schemaIndexes, [k]: [] }
    } finally {
      const s = new Set(schemaIndexLoading)
      s.delete(k)
      schemaIndexLoading = s
    }
  }
  // Clear the tree selection when switching connections so the sidebar ER / Generate
  // Scripts buttons stay disabled until a schema/database is picked in the new tree.
  $effect(() => {
    void selected?.id
    untrack(() => (treeSel = null))
  })
  // The schema/database node the toolbar's View-ER / Generate-Scripts act on, derived
  // from the current tree selection. Only schema nodes (public/dbo/a database) qualify;
  // a table/folder/leaf selection → null → those buttons disable.
  const erTarget = $derived.by(() => {
    const t = treeSel
    if (!selected || !t) return null
    if (t.startsWith('s:')) return { connId: selected.id, base: selected.id, system: selected.system, schema: t.slice(2) }
    if (t === 'curdb') {
      const sch = cache?.schemas?.[0]?.name
      return sch ? { connId: selected.id, base: selected.id, system: selected.system, schema: sch } : null
    }
    const mSub = t.match(/^fdb:(.+):s:(.+)$/)
    if (mSub) {
      const sub = dbSubId[mSub[1]]
      return sub ? { connId: sub, base: selected.id, system: selected.system, schema: mSub[2] } : null
    }
    const mDb = t.match(/^fdb:([^:]+)$/)
    if (mDb) {
      const sub = dbSubId[mDb[1]]
      const sch = sub ? explorer.cache[sub]?.schemas?.[0]?.name : undefined
      return sub && sch ? { connId: sub, base: selected.id, system: selected.system, schema: sch } : null
    }
    return null
  })
  $effect(() => {
    explorer.selectedSchema = erTarget
  })
  // The database a NEW Query Editor tab should bind to, from the current tree
  // selection. Unlike `erTarget` this resolves the database NAME even for a
  // not-yet-expanded foreign database — New Query doesn't need the sub-connection
  // (SqlWorkspace attaches its own per-tab connection at run time). For PG/MSSQL a
  // schema node maps to the connection's current database; MySQL/MariaDB/ClickHouse
  // treat the schema itself as the database; a foreign-DB node carries its name.
  const dbTarget = $derived.by(() => {
    const t = treeSel
    if (!selected || !t) return null
    if (t.startsWith('s:')) {
      const schema = t.slice(2)
      const db = dbForSchema(schema) ?? (isClickhouse ? schema : curDbName || selected.database)
      return db ? { base: selected.id, database: db } : null
    }
    if (t === 'curdb') {
      const db = curDbName || selected.database
      return db ? { base: selected.id, database: db } : null
    }
    const mSub = t.match(/^fdb:(.+):s:(.+)$/)
    if (mSub) return { base: selected.id, database: mSub[1] }
    const mDb = t.match(/^fdb:([^:]+)$/)
    if (mDb) return { base: selected.id, database: mDb[1] }
    return null
  })
  $effect(() => {
    explorer.selectedDatabase = dbTarget
  })
  // Top filter — DATABASE names only (item 1). Object filtering is per-folder.
  let dbFilter = $state('')
  const dbFiltering = $derived(!!dbFilter.trim())
  function matchDb(name: string): boolean {
    const q = dbFilter.trim().toLowerCase()
    return !q || name.toLowerCase().includes(q)
  }
  function matchSearch(_name: string): boolean {
    return true // top filter no longer filters objects
  }
  const searching = false

  // Per-folder object filter (SSMS-style): the search box is hidden until the
  // user picks "Filter…" from the folder's context menu, keyed by the folder tree
  // key. `folderFilterOpen` = the box is shown; `folderFilters` = the query text.
  const folderFilters = $state<Record<string, string>>({}) // committed → drives filtering (debounced)
  const folderFilterOpen = $state<Record<string, boolean>>({})
  // Raw input text — drives the <input> so keystrokes echo instantly, while the
  // committed value (which triggers the expensive tree re-render) is debounced.
  // Without this, every keystroke rebuilt the whole folder (each row wraps a
  // ContextMenu.Root), so clearing characters felt laggy.
  const folderFilterRaw = $state<Record<string, string>>({})
  const folderFilterTimers: Record<string, ReturnType<typeof setTimeout>> = {}
  function folderMatch(key: string, name: string): boolean {
    return objectFilterMatch(folderFilters[key] ?? '', name)
  }
  /** Type handler: echo the character immediately, commit (filter) after a pause. */
  function setFolderFilter(key: string, value: string) {
    folderFilterRaw[key] = value
    clearTimeout(folderFilterTimers[key])
    folderFilterTimers[key] = setTimeout(() => (folderFilters[key] = value), 120)
  }
  /** Reset both raw + committed at once (cancel any pending debounce). */
  function resetFolderFilter(key: string) {
    clearTimeout(folderFilterTimers[key])
    folderFilterRaw[key] = ''
    folderFilters[key] = ''
  }
  /** Open the filter box for a folder (expand it first so the box is visible). */
  function openFolderFilter(key: string) {
    if (!expanded.has(key)) expanded = new Set([...expanded, key])
    folderFilterRaw[key] = folderFilters[key] ?? ''
    folderFilterOpen[key] = true
  }
  /** Clear the query but keep the box open (list restored, ready to re-filter). */
  function clearFolderFilterText(key: string) {
    resetFolderFilter(key)
  }
  /** Clear Filter: clear the query AND hide the box (never leaves a hidden active
   *  filter, since folderMatch keys off the query text). */
  function clearFolderFilter(key: string) {
    resetFolderFilter(key)
    folderFilterOpen[key] = false
  }
  const hasFolderFilter = (key: string) => (folderFilters[key] ?? '').trim() !== ''
  /** Toggle the filter box from the folder header's funnel icon. */
  function toggleFolderFilter(key: string) {
    if (folderFilterOpen[key]) clearFolderFilter(key)
    else openFolderFilter(key)
  }
  /** Focus the filter input when it appears. */
  function focusFilter(node: HTMLInputElement) {
    node.focus()
  }

  const curDbName = $derived(cache?.databases?.find((d) => d.current)?.name ?? selected?.database ?? '')
  const visibleSchemas = $derived.by(() => {
    const all = cache?.schemas ?? []
    if (!dbFiltering) return all
    return all.filter((s) => matchDb(s.name))
  })
  // T18 — Object Properties panel: suy ra type/schema/name từ key node đang chọn.
  const selProps = $derived.by(() => {
    const k = treeSel
    if (!k || k.indexOf(':') < 0 || !selected) return null
    const prefix = k.slice(0, k.indexOf(':'))
    const rest = k.slice(k.indexOf(':') + 1)
    const dot = rest.indexOf('.')
    const typeMap: Record<string, string> = {
      t: 'Table', v: 'View', p: 'Procedure', fn: 'Function', tg: 'Trigger',
      col: 'Column', vcol: 'Column', s: 'Schema', i: 'Indexes', seq: 'Sequence', dic: 'Dictionary', f: 'Folder',
    }
    return {
      type: typeMap[prefix] ?? prefix,
      schema: dot >= 0 ? rest.slice(0, dot) : rest,
      name: dot >= 0 ? rest.slice(dot + 1) : rest,
    }
  })

  // Right-side Properties panel: parse the selected key precisely (schema / table /
  // column) and publish it so PropertiesPanel can render columns / definition.
  const propTarget = $derived.by((): PropTarget | null => {
    const k = treeSel
    const s = selected
    if (!k || !s || k.indexOf(':') < 0) return null
    const prefix = k.slice(0, k.indexOf(':'))
    const rest = k.slice(k.indexOf(':') + 1)
    const kindMap: Record<string, { kind: string; label: string }> = {
      t: { kind: 'table', label: 'Table' },
      v: { kind: 'view', label: 'View' },
      col: { kind: 'column', label: 'Column' },
      vcol: { kind: 'column', label: 'Column' },
      p: { kind: 'procedure', label: 'Procedure' },
      fn: { kind: 'function', label: 'Function' },
      tg: { kind: 'trigger', label: 'Trigger' },
      seq: { kind: 'sequence', label: 'Sequence' },
      s: { kind: 'schema', label: 'Schema' },
      dic: { kind: 'dictionary', label: 'Dictionary' },
    }
    const m = kindMap[prefix]
    if (!m) return null
    const parts = rest.split('.')
    if (m.kind === 'schema') {
      return { connId: s.id, system: s.system, kind: m.kind, typeLabel: m.label, schema: rest, name: rest }
    }
    if (m.kind === 'column') {
      return { connId: s.id, system: s.system, kind: m.kind, typeLabel: m.label, schema: parts[0] ?? '', table: parts[1], name: parts.slice(2).join('.') || (parts[1] ?? '') }
    }
    return { connId: s.id, system: s.system, kind: m.kind, typeLabel: m.label, schema: parts[0] ?? '', name: parts.slice(1).join('.') || (parts[0] ?? '') }
  })

  // Sync the parsed target into the shared store (no feedback loop: propTarget is
  // derived from treeSel/selected only, and we only write to `properties`).
  $effect(() => {
    properties.set(propTarget)
  })

  // untrack: loadSchemas() đọc+ghi explorer.cache đồng bộ (conn()/track()) → nếu
  // trong vùng track của effect sẽ read+write cùng $state → effect_update_depth
  // (kích hoạt khi chọn 1 connection ĐANG kết nối). Xem build-gotchas memory.
  $effect(() => {
    const s = selected
    if (s?.connected) {
      untrack(() => {
        void explorer.loadSchemas(s.id)
        // Postgres/MSSQL: one DB per connection → list every database so the user
        // can open another. (MySQL/MariaDB already expose all DBs as schemas.)
        if (s.system === 'postgres' || s.system === 'mssql') void explorer.loadDatabases(s.id)
      })
    }
  })

  // AUDIT-4 item 2 — other databases are browsed through an internal sub-connection
  // (attach_database → {connId}::{db}), NOT a duplicate sidebar connection.
  // `dbSubId` caches the resolved sub-connection id per database name.
  let dbSubId = $state<Record<string, string>>({})
  let attaching = $state('')
  async function toggleForeignDb(dbName: string) {
    const key = `fdb:${dbName}`
    if (expanded.has(key)) {
      toggle(key)
      return
    }
    if (!selected || attaching) return
    attaching = dbName
    try {
      const sub = dbSubId[dbName] ?? (await ipc.attachDatabase(selected.id, dbName))
      dbSubId = { ...dbSubId, [dbName]: sub }
      await explorer.loadSchemas(sub)
      toggle(key)
    } catch (e) {
      toasts.error(String(e))
    } finally {
      attaching = ''
    }
  }

  // Double-clicking opens (or retargets) the pinned Objects tab. The unit differs by
  // system:
  //  - schema-as-database (MySQL/MariaDB/ClickHouse): the "database" IS a schema, so
  //    double-clicking it opens Objects for that database.
  //  - schema-based (PG/MSSQL): a database has many schemas, so Objects is scoped to a
  //    SCHEMA — double-clicking a schema opens it; double-clicking the database node
  //    only expands (never a mixed all-schemas view).
  function openObjectsForSchemaDb(schemaName: string) {
    if (!selected) return
    expandSchema(schemaName) // keep the original toggle behavior
    tabs.openObjectsTab({ connId: selected.id, database: schemaName, schema: schemaName })
  }
  // PG/MSSQL: double-clicking a SCHEMA opens the Objects tab scoped to that schema
  // (its tables only). Keeps the expand/collapse.
  function openObjectsForSchema(schemaName: string) {
    if (!selected) return
    expandSchema(schemaName) // keep the original toggle behavior
    tabs.openObjectsTab({ connId: selected.id, database: curDbName || selected.database || 'database', schema: schemaName })
  }

  // Cassandra (Phase 4b): cây keyspace lấy qua command chuyên biệt (cassandra_tree),
  // không đi qua explorer store quan hệ.
  const isCassandra = $derived(selected?.system === 'cassandra')
  // Multi-keyspace: list of keyspaces + a lazily-loaded tree per keyspace (loaded
  // on expand, cached). Replaces the old single-keyspace `cassTree`.
  let cassKeyspaces = $state<string[]>([])
  let cassTrees = $state<Record<string, ipc.CassKeyspaceTree>>({})
  let cassError = $state<string | null>(null)
  $effect(() => {
    const s = selected
    if (s?.connected && s.system === 'cassandra') {
      untrack(() => void loadCass(s.id))
    }
  })
  async function loadCass(id: string) {
    cassError = null
    try {
      cassKeyspaces = await ipc.cassandraKeyspaces(id)
      cassTrees = {}
      // Preload the default keyspace (connection.database) so its subtree is ready.
      const def = connections.byId(id)?.database
      if (def && cassKeyspaces.includes(def)) await loadCassKeyspace(id, def)
    } catch (e) {
      cassError = String(e)
      cassKeyspaces = []
    }
  }
  async function loadCassKeyspace(id: string, ks: string) {
    if (cassTrees[ks]) return
    try {
      cassTrees = { ...cassTrees, [ks]: await ipc.cassandraTree(id, ks) }
    } catch (e) {
      cassError = String(e)
    }
  }
  // "Alter…" an index → open its REAL definition (from the catalog: incl. INCLUDE /
  // filtered WHERE / method / CLUSTERED) as a re-runnable DROP + CREATE to edit & run.
  // Falls back to a column-list reconstruction if the catalog yields nothing.
  async function alterIndex(
    connId: string,
    system: string,
    schema: string,
    table: string,
    ix: { name: string; columns: string[]; unique: boolean },
    database?: string,
  ) {
    let def = ''
    try {
      def = (await ipc.indexDefinition(connId, schema, table, ix.name)).trim()
    } catch {
      /* fall back to reconstruction */
    }
    const sql =
      system !== 'clickhouse' && def
        ? `-- Alter index: edit the recreate below, then run. Drop & recreate (an index's columns can't be altered in place).\n${genDropIndex(system, schema, table, ix.name)}\n${def}`
        : genAlterIndex(system, schema, { name: ix.name, table, columns: ix.columns, unique: ix.unique })
    stmtTab(`Alter index ${ix.name}`, sql, database, connId)
  }

  // Expand a keyspace node → ensure its tree is loaded, then toggle.
  function toggleCassKeyspace(ks: string, key: string) {
    if (selected && !cassTrees[ks]) void loadCassKeyspace(selected.id, ks)
    toggle(key)
  }

  // Header "⟳ Refresh" — works for EVERY connection type by dispatching to the right
  // reload path (relational/ClickHouse schema cache, Kafka/NATS streaming, Redis key
  // browser, Cassandra keyspace tree). Guarded + spinning indicator (Refresh rule chung).
  let refreshingTree = $state(false)
  async function refreshConnection() {
    const s = selected
    if (!s || refreshingTree) return
    refreshingTree = true
    try {
      if (s.system === 'kafka' || s.system === 'nats') {
        await explorer.loadStreaming(s.id, s.system, true)
      } else if (s.system === 'redis') {
        explorer.bumpRedis(s.id) // RedisExplorer reloads its key list on the tick
      } else if (s.system === 'cassandra') {
        await loadCass(s.id)
      } else if (s.system === 'mongodb') {
        mongoRefresh++ // MongoExplorer reloads its tree when the key changes
      } else {
        // relational + ClickHouse: rebuild the schema cache; PG/MSSQL also re-list DBs
        await explorer.refresh(s.id, { kind: 'connection' })
        if (s.system === 'postgres' || s.system === 'mssql') await explorer.loadDatabases(s.id)
      }
    } finally {
      refreshingTree = false
    }
  }
  // NATS mark (blue tile + white "N" + chat-bubble tail) served from an asset
  // file, used as the stream-node icon in the explorer instead of the ▤ glyph.
  const NATS_LOGO = '<img src="/assets/db-nats.svg" width="14" height="14" style="display:block" alt="nats" />'
  // Streaming (Kafka topics / NATS JetStream streams) — loaded via the explorer
  // store so the messages tabs can trigger a refresh after purge/delete.
  const isKafka = $derived(selected?.system === 'kafka')
  const isNats = $derived(selected?.system === 'nats')
  const isRedis = $derived(selected?.system === 'redis')
  const isMongo = $derived(selected?.system === 'mongodb')
  // Bumped by the header Refresh button → MongoExplorer reloads its tree.
  let mongoRefresh = $state(0)
  const streamCache = $derived(selected ? explorer.streaming[selected.id] : undefined)
  const topicRows = $derived(streamCache?.kafkaTopics ? kafkaTopicRows(streamCache.kafkaTopics) : [])
  // Kafka explorer filter — matches topic names (case-insensitive substring).
  let topicFilter = $state('')
  const topicFiltering = $derived(!!topicFilter.trim())
  const filteredTopicRows = $derived(filterTopicRows(topicFilter, topicRows))
  const allStreamRows = $derived(streamCache?.natsStreams ? natsStreamRows(streamCache.natsStreams) : [])
  // NATS explorer filter — matches stream names only (see filterStreamRows).
  let streamFilter = $state('')
  const streamFiltering = $derived(!!streamFilter.trim())
  const streamRows = $derived(filterStreamRows(streamFilter, allStreamRows))
  // Per-stream subject filter (SSMS-style "Filter…" on a stream): stream name → query,
  // plus the set of streams whose filter box is currently shown.
  let subjFilters = $state<Record<string, string>>({})
  let subjFilterOpen = $state<Set<string>>(new Set())
  function openSubjFilter(stream: string) {
    if (!expanded.has(`nats:s:${stream}`)) toggle(`nats:s:${stream}`)
    subjFilterOpen = new Set(subjFilterOpen).add(stream)
    subjFilters = { ...subjFilters, [stream]: subjFilters[stream] ?? '' }
  }
  function clearSubjFilter(stream: string) {
    const f = { ...subjFilters }
    delete f[stream]
    subjFilters = f
    const o = new Set(subjFilterOpen)
    o.delete(stream)
    subjFilterOpen = o
  }
  $effect(() => {
    const s = selected
    if (s?.connected && (s.system === 'kafka' || s.system === 'nats')) {
      untrack(() => void explorer.loadStreaming(s.id, s.system))
    }
  })

  // In-app confirm popup (window.confirm isn't reliable inside the Tauri webview);
  // clicking the backdrop does NOT confirm — only the Confirm button runs the action.
  let confirmState = $state<{ title: string; body: string; run: () => void } | null>(null)
  function askConfirm(title: string, body: string, run: () => void) {
    confirmState = { title, body, run }
  }
  function runConfirm() {
    const c = confirmState
    confirmState = null
    c?.run()
  }

  function deleteTopic(topic: string) {
    if (!selected) return
    askConfirm('Delete topic', `Delete topic "${topic}"? This drops the topic and all its data.`, async () => {
      if (!selected) return
      try {
        await ipc.kafkaDeleteTopic(selected.id, topic)
        toasts.success(`Deleted topic ${topic}`, 'kafka')
        explorer.refreshStreaming(selected.id)
      } catch (e) {
        toasts.error(String(e), 'kafka')
      }
    })
  }
  function clearTopic(topic: string) {
    if (!selected) return
    askConfirm('Clear messages', `Clear all messages of topic "${topic}"? This cannot be undone.`, async () => {
      if (!selected) return
      try {
        await ipc.kafkaPurgeTopic(selected.id, topic)
        toasts.success(`Cleared messages of ${topic}`, 'kafka')
        explorer.refreshStreaming(selected.id)
        // clear the open consumer tab for this topic too, so both stay in sync
        explorer.bumpKafkaTopic(selected.id, topic)
      } catch (e) {
        toasts.error(String(e), 'kafka')
      }
    })
  }
  // Delete the subject only — its messages are purged and it is dropped from the
  // stream config. The stream itself is always kept (a stream must keep ≥1 subject;
  // deleting the last one is refused by the backend — use "Delete stream" instead).
  // This is a SEPARATE action from Delete stream and never touches it.
  function deleteSubject(stream: string, subject: string) {
    if (!selected) return
    askConfirm(
      'Delete subject',
      `Delete subject "${subject}" from stream "${stream}"? This purges its messages and removes it from the stream. The stream itself is kept.`,
      async () => {
        if (!selected) return
        try {
          await ipc.natsJsRemoveSubject(selected.id, stream, subject)
          toasts.success(`Deleted subject ${subject}`, 'nats')
          explorer.refreshStreaming(selected.id)
        } catch (e) {
          toasts.error(String(e), 'nats')
        }
      },
    )
  }
  function deleteStream(stream: string) {
    if (!selected) return
    askConfirm(
      'Delete stream',
      `Delete stream "${stream}"? This drops the stream and all its subjects and messages. This cannot be undone.`,
      async () => {
        if (!selected) return
        try {
          await ipc.natsJsDeleteStream(selected.id, stream) // throws if the server didn't delete
          toasts.success(`Deleted stream ${stream}`, 'nats')
          // await a FRESH server list so the tree reflects the real server state
          await explorer.loadStreaming(selected.id, 'nats', true)
        } catch (e) {
          toasts.error(String(e), 'nats')
        }
      },
    )
  }
  function clearSubject(stream: string, subject: string) {
    if (!selected) return
    askConfirm(
      'Clear messages',
      `Clear all messages of subject "${subject}"? This cannot be undone.`,
      async () => {
        if (!selected) return
        try {
          await ipc.natsJsPurgeSubject(selected.id, stream, subject)
          toasts.success(`Cleared messages of ${subject}`, 'nats')
          explorer.refreshStreaming(selected.id)
          // also reload the focused subject-messages tab so it shows empty
          explorer.bumpNatsSubject(selected.id, stream, subject)
        } catch (e) {
          toasts.error(String(e), 'nats')
        }
      },
    )
  }

  // ClickHouse Dictionaries (§3) — nạp lười khi mở folder.
  let chDicts = $state<Record<string, string[]>>({})
  async function loadChDicts(connId: string, schema: string) {
    if (chDicts[schema]) return
    try {
      chDicts = { ...chDicts, [schema]: await ipc.chDictionaries(connId, schema) }
    } catch {
      chDicts = { ...chDicts, [schema]: [] }
    }
  }

  // meta hậu tố phân biệt partition key / clustering / FK (prototype dòng 3968-3970).
  function colMeta(c: ipc.CassColumn): string {
    let suffix = ''
    if (c.kind === 'partition_key') suffix = ' · PK'
    else if (c.kind === 'clustering') suffix = ' · CK'
    else if (/_id$/.test(c.name)) suffix = ' · FK'
    return `${c.data_type}${suffix}`
  }

  function toggle(key: string) {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expanded = next
  }

  function expandSchema(schema: string) {
    if (!selected) return
    toggle(`s:${schema}`)
    void explorer.loadSchemaChildren(selected.id, schema)
  }

  function expandTable(schema: string, table: string) {
    if (!selected) return
    toggle(`t:${schema}.${table}`)
    void explorer.loadTableDetail(selected.id, schema, table)
  }

  function openData(schema: string, t: TableInfo, cid = selected?.id) {
    if (!cid) return
    tabs.openTableViewer(cid, schema, t.name)
  }

  // The database a Query Editor tab should target for an object in `schema`:
  // an explicit database (foreign-db subtree) wins; otherwise for MySQL/MariaDB
  // the schema IS the database (item 3 — open the tab on the selected DB), while
  // PG/MSSQL objects live in the connection's current database (undefined → default).
  function dbForSchema(schema: string, database?: string): string | undefined {
    return database ?? (schemaIsDatabase ? schema : undefined)
  }

  // `database` binds a Query Editor tab to another database on the same server —
  // the base connection stays, tab.state.database routes the run through an
  // attached sub-connection (see SqlWorkspace.resolveRunConn).
  function newQuery(schema: string, table?: string, database?: string) {
    if (!selected) return
    const query = table ? selectStarSql(selected.system, schema, table) : ''
    const tab = tabs.openSqlTab({
      connectionId: selected.id,
      title: table ? `${table} · SELECT` : 'Untitled query',
      query,
    })
    const db = dbForSchema(schema, database)
    if (db) {
      tab.state.database = db
      tabs.schedulePersist()
    }
  }

  async function copyName(name: string) {
    await navigator.clipboard.writeText(name)
    toasts.success(`Copied "${name}"`)
  }

  // DDL Viewer + Generate SQL — sinh từ ColumnInfo thật (ddl.ts), mở trong tab
  // SQL Editor (syntax highlight sẵn). Cột nạp lazy nên phải chờ loadTableDetail.
  async function columnsOf(schema: string, table: string, cid = selected?.id): Promise<ColumnInfo[]> {
    if (!cid) return []
    await explorer.loadTableDetail(cid, schema, table)
    return explorer.cache[cid]?.bySchema[schema]?.tableDetails[table]?.columns ?? []
  }

  async function genSqlTab(kind: 'select' | 'insert' | 'update' | 'delete' | 'ddl', schema: string, table: string, cid = selected?.id, database?: string) {
    if (!selected || !cid) return
    const cols = await columnsOf(schema, table, cid)
    if (!cols.length) {
      toasts.show(`Could not load columns for "${table}"`)
      return
    }
    const sys = selected.system
    const gen = { select: genSelect, insert: genInsert, update: genUpdate, delete: genDelete, ddl: genCreate }[kind]
    const suffix = { select: 'SELECT', insert: 'INSERT', update: 'UPDATE', delete: 'DELETE', ddl: 'DDL' }[kind]
    stmtTab(`${table} · ${suffix}`, gen(sys, schema, table, cols), dbForSchema(schema, database))
  }

  async function copyDdl(schema: string, table: string, cid = selected?.id) {
    if (!selected || !cid) return
    const cols = await columnsOf(schema, table, cid)
    if (!cols.length) {
      toasts.show(`Could not load columns for "${table}"`)
      return
    }
    await navigator.clipboard.writeText(genCreate(selected.system, schema, table, cols))
    toasts.success('Copied DDL')
  }

  // Rename/Truncate/Drop — mở SQL editable để review trước khi Run (port HTML dòng 3370-3398).
  // `database` binds the SQL tab to a foreign database (see newQuery).
  function stmtTab(title: string, sql: string, database?: string, cid = selected?.id) {
    if (!cid) return
    const tab = tabs.openSqlTab({ connectionId: cid, title, query: sql })
    if (database) {
      tab.state.database = database
      tabs.schedulePersist()
    }
  }

  // ---- Partitions node (View + Manage) ----------------------------------------
  function partMeta(p: PartitionInfo): string {
    const bits: string[] = []
    if (p.expression) bits.push(p.expression)
    else if (p.method) bits.push(p.method)
    if (p.rows != null) bits.push(`${p.rows.toLocaleString()} rows`)
    return bits.join(' · ')
  }

  /** Reveal a table's Partitions node: load its detail, then expand both the
   *  table row and its Partitions folder so existing partitions become visible. */
  async function showPartitions(cid: string, schema: string, table: string, tableKey: string, partsKey: string) {
    await explorer.loadTableDetail(cid, schema, table)
    const next = new Set(expanded)
    next.add(tableKey)
    next.add(partsKey)
    expanded = next
    const parts = explorer.cache[cid]?.bySchema[schema]?.tableDetails[table]?.partitions ?? []
    if (parts.length === 0) toasts.show(`"${table}" is not partitioned`)
  }

  /** Right-click menu for one partition: copy + dialect-correct maintenance ops
   *  (each opens an editable SQL tab for review before running). `cid`/`database`
   *  target a foreign-database sub-connection when set. */
  function partitionMenuItems(
    cid: string,
    schema: string,
    table: string,
    p: PartitionInfo,
    system: string,
    database?: string,
  ): { label: string; run: () => void }[] {
    const items: { label: string; run: () => void }[] = [{ label: 'Copy name', run: () => copyName(p.name) }]
    if (p.expression) items.push({ label: 'Copy bound / value', run: () => copyName(p.expression!) })
    for (const op of partitionOps(system, schema, table, p)) {
      items.push({
        label: op.danger ? `${op.label}…` : op.label,
        run: () => stmtTab(`${table} — ${op.label}`, op.sql, database, cid),
      })
    }
    items.push({ label: 'Refresh', run: () => explorer.refresh(cid, { kind: 'table', schema, table }) })
    return items
  }

  // Generate Scripts cho MỘT bảng theo mode (structure/data/both) — mở SQL tab.
  // Dùng lại engine thuần generateScript + genCreate + genForeignKey + toSqlInsert.
  async function genTableScript(schema: string, table: string, mode: ScriptMode, cid = selected?.id, database?: string) {
    if (!selected || !cid) return
    const sys = selected.system
    const cols = await columnsOf(schema, table, cid)
    if (!cols.length) {
      toasts.show(`Could not load columns for "${table}"`)
      return
    }
    const fks = (await ipc.listForeignKeys(cid, schema).catch(() => [])).filter((f) => f.from_table === table)
    let dataSql: string | undefined
    if (mode !== 'structure') {
      const res = await ipc.execStatement(cid, buildExportSelect({ system: sys, schema, table }), 0)
      if (res.ok && res.result && res.result.rows.length) {
        dataSql = toSqlInsert(table, res.result.cols.map((c) => c[0]), res.result.rows as Record<string, unknown>[])
      }
    }
    const obj: DbObject = {
      name: table,
      kind: 'table',
      createSql: genCreate(sys, schema, table, cols),
      deps: fks.map((f) => f.to_table),
      fkAlters: fks.map((f) => genForeignKey(sys, schema, f)),
      dataSql,
    }
    const script = generateScript([obj], mode)
    stmtTab(`${table} · scripts`, `-- ${table} (${mode})\n\n${script}`, dbForSchema(schema, database))
  }

  // "Create <type>…" folder action — open a ready-to-edit CREATE skeleton in a SQL
  // tab, bound to the target database (foreign-db subtree passes db.name; MySQL
  // uses the schema-as-database).
  function createObject(kind: CreateKind, schema: string, database?: string) {
    if (!selected) return
    stmtTab(`Create ${kind}`, createTemplate(selected.system, kind, schema), dbForSchema(schema, database))
  }

  // New Database (DataGrip-style) — open a dialog to enter the name; Create runs
  // CREATE DATABASE on the connection.
  function newDatabase() {
    if (selected) newDatabaseWizard.show(selected.id, selected.system)
  }

  // T18 — Show Definition: lấy text định nghĩa THẬT từ server (view/trigger/proc/func).
  // `titleSuffix='alter'` opens the same server DDL as an editable "Alter" tab —
  // for PG that DDL is `CREATE OR REPLACE …` (re-running alters in place); for
  // MSSQL/MySQL the user edits CREATE→ALTER or drops+recreates as the dialect needs.
  async function showDefinition(kind: string, schema: string, name: string, cid = selected?.id, titleSuffix = 'definition') {
    if (!selected || !cid) return
    try {
      const def = await ipc.objectDefinition(cid, schema, kind, name)
      // Bind the tab to the object's database: the foreign-db sub-connection's DB,
      // or (MySQL/MariaDB) the schema itself (schema == database).
      const database = cid !== selected.id
        ? Object.entries(dbSubId).find(([, v]) => v === cid)?.[0]
        : dbForSchema(schema)
      stmtTab(`${name} · ${titleSuffix}`, def, database)
    } catch (e) {
      toasts.error(String(e))
    }
  }
  // Alter: fetch the real definition, then rewrite it into a RE-RUNNABLE statement
  // (CREATE OR REPLACE / CREATE OR ALTER / DROP+CREATE per dialect) so running it
  // actually modifies the object instead of failing "already exists".
  async function alterObject(kind: string, schema: string, name: string, cid = selected?.id) {
    if (!selected || !cid) return
    try {
      const def = await ipc.objectDefinition(cid, schema, kind, name)
      const stmt = toAlterStatement(selected.system, kind as AlterKind, schema, name, def)
      const database = cid !== selected.id
        ? Object.entries(dbSubId).find(([, v]) => v === cid)?.[0]
        : dbForSchema(schema)
      stmtTab(`${name} · alter`, stmt, database)
    } catch (e) {
      toasts.error(String(e))
    }
  }

  // Sequences (PG only) — Alter/Drop skeletons opened for review.
  function alterSequence(schema: string, name: string) {
    if (!selected) return
    stmtTab(`Alter ${name}`, `ALTER SEQUENCE ${qualified(selected.system, schema, name)}\n  INCREMENT BY 1\n  RESTART WITH 1;`)
  }
  function dropSequence(schema: string, name: string) {
    if (!selected) return
    stmtTab(`Drop ${name}`, `DROP SEQUENCE IF EXISTS ${qualified(selected.system, schema, name)};`)
  }

  // T18 — Drop: sinh câu DROP mở trong editor để review (không tự chạy).
  function dropObject(kind: string, schema: string, name: string, table?: string) {
    if (!selected) return
    const sys = selected.system
    const q = (x: string) => quoteIdent(sys, x)
    const qual = schema && sys !== 'sqlite' ? `${q(schema)}.${q(name)}` : q(name)
    let sql: string
    if (kind === 'view') {
      sql = `DROP VIEW IF EXISTS ${qual};`
    } else if (kind === 'trigger') {
      const on = table ? ` ON ${schema && sys !== 'sqlite' ? `${q(schema)}.${q(table)}` : q(table)}` : ''
      sql = `-- Check the target table before running\nDROP TRIGGER IF EXISTS ${q(name)}${on};`
    } else {
      const kw = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      sql = `-- PostgreSQL may need the argument signature: DROP ${kw} ${qual}(...)\nDROP ${kw} IF EXISTS ${qual};`
    }
    stmtTab(`Drop ${name}`, sql, dbForSchema(schema))
  }

  // T28 — Execute proc/func (dialog by signature) + Rename (dialect-aware).
  function execRoutine(schemaName: string, r: RoutineInfo) {
    // Bind to the routine's database (MySQL: schema == database) so the CALL runs
    // against the right DB — item 3.
    if (selected) execRoutineWizard.show(selected.id, schemaName, r, dbForSchema(schemaName))
  }
  function renameRoutine(schemaName: string, r: RoutineInfo) {
    if (!selected) return
    const newName = window.prompt(`Rename ${r.name} to:`, r.name)
    if (!newName || newName === r.name) return
    const sql = genRenameRoutine(selected.system, schemaName, r.kind, r.name, newName, r.params.map((p) => p.data_type))
    stmtTab(`Rename ${r.name}`, sql)
  }

  function routineLabel(r: RoutineInfo): string {
    const params = r.params.map((p) => p.data_type).join(', ')
    return `${r.name}(${params})`
  }

  // Cassandra DDL viewer (Phase 4b · T5) — native CQL reconstructed from real
  // metadata for ANY object kind (table/view/type/index/function/aggregate).
  async function cassObjectDdlTab(keyspace: string, kind: string, name: string) {
    if (!selected) return
    try {
      const ddl = await ipc.cassandraObjectDdl(selected.id, keyspace, kind, name)
      tabs.openSqlTab({ connectionId: selected.id, title: `${name} DDL`, query: ddl })
    } catch (e) {
      toasts.error(`${e}`)
    }
  }

  function cassSelectTab(keyspace: string, table: string) {
    if (!selected) return
    tabs.openSqlTab({
      connectionId: selected.id,
      title: table,
      query: `SELECT * FROM ${keyspace}.${table} LIMIT 100;`,
    })
  }

  function cassCopyName(name: string) {
    void navigator.clipboard.writeText(name).then(() => toasts.success('Copied name'))
  }

  // Create: open an editable CQL template in a new editor tab (review + run).
  function cassCreateTab(keyspace: string, kind: CassCreateKind, table?: string) {
    if (!selected) return
    tabs.openSqlTab({
      connectionId: selected.id,
      title: `New ${kind}`,
      query: cassCreateTemplate(kind, keyspace, table),
    })
  }

  // Force-reload a keyspace's cached tree (after a DDL change).
  async function refreshCassKeyspace(keyspace: string) {
    if (!selected) return
    const next = { ...cassTrees }
    delete next[keyspace]
    cassTrees = next
    await loadCassKeyspace(selected.id, keyspace)
  }

  async function cassRunAndRefresh(cql: string, keyspace: string, keyspaceGone: boolean) {
    if (!selected) return
    try {
      const r = await ipc.cqlExec(selected.id, cql)
      if (r.error) {
        toasts.error(r.error.message)
        return
      }
      toasts.success('Done')
      if (keyspaceGone) await loadCass(selected.id)
      else await refreshCassKeyspace(keyspace)
    } catch (e) {
      toasts.error(String(e))
    }
  }

  // Drop/Truncate: confirm (in-app; backdrop does not close) then run the CQL.
  function cassDrop(kind: CassDropKind, keyspace: string, name: string) {
    askConfirm(`Drop ${kind}`, `Drop ${kind} "${name}"? This cannot be undone.`, () => {
      void cassRunAndRefresh(cassDropStmt(kind, keyspace, name), keyspace, kind === 'keyspace')
    })
  }

  function collapseAll() {
    expanded = new Set()
  }


  // map C trong Component (dòng 3947): màu glyph per loại object
  const C = {
    table: 'var(--hex-5b9bd5)',
    view: 'var(--hex-b48ead)',
    proc: 'var(--hex-e8923a)',
    func: 'var(--hex-e8c547)',
    trig: 'var(--hex-e06c75)',
    seq: 'var(--hex-56b6c2)',
    idx: 'var(--hex-7f8a9e)',
    col: 'var(--hex-9aa4b8)',
    folder: 'var(--hex-d0a45e)',
    schema: 'var(--hex-7f8a9e)',
    part: 'var(--hex-56b6c2)',
    kafka: 'var(--hex-8b5cf6)',
  } as const

  // Kafka topic icon — the gradient Kafka logo (connected nodes) served as an SVG
  // asset so the blue→purple gradient renders exactly (like the NATS logo).
  const KAFKA_LOGO = '<img src="/assets/db-kafka.svg" width="14" height="15" style="display:block" alt="kafka" />'

  // Folder icon for database nodes (DataGrip-style) — inline SVG, uses currentColor.
  const DB_FOLDER_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/></svg>'

  // Funnel icon for the per-folder filter toggle (shown on the right of folder headers).
  const FILTER_ICON =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h18l-7 8v6l-4 2v-8z"/></svg>'

  interface RowProps {
    key: string
    depth: number
    glyph: string
    /** optional inline SVG shown instead of the mono glyph (e.g. folder icon) */
    svg?: string
    color: string
    /** optional override for the name text color (default: text/text2 by state) */
    nameColor?: string
    name: string
    meta?: string
    head?: boolean
    expandable?: boolean
    locked?: boolean
    /** if set, the row is draggable and carries this payload for the ER canvas */
    dragData?: string
    /** leaf rows (Kafka topic / NATS subject) act on a single click, not dbl */
    openOnSingleClick?: boolean
    /** folder headers: show a funnel icon on the right that toggles the filter box
     *  (uses `key` as the folder-filter key) */
    filterable?: boolean
    onClick?: () => void
    onDblClick?: () => void
  }
</script>

{#snippet row(p: RowProps, menu?: Snippet)}
  {@const sel = treeSel === p.key}
  {#snippet inner()}
    <!-- node row — port dòng 145-151 -->
    <div
      onclick={() => {
        // single-click SELECTS only; expansion needs a double-click (or the chevron).
        // Leaf action rows (Kafka topic / NATS subject) open on a single click.
        treeSel = p.key
        if (p.openOnSingleClick) p.onClick?.()
      }}
      ondblclick={() => {
        treeSel = p.key
        ;(p.onDblClick ?? p.onClick)?.()
      }}
      onkeydown={(e) => e.key === 'Enter' && (p.onDblClick ?? p.onClick)?.()}
      role="treeitem"
      aria-selected={sel}
      aria-expanded={p.expandable ? expanded.has(p.key) : undefined}
      tabindex="0"
      draggable={p.dragData != null}
      ondragstart={(e) => {
        if (!p.dragData || !e.dataTransfer) return
        e.dataTransfer.effectAllowed = 'copy'
        e.dataTransfer.setData('application/x-ds-er-table', p.dragData)
        e.dataTransfer.setData('text/plain', p.dragData) // fallback mime for strict engines
      }}
      title={p.name}
      style="display:flex;align-items:center;gap:var(--px-5);padding:var(--px-3) var(--px-6);border-radius:var(--px-5);cursor:pointer;white-space:nowrap;padding-left:calc(var(--px-6) + {p.depth} * var(--px-15));background:{sel ? 'var(--rgba-91-124-255-_16)' : 'transparent'};box-shadow:inset var(--px-2) 0 0 {sel ? 'var(--primary)' : 'transparent'}"
    >
      <!-- chevron: single-click toggles expansion (row single-click only selects) -->
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <span
        class="mono"
        role={p.expandable ? 'button' : undefined}
        onclick={(e) => { if (p.expandable) { e.stopPropagation(); treeSel = p.key; p.onClick?.() } }}
        style="flex:none;width:var(--px-10);text-align:center;font-size:var(--px-9);color:var(--muted);cursor:{p.expandable ? 'pointer' : 'default'}"
      >{p.expandable ? (expanded.has(p.key) ? '▾' : '▸') : ''}</span>
      <span class="mono" style="flex:none;width:var(--px-15);display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:{p.color}">{#if p.svg}{@html p.svg}{:else}{p.glyph}{/if}</span>
      <span class="mono" style="font-size:var(--px-12_5);font-weight:{p.head ? 700 : 500};color:{p.nameColor ?? (sel || p.head ? 'var(--text)' : 'var(--text2)')};overflow:hidden;text-overflow:ellipsis">{p.name}</span>
      {#if p.locked}<span style="font-size:var(--px-9)" title="System table — read-only">🔒</span>{/if}
      <span class="mono" style="font-size:var(--px-10);color:var(--muted);margin-left:auto">{p.meta ?? ''}</span>
      {#if p.filterable}
        {@const active = hasFolderFilter(p.key) || folderFilterOpen[p.key]}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <span
          role="button"
          tabindex="0"
          onclick={(e) => { e.stopPropagation(); treeSel = p.key; toggleFolderFilter(p.key) }}
          onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); toggleFolderFilter(p.key) } }}
          title={active ? 'Clear filter' : 'Filter items'}
          aria-label="Filter items"
          style="flex:none;display:flex;align-items:center;justify-content:center;width:var(--px-15);color:{active ? 'var(--primary)' : 'var(--muted)'};cursor:pointer;opacity:{active ? 1 : 0.55}"
        >{@html FILTER_ICON}</span>
      {/if}
    </div>
  {/snippet}
  {#if menu}
    <ContextMenu.Root>
      <ContextMenu.Trigger>{@render inner()}</ContextMenu.Trigger>
      {@render menu()}
    </ContextMenu.Root>
  {:else}
    {@render inner()}
  {/if}
{/snippet}

<!-- per-folder object filter — a search box revealed by the folder's context-menu
     "Filter…" (SSMS-style); hidden otherwise. -->
{#snippet folderFilter(key: string, depth: number)}
  {#if folderFilterOpen[key]}
    <div style="display:flex;align-items:center;gap:var(--px-4);padding:var(--px-2) var(--px-6) var(--px-3);padding-left:calc(var(--px-6) + {depth} * var(--px-15))">
      <input
        use:focusFilter
        value={folderFilterRaw[key] ?? ''}
        oninput={(e) => setFolderFilter(key, e.currentTarget.value)}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && clearFolderFilter(key)}
        placeholder="Filter…"
        aria-label="Filter items"
        style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-7);color:var(--text);font-size:var(--px-11);outline:none"
      />
      <!-- × clears the query text (list restored) but keeps the box open -->
      <span onclick={() => clearFolderFilterText(key)} onkeydown={(e) => e.key === 'Enter' && clearFolderFilterText(key)} role="button" tabindex="0" title="Clear filter text" aria-label="Clear filter text" style="cursor:pointer;color:var(--muted);font-size:var(--px-13);line-height:1">×</span>
      <!-- Clear Filter removes the filter entirely (clears text + closes the box) -->
      <span onclick={() => clearFolderFilter(key)} onkeydown={(e) => e.key === 'Enter' && clearFolderFilter(key)} role="button" tabindex="0" title="Clear filter" aria-label="Clear filter" style="cursor:pointer;color:var(--muted);font-size:var(--px-11);white-space:nowrap">Clear</span>
    </div>
  {/if}
{/snippet}

<!-- context-menu items: Filter… / Clear Filter (shared by every folder header) -->
{#snippet filterMenuItems(key: string)}
  <ContextMenu.Item onclick={() => openFolderFilter(key)}>Filter…</ContextMenu.Item>
  {#if hasFolderFilter(key) || folderFilterOpen[key]}
    <ContextMenu.Item onclick={() => clearFolderFilter(key)}>Clear Filter</ContextMenu.Item>
  {/if}
{/snippet}

<!-- explorer — dòng 136 -->
<div
  style="flex:1;display:flex;flex-direction:column;min-height:0"
  role="tree"
  tabindex="-1"
>
  <!-- header — dòng 137-142 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-12) var(--px-7)">
    <span style="font-size:var(--px-10_5);font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)">Explorer</span>
    {#if selected}
      <span style="display:flex;align-items:center;flex:none"><SystemIcon system={selected.system} size={16} /></span>
      <span class="mono" style="font-size:var(--px-11_5);color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{selected.name}</span>
    {/if}
    <span
      onclick={refreshConnection}
      onkeydown={(e) => e.key === 'Enter' && refreshConnection()}
      role="button"
      tabindex="0"
      aria-busy={refreshingTree}
      aria-label="Refresh"
      title="Refresh"
      style="margin-left:auto;display:inline-flex;align-items:center;gap:var(--px-4);cursor:{refreshingTree ? 'default' : 'pointer'};color:var(--muted);font-size:var(--px-11_5);font-weight:600;opacity:{selected ? (refreshingTree ? 0.6 : 1) : 0.4}"
    ><span class="tree-refresh-glyph" class:spinning={refreshingTree} style="font-size:var(--px-13)">⟳</span>{refreshingTree ? 'Refreshing…' : 'Refresh'}</span>
  </div>

  <!-- filter — finds databases and objects by name (schema-tree systems) -->
  {#if selected?.connected && ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse'].includes(selected.system)}
    <div style="flex:none;padding:0 var(--px-8) var(--px-6);position:relative">
      <span style="position:absolute;left:var(--px-16);top:50%;transform:translateY(-60%);color:var(--muted);font-size:var(--px-11);pointer-events:none">⌕</span>
      <input
        bind:value={dbFilter}
        placeholder="Filter databases…"
        aria-label="Filter databases"
        spellcheck="false"
        style="width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-22);color:var(--text);font-size:var(--px-11_5);outline:none"
      />
      {#if dbFiltering}
        <span onclick={() => (dbFilter = '')} onkeydown={(e) => e.key === 'Enter' && (dbFilter = '')} role="button" tabindex="0" title="Clear" style="position:absolute;right:var(--px-14);top:50%;transform:translateY(-60%);color:var(--muted);font-size:var(--px-13);cursor:pointer">×</span>
      {/if}
    </div>
  {/if}

  <!-- filter — finds Kafka topics by name -->
  {#if selected?.connected && isKafka}
    <div style="flex:none;padding:var(--px-6) var(--px-8);position:relative">
      <span style="position:absolute;left:var(--px-16);top:50%;transform:translateY(-50%);color:var(--muted);font-size:var(--px-11);pointer-events:none">⌕</span>
      <input
        bind:value={topicFilter}
        placeholder="Filter topics…"
        aria-label="Filter topics"
        spellcheck="false"
        style="width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-22);color:var(--text);font-size:var(--px-11_5);outline:none"
      />
      {#if topicFiltering}
        <span onclick={() => (topicFilter = '')} onkeydown={(e) => e.key === 'Enter' && (topicFilter = '')} role="button" tabindex="0" title="Clear" style="position:absolute;right:var(--px-14);top:50%;transform:translateY(-50%);color:var(--muted);font-size:var(--px-13);cursor:pointer">×</span>
      {/if}
    </div>
  {/if}

  <!-- Kafka: Add topic button (below the filter) -->
  {#if selected?.connected && isKafka}
    <div style="flex:none;padding:var(--px-4) var(--px-8) var(--px-6);display:flex;justify-content:flex-end">
      <span
        onclick={() => selected && kafkaTopicWizard.show(selected.id)}
        onkeydown={(e) => e.key === 'Enter' && selected && kafkaTopicWizard.show(selected.id)}
        role="button"
        tabindex="0"
        title="Add topic"
        style="font-size:var(--px-11);color:var(--text2);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600"
      >＋ Add topic</span>
    </div>
  {/if}

  <!-- filter — finds NATS JetStream streams by name -->
  {#if selected?.connected && isNats}
    <div style="flex:none;padding:var(--px-6) var(--px-8) 0;position:relative">
      <span style="position:absolute;left:var(--px-16);top:calc(50% + var(--px-3));transform:translateY(-60%);color:var(--muted);font-size:var(--px-11);pointer-events:none">⌕</span>
      <input
        bind:value={streamFilter}
        placeholder="Filter streams…"
        aria-label="Filter streams"
        spellcheck="false"
        style="width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-22);color:var(--text);font-size:var(--px-11_5);outline:none"
      />
      {#if streamFiltering}
        <span onclick={() => (streamFilter = '')} onkeydown={(e) => e.key === 'Enter' && (streamFilter = '')} role="button" tabindex="0" title="Clear" style="position:absolute;right:var(--px-14);top:calc(50% + var(--px-3));transform:translateY(-60%);color:var(--muted);font-size:var(--px-13);cursor:pointer">×</span>
      {/if}
    </div>
  {/if}

  <!-- NATS: Add stream button (below the filter) -->
  {#if selected?.connected && isNats}
    <div style="flex:none;padding:var(--px-8) var(--px-8) var(--px-6);display:flex;justify-content:flex-end">
      <span
        onclick={() => selected && natsCreateStream.show(selected.id)}
        onkeydown={(e) => e.key === 'Enter' && selected && natsCreateStream.show(selected.id)}
        role="button"
        tabindex="0"
        title="Add stream"
        style="font-size:var(--px-11);color:var(--text2);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600"
      >＋ Add stream</span>
    </div>
  {/if}

  <!-- tree — dòng 143-152 -->
  <div style="flex:1;overflow:auto;padding:0 var(--px-6) var(--px-10)">
    {#if !selected}
      <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">
        Select a connection to view its structure
      </div>
    {:else if connections.connecting.has(selected.id)}
      <!-- item 5: connection in flight → clear "connecting…" indicator -->
      <div style="padding:var(--px-20) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted);display:flex;flex-direction:column;align-items:center;gap:var(--px-8)">
        <span class="mono" style="font-size:var(--px-18);color:var(--warn)">◴</span>
        <span>Connecting to {selected.name}…</span>
      </div>
    {:else if !selected.connected}
      <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">
        {#if connections.connectErrors[selected.id]}
          <!-- item 5: connect failed → clear message (not just a toast) -->
          <p style="color:var(--error);font-weight:600">Could not connect to {selected.name}</p>
          <p class="mono" style="color:var(--error);font-size:var(--px-11);max-width:var(--px-320);margin:var(--px-6) auto;word-break:break-word;line-height:1.4">{connections.connectErrors[selected.id]}</p>
        {:else}
          <p>Not connected.</p>
        {/if}
        <div
          onclick={() => selected && connections.connect(selected.id)}
          onkeydown={(e) => e.key === 'Enter' && selected && connections.connect(selected.id)}
          role="button"
          tabindex="0"
          style="margin-top:var(--px-6);color:var(--primary);cursor:pointer"
        >{connections.connectErrors[selected.id] ? 'Retry' : 'Connect'}</div>
      </div>
    {:else if cache?.error}
      <div style="padding:var(--px-12);font-size:var(--px-11_5);color:var(--error)">{cache.error}</div>
    {:else if isCassandra}
      <!-- Cassandra keyspace tree (Phase 4b) — every keyspace, lazy per-keyspace -->
      {#if cassError}
        <div style="padding:var(--px-12);font-size:var(--px-11_5);color:var(--error)">{cassError}</div>
      {:else if cassKeyspaces.length}
        {#each cassKeyspaces as ks (ks)}
          {@const ksKey = `cass:ks:${ks}`}
          {@const tree = cassTrees[ks]}
          {#snippet ksMenu()}
            <ContextMenu.Content>
              <ContextMenu.Item onclick={() => tabs.openSqlTab({ connectionId: selected!.id, title: 'Untitled CQL' })}>New Query</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => cassCreateTab(ks, 'table')}>Create Table…</ContextMenu.Item>
              <ContextMenu.Item onclick={() => cassCreateTab(ks, 'type')}>Create Type…</ContextMenu.Item>
              <ContextMenu.Item onclick={() => cassCreateTab(ks, 'materialized-view')}>Create Materialized View…</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => cassDrop('keyspace', ks, ks)}>Drop Keyspace</ContextMenu.Item>
              <ContextMenu.Item onclick={() => selected && refreshCassKeyspace(ks)}>Refresh</ContextMenu.Item>
            </ContextMenu.Content>
          {/snippet}
          {@render row({ key: ksKey, depth: 0, glyph: '▤', color: C.schema, name: ks, meta: 'keyspace', head: true, expandable: true, onClick: () => toggleCassKeyspace(ks, ksKey) }, ksMenu)}
          {#if expanded.has(ksKey)}
            {#if !tree}
              <div style="padding:var(--px-8) var(--px-24);font-size:var(--px-11_5);color:var(--muted)">Loading keyspace…</div>
            {:else}
              <!-- Tables -->
              {@const tKey = `cass:tables:${ks}`}
              {#snippet tablesFolderMenu()}
                <ContextMenu.Content>
                  <ContextMenu.Item onclick={() => cassCreateTab(ks, 'table')}>Create Table…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && refreshCassKeyspace(ks)}>Refresh</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row({ key: tKey, depth: 1, glyph: '▤', color: C.folder, name: 'Tables', meta: String(tree.tables.length), head: true, expandable: true, onClick: () => toggle(tKey) }, tablesFolderMenu)}
              {#if expanded.has(tKey)}
                {#each tree.tables as t (t.name)}
                  {@const tbKey = `cass:t:${ks}:${t.name}`}
                  {#snippet cassMenu()}
                    <ContextMenu.Content>
                      <ContextMenu.Item onclick={() => tabs.openCassandraTable(selected!.id, ks, t.name)}>Open Data (editable)</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => cassSelectTab(ks, t.name)}>SELECT * (LIMIT 100)</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => cassObjectDdlTab(ks, 'table', t.name)}>View DDL (CQL)</ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item onclick={() => cassCreateTab(ks, 'index', t.name)}>Create Index…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => cassCopyName(t.name)}>Copy Name</ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item onclick={() => selected && truncateWizard.show(selected.id, ks, t.name, 'cassandra', 'plain', undefined, () => refreshCassKeyspace(ks))}>Truncate</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => cassDrop('table', ks, t.name)}>Drop</ContextMenu.Item>
                    </ContextMenu.Content>
                  {/snippet}
                  {@render row({ key: tbKey, depth: 2, glyph: '▦', color: C.table, name: t.name, expandable: true, onClick: () => toggle(tbKey), onDblClick: () => tabs.openCassandraTable(selected!.id, ks, t.name) }, cassMenu)}
                  {#if expanded.has(tbKey)}
                    {#each t.columns as c (c.name)}
                      {@render row({ key: `cass:c:${ks}:${t.name}.${c.name}`, depth: 3, glyph: '▸', color: C.col, name: c.name, meta: colMeta(c) })}
                    {/each}
                  {/if}
                {/each}
              {/if}
              <!-- Materialized Views -->
              {#if tree.views.length}
                {@const vKey = `cass:views:${ks}`}
                {@render row({ key: vKey, depth: 1, glyph: '◫', color: C.view, name: 'Materialized Views', meta: String(tree.views.length), head: true, expandable: true, onClick: () => toggle(vKey) })}
                {#if expanded.has(vKey)}
                  {#each tree.views as v (v.name)}
                    {#snippet viewMenu()}
                      <ContextMenu.Content>
                        <ContextMenu.Item onclick={() => cassObjectDdlTab(ks, 'view', v.name)}>View DDL (CQL)</ContextMenu.Item>
                        <ContextMenu.Item onclick={() => cassCopyName(v.name)}>Copy Name</ContextMenu.Item>
                        <ContextMenu.Separator />
                        <ContextMenu.Item onclick={() => cassDrop('view', ks, v.name)}>Drop</ContextMenu.Item>
                      </ContextMenu.Content>
                    {/snippet}
                    {@render row({ key: `cass:v:${ks}:${v.name}`, depth: 2, glyph: '◫', color: C.view, name: v.name, meta: v.base_table }, viewMenu)}
                  {/each}
                {/if}
              {/if}
              <!-- User Types -->
              {#if tree.types.length}
                {@const uKey = `cass:types:${ks}`}
                {@render row({ key: uKey, depth: 1, glyph: '▢', color: C.folder, name: 'User Types', meta: String(tree.types.length), head: true, expandable: true, onClick: () => toggle(uKey) })}
                {#if expanded.has(uKey)}
                  {#each tree.types as ty (ty.name)}
                    {#snippet typeMenu()}
                      <ContextMenu.Content>
                        <ContextMenu.Item onclick={() => cassObjectDdlTab(ks, 'type', ty.name)}>View DDL (CQL)</ContextMenu.Item>
                        <ContextMenu.Item onclick={() => cassCopyName(ty.name)}>Copy Name</ContextMenu.Item>
                        <ContextMenu.Separator />
                        <ContextMenu.Item onclick={() => cassDrop('type', ks, ty.name)}>Drop</ContextMenu.Item>
                      </ContextMenu.Content>
                    {/snippet}
                    {@render row({ key: `cass:u:${ks}:${ty.name}`, depth: 2, glyph: '▢', color: C.col, name: ty.name, meta: 'udt' }, typeMenu)}
                  {/each}
                {/if}
              {/if}
              <!-- Functions -->
              {#if tree.functions.length}
                {@const fKey = `cass:fns:${ks}`}
                {@render row({ key: fKey, depth: 1, glyph: 'ƒ', color: C.folder, name: 'Functions', meta: String(tree.functions.length), head: true, expandable: true, onClick: () => toggle(fKey) })}
                {#if expanded.has(fKey)}
                  {#each tree.functions as fn (fn.signature)}
                    {#snippet fnMenu()}
                      <ContextMenu.Content>
                        <ContextMenu.Item onclick={() => cassObjectDdlTab(ks, fn.kind === 'aggregate' ? 'aggregate' : 'function', fn.name)}>View DDL (CQL)</ContextMenu.Item>
                        <ContextMenu.Item onclick={() => cassCopyName(fn.name)}>Copy Name</ContextMenu.Item>
                        <ContextMenu.Separator />
                        <ContextMenu.Item onclick={() => cassDrop(fn.kind === 'aggregate' ? 'aggregate' : 'function', ks, fn.name)}>Drop</ContextMenu.Item>
                      </ContextMenu.Content>
                    {/snippet}
                    {@render row({ key: `cass:f:${ks}:${fn.signature}`, depth: 2, glyph: 'ƒ', color: C.col, name: fn.name, meta: fn.kind === 'aggregate' ? 'uda' : 'udf' }, fnMenu)}
                  {/each}
                {/if}
              {/if}
              <!-- Secondary Indexes -->
              {#if tree.indexes.length}
                {@const iKey = `cass:idx:${ks}`}
                {@render row({ key: iKey, depth: 1, glyph: '⌗', color: C.idx, name: 'Secondary Indexes', meta: String(tree.indexes.length), head: true, expandable: true, onClick: () => toggle(iKey) })}
                {#if expanded.has(iKey)}
                  {#each tree.indexes as ix (ix.name)}
                    {#snippet ixMenu()}
                      <ContextMenu.Content>
                        <ContextMenu.Item onclick={() => cassObjectDdlTab(ks, 'index', ix.name)}>View DDL (CQL)</ContextMenu.Item>
                        <ContextMenu.Item onclick={() => cassCopyName(ix.name)}>Copy Name</ContextMenu.Item>
                        <ContextMenu.Separator />
                        <ContextMenu.Item onclick={() => cassDrop('index', ks, ix.name)}>Drop</ContextMenu.Item>
                      </ContextMenu.Content>
                    {/snippet}
                    {@render row({ key: `cass:i:${ks}:${ix.name}`, depth: 2, glyph: '⌗', color: C.idx, name: ix.name, meta: ix.kind === 'CUSTOM' ? 'SASI' : ix.target }, ixMenu)}
                  {/each}
                {/if}
              {/if}
              <!-- replication (properties) -->
              {#if tree.replication}
                {@render row({ key: `cass:repl:${ks}`, depth: 1, glyph: '⚙', color: C.col, name: 'replication', meta: tree.replication })}
              {/if}
            {/if}
          {/if}
        {/each}
      {:else}
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">Loading keyspaces…</div>
      {/if}
    {:else if isKafka}
      <!-- Kafka: each topic (click → messages; ctx: view/clear/delete) -->
      {#if streamCache?.error}
        <div style="padding:var(--px-12);font-size:var(--px-11_5);color:var(--error)">{streamCache.error}</div>
      {:else if streamCache?.loading && !streamCache?.kafkaTopics}
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">Loading topics…</div>
      {:else if filteredTopicRows.length === 0}
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">{topicFiltering ? 'No topics match the filter' : 'No topics'}</div>
      {:else}
        {#each filteredTopicRows as t (t.name)}
          {#snippet topicMenu()}
            <ContextMenu.Content class="w-52">
              <ContextMenu.Item onclick={() => selected && tabs.openKafkaTool(selected.id, 'kafka-consumer', t.name)}>View messages</ContextMenu.Item>
              <ContextMenu.Item onclick={() => selected && tabs.openKafkaTool(selected.id, 'kafka-producer', t.name)}>Produce message…</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => clearTopic(t.name)}>Clear messages</ContextMenu.Item>
              <ContextMenu.Item onclick={() => deleteTopic(t.name)}>Delete topic</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => selected && explorer.refreshStreaming(selected.id)}>Refresh</ContextMenu.Item>
            </ContextMenu.Content>
          {/snippet}
          {@render row(
            { key: `kafka:t:${t.name}`, depth: 0, glyph: '', svg: KAFKA_LOGO, color: C.kafka, nameColor: 'var(--hex-56b6c2)', head: true, name: t.name, meta: t.meta, openOnSingleClick: true, onClick: () => selected && tabs.openKafkaTool(selected.id, 'kafka-consumer', t.name) },
            topicMenu,
          )}
        {/each}
      {/if}
    {:else if isNats}
      <!-- NATS JetStream: each stream → its subjects (click subject → messages) -->
      {#if streamCache?.error}
        <div style="padding:var(--px-12);font-size:var(--px-11_5);color:var(--error)">{streamCache.error}</div>
      {:else if streamCache?.loading && !streamCache?.natsStreams}
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">Loading streams…</div>
      {:else if streamRows.length === 0}
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">{streamFiltering ? 'No streams match the filter' : 'No JetStream streams'}</div>
      {:else}
        {#each streamRows as s (s.name)}
          {@const sKey = `nats:s:${s.name}`}
          {#snippet streamMenu()}
            <ContextMenu.Content class="w-52">
              <ContextMenu.Item onclick={() => toggle(sKey)}>Expand / Collapse</ContextMenu.Item>
              <ContextMenu.Item onclick={() => selected && natsAddWizard.show(selected.id, s.name, '', true)}>Add subject…</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => openSubjFilter(s.name)}>Filter subjects…</ContextMenu.Item>
              {#if subjFilterOpen.has(s.name)}
                <ContextMenu.Item onclick={() => clearSubjFilter(s.name)}>Clear filter</ContextMenu.Item>
              {/if}
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => deleteStream(s.name)}>Delete stream</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => selected && explorer.refreshStreaming(selected.id)}>Refresh</ContextMenu.Item>
            </ContextMenu.Content>
          {/snippet}
          {@render row({ key: sKey, depth: 0, glyph: '', svg: NATS_LOGO, color: C.folder, nameColor: 'var(--success)', name: s.name, meta: s.meta, head: true, expandable: true, onClick: () => toggle(sKey) }, streamMenu)}
          {#if expanded.has(sKey)}
            {#if subjFilterOpen.has(s.name)}
              <!-- per-stream subject filter (SSMS-style), depth-1 indented -->
              <div style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-3) var(--px-8) var(--px-5);padding-left:calc(var(--px-8) + 1 * var(--px-14));position:relative">
                <span style="position:absolute;left:calc(var(--px-16) + 1 * var(--px-14));color:var(--muted);font-size:var(--px-11);pointer-events:none">⌕</span>
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  bind:value={subjFilters[s.name]}
                  placeholder="Filter subjects…"
                  aria-label="Filter subjects"
                  autofocus
                  spellcheck="false"
                  style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-22);color:var(--text);font-size:var(--px-11_5);outline:none"
                />
                <span onclick={() => clearSubjFilter(s.name)} onkeydown={(e) => e.key === 'Enter' && clearSubjFilter(s.name)} role="button" tabindex="0" title="Clear filter" style="position:absolute;right:var(--px-14);color:var(--muted);font-size:var(--px-13);cursor:pointer">×</span>
              </div>
            {/if}
            {@const subs = s.subjects.filter((sub) => objectFilterMatch(subjFilters[s.name] ?? '', sub.subject))}
            {#if subs.length === 0}
              <div style="padding:var(--px-4) var(--px-12);padding-left:calc(var(--px-8) + 1 * var(--px-14));font-size:var(--px-11);color:var(--muted)">No subjects match the filter</div>
            {/if}
            {#each subs as sub (sub.subject)}
              {#snippet subjectMenu()}
                <ContextMenu.Content class="w-52">
                  <ContextMenu.Item onclick={() => selected && tabs.openNatsSubject(selected.id, s.name, sub.subject)}>View messages</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && natsAddWizard.show(selected.id, s.name, sub.subject, false)}>Add message…</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => clearSubject(s.name, sub.subject)}>Clear messages</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => deleteSubject(s.name, sub.subject)}>Delete subject</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => selected && explorer.refreshStreaming(selected.id)}>Refresh</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row(
                { key: `nats:sub:${s.name}:${sub.subject}`, depth: 1, glyph: '✉', color: C.seq, nameColor: 'var(--warn2)', name: sub.subject, openOnSingleClick: true, onClick: () => selected && tabs.openNatsSubject(selected.id, s.name, sub.subject) },
                subjectMenu,
              )}
            {/each}
          {/if}
        {/each}
      {/if}
    {:else if isRedis}
      <!-- Redis: key browser (DB selector + SCAN + pattern + tree + Add key). -->
      <RedisExplorer connId={selected.id} />
    {:else if isMongo}
      <!-- MongoDB: database → collection → (fields, indexes) tree. -->
      <MongoExplorer connId={selected.id} defaultDb={selected.database} refreshKey={mongoRefresh} />
    {:else}
      {#if pgMssqlMultiDb}
        <!-- current database header (PG/MSSQL bind one DB per connection); its -->
        <!-- schemas render below at base=1. Other databases follow the schema loop. -->
        {@const curDb = cache?.databases?.find((d) => d.current)}
        {#snippet curDbMenu()}
          <ContextMenu.Content class="w-52">
            <ContextMenu.Item onclick={() => newQuery('')}>New Query</ContextMenu.Item>
            {#if !isSqlite}
              <ContextMenu.Item onclick={() => newDatabase()}>New Database…</ContextMenu.Item>
            {/if}
            <ContextMenu.Item onclick={() => selected && scriptsWizard.show(selected.id, cache?.schemas?.[0]?.name ?? '')}>Generate Scripts…</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && backupWizard.show(selected.id, selected.system)}>Backup & Restore…</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && tabs.openSchemaCompare(selected.id)}>Compare Schemas…</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && tabs.openSchemaCompare(selected.id, { tgtConnId: selected.id })}>Compare Databases…</ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onclick={() => selected && stmtTab(`Rename database ${curDb?.name ?? selected.database}`, genRenameDatabase(selected.system, curDb?.name ?? selected.database ?? ''))}>Rename…</ContextMenu.Item>
            <ContextMenu.Item onclick={() => copyName(curDb?.name ?? selected.database ?? '')}>Copy Name</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'connection' })}>Refresh</ContextMenu.Item>
            <ContextMenu.Separator />
            <!-- current DB: PG can't drop the database you're connected to — connect elsewhere first -->
            <ContextMenu.Item variant="destructive" onclick={() => selected && stmtTab(`Drop database ${curDb?.name ?? selected.database}`, genDropDatabase(selected.system, curDb?.name ?? selected.database ?? ''))}>Drop Database…</ContextMenu.Item>
          </ContextMenu.Content>
        {/snippet}
        {#if !dbFiltering || matchDb(curDbName)}
          {@render row({ key: 'curdb', depth: 0, glyph: '', svg: DB_FOLDER_SVG, color: 'var(--primary)', name: curDb?.name ?? selected.database ?? 'database', meta: 'current', head: true }, curDbMenu)}
        {/if}
      {/if}

      {#if isSqlite}
        {@render row({
          key: 'file',
          depth: 0,
          glyph: '▤',
          color: C.schema,
          name: (selected.sqlite_mode === 'in-memory' ? ':memory:' : selected.sqlite_path.split(/[\\/]/).pop()) || 'database',
          meta: 'file',
          head: true,
        })}
      {/if}

      {#each visibleSchemas as schema (schema.name)}
        {@const sOpen = searching || expanded.has(`s:${schema.name}`)}
        {@const sc = cache?.bySchema[schema.name]}
        {#snippet schemaMenu()}
          <ContextMenu.Content class="w-52">
            <ContextMenu.Item onclick={() => newQuery(schema.name)}>New Query</ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onclick={() => selected && tabs.openErDiagram(selected.id, schema.name)}>View ER Diagram</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && tabs.openErDiagram(selected.id, schema.name, { blank: true })}>New ER Diagram</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && tabs.openIndexScanner(selected.id, schema.name)}>Scan Indexes</ContextMenu.Item>
            <ContextMenu.Item onclick={() => selected && tabs.openTableDesigner(selected.id, schema.name, '')}>New Table…</ContextMenu.Item>
            {#if isClickhouse}
              <ContextMenu.Item onclick={() => selected && chCreateWizard.show(selected.id, schema.name, 'mv')}>Create Materialized View…</ContextMenu.Item>
              <ContextMenu.Item onclick={() => selected && chCreateWizard.show(selected.id, schema.name, 'dict')}>Create Dictionary…</ContextMenu.Item>
            {/if}
            <ContextMenu.Item onclick={() => selected && scriptsWizard.show(selected.id, schema.name)}>Generate Scripts…</ContextMenu.Item>
            <ContextMenu.Separator />
            {#if schemaNodeIsDatabase}
              <!-- database-node ops apply to every schema-as-database system (MySQL/
                   MariaDB/ClickHouse). Unify Collation is MySQL/MariaDB-only. -->
              <ContextMenu.Item onclick={() => selected && tabs.openSchemaCompare(selected.id, { tgtConnId: selected.id, srcDb: schema.name })}>Compare Databases…</ContextMenu.Item>
              {#if schemaIsDatabase}
                <ContextMenu.Item onclick={() => selected && collationWizard.show(selected.id, schema.name)}>Unify Collation…</ContextMenu.Item>
              {/if}
              <ContextMenu.Item onclick={() => selected && stmtTab(`Rename database ${schema.name}`, genRenameDatabase(selected.system, schema.name))}>Rename…</ContextMenu.Item>
              <ContextMenu.Item variant="destructive" onclick={() => selected && stmtTab(`Drop database ${schema.name}`, genDropDatabase(selected.system, schema.name))}>Drop Database…</ContextMenu.Item>
            {/if}
            <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
          </ContextMenu.Content>
        {/snippet}
        {@render row({
          key: `s:${schema.name}`,
          depth: base,
          // schema-as-database systems (MySQL/MariaDB/ClickHouse) show a database
          // folder + "database" label; PG/MSSQL real schemas keep the schema glyph.
          glyph: schemaNodeIsDatabase ? '' : '▤',
          svg: schemaNodeIsDatabase ? DB_FOLDER_SVG : undefined,
          color: schemaNodeIsDatabase ? C.folder : C.schema,
          name: schema.name,
          meta: explorer.isLoading(selected.id, `schema:${schema.name}`) ? '…' : schemaNodeIsDatabase ? 'database' : 'schema',
          head: true,
          expandable: true,
          onClick: () => expandSchema(schema.name),
          // double-click: schema-as-database systems (MySQL/MariaDB/ClickHouse) →
          // Objects for that database; PG/MSSQL (real schemas) → Objects scoped to
          // the double-clicked schema. Both keep the expand/collapse.
          onDblClick: schemaNodeIsDatabase
            ? () => openObjectsForSchemaDb(schema.name)
            : () => openObjectsForSchema(schema.name),
        }, schemaMenu)}

        {#if sOpen && sc}
          {@const tKey = `f:${schema.name}:tables`}
          {@const vKey = `f:${schema.name}:views`}
          {@const pKey = `f:${schema.name}:procs`}
          {@const fnKey = `f:${schema.name}:fns`}
          {@const tvfKey = `f:${schema.name}:tvf`}
          {@const scalarKey = `f:${schema.name}:scalar`}
          {@const tables = (sc.tables?.filter((t) => t.kind !== 'view') ?? []).filter((t) => folderMatch(tKey, t.name))}
          {@const views = (sc.tables?.filter((t) => t.kind === 'view') ?? []).filter((t) => folderMatch(vKey, t.name))}
          {@const procs = (sc.routines?.filter((r) => r.kind === 'procedure') ?? []).filter((r) => folderMatch(pKey, r.name))}
          {@const allFns = sc.routines?.filter((r) => r.kind !== 'procedure') ?? []}
          {@const fns = allFns.filter((r) => folderMatch(fnKey, r.name))}
          {@const tvfs = allFns.filter((r) => r.kind === 'table_function' && folderMatch(tvfKey, r.name))}
          {@const scalarFns = allFns.filter((r) => r.kind !== 'table_function' && folderMatch(scalarKey, r.name))}

          <!-- Tables folder (glyph ▤ màu folder — dòng 3963) -->
          {#snippet tablesFolderMenu()}
            <ContextMenu.Content class="w-48">
              <ContextMenu.Item onclick={() => selected && tabs.openTableDesigner(selected.id, schema.name, '')}>New Table…</ContextMenu.Item>
              <ContextMenu.Item onclick={() => selected && importWizard.show(selected.id, schema.name)}>Import Data…</ContextMenu.Item>
              <ContextMenu.Separator />
              {@render filterMenuItems(tKey)}
              <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
            </ContextMenu.Content>
          {/snippet}
          {@render row({
            key: `f:${schema.name}:tables`,
            depth: base + 1,
            glyph: '▤',
            color: C.folder,
            name: 'Tables',
            meta: String(tables.length),
            head: true,
            expandable: true,
            filterable: true,
            onClick: () => toggle(`f:${schema.name}:tables`),
          }, tablesFolderMenu)}
          {#if searching || expanded.has(`f:${schema.name}:tables`)}
            {@render folderFilter(tKey, base + 1)}
            {#each tables as t (t.name)}
              {@const tbOpen = expanded.has(`t:${schema.name}.${t.name}`)}
              {@const detail = sc.tableDetails[t.name]}
              {#snippet tableMenu()}
                <!-- the single shared relational table menu (rule chung); the tree
                     supplies the two context actions (reveal Partitions, refresh). -->
                <TableContextMenu
                  connId={selected!.id}
                  schema={schema.name}
                  table={t.name}
                  system={selected!.system}
                  locked={t.locked}
                  engine={t.engine}
                  database={dbForSchema(schema.name)}
                  onShowPartitions={() => selected && showPartitions(selected.id, schema.name, t.name, `t:${schema.name}.${t.name}`, `p:${schema.name}.${t.name}`)}
                  onRefresh={() => selected && explorer.refresh(selected.id, { kind: 'table', schema: schema.name, table: t.name })}
                />
              {/snippet}
              {@render row(
                {
                  key: `t:${schema.name}.${t.name}`,
                  depth: base + 2,
                  glyph: '▦',
                  color: C.table,
                  name: t.name,
                  meta: isClickhouse && t.engine ? t.engine : t.row_estimate != null && t.row_estimate > 0 ? `${t.row_estimate.toLocaleString()} rows` : '',
                  expandable: true,
                  locked: t.locked,
                  dragData: JSON.stringify({ schema: schema.name, table: t.name }),
                  onClick: () => expandTable(schema.name, t.name),
                  onDblClick: () => openData(schema.name, t),
                },
                tableMenu,
              )}
              {#if tbOpen}
                {#if explorer.isLoading(selected.id, `table:${schema.name}.${t.name}`)}
                  <div class="mono" style="padding-left:calc(var(--px-6) + {base + 3} * var(--px-15));font-size:var(--px-10);color:var(--muted)">loading…</div>
                {:else if detail}
                  {#each detail.columns ?? [] as col (col.name)}
                    {#snippet columnMenu()}
                      <ContextMenu.Content class="w-48">
                        <ContextMenu.Item onclick={() => copyName(col.name)}>Copy Name</ContextMenu.Item>
                        <ContextMenu.Item onclick={() => copyName(`${t.name}.${col.name}`)}>Copy as table.column</ContextMenu.Item>
                        <ContextMenu.Separator />
                        <ContextMenu.Item onclick={() => selected && tabs.openTableViewer(selected.id, schema.name, t.name, [{ col: col.name, op: '=', value: '' }])}>Set as Filter</ContextMenu.Item>
                        <ContextMenu.Separator />
                        <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'table', schema: schema.name, table: t.name })}>Refresh</ContextMenu.Item>
                      </ContextMenu.Content>
                    {/snippet}
                    {@render row(
                      {
                        key: `col:${schema.name}.${t.name}.${col.name}`,
                        depth: base + 3,
                        glyph: '▸',
                        color: C.col,
                        name: col.name,
                        meta: `${col.data_type}${col.is_pk ? ' · PK' : col.is_fk ? ' · FK' : ''}${!col.nullable && !col.is_pk ? ' · NN' : ''}`,
                      },
                      columnMenu,
                    )}
                  {/each}
                  {#if (detail.indexes ?? []).length > 0}
                    {@render row({
                      key: `i:${schema.name}.${t.name}`,
                      depth: base + 3,
                      glyph: '⌗',
                      color: C.idx,
                      name: 'Indexes',
                      meta: String(detail.indexes?.length),
                      expandable: true,
                      onClick: () => toggle(`i:${schema.name}.${t.name}`),
                    })}
                    {#if expanded.has(`i:${schema.name}.${t.name}`)}
                      {#each detail.indexes ?? [] as ix (ix.name)}
                        {@render row({
                          key: `ix:${schema.name}.${t.name}.${ix.name}`,
                          depth: base + 4,
                          glyph: '⌗',
                          color: C.idx,
                          name: ix.name,
                          meta: `${ix.method}${ix.unique ? ' · UNIQUE' : ''}`,
                        })}
                      {/each}
                    {/if}
                  {/if}
                  {#if (detail.constraints ?? []).length > 0}
                    {@render row({
                      key: `c:${schema.name}.${t.name}`,
                      depth: base + 3,
                      glyph: '⌗',
                      color: C.idx,
                      name: 'Constraints',
                      meta: String(detail.constraints?.length),
                      expandable: true,
                      onClick: () => toggle(`c:${schema.name}.${t.name}`),
                    })}
                    {#if expanded.has(`c:${schema.name}.${t.name}`)}
                      {#each detail.constraints ?? [] as ct (ct.name)}
                        {@render row({
                          key: `ct:${schema.name}.${t.name}.${ct.name}`,
                          depth: base + 4,
                          glyph: '⌗',
                          color: C.idx,
                          name: ct.name,
                          meta: ct.kind,
                        })}
                      {/each}
                    {/if}
                  {/if}
                  {#if (detail.partitions ?? []).length > 0}
                    {@render row({
                      key: `p:${schema.name}.${t.name}`,
                      depth: base + 3,
                      glyph: '▤',
                      color: C.part,
                      name: 'Partitions',
                      meta: detail.partitions?.[0]?.key ?? String(detail.partitions?.length),
                      expandable: true,
                      onClick: () => toggle(`p:${schema.name}.${t.name}`),
                    })}
                    {#if expanded.has(`p:${schema.name}.${t.name}`)}
                      {#each detail.partitions ?? [] as pt (pt.name)}
                        {#snippet partitionMenu()}
                          <ContextMenu.Content class="w-56">
                            {#each partitionMenuItems(selected!.id, schema.name, t.name, pt, selected!.system) as it (it.label)}
                              <ContextMenu.Item onclick={it.run}>{it.label}</ContextMenu.Item>
                            {/each}
                          </ContextMenu.Content>
                        {/snippet}
                        {@render row(
                          {
                            key: `pt:${schema.name}.${t.name}.${pt.name}`,
                            depth: base + 4,
                            glyph: '▤',
                            color: C.part,
                            name: pt.name,
                            meta: partMeta(pt),
                          },
                          partitionMenu,
                        )}
                      {/each}
                    {/if}
                  {/if}
                {/if}
              {/if}
            {/each}
          {/if}

          <!-- Views -->
          {#snippet viewsFolderMenu()}
            <ContextMenu.Content class="w-48">
              <ContextMenu.Item onclick={() => createObject('view', schema.name)}>Create View…</ContextMenu.Item>
              <ContextMenu.Separator />
              {@render filterMenuItems(vKey)}
              <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
            </ContextMenu.Content>
          {/snippet}
          {@render row({
            key: `f:${schema.name}:views`,
            depth: base + 1,
            glyph: '◫',
            color: C.view,
            name: 'Views',
            meta: String(views.length),
            head: true,
            expandable: true,
            filterable: true,
            onClick: () => toggle(`f:${schema.name}:views`),
          }, isClickhouse ? undefined : viewsFolderMenu)}
          {#if searching || expanded.has(`f:${schema.name}:views`)}
            {@render folderFilter(vKey, base + 1)}
            {#each views as v (v.name)}
              {@const vOpen = expanded.has(`t:${schema.name}.${v.name}`)}
              {@const vDetail = sc.tableDetails[v.name]}
              {#snippet viewMenu()}
                <ContextMenu.Content class="w-44">
                  <ContextMenu.Item onclick={() => openData(schema.name, v)}>Open Data</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => showDefinition('view', schema.name, v.name)}>Show Definition</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => alterObject('view', schema.name, v.name)}>Alter…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => newQuery(schema.name, v.name)}>New Query</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => copyName(v.name)}>Copy Name</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item variant="destructive" onclick={() => dropObject('view', schema.name, v.name)}>Drop</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row(
                {
                  key: `v:${schema.name}.${v.name}`,
                  depth: base + 2,
                  glyph: '◫',
                  color: C.view,
                  name: v.name,
                  expandable: true,
                  onClick: () => expandTable(schema.name, v.name),
                  onDblClick: () => openData(schema.name, v),
                },
                viewMenu,
              )}
              {#if vOpen && vDetail}
                {#each vDetail.columns ?? [] as col (col.name)}
                  {@render row({
                    key: `vcol:${schema.name}.${v.name}.${col.name}`,
                    depth: base + 3,
                    glyph: '▸',
                    color: C.col,
                    name: col.name,
                    meta: `${col.data_type}${!col.nullable ? ' · NN' : ''}`,
                  })}
                {/each}
              {/if}
            {/each}
          {/if}

          {#if isClickhouse}
            <!-- Dictionaries (CLICKHOUSE_SPEC_ADDENDUM §3 clickhouseTree) -->
            {@const dKey = `f:${schema.name}:dicts`}
            {@render row({
              key: dKey,
              depth: base + 1,
              glyph: '⊞',
              color: C.folder,
              name: 'Dictionaries',
              meta: String((chDicts[schema.name] ?? []).length || ''),
              head: true,
              expandable: true,
              onClick: () => { toggle(dKey); if (selected) loadChDicts(selected.id, schema.name) },
            })}
            {#if expanded.has(dKey)}
              {#each chDicts[schema.name] ?? [] as dic (dic)}
                {#snippet dictMenu()}
                  <ContextMenu.Content class="w-48">
                    <ContextMenu.Item onclick={() => stmtTab(`${dic} · DDL`, chops.dictShowDefinition(schema.name, dic))}>Show Definition</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`Query ${dic}`, `SELECT * FROM ${schema.name}.${dic} LIMIT 100;`)}>Query</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`Reload ${dic}`, chops.dictReload(dic))}>Reload</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => copyName(dic)}>Copy Name</ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item variant="destructive" onclick={() => stmtTab(`Drop ${dic}`, `DROP DICTIONARY ${schema.name}.${dic};`)}>Drop</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                  </ContextMenu.Content>
                {/snippet}
                {@render row({ key: `dic:${schema.name}.${dic}`, depth: base + 2, glyph: '⊞', color: C.view, name: dic, meta: 'dictionary' }, dictMenu)}
              {/each}
            {/if}
          {/if}

          {#if showRoutines}
            <!-- Stored Procedures -->
            {#snippet procsFolderMenu()}
              <ContextMenu.Content class="w-48">
                <ContextMenu.Item onclick={() => createObject('procedure', schema.name)}>Create Procedure…</ContextMenu.Item>
                <ContextMenu.Separator />
                {@render filterMenuItems(pKey)}
                <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
              </ContextMenu.Content>
            {/snippet}
            {@render row({
              key: `f:${schema.name}:procs`,
              depth: base + 1,
              glyph: '⚙',
              color: C.proc,
              name: 'Stored Procedures',
              meta: String(procs.length),
              head: true,
              expandable: true,
              filterable: true,
              onClick: () => toggle(`f:${schema.name}:procs`),
            }, procsFolderMenu)}
            {#if searching || expanded.has(`f:${schema.name}:procs`)}
              {@render folderFilter(pKey, base + 1)}
              {#each procs as r (r.name)}
                {#snippet procMenu()}
                  <ContextMenu.Content class="w-44">
                    <ContextMenu.Item onclick={() => execRoutine(schema.name, r)}>Execute…</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => showDefinition('procedure', schema.name, r.name)}>Show Definition</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => alterObject('procedure', schema.name, r.name)}>Alter…</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => renameRoutine(schema.name, r)}>Rename…</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => copyName(r.name)}>Copy Name</ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item variant="destructive" onclick={() => dropObject('procedure', schema.name, r.name)}>Drop</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                  </ContextMenu.Content>
                {/snippet}
                {@render row({
                  key: `p:${schema.name}.${r.name}`,
                  depth: base + 2,
                  glyph: '⚙',
                  color: C.proc,
                  name: routineLabel(r),
                }, procMenu)}
              {/each}
            {/if}

            {#if isMssql}
              <!-- MSSQL: tách TVF / Scalar -->
              {#snippet tvfFolderMenu()}
                <ContextMenu.Content class="w-48">
                  <ContextMenu.Item onclick={() => createObject('function', schema.name)}>Create Function…</ContextMenu.Item>
                  <ContextMenu.Separator />
                  {@render filterMenuItems(tvfKey)}
                  <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {#snippet scalarFolderMenu()}
                <ContextMenu.Content class="w-48">
                  <ContextMenu.Item onclick={() => createObject('function', schema.name)}>Create Function…</ContextMenu.Item>
                  <ContextMenu.Separator />
                  {@render filterMenuItems(scalarKey)}
                  <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row({
                key: `f:${schema.name}:tvf`,
                depth: base + 1,
                glyph: 'ƒ',
                color: C.func,
                name: 'Table-Valued Functions',
                meta: String(tvfs.length),
                head: true,
                expandable: true,
                filterable: true,
                onClick: () => toggle(`f:${schema.name}:tvf`),
              }, tvfFolderMenu)}
              {#if searching || expanded.has(`f:${schema.name}:tvf`)}
                {@render folderFilter(tvfKey, base + 1)}
                {#each tvfs as r (r.name)}
                  {#snippet tvfMenu()}
                    <ContextMenu.Content class="w-44">
                      <ContextMenu.Item onclick={() => execRoutine(schema.name, r)}>Execute…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => showDefinition('function', schema.name, r.name)}>Show Definition</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => alterObject('function', schema.name, r.name)}>Alter…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => renameRoutine(schema.name, r)}>Rename…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => copyName(r.name)}>Copy Name</ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item variant="destructive" onclick={() => dropObject('function', schema.name, r.name)}>Drop</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                    </ContextMenu.Content>
                  {/snippet}
                  {@render row({ key: `fn:${schema.name}.${r.name}`, depth: base + 2, glyph: 'ƒ', color: C.func, name: routineLabel(r) }, tvfMenu)}
                {/each}
              {/if}
              {@render row({
                key: `f:${schema.name}:scalar`,
                depth: base + 1,
                glyph: 'ƒ',
                color: C.func,
                name: 'Scalar Functions',
                meta: String(scalarFns.length),
                head: true,
                expandable: true,
                filterable: true,
                onClick: () => toggle(`f:${schema.name}:scalar`),
              }, scalarFolderMenu)}
              {#if searching || expanded.has(`f:${schema.name}:scalar`)}
                {@render folderFilter(scalarKey, base + 1)}
                {#each scalarFns as r (r.name)}
                  {#snippet scalarMenu()}
                    <ContextMenu.Content class="w-44">
                      <ContextMenu.Item onclick={() => execRoutine(schema.name, r)}>Execute…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => showDefinition('function', schema.name, r.name)}>Show Definition</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => alterObject('function', schema.name, r.name)}>Alter…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => renameRoutine(schema.name, r)}>Rename…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => copyName(r.name)}>Copy Name</ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item variant="destructive" onclick={() => dropObject('function', schema.name, r.name)}>Drop</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                    </ContextMenu.Content>
                  {/snippet}
                  {@render row({
                    key: `fn:${schema.name}.${r.name}`,
                    depth: base + 2,
                    glyph: 'ƒ',
                    color: C.func,
                    name: routineLabel(r),
                    meta: r.return_type ? `→ ${r.return_type}` : '',
                  }, scalarMenu)}
                {/each}
              {/if}
            {:else}
              <!-- Functions (PG hiển thị return type) -->
              {#snippet fnsFolderMenu()}
                <ContextMenu.Content class="w-48">
                  <ContextMenu.Item onclick={() => createObject('function', schema.name)}>Create Function…</ContextMenu.Item>
                  <ContextMenu.Separator />
                  {@render filterMenuItems(fnKey)}
                  <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row({
                key: `f:${schema.name}:fns`,
                depth: base + 1,
                glyph: 'ƒ',
                color: C.func,
                name: 'Functions',
                meta: String(fns.length),
                head: true,
                filterable: true,
                expandable: true,
                onClick: () => toggle(`f:${schema.name}:fns`),
              }, fnsFolderMenu)}
              {#if searching || expanded.has(`f:${schema.name}:fns`)}
                {@render folderFilter(fnKey, base + 1)}
                {#each fns as r (r.name)}
                  {#snippet fnMenu()}
                    <ContextMenu.Content class="w-44">
                      <ContextMenu.Item onclick={() => execRoutine(schema.name, r)}>Execute…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => showDefinition('function', schema.name, r.name)}>Show Definition</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => alterObject('function', schema.name, r.name)}>Alter…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => renameRoutine(schema.name, r)}>Rename…</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => copyName(r.name)}>Copy Name</ContextMenu.Item>
                      <ContextMenu.Separator />
                      <ContextMenu.Item variant="destructive" onclick={() => dropObject('function', schema.name, r.name)}>Drop</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                    </ContextMenu.Content>
                  {/snippet}
                  {@render row({
                    key: `fn:${schema.name}.${r.name}`,
                    depth: base + 2,
                    glyph: 'ƒ',
                    color: C.func,
                    name: routineLabel(r),
                    meta: r.return_type ? `→ ${r.return_type}` : '',
                  }, fnMenu)}
                {/each}
              {/if}
            {/if}
          {/if}

          <!-- Triggers -->
          {#if showTriggers}
          {#snippet trigsFolderMenu()}
            <ContextMenu.Content class="w-48">
              <ContextMenu.Item onclick={() => createObject('trigger', schema.name)}>Create Trigger…</ContextMenu.Item>
              <ContextMenu.Separator />
              {@render filterMenuItems(`f:${schema.name}:triggers`)}
              <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
            </ContextMenu.Content>
          {/snippet}
          {@render row({
            key: `f:${schema.name}:triggers`,
            depth: base + 1,
            glyph: '⚡',
            color: C.trig,
            name: 'Triggers',
            meta: String(sc.triggers?.length ?? 0),
            head: true,
            expandable: true,
            filterable: true,
            onClick: () => toggle(`f:${schema.name}:triggers`),
          }, trigsFolderMenu)}
          {#if searching || expanded.has(`f:${schema.name}:triggers`)}
            {@render folderFilter(`f:${schema.name}:triggers`, base + 1)}
            {#each (sc.triggers ?? []).filter((tg) => folderMatch(`f:${schema.name}:triggers`, tg.name)) as tg (tg.name)}
              {#snippet trigMenu()}
                <ContextMenu.Content class="w-44">
                  <ContextMenu.Item onclick={() => showDefinition('trigger', schema.name, tg.name)}>Show Definition</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => alterObject('trigger', schema.name, tg.name)}>Alter…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => copyName(tg.name)}>Copy Name</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item variant="destructive" onclick={() => dropObject('trigger', schema.name, tg.name, tg.table)}>Drop</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row({
                key: `tg:${schema.name}.${tg.name}`,
                depth: base + 2,
                glyph: '⚡',
                color: C.trig,
                name: tg.name,
                meta: `${tg.event} ON ${tg.table}`,
              }, trigMenu)}
            {/each}
          {/if}
          {/if}

          <!-- Indexes (schema-wide): every index across the schema's tables. Data
               from scan_indexes (same source as the Index Scanner), loaded on expand. -->
          {@const ixFolderKey = `f:${schema.name}:indexes`}
          {@const ixKeyC = idxKey(selected?.id ?? '', schema.name)}
          <!-- Only secondary indexes (clustered / non-clustered); primary-key indexes excluded. -->
          {@const ixShown = (schemaIndexes[ixKeyC] ?? []).filter((ix) => !ix.primary)}
          {#snippet idxFolderMenu()}
            <ContextMenu.Content class="w-48">
              <ContextMenu.Item onclick={() => selected && stmtTab('Create index', genCreateIndex(selected.system, schema.name, 'table_name', { name: 'idx_name', columns: ['column'], unique: false }))}>Create Index…</ContextMenu.Item>
              <ContextMenu.Separator />
              {@render filterMenuItems(ixFolderKey)}
              <ContextMenu.Item onclick={() => selected && loadSchemaIndexes(selected.id, schema.name, true)}>Refresh</ContextMenu.Item>
            </ContextMenu.Content>
          {/snippet}
          {@render row({
            key: ixFolderKey,
            depth: base + 1,
            glyph: '⌗',
            color: C.idx,
            name: 'Indexes',
            meta: ixShown.length ? String(ixShown.length) : '',
            head: true,
            expandable: true,
            filterable: true,
            onClick: () => { toggle(ixFolderKey); if (selected) void loadSchemaIndexes(selected.id, schema.name) },
          }, idxFolderMenu)}
          {#if searching || expanded.has(ixFolderKey)}
            {@render folderFilter(ixFolderKey, base + 1)}
            {#if !ixShown.length && schemaIndexLoading.has(ixKeyC)}
              {@render row({ key: `${ixFolderKey}:loading`, depth: base + 2, glyph: '·', color: C.col, name: 'Loading…', meta: '' })}
            {:else if !ixShown.length}
              {@render row({ key: `${ixFolderKey}:empty`, depth: base + 2, glyph: '·', color: C.col, name: 'No indexes', meta: '' })}
            {/if}
            {#each ixShown.filter((ix) => folderMatch(ixFolderKey, ix.name)) as ix (ix.table + '.' + ix.name)}
              {#snippet sIdxMenu()}
                <ContextMenu.Content class="w-48">
                  <ContextMenu.Item onclick={() => selected && alterIndex(selected.id, selected.system, schema.name, ix.table, { name: ix.name, columns: ix.columns, unique: ix.unique })}>Alter…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => copyName(ix.name)}>Copy Name</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => copyName(`${ix.table}.${ix.name}`)}>Copy Qualified Name</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item variant="destructive" onclick={() => selected && stmtTab(`Drop index ${ix.name}`, genDropIndex(selected.system, schema.name, ix.table, ix.name))}>Drop…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && loadSchemaIndexes(selected.id, schema.name, true)}>Refresh</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row({
                key: `six:${schema.name}.${ix.table}.${ix.name}`,
                depth: base + 2,
                glyph: '⌗',
                color: C.idx,
                name: ix.name,
                meta: `${ix.table}${ix.primary ? ' · PK' : ix.unique ? ' · UNIQUE' : ''}`,
              }, sIdxMenu)}
            {/each}
          {/if}

          {#if isPg}
            <!-- Sequences (PG only) -->
            {#snippet seqsFolderMenu()}
              <ContextMenu.Content class="w-48">
                <ContextMenu.Item onclick={() => createObject('sequence', schema.name)}>Create Sequence…</ContextMenu.Item>
                <ContextMenu.Separator />
                {@render filterMenuItems(`f:${schema.name}:seqs`)}
                <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
              </ContextMenu.Content>
            {/snippet}
            {@render row({
              key: `f:${schema.name}:seqs`,
              depth: base + 1,
              glyph: '#',
              color: C.seq,
              name: 'Sequences',
              meta: String(sc.sequences?.length ?? 0),
              head: true,
              expandable: true,
              filterable: true,
              onClick: () => toggle(`f:${schema.name}:seqs`),
            }, seqsFolderMenu)}
            {#if searching || expanded.has(`f:${schema.name}:seqs`)}
              {@render folderFilter(`f:${schema.name}:seqs`, base + 1)}
              {#each (sc.sequences ?? []).filter((sq) => folderMatch(`f:${schema.name}:seqs`, sq.name)) as sq (sq.name)}
                {#snippet seqMenu()}
                  <ContextMenu.Content class="w-44">
                    <ContextMenu.Item onclick={() => alterSequence(schema.name, sq.name)}>Alter…</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => copyName(sq.name)}>Copy Name</ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item variant="destructive" onclick={() => dropSequence(schema.name, sq.name)}>Drop</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
                  </ContextMenu.Content>
                {/snippet}
                {@render row({ key: `sq:${schema.name}.${sq.name}`, depth: base + 2, glyph: '#', color: C.seq, name: sq.name }, seqMenu)}
              {/each}
            {/if}
          {/if}
        {/if}
      {/each}

      {#if pgMssqlMultiDb}
        <!-- other databases on the server — browsed via internal sub-connection -->
        <!-- (attach_database); expand to see their full object tree. No duplicate -->
        <!-- sidebar connection. -->
        {#each (cache?.databases ?? []).filter((d) => !d.current && matchDb(d.name)) as db (db.name)}
          {@const fkey = `fdb:${db.name}`}
          {@const sub = dbSubId[db.name]}
          {@const fcache = sub ? explorer.cache[sub] : undefined}
          {#snippet dbMenu()}
            <ContextMenu.Content class="w-52">
              <ContextMenu.Item onclick={() => newQuery('', undefined, db.name)}>New Query</ContextMenu.Item>
              <ContextMenu.Item onclick={() => toggleForeignDb(db.name)}>{expanded.has(fkey) ? 'Collapse' : 'Expand'}</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => selected && tabs.openSchemaCompare(selected.id, { tgtConnId: selected.id, srcDb: db.name })}>Compare Databases…</ContextMenu.Item>
              <!-- rename/drop run on the base connection (not attached to db.name), which PG requires -->
              <ContextMenu.Item onclick={() => selected && stmtTab(`Rename database ${db.name}`, genRenameDatabase(selected.system, db.name))}>Rename…</ContextMenu.Item>
              <ContextMenu.Item onclick={() => copyName(db.name)}>Copy Name</ContextMenu.Item>
              <ContextMenu.Item onclick={() => sub && explorer.refresh(sub, { kind: 'connection' })}>Refresh</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item variant="destructive" onclick={() => selected && stmtTab(`Drop database ${db.name}`, genDropDatabase(selected.system, db.name))}>Drop Database…</ContextMenu.Item>
            </ContextMenu.Content>
          {/snippet}
          {@render row({ key: fkey, depth: 0, glyph: '', svg: DB_FOLDER_SVG, color: C.folder, name: db.name, meta: attaching === db.name ? 'attaching…' : 'database', head: true, expandable: true, onClick: () => toggleForeignDb(db.name) }, dbMenu)}
          {#if expanded.has(fkey) && fcache}
            {#each fcache.schemas ?? [] as fsch (fsch.name)}
              {@const skey = `${fkey}:s:${fsch.name}`}
              {@const fsc = fcache.bySchema[fsch.name]}
              {#snippet fSchemaMenu()}
                <ContextMenu.Content class="w-52">
                  <ContextMenu.Item onclick={() => newQuery(fsch.name, undefined, db.name)}>New Query</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => sub && tabs.openErDiagram(sub, fsch.name)}>View ER Diagram</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => sub && tabs.openErDiagram(sub, fsch.name, { blank: true })}>New ER Diagram</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => sub && tabs.openIndexScanner(sub, fsch.name)}>Scan Indexes</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => sub && tabs.openTableDesigner(sub, fsch.name, '')}>New Table…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => createObject('view', fsch.name, db.name)}>Create View…</ContextMenu.Item>
                  {#if showRoutines}
                    <ContextMenu.Item onclick={() => createObject('procedure', fsch.name, db.name)}>Create Procedure…</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => createObject('function', fsch.name, db.name)}>Create Function…</ContextMenu.Item>
                  {/if}
                  {#if showTriggers}
                    <ContextMenu.Item onclick={() => createObject('trigger', fsch.name, db.name)}>Create Trigger…</ContextMenu.Item>
                  {/if}
                  <ContextMenu.Item onclick={() => sub && scriptsWizard.show(sub, fsch.name)}>Generate Scripts…</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => sub && explorer.refresh(sub, { kind: 'schema', schema: fsch.name })}>Refresh</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row({ key: skey, depth: 1, glyph: '▤', color: C.schema, name: fsch.name, meta: 'schema', head: true, expandable: true, onClick: () => { toggle(skey); if (sub && !fsc?.tables) void explorer.loadSchemaChildren(sub, fsch.name) }, onDblClick: () => { toggle(skey); if (sub) { if (!fsc?.tables) void explorer.loadSchemaChildren(sub, fsch.name); tabs.openObjectsTab({ connId: sub, database: db.name, schema: fsch.name }) } } }, fSchemaMenu)}
              {#if expanded.has(skey) && fsc}
                {@const fTables = fsc.tables?.filter((t) => t.kind !== 'view') ?? []}
                {@const fViews = fsc.tables?.filter((t) => t.kind === 'view') ?? []}
                {@const fProcs = fsc.routines?.filter((r) => r.kind === 'procedure') ?? []}
                {@const fFns = fsc.routines?.filter((r) => r.kind !== 'procedure') ?? []}
                {#each [['t', 'Tables', '▤', fTables], ['v', 'Views', '◫', fViews], ['p', 'Procedures', '⚙', fProcs], ['fn', 'Functions', 'ƒ', fFns], ['tg', 'Triggers', '⚡', fsc.triggers ?? []], ...(isPg ? [['sq', 'Sequences', '#', fsc.sequences ?? []]] : [])] as [fk, label, glyph, items] (fk)}
                  {@const folderKey = `${skey}:${fk}`}
                  {#snippet fFolderMenu()}
                    <ContextMenu.Content class="w-48">
                      {#if fk === 't'}
                        <ContextMenu.Item onclick={() => sub && tabs.openTableDesigner(sub, fsch.name, '')}>New Table…</ContextMenu.Item>
                        <ContextMenu.Item onclick={() => sub && importWizard.show(sub, fsch.name)}>Import Data…</ContextMenu.Item>
                      {:else if fk === 'v'}
                        <ContextMenu.Item onclick={() => createObject('view', fsch.name, db.name)}>Create View…</ContextMenu.Item>
                      {:else if fk === 'p'}
                        <ContextMenu.Item onclick={() => createObject('procedure', fsch.name, db.name)}>Create Procedure…</ContextMenu.Item>
                      {:else if fk === 'fn'}
                        <ContextMenu.Item onclick={() => createObject('function', fsch.name, db.name)}>Create Function…</ContextMenu.Item>
                      {:else if fk === 'tg'}
                        <ContextMenu.Item onclick={() => createObject('trigger', fsch.name, db.name)}>Create Trigger…</ContextMenu.Item>
                      {:else if fk === 'sq'}
                        <ContextMenu.Item onclick={() => createObject('sequence', fsch.name, db.name)}>Create Sequence…</ContextMenu.Item>
                      {/if}
                      <ContextMenu.Separator />
                      {@render filterMenuItems(folderKey)}
                      <ContextMenu.Item onclick={() => sub && explorer.refresh(sub, { kind: 'schema', schema: fsch.name })}>Refresh</ContextMenu.Item>
                    </ContextMenu.Content>
                  {/snippet}
                  {@render row({ key: folderKey, depth: 2, glyph: glyph as string, color: C.folder, name: label as string, meta: String((items as unknown[]).length), head: true, expandable: true, filterable: true, onClick: () => toggle(folderKey) }, fFolderMenu)}
                  {#if expanded.has(folderKey)}
                    {@render folderFilter(folderKey, 2)}
                    {#each (items as { name: string }[]).filter((it) => folderMatch(folderKey, it.name)) as it (('name' in (it as object) ? (it as { name: string }).name : String(it)))}
                      {@const nm = (it as { name: string }).name}
                      {#snippet fObjMenu()}
                        {#if fk === 't'}
                          <!-- rule chung: foreign-db tables use the SAME shared table menu -->
                          <TableContextMenu
                            connId={sub ?? selected!.id}
                            schema={fsch.name}
                            table={nm}
                            system={selected!.system}
                            database={db.name}
                            onShowPartitions={() => sub && showPartitions(sub, fsch.name, nm, `${folderKey}:${nm}`, `${folderKey}:${nm}:parts`)}
                            onRefresh={() => sub && explorer.refresh(sub, { kind: 'table', schema: fsch.name, table: nm })}
                          />
                        {:else}
                          <ContextMenu.Content class="w-52">
                            {#if fk === 'v'}
                              <ContextMenu.Item onclick={() => sub && tabs.openTableViewer(sub, fsch.name, nm)}>Open Data</ContextMenu.Item>
                            {/if}
                            <ContextMenu.Item onclick={() => newQuery(fsch.name, fk === 'v' ? nm : undefined, db.name)}>New Query</ContextMenu.Item>
                            {#if fk === 'v' || fk === 'p' || fk === 'fn' || fk === 'tg'}
                              {@const okind = fk === 'v' ? 'view' : fk === 'p' ? 'procedure' : fk === 'tg' ? 'trigger' : 'function'}
                              {#if fk === 'p' || fk === 'fn'}
                                <ContextMenu.Item onclick={() => selected && execRoutineWizard.show(selected.id, fsch.name, it as RoutineInfo, db.name)}>Execute…</ContextMenu.Item>
                              {/if}
                              <ContextMenu.Item onclick={() => sub && showDefinition(okind, fsch.name, nm, sub)}>Show Definition</ContextMenu.Item>
                              <ContextMenu.Item onclick={() => sub && alterObject(okind, fsch.name, nm, sub)}>Alter…</ContextMenu.Item>
                              {#if fk === 'p' || fk === 'fn'}
                                <ContextMenu.Item variant="destructive" onclick={() => stmtTab(`Drop ${nm}`, `DROP ${fk === 'p' ? 'PROCEDURE' : 'FUNCTION'} IF EXISTS ${selected ? qualified(selected.system, fsch.name, nm) : nm};`, db.name)}>Drop</ContextMenu.Item>
                              {:else}
                                <ContextMenu.Item variant="destructive" onclick={() => stmtTab(`Drop ${nm}`, `DROP ${fk === 'v' ? 'VIEW' : 'TRIGGER'} IF EXISTS ${selected ? qualified(selected.system, fsch.name, nm) : nm};`, db.name)}>Drop</ContextMenu.Item>
                              {/if}
                            {/if}
                            <ContextMenu.Separator />
                            <ContextMenu.Item onclick={() => copyName(nm)}>Copy Name</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => selected && copyName(`${quoteIdent(selected.system, fsch.name)}.${quoteIdent(selected.system, nm)}`)}>Copy Qualified Name</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => sub && explorer.refresh(sub, { kind: 'schema', schema: fsch.name })}>Refresh</ContextMenu.Item>
                          </ContextMenu.Content>
                        {/if}
                      {/snippet}
                      {@const isTblLike = fk === 't' || fk === 'v'}
                      {@render row({
                        key: `${folderKey}:${nm}`,
                        depth: 3,
                        glyph: glyph as string,
                        color: fk === 't' ? C.table : fk === 'v' ? C.view : fk === 'tg' ? C.trig : fk === 'sq' ? C.seq : fk === 'p' ? C.proc : C.func,
                        name: nm,
                        expandable: isTblLike,
                        dragData: fk === 't' ? JSON.stringify({ schema: fsch.name, table: nm }) : undefined,
                        onClick: isTblLike && sub ? () => { toggle(`${folderKey}:${nm}`); void explorer.loadTableDetail(sub, fsch.name, nm) } : undefined,
                        onDblClick: fk === 't' && sub ? () => tabs.openTableViewer(sub, fsch.name, nm) : undefined,
                      }, fk === 'sq' ? undefined : fObjMenu)}
                      <!-- item 4: foreign-database tables/views expand to their columns too -->
                      {#if isTblLike && sub && expanded.has(`${folderKey}:${nm}`)}
                        {@const fdetail = fsc.tableDetails[nm]}
                        {#if explorer.isLoading(sub, `table:${fsch.name}.${nm}`)}
                          <div class="mono" style="padding-left:calc(var(--px-6) + 4 * var(--px-15));font-size:var(--px-10);color:var(--muted)">loading…</div>
                        {:else if fdetail}
                          {#each fdetail.columns ?? [] as col (col.name)}
                            {#snippet fColMenu()}
                              <ContextMenu.Content class="w-48">
                                <ContextMenu.Item onclick={() => copyName(col.name)}>Copy Name</ContextMenu.Item>
                                <ContextMenu.Item onclick={() => copyName(`${nm}.${col.name}`)}>Copy as table.column</ContextMenu.Item>
                                <ContextMenu.Separator />
                                <ContextMenu.Item onclick={() => sub && tabs.openTableViewer(sub, fsch.name, nm, [{ col: col.name, op: '=', value: '' }])}>Set as Filter</ContextMenu.Item>
                                <ContextMenu.Separator />
                                <ContextMenu.Item onclick={() => sub && explorer.refresh(sub, { kind: 'table', schema: fsch.name, table: nm })}>Refresh</ContextMenu.Item>
                              </ContextMenu.Content>
                            {/snippet}
                            {@render row(
                              {
                                key: `${folderKey}:${nm}:col:${col.name}`,
                                depth: 4,
                                glyph: '▸',
                                color: C.col,
                                name: col.name,
                                meta: `${col.data_type}${col.is_pk ? ' · PK' : col.is_fk ? ' · FK' : ''}${!col.nullable && !col.is_pk ? ' · NN' : ''}`,
                              },
                              fColMenu,
                            )}
                          {/each}
                          {#if (fdetail.partitions ?? []).length > 0}
                            {@render row({
                              key: `${folderKey}:${nm}:parts`,
                              depth: 4,
                              glyph: '▤',
                              color: C.part,
                              name: 'Partitions',
                              meta: fdetail.partitions?.[0]?.key ?? String(fdetail.partitions?.length),
                              expandable: true,
                              onClick: () => toggle(`${folderKey}:${nm}:parts`),
                            })}
                            {#if expanded.has(`${folderKey}:${nm}:parts`)}
                              {#each fdetail.partitions ?? [] as pt (pt.name)}
                                {#snippet fPartitionMenu()}
                                  <ContextMenu.Content class="w-56">
                                    {#each partitionMenuItems(sub!, fsch.name, nm, pt, selected!.system, db.name) as it (it.label)}
                                      <ContextMenu.Item onclick={it.run}>{it.label}</ContextMenu.Item>
                                    {/each}
                                  </ContextMenu.Content>
                                {/snippet}
                                {@render row(
                                  {
                                    key: `${folderKey}:${nm}:pt:${pt.name}`,
                                    depth: 5,
                                    glyph: '▤',
                                    color: C.part,
                                    name: pt.name,
                                    meta: partMeta(pt),
                                  },
                                  fPartitionMenu,
                                )}
                              {/each}
                            {/if}
                          {/if}
                        {/if}
                      {/if}
                    {/each}
                  {/if}
                {/each}
                <!-- Indexes (schema-wide) for a foreign database — same as the main tree -->
                {@const fIxKey = `${skey}:indexes`}
                {@const fIxKeyC = idxKey(sub ?? '', fsch.name)}
                {@const fIxShown = (schemaIndexes[fIxKeyC] ?? []).filter((ix) => !ix.primary)}
                {#snippet fIdxFolderMenu()}
                  <ContextMenu.Content class="w-48">
                    <ContextMenu.Item onclick={() => sub && stmtTab('Create index', genCreateIndex(selected!.system, fsch.name, 'table_name', { name: 'idx_name', columns: ['column'], unique: false }), db.name)}>Create Index…</ContextMenu.Item>
                    <ContextMenu.Separator />
                    {@render filterMenuItems(fIxKey)}
                    <ContextMenu.Item onclick={() => sub && loadSchemaIndexes(sub, fsch.name, true)}>Refresh</ContextMenu.Item>
                  </ContextMenu.Content>
                {/snippet}
                {@render row({
                  key: fIxKey,
                  depth: 2,
                  glyph: '⌗',
                  color: C.idx,
                  name: 'Indexes',
                  meta: fIxShown.length ? String(fIxShown.length) : '',
                  head: true,
                  expandable: true,
                  filterable: true,
                  onClick: () => { toggle(fIxKey); if (sub) void loadSchemaIndexes(sub, fsch.name) },
                }, fIdxFolderMenu)}
                {#if expanded.has(fIxKey)}
                  {@render folderFilter(fIxKey, 2)}
                  {#if !fIxShown.length && schemaIndexLoading.has(fIxKeyC)}
                    {@render row({ key: `${fIxKey}:loading`, depth: 3, glyph: '·', color: C.col, name: 'Loading…', meta: '' })}
                  {:else if !fIxShown.length}
                    {@render row({ key: `${fIxKey}:empty`, depth: 3, glyph: '·', color: C.col, name: 'No indexes', meta: '' })}
                  {/if}
                  {#each fIxShown.filter((ix) => folderMatch(fIxKey, ix.name)) as ix (ix.table + '.' + ix.name)}
                    {#snippet fSIdxMenu()}
                      <ContextMenu.Content class="w-48">
                        <ContextMenu.Item onclick={() => sub && alterIndex(sub, selected!.system, fsch.name, ix.table, { name: ix.name, columns: ix.columns, unique: ix.unique }, db.name)}>Alter…</ContextMenu.Item>
                        <ContextMenu.Item onclick={() => copyName(ix.name)}>Copy Name</ContextMenu.Item>
                        <ContextMenu.Separator />
                        <ContextMenu.Item variant="destructive" onclick={() => sub && stmtTab(`Drop index ${ix.name}`, genDropIndex(selected!.system, fsch.name, ix.table, ix.name), db.name)}>Drop…</ContextMenu.Item>
                        <ContextMenu.Item onclick={() => sub && loadSchemaIndexes(sub, fsch.name, true)}>Refresh</ContextMenu.Item>
                      </ContextMenu.Content>
                    {/snippet}
                    {@render row({
                      key: `fix:${fsch.name}.${ix.table}.${ix.name}`,
                      depth: 3,
                      glyph: '⌗',
                      color: C.idx,
                      name: ix.name,
                      meta: `${ix.table}${ix.unique ? ' · UNIQUE' : ''}`,
                    }, fSIdxMenu)}
                  {/each}
                {/if}
              {/if}
            {/each}
          {/if}
        {/each}
      {/if}
    {/if}
  </div>

  <!-- Object Properties panel (T18) — thông tin object đang chọn -->
  {#if selProps}
    <div style="flex:none;border-top:var(--px-1) solid var(--border);background:var(--surface);padding:var(--px-7) var(--px-12)">
      <div style="font-size:var(--px-9_5);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:var(--px-3)">Properties</div>
      <div style="display:flex;align-items:center;gap:var(--px-8);flex-wrap:wrap">
        <span style="font-size:var(--px-9_5);font-weight:700;color:var(--hex-fff);background:var(--primary);border-radius:var(--px-3);padding:var(--px-1) var(--px-6)">{selProps.type}</span>
        <span class="mono" style="font-size:var(--px-12);font-weight:600;color:var(--text)">{selProps.name}</span>
      </div>
      {#if selProps.schema && selProps.schema !== selProps.name}
        <div class="mono" style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-2)">schema: {selProps.schema}</div>
      {/if}
    </div>
  {/if}

  <!-- bottom toolbar — dòng 155-166 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-1);padding:var(--px-5) var(--px-8);border-top:var(--px-1) solid var(--border);background:var(--header);color:var(--text2)">
    <span class="xbtn" onclick={() => selected && tabs.openTableDesigner(selected.id, cache?.schemas?.[0]?.name ?? '', '')} onkeydown={(e) => e.key === 'Enter' && selected && tabs.openTableDesigner(selected.id, cache?.schemas?.[0]?.name ?? '', '')} role="button" tabindex="0" title="New table">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="1.5"></rect><path d="M3 9h18M9 9v11" stroke-linecap="round"></path><path d="M16.5 14v5M14 16.5h5" stroke-linecap="round"></path></svg>
    </span>
    <span class="xbtn" onclick={() => newQuery(cache?.schemas?.[0]?.name ?? '')} onkeydown={(e) => e.key === 'Enter' && newQuery(cache?.schemas?.[0]?.name ?? '')} role="button" tabindex="0" title="Open query console">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9l3 3-3 3M13 15h4"></path></svg>
    </span>
    <span style="width:var(--px-1);height:var(--px-16);background:var(--border);margin:0 var(--px-3)"></span>
    <span class="xbtn" onclick={() => selected && importWizard.show(selected.id, cache?.schemas?.[0]?.name ?? '')} onkeydown={(e) => e.key === 'Enter' && selected && importWizard.show(selected.id, cache?.schemas?.[0]?.name ?? '')} role="button" tabindex="0" title="Import data from file">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"></path><path d="M5 21h14"></path></svg>
    </span>
    <!-- Export/dump → Generate Scripts (T15). Users & privileges (T23) còn ẩn. -->
    <span class="xbtn" onclick={() => selected && scriptsWizard.show(selected.id, cache?.schemas?.[0]?.name ?? '')} onkeydown={(e) => e.key === 'Enter' && selected && scriptsWizard.show(selected.id, cache?.schemas?.[0]?.name ?? '')} role="button" tabindex="0" title="Generate scripts (dump schema)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9M7 14l5 5 5-5"></path><path d="M5 3h14"></path></svg>
    </span>
    <!-- Backup & Restore (T22) -->
    <span class="xbtn" onclick={() => selected && backupWizard.show(selected.id, selected.system)} onkeydown={(e) => e.key === 'Enter' && selected && backupWizard.show(selected.id, selected.system)} role="button" tabindex="0" title="Backup & Restore">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"></path></svg>
    </span>
    <!-- Session Monitor + Users & privileges (T23) -->
    <span class="xbtn" onclick={() => selected && tabs.openAdminView(selected.id, 'sessions')} onkeydown={(e) => e.key === 'Enter' && selected && tabs.openAdminView(selected.id, 'sessions')} role="button" tabindex="0" title="Session Monitor">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4"></path></svg>
    </span>
    <span class="xbtn" onclick={() => selected && tabs.openAdminView(selected.id, 'users')} onkeydown={(e) => e.key === 'Enter' && selected && tabs.openAdminView(selected.id, 'users')} role="button" tabindex="0" title="Users & privileges">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"></circle><path d="M3 20c0-3 3-5 6-5s6 2 6 5"></path><path d="M17 7a3 3 0 0 1 0 6M22 20c0-2.5-2-4-4-4.5"></path></svg>
    </span>
    <span style="margin-left:auto;display:flex;gap:var(--px-1)">
      <span class="xbtn2" onclick={() => cache?.schemas?.forEach((s) => expandSchema(s.name))} onkeydown={(e) => e.key === 'Enter' && cache?.schemas?.forEach((s) => expandSchema(s.name))} role="button" tabindex="0" title="Expand all">⊕</span>
      <span class="xbtn2" onclick={collapseAll} onkeydown={(e) => e.key === 'Enter' && collapseAll()} role="button" tabindex="0" title="Collapse all">⊖</span>
    </span>
  </div>
</div>

{#if confirmState}
  <!-- backdrop click does NOT confirm/close; use Cancel / Confirm / Escape -->
  <div
    onkeydown={(e) => { if (e.key === 'Escape') confirmState = null; if (e.key === 'Enter') runConfirm() }}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:90"
  >
    <div
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);min-width:var(--px-320);max-width:var(--px-420);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
    >
      <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">{confirmState.title}</div>
      <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">{confirmState.body}</div>
      <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
        <span use:autofocus onclick={() => (confirmState = null)} onkeydown={(e) => e.key === 'Enter' && (confirmState = null)} role="button" tabindex="0" class="cfm-btn">Cancel</span>
        <span onclick={runConfirm} onkeydown={(e) => e.key === 'Enter' && runConfirm()} role="button" tabindex="0" class="cfm-btn danger">Confirm</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .tree-refresh-glyph {
    display: inline-block;
    line-height: 1;
  }
  .tree-refresh-glyph.spinning {
    animation: tree-refresh-spin 0.7s linear infinite;
  }
  @keyframes tree-refresh-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .xbtn {
    width: var(--px-26);
    height: var(--px-24);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-5);
    cursor: pointer;
  }
  .xbtn2 {
    width: var(--px-24);
    height: var(--px-24);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-5);
    cursor: pointer;
    font-size: var(--px-13);
  }
  .xbtn:hover,
  .xbtn2:hover {
    background: var(--hover);
  }
  .cfm-btn {
    font-size: var(--px-12);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-14);
    cursor: pointer;
  }
  .cfm-btn:hover {
    background: var(--hover);
  }
  .cfm-btn.danger {
    color: var(--hex-fff);
    background: var(--error);
    border-color: var(--error);
    font-weight: 600;
  }
</style>
