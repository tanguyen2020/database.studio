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
  import { save as saveFileDialog } from '@tauri-apps/plugin-dialog'
  import { invoke } from '@tauri-apps/api/core'
  import { toasts } from '$lib/stores/toast.svelte'
  import { applyGridChanges, previewGridChanges, chGenerateMutations, type GridChange } from '$lib/ipc'
  import { tabs } from '$lib/stores/tabs.svelte'
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
  }

  let { data, editTarget }: Props = $props()

  // ---- editable state (chỉ dùng khi editTarget) ----------------------------
  // cell đã sửa: "rowIdx:col" → giá trị mới (đã coerce về kiểu gốc)
  let edits = $state<Map<string, unknown>>(new Map())
  let deletedRows = $state<Set<number>>(new Set())
  let insertedRows = $state<Record<string, unknown>[]>([])
  let editingCell = $state<{ row: number; col: string; insert?: number } | null>(null)
  let previewSql = $state<string[] | null>(null)
  let applying = $state(false)
  // JSON cell viewer (badge { } → modal)
  let jsonCell = $state<string | null>(null)

  function isJsonValue(v: unknown): boolean {
    return typeof v === 'object' && v !== null
  }

  const editable = $derived(!!editTarget)
  const pendingCount = $derived(edits.size + deletedRows.size + insertedRows.length)

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

  function startEdit(row: number, col: string, insert?: number) {
    if (!editable) return
    editingCell = { row, col, insert }
  }

  function commitEdit(value: string, original: unknown) {
    if (!editingCell) return
    const { row, col, insert } = editingCell
    if (insert != null) {
      insertedRows[insert][col] = coerce(value, original ?? '')
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

  function toggleDeleteSelected() {
    if (selectedRows.size === 0) return
    const next = new Set(deletedRows)
    for (const r of selectedRows) {
      if (next.has(r)) next.delete(r)
      else next.add(r)
    }
    deletedRows = next
  }

  function addRow() {
    insertedRows.push(Object.fromEntries(columns.map((c) => [c, null])))
    insertedRows = [...insertedRows]
  }

  function discard() {
    edits = new Map()
    deletedRows = new Set()
    insertedRows = []
    editingCell = null
    previewSql = null
  }

  /** Dựng GridChange[] từ buffer pending. */
  function buildChanges(): GridChange[] {
    const t = editTarget!
    const pk = (cols: string[]) => cols
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
        pk: pk(whereCols).map((c) => ({ name: c, value: orig?.[c] ?? null })),
        set: cols.map((c) => ({ name: c, value: edits.get(cellKey(r, c)) })),
      })
    }
    // DELETE
    for (const r of deletedRows) {
      const orig = data.rows[r]
      out.push({
        kind: 'delete',
        schema: t.schema,
        table: t.table,
        pk: pk(whereCols).map((c) => ({ name: c, value: orig?.[c] ?? null })),
      })
    }
    // INSERT (bỏ cột null hoàn toàn để dùng default của DB)
    for (const ins of insertedRows) {
      const values = columns
        .filter((c) => ins[c] !== null && ins[c] !== undefined && ins[c] !== '')
        .map((c) => ({ name: c, value: ins[c] }))
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

  $effect(() => {
    if (!scrollEl) return
    const count = rowCount
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

  function onKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault()
      void copySelection()
    }
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
          <span class="eg-btn" onclick={discard} onkeydown={(e) => e.key === 'Enter' && discard()} role="button" tabindex="0">Discard</span>
          <span
            onclick={apply}
            onkeydown={(e) => e.key === 'Enter' && apply()}
            role="button"
            tabindex="0"
            style="font-size:var(--px-11_5);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer"
          >{applying ? 'Applying…' : 'Apply'}</span>
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
>
  <!-- table — port dòng 421-452: mono 12px, th sticky header 6px 12px/600/text2 -->
  <table class="mono" style="border-collapse:separate;border-spacing:0;width:100%;font-size:var(--px-12)">
    <thead style="position:sticky;top:0;z-index:10">
      <tr>
        {#each data.cols as [name, type] (name)}
          <th style="background:var(--header);border-bottom:var(--px-1) solid var(--border2);border-right:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);text-align:left;font-weight:600;color:var(--text2);white-space:nowrap">
            {name}
            <span style="color:var(--muted);font-weight:400;font-size:var(--px-10)">{type}</span>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if virtualItems.length > 0}
        <tr style="height: {virtualItems[0].start}px;"><td colspan={columns.length}></td></tr>
      {/if}
      {#each virtualItems as vi (vi.key)}
        {@const row = data.rows[vi.index]}
        {@const isRowSelected = selectedRows.has(vi.index)}
        {@const isDeleted = deletedRows.has(vi.index)}
        <!-- row — dòng 434: zebra + selected inset bar; deleted → đỏ gạch ngang -->
        <tr
          class="grid-row"
          onclick={(e) => clickRowNumber(e, vi.index)}
          style="height:{ROW_H}px;cursor:pointer;background:{isDeleted ? 'var(--rgba-224-108-117-_14)' : isRowSelected ? 'var(--rgba-91-124-255-_16)' : vi.index % 2 === 1 ? 'var(--grid-zebra)' : 'transparent'};box-shadow:inset var(--px-2) 0 0 {isRowSelected ? 'var(--primary)' : 'transparent'};{isDeleted ? 'text-decoration:line-through;opacity:.65;' : ''}"
        >
          {#each columns as col (col)}
            {@const edited = edits.has(cellKey(vi.index, col))}
            {@const rawVal = edited ? edits.get(cellKey(vi.index, col)) : row?.[col]}
            {@const cell = display(rawVal, col)}
            {@const isCellSelected = selectedCell?.row === vi.index && selectedCell?.col === col}
            {@const isEditing = editingCell?.row === vi.index && editingCell?.col === col && editingCell?.insert == null}
            <!-- cell — dòng 436-446: padding 5px 12px, NULL badge; edit → highlight vàng -->
            <td
              style="border-bottom:var(--px-1) solid var(--border);border-right:var(--px-1) solid var(--border);padding:0;white-space:nowrap;max-width:var(--px-420);overflow:hidden;text-overflow:ellipsis;{edited ? `background:var(--rgba-240-160-32-_18);` : ''}{isCellSelected ? 'box-shadow:inset 0 0 0 var(--px-1) var(--primary);' : ''}"
              onclick={(e) => { e.stopPropagation(); clickCell(vi.index, col) }}
              ondblclick={(e) => {
                e.stopPropagation()
                if (editable) startEdit(vi.index, col)
                else { clickCell(vi.index, col); void copySelection() }
              }}
              title={cell.isNull ? undefined : cell.text}
            >
              {#if isEditing}
                <!-- inline edit — port dòng 437-439 -->
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="mono"
                  value={cell.isNull ? '' : cell.text}
                  autofocus
                  style="width:100%;border:none;outline:none;background:var(--raised);color:var(--text);font-size:var(--px-12);padding:var(--px-5) var(--px-12);font-family:inherit"
                  onblur={(e) => commitEdit(e.currentTarget.value, row?.[col] ?? null)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') commitEdit(e.currentTarget.value, row?.[col] ?? null)
                    if (e.key === 'Escape') editingCell = null
                  }}
                />
              {:else}
                <div style="padding:var(--px-5) var(--px-12);display:flex;align-items:center;gap:var(--px-6)">
                  {#if cell.isNull}
                    <span style="font-size:var(--px-10);color:var(--muted);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-3);padding:0 var(--px-5)">NULL</span>
                  {:else if cell.text === ''}
                    <span style="font-size:var(--px-10);color:var(--muted);opacity:.6">''</span>
                  {:else}
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{cell.text}</span>
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
      {#if editable}
        <!-- inserted rows (pending) — nền xanh lá nhạt -->
        {#each insertedRows as ins, insIdx (insIdx)}
          <tr style="height:{ROW_H}px;background:var(--rgba-39-174-96-_14)">
            {#each columns as col (col)}
              {@const isEditing = editingCell?.insert === insIdx && editingCell?.col === col}
              <td
                style="border-bottom:var(--px-1) solid var(--border);border-right:var(--px-1) solid var(--border);padding:0;white-space:nowrap"
                ondblclick={() => startEdit(insIdx, col, insIdx)}
              >
                {#if isEditing}
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    class="mono"
                    value={ins[col] == null ? '' : String(ins[col])}
                    autofocus
                    style="width:100%;border:none;outline:none;background:var(--raised);color:var(--text);font-size:var(--px-12);padding:var(--px-5) var(--px-12);font-family:inherit"
                    onblur={(e) => commitEdit(e.currentTarget.value, ins[col])}
                    onkeydown={(e) => {
                      if (e.key === 'Enter') commitEdit(e.currentTarget.value, ins[col])
                      if (e.key === 'Escape') editingCell = null
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
      {#if virtualItems.length > 0}
        {@const last = virtualItems[virtualItems.length - 1]}
        <tr style="height: {Math.max(0, totalSize - last.end)}px;">
          <td colspan={columns.length}></td>
        </tr>
      {/if}
    </tbody>
  </table>
  {#if rowCount === 0 && insertedRows.length === 0}
    <div style="padding:var(--px-12);font-size:var(--px-12);color:var(--muted)">0 rows</div>
  {/if}
</div>
</div>

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
  /* style-hover của row (dòng 434) */
  .grid-row:hover {
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
