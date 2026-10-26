// Multi-tab system store. Every tab carries full context — there is no
// global "active connection". Persisted to SQLite storage via IPC.

import * as ipc from '$lib/ipc'
import { IS_TAURI } from '$lib/demo'
import type { SystemType, TabContentType, TabState } from '$lib/types'
import { baseConnId, connections } from './connections.svelte'
import { results } from './results.svelte'
import { explorer } from './explorer.svelte'
import { messagesSection } from '$lib/stream/workspace-systems'
import { LANGUAGE_LABEL, languageFor, searchProduct, type QueryLanguage } from '$lib/elastic/flavor'

const MAX_CLOSED_STACK = 20

let nextUntitled = 1

function uuid(): string {
  return crypto.randomUUID()
}

class TabsStore {
  tabs = $state<TabState[]>([])
  activeTabId = $state<string | null>(null)
  /** Split view (T11): null = 1 pane; 'v' = trái|phải; 'h' = trên/dưới. */
  splitDir = $state<null | 'v' | 'h'>(null)
  /** active tab của pane 1 (pane 0 dùng activeTabId). */
  activeTabId1 = $state<string | null>(null)
  /** pane đang focus (0/1) — quyết định tab.active + nơi mở tab mới. */
  activePane = $state<0 | 1>(0)
  /** stack of recently closed tabs for Ctrl+Shift+T */
  private closedStack: TabState[] = []
  /** tabs pending the save-before-close dialog */
  pendingClose = $state<TabState[] | null>(null)
  restored = $state(false)

  get active(): TabState | null {
    const id = this.activePane === 1 ? this.activeTabId1 : this.activeTabId
    return this.tabs.find((t) => t.id === id) ?? null
  }

  byId(id: string | null | undefined): TabState | null {
    return this.tabs.find((t) => t.id === id) ?? null
  }

  /** Tabs thuộc pane (0 mặc định cho tab chưa gắn pane). */
  tabsInPane(pane: 0 | 1): TabState[] {
    return this.tabs.filter((t) => (t.pane ?? 0) === pane)
  }

  activeInPane(pane: 0 | 1): TabState | null {
    return this.byId(pane === 1 ? this.activeTabId1 : this.activeTabId)
  }

  tabsForConnection(connId: string): TabState[] {
    return this.tabs.filter((t) => t.connectionId === connId)
  }

  // ---- open / activate -----------------------------------------------------

  /** New SQL editor tab. Inherits the active tab's connection unless given. */
  openSqlTab(opts?: {
    connectionId?: string | null
    title?: string
    query?: string
    activate?: boolean
    pane?: 0 | 1
    /** run the query automatically once the editor mounts (Execute routine) */
    autoRun?: boolean
    /** bind the tab to a specific database within the connection (runs there) */
    database?: string
    /** pre-select a schema (PG/MSSQL/Oracle — scopes autocomplete + search_path) */
    schema?: string
  }): TabState {
    const connId =
      opts?.connectionId !== undefined
        ? opts.connectionId
        : this.active?.connectionId ?? connections.selectedId
    const profile = connections.byId(connId)
    const pane = opts?.pane ?? (this.splitDir ? this.activePane : 0)
    const tab: TabState = {
      id: uuid(),
      connectionId: connId ?? null,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'sql-editor',
      title: opts?.title ?? `Untitled ${nextUntitled++}`,
      isPinned: false,
      isDirty: false,
      pane,
      state: {
        query: opts?.query ?? '',
        autoRun: opts?.autoRun ?? false,
        ...(opts?.database ? { database: opts.database } : {}),
        ...(opts?.schema ? { schema: opts.schema } : {}),
      },
    }
    this.tabs.push(tab)
    if (opts?.activate !== false) {
      this.activePane = pane
      if (pane === 1) this.activeTabId1 = tab.id
      else this.activeTabId = tab.id
    }
    this.schedulePersist()
    return tab
  }

