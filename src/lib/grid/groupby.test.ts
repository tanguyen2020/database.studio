import { describe, expect, it } from 'vitest'
import { buildGroupSql, buildGroups, computeAgg } from './groupby'

const ROWS: Record<string, unknown>[] = [
  { region: 'North', year: 2024, amount: 10 },
  { region: 'North', year: 2024, amount: 20 },
  { region: 'North', year: 2025, amount: 5 },
  { region: 'South', year: 2024, amount: 100 },
  { region: 'South', year: 2025, amount: null },
]

describe('computeAgg', () => {
  it('count / sum / avg / min / max', () => {
    expect(computeAgg(ROWS, 'count')).toBe(5)
    expect(computeAgg(ROWS, 'sum', 'amount')).toBe(135)
    expect(computeAgg(ROWS, 'avg', 'amount')).toBeCloseTo(135 / 4) // null ignored
    expect(computeAgg(ROWS, 'min', 'amount')).toBe(5)
    expect(computeAgg(ROWS, 'max', 'amount')).toBe(100)
  })
  it('null when no numeric values', () => {
    expect(computeAgg([{ amount: null }, { amount: 'x' }], 'sum', 'amount')).toBeNull()
  })
})

describe('buildGroups', () => {
  it('single column: groups with subtotals + grand total', () => {
    const r = buildGroups(ROWS, { by: ['region'], fn: 'sum', col: 'amount' })
    expect(r.groups.map((g) => g.key)).toEqual(['North', 'South'])
    expect(r.groups[0]).toMatchObject({ count: 3, agg: 35 })
    expect(r.groups[1]).toMatchObject({ count: 2, agg: 100 })
    expect(r.grandCount).toBe(5)
    expect(r.grandAgg).toBe(135)
    // leaf groups carry their rows
    expect(r.groups[0].rows).toHaveLength(3)
  })

  it('multi column: nested groups, inner subtotals', () => {
    const r = buildGroups(ROWS, { by: ['region', 'year'], fn: 'count' })
    const north = r.groups[0]
    expect(north.key).toBe('North')
    expect(north.children.map((c) => c.key)).toEqual([2024, 2025])
    expect(north.children[0]).toMatchObject({ count: 2, agg: 2, path: 'North / 2024' })
    expect(north.children[0].rows).toHaveLength(2) // deepest level carries rows
    expect(north.rows).toBeUndefined() // non-leaf has no rows
  })

  it('count aggregate needs no column', () => {
    expect(buildGroups(ROWS, { by: ['region'], fn: 'count' }).groups[0].agg).toBe(3)
  })

  it('no group columns → just a grand total', () => {
    const r = buildGroups(ROWS, { by: [], fn: 'sum', col: 'amount' })
    expect(r.groups).toEqual([])
    expect(r.grandAgg).toBe(135)
  })

  it('preserves first-appearance order of keys', () => {
    const rows = [{ k: 'b' }, { k: 'a' }, { k: 'b' }]
    expect(buildGroups(rows, { by: ['k'], fn: 'count' }).groups.map((g) => g.key)).toEqual(['b', 'a'])
  })
})

describe('buildGroupSql', () => {
  it('wraps the statement as a subquery with GROUP BY', () => {
    const sql = buildGroupSql('SELECT * FROM sales', { by: ['region'], fn: 'sum', col: 'amount' })
    expect(sql).toContain('sum("amount") AS "sum_agg"')
    expect(sql).toContain('FROM (\nSELECT * FROM sales\n) AS _g')
    expect(sql).toContain('GROUP BY "region"')
  })
  it('count(*) needs no column; strips trailing semicolon', () => {
    const sql = buildGroupSql('SELECT * FROM t;', { by: ['a', 'b'], fn: 'count' })
    expect(sql).toContain('count(*) AS "count_agg"')
    expect(sql).toContain('GROUP BY "a", "b"')
    expect(sql).not.toContain(';\n) AS _g')
  })
})
