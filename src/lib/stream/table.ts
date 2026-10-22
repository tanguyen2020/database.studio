// Pure helpers behind StreamTable: filter, sort and the virtual-scroll window.
// Kept out of the component so they are unit-tested and the table stays a thin view.

export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: string
  dir: SortDir
}

/** A value a column sorts by: numbers sort numerically, everything else as text. */
export type SortValue = number | string | null | undefined

/**
 * Case-insensitive "contains" over the given text fields of each row.
 * An empty query keeps every row (same array, no copy).
 */
export function filterRows<T>(rows: T[], query: string, text: (row: T) => string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => text(r).toLowerCase().includes(q))
}

function compare(a: SortValue, b: SortValue): number {
  const aNil = a == null || (typeof a === 'number' && Number.isNaN(a))
  const bNil = b == null || (typeof b === 'number' && Number.isNaN(b))
  if (aNil && bNil) return 0
  if (aNil) return 1 // unknown values always sink to the bottom
  if (bNil) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' })
}

/**
 * Stable sort by one column. Unknown values (null/NaN) stay at the bottom in both
 * directions, so "sort by lag" never puts "?" rows on top.
 */
export function sortRows<T>(rows: T[], sort: SortState | null, value: (row: T, key: string) => SortValue): T[] {
  if (!sort) return rows
  const dir = sort.dir === 'asc' ? 1 : -1
  return rows
    .map((row, i) => ({ row, i, v: value(row, sort.key) }))
    .sort((x, y) => {
      const xNil = x.v == null || (typeof x.v === 'number' && Number.isNaN(x.v))
      const yNil = y.v == null || (typeof y.v === 'number' && Number.isNaN(y.v))
      if (xNil !== yNil) return xNil ? 1 : -1
      const c = compare(x.v, y.v) * dir
      return c !== 0 ? c : x.i - y.i
    })
    .map((x) => x.row)
}

/** Click on a header: new column → ascending; same column → toggles direction. */
export function nextSort(current: SortState | null, key: string, firstDir: SortDir = 'asc'): SortState {
  if (!current || current.key !== key) return { key, dir: firstDir }
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
}

export interface VirtualWindow {
  start: number
  end: number // exclusive
  padTop: number
  padBottom: number
}

/**
 * Which rows to render for a fixed row height. `overscan` extra rows above and
 * below keep fast scrolling from flashing blank lines.
 */
export function virtualWindow(
  total: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 8,
): VirtualWindow {
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1
  const start = Math.max(0, Math.min(total, first - overscan))
  const end = Math.max(start, Math.min(total, first + visible + overscan))
  return { start, end, padTop: start * rowHeight, padBottom: (total - end) * rowHeight }
}

/** Index after moving the keyboard selection by `delta`, clamped to the list. */
/** True when a cell shows nothing but a zero ("0", "0 B", "0/s", "0.0 MB") —
 *  such cells are drawn quieter so the rows that hold something stand out. */
export function isZeroText(text: string): boolean {
  return /^0(?:[.,]0+)?\s*(?:[a-zA-Z%]+)?(?:\/[a-zA-Z]+)?$/.test(text.trim())
}

export function moveSelection(current: number, delta: number, total: number): number {
  if (total <= 0) return -1
  if (current < 0) return delta >= 0 ? 0 : total - 1
  return Math.max(0, Math.min(total - 1, current + delta))
}
