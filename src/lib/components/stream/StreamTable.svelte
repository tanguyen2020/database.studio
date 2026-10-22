<script lang="ts" module>
  import type { SortValue } from '$lib/stream/table'
  export interface StreamColumn<T> {
    key: string
    label: string
    /** one-sentence tooltip on the header explaining the term (rule U1) */
    help?: string
    align?: 'left' | 'right'
    /** CSS width, e.g. 'var(--px-120)' */
    width?: string
    /** for a column WITHOUT a fixed width: the least it may shrink to (default 200px) */
    min?: string
    /** value used for sorting; omit to make the column unsortable */
    sort?: (row: T) => SortValue
  }
</script>

<script lang="ts" generics="T">
  // One data table for every Cache & Streaming list (SPEC-STREAM-SHELL.md §3):
  // filter box, sortable headers with plain-language tooltips, virtual scrolling for
  // thousands of rows, keyboard selection (↑ ↓ Home End, Enter opens) and an empty
  // state that says what to do next (rule U6).
  import type { Snippet } from 'svelte'
  import { untrack } from 'svelte'
  import Icon from '$lib/components/Icon.svelte'
  import { filterRows, isZeroText, moveSelection, nextSort, sortRows, virtualWindow, type SortState } from '$lib/stream/table'

  // Number cells that show only a zero get data-zero, so empty rows recede and the
  // rows that hold something stand out. Watches the cell because its content is
  // re-rendered in place when the row's data changes.
  function markZero(node: HTMLElement, enabled: boolean) {
    let mo: MutationObserver | null = null
    const check = () => {
      if (enabled && isZeroText(node.textContent ?? '')) node.setAttribute('data-zero', '')
      else node.removeAttribute('data-zero')
    }
    const start = () => {
      check()
      mo?.disconnect()
      mo = null
      if (enabled) {
        mo = new MutationObserver(check)
        mo.observe(node, { childList: true, subtree: true, characterData: true })
      }
    }
    start()
    return {
      update(next: boolean) {
        enabled = next
        start()
      },
      destroy() {
        mo?.disconnect()
      },
    }
  }

  interface Props {
    rows: T[]
    columns: StreamColumn<T>[]
    rowKey: (row: T) => string
    cell: Snippet<[T, StreamColumn<T>]>
    ariaLabel: string
    selected?: string | null
    onSelect?: (row: T) => void
    onOpen?: (row: T) => void
    filterText?: (row: T) => string
    filterPlaceholder?: string
    initialSort?: SortState | null
    rowHeight?: number
    loading?: boolean
    error?: string | null
    emptyTitle?: string
    emptyBody?: string
    emptyActionLabel?: string
    onEmptyAction?: () => void
    /** extra controls placed next to the filter box */
    tools?: Snippet
    /** short note under the table (e.g. "3 internal topics hidden") */
    note?: string | null
    /** called with the rows currently rendered (the virtual window), so a view can
     *  fetch per-row details only for what is on screen (Redis Browser key sizes) */
    onWindow?: (rows: T[]) => void
    /** tree lists (NATS stream → subject): replaces the flat filter + sort with the
     *  caller's own ordering, so children stay under their parent */
    arrange?: (rows: T[], query: string, sort: SortState | null) => T[]
    /** tree row metadata: depth (aria-level), open state (aria-expanded), and a kind
     *  written to data-kind so a view and its tests can tell parents from children */
    rowLevel?: (row: T) => number
    rowExpanded?: (row: T) => boolean | undefined
    rowKind?: (row: T) => string
    /** ← / → on the selected row: close (false) or open (true) it */
    onToggle?: (row: T, open: boolean) => void
  }

  let {
    rows,
    columns,
    rowKey,
    cell,
    ariaLabel,
    selected = null,
    onSelect,
    onOpen,
    filterText,
    filterPlaceholder = 'Filter…',
    initialSort = null,
    rowHeight = 30,
    loading = false,
    error = null,
    emptyTitle = 'Nothing here yet',
    emptyBody = '',
    emptyActionLabel,
    onEmptyAction,
    tools,
    note = null,
    onWindow,
    arrange,
    rowLevel,
    rowExpanded,
    rowKind,
    onToggle,
  }: Props = $props()

  let query = $state('')
  let sort = $state<SortState | null>(untrack(() => initialSort))
  let scrollTop = $state(0)
  let viewport = $state(0)
  let scroller = $state<HTMLDivElement | null>(null)

  const columnByKey = $derived(new Map(columns.map((c) => [c.key, c])))
  // The table never squeezes a column to nothing (a fixed-width set wider than the
  // panel used to hide the name column): it is at least as wide as every fixed column
  // plus room for each flexible one, and scrolls sideways when the panel is narrower.
  const minWidth = $derived(`calc(${columns.map((c) => c.width ?? c.min ?? 'var(--px-200)').join(' + ')})`)
  const visible = $derived(arrange ? rows : filterText ? filterRows(rows, query, filterText) : rows)
  const sorted = $derived(arrange ? arrange(rows, query, sort) : sortRows(visible, sort, (r, key) => columnByKey.get(key)?.sort?.(r)))
  // a tree counts its top-level rows (streams), not the children shown under them
  const shownCount = $derived(arrange && rowLevel ? sorted.filter((r) => rowLevel(r) === 0).length : sorted.length)
  const win = $derived(virtualWindow(sorted.length, rowHeight, scrollTop, viewport))
  const slice = $derived(sorted.slice(win.start, win.end))
  $effect(() => {
    const rows = slice
    if (onWindow) untrack(() => onWindow(rows))
  })
  const selectedIndex = $derived(selected == null ? -1 : sorted.findIndex((r) => rowKey(r) === selected))

  function headerClick(c: StreamColumn<T>) {
    if (!c.sort) return
    sort = nextSort(sort, c.key, c.align === 'right' ? 'desc' : 'asc')
  }

  function ensureVisible(index: number) {
    if (!scroller || index < 0) return
    const head = rowHeight // the sticky header is one row tall
    const top = index * rowHeight
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (top + rowHeight > scroller.scrollTop + scroller.clientHeight - head) scroller.scrollTop = top + rowHeight - scroller.clientHeight + head
  }

  function onKey(e: KeyboardEvent) {
    if (!sorted.length) return
    let next = -2
    if (e.key === 'ArrowDown') next = moveSelection(selectedIndex, 1, sorted.length)
    else if (e.key === 'ArrowUp') next = moveSelection(selectedIndex, -1, sorted.length)
    else if (e.key === 'PageDown') next = moveSelection(selectedIndex, Math.max(1, Math.floor(viewport / rowHeight) - 1), sorted.length)
    else if (e.key === 'PageUp') next = moveSelection(selectedIndex, -Math.max(1, Math.floor(viewport / rowHeight) - 1), sorted.length)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = sorted.length - 1
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && onToggle && selectedIndex >= 0) {
      e.preventDefault()
      onToggle(sorted[selectedIndex], e.key === 'ArrowRight')
      return
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault()
      onOpen?.(sorted[selectedIndex])
      return
    }
    if (next === -2) return
    e.preventDefault()
    onSelect?.(sorted[next])
    ensureVisible(next)
  }

  function sortLabel(c: StreamColumn<T>): 'ascending' | 'descending' | undefined {
    if (!sort || sort.key !== c.key) return undefined
    return sort.dir === 'asc' ? 'ascending' : 'descending'
  }