  /** New Query Editor console, binding to the database currently selected in the
   *  Explorer tree when it belongs to the target connection (so the editor's
   *  Database dropdown pre-selects it). Shared by the sidebar "New query console"
   *  button, its context menu, and Ctrl/Cmd+T / Ctrl/Cmd+N.
   *  - `connectionId` given → open on that connection (an explicit context-menu
   *    pick on another connection); pass `useSelection: false` to ignore the tree.
   *  - `connectionId` omitted → target the selected database's connection, else
   *    inherit the active tab's / selected connection. */
  openQueryConsole(opts?: { connectionId?: string | null; useSelection?: boolean }): TabState {
    const dbSel = explorer.selectedDatabase
    const connId =
      opts?.connectionId !== undefined
        ? opts.connectionId
        : dbSel
          ? dbSel.base
          : this.active?.connectionId ?? connections.selectedId
    const useSel = opts?.useSelection !== false && dbSel && dbSel.base === connId
    const database = useSel ? dbSel!.database : undefined
    // Schema-based engines (PG/MSSQL/Oracle) also carry the selected schema, so the
    // editor's Schema dropdown pre-selects it (and Postgres scopes search_path).
    const schema = useSel ? dbSel!.schema : undefined
    // MongoDB consoles are mongosh (db.<coll>.find(…)) — title them so they read as
    // Mongo, matching the Explorer's "New Query" (Ctrl/Cmd+N opens the right editor).
    const title = connections.byId(connId)?.system === 'mongodb' ? 'Untitled Mongo' : 'Untitled query'
    return this.openSqlTab({
      connectionId: connId,
      title,
      ...(database ? { database } : {}),
      ...(schema ? { schema } : {}),
    })
  }

