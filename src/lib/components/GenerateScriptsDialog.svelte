<script lang="ts">
  // Generate Scripts wizard (T15 + item 3). Whole-schema multi-object script across
  // ALL object types — Tables, Views, Stored Procedures, Functions, Triggers,
  // Sequences — grouped (each group collapsible, with a check-all), searchable by
  // name. Structure / Data / Both.
  //
  // Speed: every object needs its own server round-trip (column list or
  // definition). Those run through a bounded pool, and for a big schema on a
  // socket engine the pool gets a few extra worker connections — the app holds one
  // connection per profile and it serialises calls, so extra connections are what
  // actually overlap the round-trips. Output order is unchanged (results are kept
  // in input order), so the script is identical to a one-at-a-time run.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { scriptsWizard } from '$lib/stores/scripts.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { genCreate, genForeignKey } from '$lib/sql/ddl'
  import { qualified } from '$lib/sql/dialect'
  import { generateScript, type DbObject, type ScriptMode } from '$lib/sql/scripts'
  import { buildExportSelect } from '$lib/export/query'
  import { toSqlInsert, download } from '$lib/export/rows'
  import { mapPool, extraLanes } from '$lib/util/pool'
  import Chevron from '$lib/components/Chevron.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import { dbIcon } from '$lib/explorer/icons'

  type ObjKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'sequence'
  interface ObjRef {
    kind: ObjKind
    name: string
  }
  const GROUPS: { kind: ObjKind; label: string }[] = [
    { kind: 'table', label: 'Tables' },
    { kind: 'view', label: 'Views' },
    { kind: 'procedure', label: 'Stored Procedures' },
    { kind: 'function', label: 'Functions' },
    { kind: 'trigger', label: 'Triggers' },
    { kind: 'sequence', label: 'Sequences' },
  ]
  const okey = (o: ObjRef) => `${o.kind}:${o.name}`
  // Each object type keeps the colour + mark it has in the Explorer, so the list
  // reads by type at a glance instead of as a wall of names.
  const KIND_COLOR: Record<ObjKind, string> = {
    table: 'var(--sacc-blue)',
    view: 'var(--sacc-purple)',
    procedure: 'var(--sacc-orange)',
    function: 'var(--sacc-yellow)',
    trigger: 'var(--sacc-red)',
    sequence: 'var(--sacc-cyan)',
  }
  const KIND_NAME: Record<ObjKind, string> = {
    table: 'Table',
    view: 'View',
    procedure: 'Procedure',
    function: 'Function',
    trigger: 'Trigger',
    sequence: 'Sequence',
  }
  const MODES: { id: ScriptMode; title: string; desc: string }[] = [
    { id: 'structure', title: 'Structure only', desc: 'CREATE statements for tables, views and routines' },
    { id: 'data', title: 'Data only', desc: 'INSERT statements with every row of each table' },
    { id: 'both', title: 'Structure + Data', desc: 'The whole schema and its data in one file' },
  ]

  let mode = $state<ScriptMode>('structure')
  let objects = $state<ObjRef[]>([])
  let picked = $state<Set<string>>(new Set())
  let loading = $state(false)
  let running = $state(false)
  let search = $state('')
  let collapsed = $state<Set<ObjKind>>(new Set())
  // Generation progress overlay — per-object bar so you can tell when it's done.
  let prog = $state<{
    pct: number
    cur: number
    total: number
    label: string
    done: boolean
    error?: string
    path?: string
    lanes: number
    /** Stop pressed — finishing the in-flight calls, nothing new starts. */
    stopping?: boolean
    /** Stopped before the end: no file was written. */
    cancelled?: boolean
  } | null>(null)
  // Per-object run list shown in the progress popup: every chosen object, in the
  // order it is processed, with where it stands — so you can see exactly which
  // table is running (several at once with parallel connections) and what is left.
  type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'stopped'
  interface RunItem {
    key: string
    kind: ObjKind
    name: string
    status: RunStatus
    ms?: number
  }
  let runItems = $state<RunItem[]>([])
  let runIndex = new Map<string, number>()
  /** index of the object that started most recently — the list follows it */
  let currentIdx = $state(-1)
  /** follow the running object; turned off when you scroll the list yourself */
  let follow = $state(true)
  let runListEl = $state<HTMLElement | null>(null)
  // Counts and the "running: …" names are kept up to date as each row changes
  // (O(1) per change) — re-deriving them over every row made a 1,500-object run
  // quadratic.
  const emptyCounts = () => ({ pending: 0, running: 0, done: 0, failed: 0, skipped: 0, stopped: 0 })
  let runCounts = $state(emptyCounts())
  let runningSet = $state<string[]>([])
  const runningNames = $derived(runningSet)

  function setStatus(i: number, status: RunStatus) {
    const it = runItems[i]
    const was = it.status
    if (was === status) return
    runCounts[was]--
    runCounts[status]++
    it.status = status
    if (was === 'running') runningSet = runningSet.filter((n) => n !== it.name)
    if (status === 'running') runningSet = [...runningSet, it.name]
  }
  function mark(o: ObjRef, status: RunStatus, ms?: number) {
    const i = runIndex.get(okey(o))
    if (i === undefined) return
    setStatus(i, status)
    if (ms !== undefined) runItems[i].ms = ms
    if (status === 'running') {
      currentIdx = i
      scheduleFollow()
    }
  }
  /** Run `work` for one object, keeping its row in the list up to date. */
  async function track<R>(o: ObjRef, gen: number, work: () => Promise<R>): Promise<R> {
    mark(o, 'running')
    const t0 = performance.now()
    try {
      const r = await work()
      // a run abandoned by Stop must not touch the rows of the run shown now
      if (gen === runGen) mark(o, 'done', Math.round(performance.now() - t0))
      return r
    } catch (e) {
      if (gen === runGen) mark(o, e === STOPPED || stopRequested ? 'stopped' : 'failed')
      throw e
    }
  }

  // Keep the running object in view (unless you scrolled away to look at others).
  // At most once per frame, and only when the row is actually out of view: calling
  // scrollIntoView for every object forced a layout of the whole list each time and
  // made a 1,500-table run several times slower than the work itself.
  let followQueued = false
  function scheduleFollow() {
    if (followQueued || !follow) return
    followQueued = true
    requestAnimationFrame(() => {
      followQueued = false
      const list = runListEl
      const i = currentIdx
      if (!follow || !list || i < 0) return
      const row = list.children[i] as HTMLElement | undefined
      if (!row) return
      const top = row.offsetTop - list.offsetTop
      const bottom = top + row.offsetHeight
      if (top < list.scrollTop) list.scrollTop = top
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
    })
  }

  // Stop: a plain flag (read inside the pool jobs, not rendered) + the
  // connections the current run uses, so Stop can cancel their queries.
  let stopRequested = false
  let runLanes: string[] = []
  /** worker connections opened for the current run (closed when it ends/stops) */
  let runExtra: string[] = []
  /** Bumped by every new run and by Stop: work still in flight from an older run
   *  sees a different number and drops its result instead of writing into the
   *  run shown now. */
  let runGen = 0
  let writingFile = false
  const STOPPED = Symbol('generate-stopped')
  const checkpoint = () => {
    if (stopRequested) throw STOPPED
  }

  // ---- the dialog's own connection ---------------------------------------------
  // Everything this dialog reads (the object list, columns, definitions, data) goes
  // through a connection of its OWN, never the profile's main one. A connection
  // runs one call at a time and an introspection call cannot be interrupted, so a
  // slow catalog query used to keep the main connection busy long after Cancel —
  // the Explorer, Open Data and everything else on that connection then queued
  // behind it and the app looked frozen. Now Cancel / Stop simply let go of this
  // connection (closed in the background) and the rest of the app never waited.
  let sessionConn: string | null = null
  let sessionSeq = 0
  let loadGen = 0
  const isOwnConn = (id: string | null) => !!id && id.includes('#tab-scripts-')

  /** Open the dialog's connection; falls back to the main one if it can't. */
  async function openSession(connId: string): Promise<string> {
    const tag = `scripts-${Date.now().toString(36)}-${++sessionSeq}`
    try {
      return await ipc.openTabConnection(connId, tag, connections.databaseOf(connId) ?? '')
    } catch {
      return connId
    }
  }
  /** Close a connection of ours without waiting on whatever is still running on it. */
  function dropConn(id: string | null) {
    if (!isOwnConn(id)) return
    void ipc.cancelQuery(id!).catch(() => {})
    void ipc.closeTabConnection(id!).catch(() => {})
  }
  function releaseSession() {
    const s = sessionConn
    sessionConn = null
    dropConn(s)
  }
  /** The dialog closed: forget the load in flight and let its connection go. */
  function endSession() {
    loadGen++
    loading = false
    releaseSession()
  }

  // The progress popup takes focus so Escape reaches it (= Stop while running).
  const focusOnMount = (node: HTMLElement) => node.focus()

  /** Close the progress popup — after a successful run, the wizard too (its job
   *  is done); after a stop or a failure you land back on the wizard to retry. */
  function closeProgress() {
    const finishedOk = !!prog?.done && !prog.error && !prog.cancelled
    prog = null
    if (finishedOk) scriptsWizard.close()
  }

  /** Stop the running generation: no new object starts, the query running on
   *  each lane (the data-mode SELECT can be long) is cancelled, and no file is
   *  written.
   *
   *  It does NOT wait for the calls in flight. A column list or a definition is
   *  an introspection call that cannot be interrupted, and on a slow server it can
   *  take minutes — waiting for it used to leave the modal progress popup stuck on
   *  "Stopping…" with no way out, covering the whole app. The run is finished
   *  here and now; its connections are closed in the background and whatever
   *  they still return is ignored (runGen). */
  function stop() {
    if (!running || stopRequested || writingFile) return
    stopRequested = true
    runGen++
    for (const id of runLanes) void ipc.cancelQuery(id).catch(() => {})
    for (const id of runExtra) dropConn(id)
    // the dialog's own connection may still be busy with the abandoned work — a
    // new one is opened by the next Generate
    releaseSession()
    runItems.forEach((it, i) => it.status === 'running' && setStatus(i, 'stopped'))
    if (prog) {
      prog.stopping = false
      prog.cancelled = true
      toasts.show(`Generate stopped after ${prog.cur} of ${prog.total} object(s) — no file written`)
    }
    runLanes = []
    runExtra = []
    running = false
  }

  const system = $derived(connections.byId(scriptsWizard.connId)?.system ?? 'postgres')
  // Header shows the target as db.schema (schema-as-database engines already show
  // the db as the schema, so skip the redundant prefix there).
  const db = $derived(connections.databaseOf(scriptsWizard.connId))
  const target = $derived(
    db && db !== scriptsWizard.schema ? `${db}.${scriptsWizard.schema}` : scriptsWizard.schema,
  )
  const query = $derived(search.trim().toLowerCase())
  const matches = (o: ObjRef) => !query || o.name.toLowerCase().includes(query)
  const grouped = $derived(
    GROUPS.map((g) => {
      const items = objects.filter((o) => o.kind === g.kind)
      return { ...g, items, visible: items.filter(matches) }
    }).filter((g) => (query ? g.visible.length : g.items.length)),
  )
  const matchCount = $derived(grouped.reduce((n, g) => n + g.visible.length, 0))
  // While searching every group with a hit is shown open — a match hidden in a
  // collapsed group would look like "no result".
  const isOpen = (kind: ObjKind) => !!query || !collapsed.has(kind)

  $effect(() => {
    if (scriptsWizard.open) untrack(() => void load())
    else untrack(endSession)
  })

  async function load() {
    const gen = ++loadGen
    mode = 'structure'
    running = false
    loading = true
    objects = []
    picked = new Set()
    search = ''
    collapsed = new Set()
    releaseSession()
    const connId = scriptsWizard.connId
    const schema = scriptsWizard.schema
    if (!connId) {
      loading = false
      return
    }
    try {
      const conn = await openSession(connId)
      if (gen !== loadGen) {
        // closed (or reopened) while the connection was opening
        dropConn(conn)
        return
      }
      sessionConn = conn
      // One call, names only. The full list_* calls also compute row counts and
      // sizes (one stat per table) and, on MySQL, routine parameters (one query per
      // routine) — none of which a picker needs, and on a big schema they were what
      // made this list take ages. The old calls stay as a fallback.
      const found = await ipc.listObjectNames(conn, schema).catch(() => loadObjectsTheLongWay(conn, schema))
      // Cancelled while loading: drop the late answer (it would otherwise fill the
      // next dialog with this schema's objects)
      if (gen !== loadGen) return
      // group by kind in GROUPS order; overloads (PG) share a name → one row
      const seen = new Set<string>()
      objects = GROUPS.flatMap((g) =>
        found
          .filter((o) => o.kind === g.kind)
          .map((o): ObjRef => ({ kind: o.kind, name: o.name }))
          .filter((o) => !seen.has(okey(o)) && (seen.add(okey(o)), true)),
      )
      picked = new Set(objects.map(okey))
    } catch (e) {
      if (gen === loadGen) toasts.error(String(e))
    } finally {
      if (gen === loadGen) loading = false
    }
  }

  /** The four separate list_* calls — used only if list_object_names fails. */
  async function loadObjectsTheLongWay(conn: string, schema: string): Promise<ObjRef[]> {
    const [tbls, routines, triggers, sequences] = await Promise.all([
      ipc.listTables(conn, schema).catch(() => []),
      ipc.listRoutines(conn, schema).catch(() => []),
      ipc.listTriggers(conn, schema).catch(() => []),
      ipc.listSequences(conn, schema).catch(() => []),
    ])
    return [
      ...tbls.map((t): ObjRef => ({ kind: t.kind === 'view' ? 'view' : 'table', name: t.name })),
      ...routines.map((r): ObjRef => ({ kind: r.kind === 'procedure' ? 'procedure' : 'function', name: r.name })),
      ...triggers.map((t): ObjRef => ({ kind: 'trigger', name: t.name })),
      ...sequences.map((q): ObjRef => ({ kind: 'sequence', name: q.name })),
    ]
  }

  function toggle(o: ObjRef) {
    const next = new Set(picked)
    if (next.has(okey(o))) next.delete(okey(o))
    else next.add(okey(o))
    picked = next
  }
  /** Check-all of a group acts on the rows you can SEE: with a search active it
   *  toggles only the matches, never objects hidden by the filter. */
  function groupAllOn(g: { visible: ObjRef[] }): boolean {
    return g.visible.length > 0 && g.visible.every((o) => picked.has(okey(o)))
  }
  function toggleGroup(g: { visible: ObjRef[] }) {
    const allOn = groupAllOn(g)
    const next = new Set(picked)
    for (const o of g.visible) {
      if (allOn) next.delete(okey(o))
      else next.add(okey(o))
    }
    picked = next
  }
  function setVisible(on: boolean) {
    const next = new Set(picked)
    for (const g of grouped) for (const o of g.visible) on ? next.add(okey(o)) : next.delete(okey(o))
    picked = next
  }
  // ---- keyboard selection in the object list ----------------------------------
  // The list is one focus stop with an "active" row (group header or object):
  // ↑/↓ move, Home/End jump, Enter/Space check or uncheck it (a group header
  // checks/unchecks its whole group), ←/→ collapse/expand the group.
  type NavRow = { key: string; kind: ObjKind; obj?: ObjRef }
  const navRows = $derived.by((): NavRow[] => {
    const out: NavRow[] = []
    for (const g of grouped) {
      out.push({ key: `g:${g.kind}`, kind: g.kind })
      if (isOpen(g.kind)) for (const o of g.visible) out.push({ key: okey(o), kind: g.kind, obj: o })
    }
    return out
  })
  let activeKey = $state<string | null>(null)
  let listEl = $state<HTMLElement | null>(null)
  const activeIdx = $derived(activeKey ? navRows.findIndex((r) => r.key === activeKey) : -1)
  const rowId = (key: string) => `gs-row-${key.replace(/[^\w-]/g, '_')}`

  // the active row stays in view (and stays valid when a filter/collapse hides it)
  $effect(() => {
    const k = activeKey
    if (!k) return
    if (!navRows.some((r) => r.key === k)) {
      activeKey = null
      return
    }
    document.getElementById(rowId(k))?.scrollIntoView({ block: 'nearest' })
  })

  function moveActive(to: number) {
    if (!navRows.length) return
    const i = Math.max(0, Math.min(navRows.length - 1, to))
    activeKey = navRows[i].key
  }
  function toggleRow(r: NavRow) {
    if (r.obj) toggle(r.obj)
    else {
      const g = grouped.find((x) => x.kind === r.kind)
      if (g) toggleGroup(g)
    }
  }
  function onListKey(e: KeyboardEvent) {
    const r = activeIdx >= 0 ? navRows[activeIdx] : undefined
    switch (e.key) {
      case 'ArrowDown':
        moveActive(activeIdx < 0 ? 0 : activeIdx + 1)
        break
      case 'ArrowUp':
        moveActive(activeIdx < 0 ? 0 : activeIdx - 1)
        break
      case 'Home':
        moveActive(0)
        break
      case 'End':
        moveActive(navRows.length - 1)
        break
      case 'Enter':
      case ' ':
        if (!r) return
        toggleRow(r)
        break
      case 'ArrowRight':
        if (!r || r.obj) return
        if (!isOpen(r.kind)) toggleCollapse(r.kind)
        else moveActive(activeIdx + 1)
        break
      case 'ArrowLeft':
        if (!r) return
        if (r.obj) activeKey = `g:${r.kind}`
        else if (isOpen(r.kind) && !query) toggleCollapse(r.kind)
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }
  /** A click on a row's label moves focus to its checkbox; hand it back to the
   *  list so the arrow keys keep working (and Space is not handled twice). */
  const keepListFocus = () => listEl?.focus({ preventScroll: true })
  /** Pointer selects the row too, so the keyboard continues from where you clicked. */
  function pick(key: string) {
    activeKey = key
    listEl?.focus({ preventScroll: true })
  }

  function toggleCollapse(kind: ObjKind) {
    const next = new Set(collapsed)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    collapsed = next
  }

  // Yield to the event loop now and then so the bar repaints — but not after
  // every object (a nested setTimeout(0) is clamped to ~4 ms, which alone costs
  // seconds on a schema with a few hundred objects).
  let lastYield = 0
  async function breathe() {
    const now = performance.now()
    if (now - lastYield < 32) return
    lastYield = now
    await new Promise((res) => setTimeout(res, 0))
  }

  /** The existing connection plus a few worker connections for a big job. A
   *  worker that fails to open is simply not used. */
  async function openLanes(connId: string, first: string, work: number): Promise<{ lanes: string[]; extra: string[] }> {
    const n = extraLanes(system, work)
    if (!n || !IS_TAURI) return { lanes: [first], extra: [] }
    const tag = `scripts-lane-${Date.now().toString(36)}`
    const database = connections.databaseOf(connId) ?? ''
    const opened = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => ipc.openTabConnection(connId, `${tag}-${i}`, database)),
    )
    const extra = opened.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    return { lanes: [first, ...extra], extra }
  }

  async function generate() {
    const connId = scriptsWizard.connId
    if (!connId) return
    const schema = scriptsWizard.schema
    const chosen = objects.filter((o) => picked.has(okey(o)))
    if (!chosen.length) {
      toasts.error('No objects selected')
      return
    }

    // Desktop: choose where to save the .sql first (a real folder picker).
    const filename = `scripts_${schema}.sql`
    let savePath: string | null = null
    if (IS_TAURI) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog')
        savePath = await save({ defaultPath: filename, filters: [{ name: 'SQL', extensions: ['sql'] }] })
      } catch (e) {
        toasts.error(String(e))
        return
      }
      if (!savePath) return // user cancelled
    }

    running = true
    stopRequested = false
    const gen = ++runGen
    // shadows the outer one: a run that was stopped (or replaced) stops here too
    const checkpoint = () => {
      if (stopRequested || gen !== runGen) throw STOPPED
    }
    runLanes = []
    runExtra = []
    const total = chosen.length
    let cur = 0
    prog = { pct: 0, cur: 0, total, label: '', done: false, path: savePath ?? filename, lanes: 1 }
    const step = (label: string) => {
      if (gen !== runGen) return
      cur++
      if (prog) {
        prog.cur = cur
        prog.label = label
        prog.pct = Math.round((cur / total) * 90)
      }
    }

    const seqs = chosen.filter((o) => o.kind === 'sequence')
    const tvs = chosen.filter((o) => o.kind === 'table' || o.kind === 'view')
    const routines = chosen.filter((o) => o.kind === 'procedure' || o.kind === 'function' || o.kind === 'trigger')
    // the popup lists every object in processing order
    const order = [...seqs, ...tvs, ...routines]
    runItems = order.map((o): RunItem => ({ key: okey(o), kind: o.kind, name: o.name, status: 'pending' }))
    runCounts = { ...emptyCounts(), pending: order.length }
    runningSet = []
    runIndex = new Map(order.map((o, i) => [okey(o), i]))
    currentIdx = -1
    follow = true
    const roundTrips = tvs.length + (mode !== 'data' ? routines.length : 0)
    // the dialog's own connection (a Stop let the previous one go — open a fresh one)
    let first = sessionConn
    if (!first) {
      const opened = await openSession(connId)
      if (gen !== runGen || !scriptsWizard.open) {
        dropConn(opened)
        return
      }
      first = sessionConn = opened
    }
    const { lanes, extra } = await openLanes(connId, first, roundTrips)
    if (gen !== runGen) {
      for (const id of extra) dropConn(id)
      return
    }
    runLanes = lanes
    runExtra = extra
    if (prog) prog.lanes = lanes.length

    try {
      checkpoint()
      const parts: string[] = []
      // Sequences first (tables may reference them). No round-trip needed.
      if (seqs.length) {
        if (mode !== 'data') {
          parts.push('-- Sequences\n' + seqs.map((s) => `CREATE SEQUENCE ${qualified(system, schema, s.name)};`).join('\n'))
        }
        for (const s of seqs) {
          mark(s, mode !== 'data' ? 'done' : 'skipped')
          step(s.name)
        }
      }
      // Tables + Views → dependency-ordered structure/data (reuse generateScript).
      if (tvs.length) {
        const fks = await ipc.listForeignKeys(first, schema).catch(() => [])
        checkpoint()
        const tableNames = tvs.filter((o) => o.kind === 'table').map((o) => o.name)
        const scriptOne = async (o: ObjRef, cid: string): Promise<DbObject> => {
          if (o.kind === 'view') {
            const def = await ipc.objectDefinition(cid, schema, 'view', o.name).catch(() => null)
            return { name: o.name, kind: 'view', createSql: def ?? `-- VIEW ${o.name}: definition unavailable`, deps: tableNames }
          }
          const cols = await ipc.listColumns(cid, schema, o.name)
          const tableFks = fks.filter((f) => f.from_table === o.name && picked.has(`table:${f.to_table}`))
          let dataSql: string | undefined
          if (mode !== 'structure') {
            const res = await ipc.execStatement(cid, buildExportSelect({ system, schema, table: o.name }), 0)
            checkpoint() // a cancelled SELECT comes back as an error — don't script it
            if (res.ok && res.result && res.result.rows.length) {
              dataSql = toSqlInsert(o.name, res.result.cols.map((c) => c[0]), res.result.rows as Record<string, unknown>[])
            }
          }
          return {
            name: o.name,
            kind: 'table',
            createSql: genCreate(system, schema, o.name, cols),
            deps: tableFks.map((f) => f.to_table),
            fkAlters: tableFks.map((f) => genForeignKey(system, schema, f)),
            dataSql,
          }
        }
        const objs = await mapPool(tvs, lanes.length, async (o, lane): Promise<DbObject> => {
          checkpoint()
          const obj = await track(o, gen, async () => {
            const r = await scriptOne(o, lanes[lane])
            checkpoint()
            return r
          })
          step(o.name)
          await breathe()
          return obj
        })
        parts.push(generateScript(objs, mode))
      }
      // Procedures / Functions / Triggers → real DDL (structure only).
      if (routines.length) {
        const defs = await mapPool(routines, lanes.length, async (o, lane): Promise<string | null> => {
          checkpoint()
          if (mode === 'data') {
            mark(o, 'skipped') // routines carry no data
            step(o.name)
            return null
          }
          const out = await track(o, gen, async () => {
            const def = await ipc.objectDefinition(lanes[lane], schema, o.kind, o.name).catch(() => null)
            checkpoint()
            return `-- ${o.kind}: ${o.name}\n${def ?? `-- definition unavailable`}`
          })
          step(o.name)
          await breathe()
          return out
        })
        const kept = defs.filter((d): d is string => d !== null)
        if (kept.length) parts.push('-- Routines & Triggers\n' + kept.join('\n\n'))
      }

      const header = `-- Generated scripts for ${schema} (${mode}) — ${chosen.length} object(s)\n\n`
      const content = header + parts.filter(Boolean).join('\n\n')
      checkpoint() // last chance — once the file is written there is nothing to stop
      writingFile = true // the file is going out: Stop can no longer promise "no file written"

      if (IS_TAURI && savePath) {
        await ipc.writeTextFile(savePath, content)
      } else {
        download(filename, content, 'text/plain')
      }
      if (prog) {
        prog.pct = 100
        prog.done = true
      }
      toasts.success(`Generated ${chosen.length} object(s) (${mode}) → ${savePath ?? filename}`)
      // The popup stays up (it no longer vanishes after a second) so the run list
      // can be read; closing it after a successful run closes the wizard too.
    } catch (e) {
      // Stop already finished this run (and may have started another): nothing to report
      if (gen !== runGen) return
      if (stopRequested || e === STOPPED) {
        // Stopped: report it as such (not as a failure) and write nothing.
        runItems.forEach((it, i) => it.status === 'running' && setStatus(i, 'stopped'))
        if (prog) {
          prog.stopping = false
          prog.cancelled = true
        }
        toasts.show(`Generate stopped after ${cur} of ${total} object(s) — no file written`)
      } else {
        if (prog) prog.error = String(e)
        toasts.error(`Generate failed: ${e}`)
      }
    } finally {
      if (gen === runGen) {
        writingFile = false
        for (const id of extra) void ipc.closeTabConnection(id).catch(() => {})
        runLanes = []
        runExtra = []
        running = false
      }
    }
  }
