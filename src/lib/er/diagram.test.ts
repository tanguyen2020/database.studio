import { describe, expect, it } from 'vitest'
import { addTable, flowPosition, removeTable, visibleTables, relationshipFromConnection, type Rel } from './diagram'

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

describe('relationshipFromConnection (hand-drawn, Phase 3)', () => {
  const conn = (sh: string | null, th: string | null) => ({ source: 'orders', target: 'users', sourceHandle: sh, targetHandle: th })
  const existing: Rel[] = [{ from_table: 'orders', from_column: 'user_id', to_table: 'users', to_column: 'id' }]

  it('valid column→column connection → relationship', () => {
    expect(relationshipFromConnection(conn('customer_id', 'id'), [], [])).toEqual({
      from_table: 'orders',
      from_column: 'customer_id',
      to_table: 'users',
      to_column: 'id',
    })
  })
  it('missing column anchor (node-level drop) → null', () => {
    expect(relationshipFromConnection(conn(null, 'id'), [], [])).toBeNull()
    expect(relationshipFromConnection(conn('customer_id', null), [], [])).toBeNull()
  })
  it('duplicate of an existing schema FK → null', () => {
    expect(relationshipFromConnection(conn('user_id', 'id'), existing, [])).toBeNull()
  })
  it('duplicate of a pending relationship → null', () => {
    const pending: Rel[] = [{ from_table: 'orders', from_column: 'x', to_table: 'users', to_column: 'id' }]
    expect(relationshipFromConnection(conn('x', 'id'), [], pending)).toBeNull()
  })
  it('self-referencing table allowed when columns differ, rejected when identical', () => {
    const self = { source: 'employees', target: 'employees', sourceHandle: 'manager_id', targetHandle: 'id' }
    expect(relationshipFromConnection(self, [], [])).toEqual({
      from_table: 'employees',
      from_column: 'manager_id',
      to_table: 'employees',
      to_column: 'id',
    })
    expect(relationshipFromConnection({ ...self, targetHandle: 'manager_id' }, [], [])).toBeNull()
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
