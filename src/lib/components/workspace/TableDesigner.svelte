<script lang="ts">
  // Table Designer (Phase 5 · T3, extended) — full attribute editor with tabs:
  // Fields · Indexes · Foreign Keys · Uniques · Checks · Triggers. Save (Ctrl/Cmd+S
  // or the button) runs dialect-correct DDL: a full CREATE for a new table, or
  // ALTER/CREATE for the objects added to an existing one (see sql/table-designer).
  import { tick, untrack, onDestroy } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { systemMeta } from '$lib/systems'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { dbIcon } from '$lib/explorer/icons'
  import { designerTypes } from '$lib/sql/ddl'
  import { defaultColumnType } from '$lib/sql/datatypes'
  import TypeSelect from '$lib/components/TypeSelect.svelte'
  import SearchSelect from '$lib/components/SearchSelect.svelte'
  import MultiSelect from '$lib/components/MultiSelect.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
  import {
    buildTableDdl,
    type DesignColumn,
    type DesignIndex,
    type DesignForeignKey,
    type DesignUnique,
    type DesignCheck,
    type DesignTrigger,
    type TableModel,
  } from '$lib/sql/table-designer'
  import {
    supportsPartitioning,
    canConvertToPartitioned,
    parsePartitionMethod,
    partitionKeyColumns,
    buildPartitionCreate,
    buildAddPartition,
    buildConvertToPartitioned,
    type PartStrategy,
    type PartitionDef,
    type PartitionSpec,
  } from '$lib/sql/partitions'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const st = $derived(tab.state as { schema?: string; table?: string })
  const profile = $derived(connections.byId(tab.connectionId))
  const dbName = $derived(connections.databaseOf(tab.connectionId))
  const system = $derived(tab.systemType)
  const accent = $derived(systemMeta(system).accent)
  const types = $derived(designerTypes(system))

  const initState = untrack(() => tab.state) as { schema?: string; table?: string }
  // Existing table → ALTER additions; blank → CREATE a new table.
  const isNew = !initState.table
  const isActive = $derived(tab.id === tabs.activeTabId || tab.id === tabs.activeTabId1)

  let name = $state(initState.table || 'new_table')
  let schema = $state(initState.schema || '')
  let cols = $state<DesignColumn[]>([])
  let indexes = $state<DesignIndex[]>([])
  let fks = $state<DesignForeignKey[]>([])
  let uniques = $state<DesignUnique[]>([])
  let checks = $state<DesignCheck[]>([])
  let triggers = $state<DesignTrigger[]>([])
  let mode = $state<'table' | 'scripts'>('table')
  type DesignerTab = 'fields' | 'indexes' | 'foreign-keys' | 'uniques' | 'checks' | 'triggers' | 'partitions'
  let activeTab = $state<DesignerTab>('fields')
  let execMsg = $state('')
  let seeded = $state(false)

  // ---- partitioning (supported engines; new tables create, existing tables add) -
  const canPartition = $derived(supportsPartitioning(system))
  // Existing table already partitioned (seeded) → strategy/key are read-only; the
  // user can only ADD partitions. New table → full create controls.
  let partSeededExisting = $state(false)
  const partLocked = $derived(!isNew && partSeededExisting)
  let partEnabled = $state(false)
  let partStrategy = $state<PartStrategy>('RANGE')
  let partColumns = $state('') // comma-separated key column(s)/expression
  let partColumnsMode = $state(false) // MySQL RANGE COLUMNS / LIST COLUMNS
  let partHashCount = $state(4)
  // Row model carries structured RANGE bounds (from/to for PG) alongside the raw
  // `bound`, so the UI can offer separate fields but the builder still gets a string.
  interface PartRow extends PartitionDef {
    from?: string
    to?: string
  }
  let partDefs = $state<PartRow[]>([{ name: '', bound: '', from: '', to: '' }])
  const addPartDef = () => (partDefs = [...partDefs, { name: '', bound: '', from: '', to: '' }])
  const removePartDef = (i: number) => (partDefs = partDefs.filter((_, j) => j !== i))

  // Compose a new row's bound string from its structured fields. PG RANGE uses
  // FROM (…) TO (…); everything else uses the single `bound` field. Returns '' when
  // incomplete so the builder skips the row.
  function effectiveBound(p: PartRow): string {
    if (p.existing) return p.bound
    if (partStrategy === 'RANGE' && system === 'postgres') {
      const f = (p.from ?? '').trim()
      const to = (p.to ?? '').trim()
      return f && to ? `FROM (${f}) TO (${to})` : ''
    }
    return p.bound.trim()
  }

  // Converting an EXISTING non-partitioned table (user enabled partitioning on a
  // table that wasn't seeded as partitioned).
  const partConvert = $derived(!isNew && !partSeededExisting && partEnabled)
  // Whether the "Partition this table" toggle can be enabled: new tables always,
  // existing tables only when the engine supports converting (not already partitioned).
  const canEnablePart = $derived(isNew || (!partSeededExisting && canConvertToPartitioned(system)))

  // The partition spec fed to the DDL builder (model + inline preview share it).
  function partSpec(): PartitionSpec | undefined {
    if (!(canPartition && partEnabled && partColumns.trim())) return undefined
    return {
      strategy: partStrategy,
      columns: splitCols(partColumns),
      columnsMode: partColumnsMode,
      hashCount: partHashCount,
      convert: partConvert,
      partitions: partDefs
        .map((p) => ({ name: p.name, bound: effectiveBound(p), existing: p.existing }))
        .filter((p) => p.existing || (p.name.trim() && p.bound.trim())),
    }
  }

  // MSSQL types its partition function from the key column's declared type.
  function partKeyType(): string {
    const kc = cols.find((c) => c.name === splitCols(partColumns)[0])
    return kc ? `${(kc.type || 'int').trim()}${kc.len.trim() ? `(${kc.len.trim()})` : ''}` : 'int'
  }

  // Live, partition-only script + warnings shown inside the tab (script + UI
  // together): new-table CREATE, existing-table CONVERT, or ADD for new rows.
  const partBuild = $derived.by<{ script: string; warnings: string[] }>(() => {
    const spec = partSpec()
    if (!spec) return { script: '', warnings: [] }
    if (isNew) {
      if (system === 'clickhouse') return { script: '', warnings: [] }
      const pc = buildPartitionCreate(system, schema || '', name || 'new_table', spec, partKeyType())
      const lines = [...pc.pre]
      if (pc.clause) lines.push(`-- on CREATE TABLE: ${pc.clause}`)
      lines.push(...pc.post)
      return { script: lines.join('\n'), warnings: pc.warnings }
    }
    if (spec.convert) {
      const conv = buildConvertToPartitioned(system, schema, name, spec, partKeyType())
      return { script: [...conv.pre, ...conv.post].join('\n'), warnings: conv.warnings }
    }
    const out: string[] = []
    const warns: string[] = []
    for (const p of spec.partitions ?? []) {
      if (p.existing) continue
      const { sql, warning } = buildAddPartition(system, schema, name, spec.strategy, p)
      if (sql) out.push(sql)
      if (warning) warns.push(warning)
    }
    return { script: out.join('\n'), warnings: warns }
  })
  const partScript = $derived(partBuild.script)

  const TABS = $derived<[DesignerTab, string][]>([
    ['fields', 'Fields'],
    ['indexes', 'Indexes'],
    ['foreign-keys', 'Foreign Keys'],
    ['uniques', 'Uniques'],
    ['checks', 'Checks'],
    ['triggers', 'Triggers'],
    ...(canPartition ? ([['partitions', 'Partitioning']] as [DesignerTab, string][]) : []),
  ])

  function blankCol(): DesignColumn {
    return { name: '', type: defaultColumnType(system), len: '', pk: false, nullable: true, dflt: '' }
  }

  // ---- dropdown data (item: columns/ref-table/ref-column/method/actions are pickers) --
  // Column names in THIS table — options for index / unique / FK columns.
  const colNames = $derived(cols.filter((c) => !c.dropped && c.name.trim()).map((c) => c.name))
  // Tables in the schema (FK "Ref. table") + the ref table's columns (loaded lazily).
  let schemaTables = $state<string[]>([])
  let refColsCache = $state<Record<string, string[]>>({})
  async function loadRefCols(tbl: string) {
    if (!tbl || refColsCache[tbl] || !tab.connectionId) return
    try {
      const cs = await ipc.listColumns(tab.connectionId, st.schema ?? '', tbl)
      refColsCache = { ...refColsCache, [tbl]: cs.map((c) => c.name) }
    } catch {
      refColsCache = { ...refColsCache, [tbl]: [] }
    }
  }
  const refTableOptions = $derived([{ value: null as string | null, label: '—' }, ...schemaTables.map((t) => ({ value: t as string | null, label: t }))])
  // FK referential actions — SQL standard.
  const FK_ACTIONS = ['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT']
  const fkActionOptions = [{ value: null as string | null, label: '— (default)' }, ...FK_ACTIONS.map((a) => ({ value: a as string | null, label: a }))]
  // Index access methods per dialect (SQL standard).
  function indexMethods(sys: string): string[] {
    switch (sys) {
      case 'postgres': return ['btree', 'hash', 'gist', 'gin', 'brin', 'spgist']
      case 'mysql': case 'mariadb': return ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL']
      case 'mssql': return ['NONCLUSTERED', 'CLUSTERED']
      default: return ['btree']
    }
  }
  const idxMethodOptions = $derived([{ value: null as string | null, label: '— (default)' }, ...indexMethods(system).map((m) => ({ value: m as string | null, label: m }))])

  const splitCols = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

  const model = $derived<TableModel>({
    schema,
    table: name,
    columns: cols,
    indexes,
    foreignKeys: fks,
    uniques,
    checks,
    triggers,
    partition: partSpec(),
  })
  const build = $derived(buildTableDdl(system, model, isNew))
  const ddlText = $derived(build.statements.join('\n\n'))

  // Seed: existing table → its real objects (marked `existing`, never re-created);
  // new table → one id PK row to start from.
  $effect(() => {
    if (seeded || !tab.connectionId) return
    untrack(() => void seed())
  })
  async function seed() {
    seeded = true
    const cid = tab.connectionId
    const sch = st.schema ?? ''
    // tables in the schema for the FK "Ref. table" dropdown (new + existing tables)
    if (cid) {
      try {
        const tbls = await ipc.listTables(cid, sch)
        schemaTables = tbls.filter((t) => t.kind !== 'view').map((t) => t.name)
      } catch {
        /* keep */
      }
    }
    if (cid && st.table) {
      try {
        const existing = await ipc.listColumns(cid, sch, st.table)
        cols = existing.map((c) => ({
          name: c.name,
          type: c.data_type,
          len: '',
          pk: c.is_pk,
          nullable: c.nullable,
          dflt: c.default ?? '',
          existing: true,
          orig: { name: c.name, type: c.data_type, len: '', nullable: c.nullable, dflt: c.default ?? '' },
        }))
      } catch {
        cols = []
      }
      try {
        const ix = await ipc.listIndexes(cid, sch, st.table)
        indexes = ix.filter((i) => !i.primary && !i.unique).map((i) => ({ name: i.name, columns: [...i.columns], method: i.method, existing: true, orig: { columns: [...i.columns], method: i.method } }))
        uniques = ix.filter((i) => i.unique && !i.primary).map((i) => ({ name: i.name, columns: [...i.columns], existing: true, orig: { columns: [...i.columns] } }))
      } catch {
        /* keep empty */
      }
      try {
        const cons = await ipc.listConstraints(cid, sch, st.table)
        checks = cons.filter((c) => /check/i.test(c.kind)).map((c) => ({ name: c.name, expression: c.definition ?? '', existing: true }))
        // uniques declared as constraints (not seen as unique indexes above)
        for (const c of cons.filter((c) => /unique/i.test(c.kind))) {
          if (!uniques.some((u) => u.name === c.name)) uniques.push({ name: c.name, columns: [], existing: true, orig: { columns: [] } })
        }
        uniques = [...uniques]
      } catch {
        /* keep */
      }
      try {
        const allFk = await ipc.listForeignKeys(cid, sch)
        fks = allFk
          .filter((f) => f.from_table === st.table)
          .map((f) => ({ name: f.name, columns: [f.from_column], refTable: f.to_table, refColumns: [f.to_column], existing: true, orig: { columns: [f.from_column], refTable: f.to_table, refColumns: [f.to_column], onDelete: '', onUpdate: '' } }))
        for (const f of fks) if (f.refTable) void loadRefCols(f.refTable)
      } catch {
        /* keep */
      }
      try {
        const trg = await ipc.listTriggers(cid, sch)
        triggers = trg.filter((t) => t.table === st.table).map((t) => ({ name: t.name, timing: '', event: t.event, body: '', table: t.table, existing: true }))
      } catch {
        /* keep */
      }
      if (supportsPartitioning(system)) {
        try {
          const parts = await ipc.listPartitions(cid, sch, st.table)
          if (parts.length) {
            const { strategy, columnsMode } = parsePartitionMethod(parts[0].method)
            partStrategy = strategy
            partColumnsMode = columnsMode
            partColumns = partitionKeyColumns(parts[0].key ?? '')
            // Existing partitions are read-only; strip PG's "FOR VALUES " prefix so
            // the bound field matches what a new partition row expects.
            partDefs = parts.map((p) => ({
              name: p.name,
              bound: (p.expression ?? '').replace(/^FOR VALUES\s+/i, ''),
              from: '',
              to: '',
              existing: true,
            }))
            partEnabled = true
            partSeededExisting = true
          }
        } catch {
          /* keep — not partitioned / not supported */
        }
      }
    }
    if (cols.length === 0) {
      cols = [{ name: 'id', type: defaultColumnType(system), len: '', pk: true, nullable: false, dflt: '' }]
    }
  }

  // ---- row add/remove helpers ------------------------------------------------
  // Existing objects are marked `dropped` (→ DROP on save, toggleable); brand-new
  // rows are just removed from the array.
  function removeOrDrop<T extends { existing?: boolean; dropped?: boolean }>(arr: T[], i: number): T[] {
    const it = arr[i]
    if (it?.existing) {
      it.dropped = !it.dropped
      return [...arr]
    }
    return arr.filter((_, idx) => idx !== i)
  }
  const addCol = () => (cols = [...cols, blankCol()])
  const delCol = (i: number) => (cols = removeOrDrop(cols, i))

  // ---- Fields grid: keyboard row-append + navigation + drag-reorder ----------
  // A row "has data" once its name is filled — used to decide whether Tab/Down at
  // the last row should open a fresh row (never a second empty one).
  const rowHasData = (c: DesignColumn) => c.name.trim() !== ''
  // Focus a specific cell input by (row, column) — ids are namespaced per tab so
  // split panes don't collide.
  function focusCell(row: number, colKey: 'name' | 'len' | 'dflt') {
    const el = document.getElementById(`tdf-${tab.id}-${row}-${colKey}`) as HTMLInputElement | null
    el?.focus()
    el?.select?.()
  }
  async function appendAndFocus(colKey: 'name' | 'len' | 'dflt') {
    addCol()
    await tick()
    focusCell(cols.length - 1, colKey)
  }
  // Down/Up move between rows on the same column; at the last row, Down (or Tab
  // off the last field) appends a new row when the current row has data.
  async function fieldKey(e: KeyboardEvent, i: number, colKey: 'name' | 'len' | 'dflt') {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (i >= cols.length - 1) {
        if (rowHasData(cols[i])) await appendAndFocus(colKey)
      } else {
        focusCell(i + 1, colKey)
      }
    } else if (e.key === 'ArrowUp') {
      if (i > 0) {
        e.preventDefault()
        focusCell(i - 1, colKey)
      }
    } else if (e.key === 'Tab' && !e.shiftKey && colKey === 'dflt' && i === cols.length - 1 && rowHasData(cols[i])) {
      e.preventDefault()
      await appendAndFocus('name')
    }
  }
  // Reorder rows — the row order is exactly what Save emits (column order in the
  // generated DDL). Drag&drop uses POINTER events, not the native HTML5 drag API:
  // WebView2 (Tauri) hands file-style drag-drop to the OS, which swallows HTML5
  // dragstart/drop inside the page — so native DnD silently does nothing there.
  // Pointer capture + live reorder works in both the WebView and the browser.
  // The ▲/▼ buttons remain as a keyboard/click fallback.
  let fieldsBody = $state<HTMLTableSectionElement | null>(null)
  let dragRow = $state<number | null>(null) // current index of the row being dragged
  let dragStartRow = $state<number | null>(null) // where the drag began (for direction)
  // Which way the dragged row has moved vs. where it was grabbed — drives the
  // ↑/↓ direction badge and accent bar so you can see it lifting up or down.
  const dragDir = $derived<'up' | 'down' | null>(
    dragRow == null || dragStartRow == null || dragRow === dragStartRow
      ? null
      : dragRow < dragStartRow
        ? 'up'
        : 'down'
  )

  function reorderCols(from: number, to: number) {
    if (from === to || to < 0 || from < 0 || to >= cols.length || from >= cols.length) return
    const next = [...cols]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    cols = next
  }
  const moveRow = (i: number, dir: -1 | 1) => reorderCols(i, i + dir)

  // Index of the <tbody> row the cursor is directly over (box contains y), clamped
  // to the first/last row when above/below the list. Containment (not midpoint
  // crossing) makes the live drag target the row you're hovering, so dropping onto
  // a row's center reorders there.
  function rowIndexFromY(y: number): number | null {
    if (!fieldsBody) return null
    const rows = Array.from(fieldsBody.querySelectorAll('tr'))
    if (rows.length === 0) return null
    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx].getBoundingClientRect()
      if (y >= r.top && y <= r.bottom) return idx
    }
    return y < rows[0].getBoundingClientRect().top ? 0 : rows.length - 1
  }
  // Global listeners while dragging (attached on pointerdown, removed on pointerup)
  // — more reliable than element pointer-capture across the WebView + tests.
  function onDragMove(e: PointerEvent) {
    if (dragRow == null) return
    const t = rowIndexFromY(e.clientY)
    if (t != null && t !== dragRow) {
      reorderCols(dragRow, t) // live reorder → DOM follows (keyed by object identity)
      dragRow = t
    }
  }
  function onDragUp() {
    dragRow = null
    dragStartRow = null
    document.body.style.cursor = '' // release the global grabbing cursor
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragUp)
  }
  function dragStart(i: number, e: PointerEvent) {
    if (e.button !== 0) return // left button only
    dragRow = i
    dragStartRow = i
    document.body.style.cursor = 'grabbing' // whole-window feedback while dragging
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
    e.preventDefault()
  }
  onDestroy(() => {
    document.body.style.cursor = ''
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragUp)
  })
  const addIndex = () => (indexes = [...indexes, { name: '', columns: [], method: '' }])
  const delIndex = (i: number) => (indexes = removeOrDrop(indexes, i))
  const addFk = () => (fks = [...fks, { name: '', columns: [], refTable: '', refColumns: [], onDelete: '', onUpdate: '' }])
  const delFk = (i: number) => (fks = removeOrDrop(fks, i))
  const addUnique = () => (uniques = [...uniques, { name: '', columns: [] }])
  const delUnique = (i: number) => (uniques = removeOrDrop(uniques, i))
  const addCheck = () => (checks = [...checks, { name: '', expression: '' }])
  const delCheck = (i: number) => (checks = removeOrDrop(checks, i))
  const addTrigger = () => (triggers = [...triggers, { name: '', timing: 'BEFORE', event: 'INSERT', body: '' }])
  const delTrigger = (i: number) => (triggers = removeOrDrop(triggers, i))

  async function save() {
    if (!tab.connectionId) return
    execMsg = ''
    const { statements, warnings } = build
    for (const w of warnings) toasts.show(w, { kind: 'info', duration: 6000 })
    if (!statements.length) {
      toasts.error(warnings.length ? 'Nothing to run (see warnings)' : 'Nothing to run — add a column or object first')
      return
    }
    try {
      let done = 0
      for (const sql of statements) {
        const res = await ipc.execStatement(tab.connectionId, sql, 0)
        if (!res.ok) {
          toasts.error(res.error?.message ?? 'DDL error', system)
          if (done) explorer.refresh(tab.connectionId, { kind: 'connection' })
          return
        }
        done++
      }
      execMsg = `✓ Applied ${done} statement(s)`
      toasts.success(`Applied ${done} statement(s) to ${name}`, system)
      explorer.refresh(tab.connectionId, { kind: 'connection' })
    } catch (e) {
      toasts.error(`${e}`, system)
    }
  }

  // Ctrl/Cmd+S → Save (only the active designer tab reacts).
  function onWinKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && isActive) {
      e.preventDefault()
      void save()
    }
  }
