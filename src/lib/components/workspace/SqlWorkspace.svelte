<script lang="ts">
  // SQL editor workspace for one tab: toolbar (connection dropdown + Run/Cancel)
  // + CodeMirror + resizable split + result panel. Run is selection-aware (F5),
  // Ctrl+Enter runs the statement at the cursor.
  import SqlEditor from '$lib/components/editor/SqlEditor.svelte'
  import SqliteFileHeader from './SqliteFileHeader.svelte'
  import ResultPanel from '$lib/components/results/ResultPanel.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import SearchSelect from '$lib/components/SearchSelect.svelte'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { results } from '$lib/stores/results.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { settings } from '$lib/stores/settings.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { snippets } from '$lib/stores/snippets.svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { formatSql } from '$lib/sql/format'
  import { mapErrorToDocument } from '$lib/sql/errors'
  import { lintSql, schemaLints, toCmDiagnostics } from '$lib/sql/lint-client'
  import { splitStatements, statementAtOffset, offsetToLineCol } from '$lib/sql/statements'
  import { parseTableRefs, resolveRef } from '$lib/sql/aliases'
  import { dangerousStatements, type DangerStmt } from '$lib/sql/danger'
  import { quoteIfReserved } from '$lib/sql/reserved'
  import { autofocus } from '$lib/actions/autofocus'
  import type { TabState } from '$lib/types'
  import type { Diagnostic } from '@codemirror/lint'
  import type { Completion, CompletionSource } from '@codemirror/autocomplete'
  import type { SQLNamespace } from '@codemirror/lang-sql'
  import { untrack, onMount } from 'svelte'

  interface Props {
    tab: TabState
  }

  let { tab }: Props = $props()

  let editor = $state<SqlEditor | null>(null)
  let connDropOpen = $state(false)
  const exec = $derived(results.get(tab.id))
  const profile = $derived(connections.byId(tab.connectionId))
  const isOrphan = $derived(tab.systemType === 'orphan' || (!!tab.connectionId && !profile))
  const disconnected = $derived(!!profile && !profile.connected)

  // ---- database dropdown (AUDIT-5 items 1 + 10) --------------------------------
  // Query editor shows the active connection AND lets you pick a database within
  // it. For PG/MSSQL databases come from list_databases; for MySQL/MariaDB/CH a
  // "database" is a schema (list_schemas). Selecting one that differs from the
  // connection's own DB attaches an internal sub-connection at run time, so the
  // connection dropdown keeps showing the base profile.
  let dbList = $state<string[]>([])
  const dbOptions = $derived(dbList.map((d) => ({ value: d, label: d })))
  const supportsDbSwitch = $derived(
    !isOrphan && ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse'].includes(tab.systemType),
  )
  const currentDb = $derived(((tab.state.database as string) || profile?.database || '').trim())

  // ---- schema dropdown ---------------------------------------------------------
  // Postgres/MSSQL split one database into multiple schemas; picking one scopes
  // autocomplete (and, for Postgres, the run-time search_path) to that schema.
  // Systems where a "database" already IS a schema (MySQL/MariaDB/ClickHouse) or
  // that have no schemas (SQLite) don't show this dropdown.
  const supportsSchemaSwitch = $derived(!isOrphan && ['postgres', 'mssql'].includes(tab.systemType))
  const selectedSchema = $derived(((tab.state.schema as string) || '').trim())

  $effect(() => {
    const p = profile
    if (!p?.connected || !supportsDbSwitch) return
    untrack(() => void loadDbList(p.id, p.system))
  })

  async function loadDbList(connId: string, system: string) {
    try {
      if (system === 'postgres' || system === 'mssql') {
        dbList = (await ipc.listDatabases(connId)).map((d) => d.name)
      } else {
        // MySQL/MariaDB/ClickHouse: a schema IS a database.
        dbList = (await ipc.listSchemas(connId)).map((s) => s.name)
      }
    } catch {
      dbList = []
    }
  }

  function pickDatabase(db: string) {
    tab.state.database = db
    tab.state.schema = '' // the new database has its own schemas — reset the pick
    tabs.schedulePersist()
  }

  function pickSchema(s: string) {
    tab.state.schema = s
    tabs.schedulePersist()
  }

  /** QueryEditor executes ONLY against an open connection. If the underlying
   *  connection was disconnected, block with a clear "reopen" message instead of
   *  silently (re)opening a per-tab connection — the user must Open Connection
   *  again first. Returns false (and toasts) when it's not safe to run. */
  function ensureConnected(): boolean {
    if (isOrphan) {
      toasts.error('This tab has no connection — reassign it first.')
      return false
    }
    if (!profile?.connected) {
      toasts.error(`Connection "${profile?.name ?? ''}" is closed. Please open the connection again.`)
      return false
    }
    return true
  }

  /** Effective connection to run against: the base connection, or an attached
   *  sub-connection when the tab points at a different database. */
  async function resolveRunConn(): Promise<string | null> {
    if (!tab.connectionId) return null
    // Item 6: each Query Editor tab runs on its OWN dedicated connection so a hung
    // query here can't block other tabs or the Explorer. Pass the tab's chosen
    // database (empty → the connection's own DB); the backend opens/reuses a
    // per-tab connection keyed by tab id.
    const db = supportsDbSwitch && currentDb && currentDb !== (profile?.database ?? '') ? currentDb : ''
    try {
      const cid = await ipc.openTabConnection(tab.connectionId, tab.id, db)
      // Postgres: scope unqualified names to the picked schema for this run. Re-applied
      // every run so it survives a cancel/reconnect heal. No pick → default search_path
      // (query as before). MSSQL has no session default-schema SET, so it's PG-only.
      if (tab.systemType === 'postgres' && selectedSchema) {
        const q = `"${selectedSchema.replace(/"/g, '""')}"`
        await ipc.execStatement(cid, `SET search_path TO ${q}, public`).catch(() => {})
      }
      return cid
    } catch (e) {
      toasts.error(`Cannot open a connection for this tab: ${e}`)
      return tab.connectionId
    }
  }

  // Connection ID the last result was run against — grid edits (apply_grid_changes)
  // must target the same database, not always the base connection.
  let runConnId = $state<string | null>(null)

  // Per-statement consistency (Cassandra only). Seeded from tab.state, persisted
  // back on change; passed to results.run so cql_exec overrides the default.
  // svelte-ignore state_referenced_locally
  let cqlConsistency = $state<string>((tab.state.consistency as string) || 'LOCAL_QUORUM')
  $effect(() => {
    if (tab.systemType === 'cassandra') tab.state.consistency = cqlConsistency
  })
  const runOpts = () =>
    tab.systemType === 'cassandra' ? { consistency: cqlConsistency } : undefined

  // ---- destructive-statement guard --------------------------------------------
  // A DELETE with no WHERE clause, or a TRUNCATE, wipes a whole table. Before
  // running one we pop an in-app confirm. Applies to relational SQL dialects.
  const RELATIONAL = ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse']
  let dangerPrompt = $state<{ items: DangerStmt[]; resolve: (ok: boolean) => void } | null>(null)

  /** Resolve true if it's safe to run, false if the user cancels. Only prompts
   *  for relational systems when the batch contains a destructive statement. */
  function confirmDangerous(statements: { sql: string }[]): Promise<boolean> {
    if (!RELATIONAL.includes(tab.systemType)) return Promise.resolve(true)
    const items = dangerousStatements(statements)
    if (items.length === 0) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      dangerPrompt = { items, resolve }
    })
  }

  function answerDanger(ok: boolean) {
    dangerPrompt?.resolve(ok)
    dangerPrompt = null
  }

  // initial buffer from persisted tab state (component remounts per tab via {#key})
  // svelte-ignore state_referenced_locally
  const initialQuery = (tab.state.query as string) ?? ''
  let savedQuery = initialQuery

  // ---- autocomplete schema (phase-2 §1): suggest tables of the ACTIVE database.
  // When a database is picked in the toolbar dropdown, introspect a sub-connection
  // attached to that database so completions reflect ITS tables — not the base
  // connection's own DB. `acConnId` is that connection id (base id when no switch).
  // untrack: loadSchemas() ghi explorer.cache đồng bộ (conn()/track()) → nếu để
  // trong vùng track của effect sẽ read+write cùng $state → effect_update_depth.
  let acConnId = $state<string | null>(null)
  $effect(() => {
    const p = profile
    const db = currentDb
    const switchable = supportsDbSwitch
    const picked = selectedSchema // re-run the loader when the schema pick changes
    if (!p?.connected) {
      acConnId = null
      return
    }
    untrack(() => {
      void (async () => {
        let cid = p.id
        if (switchable && db && db !== (p.database ?? '')) {
          try {
            cid = await ipc.attachDatabase(p.id, db)
          } catch {
            cid = p.id
          }
        }
        acConnId = cid
        await explorer.loadSchemas(cid)
        const schemas = explorer.cache[cid]?.schemas ?? []
        // Load the tables the completion needs: the default schema, plus — for
        // MySQL/MariaDB/ClickHouse where a "database" IS a schema — the picked one,
        // plus the schema chosen in the Schema dropdown (PG/MSSQL) so its tables
        // surface in autocomplete.
        const targets = new Set<string>()
        const def = schemas.find((s) => s.is_default) ?? schemas[0]
        if (def) targets.add(def.name)
        if (db && schemas.some((s) => s.name === db)) targets.add(db)
        if (picked && schemas.some((s) => s.name === picked)) targets.add(picked)
        for (const name of targets) await explorer.loadSchemaChildren(cid, name)
      })()
    })
  })

  // A completion for one table/column identifier. Reserved words (and non-bare
  // names) get a quoted `apply` so autocomplete inserts e.g. `order` / "order" /
  // [order] — otherwise the query/JOIN would be a syntax error — while the label
  // stays plain so prefix matching still works.
  // A completion for one table/column identifier. `detail` is shown right-aligned
  // and greyed so suggestions read explicitly — the schema/database for a table,
  // the data type for a column (like DataGrip's completion list).
  function identOption(name: string, type: 'type' | 'property', detail?: string): Completion {
    const q = quoteIfReserved(tab.systemType, name)
    // Boost schema identifiers above lang-sql's keyword completions so the popup
    // highlights (and Tab/Enter insert) the real table/column — columns rank
    // highest since they only surface in a column context (after a table/alias).
    // Must clear the matcher's -100 "not a full match" penalty (a prefix-matched
    // column would otherwise lose to an exact-match keyword like `or`).
    const boost = type === 'property' ? 200 : 150
    const base: Completion = { label: name, type, boost, ...(detail ? { detail } : {}) }
    return q === name ? base : { ...base, apply: q }
  }

  /** Nested { schema: { table: {self, children:[cols]} } } for lang-sql completion,
   *  with reserved identifiers quoted on insert (see identOption). Table entries
   *  show their schema/database and columns show their data type in the list. */
  const completionSchema = $derived.by((): SQLNamespace | undefined => {
    const cid = acConnId
    if (!cid) return undefined
    const cache = explorer.cache[cid]
    if (!cache) return undefined
    const ns: Record<string, SQLNamespace> = {}
    for (const [schemaName, sc] of Object.entries(cache.bySchema)) {
      const tables: Record<string, SQLNamespace> = {}
      for (const t of sc.tables ?? []) {
        const cols = sc.tableDetails[t.name]?.columns ?? []
        tables[t.name] = {
          self: identOption(t.name, 'type', schemaName),
          children: cols.map((c) => identOption(c.name, 'property', c.data_type)),
        }
      }
      ns[schemaName] = tables
    }
    return Object.keys(ns).length > 0 ? ns : undefined
  })

  // The database's own default schema (public / dbo) from introspection.
  const dbDefaultSchema = $derived.by(() => {
    const cid = acConnId
    if (!cid) return undefined
    const schemas = explorer.cache[cid]?.schemas ?? []
    return (schemas.find((s) => s.is_default) ?? schemas[0])?.name
  })

  // Schema anchor for autocomplete (which schema counts as "current", so its tables
  // insert unqualified). Postgres honours the picked schema (search_path makes the
  // unqualified name valid); MSSQL keeps the DB default so a picked non-default schema
  // still inserts qualified (schema.table) — correct, since MSSQL can't switch the
  // session default schema. Non-schema systems fall through to the DB default.
  const defaultSchema = $derived(
    tab.systemType === 'postgres' ? selectedSchema || dbDefaultSchema : dbDefaultSchema,
  )

  // Schema dropdown options (PG/MSSQL): every schema in the active database.
  const schemaOptions = $derived.by(() => {
    const cid = acConnId
    if (!cid) return [] as { value: string; label: string }[]
    return (explorer.cache[cid]?.schemas ?? []).map((s) => ({ value: s.name, label: s.name }))
  })

  const knownTables = $derived.by(() => {
    const cid = acConnId
    if (!cid) return []
    const cache = explorer.cache[cid]
    if (!cache) return []
    return Object.values(cache.bySchema).flatMap((sc) => (sc.tables ?? []).map((t) => t.name))
  })

  /** Find the schema that owns `table` (prefer the default), searching loaded
   *  table lists in the completion connection's cache. */
  function schemaOfTable(cid: string, table: string): string | undefined {
    const cache = explorer.cache[cid]
    if (!cache) return undefined
    const t = table.toLowerCase()
    const def = defaultSchema
    if (def && cache.bySchema[def]?.tables?.some((x) => x.name.toLowerCase() === t)) return def
    for (const [name, sc] of Object.entries(cache.bySchema)) {
      if (sc.tables?.some((x) => x.name.toLowerCase() === t)) return name
    }
    return def
  }

  /** Cached columns of a table, or `null` after kicking off a lazy load. The built-in
   *  schema completion can't fetch on demand, so column sources load here and the
   *  popup refreshes on the next keystroke. */
  function colsOf(cid: string, schema: string, table: string): { name: string; data_type: string }[] | null {
    const cols = explorer.cache[cid]?.bySchema[schema]?.tableDetails[table]?.columns
    if (!cols) {
      void explorer.loadTableDetail(cid, schema, table)
      return null
    }
    return cols
  }

  // Column completion. Two cases, both resolved against the current statement's
  // FROM/JOIN clauses (which `parseTableRefs` finds even when they sit AFTER the
  // cursor, e.g. `SELECT ▮ FROM users`). Columns load on demand; the source stays
  // SYNCHRONOUS (returns cached columns now, else kicks off the load + returns null —
  // a Promise would leave the popup pending so Tab/Enter couldn't accept).
  const columnSource: CompletionSource = (ctx) => {
    const cid = acConnId
    if (!cid) return null
    const doc = ctx.state.doc.toString()
    const stmt = statementAtOffset(doc, ctx.pos)
    const refs = parseTableRefs(stmt?.sql ?? doc)

    // Case 1 — after `alias.` / `table.` → that one table's columns.
    const dotted = ctx.matchBefore(/[a-zA-Z_][\w$]*\.[\w$]*$/)
    if (dotted) {
      const dot = dotted.text.lastIndexOf('.')
      const ref = resolveRef(refs, dotted.text.slice(0, dot))
      if (!ref) return null
      const schema = ref.schema ?? schemaOfTable(cid, ref.table)
      if (!schema) return null
      const cols = colsOf(cid, schema, ref.table)
      if (!cols || cols.length === 0) return null
      return {
        from: dotted.from + dot + 1,
        options: cols.map((c) => ({ ...identOption(c.name, 'property'), detail: c.data_type })),
        validFor: /^[\w$]*$/,
      }
    }

    // Case 2 — a bare identifier (no qualifier) → columns of EVERY table referenced
    // by the statement (SELECT/WHERE/ORDER BY … suggest the FROM tables' columns, the
    // way DataGrip does). Only fires once there is at least one FROM/JOIN table.
    if (refs.length === 0) return null
    const word = ctx.matchBefore(/[\w$]*$/)
    if (!word || (word.from === word.to && !ctx.explicit)) return null
    // don't fire right after a dot (handled by case 1) or a digit-only token
    if (word.from > 0 && ctx.state.sliceDoc(word.from - 1, word.from) === '.') return null
    const seen = new Set<string>()
    const options: Completion[] = []
    let anyLoaded = false
    for (const r of refs) {
      const schema = r.schema ?? schemaOfTable(cid, r.table)
      if (!schema) continue
      const cols = colsOf(cid, schema, r.table)
      if (!cols) continue
      anyLoaded = true
      const qualifier = r.alias ?? r.table
      for (const c of cols) {
        const key = `${qualifier}.${c.name}`
        if (seen.has(key)) continue
        seen.add(key)
        options.push({
          ...identOption(c.name, 'property'),
          // when several tables are in play, show which one each column belongs to
          detail: refs.length > 1 ? `${qualifier} · ${c.data_type}` : c.data_type,
        })
      }
    }
    if (!anyLoaded || options.length === 0) return null
    return { from: word.from, options, validFor: /^[\w$]*$/ }
  }

  // ---- lint tầng 1 (phase-2 §2b): backend parse-only + schema-aware client ----
  async function lintDoc(doc: string): Promise<Diagnostic[]> {
    if (!tab.connectionId || isOrphan) return []
    const backend = await lintSql(tab.systemType, doc)
    return [...toCmDiagnostics(doc, backend), ...schemaLints(doc, knownTables)]
  }

  function onChange(doc: string) {
    tab.state.query = doc
    tabs.setDirty(tab.id, doc !== savedQuery)
    tabs.schedulePersist()
  }

  async function run() {
    if (!editor || !tab.connectionId) {
      if (!tab.connectionId) toasts.error('Tab has no connection — pick one in the toolbar dropdown')
      return
    }
    editor.clearErrors()
    const doc = editor.getDoc()
    const range = editor.getSelectionRange()
    // Selection → run EXACTLY the selected text (split into statements, offsets
    // rebased to the document so error positions stay accurate); else run all.
    const statements =
      range.from === range.to
        ? splitStatements(doc)
        : splitStatements(doc.slice(range.from, range.to)).map((s) => {
            const from = s.from + range.from
            const { line, col } = offsetToLineCol(doc, from)
            return { ...s, from, to: s.to + range.from, startLine: line, startCol: col }
          })
    if (statements.length === 0) {
      toasts.show('No statement to run')
      return
    }
    if (!ensureConnected()) return
    if (!(await confirmDangerous(statements))) return
    const cid = await resolveRunConn()
    if (!cid) return
    runConnId = cid
    await results.run(tab.id, cid, statements, runOpts())
    showExecErrors()
  }

  // Focus the editor when a Query tab opens (e.g. Ctrl/Cmd+N) so you can type
  // immediately. Parent onMount runs after the child editor's view is created.
  onMount(() => {
    requestAnimationFrame(() => editor?.focus())
  })

  // Auto-run once when a tab is opened with autoRun (Execute routine dialog):
  // the editor is seeded with the CALL/SELECT and executed immediately so the
  // result grid shows the routine's output.
  let autoRan = false
  $effect(() => {
    if (autoRan || !editor || !tab.state.autoRun) return
    autoRan = true
    tab.state.autoRun = false
    untrack(() => void run())
  })

  async function runAtCursor() {
    if (!editor || !tab.connectionId) return
    editor.clearErrors()
    const doc = editor.getDoc()
    const stmt = statementAtOffset(doc, editor.getCursorOffset())
    if (!stmt) return
    if (!ensureConnected()) return
    if (!(await confirmDangerous([stmt]))) return
    const cid = await resolveRunConn()
    if (!cid) return
    runConnId = cid
    await results.run(tab.id, cid, [stmt], runOpts())
    showExecErrors()
  }

  function showExecErrors() {
    const e = results.get(tab.id)
    if (!e || !editor) return
    const errs = e.subResults
      .filter((s) => s.kind === 'error' && s.error && s.error.code !== 'CANCELLED')
      .map((s) => {
        const pos = mapErrorToDocument(s.statement, s.error!)
        // statement-level errors highlight the whole statement
        const stmtLines = s.statement.sql.split('\n')
        const endLine = s.statement.startLine + stmtLines.length - 1
        const endCol =
          stmtLines.length === 1
            ? s.statement.startCol + stmtLines[0].length
            : stmtLines[stmtLines.length - 1].length + 1
        return s.error!.position
          ? { line: pos.line, col: pos.col, message: s.error!.message }
          : { line: pos.line, col: pos.col, endLine, endCol, message: s.error!.message }
      })
    if (errs.length > 0) editor.showErrors(errs)
  }

  function cancel() {
    const cid = runConnId ?? tab.connectionId
    if (cid) void results.cancel(tab.id, cid)
  }


  // Đồng hồ "running Ns" + cảnh báo query chạy lâu (> ngưỡng Settings) — T11.
  let nowMs = $state(Date.now())
  let longRunWarned = $state(false)
  const runningSecs = $derived(
    exec?.running && exec.startedAt ? Math.max(0, Math.floor((nowMs - exec.startedAt) / 1000)) : 0,
  )
  $effect(() => {
    if (!exec?.running) {
      longRunWarned = false
      return
    }
    const iv = setInterval(() => {
      nowMs = Date.now()
      if (!longRunWarned && exec.startedAt && nowMs - exec.startedAt > settings.value.longRunningWarnMs) {
        longRunWarned = true
        toasts.show(`Query still running > ${Math.round(settings.value.longRunningWarnMs / 1000)}s — press Esc to cancel`)
      }
    }, 500)
    return () => clearInterval(iv)
  })

  // Format SQL (Ctrl+Shift+F) — dialect-aware, giữ 1 transaction để undo
  function doFormat() {
    if (!editor) return
    const doc = editor.getDoc()
    const formatted = formatSql(tab.systemType, doc)
    if (formatted !== doc) editor.setDoc(formatted)
  }

  // T21 — shortcut Ctrl+Shift+F từ App.svelte phát tín hiệu qua ui.formatTick;
  // chỉ tab đang active mới format (tránh format editor nền khi split).
  $effect(() => {
    void ui.formatTick
    if (ui.formatTick > 0 && tabs.active?.id === tab.id) untrack(() => doFormat())
  })

  // Explain (Ctrl+Shift+E) — show the Query Plan INSIDE the Result panel (a
  // "Query Plan" sub-tab), not a new editor tab. Runs on the SAME connection/
  // database/schema the query runs on (resolveRunConn) so it sees the right tables.
  async function runExplainSql(sql: string, actual: boolean) {
    if (!ensureConnected()) return
    const cid = await resolveRunConn()
    if (!cid) return
    await results.runExplain(tab.id, cid, sql, actual)
  }
  async function doExplain() {
    if (!editor || !tab.connectionId) return
    const doc = editor.getDoc()
    const stmt = statementAtOffset(doc, editor.getCursorOffset())
    if (!stmt) return
    await runExplainSql(stmt.sql, false)
  }
  const explain = $derived(results.explainOf(tab.id))
  // Capability drives the Actual toggle visibility inside the plan view.
  let explainCap = $state<ipc.EngineCapability | null>(null)
  $effect(() => {
    void tab.connectionId
    untrack(async () => {
      if (!tab.connectionId) {
        explainCap = null
        return
      }
      try {
        explainCap = await ipc.explainCapability(tab.connectionId)
      } catch {
        explainCap = null
      }
    })
  })
  function explainSetActual(actual: boolean) {
    const st = results.explainOf(tab.id)
    if (!st) return
    if (actual && !confirm('Actual Plan runs the query (ANALYZE). Write statements are rolled back on PostgreSQL and blocked on other engines. Continue?')) return
    void runExplainSql(st.sql, actual)
  }
  function explainReExplain() {
    const st = results.explainOf(tab.id)
    if (st) void runExplainSql(st.sql, st.actual)
  }
  function explainClose() {
    results.clearExplain(tab.id)
  }

  // Ctrl+S / Cmd+S — save the editor content to a .sql file via a native save
  // dialog (AUDIT-5 item 5). In the browser (demo/tests) fall back to saving a
  // named snippet, since there is no file system.
  async function saveSnippet() {
    if (!editor) return
    const sqlText = editor.getDoc().trim()
    if (!sqlText) return
    if (IS_TAURI) {
      const { save: saveFileDialog } = await import('@tauri-apps/plugin-dialog')
      const suggested = `${(tab.title || 'query').replace(/[^\w.-]+/g, '_')}.sql`
      const path = await saveFileDialog({ defaultPath: suggested, filters: [{ name: 'SQL', extensions: ['sql'] }] })
      if (!path) return
      try {
        await ipc.writeTextFile(path, sqlText.endsWith('\n') ? sqlText : `${sqlText}\n`)
        savedQuery = editor.getDoc()
        tabs.setDirty(tab.id, false)
        toasts.success(`Saved → ${path}`)
      } catch (e) {
        toasts.error(String(e))
      }
      return
    }
    const name = window.prompt('Snippet name:', tab.title)
    if (!name) return
    await snippets.save(name, sqlText, tab.systemType === 'orphan' ? null : tab.systemType)
    toasts.success(`Saved snippet "${name}"`)
  }

  function jump(line: number, col: number) {
    editor?.jumpTo(line, col)
  }

  // ---- editor/result resizable split ----
  let container = $state<HTMLDivElement | null>(null)
  let dragging = $state(false)

  function startDrag(e: PointerEvent) {
    dragging = true
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
  }

  function onDrag(e: PointerEvent) {
    if (!dragging || !container) return
    const rect = container.getBoundingClientRect()
    const h = Math.min(Math.max(e.clientY - rect.top, 120), rect.height - 100)
    ui.editorHeight = h
    ui.persistSizes()
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0" bind:this={container}>
  {#if isOrphan}
    <!-- orphaned banner — spec phase-1 §3 (badge xám ⚠ + Reassign) -->
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-6) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--panel);font-size:var(--px-12)">
      <SystemBadge system="orphan" />
      <span style="color:var(--text2)">Connection was deleted · tab is orphaned</span>
      <div style="margin-left:auto">
        <select
          class="wk-select"
          onchange={(e) => {
            const id = e.currentTarget.value
            if (id) tabs.reassign(tab.id, id)
          }}
        >
          <option value="">Reassign connection…</option>
          {#each connections.profiles as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </div>
    </div>
  {:else if disconnected}
    <!-- disconnected banner — SPEC_v2 §12 (không chặn nội dung) -->
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-6) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--panel);font-size:var(--px-12)">
      <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;background:var(--border2)"></span>
      <span style="color:var(--text2)">Disconnected</span>
      <div
        onclick={() => profile && connections.connect(profile.id)}
        onkeydown={(e) => e.key === 'Enter' && profile && connections.connect(profile.id)}
        role="button"
        tabindex="0"
        style="margin-left:auto;color:var(--primary);cursor:pointer"
      >Reconnect</div>
    </div>
  {/if}

  {#if tab.systemType === 'sqlite' && profile?.connected && tab.connectionId}
    <!-- SQLite file header + PRAGMA panel — dòng 197-227 -->
    <SqliteFileHeader
      connId={tab.connectionId}
      onRunSql={(sqlText) => {
        void results.run(tab.id, tab.connectionId!, splitStatements(sqlText))
      }}
    />
  {/if}

  <!-- editor toolbar — port dòng 230-262 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <!-- connection dropdown — dòng 231-250 -->
    <div style="position:relative">
      <div
        onclick={() => (connDropOpen = !connDropOpen)}
        onkeydown={(e) => e.key === 'Enter' && (connDropOpen = !connDropOpen)}
        role="button"
        tabindex="0"
        style="display:flex;align-items:center;gap:var(--px-7);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-4) var(--px-9);cursor:pointer"
      >
        <span style="display:flex;align-items:center;flex:none"><SystemIcon system={tab.systemType} size={15} /></span>
        <span style="font-size:var(--px-12);font-weight:600">{profile?.name ?? (isOrphan ? '(deleted)' : '— no connection —')}</span>
        <span style="color:var(--muted);font-size:var(--px-9)">▾</span>
      </div>
      {#if connDropOpen}
        <div onclick={() => (connDropOpen = false)} onkeydown={(e) => e.key === 'Escape' && (connDropOpen = false)} role="presentation" style="position:fixed;inset:0;z-index:39"></div>
        <div style="position:absolute;top:var(--px-34);left:0;z-index:40;min-width:var(--px-248);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-10);box-shadow:0 var(--px-16) var(--px-40) var(--rgba-0-0-0-_45);padding:var(--px-5)">
          <div style="font-size:var(--px-10);font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:var(--px-6) var(--px-9) var(--px-4)">Switch connection</div>
          {#each connections.profiles as p (p.id)}
            <div
              onclick={() => {
                tabs.setConnection(tab.id, p.id)
                connDropOpen = false
              }}
              onkeydown={(e) => e.key === 'Enter' && (tabs.setConnection(tab.id, p.id), (connDropOpen = false))}
              role="button"
              tabindex="0"
              class="wk-drop-row"
              style="display:flex;align-items:center;gap:var(--px-9);padding:var(--px-6) var(--px-9);border-radius:var(--px-7);cursor:pointer;background:{p.id === tab.connectionId ? 'var(--hover)' : 'transparent'}"
            >
              <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;flex:none;background:{p.connected ? systemMeta(p.system).accent : 'var(--sys-orphan-accent)'}"></span>
              <span style="flex:none;display:flex;align-items:center"><SystemIcon system={p.system} size={16} /></span>
              <div style="min-width:0">
                <div style="font-size:var(--px-12_5);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{p.name}</div>
                <div class="mono" style="font-size:var(--px-10);color:var(--muted)">{p.system === 'sqlite' ? p.sqlite_path || ':memory:' : `${p.host}:${p.port}`}</div>
              </div>
              <span style="margin-left:auto;flex:none;color:var(--primary);font-size:var(--px-12)">{p.id === tab.connectionId ? '✓' : ''}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- database dropdown (AUDIT-5 items 1 + 10) — searchable combobox to pick a
         DB within the connection (type to filter when there are many). -->
    {#if supportsDbSwitch && profile?.connected}
      <div style="display:flex;align-items:center;gap:var(--px-6)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none;color:var(--muted)"><ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"></path><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"></path></svg>
        <SearchSelect
          value={currentDb || null}
          options={dbOptions}
          placeholder="(database)"
          title="Database"
          onChange={(v) => v && pickDatabase(v)}
        />
      </div>
    {/if}

    <!-- schema dropdown — only for schema-based systems (Postgres/MSSQL); a
         database with multiple schemas. Scopes autocomplete (+ PG search_path). -->
    {#if supportsSchemaSwitch && profile?.connected && schemaOptions.length > 0}
      <div style="display:flex;align-items:center;gap:var(--px-6)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none;color:var(--muted)"><path d="M3 7h18M3 12h18M3 17h18"></path></svg>
        <SearchSelect
          value={selectedSchema || dbDefaultSchema || null}
          options={schemaOptions}
          placeholder="(schema)"
          title="Schema"
          onChange={(v) => v && pickSchema(v)}
        />
      </div>
    {/if}

    <!-- Run / Cancel — dòng 252-254 -->
    {#if exec?.running}
      <div
        onclick={cancel}
        onkeydown={(e) => e.key === 'Enter' && cancel()}
        role="button"
        tabindex="0"
        title="Cancel (Ctrl+F5 / Esc)"
        style="display:flex;align-items:center;gap:var(--px-7);background:var(--error);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-5) var(--px-13);cursor:pointer;font-weight:600;font-size:var(--px-12)"
      >
        <span>■</span><span>Cancel</span><span class="mono" style="opacity:.85;font-size:var(--px-10)">running {runningSecs}s</span>
      </div>
    {:else}
      <div
        onclick={run}
        onkeydown={(e) => e.key === 'Enter' && run()}
        role="button"
        tabindex="0"
        title="Run (F5) — runs the selection if any"
        style="display:flex;align-items:center;gap:var(--px-7);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-5) var(--px-13);cursor:{isOrphan || !tab.connectionId ? 'not-allowed' : 'pointer'};opacity:{isOrphan || !tab.connectionId ? 0.5 : 1};font-weight:600;font-size:var(--px-12)"
      >
        <span>▶</span><span>Run</span><span class="mono" style="opacity:.7;font-size:var(--px-10)">F5</span>
      </div>
    {/if}

    <!-- Format (Ctrl+Shift+F) + Explain (Ctrl+Shift+E, text — visual plan Phase 5) -->
    <div class="wk-tbtn" onclick={doFormat} onkeydown={(e) => e.key === 'Enter' && doFormat()} role="button" tabindex="0" title="Format SQL (Ctrl+Shift+F)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="14" y2="12"></line><line x1="4" y1="18" x2="18" y2="18"></line></svg>Format
    </div>
    <div class="wk-tbtn" onclick={doExplain} onkeydown={(e) => e.key === 'Enter' && doExplain()} role="button" tabindex="0" title="Explain (Ctrl+Shift+E) — visual query plan">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="20" x2="6" y2="13"></line><line x1="12" y1="20" x2="12" y2="8"></line><line x1="18" y1="20" x2="18" y2="11"></line></svg>Explain
    </div>
    {#if tab.systemType === 'cassandra'}
      <!-- Per-statement consistency level (CQL only) — overrides the connection default. -->
      <select
        class="mono"
        title="Consistency level for statements run from this editor"
        bind:value={cqlConsistency}
        style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-6);font-size:var(--px-11);color:var(--text)"
      >
        {#each ['LOCAL_QUORUM', 'QUORUM', 'ONE', 'TWO', 'THREE', 'ALL', 'LOCAL_ONE', 'EACH_QUORUM', 'ANY', 'SERIAL', 'LOCAL_SERIAL'] as lvl (lvl)}
          <option value={lvl}>{lvl}</option>
        {/each}
      </select>
      <!-- Ring (prototype dòng 257-259) — mở Ring Topology, màu accent Cassandra -->
      <div class="wk-tbtn" style="color:#1287B1" onclick={() => tab.connectionId && tabs.openCassandraRing(tab.connectionId)} onkeydown={(e) => e.key === 'Enter' && tab.connectionId && tabs.openCassandraRing(tab.connectionId)} role="button" tabindex="0" title="Ring Topology">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9" stroke-dasharray="3 3"></circle><circle cx="12" cy="3" r="2" fill="currentColor" stroke="none"></circle><circle cx="20" cy="17" r="2" fill="currentColor" stroke="none"></circle><circle cx="4" cy="17" r="2" fill="currentColor" stroke="none"></circle></svg>Ring
      </div>
    {/if}
    <div style="margin-left:auto">
      {#if exec && !exec.running}
        <span class="mono" style="font-size:var(--px-11);color:var(--muted)">{exec.totalMs} ms</span>
      {/if}
    </div>
  </div>

  <!-- editor -->
  <div style="height:{ui.editorHeight}px;flex:none">
    <SqlEditor
      bind:this={editor}
      value={initialQuery}
      system={tab.systemType}
      schema={completionSchema}
      {defaultSchema}
      {columnSource}
      lintSource={lintDoc}
      {onChange}
      onRun={run}
      onRunAtCursor={runAtCursor}
      onCancel={cancel}
      onFormat={doFormat}
      onExplain={doExplain}
      onSaveSnippet={saveSnippet}
    />
  </div>

  <!-- split handle editor/result -->
  <div
    style="flex:none;height:var(--px-5);cursor:row-resize;background:var(--border)"
    role="separator"
    aria-orientation="horizontal"
    onpointerdown={startDrag}
    onpointermove={onDrag}
    onpointerup={() => (dragging = false)}
  ></div>

  <!-- results -->
  <div style="min-height:0;flex:1;display:flex;flex-direction:column">
    {#if exec || explain}
      <ResultPanel
        {exec}
        connId={runConnId ?? tab.connectionId}
        active={tabs.active?.id === tab.id}
        accent={systemMeta(tab.systemType).accent}
        onJump={jump}
        onLoadMore={(idx) => results.fetchMoreCql(tab.id, idx)}
        {explain}
        capability={explainCap}
        onExplainActual={explainSetActual}
        onExplainReExplain={explainReExplain}
        onExplainClose={explainClose}
      />
    {:else}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">
        Run a query (F5) to see results · Ctrl+Enter runs the statement at the cursor
      </div>
    {/if}
  </div>
</div>

{#if dangerPrompt}
  <!-- Destructive-statement confirm. Backdrop click does NOT confirm/close;
       use Cancel / Run anyway / Escape. -->
  <div
    onkeydown={(e) => { if (e.key === 'Escape') answerDanger(false) }}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:90"
  >
    <div
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);min-width:var(--px-360);max-width:var(--px-520);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
    >
      <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-8)">
        <span style="color:var(--error);font-size:var(--px-16)">⚠</span>
        <span style="font-size:var(--px-14);font-weight:600;color:var(--text)">Delete all rows without a filter?</span>
      </div>
      <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-10)">
        {dangerPrompt.items.length === 1 ? 'This statement' : `${dangerPrompt.items.length} statements`} will remove every row from the target
        {dangerPrompt.items.length === 1 ? 'table' : 'tables'}. This cannot be undone.
      </div>
      <div style="max-height:var(--px-200);overflow:auto;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8);margin-bottom:var(--px-16)">
        {#each dangerPrompt.items as d (d.index)}
          <div class="mono" style="font-size:var(--px-11_5);color:var(--text);white-space:pre-wrap;word-break:break-word;padding:var(--px-2) 0">
            <span style="color:var(--error);font-weight:700">{d.kind === 'truncate' ? 'TRUNCATE' : 'DELETE (no WHERE)'}</span> · {d.sql}
          </div>
        {/each}
      </div>
      <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
        <span use:autofocus onclick={() => answerDanger(false)} onkeydown={(e) => e.key === 'Enter' && answerDanger(false)} role="button" tabindex="0" class="cfm-btn">Cancel</span>
        <span onclick={() => answerDanger(true)} onkeydown={(e) => e.key === 'Enter' && answerDanger(true)} role="button" tabindex="0" class="cfm-btn danger">Run anyway</span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* nút toolbar editor — dòng 255 */
  .wk-tbtn {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    color: var(--text2);
    font-size: var(--px-12);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-7);
    padding: var(--px-5) var(--px-10);
    cursor: pointer;
  }
  .wk-tbtn:hover,
  .wk-drop-row:hover {
    background: var(--hover);
  }
  .wk-select {
    background: var(--surface);
    border: var(--px-1) solid var(--input);
    border-radius: var(--px-5);
    padding: var(--px-2) var(--px-6);
    font-size: var(--px-11_5);
    color: var(--text);
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
