import { describe, expect, it } from 'vitest'
import type { PlanNode, QueryPlan } from '$lib/ipc'
import {
  compactNumber,
  costliestStep,
  describeStep,
  estimateOff,
  executionOrder,
  formatMs,
  humanize,
  planVerdict,
  rowsLabel,
  stepDetails,
  stepTarget,
  translateWarning,
} from './explain'

const node = (operation: string, over: Partial<PlanNode> = {}): PlanNode => ({
  operation,
  native_op: over.native_op ?? operation,
  extra: {},
  children: [],
  is_hotspot: false,
  ...over,
})

const plan = (over: Partial<QueryPlan> = {}): QueryPlan => ({
  system: 'postgres',
  mode: 'estimated',
  summary: { warnings: [] },
  raw: '',
  ...over,
})

describe('describeStep', () => {
  it('names the planner operations in plain words, with the table and index', () => {
    const scan = describeStep(node('SeqScan', { extra: { 'Relation Name': 'orders' } }))
    expect(scan).toMatchObject({ label: 'Full table scan', kind: 'scan', table: 'orders' })
    expect(scan.description).toContain('every row of orders')

    const seek = describeStep(node('IndexSeek', { extra: { 'Index Name': 'ix_a', 'Relation Name': 't' } }))
    expect(seek).toMatchObject({ label: 'Index lookup', kind: 'index', index: 'ix_a' })
    expect(seek.description).toContain('using index ix_a')

    expect(describeStep(node('HashJoin')).label).toBe('Hash join')
    expect(describeStep(node('NestedLoop')).kind).toBe('join')
    expect(describeStep(node('Aggregate')).label).toBe('Group & aggregate')
    expect(describeStep(node('Sort', { extra: { 'Sort Key': '["created_at DESC"]' } })).description).toBe('Orders the rows by created_at DESC.')
  })

  it('reads table/index from whichever key the engine used', () => {
    expect(stepTarget(node('X', { extra: { relation: 'events' } })).table).toBe('events')
    expect(stepTarget(node('X', { extra: { Table: 'ev' } })).table).toBe('ev')
    expect(stepTarget(node('X', { extra: { indexName: 'a_1' } })).index).toBe('a_1')
  })

  it('falls back to a readable form of the engine operation', () => {
    expect(describeStep(node('HASH_GROUP_BY')).label).toBe('Hash group by')
    expect(describeStep(node('ReadFromMergeTree')).label).toBe('Read from merge tree')
    expect(describeStep(node('Compute Scalar')).label).toBe('Compute Scalar')
    expect(describeStep(node('TraceEvent', { native_op: 'Parsing CQL query' })).label).toBe('Parsing CQL query')
    expect(humanize('FETCH')).toBe('Fetch')
  })
})

describe('formatting', () => {
  it('compacts row counts and durations', () => {
    expect(compactNumber(214)).toBe('214')
    expect(compactNumber(48210)).toBe('48.2K')
    expect(compactNumber(50000)).toBe('50K')
    expect(compactNumber(1_250_000)).toBe('1.3M')
    expect(rowsLabel(1)).toBe('1 row')
    expect(rowsLabel(0)).toBe('0 rows')
    expect(rowsLabel(48210)).toBe('48.2K rows')
    expect(formatMs(0.04)).toBe('<0.1 ms')
    expect(formatMs(8.24)).toBe('8.2 ms')
    expect(formatMs(1240)).toBe('1.24 s')
    expect(formatMs(125_000)).toBe('2 min 5 s')
  })
})

describe('translateWarning', () => {
  it('turns every engine warning into a title, an explanation and a fix', () => {
    const cases: [string, RegExp][] = [
      ['Seq Scan on orders scans ~50000 rows to return 12 (missing index?)', /far more rows of orders/],
      ['Seq Scan on enrollments (~50000 rows)', /whole enrollments table/],
      ['Full scan on dbo.t (reads ~120000 rows)', /whole dbo\.t table/],
      ['Using filesort over ~90000 rows', /Sorts ~90K rows/],
      ['Using temporary table over ~5000 rows', /temporary table/],
      ['ClickHouse reads 120/128 granules of events (no effective pruning)', /most of events/],
      ['ClickHouse reads all of events (no index used)', /all of events/],
      ['ALLOW FILTERING: scans all partitions (no partition key) — expensive', /every partition/],
      ['Collection scan (COLLSCAN) — no index used; consider creating one.', /whole collection/],
      ['HashJoin: actual 9000 vs estimated 10 (off by >10x)', /estimate is far off/],
    ]
    for (const [w, title] of cases) {
      const i = translateWarning(w)
      expect(i.title, w).toMatch(title)
      expect(i.detail, w).not.toBe('')
      expect(i.fix, w).toBeTruthy()
      expect(i.source).toBe(w)
    }
  })

  it('keeps an unknown warning as-is instead of inventing advice', () => {
    expect(translateWarning('Something new')).toEqual({ source: 'Something new', title: 'Something new', detail: '' })
  })
})

describe('plan structure', () => {
  const scan = node('SeqScan', { cost_pct: 74.2 })
  const idx = node('IndexScan', { cost_pct: 1.6 })
  const root = node('HashJoin', { cost_pct: 24.2, children: [scan, idx] })

  it('numbers steps in the order they run (inputs first)', () => {
    const order = executionOrder(root)
    expect([order.get(scan), order.get(idx), order.get(root)]).toEqual([1, 2, 3])
  })

  it('finds the costliest step', () => {
    expect(costliestStep(root)).toBe(scan)
    expect(costliestStep(node('Limit'))).toBeUndefined()
  })

  it('flags estimates that are more than 10x off', () => {
    expect(estimateOff(node('X', { estimated_rows: 10, actual_rows: 9000 }))).toBe(true)
    expect(estimateOff(node('X', { estimated_rows: 1000, actual_rows: 900 }))).toBe(false)
    expect(estimateOff(node('X', { estimated_rows: 10 }))).toBe(false)
  })

  it('lists remaining details with readable labels, without the table/index', () => {
    const d = stepDetails(node('SeqScan', { native_op: 'Seq Scan', extra: { 'Relation Name': 't', Filter: '(a = 1)', has_index: false } }))
    expect(d).toEqual([
      { label: 'Filter', value: '(a = 1)' },
      { label: 'Uses an index', value: 'No' },
      { label: 'Engine operation', value: 'Seq Scan' },
    ])
  })
})

describe('planVerdict', () => {
  it('leads with the missing index when there is one', () => {
    const v = planVerdict(plan({ missing_index: { impact_pct: 92.5, table: 'e', ddl: 'x', reason: 'Filter on status.' }, summary: { warnings: ['a', 'b'] } }))
    expect(v).toEqual({ tone: 'attention', headline: 'An index could cut the cost by ~92.5%', subline: 'Filter on status. · 2 more issues below' })
  })

  it('otherwise leads with the first warning', () => {
    const v = planVerdict(plan({ summary: { warnings: ['Seq Scan on t (~50000 rows)'] } }))
    expect(v.tone).toBe('attention')
    expect(v.headline).toBe('Reads the whole t table')
  })

  it('reports a clean plan as good and names where the work goes', () => {
    const v = planVerdict(plan({ root: node('Limit', { cost_pct: 10, children: [node('IndexScan', { cost_pct: 90 })] }) }))
    expect(v.tone).toBe('good')
    expect(v.headline).toBe('No problems found')
    expect(v.subline).toContain('index scan (90% of the cost)')
  })

  it('labels a trace as information, not a verdict', () => {
    expect(planVerdict(plan({ mode: 'tracing' })).tone).toBe('info')
  })
})
