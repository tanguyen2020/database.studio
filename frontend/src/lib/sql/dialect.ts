// Dialect-aware identifier quoting + snippet generation.
// Quoting rules: PG/SQLite = "..." · MySQL/MariaDB/ClickHouse = `...` · MSSQL = [...]

import { systemMeta } from '$lib/systems'

export function quoteIdent(system: string, name: string): string {
  const style = systemMeta(system).quote
  switch (style) {
    case 'backtick':
      return '`' + name.replaceAll('`', '``') + '`'
    case 'bracket':
      return '[' + name.replaceAll(']', ']]') + ']'
    case 'double':
    default:
      return '"' + name.replaceAll('"', '""') + '"'
  }
}

export function qualified(system: string, schema: string, table: string): string {
  return `${quoteIdent(system, schema)}.${quoteIdent(system, table)}`
}

/** SELECT preview statement per dialect (MSSQL uses TOP, others LIMIT). */
export function selectStarSql(system: string, schema: string, table: string, limit = 100): string {
  const target =
    system === 'sqlite' && schema === 'main'
      ? quoteIdent(system, table)
      : qualified(system, schema, table)
  if (system === 'mssql') {
    return `SELECT TOP ${limit} * FROM ${target};`
  }
  return `SELECT * FROM ${target} LIMIT ${limit};`
}