</script>

<svelte:window onkeydown={onWinKey} />

<div class="td-root" style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- header — the table's name first (what you're designing), then where it
       lives, then the actions. Plain language: "New table" / "Editing", not DDL. -->
  <div class="td-head">
    <span class="td-head-icon" style="color:{accent};background:color-mix(in srgb, {accent} 14%, transparent)" aria-hidden="true">{@html dbIcon('table', 18)}</span>
    <div class="td-head-main">
      <div class="td-name-row">
        <input
          bind:value={name}
          disabled={!isNew}
          class="td-name"
          aria-label="Table name"
          placeholder="table_name"
          spellcheck="false"
          title={isNew ? 'Table name' : 'Rename the table from the Explorer (Rename…)'}
        />
        {#if isNew}
          <span class="td-badge new">New table</span>
        {:else}
          <span class="td-badge edit" title="Saving changes the existing table (ALTER TABLE)">Editing</span>
        {/if}
      </div>
      <div class="td-crumbs">
        <SystemBadge system={system} />
        <span class="td-crumb-strong" title="Connection">{profile?.name ?? '—'}</span>
        <span class="td-sep" aria-hidden="true">›</span>
        <span title={`Database: ${dbName || '(none)'}${schema && schema !== dbName ? ` · schema: ${schema}` : ''}`}>{dbName || 'database'}{#if schema && schema !== dbName}<span class="td-sep" aria-hidden="true">›</span>{schema}{/if}</span>
      </div>
    </div>
    <div class="td-seg" role="group" aria-label="View">
      <span onclick={() => (mode = 'table')} onkeydown={(e) => e.key === 'Enter' && (mode = 'table')} role="button" tabindex="0" class:on={mode === 'table'}>Table</span>
      <span onclick={() => (mode = 'scripts')} onkeydown={(e) => e.key === 'Enter' && (mode = 'scripts')} role="button" tabindex="0" class:on={mode === 'scripts'}>Scripts</span>
    </div>
    {#if execMsg}<span class="td-saved">{execMsg}</span>{/if}
    <span onclick={save} onkeydown={(e) => e.key === 'Enter' && save()} role="button" tabindex="0" title="Save (Ctrl/Cmd+S)" class="cfm-btn primary">Save</span>
  </div>

  {#if mode === 'table'}
    <!-- attribute tab bar (Fields · Indexes · Foreign Keys · Uniques · Checks · Triggers) -->
    <div class="td-tabs">
      {#each TABS as [id, label] (id)}
        {@const count = id === 'fields' ? cols.length : id === 'indexes' ? indexes.length : id === 'foreign-keys' ? fks.length : id === 'uniques' ? uniques.length : id === 'checks' ? checks.length : triggers.length}
        <span
          onclick={() => (activeTab = id)}
          onkeydown={(e) => e.key === 'Enter' && (activeTab = id)}
          role="tab"
          tabindex="0"
          aria-selected={activeTab === id}
          class="td-tab"
          class:on={activeTab === id}
          style="--td-accent:{accent}"
        >{label}{#if count}<span class="td-count">{count}</span>{/if}</span>
      {/each}
    </div>

    <div style="flex:1;overflow:auto;min-height:0">
      {#if activeTab === 'fields'}
        <table class="td-grid">
          <thead><tr>
            {#each [['#', 'width:var(--px-90);text-align:center'], ['Column', ''], ['Type', 'width:var(--px-160)'], ['Length', 'width:var(--px-90)'], ['PK', 'width:var(--px-60);text-align:center'], ['Nullable', 'width:var(--px-70);text-align:center'], ['Default', 'width:var(--px-150)'], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style={extra}>{h}</th>
            {/each}
          </tr></thead>
          <tbody bind:this={fieldsBody}>
            {#each cols as col, i (col)}
              {@const dragging = dragRow === i}
              <tr
                style={`${col.dropped ? 'opacity:0.5;text-decoration:line-through;' : ''}${dragging ? `background:color-mix(in srgb, ${accent} 16%, var(--surface));box-shadow:inset var(--px-3) 0 0 ${accent}, 0 var(--px-3) var(--px-8) var(--rgba-0-0-0-_5);position:relative;z-index:1;` : ''}`}
              >
                <!-- # cell: drag handle (press & hold, move up/down) via POINTER
                     events — reliable in the Tauri WebView where native HTML5 drag
                     is swallowed by the OS drag-drop handler. Row order = column
                     order emitted on Save. The ⠿ grip reads as "draggable"; while
                     dragging, the handle becomes a ↑/↓ badge showing the direction.
                     ▲/▼ remain as a click fallback. -->
                <td
                  onpointerdown={(e) => dragStart(i, e)}
                  title="Drag to reorder"
                  class="td-cell" style="cursor:{dragging ? 'grabbing' : 'grab'};user-select:none;touch-action:none"
                >
                  <div style="display:flex;align-items:center;justify-content:center;gap:var(--px-4)">
                    {#if dragging}
                      <!-- direction badge: which way this row is moving vs. grab point -->
                      <span class="mono" title={dragDir === 'up' ? 'Moving up' : dragDir === 'down' ? 'Moving down' : 'Drag up or down'} style="display:inline-flex;align-items:center;justify-content:center;width:var(--px-16);height:var(--px-16);font-size:var(--px-13);font-weight:700;line-height:1;color:{accent}">{dragDir === 'up' ? '↑' : dragDir === 'down' ? '↓' : '↕'}</span>
                    {:else}
                      <!-- grip handle (two columns of dots) — the universal "drag me" affordance -->
                      <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true" style="flex:none;color:var(--muted)">
                        {#each [2, 7, 12] as cy (cy)}
                          <circle cx="2" cy={cy} r="1.15" fill="currentColor" />
                          <circle cx="6" cy={cy} r="1.15" fill="currentColor" />
                        {/each}
                      </svg>
                    {/if}
                    <span class="mono" style="color:{dragging ? accent : 'var(--muted)'};font-weight:{dragging ? 700 : 400};font-size:var(--px-11);min-width:var(--px-14);text-align:center">{i + 1}</span>
                    <div style="display:flex;flex-direction:column;line-height:0.7">
                      <span onpointerdown={(e) => e.stopPropagation()} onclick={() => moveRow(i, -1)} onkeydown={(e) => e.key === 'Enter' && moveRow(i, -1)} role="button" tabindex="0" title="Move up" style="cursor:pointer;color:{i === 0 ? 'var(--border2)' : 'var(--muted)'};font-size:var(--px-9);line-height:0.9">▲</span>
                      <span onpointerdown={(e) => e.stopPropagation()} onclick={() => moveRow(i, 1)} onkeydown={(e) => e.key === 'Enter' && moveRow(i, 1)} role="button" tabindex="0" title="Move down" style="cursor:pointer;color:{i === cols.length - 1 ? 'var(--border2)' : 'var(--muted)'};font-size:var(--px-9);line-height:0.9">▼</span>
                    </div>
                  </div>
                </td>
                <td class="td-cell"><input id={`tdf-${tab.id}-${i}-name`} bind:value={col.name} onkeydown={(e) => fieldKey(e, i, 'name')} class="td-in" /></td>
                <td class="td-cell" style="position:relative">
                  <!-- searchable type dropdown showing the full per-engine catalog
                       (custom combobox — reliable in WebView2, unlike <datalist>). -->
                  <TypeSelect bind:value={col.type} options={types} placeholder="type…" />
                </td>
                <td class="td-cell"><input id={`tdf-${tab.id}-${i}-len`} bind:value={col.len} onkeydown={(e) => fieldKey(e, i, 'len')} class="td-in code" /></td>
                <td class="td-cell" style="text-align:center"><span onclick={() => (col.pk = !col.pk)} onkeydown={(e) => e.key === 'Enter' && (col.pk = !col.pk)} role="button" tabindex="0" style="display:inline-flex;width:var(--px-18);height:var(--px-18);border:var(--px-1) solid var(--border2);border-radius:var(--px-5);align-items:center;justify-content:center;cursor:pointer;background:{col.pk ? 'var(--primary)' : 'transparent'};color:var(--hex-fff);font-size:var(--px-11)">{col.pk ? '✓' : ''}</span></td>
                <td class="td-cell" style="text-align:center"><span onclick={() => (col.nullable = !col.nullable)} onkeydown={(e) => e.key === 'Enter' && (col.nullable = !col.nullable)} role="button" tabindex="0" style="display:inline-flex;width:var(--px-18);height:var(--px-18);border:var(--px-1) solid var(--border2);border-radius:var(--px-5);align-items:center;justify-content:center;cursor:pointer;background:{col.nullable ? 'var(--primary)' : 'transparent'};color:var(--hex-fff);font-size:var(--px-11)">{col.nullable ? '✓' : ''}</span></td>
                <td class="td-cell"><input id={`tdf-${tab.id}-${i}-dflt`} bind:value={col.dflt} onkeydown={(e) => fieldKey(e, i, 'dflt')} class="td-in code dflt" /></td>
                <td class="td-cell" style="text-align:center"><span onclick={() => delCol(i)} onkeydown={(e) => e.key === 'Enter' && delCol(i)} role="button" tabindex="0" title={col.existing ? (col.dropped ? 'Restore column' : 'Drop column') : 'Remove column'} class="td-del" class:restore={col.dropped}>{col.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addCol} onkeydown={(e) => e.key === 'Enter' && addCol()} role="button" tabindex="0" class="td-add">＋ Add column</div>

      {:else if activeTab === 'indexes'}
        <table class="td-grid">
          <thead><tr>
            {#each [['Index name', ''], ['Columns', ''], ['Method', 'width:var(--px-160)'], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style={extra}>{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each indexes as ix, i (i)}
              <tr style={ix.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td class="td-cell"><input bind:value={ix.name} placeholder={`idx_${name}_…`} class="td-in" /></td>
                <td class="td-cell" style="position:relative"><MultiSelect bind:values={ix.columns} options={colNames} placeholder="columns…" /></td>
                <td class="td-cell" style="position:relative"><SearchSelect value={ix.method ?? null} options={idxMethodOptions} title="Index method" onChange={(v) => (ix.method = v ?? '')} /></td>
                <td class="td-cell" style="text-align:center"><span onclick={() => delIndex(i)} onkeydown={(e) => e.key === 'Enter' && delIndex(i)} role="button" tabindex="0" title={ix.existing ? (ix.dropped ? 'Restore' : 'Drop') : 'Remove'} class="td-del" class:restore={ix.dropped}>{ix.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addIndex} onkeydown={(e) => e.key === 'Enter' && addIndex()} role="button" tabindex="0" class="td-add">＋ Add index</div>

      {:else if activeTab === 'foreign-keys'}
        <table class="td-grid">
          <thead><tr>
            {#each [['Name', ''], ['Columns', ''], ['Ref. table', ''], ['Ref. columns', ''], ['ON DELETE', 'width:var(--px-140)'], ['ON UPDATE', 'width:var(--px-140)'], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style={extra}>{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each fks as fk, i (i)}
              <tr style={fk.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td class="td-cell"><input bind:value={fk.name} placeholder={`fk_${name}_…`} class="td-in" /></td>
                <td class="td-cell" style="position:relative"><MultiSelect bind:values={fk.columns} options={colNames} placeholder="columns…" /></td>
                <td class="td-cell" style="position:relative"><SearchSelect value={fk.refTable || null} options={refTableOptions} title="Referenced table" onChange={(v) => { fk.refTable = v ?? ''; if (v) void loadRefCols(v) }} /></td>
                <td class="td-cell" style="position:relative"><MultiSelect bind:values={fk.refColumns} options={refColsCache[fk.refTable] ?? []} placeholder="ref columns…" /></td>
                <td class="td-cell" style="position:relative"><SearchSelect value={fk.onDelete || null} options={fkActionOptions} title="ON DELETE" onChange={(v) => (fk.onDelete = v ?? '')} /></td>
                <td class="td-cell" style="position:relative"><SearchSelect value={fk.onUpdate || null} options={fkActionOptions} title="ON UPDATE" onChange={(v) => (fk.onUpdate = v ?? '')} /></td>
                <td class="td-cell" style="text-align:center"><span onclick={() => delFk(i)} onkeydown={(e) => e.key === 'Enter' && delFk(i)} role="button" tabindex="0" title={fk.existing ? (fk.dropped ? 'Restore' : 'Drop') : 'Remove'} class="td-del" class:restore={fk.dropped}>{fk.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addFk} onkeydown={(e) => e.key === 'Enter' && addFk()} role="button" tabindex="0" class="td-add">＋ Add foreign key</div>

      {:else if activeTab === 'uniques'}
        <table class="td-grid">
          <thead><tr>
            {#each [['Constraint name', ''], ['Columns', ''], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style={extra}>{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each uniques as u, i (i)}
              <tr style={u.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td class="td-cell"><input bind:value={u.name} placeholder={`uq_${name}_…`} class="td-in" /></td>
                <td class="td-cell" style="position:relative"><MultiSelect bind:values={u.columns} options={colNames} placeholder="columns…" /></td>
                <td class="td-cell" style="text-align:center"><span onclick={() => delUnique(i)} onkeydown={(e) => e.key === 'Enter' && delUnique(i)} role="button" tabindex="0" title={u.existing ? (u.dropped ? 'Restore' : 'Drop') : 'Remove'} class="td-del" class:restore={u.dropped}>{u.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addUnique} onkeydown={(e) => e.key === 'Enter' && addUnique()} role="button" tabindex="0" class="td-add">＋ Add unique</div>

      {:else if activeTab === 'checks'}
        <table class="td-grid">
          <thead><tr>
            {#each [['Constraint name', 'width:var(--px-220)'], ['Expression', ''], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style={extra}>{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each checks as c, i (i)}
              <tr style={c.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td class="td-cell"><input value={c.name} oninput={(e) => (c.name = e.currentTarget.value)} disabled={c.existing} placeholder={`ck_${name}_…`} class="td-in" /></td>
                <td class="td-cell"><input value={c.expression} oninput={(e) => (c.expression = e.currentTarget.value)} disabled={c.existing} placeholder="age >= 0" class="td-in code" /></td>
                <td class="td-cell" style="text-align:center"><span onclick={() => delCheck(i)} onkeydown={(e) => e.key === 'Enter' && delCheck(i)} role="button" tabindex="0" title={c.existing ? (c.dropped ? 'Restore' : 'Drop') : 'Remove'} class="td-del" class:restore={c.dropped}>{c.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addCheck} onkeydown={(e) => e.key === 'Enter' && addCheck()} role="button" tabindex="0" class="td-add">＋ Add check</div>

      {:else if activeTab === 'triggers'}
        <!-- triggers -->
        <table class="td-grid">
          <thead><tr>
            {#each [['Name', 'width:var(--px-160)'], ['Timing', 'width:var(--px-110)'], ['Event', 'width:var(--px-110)'], ['Body / function', ''], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
              <th style={extra}>{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each triggers as tr, i (i)}
              <tr style={tr.dropped ? "opacity:0.5;text-decoration:line-through" : ""}>
                <td class="td-cell"><input value={tr.name} oninput={(e) => (tr.name = e.currentTarget.value)} disabled={tr.existing} placeholder={`trg_${name}`} class="td-in" /></td>
                <td class="td-cell">
                  <select value={tr.timing} onchange={(e) => (tr.timing = e.currentTarget.value)} disabled={tr.existing} class="td-in" style="cursor:pointer">
                    {#each ['BEFORE', 'AFTER', 'INSTEAD OF'] as o (o)}<option value={o}>{o}</option>{/each}
                  </select>
                </td>
                <td class="td-cell">
                  <select value={tr.event} onchange={(e) => (tr.event = e.currentTarget.value)} disabled={tr.existing} class="td-in" style="cursor:pointer">
                    {#each ['INSERT', 'UPDATE', 'DELETE'] as o (o)}<option value={o}>{o}</option>{/each}
                  </select>
                </td>
                <td class="td-cell"><input value={tr.body} oninput={(e) => (tr.body = e.currentTarget.value)} disabled={tr.existing} placeholder={system === 'postgres' ? 'my_function()' : 'trigger body'} class="td-in code" /></td>
                <td class="td-cell" style="text-align:center"><span onclick={() => delTrigger(i)} onkeydown={(e) => e.key === 'Enter' && delTrigger(i)} role="button" tabindex="0" title={tr.existing ? (tr.dropped ? 'Restore' : 'Drop') : 'Remove'} class="td-del" class:restore={tr.dropped}>{tr.dropped ? '↺' : '×'}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div onclick={addTrigger} onkeydown={(e) => e.key === 'Enter' && addTrigger()} role="button" tabindex="0" class="td-add">＋ Add trigger</div>

      {:else}
        <!-- partitioning — new tables: create; existing partitioned tables: show
             current partitioning (read-only) + ADD partitions. -->
        <div style="padding:var(--px-14) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12);max-width:var(--px-640)">
          <label style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-13);color:var(--text);cursor:{canEnablePart && !partLocked ? 'pointer' : 'default'};opacity:{canEnablePart || partLocked ? 1 : 0.85}">
            <input type="checkbox" bind:checked={partEnabled} disabled={partLocked || !canEnablePart} /> Partition this table
          </label>
          {#if !isNew && !partEnabled}
            {#if canConvertToPartitioned(system)}
              <div style="font-size:var(--px-12);color:var(--muted);line-height:1.5">
                This table is not partitioned. Turn on to partition it —
                {#if system === 'mysql' || system === 'mariadb'}MySQL/MariaDB alter it in place (<code>ALTER TABLE … PARTITION BY …</code>).{:else if system === 'postgres'}PostgreSQL recreates it (rename + create partitioned + copy + drop) — review the script.{:else if system === 'oracle'}Oracle repartitions in place (<code>ALTER TABLE … MODIFY PARTITION BY … ONLINE</code>, needs 12cR2+) — local indexes are rebuilt.{:else if system === 'clickhouse'}ClickHouse recreates it (rename + create with PARTITION BY + copy + drop) — set ENGINE/ORDER BY to match the original before running.{:else}SQL Server creates a partition function + scheme and a clustered index on it.{/if}
              </div>
            {:else}
              <div style="font-size:var(--px-12);color:var(--muted);line-height:1.5">
                This table is not partitioned. Partitioning an existing table is not supported for this engine — use <b>New Table</b> with the Partitioning tab, then migrate the data.
              </div>
            {/if}
          {:else if partEnabled}
            {#if partLocked}
              <div style="font-size:var(--px-11);color:var(--muted)">Current partitioning (read-only) — you can add new partitions below.</div>
            {:else if partConvert}
              <div style="font-size:var(--px-11);color:var(--warn)">⚠ Converting an existing table to partitioned. Review the script below before saving.</div>
            {/if}
            <div style="display:flex;align-items:center;gap:var(--px-10);flex-wrap:wrap">
              <span style="font-size:var(--px-12);color:var(--text2)">Strategy</span>
              <select bind:value={partStrategy} disabled={system === 'clickhouse' || partLocked} style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);font-size:var(--px-12);cursor:pointer">
                {#each ['RANGE', 'LIST', 'HASH'] as s (s)}<option value={s}>{s}</option>{/each}
              </select>
              {#if system === 'mysql' || system === 'mariadb'}
                <label style="display:flex;align-items:center;gap:var(--px-6);font-size:var(--px-12);color:var(--text2);cursor:pointer">
                  <input type="checkbox" bind:checked={partColumnsMode} disabled={partLocked} /> COLUMNS mode
                </label>
              {/if}
            </div>
            <div style="display:flex;flex-direction:column;gap:var(--px-4)">
              <span style="font-size:var(--px-12);color:var(--text2)">{system === 'clickhouse' ? 'Partition expression' : 'Key column(s) / expression'}</span>
              <input bind:value={partColumns} disabled={partLocked} placeholder={system === 'clickhouse' ? 'toYYYYMM(created_at)' : 'created_at'} class="mono" style="border:var(--px-1) solid var(--border);background:var(--panel);border-radius:var(--px-6);color:var(--text);font-size:var(--px-12_5);padding:var(--px-7) var(--px-11);outline:none" />
            </div>
            {#if partStrategy === 'HASH' && system !== 'clickhouse' && !partLocked}
              <div style="display:flex;align-items:center;gap:var(--px-8)">
                <span style="font-size:var(--px-12);color:var(--text2)">Number of partitions</span>
                <input type="number" min="1" bind:value={partHashCount} class="mono" style="width:var(--px-80);border:var(--px-1) solid var(--border);background:var(--panel);border-radius:var(--px-6);color:var(--text);font-size:var(--px-12_5);padding:var(--px-5) var(--px-9);outline:none" />
              </div>
            {:else if system !== 'clickhouse'}
              <div style="display:flex;flex-direction:column;gap:var(--px-6)">
                <span style="font-size:var(--px-12);color:var(--text2)">{partLocked ? 'Partitions' : 'Initial partitions'}</span>
                <table class="td-grid">
                  <thead><tr>
                    {#each [['Partition name', 'width:var(--px-200)'], [partStrategy === 'LIST' ? 'IN values' : partStrategy === 'RANGE' && system === 'postgres' ? 'Bounds — From / To' : 'Upper bound (LESS THAN)', ''], ['', 'width:var(--px-42)']] as [h, extra] (h + extra)}
                      <th style="background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
                    {/each}
                  </tr></thead>
                  <tbody>
                    {#each partDefs as p, i (i)}
                      <tr style={p.existing ? 'opacity:0.7' : ''}>
                        <td class="td-cell"><input bind:value={p.name} disabled={p.existing} placeholder={`${name}_p${i}`} class="td-in" /></td>
                        <td class="td-cell">
                          {#if !p.existing && partStrategy === 'RANGE' && system === 'postgres'}
                            <!-- structured RANGE bounds: FROM (…) TO (…) built for you -->
                            <div style="display:flex;align-items:center;gap:var(--px-2)">
                              <input bind:value={p.from} placeholder="'2024-01-01'" class="mono" style="width:50%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-8);outline:none" />
                              <span class="mono" style="color:var(--muted);font-size:var(--px-10)">→</span>
                              <input bind:value={p.to} placeholder="'2025-01-01'" class="mono" style="width:50%;border:none;background:transparent;color:var(--text2);font-size:var(--px-12);padding:var(--px-7) var(--px-8);outline:none" />
                            </div>
                          {:else}
                            <input bind:value={p.bound} disabled={p.existing} placeholder={partStrategy === 'LIST' ? "1, 2, 3" : "2025"} class="td-in code" />
                          {/if}
                        </td>
                        <td class="td-cell" style="text-align:center">{#if !p.existing}<span onclick={() => removePartDef(i)} onkeydown={(e) => e.key === 'Enter' && removePartDef(i)} role="button" tabindex="0" title="Remove" style="cursor:pointer;color:var(--muted);font-size:var(--px-14)">×</span>{:else}<span class="mono" style="color:var(--muted);font-size:var(--px-10)" title="Existing partition">●</span>{/if}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                {#if partStrategy !== 'HASH'}
                  <div onclick={addPartDef} onkeydown={(e) => e.key === 'Enter' && addPartDef()} role="button" tabindex="0" class="td-add">＋ Add partition</div>
                {/if}
              </div>
            {/if}
            <div style="font-size:var(--px-11);color:var(--muted);line-height:1.5">
              {#if partLocked}Adding a partition{system === 'postgres' ? ' creates a child table (CREATE TABLE … PARTITION OF)' : system === 'mssql' ? ' on SQL Server needs a manual SPLIT RANGE script' : system === 'clickhouse' ? ' is automatic on INSERT for ClickHouse' : ' runs ALTER TABLE … ADD PARTITION'}.{:else if system === 'clickhouse'}ClickHouse partitions by an expression on a MergeTree engine.{:else if system === 'mssql'}SQL Server creates a partition function + scheme; the partition column must be part of the primary key.{:else if system === 'postgres'}PostgreSQL creates child tables (PARTITION OF); the partition key must be part of the primary key.{:else}MySQL/MariaDB emit an inline PARTITION BY clause.{/if}
            </div>

            <!-- live partition script (script + UI side by side): updates as you edit
                 the rows above; this is exactly what runs on Save. -->
            {#if partScript}
              <div style="display:flex;flex-direction:column;gap:var(--px-4)">
                <span style="font-size:var(--px-11);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">{partLocked ? 'Add-partition script' : partConvert ? 'Convert-to-partitioned script' : 'Partition script'}</span>
                <CodeView value={partScript} language={editorLanguageId(system)} readOnly height="auto" maxHeight={260} ariaLabel="Partition script" />
              </div>
            {/if}
            {#each partBuild.warnings as w (w)}
              <div style="font-size:var(--px-11);color:var(--warn);line-height:1.4">⚠ {w}</div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div style="flex:1;overflow:auto;background:var(--bg)">
      {#if build.warnings.length}
        <div style="padding:var(--px-10) var(--px-18);border-bottom:var(--px-1) solid var(--border);color:var(--warn);font-size:var(--px-12)">
          {#each build.warnings as w (w)}<div>⚠ {w}</div>{/each}
        </div>
      {/if}
      <!-- syntax-coloured DDL preview (keywords / strings / comments) for readability -->
      <CodeView
        value={ddlText || '-- add a column or object, then Save (Ctrl/Cmd+S)'}
        language={editorLanguageId(system)}
        readOnly
        height="100%"
        ariaLabel="Generated DDL"
      />
    </div>
  {/if}
</div>

<style>
  /* ---- header ---------------------------------------------------------- */
  .td-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-12) var(--px-18);
    border-bottom: var(--px-1) solid var(--border);
    background: var(--surface);
  }
  .td-head-icon {
    flex: none;
    width: var(--px-38);
    height: var(--px-38);
    border-radius: var(--px-10);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .td-head-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-3);
  }
  .td-name-row {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    min-width: 0;
  }
  .td-name {
    /* sized to the name, so the New table / Editing badge sits right after it */
    field-sizing: content;
    min-width: var(--px-120);
    width: auto;
    max-width: 100%;
    font-family: var(--font-main);
    font-size: var(--px-17);
    font-weight: 650;
    color: var(--text);
    background: transparent;
    border: var(--px-1) solid transparent;
    border-radius: var(--px-6);
    padding: var(--px-2) var(--px-6);
    margin-left: calc(-1 * var(--px-7));
    outline: none;
  }
  .td-name:not(:disabled):hover {
    border-color: var(--border2);
  }
  .td-name:not(:disabled):focus {
    background: var(--raised);
  }
  .td-name:disabled {
    color: var(--text);
    opacity: 1;
    cursor: default;
  }
  .td-badge {
    flex: none;
    font-size: var(--px-11);
    font-weight: 600;
    border-radius: var(--px-10);
    padding: var(--px-1) var(--px-9);
  }
  .td-badge.new {
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--sacc-green) 13%, transparent);
  }
  .td-badge.edit {
    color: var(--sacc-amber);
    background: color-mix(in srgb, var(--sacc-amber) 14%, transparent);
  }
  .td-crumbs {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--muted);
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .td-crumb-strong {
    color: var(--text2);
    font-weight: 500;
  }
  .td-sep {
    color: var(--border2);
    margin: 0 var(--px-4);
  }
  .td-seg {
    flex: none;
    display: flex;
    padding: var(--px-2);
    gap: var(--px-2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
  }
  .td-seg span {
    padding: var(--px-4) var(--px-14);
    font-size: var(--px-12_5);
    font-weight: 500;
    color: var(--text2);
    border-radius: var(--px-6);
    cursor: pointer;
  }
  .td-seg span:hover {
    color: var(--text);
  }
  .td-seg span.on {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: var(--shadow-xs);
  }
  .td-saved {
    font-size: var(--px-12);
    color: var(--success);
    font-weight: 600;
  }

  /* ---- attribute tabs ---------------------------------------------------- */
  .td-tabs {
    flex: none;
    display: flex;
    gap: var(--px-4);
    padding: 0 var(--px-14);
    border-bottom: var(--px-1) solid var(--border);
    background: var(--surface);
  }
  .td-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    padding: var(--px-10) var(--px-10);
    font-size: var(--px-13);
    font-weight: 500;
    color: var(--text2);
    border-bottom: var(--px-2) solid transparent;
    margin-bottom: calc(-1 * var(--px-1));
    cursor: pointer;
  }
  .td-tab:hover {
    color: var(--text);
  }
  .td-tab.on {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--td-accent, var(--primary));
  }
  .td-count {
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--text2);
    background: var(--panel);
    border-radius: var(--px-8);
    padding: 0 var(--px-6);
    font-variant-numeric: tabular-nums;
  }
  .td-tab.on .td-count {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }

  /* ---- grids (fields, indexes, keys, uniques, checks, triggers, partitions) ----
     Drawn as a real table: a framed card with a header band, column dividers and
     zebra rows; every cell edits in place and shows a cell-style focus ring. */
  .td-root :global(.td-grid) {
    border-collapse: separate;
    border-spacing: 0;
    width: calc(100% - 2 * var(--px-16));
    margin: var(--px-14) var(--px-16) 0;
    font-size: var(--px-13);
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    box-shadow: var(--shadow-xs);
    /* clip (not hidden): keeps the rounded corners without breaking the sticky header */
    overflow: clip;
  }
  .td-root :global(.td-grid th) {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--header);
    border-bottom: var(--px-1) solid var(--border2);
    border-right: var(--px-1) solid var(--border);
    padding: var(--px-9) var(--px-12);
    text-align: left;
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
    white-space: nowrap;
  }
  .td-root :global(.td-grid th:last-child),
  .td-root :global(.td-grid td:last-child) {
    border-right: none;
  }
  .td-root :global(.td-grid tbody tr:nth-child(even)) {
    background: var(--grid-zebra);
  }
  .td-root :global(.td-grid tbody tr) {
    transition: background-color 0.1s ease;
  }
  .td-root :global(.td-grid tbody tr:hover) {
    background: color-mix(in srgb, var(--primary) 5%, var(--surface));
  }
  .td-root :global(.td-grid tbody tr:last-child td) {
    border-bottom: none;
  }
  .td-root :global(.td-cell) {
    border-bottom: var(--px-1) solid var(--border);
    border-right: var(--px-1) solid var(--border);
    padding: 0;
    height: var(--px-38);
  }
  /* the # / drag column reads as a row gutter */
  .td-root :global(.td-grid td:first-child.td-cell[title='Drag to reorder']) {
    background: color-mix(in srgb, var(--header) 70%, transparent);
  }
  .td-root :global(.td-in) {
    width: 100%;
    height: var(--px-38);
    box-sizing: border-box;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    font-family: var(--font-main);
    font-size: var(--px-13);
    padding: 0 var(--px-12);
    outline: none;
  }
  .td-root :global(.td-in.code) {
    font-family: var(--font-mono);
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  .td-root :global(.td-in.dflt) {
    color: var(--syntax-string);
  }
  .td-root :global(.td-in::placeholder) {
    color: var(--muted);
    opacity: 0.7;
  }
  .td-root :global(.td-in:hover:not(:disabled)) {
    background: color-mix(in srgb, var(--primary) 4%, transparent);
  }
  /* editing a cell: ring INSIDE the cell, like a spreadsheet */
  .td-root :global(.td-in:focus) {
    background: var(--raised);
    box-shadow: inset 0 0 0 var(--px-2) var(--primary) !important;
  }
  .td-root :global(.td-in:disabled) {
    color: var(--text2);
    cursor: default;
  }
  /* a SearchSelect (Method, Ref. table, ON DELETE…) draws its own box; inside a
     table cell it sits flat like every other cell and fills it */
  .td-root :global(.td-cell > span:first-child:has(> input)) {
    display: flex !important;
    width: 100%;
  }
  .td-root :global(.td-cell > span:first-child > input) {
    width: 100% !important;
    min-width: 0 !important;
    height: var(--px-38);
    box-sizing: border-box;
    background: transparent !important;
    border: none !important;
    border-radius: 0 !important;
    font-family: var(--font-main) !important;
    font-size: var(--px-13) !important;
    padding-left: var(--px-12) !important;
  }
  .td-root :global(.td-cell > span:first-child > input:focus) {
    background: var(--raised) !important;
    box-shadow: inset 0 0 0 var(--px-2) var(--primary) !important;
  }
  /* remove / restore — quiet until you look at the row */
  .td-root :global(.td-del) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-26);
    height: var(--px-26);
    border-radius: var(--px-6);
    font-size: var(--px-15);
    color: var(--muted);
    cursor: pointer;
    opacity: 0;
    transition:
      opacity 0.12s ease,
      background-color 0.12s ease,
      color 0.12s ease;
  }
  .td-root :global(.td-grid tr:hover .td-del),
  .td-root :global(.td-del:focus-visible),
  .td-root :global(.td-del.restore) {
    opacity: 1;
  }
  .td-root :global(.td-del:hover) {
    color: var(--danger-text);
    background: var(--danger-soft);
  }
  .td-root :global(.td-del.restore) {
    color: var(--success);
  }
  .td-root :global(.td-del.restore:hover) {
    color: var(--success);
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }
  .td-root :global(.td-add) {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    margin: var(--px-10) var(--px-16);
    padding: var(--px-6) var(--px-12);
    border: var(--px-1) dashed var(--border2);
    border-radius: var(--px-8);
    color: var(--primary);
    font-size: var(--px-12_5);
    font-weight: 600;
    cursor: pointer;
  }
  .td-root :global(.td-add:hover) {
    border-style: solid;
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 7%, transparent);
  }

</style>
