// Export SELECT builder (Phase 5 · T14) — pure, dialect-aware. Column subset +
// WHERE + LIMIT/OFFSET so the Export wizard can stream a filtered projection of a
// table. Kept dep-light (quoteIdent/qualified) for full unit-testing without a DB.

import { qualified, quoteIdent } from '$lib/sql/dialect'

export interface ExportSelect {
  system: string
  schema: string
  table: string
  /** subset to project; empty/undefined → all columns (*) */
  columns?: string[]
  /** raw WHERE body (without the WHERE keyword); blank → no filter */
  where?: string
  /** row cap; null/<=0 → unbounded */
  limit?: number | null
  /** page offset for streaming; requires supportsOffset(system) */
  offset?: number | null
}

/** Systems that accept `LIMIT n OFFSET k` for paged export streaming.
 *  MSSQL needs ORDER BY for OFFSET/FETCH and Cassandra has no OFFSET → false
 *  (those export in a single query). */
export function supportsOffset(system: string): boolean {
  return (
    system === 'postgres' ||
    system === 'mysql' ||
    system === 'mariadb' ||
    system === 'sqlite' ||
    system === 'clickhouse'
  )
}

function target(system: string, schema: string, table: string): string {
  return system === 'sqlite' && schema === 'main'
    ? quoteIdent(system, table)
    : qualified(system, schema, table)
}

export function buildExportSelect(o: ExportSelect): string {
  const colList =
    o.columns && o.columns.length
      ? o.columns.map((c) => quoteIdent(o.system, c)).join(', ')
      : '*'
  const tgt = target(o.system, o.schema, o.table)
  const where = o.where?.trim()
  const hasLimit = o.limit != null && o.limit > 0
  const hasOffset = o.offset != null && o.offset > 0

  // MSSQL without offset → TOP n (LIMIT/OFFSET requires ORDER BY there)
  if (o.system === 'mssql' && hasLimit && !hasOffset) {
    let sql = `SELECT TOP ${o.limit} ${colList} FROM ${tgt}`
    if (where) sql += ` WHERE ${where}`
    return sql
  }

  // Oracle has no LIMIT → FETCH FIRST n ROWS ONLY (12c+); never appends LIMIT/OFFSET.
  if (o.system === 'oracle') {
    let sql = `SELECT ${colList} FROM ${tgt}`
    if (where) sql += ` WHERE ${where}`
    if (hasLimit) sql += ` FETCH FIRST ${o.limit} ROWS ONLY`
    return sql
  }

  let sql = `SELECT ${colList} FROM ${tgt}`
  if (where) sql += ` WHERE ${where}`
  if (hasLimit) sql += ` LIMIT ${o.limit}`
  if (hasOffset) sql += ` OFFSET ${o.offset}`
  return sql
}
