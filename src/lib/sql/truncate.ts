// TRUNCATE variants per engine. Only offer what a database can actually run — no
// ambiguous options — and emit the exact statement(s) for each. Pure → unit-testable.
import { quoteIdent, qualified } from './dialect'

export type TruncateVariant = 'plain' | 'cascade' | 'restart'

export interface TruncateOption {
  variant: TruncateVariant
  label: string
}

function target(system: string, schema: string, table: string): string {
  return system === 'sqlite' && schema === 'main' ? quoteIdent(system, table) : qualified(system, schema, table)
}

function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Variants a given engine actually supports:
 * - PostgreSQL: TRUNCATE + CASCADE + RESTART IDENTITY (all real keywords).
 * - SQLite: no TRUNCATE → DELETE; "restart" also clears sqlite_sequence. No CASCADE.
 * - MySQL/MariaDB/MSSQL: TRUNCATE only (AUTO_INCREMENT/IDENTITY reset automatically;
 *   CASCADE unsupported — a referenced table can't even be truncated).
 * - ClickHouse: TRUNCATE only.
 */
export function truncateOptions(system: string): TruncateOption[] {
  switch (system) {
    case 'postgres':
      return [
        { variant: 'plain', label: 'Truncate' },
        { variant: 'cascade', label: 'Truncate Cascade' },
        { variant: 'restart', label: 'Truncate Restart Identity' },
      ]
    case 'sqlite':
      return [
        { variant: 'plain', label: 'Truncate (delete all rows)' },
        { variant: 'restart', label: 'Truncate & Restart Identity' },
      ]
    default:
      return [{ variant: 'plain', label: 'Truncate' }]
  }
}

/** The exact statement(s) to run for a variant. An array because SQLite's restart
 *  needs two statements (DELETE + clear the AUTOINCREMENT counter). */
export function genTruncateStatements(
  system: string,
  schema: string,
  table: string,
  variant: TruncateVariant,
): string[] {
  const t = target(system, schema, table)

  if (system === 'sqlite') {
    const stmts = [`DELETE FROM ${t};`]
    if (variant === 'restart') {
      // AUTOINCREMENT counters live in sqlite_sequence; removing the row restarts it.
      stmts.push(`DELETE FROM sqlite_sequence WHERE name = ${sqlStr(table)};`)
    }
    return stmts
  }

  if (system === 'postgres') {
    const parts = ['TRUNCATE TABLE', t]
    if (variant === 'restart') parts.push('RESTART IDENTITY')
    if (variant === 'cascade') parts.push('CASCADE')
    return [parts.join(' ') + ';']
  }

  if (system === 'cassandra') {
    // CQL: TRUNCATE [keyspace.]table — no CASCADE / RESTART IDENTITY.
    return [`TRUNCATE ${schema}.${table};`]
  }

  // mysql / mariadb / mssql / clickhouse — only plain TRUNCATE is valid.
  return [`TRUNCATE TABLE ${t};`]
}