</script>

{#if scriptsWizard.open}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !running && scriptsWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !running && scriptsWizard.close()} role="dialog" aria-modal="true" aria-label="Generate Scripts" tabindex="-1" class="gs-dialog">
      <!-- header: what this does + where -->
      <div class="gs-head">
        <span class="gs-head-icon" aria-hidden="true"><Icon name="query" size={18} /></span>
        <div style="min-width:0;flex:1">
          <div class="gs-title">Generate Scripts</div>
          <div class="gs-sub" title={target}>Export <b>{target}</b> as a SQL file you can run elsewhere</div>
        </div>
        <span onclick={() => !running && scriptsWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && scriptsWizard.close()} role="button" tabindex="0" aria-label="Close" class="gs-x">×</span>
      </div>

      <div class="gs-body">
        <!-- 1 · what goes into the file -->
        <div class="gs-section-label">What to include</div>
        <div class="gs-modes" role="radiogroup" aria-label="Script content">
          {#each MODES as m (m.id)}
            <label class="gs-mode" class:on={mode === m.id}>
              <input type="radio" name="scriptmode" checked={mode === m.id} onchange={() => (mode = m.id)} />
              <span class="gs-mode-text">
                <span class="gs-mode-title">{m.title}</span>
                <span class="gs-mode-desc">{m.desc}</span>
              </span>
            </label>
          {/each}
        </div>

        <!-- 2 · which objects -->
        <div class="gs-section-row">
          <div class="gs-section-label" style="margin:0">Objects</div>
          <span class="gs-selcount">{picked.size.toLocaleString()} of {objects.length.toLocaleString()} selected</span>
          {#if query}<span class="gs-matchcount">{matchCount} matching</span>{/if}
          <span style="margin-left:auto;display:flex;gap:var(--px-12)">
            <span class="gs-link" role="button" tabindex="0" onclick={() => setVisible(true)} onkeydown={(e) => e.key === 'Enter' && setVisible(true)}>{query ? 'Select matches' : 'Select all'}</span>
            <span class="gs-link" role="button" tabindex="0" onclick={() => setVisible(false)} onkeydown={(e) => e.key === 'Enter' && setVisible(false)}>{query ? 'Clear matches' : 'Select none'}</span>
          </span>
        </div>

        <div class="gs-toolbar">
          <div class="gs-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              placeholder="Search by name"
              aria-label="Search objects"
              bind:value={search}
              onkeydown={(e) => {
                if (e.key === 'Escape' && search) {
                  e.stopPropagation()
                  search = ''
                } else if (e.key === 'ArrowDown' && navRows.length) {
                  e.preventDefault()
                  activeKey = navRows[0].obj ? navRows[0].key : (navRows[1]?.key ?? navRows[0].key)
                  listEl?.focus()
                }
              }}
            />
            {#if search}
              <span role="button" tabindex="0" aria-label="Clear search" class="gs-clear" onclick={() => (search = '')} onkeydown={(e) => e.key === 'Enter' && (search = '')}>×</span>
            {/if}
          </div>
          <span class="gs-ghost" role="button" tabindex="0" aria-label="Expand all" title="Expand every group" onclick={() => (collapsed = new Set())} onkeydown={(e) => e.key === 'Enter' && (collapsed = new Set())}>Expand all</span>
          <span class="gs-ghost" role="button" tabindex="0" aria-label="Collapse all" title="Collapse every group" onclick={() => (collapsed = new Set(GROUPS.map((g) => g.kind)))} onkeydown={(e) => e.key === 'Enter' && (collapsed = new Set(GROUPS.map((g) => g.kind)))}>Collapse all</span>
        </div>

        <div
          class="gs-list"
          bind:this={listEl}
          tabindex="0"
          role="listbox"
          aria-label="Objects"
          aria-multiselectable="true"
          aria-activedescendant={activeKey ? rowId(activeKey) : undefined}
          onkeydown={onListKey}
          onfocus={() => activeKey === null && navRows.length && (activeKey = navRows[0].key)}
        >
          {#if loading}
            <div class="gs-note">Loading objects…</div>
          {:else if objects.length === 0}
            <div class="gs-note">This schema has no objects to script.</div>
          {:else if grouped.length === 0}
            <div class="gs-note">No object matches “{search.trim()}”.</div>
          {:else}
            {#each grouped as g (g.kind)}
              {@const open = isOpen(g.kind)}
              {@const on = g.items.filter((o) => picked.has(okey(o))).length}
              <div
                class="gs-group"
                class:active={activeKey === `g:${g.kind}`}
                id={rowId(`g:${g.kind}`)}
                role="group"
                aria-label={g.label}
                onpointerdown={() => pick(`g:${g.kind}`)}
              >
                <span
                  class="gs-chev"
                  role="button"
                  tabindex="-1"
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${g.label}`}
                  onclick={() => toggleCollapse(g.kind)}
                  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleCollapse(g.kind))}
                ><Chevron {open} size={12} /></span>
                <label class="gs-group-label">
                  <input type="checkbox" tabindex="-1" checked={groupAllOn(g)} onchange={() => toggleGroup(g)} onfocus={keepListFocus} />
                  <span class="gs-kicon" style="color:{KIND_COLOR[g.kind]}" aria-hidden="true">{@html dbIcon(g.kind, 15)}</span>
                  <span>{g.label}</span>
                  <span class="gs-pill" class:full={on === g.items.length} aria-label={`${g.label} (${on}/${g.items.length})`}>{on} / {g.items.length}</span>
                </label>
              </div>
              {#if open}
                {#each g.visible as o (okey(o))}
                  <label
                    class="gs-item"
                    class:active={activeKey === okey(o)}
                    class:checked={picked.has(okey(o))}
                    id={rowId(okey(o))}
                    title={`${KIND_NAME[o.kind]} · ${o.name}`}
                    onpointerdown={() => pick(okey(o))}
                  >
                    <input type="checkbox" tabindex="-1" checked={picked.has(okey(o))} onchange={() => toggle(o)} onfocus={keepListFocus} />
                    <span class="gs-kicon small" style="color:{KIND_COLOR[o.kind]}" aria-hidden="true">{@html dbIcon(o.kind, 13)}</span>
                    <span class="gs-name">{o.name}</span>
                  </label>
                {/each}
              {/if}
            {/each}
          {/if}
        </div>
      </div>

      <div class="gs-foot">
        <span class="gs-summary">
          {#if picked.size}
            <b>{picked.size.toLocaleString()}</b> object{picked.size === 1 ? '' : 's'} · {MODES.find((m) => m.id === mode)?.title}
          {:else}
            Pick at least one object
          {/if}
        </span>
        <span class="cfm-btn" onclick={() => !running && scriptsWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && scriptsWizard.close()} role="button" tabindex="0">Cancel</span>
        <span class="cfm-btn primary" onclick={() => !running && generate()} onkeydown={(e) => e.key === 'Enter' && !running && generate()} role="button" tabindex="0" aria-disabled={running || !picked.size}>{running ? 'Generating…' : 'Generate'}</span>
      </div>
    </div>
  </div>

  {#if prog}
    {@const finished = prog.done || !!prog.error || !!prog.cancelled}
    <!-- generation progress popup — header, bar, and the list of every object with
         its status, following the one that is running. FIXED size: names change
         every few ms, so the box must never size to them. While running, Stop (or
         Escape) halts it and nothing is written. -->
    <div role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:70">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Generate progress"
        tabindex="-1"
        class="gs-prog"
        use:focusOnMount
        onkeydown={(e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          if (finished) closeProgress()
          else stop()
        }}
      >
        <div style="flex:none;display:flex;align-items:center;gap:var(--px-9);margin-bottom:var(--px-10)">
          <span style="font-size:var(--px-15);color:{prog.error ? 'var(--error)' : prog.cancelled ? 'var(--warn)' : prog.done ? 'var(--success)' : 'var(--primary)'}">{prog.error ? '✗' : prog.cancelled ? '■' : prog.done ? '✓' : '⚙'}</span>
          <span style="font-size:var(--px-13_5);font-weight:600;color:var(--text)">{prog.error ? 'Generate failed' : prog.cancelled ? 'Generate stopped' : prog.done ? 'Generate complete' : prog.stopping ? 'Stopping…' : 'Generating scripts…'}</span>
          {#if finished}
            <span onclick={closeProgress} onkeydown={(e) => e.key === 'Enter' && closeProgress()} role="button" tabindex="0" aria-label="Dismiss" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-18)">×</span>
          {/if}
        </div>
        <div class="mono gs-line" title={prog.path}>{prog.path}</div>

        <div class="gs-status">
          <span class="gs-count">{prog.cur.toLocaleString()} / {prog.total.toLocaleString()}</span>
          <span class="gs-cur" data-testid="gs-current">{prog.done ? 'done' : prog.cancelled ? 'stopped — no file written' : prog.error ? 'failed' : runningNames.length ? `running: ${runningNames.join(', ')}` : prog.label}</span>
        </div>
        <div style="flex:none;height:var(--px-8);border-radius:var(--px-6);background:var(--panel);overflow:hidden;border:var(--px-1) solid var(--border)">
          <div style="height:100%;width:{prog.pct}%;background:{prog.error ? 'var(--error)' : prog.cancelled ? 'var(--muted)' : 'var(--primary)'};transition:width .15s ease"></div>
        </div>
        <div style="flex:none;display:flex;gap:var(--px-12);font-size:var(--px-11_5);color:var(--muted);margin-top:var(--px-6);font-variant-numeric:tabular-nums">
          <span><b style="color:var(--success)">{runCounts.done}</b> done</span>
          <span><b style="color:var(--primary)">{runCounts.running}</b> running</span>
          <span><b style="color:var(--text2)">{runCounts.pending}</b> waiting</span>
          {#if runCounts.failed}<span><b style="color:var(--error)">{runCounts.failed}</b> failed</span>{/if}
          {#if runCounts.skipped}<span>{runCounts.skipped} skipped</span>{/if}
          {#if prog.lanes > 1}<span>· {prog.lanes} connections</span>{/if}
          <span style="margin-left:auto;font-variant-numeric:tabular-nums">{prog.pct}%</span>
        </div>

        <!-- every object of this run, in processing order -->
        <div
          class="gs-runlist"
          role="list"
          aria-label="Generate objects"
          bind:this={runListEl}
          onwheel={() => !finished && (follow = false)}
        >
          {#each runItems as it (it.key)}
            <div class="gs-run" role="listitem" data-status={it.status} aria-current={it.status === 'running' ? 'step' : undefined}>
              <span class="gs-st" aria-hidden="true">
                {#if it.status === 'running'}<span class="gs-spin"></span>
                {:else if it.status === 'done'}✓
                {:else if it.status === 'failed'}✗
                {:else if it.status === 'stopped'}■
                {:else if it.status === 'skipped'}–
                {:else}○{/if}
              </span>
              <span class="gs-kicon small" style="color:{KIND_COLOR[it.kind]}" title={KIND_NAME[it.kind]} aria-hidden="true">{@html dbIcon(it.kind, 13)}</span>
              <span class="gs-rname" title={`${KIND_NAME[it.kind]} · ${it.name}`}>{it.name}</span>
              <span class="gs-rtime">{it.status === 'done' && it.ms !== undefined ? `${it.ms} ms` : it.status === 'running' ? 'running…' : it.status === 'skipped' ? 'no data' : it.status === 'stopped' ? 'stopped' : it.status === 'failed' ? 'failed' : ''}</span>
            </div>
          {/each}
        </div>

        {#if prog.error}
          <div class="mono" style="flex:none;font-size:var(--px-11_5);color:var(--error);white-space:pre-wrap;word-break:break-word;max-height:var(--px-100);overflow:auto;margin-top:var(--px-8)">{prog.error}</div>
        {/if}

        <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);margin-top:var(--px-12)">
          {#if !follow && !finished}
            <span class="gs-link" role="button" tabindex="0" onclick={() => ((follow = true), scheduleFollow())} onkeydown={(e) => e.key === 'Enter' && ((follow = true), scheduleFollow())}>↓ Follow the running object</span>
          {/if}
          <span style="margin-left:auto"></span>
          {#if !finished}
            <span
              class="cfm-btn danger"
              role="button"
              tabindex="0"
              aria-disabled={prog.stopping}
              title="Stop generating — nothing is written"
              style="opacity:{prog.stopping ? 0.6 : 1};cursor:{prog.stopping ? 'default' : 'pointer'}"
              onclick={stop}
              onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), stop())}
            >{prog.stopping ? 'Stopping…' : 'Stop'}</span>
          {:else}
            <span class="cfm-btn" role="button" tabindex="0" onclick={closeProgress} onkeydown={(e) => e.key === 'Enter' && closeProgress()}>Close</span>
          {/if}
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .gs-dialog {
    width: var(--px-740);
    max-width: 95vw;
    height: min(var(--px-680), 90vh);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-14);
    box-shadow: var(--shadow-lg);
  }
  .gs-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-16) var(--px-20);
    border-bottom: var(--px-1) solid var(--border);
  }
  .gs-head-icon {
    flex: none;
    width: var(--px-38);
    height: var(--px-38);
    border-radius: var(--px-10);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .gs-title {
    font-size: var(--px-16);
    font-weight: 650;
    color: var(--text);
    line-height: 1.25;
  }
  .gs-sub {
    font-size: var(--px-12_5);
    color: var(--muted);
    margin-top: var(--px-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gs-sub b {
    color: var(--text2);
    font-weight: 600;
  }
  .gs-x {
    flex: none;
    width: var(--px-28);
    height: var(--px-28);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-6);
    cursor: pointer;
    color: var(--muted);
    font-size: var(--px-20);
  }
  .gs-x:hover {
    background: var(--hover);
    color: var(--text);
  }
  .gs-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    padding: var(--px-16) var(--px-20) var(--px-12);
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
  }
  .gs-section-label {
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
  }
  .gs-section-row {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: var(--px-10);
    margin-top: var(--px-6);
  }
  .gs-selcount,
  .gs-matchcount {
    font-size: var(--px-12);
    color: var(--muted);
  }
  .gs-matchcount {
    color: var(--primary);
  }
  .gs-modes {
    flex: none;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--px-8);
  }
  .gs-mode {
    display: flex;
    align-items: flex-start;
    gap: var(--px-9);
    padding: var(--px-10) var(--px-12);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    background: var(--raised);
    cursor: pointer;
    transition:
      border-color 0.12s ease,
      background-color 0.12s ease,
      box-shadow 0.12s ease;
  }
  .gs-mode:hover {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border2));
  }
  .gs-mode.on {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 7%, var(--raised));
    box-shadow: 0 0 0 var(--px-3) var(--ring-soft);
  }
  .gs-mode input {
    margin: var(--px-2) 0 0;
    accent-color: var(--primary);
  }
  .gs-mode-text {
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    min-width: 0;
  }
  .gs-mode-title {
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
  }
  .gs-mode-desc {
    font-size: var(--px-11_5);
    color: var(--muted);
    line-height: 1.35;
  }
  .gs-toolbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-6);
  }
  .gs-search {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--px-7);
    padding: 0 var(--px-10);
    height: var(--px-34);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    color: var(--muted);
    box-sizing: border-box;
  }
  /* The focus ring belongs to the whole box — the global input:focus ring
     (theme.css) would otherwise draw a second frame INSIDE it. */
  .gs-search:focus-within {
    border-color: var(--primary);
    box-shadow: 0 0 0 var(--px-3) var(--ring-soft);
    color: var(--primary);
  }
  .gs-search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0 !important;
    outline: 0;
    box-shadow: none !important;
    background: transparent;
    -webkit-appearance: none;
    appearance: none;
    color: var(--text);
    font-size: var(--px-13);
    line-height: normal;
  }
  .gs-search input::-webkit-search-cancel-button {
    display: none;
  }
  .gs-clear {
    cursor: pointer;
    font-size: var(--px-15);
    color: var(--muted);
  }
  .gs-ghost {
    flex: none;
    display: inline-flex;
    align-items: center;
    height: var(--px-34);
    padding: 0 var(--px-10);
    border-radius: var(--px-8);
    font-size: var(--px-12_5);
    color: var(--text2);
    cursor: pointer;
  }
  .gs-ghost:hover {
    background: var(--hover);
    color: var(--text);
  }
  .gs-link {
    cursor: pointer;
    color: var(--primary);
    font-size: var(--px-12);
    font-weight: 500;
  }
  .gs-link:hover {
    text-decoration: underline;
  }
  .gs-list {
    flex: 1;
    min-height: var(--px-200);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    overflow: auto;
    padding: var(--px-4) var(--px-6) var(--px-8);
    display: flex;
    flex-direction: column;
  }
  .gs-note {
    font-size: var(--px-13);
    color: var(--muted);
    padding: var(--px-20);
    text-align: center;
  }
  .gs-group {
    display: flex;
    align-items: center;
    gap: var(--px-4);
    margin-top: var(--px-4);
    position: sticky;
    top: calc(-1 * var(--px-4));
    background: var(--surface);
    z-index: 1;
    padding: var(--px-5) var(--px-2);
    border-bottom: var(--px-1) solid var(--border);
  }
  .gs-chev {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-20);
    height: var(--px-20);
    border-radius: var(--px-5);
    color: var(--muted);
    cursor: pointer;
  }
  .gs-chev:hover {
    background: var(--hover);
    color: var(--text);
  }
  .gs-group-label {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
  }
  .gs-kicon {
    flex: none;
    display: inline-flex;
    align-items: center;
  }
  .gs-kicon.small {
    opacity: 0.9;
  }
  .gs-pill {
    margin-left: auto;
    font-size: var(--px-11);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    padding: var(--px-1) var(--px-8);
  }
  .gs-pill.full {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 10%, transparent);
    border-color: color-mix(in srgb, var(--primary) 25%, transparent);
  }
  .gs-item {
    display: flex;
    align-items: center;
    gap: var(--px-9);
    font-size: var(--px-13);
    color: var(--text);
    cursor: pointer;
    min-height: var(--px-28);
    padding: 0 var(--px-8) 0 var(--px-30);
    border-radius: var(--px-6);
    min-width: 0;
  }
  .gs-item:hover {
    background: var(--hover);
  }
  .gs-list:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
    box-shadow: 0 0 0 var(--px-3) var(--ring-soft);
  }
  /* the row the keyboard is on — visible always, strongest while the list has focus */
  .gs-item.active,
  .gs-group.active {
    background: color-mix(in srgb, var(--primary) 9%, var(--surface));
    box-shadow: inset var(--px-3) 0 0 color-mix(in srgb, var(--primary) 55%, transparent);
  }
  .gs-list:focus .gs-item.active,
  .gs-list:focus .gs-group.active {
    background: color-mix(in srgb, var(--primary) 16%, var(--surface));
    box-shadow: inset var(--px-3) 0 0 var(--primary);
  }
  /* sticky group headers must not hide the row being scrolled to */
  .gs-item {
    scroll-margin-top: var(--px-40);
  }
  .gs-item input,
  .gs-group-label input {
    accent-color: var(--primary);
  }
  .gs-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gs-foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-12) var(--px-20);
    border-top: var(--px-1) solid var(--border);
    background: var(--panel);
  }
  .gs-summary {
    margin-right: auto;
    font-size: var(--px-12_5);
    color: var(--muted);
  }
  .gs-summary b {
    color: var(--text);
    font-weight: 600;
  }
  .gs-prog {
    width: var(--px-600);
    max-width: 92vw;
    height: min(var(--px-560), 86vh);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-14);
    box-shadow: 0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);
    padding: var(--px-18);
  }
  .gs-line {
    font-size: var(--px-11_5);
    color: var(--text2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: var(--px-6);
  }
  .gs-status {
    display: flex;
    align-items: baseline;
    gap: var(--px-10);
    font-size: var(--px-11_5);
    margin-bottom: var(--px-8);
    min-width: 0;
  }
  .gs-count {
    flex: none;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .gs-cur {
    flex: 1;
    min-width: 0;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .gs-runlist {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin-top: var(--px-10);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-3);
    background: var(--panel);
  }
  .gs-run {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    height: var(--px-24);
    padding: 0 var(--px-8);
    border-radius: var(--px-4);
    font-size: var(--px-11_5);
    color: var(--muted);
    min-width: 0;
  }
  .gs-run[data-status='running'] {
    background: color-mix(in srgb, var(--primary) 14%, transparent);
    color: var(--text);
    font-weight: 600;
  }
  .gs-run[data-status='done'] {
    color: var(--text2);
  }
  .gs-run[data-status='done'] .gs-st {
    color: var(--success);
  }
  .gs-run[data-status='failed'] .gs-st,
  .gs-run[data-status='failed'] .gs-rtime {
    color: var(--error);
  }
  .gs-run[data-status='stopped'] .gs-st {
    color: var(--warn);
  }
  .gs-st {
    flex: none;
    width: var(--px-14);
    display: inline-flex;
    justify-content: center;
  }
  .gs-spin {
    width: var(--px-10);
    height: var(--px-10);
    border-radius: 50%;
    border: var(--px-2) solid color-mix(in srgb, var(--primary) 30%, transparent);
    border-top-color: var(--primary);
    animation: gs-spin 0.8s linear infinite;
  }
  @keyframes gs-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .gs-spin {
      animation: none;
    }
  }
  .gs-rname {
    font-size: var(--px-12_5);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .gs-rtime {
    flex: none;
    font-size: var(--px-10_5);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
</style>