  openTableViewer(
    connectionId: string,
    schema: string,
    table: string,
    initialFilters?: { col: string; op: string; value: unknown }[],
  ): TabState {
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'table-viewer',
      title: `${table}`,
      isPinned: false,
      isDirty: false,
      state: { schema, table, initialFilters },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** A subject's messages = the NATS workspace's stream details on that subject
   *  (SPEC-NATS-WORKSPACE.md §3: one workspace tab per connection, no tab per subject). */
  openNatsSubject(connectionId: string, stream: string, subject: string): TabState {
    const ws = this.openStreamWorkspace(connectionId, 'streams', stream)
    this.patchState(ws.id, { sub: 'subjects', subject })
    // patchState replaces the tab's state: hand back the live tab, not the stale copy
    return this.tabs.find((t) => t.id === ws.id) ?? ws
  }

  /** Elasticsearch index tab (Discover · Mappings · Settings · Stats · Aliases) — 1 tab per index/pattern. */
  openEsIndex(connectionId: string, index: string, section?: string): TabState {
    return this.openEsTab('es-index', connectionId, index, index, { index, section: section ?? 'discover' })
  }

  /** Elasticsearch Dev Tools console — one per connection (more via openEsConsole(…, true)). */
  openEsConsole(connectionId: string, fresh = false, seed?: string): TabState {
    const key = fresh ? `console-${uuid()}` : 'console'
    return this.openEsTab('es-console', connectionId, key, 'Dev Tools · Console', seed ? { seed } : {})
  }

  /** Cluster overview (health · nodes · shards · tasks · settings). */
  openEsCluster(connectionId: string, section?: string): TabState {
    return this.openEsTab('es-cluster', connectionId, 'cluster', 'Cluster overview', { section: section ?? 'overview' })
  }

  /** Stack Management page of one resource kind (templates, pipelines, ILM, snapshots…). */
  openEsManage(connectionId: string, kind: string, label: string, select?: string): TabState {
    return this.openEsTab('es-manage', connectionId, `manage:${kind}`, label, { kind, select: select ?? null })
  }

  /** Dev Tools besides Console: Search Profiler · Grok Debugger · Painless Lab · Analyzer (one tab). */
  openEsDevTools(connectionId: string, tool: 'profiler' | 'grok' | 'painless' | 'analyzer' = 'profiler'): TabState {
    return this.openEsTab('es-devtools', connectionId, 'devtools', 'Dev Tools', { tool })
  }

  /** Query tab — ES|QL / SQL on Elasticsearch, PPL / SQL on OpenSearch. A piped language the
   *  server lacks (ES|QL asked on OpenSearch) becomes the server's own (SPEC-OPENSEARCH.md O5). */
  openEsQuery(connectionId: string, language?: QueryLanguage, query?: string): TabState {
    const lang = languageFor(searchProduct(connectionId).flavor, language)
    return this.openEsTab('es-query', connectionId, `query-${uuid()}`, `${LANGUAGE_LABEL[lang]} query`, {
      language: lang,
      query: query ?? '',
    })
  }

  /** DuckDB workspace (Overview · Databases · Extensions · Settings) — one per connection. */
  openDuckHome(connectionId: string, section?: 'overview' | 'databases' | 'extensions' | 'settings'): TabState {
    return this.openEsTab('duckdb-home', connectionId, 'duckdb-home', 'DuckDB', { section: section ?? 'overview' })
  }

  /** DuckDB data profile (SUMMARIZE + histograms / top values) of a table, view or query. */
  openDuckProfile(
    connectionId: string,
    source: { kind: 'table'; schema: string; table: string; database?: string | null } | { kind: 'query'; sql: string; label?: string },
  ): TabState {
    const key = source.kind === 'table' ? `profile:${source.database ?? ''}.${source.schema}.${source.table}` : `profile:q-${uuid()}`
    const title = source.kind === 'table' ? `${source.table} · profile` : `${source.label ?? 'Query'} · profile`
    return this.openEsTab('duckdb-profile', connectionId, key, title, { source })
  }

  private openEsTab(
    contentType: 'es-index' | 'es-console' | 'es-cluster' | 'es-manage' | 'es-query' | 'es-devtools' | 'duckdb-home' | 'duckdb-profile',
    connectionId: string,
    key: string,
    title: string,
    state: Record<string, unknown>,
  ): TabState {
    const existing = this.tabs.find(
      (t) => t.contentType === contentType && t.connectionId === connectionId && (t.state as { key?: string }).key === key,
    )
    if (existing) {
      // a second open with an explicit target (section / selection) retargets the tab
      Object.assign(existing.state as Record<string, unknown>, Object.fromEntries(Object.entries(state).filter(([k, v]) => v != null && k !== 'seed')))
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType,
      title,
      isPinned: false,
      isDirty: false,
      state: { key, ...state },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /**
   * Cache & Streaming cluster workspace (SPEC-STREAM-SHELL.md) — ONE tab per
   * connection; opening it again switches its section / focused item instead of
   * creating a second tab.
   */
  openStreamWorkspace(connectionId: string, section?: string, focus?: string): TabState {
    const existing = this.tabs.find(
      (t) => t.contentType === 'stream-workspace' && t.connectionId === connectionId,
    )
    if (existing) {
      if (section) existing.state = { ...existing.state, section, focus }
      this.activeTabId = existing.id
      this.schedulePersist()
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'stream-workspace',
      title: profile?.name ?? 'Workspace',
      isPinned: false,
      isDirty: false,
      // opened without a destination (a click on the connection): land on the messages
      // list and let the workspace pick its first item once the list has loaded
      state: section ? { section, focus } : { section: messagesSection(profile?.system), focus, autoPick: true },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Merge keys into a tab's view state (section, selected item…) from inside the tab. */
  patchState(tabId: string, patch: Record<string, unknown>, persist = true) {
    const t = this.tabs.find((x) => x.id === tabId)
    if (!t) return
    t.state = { ...t.state, ...patch }
    if (persist) this.schedulePersist()
  }

  /** A topic's messages / produce form = the Kafka workspace's topic details on that
   *  screen (SPEC-KAFKA-WORKSPACE.md §3: one workspace tab per connection, no tab per topic). */
  openKafkaTool(connectionId: string, kind: 'kafka-consumer' | 'kafka-producer', topic: string): TabState {
    const ws = this.openStreamWorkspace(connectionId, 'topics', topic)
    this.patchState(ws.id, { sub: kind === 'kafka-consumer' ? 'messages' : 'produce' })
    // patchState replaces the tab's state: hand back the live tab, not the stale copy
    return this.tabs.find((t) => t.id === ws.id) ?? ws
  }

  /** Mở tab Index Scanner cho một schema (singleton per conn+schema). */
  openIndexManager(connectionId: string, schema: string, table: string): TabState {
    const existing = this.tabs.find(
      (t) =>
        t.contentType === 'index-manager' &&
        t.connectionId === connectionId &&
        (t.state as { schema?: string; table?: string }).schema === schema &&
        (t.state as { table?: string }).table === table,
    )
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'index-manager',
      title: `Indexes · ${table}`,
      isPinned: false,
      isDirty: false,
      state: { schema, table },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  openIndexScanner(connectionId: string, schema: string): TabState {
    const existing = this.tabs.find(
      (t) =>
        t.contentType === 'index-scanner' &&
        t.connectionId === connectionId &&
        (t.state as { schema?: string }).schema === schema,
    )
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'index-scanner',
      title: `Indexes · ${schema}`,
      isPinned: false,
      isDirty: false,
      state: { schema },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở tab Admin views (Session Monitor / Users / Extensions) — T23. */
  openAdminView(connectionId: string, view: string): TabState {
    const existing = this.tabs.find((t) => t.contentType === 'admin' && t.connectionId === connectionId)
    if (existing) {
      existing.state = { view }
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'admin',
      title: `Admin · ${profile?.name ?? ''}`,
      isPinned: false,
      isDirty: false,
      state: { view },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Open the User Manager tab (singleton per connection). `focus` optionally
   *  preselects a principal so double-clicking a tree node lands on it. */
  openUserManager(connectionId: string, focus?: string): TabState {
    const existing = this.tabs.find(
      (t) => t.contentType === 'user-manager' && t.connectionId === connectionId,
    )
    if (existing) {
      if (focus) existing.state = { ...existing.state, focus }
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'user-manager',
      title: `Users · ${profile?.name ?? ''}`,
      isPinned: false,
      isDirty: false,
      state: focus ? { focus } : {},
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở tab Schema Compare (singleton). `opts` presets source/target — pass the
   *  same connection for both (with different databases picked in the UI) to
   *  compare two databases within one connection. `presetTick` lets the reused
   *  singleton re-read the preset. */
  openSchemaCompare(
    srcConnId: string | null,
    opts?: { tgtConnId?: string | null; srcDb?: string | null; tgtDb?: string | null },
  ): TabState {
    const existing = this.tabs.find((t) => t.contentType === 'schema-compare')
    const state = {
      srcConn: srcConnId,
      tgtConn: opts?.tgtConnId ?? null,
      srcDb: opts?.srcDb ?? null,
      tgtDb: opts?.tgtDb ?? null,
      presetTick: ((existing?.state as { presetTick?: number })?.presetTick ?? 0) + 1,
    }
    if (existing) {
      existing.state = state
      this.activeTabId = existing.id
      return existing
    }
    const tab: TabState = {
      id: uuid(),
      connectionId: srcConnId,
      connectionName: '',
      systemType: 'orphan',
      contentType: 'schema-compare',
      title: 'Schema Compare',
      isPinned: false,
      isDirty: false,
      state,
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở tab ER Diagram cho một schema (singleton per conn+schema). */
  openErDiagram(connectionId: string, schema: string, opts?: { blank?: boolean }): TabState {
    // A blank diagram starts with no tables (included: []) so the user can drag
    // them in from the Explorer; the default shows every table (included: undefined).
    if (!opts?.blank) {
      const existing = this.tabs.find(
        (t) =>
          t.contentType === 'er-diagram' &&
          t.connectionId === connectionId &&
          (t.state as { schema?: string; included?: string[] }).schema === schema &&
          (t.state as { included?: string[] }).included === undefined,
      )
      if (existing) {
        this.activeTabId = existing.id
        return existing
      }
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'er-diagram',
      title: opts?.blank ? `ER (new) · ${schema}` : `ER · ${schema}`,
      isPinned: false,
      isDirty: false,
      state: opts?.blank ? { schema, included: [] } : { schema },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở tab Query Plan cho một câu lệnh (visualize EXPLAIN). */
  openQueryPlan(connectionId: string, sql: string): TabState {
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'query-plan',
      title: 'Query Plan',
      isPinned: false,
      isDirty: false,
      state: { query: sql },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở Table Designer — New Table (schema/table rỗng) hoặc Design bảng có sẵn. */
  openTableDesigner(connectionId: string, schema: string, table: string): TabState {
    const existing = this.tabs.find(
      (t) =>
        t.contentType === 'table-designer' &&
        t.connectionId === connectionId &&
        (t.state as { schema?: string; table?: string }).schema === schema &&
        (t.state as { table?: string }).table === table,
    )
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'table-designer',
      title: table ? `${table} · design` : 'new_table · design',
      isPinned: false,
      isDirty: false,
      state: { schema, table },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở (hoặc focus) tab Ring Topology của Cassandra — singleton per connection. */
  openCassandraRing(connectionId: string): TabState {
    const existing = this.tabs.find(
      (t) => t.contentType === 'cassandra-ring' && t.connectionId === connectionId,
    )
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'cassandra-ring',
      title: 'Ring Topology',
      isPinned: false,
      isDirty: false,
      state: {},
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở (hoặc focus) tab dữ liệu editable của một bảng Cassandra — 1 tab/(conn,ks,table). */
  openCassandraTable(connectionId: string, keyspace: string, table: string): TabState {
    const existing = this.tabs.find(
      (t) =>
        t.contentType === 'cassandra-table' &&
        t.connectionId === connectionId &&
        t.state.keyspace === keyspace &&
        t.state.table === table,
    )
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'cassandra-table',
      title: `${keyspace}.${table}`,
      isPinned: false,
      isDirty: false,
      state: { keyspace, table },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở (hoặc focus) tab document viewer của một collection MongoDB — 1 tab/(conn,db,coll). */
  openMongoCollection(connectionId: string, database: string, collection: string): TabState {
    const existing = this.tabs.find(
      (t) =>
        t.contentType === 'mongo-collection' &&
        t.connectionId === connectionId &&
        t.state.database === database &&
        t.state.collection === collection,
    )
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const profile = connections.byId(connectionId)
    const tab: TabState = {
      id: uuid(),
      connectionId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'mongo-collection',
      title: `${database}.${collection}`,
      isPinned: false,
      isDirty: false,
      state: { database, collection },
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /** Mở (hoặc focus nếu đã có) một tab tiện ích singleton — History / Saved. */
  openUtilityTab(contentType: 'history' | 'saved', title: string): TabState {
    const existing = this.tabs.find((t) => t.contentType === contentType)
    if (existing) {
      this.activeTabId = existing.id
      return existing
    }
    const tab: TabState = {
      id: uuid(),
      connectionId: this.active?.connectionId ?? connections.selectedId ?? null,
      connectionName: '',
      systemType: 'orphan',
      contentType,
      title,
      isPinned: false,
      isDirty: false,
      state: {},
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /**
   * Objects tab — a pinned, non-closable singleton pinned at index 0 that lists a
   * database's tables (Table Name · Data Length · Rows). Double-clicking a database
   * name in the Explorer opens it the first time, or just retargets + activates the
   * existing one afterwards (never a second tab). `connId` may be a sub-connection
   * id (foreign database); `database` is the display name; `schema` (optional) lists
   * a single schema, otherwise every schema of the connection.
   */
  openObjectsTab(opts: { connId: string; database: string; schema?: string | null }): TabState {
    const profile = connections.byId(opts.connId)
    const nextState = { database: opts.database, schema: opts.schema ?? null }
    const existing = this.tabs.find((t) => t.contentType === 'objects')
    if (existing) {
      existing.connectionId = opts.connId
      existing.connectionName = profile?.name ?? existing.connectionName
      existing.systemType = (profile?.system as SystemType) ?? existing.systemType
      existing.state = nextState
      existing.pane = 0
      this.activePane = 0
      this.activeTabId = existing.id
      this.schedulePersist()
      return existing
    }
    const tab: TabState = {
      id: uuid(),
      connectionId: opts.connId,
      connectionName: profile?.name ?? '',
      systemType: (profile?.system as SystemType) ?? 'orphan',
      contentType: 'objects',
      title: 'Objects',
      isPinned: true,
      isDirty: false,
      pane: 0,
      state: nextState,
    }
    // Pinned at the very front of the tab strip.
    this.tabs.unshift(tab)
    this.activePane = 0
    this.activeTabId = tab.id
    this.schedulePersist()
    return tab
  }

  /**
   * Closes the pinned Objects tab. Users cannot close it, but it must go away when
   * its connection is no longer open (disconnect / connection lost / profile
   * deleted): it lists a live catalog, so leaving it behind shows a database that is
   * not reachable any more. `connId` (optional) restricts this to an Objects tab
   * belonging to that connection — derived ids (`{base}::db`, `{base}#tab-…`) count
   * as their base profile.
   */
  closeObjectsTab(connId?: string) {
    const tab = this.tabs.find((t) => t.contentType === 'objects')
    if (!tab) return
    if (connId && baseConnId(tab.connectionId ?? '') !== baseConnId(connId)) return
    const wasActive0 = this.activeTabId === tab.id
    const wasActive1 = this.activeTabId1 === tab.id
    const idx0 = this.tabsInPane(0).findIndex((t) => t.id === tab.id)
    const idx1 = this.tabsInPane(1).findIndex((t) => t.id === tab.id)
    this.tabs = this.tabs.filter((t) => t.id !== tab.id)
    if (wasActive0) {
      const p0 = this.tabsInPane(0)
      this.activeTabId = p0[Math.min(Math.max(idx0, 0), p0.length - 1)]?.id ?? null
    }
    if (wasActive1) {
      const p1 = this.tabsInPane(1)
      this.activeTabId1 = p1[Math.min(Math.max(idx1, 0), p1.length - 1)]?.id ?? null
      if (this.tabsInPane(1).length === 0) this.closeSplit()
    }
    this.schedulePersist()
  }

  /** The Objects tab cannot be closed / reordered / dragged (pinned system tab). */
  isClosable(t: TabState | null | undefined): boolean {
    return !!t && t.contentType !== 'objects'
  }

  activate(id: string) {
    const t = this.byId(id)
    if (!t) return
    const pane = (t.pane ?? 0) as 0 | 1
    this.activePane = pane
    if (pane === 1) this.activeTabId1 = id
    else this.activeTabId = id
  }

  focusPane(pane: 0 | 1) {
    this.activePane = pane
  }

  // ---- split view (T11) ----------------------------------------------------

  /** Đưa tab sang pane còn lại → bật split (mặc định dọc). */
  moveToSplit(id: string, dir: 'v' | 'h' = 'v') {
    const t = this.byId(id)
    if (!t) return
    if (!this.splitDir) this.splitDir = dir
    t.pane = 1
    this.activeTabId1 = id
    this.activePane = 1
    // nếu pane 0 rỗng thì kéo active pane 0 về tab đầu còn lại
    if (!this.tabsInPane(0).some((x) => x.id === this.activeTabId)) {
      this.activeTabId = this.tabsInPane(0)[0]?.id ?? null
    }
    this.schedulePersist()
  }

  toggleSplitDir() {
    if (this.splitDir) this.splitDir = this.splitDir === 'v' ? 'h' : 'v'
  }

  /** Gộp tất cả tab về pane 0, tắt split. */
  closeSplit() {
    for (const t of this.tabs) t.pane = 0
    this.splitDir = null
    this.activePane = 0
    this.activeTabId1 = null
    this.schedulePersist()
  }

  next() {
    this.step(1)
  }

  prev() {
    this.step(-1)
  }

  private step(dir: 1 | -1) {
    if (this.tabs.length === 0) return
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId)
    const nextIdx = (idx + dir + this.tabs.length) % this.tabs.length
    this.activeTabId = this.tabs[nextIdx].id
  }

  jumpTo(n: number) {
    // Ctrl+1..9 — 9 jumps to the last tab (browser convention)
    if (this.tabs.length === 0) return
    const idx = n >= 9 ? this.tabs.length - 1 : Math.min(n - 1, this.tabs.length - 1)
    this.activeTabId = this.tabs[idx].id
  }

  // ---- close ---------------------------------------------------------------

  /**
   * Requests closing tabs. Dirty tabs trigger the save-before-close dialog
   * (pendingClose); clean tabs close immediately. Returns true when closed.
   */
  requestClose(ids: string[]): boolean {
    // The pinned Objects tab is never closable — drop it from any (bulk) request.
    const targets = this.tabs.filter((t) => ids.includes(t.id) && this.isClosable(t))
    if (targets.length === 0) return false
    const dirty = targets.filter((t) => t.isDirty)
    if (dirty.length > 0) {
      this.pendingClose = targets
      return false
    }
    this.forceClose(targets.map((t) => t.id))
    return true
  }

  forceClose(ids: string[]) {
    // Never force-close the pinned Objects tab, even via a direct call.
    ids = ids.filter((id) => this.isClosable(this.byId(id)))
    if (ids.length === 0) return
    const closing = this.tabs.filter((t) => ids.includes(t.id))
    for (const tab of closing) {
      // Cancel any query still running in this tab so it doesn't keep executing
      // after the tab is gone, then close the tab's dedicated connection (item 6).
      results.cancelAndClear(tab.id)
      if (tab.contentType === 'sql-editor' && tab.connectionId) {
        void ipc.closeTabConnection(`${tab.connectionId}#tab-${tab.id}`).catch(() => {})
      }
      this.closedStack.push($state.snapshot(tab) as TabState)
    }
    if (this.closedStack.length > MAX_CLOSED_STACK) {
      this.closedStack.splice(0, this.closedStack.length - MAX_CLOSED_STACK)
    }
    if (!this.splitDir) {
      // hành vi gốc (1 pane) — giữ nguyên để không đổi test hiện có
      const wasActive = ids.includes(this.activeTabId ?? '')
      const oldIdx = this.tabs.findIndex((t) => t.id === this.activeTabId)
      this.tabs = this.tabs.filter((t) => !ids.includes(t.id))
      if (wasActive) {
        const idx = Math.min(oldIdx, this.tabs.length - 1)
        this.activeTabId = idx >= 0 ? this.tabs[idx].id : null
      }
    } else {
      // split: dọn active từng pane, tự tắt split khi pane 1 rỗng
      const was0 = ids.includes(this.activeTabId ?? '')
      const was1 = ids.includes(this.activeTabId1 ?? '')
      const i0 = this.tabsInPane(0).findIndex((t) => t.id === this.activeTabId)
      const i1 = this.tabsInPane(1).findIndex((t) => t.id === this.activeTabId1)
      this.tabs = this.tabs.filter((t) => !ids.includes(t.id))
      if (was0) {
        const p0 = this.tabsInPane(0)
        this.activeTabId = p0[Math.min(Math.max(i0, 0), p0.length - 1)]?.id ?? null
      }
      if (was1) {
        const p1 = this.tabsInPane(1)
        this.activeTabId1 = p1[Math.min(Math.max(i1, 0), p1.length - 1)]?.id ?? null
      }
      if (this.tabsInPane(1).length === 0) this.closeSplit()
    }
    this.pendingClose = null
    this.schedulePersist()
  }

  closeActive() {
    if (this.activeTabId) this.requestClose([this.activeTabId])
  }

  closeOthers(id: string) {
    this.requestClose(this.tabs.filter((t) => t.id !== id && !t.isPinned).map((t) => t.id))
  }

  closeToRight(id: string) {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    this.requestClose(this.tabs.slice(idx + 1).filter((t) => !t.isPinned).map((t) => t.id))
  }

  restoreClosed() {
    const tab = this.closedStack.pop()
    if (!tab) return
    // Re-orphan if the connection has vanished meanwhile.
    if (tab.connectionId && !connections.byId(tab.connectionId)) {
      tab.systemType = 'orphan'
      tab.connectionId = null
    }
    this.tabs.push(tab)
    this.activeTabId = tab.id
    this.schedulePersist()
  }

  // ---- mutations -------------------------------------------------------------

  reorder(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return
    // The pinned Objects tab can't be dragged, and nothing can be dropped before it
    // (it stays at index 0). Clamp the destination past any leading Objects tab.
    if (this.tabs[fromIdx]?.contentType === 'objects') return
    const minIdx = this.tabs[0]?.contentType === 'objects' ? 1 : 0
    const dest = Math.max(toIdx, minIdx)
    if (fromIdx === dest) return
    const [moved] = this.tabs.splice(fromIdx, 1)
    this.tabs.splice(dest, 0, moved)
    this.schedulePersist()
  }

  rename(id: string, title: string) {
    const tab = this.byId(id)
    if (tab && title.trim()) {
      tab.title = title.trim()
      this.schedulePersist()
    }
  }

  togglePin(id: string) {
    const tab = this.byId(id)
    if (tab) {
      tab.isPinned = !tab.isPinned
      this.schedulePersist()
    }
  }

  duplicate(id: string) {
    const tab = this.byId(id)
    if (!tab || tab.contentType === 'objects') return // singleton — never duplicated
    const copy: TabState = {
      ...($state.snapshot(tab) as TabState),
      id: uuid(),
      isPinned: false,
      title: `${tab.title} (copy)`,
    }
    const idx = this.tabs.findIndex((t) => t.id === id)
    this.tabs.splice(idx + 1, 0, copy)
    this.activeTabId = copy.id
    this.schedulePersist()
  }

  setDirty(id: string, dirty: boolean) {
    const tab = this.byId(id)
    if (tab && tab.isDirty !== dirty) tab.isDirty = dirty
  }

  /** Change the tab's connection (toolbar dropdown). */
  setConnection(id: string, connectionId: string | null) {
    const tab = this.byId(id)
    if (!tab) return
    const profile = connections.byId(connectionId)
    tab.connectionId = connectionId
    tab.connectionName = profile?.name ?? ''
    tab.systemType = (profile?.system as SystemType) ?? 'orphan'
    this.schedulePersist()
  }

  /** Force Delete: connection removed, tabs stay orphaned (gray ⚠ badge). */
  orphanByConnection(connId: string) {
    for (const tab of this.tabs) {
      if (tab.connectionId === connId) {
        tab.connectionId = null
        tab.systemType = 'orphan'
      }
    }
    this.schedulePersist()
  }

  /** Reassign an orphaned tab to another connection. */
  reassign(tabId: string, connectionId: string) {
    this.setConnection(tabId, connectionId)
  }

  // ---- persistence -----------------------------------------------------------

  private persistTimer: ReturnType<typeof setTimeout> | null = null

  schedulePersist() {
    if (!this.restored) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => void this.persist(), 400)
  }

  async persist() {
    if (!this.restored) return
    // pinned tabs are stored first so they restore first
    const ordered = [...this.tabs].sort((a, b) => Number(b.isPinned) - Number(a.isPinned))
    const payload = ordered.map((t) => ({
      id: t.id,
      is_pinned: t.isPinned,
      payload: { ...($state.snapshot(t) as TabState), activeTabId: undefined },
    }))
    try {
      await ipc.saveTabs(payload)
      await ipc.setAppState('active_tab', this.activeTabId ?? '')
    } catch {
      // persistence must never break the editing flow
    }
  }

  async restore() {
    // Product rule: closing the desktop app closes ALL open tabs — tabs do NOT
    // survive an app restart. Start every launch with a clean slate and wipe any
    // tabs a previous build persisted. (In the browser/demo harness we still seed
    // the prototype's demo tabs so the dev preview isn't empty.)
    if (IS_TAURI) {
      this.tabs = []
      this.activeTabId = null
      this.restored = true
      try {
        await ipc.saveTabs([])
        await ipc.setAppState('active_tab', '')
      } catch {
        // persistence cleanup must never break startup
      }
      return
    }
    try {
      const payloads = await ipc.loadTabs<TabState>()
      const restored: TabState[] = []
      for (const p of payloads) {
        if (!p || typeof p !== 'object' || !p.id) continue
        // connection gone since last session → orphan
        if (p.connectionId && !connections.byId(p.connectionId)) {
          p.connectionId = null
          p.systemType = 'orphan'
        }
        // the old Redis screens (keys / one key / Pub/Sub tabs) became sections of the
        // Redis workspace — a tab saved by an older version opens there instead
        const legacy = p.contentType as string
        if (legacy === 'rabbit-queue' || legacy === 'rabbit-exchange') {
          // a queue / exchange tab of an older version opens in the RabbitMQ workspace
          const st = (p.state ?? {}) as { vhost?: string; name?: string }
          if (p.connectionId && restored.some((t) => t.contentType === 'stream-workspace' && t.connectionId === p.connectionId)) continue
          p.contentType = 'stream-workspace'
          p.title = p.connectionName || 'RabbitMQ'
          const isQueue = legacy === 'rabbit-queue'
          const focus = isQueue ? st.name : st.name === '' ? '(AMQP default)' : st.name
          p.state = { section: isQueue ? 'queues' : 'exchanges', ...(focus ? { focus } : {}), ...(st.vhost ? { vhost: st.vhost } : {}) }
        }
        if (legacy === 'kafka' || legacy === 'kafka-schema-registry') {
          // the classic Kafka tab and the separate Schema Registry tab are sections of
          // the Kafka workspace now
          if (p.connectionId && restored.some((t) => t.contentType === 'stream-workspace' && t.connectionId === p.connectionId)) continue
          p.contentType = 'stream-workspace'
          p.title = p.connectionName || 'Kafka'
          p.state = { section: legacy === 'kafka' ? 'overview' : 'registry' }
        }
        if (legacy === 'kafka-consumer' || legacy === 'kafka-producer') {
          const topic = (p.state as { topic?: string } | undefined)?.topic
          if (p.connectionId && restored.some((t) => t.contentType === 'stream-workspace' && t.connectionId === p.connectionId)) continue
          p.contentType = 'stream-workspace'
          p.title = p.connectionName || 'Kafka'
          p.state = { section: 'topics', ...(topic ? { focus: topic, sub: legacy === 'kafka-consumer' ? 'messages' : 'produce' } : {}) }
        }
        if (legacy === 'nats') {
          // the classic NATS tab (subscribe / publish / request / object store) is now
          // the Publish & subscribe section of the NATS workspace
          if (p.connectionId && restored.some((t) => t.contentType === 'stream-workspace' && t.connectionId === p.connectionId)) continue
          p.contentType = 'stream-workspace'
          p.title = p.connectionName || 'NATS'
          p.state = { section: 'messaging' }
        }
        if (legacy === 'nats-subject') {
          const st = (p.state ?? {}) as { stream?: string; subject?: string }
          if (p.connectionId && restored.some((t) => t.contentType === 'stream-workspace' && t.connectionId === p.connectionId)) continue
          p.contentType = 'stream-workspace'
          p.title = p.connectionName || 'NATS'
          p.state = { section: 'streams', ...(st.stream ? { focus: st.stream } : {}), ...(st.subject ? { sub: 'subjects', subject: st.subject } : {}) }
        }
        if (legacy === 'redis' || legacy === 'redis-key' || legacy === 'redis-pubsub') {
          const key = (p.state as { key?: string } | undefined)?.key
          if (p.connectionId && restored.some((t) => t.contentType === 'stream-workspace' && t.connectionId === p.connectionId)) continue
          p.contentType = 'stream-workspace'
          p.title = p.connectionName || 'Redis'
          p.state = legacy === 'redis-pubsub' ? { section: 'pubsub' } : { section: 'browser', ...(key ? { focus: key } : {}) }
        }
        // split layout không persist → gộp về pane 0 để không có tab "ẩn"
        p.pane = 0
        restored.push(p)
      }
      // The pinned Objects tab always restores at index 0 (persist stores pinned
      // first, but guard it explicitly in case ordering drifted).
      const objIdx = restored.findIndex((t) => t.contentType === 'objects')
      if (objIdx > 0) {
        const [obj] = restored.splice(objIdx, 1)
        restored.unshift(obj)
      }
      this.tabs = restored
      const savedActive = await ipc.getAppState('active_tab')
      this.activeTabId =
        savedActive && restored.some((t) => t.id === savedActive)
          ? savedActive
          : restored[0]?.id ?? null
    } catch {
      this.tabs = []
    } finally {
      this.restored = true
    }
  }
}

export const tabs = new TabsStore()
