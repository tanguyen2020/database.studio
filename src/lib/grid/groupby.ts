// Result-grid Group By (T27). Pure → unit-testable. Groups the in-memory result
// by 1+ columns, computes an aggregate per group, and yields a collapsible tree
// with subtotals + a grand total. The component renders the tree; server-side
// GROUP BY (for truncated results) reuses buildGroupSql().

export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max'

export interface GroupSpec {
  /** columns to group by, in order (outer → inner). */
  by: string[]
  fn: AggFn
  /** column the aggregate runs on (ignored for count). */
  col?: string
}

export interface GroupNode {
  /** key value at this level. */
  key: unknown
  /** joined key path from the root ("North / 2024"). */
  path: string
  depth: number
  /** rows in this group (recursive). */
  count: number
  /** aggregate over this group's rows, or null if not computable. */
  agg: number | null
  children: GroupNode[]
  /** leaf rows (only set at the deepest grouping level). */
  rows?: Record<string, unknown>[]
}

export interface GroupResult {
  groups: GroupNode[]
  grandCount: number
  grandAgg: number | null
}

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Aggregate a set of rows. `count` counts rows; the numeric aggregates ignore
 *  null / non-numeric cells and return null when no numeric value exists. */
export function computeAgg(rows: Record<string, unknown>[], fn: AggFn, col?: string): number | null {
  if (fn === 'count') return rows.length
  if (!col) return null
  const nums = rows.map((r) => toNum(r[col])).filter((n): n is number => n != null)
  if (nums.length === 0) return null
  switch (fn) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0)
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length
    case 'min':
      return Math.min(...nums)
    case 'max':
      return Math.max(...nums)
  }
}

function keyStr(v: unknown): string {
  return v == null ? '∅' : String(v)
}

function buildLevel(
  rows: Record<string, unknown>[],
  by: string[],
  depth: number,
  parentPath: string,
  spec: GroupSpec,
): GroupNode[] {
  const col = by[depth]
  // Stable insertion order by first appearance of each key.
  const order: unknown[] = []
  const buckets = new Map<string, { key: unknown; rows: Record<string, unknown>[] }>()
  for (const r of rows) {
    const k = r[col]
    const ks = keyStr(k)
    let b = buckets.get(ks)
    if (!b) {
      b = { key: k, rows: [] }
      buckets.set(ks, b)
      order.push(ks)
    }
    b.rows.push(r)
  }
  const isLeaf = depth === by.length - 1
  return order.map((ks) => {
    const b = buckets.get(ks as string)!
    const path = parentPath ? `${parentPath} / ${keyStr(b.key)}` : keyStr(b.key)
    return {
      key: b.key,
      path,
      depth,
      count: b.rows.length,
      agg: computeAgg(b.rows, spec.fn, spec.col),
      children: isLeaf ? [] : buildLevel(b.rows, by, depth + 1, path, spec),
      rows: isLeaf ? b.rows : undefined,
    }
  })
}

/** Group `rows` per `spec` into a tree with subtotals + grand total. */
export function buildGroups(rows: Record<string, unknown>[], spec: GroupSpec): GroupResult {
  const by = spec.by.filter((c) => c)
  if (by.length === 0) {
    return { groups: [], grandCount: rows.length, grandAgg: computeAgg(rows, spec.fn, spec.col) }
  }
  return {
    groups: buildLevel(rows, by, 0, '', spec),
    grandCount: rows.length,
    grandAgg: computeAgg(rows, spec.fn, spec.col),
  }
}

/** Server-side equivalent for truncated results: quote-safe GROUP BY over the
 *  original statement as a subquery. Dialect quoting kept simple (double quotes;
 *  MySQL/CH callers may pass backtick-quoted identifiers instead). */
export function buildGroupSql(sql: string, spec: GroupSpec, quote = (s: string) => `"${s}"`): string {
  const by = spec.by.filter((c) => c)
  const cols = by.map(quote).join(', ')
  const aggExpr =
    spec.fn === 'count' ? 'count(*)' : `${spec.fn}(${spec.col ? quote(spec.col) : '*'})`
  const inner = sql.trim().replace(/;\s*$/, '')
  return `SELECT ${cols}, ${aggExpr} AS ${quote(`${spec.fn}_agg`)}\nFROM (\n${inner}\n) AS _g\nGROUP BY ${cols}\nORDER BY ${cols}`
}
