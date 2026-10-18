import { describe, expect, it } from 'vitest'
import { erRoute, manyEnd, oneEnd, roundedPath, routePoints } from './edge-geometry'

describe('routePoints', () => {
  it('two facing tables: one vertical run, midway or on the given lane', () => {
    expect(routePoints(100, 50, 1, 300, 150, -1)).toEqual([
      [100, 50],
      [200, 50],
      [200, 150],
      [300, 150],
    ])
    expect(routePoints(100, 50, 1, 300, 150, -1, { centerX: 210 })[1]).toEqual([210, 50])
  })

  it('keeps the lane between the stubs so it never runs into a table', () => {
    // centerX outside [s+22, t-22] is clamped
    expect(routePoints(100, 50, 1, 300, 150, -1, { centerX: 90 })[1]).toEqual([122, 50])
  })

  it('same row → a straight line', () => {
    expect(routePoints(100, 50, 1, 300, 50, -1)).toEqual([
      [100, 50],
      [300, 50],
    ])
  })

  it('target behind the source: steps out, crosses half-way between the rows, steps back in', () => {
    const pts = routePoints(300, 40, 1, 100, 200, -1)
    expect(pts[0]).toEqual([300, 40])
    expect(pts[1]).toEqual([322, 40])
    expect(pts[2]).toEqual([322, 120])
    expect(pts[3]).toEqual([78, 120])
    expect(pts[pts.length - 1]).toEqual([100, 200])
  })
})

describe('roundedPath / erRoute', () => {
  it('rounds every corner with a quadratic and never uses curves elsewhere', () => {
    const d = roundedPath([
      [0, 0],
      [100, 0],
      [100, 100],
      [200, 100],
    ])
    expect(d.match(/Q/g)).toHaveLength(2)
    expect(d).not.toMatch(/C/)
    expect(d.startsWith('M 0 0')).toBe(true)
    expect(d.endsWith('L 200 100')).toBe(true)
  })

  it('a corner radius never exceeds half of a short segment', () => {
    // 6px segment → radius 3
    expect(roundedPath([[0, 0], [50, 0], [50, 6], [100, 6]], 10)).toContain('L 47 0 Q 50 0 50 3')
  })

  it('puts the label on the middle segment', () => {
    const r = erRoute(100, 50, 1, 300, 150, -1)
    expect([r.labelX, r.labelY]).toEqual([200, 100])
  })
})

describe('cardinality ends', () => {
  it('MANY = three prongs meeting the table + a bar; ONE = two bars, both on the outer side', () => {
    expect(manyEnd(100, 50, 1).match(/M /g)).toHaveLength(4)
    expect(manyEnd(100, 50, 1)).toContain('M 115 45 L 115 55')
    expect(manyEnd(100, 50, -1)).toContain('M 85 45 L 85 55')
    expect(oneEnd(300, 150, -1)).toBe('M 293 145 L 293 155 M 288 145 L 288 155')
  })
})
