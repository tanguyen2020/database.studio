// Plain-language reading of a normalized query plan (drivers/plan.rs → QueryPlan).
//
// The backend already normalizes every engine's EXPLAIN into one PlanNode tree, but
// it speaks planner jargon: `SeqScan`, `HashJoin`, "Seq Scan on x (~50000 rows)".
// This module turns that into what a person needs to decide something: what each
// step does, which step costs the most, what is wrong and how to fix it. It is pure
// (no Svelte, no IPC) so every rule is unit-tested and the UI only lays it out.

import type { PlanNode, QueryPlan } from '$lib/ipc'

export type StepKind = 'scan' | 'index' | 'join' | 'sort' | 'aggregate' | 'limit' | 'trace' | 'other'

export interface StepInfo {
  /** Human label, e.g. "Full table scan". */
  label: string
  kind: StepKind
  /** One sentence: what this step does, naming the table/index when known. */
  description: string
  table?: string
  index?: string
}

export type Tone = 'good' | 'attention' | 'info'

export interface Insight {
  title: string
  /** What happens, in plain words. */
  detail: string
  /** What to do about it — absent when there is no generic advice. */
  fix?: string
  /** The engine's own message, kept verbatim for the people who want it. */
  source: string
}

export interface Verdict {
  tone: Tone
  headline: string
  subline: string
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined

const TABLE_KEYS = ['Relation Name', 'relation', 'Table', 'table', 'Object']
const INDEX_KEYS = ['Index Name', 'indexName', 'index', 'Index']

/** Table / index the step works on, read from whichever key the engine used. */
export function stepTarget(node: PlanNode): { table?: string; index?: string } {
  const pick = (keys: string[]) => keys.map((k) => str(node.extra?.[k])).find(Boolean)
  return { table: pick(TABLE_KEYS), index: pick(INDEX_KEYS) }
}

/** "SeqScan" / "TABLE_SCAN" / "ReadFromMergeTree" → "Seq scan" / "Table scan" / "Read from merge tree". */
export function humanize(s: string): string {
  const spaced = s
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  if (!spaced) return s
  // An engine phrase that is already readable ("Compute Scalar", "Parsing CQL query")
  // keeps its acronyms; identifiers (SeqScan, HASH_GROUP_BY) are sentence-cased.
  if (/\s/.test(s.trim()) && s !== s.toUpperCase()) return s.trim()
  const lower = spaced.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

const on = (table?: string) => (table ? ` of ${table}` : '')

/** What a step is, for a reader who does not know planner vocabulary. */
export function describeStep(node: PlanNode): StepInfo {
  const { table, index } = stepTarget(node)
  const via = index ? ` using index ${index}` : ''
  const base = { table, index }
  switch (node.operation) {
    case 'SeqScan':
      return { ...base, kind: 'scan', label: 'Full table scan', description: `Reads every row${on(table)} to find the matches.` }
    case 'IndexScan':
      return { ...base, kind: 'index', label: 'Index scan', description: `Finds matching rows${on(table)}${via}.` }
    case 'IndexSeek':
      return { ...base, kind: 'index', label: 'Index lookup', description: `Jumps straight to the matching rows${on(table)}${via}.` }
    case 'IndexOnlyScan':
      return { ...base, kind: 'index', label: 'Index-only scan', description: `Answers from the index${index ? ` ${index}` : ''} alone, without reading the table.` }
    case 'BitmapScan':
      return { ...base, kind: 'index', label: 'Bitmap index scan', description: `Collects the locations of matching rows${via}, then reads them in one pass.` }
    case 'NestedLoop':
      return { ...base, kind: 'join', label: 'Nested loop join', description: 'For each row of the first input, looks up the matching rows in the second.' }
    case 'HashJoin':
      return { ...base, kind: 'join', label: 'Hash join', description: 'Loads one input into an in-memory hash table, then matches the other input against it.' }
    case 'MergeJoin':
      return { ...base, kind: 'join', label: 'Merge join', description: 'Joins two inputs that are already sorted on the join key.' }
    case 'Hash':
      return { ...base, kind: 'join', label: 'Build hash table', description: 'Loads these rows into memory for the hash join above.' }
    case 'Sort': {
      const key = str(node.extra?.['Sort Key'])
      return { ...base, kind: 'sort', label: 'Sort', description: key ? `Orders the rows by ${key.replace(/^\[|\]$/g, '').replace(/"/g, '')}.` : 'Orders the rows.' }
    }
    case 'Aggregate':
      return { ...base, kind: 'aggregate', label: 'Group & aggregate', description: 'Groups rows and computes totals (GROUP BY, COUNT, SUM…).' }
    case 'Limit':
      return { ...base, kind: 'limit', label: 'Limit', description: 'Stops once the requested number of rows is reached.' }
    case 'Materialize':
      return { ...base, kind: 'other', label: 'Keep in memory', description: 'Holds intermediate rows in memory so they can be reused.' }
    case 'Gather':
      return { ...base, kind: 'other', label: 'Combine parallel workers', description: 'Merges the results of workers that ran in parallel.' }
    case 'TraceEvent':
      return { ...base, kind: 'trace', label: node.native_op || 'Trace event', description: str(node.extra?.source) ? `Recorded on node ${str(node.extra?.source)}.` : 'Recorded during execution.' }
    case 'CqlRead':
      return { ...base, kind: 'scan', label: 'Read', description: `Reads the requested partition${on(table)}.` }
  }
  const native = node.native_op || node.operation
  return {
    ...base,
    kind: 'other',
    label: humanize(native),
    description: table ? `Works on ${table}.` : 'A step of the query plan.',
  }
}

/** 50000 → "50K", 1250000 → "1.3M", 214 → "214". */
export function compactNumber(n: number): string {
  const a = Math.abs(n)
  const fmt = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}${unit}`
  if (a >= 1e9) return fmt(n / 1e9, 'B')
  if (a >= 1e6) return fmt(n / 1e6, 'M')
  if (a >= 1e3) return fmt(n / 1e3, 'K')
  return String(Math.round(n))
}

/** 1 → "1 row", 48210 → "48.2K rows". */
export function rowsLabel(rows: number): string {
  const c = compactNumber(rows)
  return `${c} ${c === '1' ? 'row' : 'rows'}`
}

/** 0.04 → "<0.1 ms", 8.24 → "8.2 ms", 1240 → "1.24 s". */
export function formatMs(ms: number): string {
  if (ms < 0.1) return '<0.1 ms'
  if (ms < 1000) return `${Number(ms.toFixed(1))} ms`
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(2))} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

const n = (s: string) => compactNumber(Number(s))

const STATS_FIX = 'Refresh the table statistics (ANALYZE / UPDATE STATISTICS) so the planner estimates correctly.'
const INDEX_FIX = 'Add an index on the columns used in WHERE or JOIN, or filter on a column that is already indexed.'

/** Engine warning (drivers/plan.rs wording) → title / plain explanation / fix. */
export function translateWarning(w: string): Insight {
  let m: RegExpMatchArray | null
  if ((m = w.match(/^Seq Scan on (\S+) scans ~(\d+) rows to return (\d+)/i))) {
    return { source: w, title: `Reads far more rows of ${m[1]} than it returns`, detail: `Scans ~${n(m[2])} rows to return only ${n(m[3])}. Most of the work is thrown away.`, fix: INDEX_FIX }
  }
  if ((m = w.match(/^(?:Seq Scan|Full scan) on (\S+) \((?:reads )?~(\d+) rows\)/i))) {
    return { source: w, title: `Reads the whole ${m[1]} table`, detail: `Every row (~${n(m[2])}) is read. This gets slower as the table grows.`, fix: INDEX_FIX }
  }
  if ((m = w.match(/^Full scan: (.+)$/i))) {
    return { source: w, title: 'Reads a whole table', detail: `No index is used: ${m[1]}.`, fix: INDEX_FIX }
  }
  if ((m = w.match(/Using filesort over ~(\d+) rows/i))) {
    return { source: w, title: `Sorts ~${n(m[1])} rows without an index`, detail: 'The database sorts the rows itself instead of reading them already in order.', fix: 'An index on the ORDER BY columns (in the same order) removes this sort.' }
  }
  if ((m = w.match(/Using temporary table over ~(\d+) rows/i))) {
    return { source: w, title: `Builds a temporary table (~${n(m[1])} rows)`, detail: 'Intermediate rows are copied into a temporary table, usually for GROUP BY or DISTINCT.', fix: 'Index the GROUP BY / DISTINCT columns, or reduce the rows before grouping.' }
  }
  if ((m = w.match(/ClickHouse reads (\d+)\/(\d+) granules of (\S+)/i))) {
    return { source: w, title: `Reads most of ${m[3]}`, detail: `${n(m[1])} of ${n(m[2])} data blocks are read — the filter barely narrows the data.`, fix: "Filter on the table's ORDER BY (primary key) columns so ClickHouse can skip blocks." }
  }
  if ((m = w.match(/ClickHouse reads all of (\S+)/i))) {
    return { source: w, title: `Reads all of ${m[1]}`, detail: 'No index helps this filter, so every block is read.', fix: "Filter on the table's ORDER BY (primary key) columns, or add a data-skipping index." }
  }
  if (/ALLOW FILTERING/i.test(w)) {
    return { source: w, title: 'Scans every partition', detail: 'ALLOW FILTERING without the partition key makes Cassandra read the whole table across the cluster.', fix: 'Include the partition key in WHERE, or create a table / materialized view keyed for this query.' }
  }
  if (/COLLSCAN/i.test(w)) {
    return { source: w, title: 'Reads the whole collection', detail: 'No index matches this filter, so every document is examined.', fix: 'Create an index on the fields used in the filter and sort.' }
  }
  if ((m = w.match(/^(\w+): actual (\d+) vs estimated (\d+)/i))) {
    const step = describeStep({ operation: m[1], native_op: m[1], extra: {}, children: [], is_hotspot: false }).label
    return { source: w, title: 'Row estimate is far off', detail: `${step} expected ~${n(m[3])} rows but got ${n(m[2])}. Wrong estimates lead the planner to choose slow plans.`, fix: STATS_FIX }
  }
  return { source: w, title: w, detail: '' }
}

function walk(node: PlanNode, visit: (n: PlanNode, depth: number) => void, depth = 0) {
  visit(node, depth)
  for (const c of node.children ?? []) walk(c, visit, depth + 1)
}

/** Every node of the tree, parent first. */
export function flatten(root: PlanNode | undefined): PlanNode[] {
  const out: PlanNode[] = []
  if (root) walk(root, (n) => out.push(n))
  return out
}

/** Execution order: a step runs after the steps that feed it (children first),
 *  so number the tree in post-order. Step 1 is the first thing the database does. */
export function executionOrder(root: PlanNode | undefined): Map<PlanNode, number> {
  const order = new Map<PlanNode, number>()
  const visit = (n: PlanNode) => {
    for (const c of n.children ?? []) visit(c)
    order.set(n, order.size + 1)
  }
  if (root) visit(root)
  return order
}

/** The step with the largest share of the cost (or time when there is no cost). */
export function costliestStep(root: PlanNode | undefined): PlanNode | undefined {
  let best: PlanNode | undefined
  let bestVal = -1
  for (const n of flatten(root)) {
    const v = n.cost_pct ?? -1
    if (v > bestVal) {
      best = n
      bestVal = v
    }
  }
  return bestVal > 0 ? best : undefined
}

/** Rows the query hands back (actual when measured, otherwise the estimate). */
export function rowsReturned(plan: QueryPlan): number | undefined {
  return plan.root?.actual_rows ?? plan.root?.estimated_rows
}

/** True when actual rows are more than 10× off the estimate (either way). */
export function estimateOff(node: PlanNode): boolean {
  const { estimated_rows: est, actual_rows: act } = node
  if (est == null || act == null || est <= 0) return false
  return act / est > 10 || est / Math.max(act, 1) > 10
}

/** One-line conclusion shown above the plan. */
export function planVerdict(plan: QueryPlan): Verdict {
  const warnings = plan.summary?.warnings ?? []
  const tracing = plan.mode === 'tracing'
  const more = (k: number) => (k > 0 ? ` · ${k} more ${k === 1 ? 'issue' : 'issues'} below` : '')
  if (plan.missing_index) {
    return {
      tone: 'attention',
      headline: `An index could cut the cost by ~${plan.missing_index.impact_pct}%`,
      subline: (plan.missing_index.reason || `A suggested index on ${plan.missing_index.table} would help this query.`) + more(warnings.length),
    }
  }
  if (warnings.length) {
    const first = translateWarning(warnings[0])
    return { tone: 'attention', headline: first.title, subline: (first.detail || 'See the details below.') + more(warnings.length - 1) }
  }
  if (tracing) {
    return { tone: 'info', headline: 'Execution trace', subline: 'This engine has no query planner — these are the real steps and timings recorded while the query ran.' }
  }
  const top = costliestStep(plan.root)
  const where = top && (top.cost_pct ?? 0) >= 50 ? ` Most of the work is the ${describeStep(top).label.toLowerCase()} (${top.cost_pct}% of the cost).` : ''
  return { tone: 'good', headline: 'No problems found', subline: `The database can run this query efficiently.${where}` }
}

const DETAIL_LABELS: Record<string, string> = {
  Filter: 'Filter',
  'Index Cond': 'Index condition',
  'Hash Cond': 'Join condition',
  'Merge Cond': 'Join condition',
  'Join Filter': 'Join filter',
  'Join Type': 'Join type',
  'Sort Key': 'Sort by',
  'Rows Removed by Filter': 'Rows discarded by the filter',
  'Actual Loops': 'Times executed',
  LogicalOp: 'Logical operation',
  EstimatedRowsRead: 'Rows read (estimated)',
  granules_read: 'Blocks read',
  granules_total: 'Blocks in table',
  parts_read: 'Parts read',
  parts_total: 'Parts in table',
  has_index: 'Uses an index',
  using_filesort: 'Sorts without an index',
  using_temporary_table: 'Uses a temporary table',
  docsExamined: 'Documents examined',
  keysExamined: 'Index keys examined',
  keyPattern: 'Index key',
  indexBounds: 'Index range',
  detail: 'Detail',
  index_analysis: 'Index analysis',
  activity: 'Activity',
  source: 'Node',
}

/** Remaining facts about a step, with readable labels. Table/index are shown
 *  separately (as chips) so they are left out here. */
export function stepDetails(node: PlanNode): { label: string; value: string }[] {
  const skip = new Set([...TABLE_KEYS, ...INDEX_KEYS])
  const out: { label: string; value: string }[] = []
  for (const [k, v] of Object.entries(node.extra ?? {})) {
    if (skip.has(k) || v == null || v === '') continue
    const value = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'object' ? JSON.stringify(v) : String(v)
    out.push({ label: DETAIL_LABELS[k] ?? humanize(k), value })
  }
  if (node.native_op && node.native_op !== describeStep(node).label) {
    out.push({ label: 'Engine operation', value: node.native_op })
  }
  return out
}
