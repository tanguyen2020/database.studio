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
  import { newDatabaseWizard } from '$lib/stores/newdatabase.svelte'
  import { genRenameRoutine } from '$lib/sql/routines'
  import { scriptsWizard } from '$lib/stores/scripts.svelte'
  import { backupWizard } from '$lib/stores/backup.svelte'
  import * as chops from '$lib/sql/chops'
  import { toasts } from '$lib/stores/toast.svelte'
  import { quoteIdent, qualified, selectStarSql } from '$lib/sql/dialect'
  import { genAlterTable, genCreate, genDelete, genDrop, genDropDatabase, genForeignKey, genInsert, genRename, genRenameDatabase, genSelect, genTruncate, genUpdate } from '$lib/sql/ddl'
  import { generateScript, type DbObject, type ScriptMode } from '$lib/sql/scripts'
  import { createTemplate, type CreateKind } from '$lib/sql/create-templates'
  import { buildExportSelect } from '$lib/export/query'
  import { kafkaTopicRows, natsStreamRows } from '$lib/stream/explorer'
  import { toAlterStatement, type AlterKind } from '$lib/sql/alter'
  import { toSqlInsert } from '$lib/export/rows'
  import type { ColumnInfo, RoutineInfo, TableInfo } from '$lib/types'
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

  // Per-folder object filter: each Tables/Views/Procedures/Functions/Triggers/
  // Sequences folder has its own search box, keyed by the folder's tree key.
  const folderFilters = $state<Record<string, string>>({})
  function folderMatch(key: string, name: string): boolean {
    const q = (folderFilters[key] ?? '').trim().toLowerCase()
    return !q || name.toLowerCase().includes(q)
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

  // Cassandra (Phase 4b): cây keyspace lấy qua command chuyên biệt (cassandra_tree),
  // không đi qua explorer store quan hệ.
  const isCassandra = $derived(selected?.system === 'cassandra')
  let cassTree = $state<ipc.CassKeyspaceTree | null>(null)
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
      const kss = await ipc.cassandraKeyspaces(id)
      const ks = connections.byId(id)?.database || kss[0]
      cassTree = ks ? await ipc.cassandraTree(id, ks) : null
    } catch (e) {
      cassError = String(e)
      cassTree = null
    }
  }
  // Streaming (Kafka topics / NATS JetStream streams) — loaded via the explorer
  // store so the messages tabs can trigger a refresh after purge/delete.
  const isKafka = $derived(selected?.system === 'kafka')
  const isNats = $derived(selected?.system === 'nats')
  const streamCache = $derived(selected ? explorer.streaming[selected.id] : undefined)
  const topicRows = $derived(streamCache?.kafkaTopics ? kafkaTopicRows(streamCache.kafkaTopics) : [])
  const streamRows = $derived(streamCache?.natsStreams ? natsStreamRows(streamCache.natsStreams) : [])
  $effect(() => {
    const s = selected
    if (s?.connected && (s.system === 'kafka' || s.system === 'nats')) {
      untrack(() => void explorer.loadStreaming(s.id, s.system))
    }
  })

  async function deleteTopic(topic: string) {
    if (!selected || !confirm(`Delete topic "${topic}"? This drops the topic and all its data.`)) return
    try {
      await ipc.kafkaDeleteTopic(selected.id, topic)
      toasts.success(`Deleted topic ${topic}`, 'kafka')
      explorer.refreshStreaming(selected.id)
    } catch (e) {
      toasts.error(String(e), 'kafka')
    }
  }
  async function clearTopic(topic: string) {
    if (!selected || !confirm(`Clear all messages of topic "${topic}"? This cannot be undone.`)) return
    try {
      await ipc.kafkaPurgeTopic(selected.id, topic)
      toasts.success(`Cleared messages of ${topic}`, 'kafka')
      explorer.refreshStreaming(selected.id)
    } catch (e) {
      toasts.error(String(e), 'kafka')
    }
  }
  async function deleteSubject(stream: string, subject: string) {
    if (!selected || !confirm(`Remove subject "${subject}" from stream "${stream}"?`)) return
    try {
      await ipc.natsJsRemoveSubject(selected.id, stream, subject)
      toasts.success(`Removed subject ${subject}`, 'nats')
      explorer.refreshStreaming(selected.id)
    } catch (e) {
      toasts.error(String(e), 'nats')
    }
  }
  async function clearSubject(stream: string, subject: string) {
    if (!selected || !confirm(`Clear all messages of subject "${subject}"?`)) return
    try {
      await ipc.natsJsPurgeSubject(selected.id, stream, subject)
      toasts.success(`Cleared messages of ${subject}`, 'nats')
      explorer.refreshStreaming(selected.id)
    } catch (e) {
      toasts.error(String(e), 'nats')
    }
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
  function stmtTab(title: string, sql: string, database?: string) {
    if (!selected) return
    const tab = tabs.openSqlTab({ connectionId: selected.id, title, query: sql })
    if (database) {
      tab.state.database = database
      tabs.schedulePersist()
    }
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
    stmtTab(`Drop ${name}`, sql)
  }

  // T28 — Execute proc/func (dialog by signature) + Rename (dialect-aware).
  function execRoutine(schemaName: string, r: RoutineInfo) {
    if (selected) execRoutineWizard.show(selected.id, schemaName, r)
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

  // Cassandra DDL viewer (Phase 4b · T5) — native CQL sinh từ metadata thật.
  async function cassDdlTab(table: string) {
    if (!selected || !cassTree) return
    try {
      const ddl = await ipc.cassandraTableDdl(selected.id, cassTree.keyspace, table)
      tabs.openSqlTab({ connectionId: selected.id, title: `${table} DDL`, query: ddl })
    } catch (e) {
      toasts.error(`${e}`)
    }
  }

  function cassSelectTab(table: string) {
    if (!selected || !cassTree) return
    tabs.openSqlTab({
      connectionId: selected.id,
      title: table,
      query: `SELECT * FROM ${cassTree.keyspace}.${table} LIMIT 100;`,
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
  } as const

  // Folder icon for database nodes (DataGrip-style) — inline SVG, uses currentColor.
  const DB_FOLDER_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/></svg>'

  interface RowProps {
    key: string
    depth: number
    glyph: string
    /** optional inline SVG shown instead of the mono glyph (e.g. folder icon) */
    svg?: string
    color: string
    name: string
    meta?: string
    head?: boolean
    expandable?: boolean
    locked?: boolean
    /** if set, the row is draggable and carries this payload for the ER canvas */
    dragData?: string
    /** leaf rows (Kafka topic / NATS subject) act on a single click, not dbl */
    openOnSingleClick?: boolean
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
      <span class="mono" style="font-size:var(--px-12_5);font-weight:{p.head ? 700 : 500};color:{sel || p.head ? 'var(--text)' : 'var(--text2)'};overflow:hidden;text-overflow:ellipsis">{p.name}</span>
      {#if p.locked}<span style="font-size:var(--px-9)" title="System table — read-only">🔒</span>{/if}
      <span class="mono" style="font-size:var(--px-10);color:var(--muted);margin-left:auto">{p.meta ?? ''}</span>
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

<!-- per-folder object filter (item 1) — small search box under a folder header -->
{#snippet folderFilter(key: string, depth: number)}
  <div style="display:flex;align-items:center;padding:var(--px-2) var(--px-6) var(--px-3);padding-left:calc(var(--px-6) + {depth} * var(--px-15))">
    <input
      value={folderFilters[key] ?? ''}
      oninput={(e) => (folderFilters[key] = e.currentTarget.value)}
      onclick={(e) => e.stopPropagation()}
      placeholder="Filter…"
      aria-label="Filter items"
      style="width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-7);color:var(--text);font-size:var(--px-11);outline:none"
    />
  </div>
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
      onclick={() => selected && explorer.refresh(selected.id, { kind: 'connection' })}
      onkeydown={(e) => e.key === 'Enter' && selected && explorer.refresh(selected.id, { kind: 'connection' })}
      role="button"
      tabindex="0"
      title="Refresh"
      style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-13)"
    >⟳</span>
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

  <!-- tree — dòng 143-152 -->
  <div style="flex:1;overflow:auto;padding:0 var(--px-6) var(--px-10)">
    {#if !selected}
      <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">
        Select a connection to view its structure
      </div>
    {:else if !selected.connected}
      <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">
        <p>Not connected.</p>
        <div
          onclick={() => selected && connections.connect(selected.id)}
          onkeydown={(e) => e.key === 'Enter' && selected && connections.connect(selected.id)}
          role="button"
          tabindex="0"
          style="margin-top:var(--px-6);color:var(--primary);cursor:pointer"
        >Connect</div>
      </div>
    {:else if cache?.error}
      <div style="padding:var(--px-12);font-size:var(--px-11_5);color:var(--error)">{cache.error}</div>
    {:else if isCassandra}
      <!-- Cassandra keyspace tree (Phase 4b) — cassandra_tree, PK/CK meta -->
      {#if cassError}
        <div style="padding:var(--px-12);font-size:var(--px-11_5);color:var(--error)">{cassError}</div>
      {:else if cassTree}
        {@const ksKey = `cass:ks`}
        {@render row({ key: ksKey, depth: 0, glyph: '▤', color: C.schema, name: cassTree.keyspace, meta: 'keyspace', head: true, expandable: true, onClick: () => toggle(ksKey) })}
        {#if expanded.has(ksKey)}
          <!-- Tables -->
          {@const tKey = `cass:tables`}
          {@render row({ key: tKey, depth: 1, glyph: '▤', color: C.folder, name: 'Tables', meta: String(cassTree.tables.length), head: true, expandable: true, onClick: () => toggle(tKey) })}
          {#if expanded.has(tKey)}
            {#each cassTree.tables as t (t.name)}
              {@const tbKey = `cass:t:${t.name}`}
              {#snippet cassMenu()}
                <ContextMenu.Content>
                  <ContextMenu.Item onclick={() => cassSelectTab(t.name)}>SELECT * (LIMIT 100)</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => cassDdlTab(t.name)}>View DDL (CQL)</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row({ key: tbKey, depth: 2, glyph: '▦', color: C.table, name: t.name, expandable: true, onClick: () => toggle(tbKey), onDblClick: () => cassSelectTab(t.name) }, cassMenu)}
              {#if expanded.has(tbKey)}
                {#each t.columns as c (c.name)}
                  {@render row({ key: `cass:c:${t.name}.${c.name}`, depth: 3, glyph: '▸', color: C.col, name: c.name, meta: colMeta(c) })}
                {/each}
              {/if}
            {/each}
          {/if}
          <!-- Materialized Views -->
          {#if cassTree.views.length}
            {@const vKey = `cass:views`}
            {@render row({ key: vKey, depth: 1, glyph: '◫', color: C.view, name: 'Materialized Views', meta: String(cassTree.views.length), head: true, expandable: true, onClick: () => toggle(vKey) })}
            {#if expanded.has(vKey)}
              {#each cassTree.views as v (v.name)}
                {@render row({ key: `cass:v:${v.name}`, depth: 2, glyph: '◫', color: C.view, name: v.name, meta: v.base_table })}
              {/each}
            {/if}
          {/if}
          <!-- User Types -->
          {#if cassTree.types.length}
            {@const uKey = `cass:types`}
            {@render row({ key: uKey, depth: 1, glyph: '▢', color: C.folder, name: 'User Types', meta: String(cassTree.types.length), head: true, expandable: true, onClick: () => toggle(uKey) })}
            {#if expanded.has(uKey)}
              {#each cassTree.types as ty (ty.name)}
                {@render row({ key: `cass:u:${ty.name}`, depth: 2, glyph: '▢', color: C.col, name: ty.name, meta: 'udt' })}
              {/each}
            {/if}
          {/if}
          <!-- Functions -->
          {#if cassTree.functions.length}
            {@const fKey = `cass:fns`}
            {@render row({ key: fKey, depth: 1, glyph: 'ƒ', color: C.folder, name: 'Functions', meta: String(cassTree.functions.length), head: true, expandable: true, onClick: () => toggle(fKey) })}
            {#if expanded.has(fKey)}
              {#each cassTree.functions as fn (fn.signature)}
                {@render row({ key: `cass:f:${fn.signature}`, depth: 2, glyph: 'ƒ', color: C.col, name: fn.name, meta: fn.kind === 'aggregate' ? 'uda' : 'udf' })}
              {/each}
            {/if}
          {/if}
          <!-- Secondary Indexes -->
          {#if cassTree.indexes.length}
            {@const iKey = `cass:idx`}
            {@render row({ key: iKey, depth: 1, glyph: '⌗', color: C.idx, name: 'Secondary Indexes', meta: String(cassTree.indexes.length), head: true, expandable: true, onClick: () => toggle(iKey) })}
            {#if expanded.has(iKey)}
              {#each cassTree.indexes as ix (ix.name)}
                {@render row({ key: `cass:i:${ix.name}`, depth: 2, glyph: '⌗', color: C.idx, name: ix.name, meta: ix.kind === 'CUSTOM' ? 'SASI' : ix.target })}
              {/each}
            {/if}
          {/if}
          <!-- replication (properties) -->
          {#if cassTree.replication}
            {@render row({ key: `cass:repl`, depth: 1, glyph: '⚙', color: C.col, name: 'replication', meta: cassTree.replication })}
          {/if}
        {/if}
      {:else}
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">Loading keyspace…</div>
      {/if}
    {:else if isKafka}
      <!-- Kafka: each topic (click → messages; ctx: view/clear/delete) -->
      {#if streamCache?.error}
        <div style="padding:var(--px-12);font-size:var(--px-11_5);color:var(--error)">{streamCache.error}</div>
      {:else if streamCache?.loading && !streamCache?.kafkaTopics}
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">Loading topics…</div>
      {:else if topicRows.length === 0}
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">No topics</div>
      {:else}
        {#each topicRows as t (t.name)}
          {#snippet topicMenu()}
            <ContextMenu.Content class="w-52">
              <ContextMenu.Item onclick={() => selected && tabs.openKafkaTool(selected.id, 'kafka-consumer', t.name)}>View messages</ContextMenu.Item>
              <ContextMenu.Item onclick={() => selected && tabs.openKafkaTool(selected.id, 'kafka-producer', t.name)}>Produce message…</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => clearTopic(t.name)}>Clear messages</ContextMenu.Item>
              <ContextMenu.Item onclick={() => deleteTopic(t.name)}>Delete topic</ContextMenu.Item>
            </ContextMenu.Content>
          {/snippet}
          {@render row(
            { key: `kafka:t:${t.name}`, depth: 0, glyph: '▤', color: C.table, name: t.name, meta: t.meta, openOnSingleClick: true, onClick: () => selected && tabs.openKafkaTool(selected.id, 'kafka-consumer', t.name) },
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
        <div style="padding:var(--px-16) var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">No JetStream streams</div>
      {:else}
        {#each streamRows as s (s.name)}
          {@const sKey = `nats:s:${s.name}`}
          {@render row({ key: sKey, depth: 0, glyph: '▤', color: C.folder, name: s.name, meta: s.meta, head: true, expandable: true, onClick: () => toggle(sKey) })}
          {#if expanded.has(sKey)}
            {#each s.subjects as sub (sub.subject)}
              {#snippet subjectMenu()}
                <ContextMenu.Content class="w-52">
                  <ContextMenu.Item onclick={() => selected && tabs.openNatsSubject(selected.id, s.name, sub.subject)}>View messages</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => clearSubject(s.name, sub.subject)}>Clear messages</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => deleteSubject(s.name, sub.subject)}>Delete subject</ContextMenu.Item>
                </ContextMenu.Content>
              {/snippet}
              {@render row(
                { key: `nats:sub:${s.name}:${sub.subject}`, depth: 1, glyph: '✉', color: C.seq, name: sub.subject, openOnSingleClick: true, onClick: () => selected && tabs.openNatsSubject(selected.id, s.name, sub.subject) },
                subjectMenu,
              )}
            {/each}
          {/if}
        {/each}
      {/if}
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
            {#if schemaIsDatabase}
              <ContextMenu.Item onclick={() => selected && tabs.openSchemaCompare(selected.id, { tgtConnId: selected.id, srcDb: schema.name })}>Compare Databases…</ContextMenu.Item>
              <ContextMenu.Item onclick={() => selected && stmtTab(`Rename database ${schema.name}`, genRenameDatabase(selected.system, schema.name))}>Rename…</ContextMenu.Item>
              <ContextMenu.Item variant="destructive" onclick={() => selected && stmtTab(`Drop database ${schema.name}`, genDropDatabase(selected.system, schema.name))}>Drop Database…</ContextMenu.Item>
            {/if}
            <ContextMenu.Item onclick={() => selected && explorer.refresh(selected.id, { kind: 'schema', schema: schema.name })}>Refresh</ContextMenu.Item>
          </ContextMenu.Content>
        {/snippet}
        {@render row({
          key: `s:${schema.name}`,
          depth: base,
          glyph: schemaIsDatabase ? '' : '▤',
          svg: schemaIsDatabase ? DB_FOLDER_SVG : undefined,
          color: schemaIsDatabase ? C.folder : C.schema,
          name: schema.name,
          meta: explorer.isLoading(selected.id, `schema:${schema.name}`) ? '…' : schemaIsDatabase ? 'database' : 'schema',
          head: true,
          expandable: true,
          onClick: () => expandSchema(schema.name),
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
            onClick: () => toggle(`f:${schema.name}:tables`),
          }, tablesFolderMenu)}
          {#if searching || expanded.has(`f:${schema.name}:tables`)}
            {@render folderFilter(tKey, base + 1)}
            {#each tables as t (t.name)}
              {@const tbOpen = expanded.has(`t:${schema.name}.${t.name}`)}
              {@const detail = sc.tableDetails[t.name]}
              {#snippet tableMenu()}
                <ContextMenu.Content class="w-52">
                  <ContextMenu.Item onclick={() => openData(schema.name, t)}>Open Data</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && importWizard.show(selected.id, schema.name)}>Import Data…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && exportWizard.showTable(selected.id, schema.name, t.name)}>Export Data…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && copyWizard.show(selected.id, schema.name, t.name)}>Copy to…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && testDataWizard.show(selected.id, schema.name, t.name)}>Generate Test Data…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => newQuery(schema.name, t.name)}>New Query</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => selected && tabs.openTableDesigner(selected.id, schema.name, t.name)}>Design Table</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => stmtTab(`Alter ${t.name}`, genAlterTable(selected!.system, schema.name, t.name), dbForSchema(schema.name))}>Alter Table…</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => selected && tabs.openIndexManager(selected.id, schema.name, t.name)}>Manage Indexes & FKs…</ContextMenu.Item>
                  <ContextMenu.Item
                    onclick={() => stmtTab(`Rename ${t.name}`, genRename(selected!.system, schema.name, t.name), dbForSchema(schema.name))}
                  >
                    Rename…
                  </ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => genSqlTab('select', schema.name, t.name)}>Generate SQL · SELECT</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => genSqlTab('insert', schema.name, t.name)}>Generate SQL · INSERT</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => genSqlTab('update', schema.name, t.name)}>Generate SQL · UPDATE</ContextMenu.Item>
                  <ContextMenu.Item onclick={() => genSqlTab('delete', schema.name, t.name)}>Generate SQL · DELETE</ContextMenu.Item>
                  <ContextMenu.Sub>
                    <ContextMenu.SubTrigger>Generate Scripts</ContextMenu.SubTrigger>
                    <ContextMenu.SubContent class="w-44">
                      <ContextMenu.Item onclick={() => genTableScript(schema.name, t.name, 'structure')}>Structure Only</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => genTableScript(schema.name, t.name, 'data')}>Data Only</ContextMenu.Item>
                      <ContextMenu.Item onclick={() => genTableScript(schema.name, t.name, 'both')}>Structure and Data</ContextMenu.Item>
                    </ContextMenu.SubContent>
                  </ContextMenu.Sub>
                  <ContextMenu.Item onclick={() => genSqlTab('ddl', schema.name, t.name)}>View DDL</ContextMenu.Item>
                  {#if isClickhouse}
                    <ContextMenu.Item onclick={() => chTtl.show(selected!.id, schema.name, t.name)}>TTL Policy…</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`Optimize ${t.name}`, chops.optimizeFinal(schema.name, t.name))}>Optimize Table (FINAL)</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`${t.name} · partitions`, chops.showPartitions(t.name))}>Show Partitions</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`${t.name} · engine`, chops.showEngine(t.name))}>Show Engine / Settings</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`${t.name} · mutations`, chops.showMutations(t.name))}>Show Mutations</ContextMenu.Item>
                    {#if chops.needsFinal(t.engine)}
                      <ContextMenu.Item onclick={() => stmtTab(`${t.name} · FINAL`, `SELECT * FROM ${quoteIdent(selected!.system, t.name)} FINAL LIMIT 100;`)}>Preview (SELECT … FINAL)</ContextMenu.Item>
                    {/if}
                    <ContextMenu.Item onclick={() => stmtTab(`Detach partition · ${t.name}`, chops.detachPartition(schema.name, t.name))}>Detach Partition…</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => stmtTab(`Freeze · ${t.name}`, chops.freezePartition(schema.name, t.name))}>Freeze (Backup) Partition</ContextMenu.Item>
                    <ContextMenu.Item variant="destructive" onclick={() => stmtTab(`Drop partition · ${t.name}`, chops.dropPartition(schema.name, t.name))}>Drop Partition…</ContextMenu.Item>
                  {/if}
                  <ContextMenu.Separator />
                  <ContextMenu.Item onclick={() => copyName(t.name)}>Copy Name</ContextMenu.Item>
                  <ContextMenu.Item
                    onclick={() => copyName(`${quoteIdent(selected!.system, schema.name)}.${quoteIdent(selected!.system, t.name)}`)}
                  >
                    Copy Qualified Name
                  </ContextMenu.Item>
                  <ContextMenu.Item onclick={() => copyDdl(schema.name, t.name)}>Copy DDL</ContextMenu.Item>
                  <ContextMenu.Separator />
                  <ContextMenu.Item
                    onclick={() => selected && explorer.refresh(selected.id, { kind: 'table', schema: schema.name, table: t.name })}
                  >
                    Refresh
                  </ContextMenu.Item>
                  <ContextMenu.Separator />
                  {#if !t.locked}
                    <ContextMenu.Item
                      variant="destructive"
                      onclick={() => stmtTab(`Truncate ${t.name}`, genTruncate(selected!.system, schema.name, t.name), dbForSchema(schema.name))}
                    >
                      Truncate
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      variant="destructive"
                      onclick={() => stmtTab(`Drop ${t.name}`, genDrop(selected!.system, schema.name, t.name), dbForSchema(schema.name))}
                    >
                      Drop
                    </ContextMenu.Item>
                  {/if}
                </ContextMenu.Content>
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
                {/if}
              {/if}
            {/each}
          {/if}

          <!-- Views -->
          {#snippet viewsFolderMenu()}
            <ContextMenu.Content class="w-48">
              <ContextMenu.Item onclick={() => createObject('view', schema.name)}>Create View…</ContextMenu.Item>
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
              {#snippet createFnFolderMenu()}
                <ContextMenu.Content class="w-48">
                  <ContextMenu.Item onclick={() => createObject('function', schema.name)}>Create Function…</ContextMenu.Item>
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
                onClick: () => toggle(`f:${schema.name}:tvf`),
              }, createFnFolderMenu)}
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
                onClick: () => toggle(`f:${schema.name}:scalar`),
              }, createFnFolderMenu)}
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

          {#if isPg}
            <!-- Sequences (PG only) -->
            {#snippet seqsFolderMenu()}
              <ContextMenu.Content class="w-48">
                <ContextMenu.Item onclick={() => createObject('sequence', schema.name)}>Create Sequence…</ContextMenu.Item>
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
              {@render row({ key: skey, depth: 1, glyph: '▤', color: C.schema, name: fsch.name, meta: 'schema', head: true, expandable: true, onClick: () => { toggle(skey); if (sub && !fsc?.tables) void explorer.loadSchemaChildren(sub, fsch.name) } }, fSchemaMenu)}
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
                      <ContextMenu.Item onclick={() => sub && explorer.refresh(sub, { kind: 'schema', schema: fsch.name })}>Refresh</ContextMenu.Item>
                    </ContextMenu.Content>
                  {/snippet}
                  {@render row({ key: folderKey, depth: 2, glyph: glyph as string, color: C.folder, name: label as string, meta: String((items as unknown[]).length), head: true, expandable: true, onClick: () => toggle(folderKey) }, fFolderMenu)}
                  {#if expanded.has(folderKey)}
                    {#each items as it (('name' in (it as object) ? (it as { name: string }).name : String(it)))}
                      {@const nm = (it as { name: string }).name}
                      {#snippet fObjMenu()}
                        <ContextMenu.Content class="w-52">
                          {#if fk === 't' || fk === 'v'}
                            <ContextMenu.Item onclick={() => sub && tabs.openTableViewer(sub, fsch.name, nm)}>Open Data</ContextMenu.Item>
                          {/if}
                          <ContextMenu.Item onclick={() => newQuery(fsch.name, fk === 't' || fk === 'v' ? nm : undefined, db.name)}>New Query</ContextMenu.Item>
                          {#if fk === 't'}
                            <ContextMenu.Item onclick={() => sub && importWizard.show(sub, fsch.name)}>Import Data…</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => sub && exportWizard.showTable(sub, fsch.name, nm)}>Export Data…</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => sub && copyWizard.show(sub, fsch.name, nm)}>Copy to…</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => sub && testDataWizard.show(sub, fsch.name, nm)}>Generate Test Data…</ContextMenu.Item>
                            <ContextMenu.Separator />
                            <ContextMenu.Item onclick={() => sub && tabs.openTableDesigner(sub, fsch.name, nm)}>Design Table</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => selected && stmtTab(`Alter ${nm}`, genAlterTable(selected.system, fsch.name, nm), db.name)}>Alter Table…</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => sub && tabs.openIndexManager(sub, fsch.name, nm)}>Manage Indexes & FKs…</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => selected && stmtTab(`Rename ${nm}`, genRename(selected.system, fsch.name, nm), db.name)}>Rename…</ContextMenu.Item>
                            <ContextMenu.Separator />
                            <ContextMenu.Item onclick={() => genSqlTab('select', fsch.name, nm, sub, db.name)}>Generate SQL · SELECT</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => genSqlTab('insert', fsch.name, nm, sub, db.name)}>Generate SQL · INSERT</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => genSqlTab('update', fsch.name, nm, sub, db.name)}>Generate SQL · UPDATE</ContextMenu.Item>
                            <ContextMenu.Item onclick={() => genSqlTab('delete', fsch.name, nm, sub, db.name)}>Generate SQL · DELETE</ContextMenu.Item>
                            <ContextMenu.Sub>
                              <ContextMenu.SubTrigger>Generate Scripts</ContextMenu.SubTrigger>
                              <ContextMenu.SubContent class="w-44">
                                <ContextMenu.Item onclick={() => genTableScript(fsch.name, nm, 'structure', sub, db.name)}>Structure Only</ContextMenu.Item>
                                <ContextMenu.Item onclick={() => genTableScript(fsch.name, nm, 'data', sub, db.name)}>Data Only</ContextMenu.Item>
                                <ContextMenu.Item onclick={() => genTableScript(fsch.name, nm, 'both', sub, db.name)}>Structure and Data</ContextMenu.Item>
                              </ContextMenu.SubContent>
                            </ContextMenu.Sub>
                            <ContextMenu.Item onclick={() => genSqlTab('ddl', fsch.name, nm, sub, db.name)}>View DDL</ContextMenu.Item>
                          {/if}
                          {#if fk === 'v' || fk === 'p' || fk === 'fn' || fk === 'tg'}
                            {@const okind = fk === 'v' ? 'view' : fk === 'p' ? 'procedure' : fk === 'tg' ? 'trigger' : 'function'}
                            {#if fk === 'p' || fk === 'fn'}
                              <ContextMenu.Item onclick={() => sub && execRoutineWizard.show(sub, fsch.name, it as RoutineInfo)}>Execute…</ContextMenu.Item>
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
                          {#if fk === 't'}
                            <ContextMenu.Item onclick={() => copyDdl(fsch.name, nm, sub)}>Copy DDL</ContextMenu.Item>
                          {/if}
                          <ContextMenu.Item onclick={() => sub && explorer.refresh(sub, fk === 't' ? { kind: 'table', schema: fsch.name, table: nm } : { kind: 'schema', schema: fsch.name })}>Refresh</ContextMenu.Item>
                          {#if fk === 't'}
                            <ContextMenu.Separator />
                            <ContextMenu.Item variant="destructive" onclick={() => selected && stmtTab(`Truncate ${nm}`, genTruncate(selected.system, fsch.name, nm), db.name)}>Truncate</ContextMenu.Item>
                            <ContextMenu.Item variant="destructive" onclick={() => selected && stmtTab(`Drop ${nm}`, genDrop(selected.system, fsch.name, nm), db.name)}>Drop</ContextMenu.Item>
                          {/if}
                        </ContextMenu.Content>
                      {/snippet}
                      {@render row({
                        key: `${folderKey}:${nm}`,
                        depth: 3,
                        glyph: glyph as string,
                        color: fk === 't' ? C.table : fk === 'v' ? C.view : fk === 'tg' ? C.trig : fk === 'sq' ? C.seq : fk === 'p' ? C.proc : C.func,
                        name: nm,
                        dragData: fk === 't' ? JSON.stringify({ schema: fsch.name, table: nm }) : undefined,
                        onDblClick: fk === 't' && sub ? () => tabs.openTableViewer(sub, fsch.name, nm) : undefined,
                      }, fk === 'sq' ? undefined : fObjMenu)}
                    {/each}
                  {/if}
                {/each}
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

<style>
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
</style>
