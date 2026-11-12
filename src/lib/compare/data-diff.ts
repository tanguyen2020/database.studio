// Data Compare — row-level diff of two tables (same or different connection).
// Pure: the view fetches rows from both sides, builds KeyedRow[] here, classifies
// into onlySrc / onlyTgt / different / same, then emits INSERT/UPDATE/DELETE to
// make the target match the source. v1 compares values in JS (correct across
// engines); a SQL-side md5 push-down for very large tables is a follow-up.

import { quoteIdent } from '$lib/sql/dialect'
import { sqlLiteral } from '$lib/export/rows'

/** Qualified table name, but a blank schema (or SQLite) yields the bare table —
 *  mirrors import/plan.ts::buildInsert so sync SQL targets the same place. */
function targetName(system: string, schema: string, table: string): string {
  const q = (n: string) => quoteIdent(system, n)
  return schema && system !== 'sqlite' ? `${q(schema)}.${q(table)}` : q(table)
}

export type Cell = unknown
export type Row = Record<string, Cell>

export interface KeyedRow {
  /** canonical join of the key-column values (identity) */
  key: string
  /** raw key values, aligned to keyCols */
  keyVals: Cell[]
  /** canonical join of the compared-column values (equality signature) */
  cmp: string
  /** full row (key + compared columns) — needed for the diff view and sync SQL */
  row: Row
}

export interface CellDiff {
  col: string
  src: Cell
  tgt: Cell
}
export interface DiffPair {
  key: string
  keyVals: Cell[]
  src: Row
  tgt: Row
  /** only the compared columns whose value differs */
  cells: CellDiff[]
}
export interface DataDiff {
  onlySrc: KeyedRow[]
  onlyTgt: KeyedRow[]
  different: DiffPair[]
  same: number
}

const SEP = '\u001f' // unit separator — not expected inside values

/** Stable, NULL-distinct string for one value. Objects are JSON-encoded so
 *  structurally-equal json/arrays hash equal regardless of key spacing. */
export function canon(v: Cell): string {
  if (v == null) return '\u0000NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `\u0000${String(v)}`
  if (typeof v === 'boolean') return v ? '\u0000true' : '\u0000false'
  if (typeof v === 'object') {
    try {
      return 'j' + JSON.stringify(v)
    } catch {
      return 's' + String(v)
    }
  }
  return 's' + String(v)
}

/** Canonical identity string for a list of values (key or compared columns). */
export function keyOf(vals: Cell[]): string {
  return vals.map(canon).join(SEP)
}

/** Build KeyedRow[] from result rows. `cmpCols` are the columns whose values are
 *  compared for equality; key identity comes from `keyCols`. */
export function makeKeyed(rows: Row[], keyCols: string[], cmpCols: string[]): KeyedRow[] {
  return rows.map((row) => {
    const keyVals = keyCols.map((c) => row[c])
    const cmpVals = cmpCols.map((c) => row[c])
    return { key: keyOf(keyVals), keyVals, cmp: keyOf(cmpVals), row }
  })
}

/** Keys that appear more than once — identity is then ambiguous; the view warns. */
export function duplicateKeys(rows: KeyedRow[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.key)) dup.add(r.key)
    else seen.add(r.key)
  }
  return [...dup]
}

/** Merge two keyed lists (sorted here by key) → the four buckets. On a matched
 *  key the rows differ when their compared-column signatures differ. */
export function classifyRows(src: KeyedRow[], tgt: KeyedRow[], cmpCols: string[]): DataDiff {
  const s = [...src].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const t = [...tgt].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const out: DataDiff = { onlySrc: [], onlyTgt: [], different: [], same: 0 }
  let i = 0
  let j = 0
  while (i < s.length && j < t.length) {
    const a = s[i]
    const b = t[j]
    if (a.key === b.key) {
      if (a.cmp === b.cmp) {
        out.same++
      } else {
        const cells: CellDiff[] = []
        for (const col of cmpCols) {
          if (canon(a.row[col]) !== canon(b.row[col])) cells.push({ col, src: a.row[col], tgt: b.row[col] })
        }
        out.different.push({ key: a.key, keyVals: a.keyVals, src: a.row, tgt: b.row, cells })
      }
      i++
      j++
    } else if (a.key < b.key) {
      out.onlySrc.push(a)
      i++
    } else {
      out.onlyTgt.push(b)
      j++
    }
  }
  while (i < s.length) out.onlySrc.push(s[i++])
  while (j < t.length) out.onlyTgt.push(t[j++])
  return out
}

/** SELECT the key + compared columns, ordered by key, for one side. */
export function keyedSelect(
  system: string,
  schema: string,
  table: string,
  keyCols: string[],
  cmpCols: string[],
  where?: string,
): string {
  const q = (n: string) => quoteIdent(system, n)
  const cols = [...keyCols, ...cmpCols.filter((c) => !keyCols.includes(c))]
  const list = cols.map(q).join(', ')
  const target = targetName(system, schema, table)
  const w = where && where.trim() ? ` WHERE ${where.trim()}` : ''
  const order = keyCols.map(q).join(', ')
  return `SELECT ${list} FROM ${target}${w} ORDER BY ${order}`
}

export interface SyncOpts {
  system: string
  schema: string
  table: string
  keyCols: string[]
  cmpCols: string[]
}
export interface SyncInclude {
  insert: boolean
  update: boolean
  del: boolean
}

function whereByKey(q: (n: string) => string, keyCols: string[], keyVals: Cell[]): string {
  return keyCols
    .map((c, k) => {
      const v = keyVals[k]
      return v == null ? `${q(c)} IS NULL` : `${q(c)} = ${sqlLiteral(v)}`
    })
    .join(' AND ')
}

/** Statements that make the target match the source: INSERT the source-only rows,
 *  UPDATE the different rows, DELETE the target-only rows. One statement per row
 *  (not batched) so each line is readable and reviewable. */
export function buildDataSync(diff: DataDiff, opts: SyncOpts, include: SyncInclude): string {
  const q = (n: string) => quoteIdent(opts.system, n)
  const target = targetName(opts.system, opts.schema, opts.table)
  const allCols = [...opts.keyCols, ...opts.cmpCols.filter((c) => !opts.keyCols.includes(c))]
  const lines: string[] = []

  if (include.insert && diff.onlySrc.length) {
    lines.push('-- Rows only in source → INSERT')
    const colList = allCols.map(q).join(', ')
    for (const r of diff.onlySrc) {
      const vals = allCols.map((c) => sqlLiteral(r.row[c])).join(', ')
      lines.push(`INSERT INTO ${target} (${colList}) VALUES (${vals});`)
    }
    lines.push('')
  }

  if (include.update && diff.different.length) {
    lines.push('-- Rows that differ → UPDATE')
    for (const p of diff.different) {
      const set = opts.cmpCols
        .filter((c) => !opts.keyCols.includes(c))
        .map((c) => `${q(c)} = ${sqlLiteral(p.src[c])}`)
        .join(', ')
      if (!set) continue
      lines.push(`UPDATE ${target} SET ${set} WHERE ${whereByKey(q, opts.keyCols, p.keyVals)};`)
    }
    lines.push('')
  }

  if (include.del && diff.onlyTgt.length) {
    lines.push('-- Rows only in target → DELETE')
    for (const r of diff.onlyTgt) {
      lines.push(`DELETE FROM ${target} WHERE ${whereByKey(q, opts.keyCols, r.keyVals)};`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}
