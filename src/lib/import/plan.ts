// Import planning — pure helpers (Phase 5 · T13). Batched INSERT generation,
// per-dialect conflict handling, JSON parsing, header synthesis. Kept dep-light
// (only quoteIdent) so it is fully unit-testable without a DB.

import { quoteIdent } from '$lib/sql/dialect'

export type ConflictMode = 'error' | 'skip'
export type ImportFormat = 'csv' | 'json'

/** Systems where "skip duplicate rows" is expressible in a single INSERT.
 *  ClickHouse (append-only, no unique constraint enforcement) and MSSQL
 *  (no single-statement IGNORE) return false → conflict opts are disabled. */
export function conflictSupported(system: string): boolean {
  return (
    system === 'postgres' ||
    system === 'mysql' ||
    system === 'mariadb' ||
    system === 'sqlite'
  )
}

/** INSERT prefix per dialect. MySQL/MariaDB use `INSERT IGNORE`, SQLite
 *  `INSERT OR IGNORE` (prefix form); Postgres expresses skip as a trailing
 *  clause instead (see conflictSuffix), so its prefix stays plain. */
export function insertPrefix(system: string, mode: ConflictMode): string {
  if (mode === 'skip') {
    if (system === 'mysql' || system === 'mariadb') return 'INSERT IGNORE INTO'
    if (system === 'sqlite') return 'INSERT OR IGNORE INTO'
  }
  return 'INSERT INTO'
}

/** Trailing conflict clause — only Postgres uses `ON CONFLICT DO NOTHING`. */
export function conflictSuffix(system: string, mode: ConflictMode): string {
  return mode === 'skip' && system === 'postgres' ? ' ON CONFLICT DO NOTHING' : ''
}

/** SQL literal for an imported cell (raw string from CSV/JSON).
 *  null/'' → NULL, numeric → unquoted, else single-quoted with '' escaping. */
export function sqlLiteral(v: string | null): string {
  if (v == null || v === '') return 'NULL'
  if (/^-?\d+(\.\d+)?$/.test(v)) return v
  return `'${v.replace(/'/g, "''")}'`
}

export interface InsertPlan {
  system: string
  schema: string
  table: string
  /** db column names, already resolved from mapping (no skipped columns) */
  columns: string[]
  /** each row aligned positionally to `columns` */
  rows: (string | null)[][]
  mode: ConflictMode
}

/** Build one multi-row INSERT statement for a batch of rows. For systems that
 *  don't support conflict handling the mode is coerced to 'error' (plain INSERT). */
export function buildInsert(p: InsertPlan): string {
  const q = (n: string) => quoteIdent(p.system, n)
  const target =
    p.schema && p.system !== 'sqlite' ? `${q(p.schema)}.${q(p.table)}` : q(p.table)
  const cols = p.columns.map(q).join(', ')
  const eff: ConflictMode = conflictSupported(p.system) ? p.mode : 'error'
  const prefix = insertPrefix(p.system, eff)
  const suffix = conflictSuffix(p.system, eff)
  const values = p.rows.map((r) => `(${r.map(sqlLiteral).join(', ')})`).join(',\n  ')
  return `${prefix} ${target} (${cols}) VALUES\n  ${values}${suffix};`
}

/** Split an array into batches of `size` (size <= 0 → single batch). */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return arr.length ? [arr] : []
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Parse a JSON array-of-objects into headers (union of keys, first-seen order)
 *  + rows aligned to those headers. Nested objects/arrays are JSON-stringified. */
export function parseJson(text: string): { headers: string[]; rows: string[][] } {
  const data = JSON.parse(text)
  if (!Array.isArray(data)) throw new Error('JSON import needs an array of objects')
  const headers: string[] = []
  for (const obj of data) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) if (!headers.includes(k)) headers.push(k)
    }
  }
  const cell = (v: unknown): string =>
    v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const rows = data.map((obj) =>
    headers.map((h) => cell((obj as Record<string, unknown>)?.[h])),
  )
  return { headers, rows }
}
