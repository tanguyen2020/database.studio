// SQL generators cho context menu Explorer — port gen* (dòng 3271-3291).
// Sinh từ ColumnInfo thật của bảng, quoting theo dialect. ClickHouse:
// UPDATE/DELETE là ALTER TABLE … (mutation async — CLICKHOUSE_SPEC_ADDENDUM).
import { qualified as q, quoteIdent } from './dialect'
import { dataTypes } from './datatypes'
import { databaseOptionClause, type DatabaseOptions } from './database-options'
import type { ColumnInfo } from '$lib/types'

function target(system: string, schema: string, table: string): string {
  return system === 'sqlite' && schema === 'main'
    ? quoteIdent(system, table)
    : q(system, schema, table)
}

function sample(dataType: string): string {
  const t = dataType.toLowerCase()
  if (/int|serial|numeric|decimal|float|double|real|uint/.test(t)) return '0'
  if (/bool/.test(t)) return 'true'
  if (/date|time/.test(t)) return "'2026-01-01'"
  if (/uuid/.test(t)) return "'00000000-0000-0000-0000-000000000000'"
  return "''"
}

export function genSelect(system: string, schema: string, table: string, cols: ColumnInfo[]): string {
  const list = cols.map((c) => quoteIdent(system, c.name)).join(', ') || '*'
  const t = target(system, schema, table)
  if (system === 'mssql') return `SELECT TOP 100 ${list}\nFROM ${t};`
  // Oracle has no LIMIT/TOP → FETCH FIRST n ROWS ONLY (12c+).
  if (system === 'oracle') return `SELECT ${list}\nFROM ${t}\nFETCH FIRST 100 ROWS ONLY;`
  return `SELECT ${list}\nFROM ${t}\nLIMIT 100;`
}

export function genInsert(system: string, schema: string, table: string, cols: ColumnInfo[]): string {
  const insertable = cols.filter((c) => !c.is_pk)
  const names = insertable.map((c) => quoteIdent(system, c.name)).join(', ')
  const vals = insertable.map((c) => sample(c.data_type)).join(', ')
  return `INSERT INTO ${target(system, schema, table)} (${names})\nVALUES (${vals});`
}

export function genUpdate(system: string, schema: string, table: string, cols: ColumnInfo[]): string {
  const t = target(system, schema, table)
  const pk = cols.find((c) => c.is_pk) ?? cols[0]
  const setCols = cols.filter((c) => !c.is_pk)
  if (system === 'clickhouse') {
    const sets = setCols.map((c) => `${quoteIdent(system, c.name)} = ${sample(c.data_type)}`).join(',\n           ')
    return `ALTER TABLE ${t}\n    UPDATE ${sets}\nWHERE ${quoteIdent(system, pk.name)} = ${sample(pk.data_type)};`
  }
  const sets = setCols.map((c) => `${quoteIdent(system, c.name)} = ${sample(c.data_type)}`).join(',\n    ')
  return `UPDATE ${t}\nSET ${sets}\nWHERE ${quoteIdent(system, pk.name)} = ${sample(pk.data_type)};`
}

export function genDelete(system: string, schema: string, table: string, cols: ColumnInfo[]): string {
  const t = target(system, schema, table)
  const pk = cols.find((c) => c.is_pk) ?? cols[0]
  if (system === 'clickhouse') {
    return `ALTER TABLE ${t}\n    DELETE WHERE ${quoteIdent(system, pk.name)} = ${sample(pk.data_type)};`
  }
  return `DELETE FROM ${t}\nWHERE ${quoteIdent(system, pk.name)} = ${sample(pk.data_type)};`
}

export function genCreate(system: string, schema: string, table: string, cols: ColumnInfo[]): string {
  const body = cols
    .map((c) => {
      let line = `  ${quoteIdent(system, c.name)} ${c.data_type}`
      if (!c.nullable) line += ' NOT NULL'
      if (c.is_pk) line += ' PRIMARY KEY'
      return line
    })
    .join(',\n')
  return `CREATE TABLE ${target(system, schema, table)} (\n${body}\n);`
}

/** ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY — dialect-aware, schema-qualified.
 *  Emitted after all CREATE TABLEs by the Generate Scripts flow (T15). */
export function genForeignKey(
  system: string,
  schema: string,
  fk: { name: string; from_table: string; from_column: string; to_table: string; to_column: string },
): string {
  const from = target(system, schema, fk.from_table)
  const to = target(system, schema, fk.to_table)
  const con = quoteIdent(system, fk.name)
  return `ALTER TABLE ${from} ADD CONSTRAINT ${con} FOREIGN KEY (${quoteIdent(system, fk.from_column)}) REFERENCES ${to} (${quoteIdent(system, fk.to_column)});`
}

export function genRename(system: string, schema: string, table: string): string {
  const t = target(system, schema, table)
  return `ALTER TABLE ${t} RENAME TO ${quoteIdent(system, table + '_new')};`
}

/** ALTER TABLE skeleton (add a column) — per-dialect, ready to edit before running.
 *  MSSQL uses `ADD` (no COLUMN keyword); others use `ADD COLUMN`. */
export function genAlterTable(system: string, schema: string, table: string): string {
  const t = target(system, schema, table)
  // Oracle: ADD (col type) — parenthesized, no COLUMN keyword; type NUMBER.
  if (system === 'oracle') {
    return `ALTER TABLE ${t}\n  ADD (${quoteIdent(system, 'new_column')} NUMBER);`
  }
  const colType = system === 'postgres' ? 'integer' : 'INT'
  const addKw = system === 'mssql' ? 'ADD' : 'ADD COLUMN'
  return `ALTER TABLE ${t}\n  ${addKw} ${quoteIdent(system, 'new_column')} ${colType};`
}

/**
 * Rename a database/schema. Emits a ready-to-edit statement (new name defaults to
 * `<old>_new`). MySQL/MariaDB have no RENAME DATABASE and SQLite is a file — those
 * return an explanatory comment instead of DDL.
 */
export function genRenameDatabase(system: string, database: string): string {
  const from = quoteIdent(system, database)
  const to = quoteIdent(system, database + '_new')
  switch (system) {
    case 'postgres':
      // Must be run while not connected TO that database (connect to another first).
      return `ALTER DATABASE ${from} RENAME TO ${to};`
    case 'mssql':
      return `ALTER DATABASE ${from} MODIFY NAME = ${to};`
    case 'clickhouse':
      return `RENAME DATABASE ${from} TO ${to};`
    case 'oracle':
      // In Oracle a "database" ≈ a user/schema; there is no rename-user. Recreate.
      return `-- Oracle has no rename-user/schema. Create the new user, copy objects\n-- (e.g. Data Pump remap_schema), then DROP USER ${from} CASCADE.`
    case 'mysql':
    case 'mariadb':
      return `-- MySQL/MariaDB cannot rename a database directly.\n-- Create ${to}, move each table (RENAME TABLE ${from}.t TO ${to}.t), then DROP DATABASE ${from}.`
    case 'sqlite':
      return `-- SQLite databases are files — rename the .sqlite file on disk instead.`
    default:
      return `-- Renaming a database is not supported for ${system}.`
  }
}

/** CREATE a database (DataGrip-style "New Database"), per dialect. SQLite databases
 *  are files, so it returns a comment instead of DDL. */
export function genCreateDatabase(system: string, database: string, opts?: DatabaseOptions): string {
  // charset/collation clause — empty unless the New Database dialog picked one, so
  // the default output stays the plain statement it has always been.
  const cl = databaseOptionClause(system, opts)
  const d = quoteIdent(system, database)
  switch (system) {
    case 'postgres':
    case 'mssql':
    case 'mysql':
    case 'mariadb':
    case 'clickhouse':
      return `CREATE DATABASE ${d}${cl};`
    case 'oracle':
      // A "database" in Oracle is an instance; the user-facing analogue is a schema = user.
      return `CREATE USER ${d} IDENTIFIED BY "change_me";\nGRANT CONNECT, RESOURCE TO ${d};\nALTER USER ${d} QUOTA UNLIMITED ON USERS;`
    case 'sqlite':
      return `-- SQLite databases are files — create a new connection with a new .sqlite path.`
    default:
      return `-- Creating a database is not supported for ${system}.`
  }
}

