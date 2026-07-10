// Index / FK Manager DDL (T29). Pure → unit-testable. Engine-aware CREATE/DROP
// INDEX + ADD/DROP FOREIGN KEY. Reuses genForeignKey (T15) for the ADD case.
import { quoteIdent } from './dialect'
import { genForeignKey } from './ddl'

function target(system: string, schema: string, table: string): string {
  const q = (n: string) => quoteIdent(system, n)
  return schema && system !== 'sqlite' ? `${q(schema)}.${q(table)}` : q(table)
}

export interface NewIndex {
  name: string
  columns: string[]
  unique: boolean
  /** access method (PG/MySQL: btree/hash/gin…); ignored where unsupported. */
  method?: string
}

/** CREATE [UNIQUE] INDEX … ON table (cols) [USING method]. */
export function genCreateIndex(system: string, schema: string, table: string, ix: NewIndex): string {
  const q = (n: string) => quoteIdent(system, n)
  const cols = ix.columns.map(q).join(', ')
  const uniq = ix.unique ? 'UNIQUE ' : ''
  // PG: USING <method> before column list; MySQL: USING after; others: omit.
  const usingPg = system === 'postgres' && ix.method ? ` USING ${ix.method}` : ''
  const usingMy = (system === 'mysql' || system === 'mariadb') && ix.method ? ` USING ${ix.method.toUpperCase()}` : ''
  return `CREATE ${uniq}INDEX ${q(ix.name)} ON ${target(system, schema, table)}${usingPg} (${cols})${usingMy};`
}

/** DROP INDEX — dialect-aware: MySQL/MariaDB/MSSQL need the table; PG/SQLite don't. */
export function genDropIndex(system: string, schema: string, table: string, name: string): string {
  const q = (n: string) => quoteIdent(system, n)
  switch (system) {
    case 'mysql':
    case 'mariadb':
      return `DROP INDEX ${q(name)} ON ${target(system, schema, table)};`
    case 'mssql':
      return `DROP INDEX ${q(name)} ON ${target(system, schema, table)};`
    case 'sqlite':
      return `DROP INDEX IF EXISTS ${q(name)};`
    default: // postgres — index lives in the schema, not tied to the table in DROP
      return `DROP INDEX IF EXISTS ${schema ? `${q(schema)}.${q(name)}` : q(name)};`
  }
}

/** ALTER INDEX — a re-runnable/template statement per dialect (rename is the
 *  portable op; rebuild/recreate shown as a comment where relevant). Opened in the
 *  SQL editor to review/edit before running. */
export function genAlterIndex(system: string, schema: string, table: string, name: string): string {
  const q = (n: string) => quoteIdent(system, n)
  const t = target(system, schema, table)
  const nn = `${name}_new`
  switch (system) {
    case 'postgres': {
      const idx = schema ? `${q(schema)}.${q(name)}` : q(name)
      return `ALTER INDEX ${idx} RENAME TO ${q(nn)};\n-- or rebuild:  REINDEX INDEX ${idx};`
    }
    case 'mysql':
    case 'mariadb':
      return `ALTER TABLE ${t} RENAME INDEX ${q(name)} TO ${q(nn)};`
    case 'mssql':
      return `EXEC sp_rename '${schema}.${table}.${name}', '${nn}', 'INDEX';\n-- or rebuild:  ALTER INDEX ${q(name)} ON ${t} REBUILD;`
    case 'sqlite':
      return `-- SQLite has no ALTER INDEX — drop and recreate:\nDROP INDEX IF EXISTS ${q(name)};\n-- CREATE INDEX ${q(name)} ON ${q(table)} (...);`
    default: // clickhouse — data-skipping index
      return `-- ClickHouse data-skipping index — drop & re-add via ALTER TABLE:\nALTER TABLE ${t} DROP INDEX ${q(name)};\n-- ALTER TABLE ${t} ADD INDEX ${q(name)} <expr> TYPE <type> GRANULARITY <n>;`
  }
}

export interface NewForeignKey {
  name: string
  from_table: string
  from_column: string
  to_table: string
  to_column: string
}

/** ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY (reuses genForeignKey). */
export function genAddForeignKey(system: string, schema: string, fk: NewForeignKey): string {
  return genForeignKey(system, schema, fk)
}

/** ALTER TABLE … DROP CONSTRAINT/FOREIGN KEY … — dialect-aware. */
export function genDropForeignKey(system: string, schema: string, table: string, name: string): string {
  const q = (n: string) => quoteIdent(system, n)
  const t = target(system, schema, table)
  if (system === 'mysql' || system === 'mariadb') {
    return `ALTER TABLE ${t} DROP FOREIGN KEY ${q(name)};`
  }
  return `ALTER TABLE ${t} DROP CONSTRAINT ${q(name)};`
}
