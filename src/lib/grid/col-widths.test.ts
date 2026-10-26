import { describe, expect, it } from 'vitest'
import { clipForMeasure, columnWidths, sampleRows } from './col-widths'

describe('sampleRows', () => {
  it('takes every row of a small result', () => {
    expect(sampleRows(5)).toEqual([0, 1, 2, 3, 4])
  })
  it('takes the head plus rows spread over the rest, in range and without repeats', () => {
    const s = sampleRows(100_000, 10, 20)
    expect(s.slice(0, 10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(s).toHaveLength(30)
    expect(new Set(s).size).toBe(30)
    expect(Math.max(...s)).toBeLessThan(100_000)
    expect(Math.max(...s)).toBeGreaterThan(90_000) // reaches the end of the result
  })
  it('empty result', () => {
    expect(sampleRows(0)).toEqual([])
  })
})

describe('columnWidths', () => {
  const widths = [[10, 20, 300], [5, 900, 5]]
  it('uses the widest of header and sampled cells, within limits', () => {
    const w = columnWidths(2, [0, 1, 2], (ci) => [80, 30][ci], (r, ci) => widths[ci][r], { min: 48, max: 420 })
    expect(w).toEqual([300, 420])
  })
  it('never goes below the minimum', () => {
    expect(columnWidths(1, [0], () => 10, () => 12, { min: 48, max: 420 })).toEqual([48])
  })
  it('depends only on the rows it is given, not on which are on screen', () => {
    const cell = (r: number) => (r === 7 ? 250 : 60)
    expect(columnWidths(1, sampleRows(10), () => 40, cell, { min: 48, max: 420 })).toEqual([250])
  })
  it('clips long text before measuring', () => {
    expect(clipForMeasure('x'.repeat(500), 120)).toHaveLength(120)
    expect(clipForMeasure('abc')).toBe('abc')
  })
})
