import { describe, expect, it } from 'vitest'
import { pageWindow, ALL_ROWS } from './paging'

describe('pageWindow', () => {
  it('not paged when result fits one page', () => {
    const w = pageWindow(3, 200, 0)
    expect(w).toMatchObject({ paged: false, pageCount: 1, offset: 0, count: 3, last: true })
  })

  it('splits into pages with correct offset/count', () => {
    expect(pageWindow(450, 200, 0)).toMatchObject({ paged: true, pageCount: 3, offset: 0, count: 200, last: false })
    expect(pageWindow(450, 200, 1)).toMatchObject({ offset: 200, count: 200, last: false })
    expect(pageWindow(450, 200, 2)).toMatchObject({ offset: 400, count: 50, last: true })
  })

  it('clamps out-of-range page (e.g. after a page-size change)', () => {
    expect(pageWindow(450, 200, 99).page).toBe(2)
    expect(pageWindow(450, 200, -5).page).toBe(0)
  })

  it('exact multiple → full last page, no empty trailing page', () => {
    const w = pageWindow(400, 200, 1)
    expect(w).toMatchObject({ pageCount: 2, offset: 200, count: 200, last: true })
  })

  it('empty result → one page, zero rows', () => {
    expect(pageWindow(0, 200, 0)).toMatchObject({ paged: false, pageCount: 1, count: 0, last: true })
  })

  // pageSize 0 used to be a div-by-zero guard (→ 1 row); it now means ALL_ROWS.
  it('ALL_ROWS (0) puts every fetched row on one page — no div-by-zero', () => {
    const w = pageWindow(250_000, ALL_ROWS, 7)
    expect(w).toEqual({ paged: false, pageCount: 1, page: 0, offset: 0, count: 250_000, last: true })
    expect(pageWindow(0, ALL_ROWS, 0).count).toBe(0)
    expect(pageWindow(10, -5, 0).count).toBe(10)
  })
})