/**
 * DROP a database. Opened for review before running (destructive). For PostgreSQL
 * you must not be connected to the target database. SQLite is a file → comment.
 */
export function genDropDatabase(system: string, database: string): string {
  const d = quoteIdent(system, database)
  switch (system) {
    case 'postgres':
      // Run from another database; add WITH (FORCE) on PG 13+ to close sessions.
      return `DROP DATABASE IF EXISTS ${d};`
    case 'mssql':
      return `DROP DATABASE IF EXISTS ${d};`
    case 'mysql':
    case 'mariadb':
    case 'clickhouse':
      return `DROP DATABASE IF EXISTS ${d};`
    case 'oracle':
      // Schema = user; no IF EXISTS. CASCADE drops the user's objects too.
      return `DROP USER ${d} CASCADE;`
    case 'sqlite':
      return `-- SQLite databases are files — delete the .sqlite file on disk instead.`
    default:
      return `-- Dropping a database is not supported for ${system}.`
  }
}

export function genTruncate(system: string, schema: string, table: string): string {
  return `TRUNCATE TABLE ${target(system, schema, table)};`
}

export function genDrop(system: string, schema: string, table: string): string {
  // Oracle has no DROP TABLE IF EXISTS (<23c); CASCADE CONSTRAINTS drops inbound FKs.
  if (system === 'oracle') return `DROP TABLE ${target(system, schema, table)} CASCADE CONSTRAINTS;`
  return `DROP TABLE IF EXISTS ${target(system, schema, table)};`
}

// ---- Table Designer (Phase 5 · T3) -----------------------------------------

/** Cột trong Table Designer form (mô hình riêng, richer hơn ColumnInfo). */
export interface DesignerCol {
  name: string
  type: string
  len: string
  pk: boolean
  nullable: boolean
  dflt: string
}

/** Data types for the designer's type dropdown, per dialect. Delegates to the
 *  comprehensive per-engine catalog in `datatypes.ts` (single source of truth). */
export function designerTypes(system: string): string[] {
  return dataTypes(system)
}

/** Sinh CREATE TABLE từ mô hình designer (port designerDDL dòng 3158-3162,
 *  mở rộng dialect-aware quoting + ENGINE cho ClickHouse). */
export function designerDdl(system: string, schema: string, table: string, cols: DesignerCol[]): string {
  const sch = schema || defaultSchema(system)
  const tbl = table || 'new_table'
  const name = sch ? target(system, sch, tbl) : quoteIdent(system, tbl)
  const lines = cols.map((c) => {
    let t = c.type || 'varchar'
    if (c.len.trim()) t += `(${c.len.trim()})`
    let line = `  ${quoteIdent(system, c.name || 'column')} ${t}`
    if (c.pk) line += ' PRIMARY KEY'
    if (!c.nullable && !c.pk) line += ' NOT NULL'
    if (c.dflt.trim()) line += ` DEFAULT ${c.dflt.trim()}`
    return line
  })
  let ddl = `CREATE TABLE ${name} (\n${lines.join(',\n')}\n)`
  if (system === 'clickhouse') {
    const pk = cols.filter((c) => c.pk).map((c) => quoteIdent(system, c.name))
    ddl += `\nENGINE = MergeTree\nORDER BY ${pk.length ? `(${pk.join(', ')})` : 'tuple()'}`
  }
  return ddl + ';'
}

function defaultSchema(system: string): string {
  if (system === 'sqlite') return 'main'
  if (system === 'mysql' || system === 'mariadb' || system === 'clickhouse') return ''
  if (system === 'mssql') return 'dbo'
  // Oracle: schema = connected user (resolved by caller); empty → current-user schema.
  if (system === 'oracle') return ''
  return 'public'
}
