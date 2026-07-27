<script lang="ts">
  // Read-only virtualized result grid (TanStack table-core + virtual-core):
  // zebra rows, sticky header, row-number gutter, NULL badge, datetime in
  // local timezone, cell/row selection, Ctrl+C copy (TSV), CSV export.
  import {
    createTable,
    getCoreRowModel,
    type ColumnDef as TanColumnDef,
    type Table,
  } from '@tanstack/table-core'
  import {
    Virtualizer,
    elementScroll,
    observeElementOffset,
    observeElementRect,
    type VirtualItem,
  } from '@tanstack/virtual-core'
  import { untrack, tick } from 'svelte'
  import { pageWindow } from '$lib/grid/paging'
  import { buildGroups, type AggFn, type GroupNode } from '$lib/grid/groupby'
  import { save as saveFileDialog } from '@tauri-apps/plugin-dialog'
  import { invoke } from '@tauri-apps/api/core'
  import { toasts } from '$lib/stores/toast.svelte'
  import { applyGridChanges, previewGridChanges, chGenerateMutations, cancelQuery, type GridChange } from '$lib/ipc'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { formatClipboard, type ClipFormat } from '$lib/export/clipboard'
  import { classifyType } from '$lib/copy/types'
  import type { QueryResultSet } from '$lib/types'

  /** Bật editable grid khi mở từ Table Data Viewer (biết schema/table/pk). */
  export interface EditTarget {
    connId: string
    system: string
    schema: string | null
    table: string
    /** cột PK (rỗng → dùng toàn bộ cột cũ làm điều kiện WHERE) */
    pkCols: string[]
    onApplied?: () => void
  }

  interface Props {
    data: QueryResultSet
    editTarget?: EditTarget
    /** system of the result's connection — enables numeric-column coloring for
     *  relational engines only (falls back to editTarget.system when omitted). */
    system?: string
  }

  let { data, editTarget, system }: Props = $props()

  // ---- editable state (chỉ dùng khi editTarget) ----------------------------
  // cell đã sửa: "rowIdx:col" → giá trị mới (đã coerce về kiểu gốc)
  let edits = $state<Map<string, unknown>>(new Map())
  let deletedRows = $state<Set<number>>(new Set())
  let insertedRows = $state<Record<string, unknown>[]>([])
  let editingCell = $state<{ row: number; col: string; insert?: number; seed?: string } | null>(null)
  let previewSql = $state<string[] | null>(null)
  let applying = $state(false)
  // JSON cell viewer (badge { } → modal)
  let jsonCell = $state<string | null>(null)

  function isJsonValue(v: unknown): boolean {
    return typeof v === 'object' && v !== null
  }

  const editable = $derived(!!editTarget)
  const pendingCount = $derived(edits.size + deletedRows.size + insertedRows.length)

  // A NEW result set invalidates every pending grid change: they are keyed by row
  // INDEX, so replaying them over freshly fetched rows shows the old values on top
  // of new data (the "results look cached" report) and Execute would write them to
  // the wrong rows — Table Viewer restarts indices at 0 on each server-side page.
  // The panel reuses this component across runs, so clear the buffer whenever the
  // result object identity changes, and say so if anything was actually dropped.
  let lastData: QueryResultSet | null = null
  $effect(() => {
    const d = data
    untrack(() => {
      if (d === lastData) return
      const dropped = lastData !== null && pendingCount > 0
      lastData = d
      discard()
      if (dropped) toasts.show('Pending grid changes were discarded — the result was refreshed.')
    })
  })

  function cellKey(row: number, col: string) {
    return `${row}:${col}`
  }

  /** coerce input string về kiểu JSON của giá trị gốc để bind khớp cột. */
  function coerce(raw: string, original: unknown): unknown {
    if (raw === '' && original === null) return null
    if (raw.toUpperCase() === 'NULL') return null
    if (typeof original === 'number') {
      const n = Number(raw)
      return Number.isNaN(n) ? raw : n
    }
    if (typeof original === 'boolean') return raw === 'true' || raw === '1'
    return raw
  }

  function startEdit(row: number, col: string, insert?: number, seed?: string) {
    if (!editable) return
    editingCell = { row, col, insert, seed }
  }

  // Focus a freshly-mounted edit <input> (the `autofocus` attribute is
  // unreliable for dynamically-inserted elements). Select the whole value unless
  // it was seeded by type-to-replace (then keep the cursor after the typed char).
  function focusEditor(node: HTMLInputElement) {
    node.focus()
    if (editingCell?.seed == null) node.select()
  }

  // Commit an edit to an EXPLICIT cell. Only the CURRENTLY-open editor commits:
  // a late onblur (fired when the input unmounts because a Tab moved the editor,
  // or a multi-cell paste closed it) must not clobber the new cell/value. So if
  // editingCell no longer points at this cell, do nothing.
  function commitEdit(row: number, col: string, value: string, original: unknown, insert?: number) {
    if (!(editingCell && editingCell.row === row && editingCell.col === col && editingCell.insert === insert)) return
    if (insert != null) {
      insertedRows[insert][col] = coerce(value, original ?? '')
      insertedRows = [...insertedRows]
    } else {
      const coerced = coerce(value, original)
      if (JSON.stringify(coerced) === JSON.stringify(data.rows[row]?.[col])) {
        edits.delete(cellKey(row, col))
      } else {
        edits.set(cellKey(row, col), coerced)
      }
      edits = new Map(edits)
    }
    editingCell = null
  }

  // Tab / Shift+Tab across cells while editing (Navicat data entry): commit then
  // open the editor on the adjacent column; closes at the row's edge.
  function editAdjacent(row: number, col: string, dCol: number, insert?: number) {
    const ci = columns.indexOf(col) + dCol
    if (ci < 0 || ci >= columns.length) {
      editingCell = null
      return
    }
    const nextCol = columns[ci]
    if (insert != null) {
      startEdit(insert, nextCol, insert)
    } else {
      selectedRows = new Set()
      selectedCell = { row, col: nextCol }
      startEdit(row, nextCol)
    }
  }

  // Spread TSV/CSV `text` across cells starting at (startAbsRow, startColName).
  // Rows live in a unified space: data rows [0, data.rows.length), then pending
  // inserted rows after them. So pasting onto a loaded row edits it; pasting onto
  // an existing inserted row FILLS it (the "paste into a new row" case); pasting
  // past the end appends new inserted rows.
  function applyPaste(text: string, startColName: string, startAbsRow: number) {
    if (!editable || !text) return
    const grid = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((r) => (r.includes('\t') ? r.split('\t') : r.split(',')))
    const startCol = columns.indexOf(startColName)
    if (startCol < 0) return
    const next = new Map(edits)
    const inserts = [...insertedRows]
    let cellsChanged = 0
    let newRows = 0
    for (let r = 0; r < grid.length; r++) {
      const abs = startAbsRow + r
      if (abs < data.rows.length) {
        // edit an existing (loaded) row
        for (let c = 0; c < grid[r].length; c++) {
          const ci = startCol + c
          if (ci >= columns.length) break
          const col = columns[ci]
          const original = data.rows[abs]?.[col]
          const coerced = coerce(grid[r][c], original)
          if (JSON.stringify(coerced) === JSON.stringify(original)) next.delete(cellKey(abs, col))
          else { next.set(cellKey(abs, col), coerced); cellsChanged++ }
        }
      } else {
        // an inserted row — fill the existing pending row or append new ones
        const insIdx = abs - data.rows.length
        while (inserts.length <= insIdx) {
          inserts.push(Object.fromEntries(columns.map((c) => [c, null])))
          newRows++
        }
        for (let c = 0; c < grid[r].length; c++) {
          const ci = startCol + c
          if (ci >= columns.length) break
          inserts[insIdx][columns[ci]] = coerce(grid[r][c], '')
          cellsChanged++
        }
      }
    }
    edits = next
    editingCell = null
    insertedRows = inserts
    if (startAbsRow >= data.rows.length || newRows) {
      page = Math.max(0, pageCount - 1) // reveal inserted rows
      void scrollToBottom()
    }
    if (cellsChanged || newRows) {
      const parts: string[] = []
      if (cellsChanged) parts.push(`${cellsChanged} cell(s)`)
      if (newRows) parts.push(`${newRows} new record(s)`)
      toasts.success(`Pasted ${parts.join(' + ')} — Execute to apply`)
    }
  }

  // Route pasted clipboard text. A MULTI-ROW clipboard is pasted as that many NEW
  // rows appended at the end — copy N rows ⇒ paste N rows (rather than overwriting
  // loaded rows). A single-row clipboard edits in place at the selected cell
  // (paste a value / column of values), else appends one row.
  function pasteText(text: string) {
    if (!editable || !text) return
    const norm = text.replace(/\r\n?/g, '\n') // normalise CRLF / lone CR first
    const multiRow = /\n/.test(norm.replace(/\n+$/, ''))
    const appendAt = data.rows.length + insertedRows.length // after any pending rows
    if (multiRow) {
      applyPaste(norm, columns[0], appendAt) // N rows → N new rows
    } else if (selectedCell) {
      applyPaste(norm, selectedCell.col, selectedCell.row)
    } else {
      applyPaste(norm, columns[0], appendAt)
    }
  }

  // Native paste on the focused grid (Ctrl+V, not while editing). Uses the paste
  // event's clipboardData — synchronous and reliable in the desktop WebView,
  // where navigator.clipboard.readText() can misbehave.
  function onGridPaste(e: ClipboardEvent) {
    if (editingCell) return // the cell editor's own onpaste handles that
    const text = e.clipboardData?.getData('text') ?? ''
    if (!text) return
    e.preventDefault()
    pasteText(text)
  }

  // Context-menu "Paste" (no paste event to read) → read the clipboard async.
  async function pasteFromClipboard() {
    if (!editable) return
    try {
      pasteText(await navigator.clipboard.readText())
    } catch {
      toasts.error('Clipboard read blocked')
    }
  }

  // Paste directly inside a cell editor. A single value pastes natively into the
  // input; a multi-value clipboard (tabs/newlines) is spread across cells/rows —
  // this is what makes pasting a record into a freshly-inserted row work.
  function onCellPaste(e: ClipboardEvent, startColName: string, startAbsRow: number) {
    const raw = e.clipboardData?.getData('text') ?? ''
    const text = raw.replace(/\r\n?/g, '\n')
    if (!text || !/[\t\n]/.test(text.replace(/\n$/, ''))) return // single value → native
    e.preventDefault()
    applyPaste(text, startColName, startAbsRow)
  }

  function toggleDeleteSelected() {
    if (selectedRows.size === 0) return
    const next = new Set(deletedRows)
    for (const r of selectedRows) {
      if (next.has(r)) next.delete(r)
      else next.add(r)
    }
    deletedRows = next
  }

  // Scroll the grid container all the way down so freshly-added inserted rows
  // (rendered after the virtual window) come fully into view.
  async function scrollToBottom() {
    await tick()
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight
  }

  async function addRow() {
    insertedRows.push(Object.fromEntries(columns.map((c) => [c, null])))
    insertedRows = [...insertedRows]
    // Inserted rows only render on the last page — jump there, scroll to the
    // bottom so the new row is visible, then open the editor on the first cell.
    const idx = insertedRows.length - 1
    page = Math.max(0, pageCount - 1)
    await scrollToBottom()
    if (columns.length) startEdit(idx, columns[0], idx)
  }

  function discard() {
    edits = new Map()
    deletedRows = new Set()
    insertedRows = []
    editingCell = null
    previewSql = null
  }

  /** Dựng GridChange[] từ buffer pending. Mỗi cột kèm SQL type để backend (PG)
   *  cast tham số ($1::uuid…) tránh lỗi "operator does not exist: uuid = text". */
  function buildChanges(): GridChange[] {
    const t = editTarget!
    const mk = (name: string, value: unknown) => ({ name, value, type: colTypes[name] })
    const whereCols = t.pkCols.length > 0 ? t.pkCols : columns
    const out: GridChange[] = []
    // UPDATE: gom edit theo row
    const byRow = new Map<number, string[]>()
    for (const key of edits.keys()) {
      const [r, c] = [Number(key.split(':')[0]), key.slice(key.indexOf(':') + 1)]
      if (deletedRows.has(r)) continue
      if (!byRow.has(r)) byRow.set(r, [])
      byRow.get(r)!.push(c)
    }
    for (const [r, cols] of byRow) {
      const orig = data.rows[r]
      out.push({
        kind: 'update',
        schema: t.schema,
        table: t.table,
        pk: whereCols.map((c) => mk(c, orig?.[c] ?? null)),
        set: cols.map((c) => mk(c, edits.get(cellKey(r, c)))),
      })
    }
    // DELETE
    for (const r of deletedRows) {
      const orig = data.rows[r]
      out.push({
        kind: 'delete',
        schema: t.schema,
        table: t.table,
        pk: whereCols.map((c) => mk(c, orig?.[c] ?? null)),
      })
    }
    // INSERT (bỏ cột null hoàn toàn để dùng default của DB)
    for (const ins of insertedRows) {
      const values = columns
        .filter((c) => ins[c] !== null && ins[c] !== undefined && ins[c] !== '')
        .map((c) => mk(c, ins[c]))
      if (values.length > 0) out.push({ kind: 'insert', schema: t.schema, table: t.table, values })
    }
    return out
  }

  async function openPreview() {
    if (!editTarget || pendingCount === 0) return
    try {
      previewSql = await previewGridChanges(editTarget.connId, buildChanges())
    } catch (e) {
      toasts.error(String(e))
    }
  }

  // Execute — commit pending edits/inserts/deletes to the DB in one transaction.
  async function apply() {
    if (!editTarget) return
    applying = true
    try {
      const n = await applyGridChanges(editTarget.connId, buildChanges())
      toasts.success(`Applied — ${n} row(s) changed`, editTarget.system)
      discard()
      editTarget.onApplied?.()
    } catch (e) {
      toasts.error(String(e), editTarget.system)
    } finally {
      applying = false
    }
  }

  // Cancel — abort the in-flight Execute on the backend (registry cancel, T11).
  async function cancelApply() {
    if (!editTarget || !applying) return
    try {
      await cancelQuery(editTarget.connId)
    } catch (e) {
      toasts.error(String(e), editTarget.system)
    }
  }

  // ClickHouse (SPEC_ADDENDUM §7): KHÔNG commit OLTP. Inline-edit không apply
  // trực tiếp — pending changes → mutation async (ALTER TABLE … UPDATE/DELETE)
  // mở trong SQL editor để review + chạy chủ động.
  const isClickhouse = $derived(editTarget?.system === 'clickhouse')
  async function generateMutation() {
    if (!editTarget) return
    try {
      const sql = await chGenerateMutations(editTarget.connId, buildChanges())
      tabs.openSqlTab({ connectionId: editTarget.connId, title: `Mutation · ${editTarget.table}`, query: sql })
      discard()
    } catch (e) {
      toasts.error(String(e), editTarget.system)
    }
  }

  const ROW_H = 26

  let scrollEl = $state<HTMLDivElement | null>(null)
  let virtualItems = $state<VirtualItem[]>([])
  let totalSize = $state(0)

  // selection: set of row indices, or a single cell
  let selectedRows = $state<Set<number>>(new Set())
  let selectedCell = $state<{ row: number; col: string } | null>(null)
  let lastAnchorRow = -1

  const columns = $derived(data.cols.map(([name]) => name))
  const colTypes = $derived(Object.fromEntries(data.cols.map(([name, type]) => [name, type])))

  // Numeric-column coloring — relational engines only (per request). Detect number
  // families (int/bigint/float/decimal — covers int/smallint/integer/bigint,
  // numeric/decimal/money, real/double/float) via the shared classifyType, and tint
  // those columns' values with the theme-aware --syntax-number token. Selected
  // cells/rows keep their white text (see the cell color guard below).
  const NUM_COLOR_SYSTEMS = ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'mongodb', 'oracle']
  const NUM_FAMILIES = new Set(['int', 'bigint', 'float', 'decimal'])
  const colorNumbers = $derived(NUM_COLOR_SYSTEMS.includes(system ?? editTarget?.system ?? ''))
  const numericCols = $derived(
    colorNumbers
      ? new Set(data.cols.filter(([, type]) => NUM_FAMILIES.has(classifyType(type))).map(([name]) => name))
      : new Set<string>(),
  )

  // Duplicate column names (e.g. `SELECT a.id, b.id`) used to crash the tab: the
  // keyed {#each} threw on the repeated key. Now the grid renders (keyed by index),
  // but because a row is a name-keyed object, same-named columns share one value —
  // so warn the user once per result instead of silently merging.
  let dupWarnedFor = ''
  $effect(() => {
    const names = data.cols.map(([n]) => n)
    const dups = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
    const key = dups.join('')
    if (dups.length && key !== dupWarnedFor) {
      dupWarnedFor = key
      toasts.show(
        `Duplicate column name${dups.length > 1 ? 's' : ''} in result: ${dups.join(', ')} — ` +
          `only one value per name is shown. Alias them (e.g. a.id AS a_id) to see both.`,
      )
    } else if (!dups.length) {
      dupWarnedFor = ''
    }
  })

  // TanStack column/row model
  const table: Table<Record<string, unknown>> = $derived.by(() => {
    const defs: TanColumnDef<Record<string, unknown>>[] = data.cols.map(([name]) => ({
      id: name,
      accessorFn: (row) => row[name],
    }))
    return createTable({
      data: data.rows,
      columns: defs,
      getCoreRowModel: getCoreRowModel(),
      state: {},
      onStateChange: () => {},
      renderFallbackValue: null,
    })
  })

  const rowCount = $derived(data.rows.length)

  // ---- pagination (AUDIT item 1) — client-side window over the fetched rows.
  // Row indices stay ABSOLUTE (ri = pageOffset + vi.index) so edits/selection
  // keep working. Table Viewer paginates server-side; this covers query results.
  const PAGE_SIZES = [100, 200, 500, 1000]
  let pageSize = $state(200)
  let page = $state(0)
  const win = $derived(pageWindow(rowCount, pageSize, page))
  const paged = $derived(win.paged)
  const pageCount = $derived(win.pageCount)
  const pageOffset = $derived(win.offset)
  const pageRowCount = $derived(win.count)
  const onLastPage = $derived(win.last)
  // Reset to page 0 whenever a new result set arrives or the page size changes.
  $effect(() => {
    void data
    void pageSize
    untrack(() => (page = 0))
  })

  $effect(() => {
    if (!scrollEl) return
    const count = pageRowCount
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
      count,
      getScrollElement: () => scrollEl,
      estimateSize: () => ROW_H,
      overscan: 12,
      scrollToFn: elementScroll,
      observeElementRect,
      observeElementOffset,
      onChange: (inst) => {
        virtualItems = inst.getVirtualItems()
        totalSize = inst.getTotalSize()
      },
    })
    const unmount = virtualizer._didMount()
    virtualizer._willUpdate()
    virtualItems = virtualizer.getVirtualItems()
    totalSize = virtualizer.getTotalSize()
    return unmount
  })

  // ---- Group By (T27) — client-side grouping of the in-memory result ----------
  const AGG_FNS: AggFn[] = ['count', 'sum', 'avg', 'min', 'max']
  let groupOpen = $state(false)
  let groupBy = $state<string[]>([])
  let groupFn = $state<AggFn>('count')
  let groupCol = $state('')
  let groupActive = $state(false)
  let collapsed = $state<Set<string>>(new Set())
  const groupResult = $derived(
    groupActive && groupBy.length
      ? buildGroups(data.rows, { by: groupBy, fn: groupFn, col: groupCol })
      : null,
  )
  function toggleGroupCol(c: string) {
    groupBy = groupBy.includes(c) ? groupBy.filter((x) => x !== c) : [...groupBy, c]
  }
  function applyGroup() {
    groupActive = groupBy.length > 0
    collapsed = new Set()
    groupOpen = false
  }
  function clearGroup() {
    groupActive = false
    groupBy = []
    groupOpen = false
  }
  function toggleCollapsed(path: string) {
    const next = new Set(collapsed)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    collapsed = next
  }
  const fmtAgg = (v: number | null) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(2))
  // Flatten the group tree into render rows, honoring the collapsed set.
  interface GroupRow {
    kind: 'group' | 'data'
    depth: number
    node?: GroupNode
    row?: Record<string, unknown>
    key: string
  }
  function flattenGroups(nodes: GroupNode[]): GroupRow[] {
    const out: GroupRow[] = []
    const walk = (list: GroupNode[]) => {
      for (const n of list) {
        out.push({ kind: 'group', depth: n.depth, node: n, key: `g:${n.path}` })
        if (collapsed.has(n.path)) continue
        if (n.children.length) walk(n.children)
        else if (n.rows) n.rows.forEach((r, i) => out.push({ kind: 'data', depth: n.depth + 1, row: r, key: `d:${n.path}:${i}` }))
      }
    }
    walk(nodes)
    return out
  }
  const groupRows = $derived(groupResult ? flattenGroups(groupResult.groups) : [])

  const isDatetimeType = (type: string) =>
    /timestamp|datetime|timestamptz/i.test(type)

  function display(value: unknown, colName: string): { text: string; isNull: boolean } {
    if (value === null || value === undefined) return { text: 'NULL', isNull: true }
    if (typeof value === 'object') return { text: JSON.stringify(value), isNull: false }
    const type = colTypes[colName] ?? ''
    if (isDatetimeType(type) && typeof value === 'string') {
      const d = new Date(value)
      if (!Number.isNaN(d.getTime())) {
        // local timezone display (UTC toggle → Phase 2)
        return { text: d.toLocaleString(), isNull: false }
      }
    }
    return { text: String(value), isNull: false }
  }

  function rawText(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }

  function clickRowNumber(e: MouseEvent, rowIdx: number) {
    selectedCell = null
    if (e.shiftKey && lastAnchorRow >= 0) {
      const [a, b] = [Math.min(lastAnchorRow, rowIdx), Math.max(lastAnchorRow, rowIdx)]
      const next = new Set<number>()
      for (let i = a; i <= b; i++) next.add(i)
      selectedRows = next
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selectedRows)
      if (next.has(rowIdx)) next.delete(rowIdx)
      else next.add(rowIdx)
      selectedRows = next
      lastAnchorRow = rowIdx
    } else {
      selectedRows = new Set([rowIdx])
      lastAnchorRow = rowIdx
    }
  }

  function clickCell(rowIdx: number, col: string) {
    selectedRows = new Set()
    selectedCell = { row: rowIdx, col }
    lastAnchorRow = rowIdx
  }

  function tsvEscape(s: string): string {
    return s.replaceAll('\t', '\\t').replaceAll('\n', '\\n')
  }

  /** Copy selection as tab-separated text (cell → value, rows → TSV). */
  async function copySelection() {
    let text = ''
    if (selectedCell) {
      text = rawText(data.rows[selectedCell.row]?.[selectedCell.col])
    } else if (selectedRows.size > 0) {
      const rows = [...selectedRows].sort((a, b) => a - b)
      text = rows
        .map((i) => columns.map((c) => tsvEscape(rawText(data.rows[i]?.[c]))).join('\t'))
        .join('\n')
    } else {
      return
    }
    await navigator.clipboard.writeText(text)
    toasts.success('Copied to clipboard')
  }

  export async function copyRow(rowIdx?: number) {
    const idx = rowIdx ?? selectedCell?.row ?? [...selectedRows][0]
    if (idx == null) return
    selectedRows = new Set([idx])
    selectedCell = null
    await copySelection()
  }

  function csvEscape(s: string): string {
    if (/[",\n\r]/.test(s)) return '"' + s.replaceAll('"', '""') + '"'
    return s
  }

  export async function exportCsv() {
    const path = await saveFileDialog({
      defaultPath: 'result.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    })
    if (!path) return
    const header = columns.map(csvEscape).join(',')
    const body = data.rows
      .map((row) => columns.map((c) => csvEscape(rawText(row[c]))).join(','))
      .join('\n')
    try {
      await invoke('write_text_file', { path, contents: `${header}\n${body}\n` })
      toasts.success(`Exported ${data.rows.length.toLocaleString()} rows → ${path}`)
    } catch (e) {
      toasts.error(String(e))
    }
  }

  // Move the selected cell by (dRow, dCol), clamped to the grid (AUDIT-5 item 2).
  function moveCell(dRow: number, dCol: number) {
    if (editingCell) return
    const cur = selectedCell ?? { row: pageOffset, col: columns[0] }
    const ci = Math.max(0, Math.min(columns.length - 1, columns.indexOf(cur.col) + dCol))
    const ri = Math.max(0, Math.min(rowCount - 1, cur.row + dRow))
    selectedRows = new Set()
    selectedCell = { row: ri, col: columns[ci] }
  }

  function onKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault()
      void copySelection()
      return
    }
    // Ctrl+V is handled by the grid's native `paste` event (onGridPaste) —
    // clipboardData is reliable where navigator.clipboard.readText() is not.
    if (e.key === 'Escape') {
      ctxMenu = null
      editingCell = null
      return
    }
    // Navicat-style edit entry: a cell is selected (not yet editing) on an
    // editable grid. Enter/F2 open the editor with the value selected; typing a
    // printable character opens it seeded with that character (type-to-replace).
    if (editable && selectedCell && !editingCell) {
      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault()
        startEdit(selectedCell.row, selectedCell.col)
        return
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        startEdit(selectedCell.row, selectedCell.col, undefined, e.key)
        return
      }
    }
    // Arrow / Tab cell navigation (Tab → next column, Shift+Tab → prev).
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault(); moveCell(1, 0); break
      case 'ArrowUp':
        e.preventDefault(); moveCell(-1, 0); break
      case 'ArrowLeft':
        e.preventDefault(); moveCell(0, -1); break
      case 'ArrowRight':
        e.preventDefault(); moveCell(0, 1); break
      case 'Tab':
        e.preventDefault(); moveCell(0, e.shiftKey ? -1 : 1); break
    }
  }

  // ---- right-click copy menu -----------------------------------------------
  let ctxMenu = $state<{ x: number; y: number; row: number; col: string } | null>(null)

  // Position the context menu fully inside the viewport. The menu's height varies
  // with the item list (Copy formats etc.), so measure the real element after mount
  // and flip/clamp — a fixed offset (the old `- 330`) under-counted and clipped the
  // last items. Falls back to scrolling only when the menu is taller than the screen.
  function placeMenu(node: HTMLElement, pos: { x: number; y: number }) {
    const place = (p: { x: number; y: number }) => {
      const margin = 8
      const r = node.getBoundingClientRect()
      let x = p.x
      let y = p.y
      if (x + r.width > window.innerWidth - margin) x = window.innerWidth - r.width - margin
      if (y + r.height > window.innerHeight - margin) y = window.innerHeight - r.height - margin
      node.style.left = `${Math.max(margin, x)}px`
      node.style.top = `${Math.max(margin, y)}px`
    }
    place(pos)
    return { update: place }
  }

  function openCtx(e: MouseEvent, rowIdx: number, col: string) {
    e.preventDefault()
    e.stopPropagation()
    // Right-clicking a cell outside the current selection selects just it.
    if (!(selectedCell?.row === rowIdx && selectedCell?.col === col) && !selectedRows.has(rowIdx)) {
      clickCell(rowIdx, col)
    }
    ctxMenu = { x: e.clientX, y: e.clientY, row: rowIdx, col }
  }

  // Right-click the No. (#) gutter → same copy menu, scoped to the whole row.
  function openRowCtx(e: MouseEvent, rowIdx: number) {
    e.preventDefault()
    e.stopPropagation()
    if (!selectedRows.has(rowIdx)) {
      selectedCell = null
      selectedRows = new Set([rowIdx])
      lastAnchorRow = rowIdx
    }
    ctxMenu = { x: e.clientX, y: e.clientY, row: rowIdx, col: columns[0] }
  }

  async function copyText(text: string, label: string) {
    ctxMenu = null
    await navigator.clipboard.writeText(text)
    toasts.success(label)
  }

  function copyCell(row: number, col: string) {
    void copyText(rawText(data.rows[row]?.[col]), 'Copied cell')
  }

  function copyRowTsv(row: number) {
    void copyText(columns.map((c) => tsvEscape(rawText(data.rows[row]?.[c]))).join('\t'), 'Copied row')
  }

  function copyColumn(col: string) {
    void copyText(data.rows.map((r) => tsvEscape(rawText(r[col]))).join('\n'), `Copied column "${col}"`)
  }

  // ---- "Copy as ▸" — multi-record extract in 6 formats (AUDIT-3 item 5) ----
  // (raw text uses copyCell/copyRow/copyColumn/copySelection above)
  // Rows to copy: the highlighted rows if any, else the row of the selected cell,
  // else the whole result set. Columns = all grid columns.
  function selectionRows(): Record<string, unknown>[] {
    if (selectedRows.size > 0) {
      return [...selectedRows]
        .sort((a, b) => a - b)
        .map((i) => data.rows[i])
        .filter((r): r is Record<string, unknown> => r != null)
    }
    if (selectedCell && data.rows[selectedCell.row]) return [data.rows[selectedCell.row]]
    return data.rows
  }

  const FORMAT_LABEL: Record<ClipFormat, string> = {
    tsv: 'Tab-separated',
    csv: 'CSV',
    json: 'JSON',
    'sql-insert': 'SQL INSERT',
    'sql-update': 'SQL UPDATE',
    markdown: 'Markdown',
    xml: 'XML',
  }

  function copyAs(fmt: ClipFormat) {
    const rows = selectionRows()
    const text = formatClipboard(fmt, {
      headers: columns,
      rows,
      table: editTarget?.table,
      keyColumns: editTarget?.pkCols,
    })
    void copyText(text, `Copied ${rows.length.toLocaleString()} row(s) as ${FORMAT_LABEL[fmt]}`)
  }
