import { describe, expect, it } from 'vitest'
import { addTable, flowPosition, removeTable, visibleTables } from './diagram'

const ALL = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]

describe('visibleTables', () => {
  it('undefined → all tables', () => {
    expect(visibleTables(ALL, undefined)).toHaveLength(3)
  })
  it('subset → only listed tables, in source order', () => {
    expect(visibleTables(ALL, ['c', 'a']).map((t) => t.name)).toEqual(['a', 'c'])
  })
  it('empty array → nothing (blank canvas)', () => {
    expect(visibleTables(ALL, [])).toEqual([])
  })
})

describe('addTable', () => {
  it('all mode stays all (no-op)', () => {
    expect(addTable(undefined, 'a')).toBeUndefined()
  })
  it('subset unions the name once', () => {
    expect(addTable(['a'], 'b')).toEqual(['a', 'b'])
    expect(addTable(['a', 'b'], 'b')).toEqual(['a', 'b'])
  })
})

describe('removeTable', () => {
  it('all mode materializes to all-except', () => {
    expect(removeTable(undefined, ['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
  it('subset drops the name', () => {
    expect(removeTable(['a', 'b'], ['a', 'b', 'c'], 'a')).toEqual(['b'])
  })
})

describe('flowPosition', () => {
  it('subtracts pane origin + pan, divides by zoom', () => {
    const p = flowPosition(300, 200, { left: 100, top: 50 }, { x: 20, y: 10, zoom: 2 })
    // (300-100-20)/2 = 90 ; (200-50-10)/2 = 70
    expect(p).toEqual({ x: 90, y: 70 })
  })
  it('zoom 0 guarded to 1', () => {
    expect(flowPosition(110, 60, { left: 100, top: 50 }, { x: 0, y: 0, zoom: 0 })).toEqual({ x: 10, y: 10 })
  })
})