</script>

<div class="st-wrap">
  {#if filterText || tools}
    <div class="st-tools">
      {#if filterText}
        <label class="ds-search st-search">
          <Icon name="search" size={13} />
          <input bind:value={query} placeholder={filterPlaceholder} aria-label={filterPlaceholder} />
          {#if query}
            <button type="button" class="st-clear" onclick={() => (query = '')} aria-label="Clear filter"><Icon name="close" size={11} /></button>
          {/if}
        </label>
      {/if}
      {@render tools?.()}
      <span class="ds-meta st-count">
        {#if query && filterText}<b>{shownCount.toLocaleString('en-US')}</b> of {rows.length.toLocaleString('en-US')}{:else}<b>{rows.length.toLocaleString('en-US')}</b>{/if}
      </span>
    </div>
  {/if}

  <div
    class="st-scroll"
    bind:this={scroller}
    bind:clientHeight={viewport}
    onscroll={(e) => (scrollTop = (e.currentTarget as HTMLDivElement).scrollTop)}
  >
    {#if error}
      <div class="ds-empty st-error" role="alert"><b>Could not load this list</b>{error}</div>
    {:else if loading && rows.length === 0}
      <div class="ds-empty" aria-busy="true">Loading…</div>
    {:else if rows.length === 0}
      <div class="ds-empty">
        <b>{emptyTitle}</b>
        {#if emptyBody}<span>{emptyBody}</span>{/if}
        {#if emptyActionLabel && onEmptyAction}
          <div class="st-empty-action"><button type="button" class="cfm-btn primary" onclick={onEmptyAction}>{emptyActionLabel}</button></div>
        {/if}
      </div>
    {:else if sorted.length === 0}
      <div class="ds-empty"><b>No matches</b>Nothing contains “{query}”. <button type="button" class="st-inline-link" onclick={() => (query = '')}>Clear the filter</button></div>
    {:else}
      <table class="st-table" style="min-width:{minWidth}" role="grid" aria-label={ariaLabel} aria-rowcount={sorted.length + 1} tabindex="0" onkeydown={onKey}>
        <colgroup>
          {#each columns as c (c.key)}<col style={c.width ? `width:${c.width}` : undefined} />{/each}
        </colgroup>
        <thead>
          <tr style="height:{rowHeight}px">
            {#each columns as c (c.key)}
              <th
                class:right={c.align === 'right'}
                class:sortable={!!c.sort}
                aria-sort={sortLabel(c) ?? (c.sort ? 'none' : undefined)}
                title={c.help}
                onclick={() => headerClick(c)}
              >
                <span class="st-th">
                  {c.label}
                  {#if c.help}<span class="st-help" aria-hidden="true"><Icon name="info" size={11} /></span>{/if}
                  {#if sort?.key === c.key}<span class="st-arrow" aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>{/if}
                </span>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#if win.padTop > 0}<tr aria-hidden="true" style="height:{win.padTop}px"></tr>{/if}
          {#each slice as row, i (rowKey(row))}
            {@const key = rowKey(row)}
            <tr
              aria-rowindex={win.start + i + 2}
              aria-level={rowLevel ? rowLevel(row) + 1 : undefined}
              aria-expanded={rowExpanded?.(row)}
              data-kind={rowKind?.(row)}
              aria-selected={key === selected}
              class:sel={key === selected}
              class:zebra={!rowLevel && (win.start + i) % 2 === 1}
              class:group={!!rowLevel && rowLevel(row) === 0}
              class:child={!!rowLevel && rowLevel(row) > 0}
              style="height:{rowHeight}px"
              onclick={() => onSelect?.(row)}
              ondblclick={() => onOpen?.(row)}
            >
              {#each columns as c (c.key)}
                <td class:right={c.align === 'right'} use:markZero={c.align === 'right'}>{@render cell(row, c)}</td>
              {/each}
            </tr>
          {/each}
          {#if win.padBottom > 0}<tr aria-hidden="true" style="height:{win.padBottom}px"></tr>{/if}
        </tbody>
      </table>
    {/if}
  </div>
  {#if note}<div class="st-note">{note}</div>{/if}
</div>

<style>
  .st-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .st-tools {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-10) var(--px-14);
    flex-wrap: wrap;
  }
  .st-search {
    flex: 1 1 var(--px-240);
    max-width: var(--px-420);
  }
  .st-clear {
    border: 0;
    background: transparent;
    color: var(--muted);
    display: inline-flex;
    cursor: pointer;
    padding: var(--px-2);
  }
  .st-count {
    margin-left: auto;
  }
  .st-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    outline: none;
    border-top: var(--px-1) solid var(--border);
    background: var(--surface);
  }
  .st-table:focus-visible {
    box-shadow: inset 0 0 0 var(--px-2) var(--ring-soft);
  }
  .st-table {
    outline: none;
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    font-size: var(--px-12_5);
  }
  .st-table th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--header);
    border-bottom: var(--px-1) solid var(--border2);
    padding: 0 var(--px-12);
    text-align: left;
    font-family: var(--font-main);
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--tbl-th);
    white-space: nowrap;
    user-select: none;
  }
  .st-table th.sortable {
    cursor: pointer;
  }
  .st-table th.sortable:hover {
    color: var(--text);
  }
  .st-th {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
  }
  .st-help {
    display: inline-flex;
    color: var(--muted);
  }
  .st-arrow {
    color: var(--primary);
  }
  .st-table td {
    padding: 0 var(--px-12);
    border-bottom: var(--px-1) solid var(--border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--tbl-cell);
  }
  .st-table .right {
    text-align: right;
  }
  /* numbers sit one step below the names they belong to; zeros step back further */
  .st-table td.right {
    color: var(--tbl-cell);
  }
  .st-table td:global([data-zero]),
  .st-table td:global([data-zero]) :global(*) {
    color: var(--tbl-zero);
  }
  .st-table th.right .st-th {
    justify-content: flex-end;
    width: 100%;
  }
  .st-table tbody tr {
    cursor: default;
  }
  .st-table tbody tr.zebra {
    background: var(--tbl-zebra);
  }
  /* tree tables: a parent is a quiet band with a bolder name; its children hang off a
     thin guide line under the parent's chevron */
  .st-table tbody tr.group {
    background: var(--tbl-group);
  }
  .st-table tbody tr.group :global(.ds-name) {
    font-weight: 600;
  }
  .st-table tbody tr.child td:first-child {
    background: linear-gradient(var(--tbl-guide), var(--tbl-guide)) var(--px-20) 0 / var(--px-1) 100% no-repeat;
  }
  .st-table tbody tr:hover {
    background: var(--tbl-hover);
  }
  .st-table tbody tr.sel {
    background: color-mix(in srgb, var(--text) 13%, var(--surface));
    box-shadow: inset var(--px-3) 0 0 color-mix(in srgb, var(--text) 62%, transparent);
  }
  .st-note {
    flex: none;
    padding: var(--px-6) var(--px-14);
    font-size: var(--px-11_5);
    color: var(--muted);
    border-top: var(--px-1) solid var(--border);
    background: var(--surface);
  }
  .st-empty-action {
    margin-top: var(--px-12);
  }
  .st-inline-link {
    border: 0;
    background: transparent;
    color: var(--primary);
    font: inherit;
    cursor: pointer;
    padding: 0;
  }
  .st-error {
    color: var(--danger-text);
  }
</style>