</script>

<div style="display:flex;flex-direction:column;height:100%;min-height:0">
{#if editable}
  <!-- editable toolbar: Add row / Delete / pending buffer → Preview + Apply/Discard -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--header);font-size:var(--px-11_5)">
    <span class="eg-btn" onclick={addRow} onkeydown={(e) => e.key === 'Enter' && addRow()} role="button" tabindex="0">＋ Insert row</span>
    <span class="eg-btn" onclick={toggleDeleteSelected} onkeydown={(e) => e.key === 'Enter' && toggleDeleteSelected()} role="button" tabindex="0" style="opacity:{selectedRows.size ? 1 : 0.5}">🗑 Delete row(s)</span>
    {#if isClickhouse}
      <span style="color:var(--muted);font-size:var(--px-10_5)">ClickHouse: edits are async mutations — no OLTP commit</span>
    {/if}
    {#if pendingCount > 0}
      <span style="color:var(--warn)">● {pendingCount} unsaved change(s)</span>
      <div style="margin-left:auto;display:flex;gap:var(--px-8)">
        {#if isClickhouse}
          <!-- §7 option (a): route sang Generate mutation (ALTER TABLE … UPDATE/DELETE), KHÔNG apply OLTP -->
          <span class="eg-btn" onclick={discard} onkeydown={(e) => e.key === 'Enter' && discard()} role="button" tabindex="0">Discard</span>
          <span
            onclick={generateMutation}
            onkeydown={(e) => e.key === 'Enter' && generateMutation()}
            role="button"
            tabindex="0"
            style="font-size:var(--px-11_5);font-weight:600;background:#FFCC00;color:#0f1219;border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer"
          >Generate mutation</span>
        {:else}
          <span class="eg-btn" onclick={openPreview} onkeydown={(e) => e.key === 'Enter' && openPreview()} role="button" tabindex="0">Preview diff</span>
          <!-- Reset — revert grid edits/inserts/deletes to the original values -->
          <span class="eg-btn" onclick={discard} onkeydown={(e) => e.key === 'Enter' && discard()} role="button" tabindex="0" title="Revert all pending changes">Reset</span>
          {#if applying}
            <!-- Cancel — abort the running Execute -->
            <span
              onclick={cancelApply}
              onkeydown={(e) => e.key === 'Enter' && cancelApply()}
              role="button"
              tabindex="0"
              title="Cancel the running command"
              style="font-size:var(--px-11_5);font-weight:600;background:var(--error);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer"
            >Cancel</span>
          {:else}
            <!-- Execute — write pending changes to the DB -->
            <span
              onclick={apply}
              onkeydown={(e) => e.key === 'Enter' && apply()}
              role="button"
              tabindex="0"
              title="Write pending changes to the database"
              style="font-size:var(--px-11_5);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer"
            >Execute</span>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={scrollEl}
  class="selectable outline-none"
  style="flex:1;min-height:0;overflow:auto"
  tabindex="0"
  role="grid"
  aria-rowcount={rowCount}
  onkeydown={onKeydown}
  onpaste={onGridPaste}
>
  {#if groupResult}
    <!-- Group By view (T27): collapsible group tree + subtotals + grand total -->
    <div class="mono" style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-4) var(--px-12);border-bottom:var(--px-1) solid var(--border2);font-weight:700;background:var(--header);position:sticky;top:0;z-index:5;font-size:var(--px-11_5)">
      <span style="color:var(--muted)">Σ Grand total</span>
      <span style="margin-left:auto;color:var(--text2)">{groupResult.grandCount.toLocaleString()} rows</span>
      <span style="color:var(--primary)">{groupFn}{groupFn !== 'count' && groupCol ? `(${groupCol})` : ''} = {fmtAgg(groupResult.grandAgg)}</span>
    </div>
    {#each groupRows as gr (gr.key)}
      {#if gr.kind === 'group' && gr.node}
        {@const node = gr.node}
        <div
          role="button"
          tabindex="0"
          onclick={() => toggleCollapsed(node.path)}
          onkeydown={(e) => e.key === 'Enter' && toggleCollapsed(node.path)}
          style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-3) var(--px-12);cursor:pointer;padding-left:calc(var(--px-12) + {gr.depth} * var(--px-16));background:var(--panel);border-bottom:var(--px-1) solid var(--border)"
        >
          <span class="mono" style="width:var(--px-10);color:var(--muted);font-size:var(--px-9)">{collapsed.has(node.path) ? '▸' : '▾'}</span>
          <span class="mono" style="font-weight:600;color:var(--text)">{node.key == null ? '∅' : String(node.key)}</span>
          <span class="mono" style="margin-left:auto;color:var(--muted);font-size:var(--px-10_5)">{node.count.toLocaleString()} rows</span>
          <span class="mono" style="color:var(--primary);font-size:var(--px-11)">{fmtAgg(node.agg)}</span>
        </div>
      {:else if gr.row}
        {@const drow = gr.row}
        <div class="mono" style="display:flex;gap:var(--px-14);padding:var(--px-2) var(--px-12);padding-left:calc(var(--px-12) + {gr.depth} * var(--px-16));font-size:var(--px-11);color:var(--text2);border-bottom:var(--px-1) solid var(--border);white-space:nowrap;overflow:hidden">
          {#each columns as c, ci (ci)}<span style="min-width:var(--px-70);max-width:var(--px-220);overflow:hidden;text-overflow:ellipsis">{display(drow[c], c).text}</span>{/each}
        </div>
      {/if}
    {/each}
  {:else}
  <!-- table — port dòng 421-452: mono 12px, th sticky header 6px 12px/600/text2 -->
  <!-- DataGrip-style data grid: JetBrains Mono (via .mono) + tabular figures so
       columns of ids/timestamps line up crisply. -->
  <table class="mono" style="border-collapse:separate;border-spacing:0;width:100%;font-size:var(--px-12);font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1,'zero' 1">
    <thead style="position:sticky;top:0;z-index:10">
      <tr>
        <!-- No. gutter (AUDIT-5 item 2): row number + click to select (shift/ctrl multi) -->
        <th style="width:1%;background:var(--header);border-bottom:var(--px-1) solid var(--border2);border-right:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-8);text-align:right;font-weight:600;color:var(--muted);white-space:nowrap;position:sticky;left:0;z-index:11">#</th>
        {#each data.cols as [name, type], ci (ci)}
          <th style="background:var(--header);border-bottom:var(--px-1) solid var(--border2);border-right:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);text-align:{numericCols.has(name) ? 'right' : 'left'};font-weight:600;color:var(--text2);white-space:nowrap">
            {name}
            <span style="color:var(--muted);font-weight:400;font-size:var(--px-10)">{type}</span>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if virtualItems.length > 0}
        <tr style="height: {virtualItems[0].start}px;"><td colspan={columns.length + 1}></td></tr>
      {/if}
      {#each virtualItems as vi (vi.key)}
        {@const ri = pageOffset + vi.index}
        {@const row = data.rows[ri]}
        {@const isRowSelected = selectedRows.has(ri)}
        {@const isDeleted = deletedRows.has(ri)}
        <!-- row — dòng 434: zebra + selected inset bar; deleted → đỏ gạch ngang -->
        <tr
          class="grid-row {isRowSelected ? 'selected' : ''}"
          onclick={(e) => clickRowNumber(e, ri)}
          style="height:{ROW_H}px;cursor:pointer;background:{isDeleted ? 'var(--rgba-224-108-117-_14)' : isRowSelected ? 'color-mix(in srgb, var(--grid-select) 62%, transparent)' : ri % 2 === 1 ? 'var(--grid-zebra)' : 'transparent'};box-shadow:inset var(--px-3) 0 0 {isRowSelected ? 'var(--grid-select)' : 'transparent'};color:{isRowSelected ? 'var(--hex-fff)' : 'inherit'};{isDeleted ? 'text-decoration:line-through;opacity:.65;' : ''}"
        >
          <td
            onclick={(e) => { e.stopPropagation(); clickRowNumber(e, ri) }}
            oncontextmenu={(e) => openRowCtx(e, ri)}
            title="Click to select · Shift/Ctrl for multiple · right-click for menu"
            class="mono"
            style="width:1%;padding:var(--px-3) var(--px-8);text-align:right;color:{isRowSelected ? 'var(--hex-fff)' : 'var(--muted)'};border-bottom:var(--px-1) solid var(--border);border-right:var(--px-1) solid var(--border);background:{isRowSelected ? 'var(--grid-select)' : 'var(--header)'};position:sticky;left:0;font-size:var(--px-10_5);user-select:none">{ri + 1}</td>
          {#each columns as col, ci (ci)}
            {@const edited = edits.has(cellKey(ri, col))}
            {@const rawVal = edited ? edits.get(cellKey(ri, col)) : row?.[col]}
            {@const cell = display(rawVal, col)}
            {@const isCellSelected = selectedCell?.row === ri && selectedCell?.col === col}
            {@const isEditing = editingCell?.row === ri && editingCell?.col === col && editingCell?.insert == null}
            <!-- cell — dòng 436-446: padding 5px 12px, NULL badge; edit → highlight vàng -->
            <td
              style="border-bottom:var(--px-1) solid var(--border);border-right:var(--px-1) solid var(--border);padding:0;white-space:nowrap;max-width:var(--px-420);overflow:hidden;text-overflow:ellipsis;{edited ? `background:var(--rgba-240-160-32-_18);` : isCellSelected ? 'background:color-mix(in srgb, var(--grid-select) 45%, transparent);' : ''}{isCellSelected ? 'box-shadow:inset 0 0 0 var(--px-2) var(--grid-select);color:var(--hex-fff);' : ''}"
              onclick={(e) => { e.stopPropagation(); clickCell(ri, col) }}
              oncontextmenu={(e) => openCtx(e, ri, col)}
              ondblclick={(e) => {
                e.stopPropagation()
                // Navicat-style: single-click selects, double-click edits (or copies
                // on read-only grids).
                if (editable) startEdit(ri, col)
                else { clickCell(ri, col); void copySelection() }
              }}
              title={cell.isNull ? undefined : cell.text}
            >
              {#if isEditing}
                <!-- inline edit — port dòng 437-439 -->
                <input
                  class="mono"
                  value={editingCell?.seed ?? (cell.isNull ? '' : cell.text)}
                  use:focusEditor
                  style="width:100%;border:none;outline:none;background:var(--raised);color:var(--text);font-size:var(--px-12);padding:var(--px-5) var(--px-12);font-family:inherit;{numericCols.has(col) ? 'text-align:right' : ''}"
                  onpaste={(e) => onCellPaste(e, col, ri)}
                  onblur={(e) => commitEdit(ri, col, e.currentTarget.value, row?.[col] ?? null)}
                  onkeydown={(e) => {
                    // Keep keys inside the editor — don't let them bubble to the
                    // grid (which would re-open the editor or move the cell).
                    e.stopPropagation()
                    if (e.key === 'Enter') commitEdit(ri, col, e.currentTarget.value, row?.[col] ?? null)
                    else if (e.key === 'Tab') {
                      e.preventDefault()
                      commitEdit(ri, col, e.currentTarget.value, row?.[col] ?? null)
                      editAdjacent(ri, col, e.shiftKey ? -1 : 1)
                    } else if (e.key === 'Escape') editingCell = null
                  }}
                />
              {:else}
                <div style="padding:var(--px-5) var(--px-12);display:flex;align-items:center;gap:var(--px-6);{numericCols.has(col) ? 'justify-content:flex-end' : ''}">
                  {#if cell.isNull}
                    <span style="font-size:var(--px-10);color:var(--muted);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-3);padding:0 var(--px-5)">NULL</span>
                  {:else if cell.text === ''}
                    <span style="font-size:var(--px-10);color:var(--muted);opacity:.6">''</span>
                  {:else}
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;{numericCols.has(col) && !isCellSelected && !isRowSelected ? 'color:var(--syntax-number)' : ''}">{cell.text}</span>
                  {/if}
                  {#if isJsonValue(rawVal)}
                    <!-- JSON/JSONB cell badge — port dòng 445, click mở modal -->
                    <span
                      onclick={(e) => { e.stopPropagation(); jsonCell = JSON.stringify(rawVal, null, 2) }}
                      onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); jsonCell = JSON.stringify(rawVal, null, 2) } }}
                      role="button"
                      tabindex="0"
                      title="Expand JSON"
                      style="flex:none;font-size:var(--px-9);font-weight:700;color:var(--hex-61afef);border:var(--px-1) solid var(--hex-2a4a6a);border-radius:var(--px-3);padding:0 var(--px-4);cursor:pointer"
                    >{'{ }'}</span>
                  {/if}
                </div>
              {/if}
            </td>
          {/each}
        </tr>
      {/each}
      {#if virtualItems.length > 0}
        {@const last = virtualItems[virtualItems.length - 1]}
        <tr style="height: {Math.max(0, totalSize - last.end)}px;">
          <td colspan={columns.length + 1}></td>
        </tr>
      {/if}
      {#if editable && onLastPage}
        <!-- inserted rows (pending) — nền xanh lá nhạt (chỉ hiện ở trang cuối); render sau spacer nên luôn nằm ở đáy -->
        {#each insertedRows as ins, insIdx (insIdx)}
          <tr style="height:{ROW_H}px;background:var(--rgba-39-174-96-_14)">
            <td class="mono" style="width:1%;padding:var(--px-3) var(--px-8);text-align:right;color:var(--success);border-bottom:var(--px-1) solid var(--border);border-right:var(--px-1) solid var(--border);position:sticky;left:0;font-size:var(--px-10_5)">＋</td>
            {#each columns as col, ci (ci)}
              {@const isEditing = editingCell?.insert === insIdx && editingCell?.col === col}
              <td
                style="border-bottom:var(--px-1) solid var(--border);border-right:var(--px-1) solid var(--border);padding:0;white-space:nowrap"
                ondblclick={() => startEdit(insIdx, col, insIdx)}
              >
                {#if isEditing}
                  <input
                    class="mono"
                    value={ins[col] == null ? '' : String(ins[col])}
                    use:focusEditor
                    style="width:100%;border:none;outline:none;background:var(--raised);color:var(--text);font-size:var(--px-12);padding:var(--px-5) var(--px-12);font-family:inherit"
                    onpaste={(e) => onCellPaste(e, col, data.rows.length + insIdx)}
                    onblur={(e) => commitEdit(insIdx, col, e.currentTarget.value, ins[col], insIdx)}
                    onkeydown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') commitEdit(insIdx, col, e.currentTarget.value, ins[col], insIdx)
                      else if (e.key === 'Tab') {
                        e.preventDefault()
                        commitEdit(insIdx, col, e.currentTarget.value, ins[col], insIdx)
                        editAdjacent(insIdx, col, e.shiftKey ? -1 : 1, insIdx)
                      } else if (e.key === 'Escape') editingCell = null
                    }}
                  />
                {:else}
                  <div style="padding:var(--px-5) var(--px-12);color:{ins[col] == null ? 'var(--muted)' : 'var(--text)'}">
                    {ins[col] == null ? 'NULL' : String(ins[col])}
                  </div>
                {/if}
              </td>
            {/each}
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
  {/if}
  {#if rowCount === 0 && insertedRows.length === 0}
    <div style="padding:var(--px-12);font-size:var(--px-12);color:var(--muted)">0 rows</div>
  {/if}
</div>
{#if !editable && rowCount > 0}
  <!-- pager (AUDIT item 1) + Group By (T27) -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-4) var(--px-12);border-top:var(--px-1) solid var(--border);background:var(--header);font-size:var(--px-11);color:var(--text2);position:relative">
    <span
      role="button"
      tabindex="0"
      onclick={() => (groupOpen = !groupOpen)}
      onkeydown={(e) => e.key === 'Enter' && (groupOpen = !groupOpen)}
      title="Group rows and aggregate"
      style="cursor:pointer;padding:0 var(--px-6);border-radius:var(--px-4);color:{groupActive ? 'var(--primary)' : 'var(--text2)'};background:{groupActive ? 'var(--panel)' : 'transparent'};font-weight:{groupActive ? 600 : 400}"
    >Σ Group by{groupActive ? ` (${groupBy.length})` : ''}</span>
    {#if groupActive}
      <span role="button" tabindex="0" onclick={clearGroup} onkeydown={(e) => e.key === 'Enter' && clearGroup()} style="cursor:pointer;color:var(--muted)" title="Clear grouping">✕</span>
    {/if}
    {#if groupOpen}
      <div style="position:absolute;bottom:calc(100% + var(--px-4));left:var(--px-8);z-index:62;min-width:var(--px-220);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-8);box-shadow:0 var(--px-12) var(--px-30) var(--rgba-0-0-0-_5);padding:var(--px-8)">
        <div style="font-size:var(--px-10);text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:var(--px-4)">Group by columns</div>
        <div style="max-height:var(--px-150);overflow:auto;display:flex;flex-direction:column;gap:var(--px-2)">
          {#each columns as c, ci (ci)}
            <label class="mono" style="display:flex;align-items:center;gap:var(--px-6);font-size:var(--px-11_5);cursor:pointer;color:var(--text2)">
              <input type="checkbox" checked={groupBy.includes(c)} onchange={() => toggleGroupCol(c)} /> {c}
            </label>
          {/each}
        </div>
        <div style="display:flex;align-items:center;gap:var(--px-6);margin-top:var(--px-8);font-size:var(--px-11)">
          <select bind:value={groupFn} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-4);padding:0 var(--px-4);color:var(--text)">
            {#each AGG_FNS as f (f)}<option value={f}>{f}</option>{/each}
          </select>
          {#if groupFn !== 'count'}
            <select bind:value={groupCol} class="mono" style="flex:1;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-4);padding:0 var(--px-4);color:var(--text)">
              <option value="">column…</option>
              {#each columns as c, ci (ci)}<option value={c}>{c}</option>{/each}
            </select>
          {/if}
        </div>
        <div style="display:flex;gap:var(--px-6);margin-top:var(--px-8);justify-content:flex-end">
          <span class="eg-btn" role="button" tabindex="0" onclick={() => (groupOpen = false)} onkeydown={(e) => e.key === 'Enter' && (groupOpen = false)}>Close</span>
          <span role="button" tabindex="0" onclick={applyGroup} onkeydown={(e) => e.key === 'Enter' && applyGroup()} style="font-size:var(--px-11);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-3) var(--px-12);cursor:{groupBy.length ? 'pointer' : 'not-allowed'};opacity:{groupBy.length ? 1 : 0.5}">Apply</span>
        </div>
      </div>
    {/if}
    <span class="mono" style="margin-left:var(--px-8)">Rows {(pageOffset + 1).toLocaleString()}–{(pageOffset + pageRowCount).toLocaleString()} of {rowCount.toLocaleString()}</span>
    <label style="margin-left:auto;display:flex;align-items:center;gap:var(--px-5)">Page size
      <select bind:value={pageSize} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-4);padding:0 var(--px-4);color:var(--text);font-size:var(--px-11)">
        {#each PAGE_SIZES as s (s)}<option value={s}>{s}</option>{/each}
      </select>
    </label>
    {#if paged}
      {#snippet pbtn(label: string, to: number, disabled: boolean)}
        <span role="button" tabindex="0" aria-disabled={disabled}
          onclick={() => !disabled && (page = to)}
          onkeydown={(e) => e.key === 'Enter' && !disabled && (page = to)}
          style="cursor:{disabled ? 'default' : 'pointer'};opacity:{disabled ? 0.35 : 1};padding:0 var(--px-5);user-select:none">{label}</span>
      {/snippet}
      {@render pbtn('⏮', 0, page === 0)}
      {@render pbtn('◀', page - 1, page === 0)}
      <span class="mono">Page {page + 1} / {pageCount}</span>
      {@render pbtn('▶', page + 1, page >= pageCount - 1)}
      {@render pbtn('⏭', pageCount - 1, page >= pageCount - 1)}
    {/if}
  </div>
{/if}
</div>

<!-- right-click copy menu -->
{#if ctxMenu}
  {@const m = ctxMenu}
  {@const selN = selectedRows.size || (selectedCell ? 1 : data.rows.length)}
  <div role="presentation" style="position:fixed;inset:0;z-index:60" onclick={() => (ctxMenu = null)} oncontextmenu={(e) => { e.preventDefault(); ctxMenu = null }}></div>
  <div use:placeMenu={{ x: m.x, y: m.y }} class="mono" style="position:fixed;left:{m.x}px;top:{m.y}px;max-height:calc(100vh - var(--px-16));overflow-y:auto;z-index:61;min-width:var(--px-200);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-8);box-shadow:0 var(--px-12) var(--px-30) var(--rgba-0-0-0-_5);padding:var(--px-4) 0;font-size:var(--px-12)">
    {#snippet item(label: string, act: () => void)}
      <div
        role="button"
        tabindex="0"
        onclick={act}
        onkeydown={(e) => e.key === 'Enter' && act()}
        style="padding:var(--px-6) var(--px-14);cursor:pointer;color:var(--text);white-space:nowrap"
        onmouseenter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
        onmouseleave={(e) => (e.currentTarget.style.background = 'transparent')}
      >{label}</div>
    {/snippet}
    {@render item('Copy cell', () => copyCell(m.row, m.col))}
    {@render item('Copy row', () => copyRowTsv(m.row))}
    {@render item('Copy column', () => copyColumn(m.col))}
    {#if editable}
      {@render item('Paste', () => { clickCell(m.row, m.col); void pasteFromClipboard() })}
    {/if}
    <div style="height:var(--px-1);background:var(--border);margin:var(--px-4) 0"></div>
    <div style="padding:var(--px-3) var(--px-14);font-size:var(--px-9_5);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">Copy {selN} row(s) as</div>
    {@render item('Tab-separated', () => copyAs('tsv'))}
    {@render item('CSV', () => copyAs('csv'))}
    {@render item('JSON', () => copyAs('json'))}
    {@render item('SQL INSERT', () => copyAs('sql-insert'))}
    {@render item('SQL UPDATE', () => copyAs('sql-update'))}
    {@render item('Markdown table', () => copyAs('markdown'))}
    {@render item('XML', () => copyAs('xml'))}
  </div>
{/if}

<!-- Preview diff dialog — SQL sẽ chạy trước khi Apply (spec §5 editable) -->
{#if previewSql !== null}
  <div
    onclick={() => (previewSql = null)}
    onkeydown={(e) => e.key === 'Escape' && (previewSql = null)}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:58"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Preview changes"
      tabindex="-1"
      style="width:var(--px-640);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden"
    >
      <div style="padding:var(--px-18) var(--px-20) var(--px-8);font-weight:700;font-size:var(--px-15)">
        Preview — {previewSql.length} statement(s) will run in one transaction
      </div>
      <div style="padding:0 var(--px-20) var(--px-14)">
        <pre class="selectable mono" style="max-height:50vh;overflow:auto;border-radius:var(--px-9);background:var(--panel);border:var(--px-1) solid var(--border);padding:var(--px-12);font-size:var(--px-11_5);line-height:1.6;margin:0">{previewSql.join('\n')}</pre>
      </div>
      <div style="display:flex;gap:var(--px-9);padding:var(--px-14) var(--px-20);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span class="eg-btn" style="margin-left:auto" onclick={() => (previewSql = null)} onkeydown={(e) => e.key === 'Enter' && (previewSql = null)} role="button" tabindex="0">Close</span>
        <span
          onclick={() => { previewSql = null; void apply() }}
          onkeydown={(e) => e.key === 'Enter' && (previewSql = null, apply())}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer"
        >Apply</span>
      </div>
    </div>
  </div>
{/if}

<!-- JSON cell modal — port jsonCellOpen (format + copy) -->
{#if jsonCell !== null}
  <div
    onclick={() => (jsonCell = null)}
    onkeydown={(e) => e.key === 'Escape' && (jsonCell = null)}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:58"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="JSON cell"
      tabindex="-1"
      style="width:var(--px-640);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden"
    >
      <div style="padding:var(--px-18) var(--px-20) var(--px-8);font-weight:700;font-size:var(--px-15)">JSON cell</div>
      <div style="padding:0 var(--px-20) var(--px-14)">
        <pre class="mono selectable" style="max-height:50vh;overflow:auto;border-radius:var(--px-9);background:var(--panel);border:var(--px-1) solid var(--border);padding:var(--px-12);font-size:var(--px-11_5);line-height:1.6;margin:0">{jsonCell}</pre>
      </div>
      <div style="display:flex;gap:var(--px-9);padding:var(--px-14) var(--px-20);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span class="eg-btn" style="margin-left:auto" onclick={async () => { if (jsonCell) await navigator.clipboard.writeText(jsonCell) }} onkeydown={(e) => e.key === 'Enter' && jsonCell && navigator.clipboard.writeText(jsonCell)} role="button" tabindex="0">Copy</span>
        <span
          onclick={() => (jsonCell = null)}
          onkeydown={(e) => e.key === 'Enter' && (jsonCell = null)}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer"
        >Close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  /* style-hover của row (dòng 434) — KHÔNG áp cho row đang selected để hover
     không xoá mất màu selection (dùng inline bg từ --grid-select). */
  .grid-row:not(.selected):hover {
    background: var(--hover) !important;
  }
  .eg-btn {
    font-size: var(--px-11_5);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-4) var(--px-10);
    cursor: pointer;
  }
  .eg-btn:hover {
    background: var(--hover);
  }
</style>
