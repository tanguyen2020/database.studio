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
  import type { QueryResultSet } from '$lib/types'

  interface Props {
    data: QueryResultSet
  }

  let { data }: Props = $props()

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
    virtualizer._didMount()
    virtualizer._willUpdate()
    virtualItems = virtualizer.getVirtualItems()
    totalSize = virtualizer.getTotalSize()
    return () => virtualizer._didMount()()
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
    toasts.success('Đã copy vào clipboard')
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
      toasts.success(`Đã export ${data.rows.length.toLocaleString()} rows → ${path}`)
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={scrollEl}
  class="selectable h-full min-h-0 overflow-auto outline-none"
  tabindex="0"
  role="grid"
  aria-rowcount={rowCount}
  onkeydown={onKeydown}
>
  <table class="border-separate border-spacing-0 text-[12px]" style="min-width: 100%;">
    <thead class="sticky top-0 z-10">
      <tr>
        <th class="sticky left-0 z-20 w-[46px] border-b border-r border-border bg-header px-1 text-right text-[10px] font-normal text-mutedfg">
          #
        </th>
        {#each data.cols as [name, type] (name)}
          <th class="border-b border-r border-border bg-header px-2 py-1 text-left font-medium">
            <div class="flex items-baseline gap-1.5 whitespace-nowrap">
              <span>{name}</span>
              <span class="mono text-[9.5px] font-normal text-mutedfg">{type}</span>
            </div>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if virtualItems.length > 0}
        <tr style="height: {virtualItems[0].start}px;"><td colspan={columns.length + 1}></td></tr>
      {/if}
      {#each virtualItems as vi (vi.key)}
        {@const row = data.rows[vi.index]}
        {@const isRowSelected = selectedRows.has(vi.index)}
        <tr
          class="{vi.index % 2 === 1 ? 'bg-zebra' : ''} {isRowSelected ? '!bg-[var(--diff-highlight)]' : ''}"
          style="height: {ROW_H}px;"
        >
          <td
            class="sticky left-0 cursor-pointer border-b border-r border-border bg-header px-1 text-right text-[10px] text-mutedfg hover:text-foreground"
            onclick={(e) => clickRowNumber(e, vi.index)}
          >
            {vi.index + 1}
          </td>
          {#each columns as col (col)}
            {@const cell = display(row?.[col], col)}
            {@const isCellSelected = selectedCell?.row === vi.index && selectedCell?.col === col}
            <td
              class="max-w-[420px] cursor-default overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-border/60 px-2
                {isCellSelected ? 'outline outline-1 -outline-offset-1 outline-primary' : ''}"
              onclick={() => clickCell(vi.index, col)}
              ondblclick={() => {
                clickCell(vi.index, col)
                void copySelection()
              }}
              title={cell.isNull ? undefined : cell.text}
            >
              {#if cell.isNull}
                <!-- NULL ≠ empty string: gray badge -->
                <span class="rounded-sm bg-panel px-1 py-px text-[9.5px] italic text-mutedfg">NULL</span>
              {:else if cell.text === ''}
                <span class="text-[9.5px] text-mutedfg/60">''</span>
              {:else}
                <span class="mono">{cell.text}</span>
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
    </tbody>
  </table>
  {#if rowCount === 0}
    <div class="px-3 py-4 text-[12px] text-mutedfg">0 rows</div>
  {/if}
</div>
