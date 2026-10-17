// Result-grid pagination math (AUDIT item 1). Pure → unit-testable. Client-side
// window over already-fetched rows; indices stay absolute in the component.

export interface PageWindow {
  /** true when the result is larger than one page. */
  paged: boolean
  /** total number of pages (≥ 1). */
  pageCount: number
  /** page clamped into [0, pageCount-1]. */
  page: number
  /** absolute index of the first row on the page. */
  offset: number
  /** number of rows on the page. */
  count: number
  /** true when showing the last page (or not paged at all). */
  last: boolean
}

/** Page size meaning "every row on one page". The grid is virtualised, so only
 *  the rows on screen are rendered no matter how many the page holds. */
export const ALL_ROWS = 0

export function pageWindow(rowCount: number, pageSize: number, page: number): PageWindow {
  const size = pageSize <= ALL_ROWS ? Math.max(1, rowCount) : Math.max(1, pageSize)
  const paged = rowCount > size
  const pageCount = paged ? Math.ceil(rowCount / size) : 1
  const clamped = Math.min(Math.max(0, page), pageCount - 1)
  const offset = paged ? clamped * size : 0
  const count = paged ? Math.max(0, Math.min(size, rowCount - offset)) : rowCount
  return { paged, pageCount, page: clamped, offset, count, last: !paged || clamped >= pageCount - 1 }
}
