// SQL generators cho context menu Explorer — port gen* (dòng 3271-3291).
// Sinh từ ColumnInfo thật của bảng, quoting theo dialect. ClickHouse:
// UPDATE/DELETE là ALTER TABLE … (mutation async — CLICKHOUSE_SPEC_ADDENDUM).
import { qualified as q, quoteIdent } from './dialect'
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

export function genTruncate(system: string, schema: string, table: string): string {
  return `TRUNCATE TABLE ${target(system, schema, table)};`
}

export function genDrop(system: string, schema: string, table: string): string {
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

/** Danh sách kiểu dữ liệu cho dropdown, theo dialect. */
export function designerTypes(system: string): string[] {
  switch (system) {
    case 'mysql':
    case 'mariadb':
      return ['int', 'bigint', 'decimal', 'varchar', 'text', 'tinyint', 'datetime', 'date', 'char', 'json']
    case 'mssql':
      return ['int', 'bigint', 'decimal', 'nvarchar', 'varchar', 'bit', 'datetime2', 'date', 'uniqueidentifier', 'nvarchar(max)']
    case 'sqlite':
      return ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC']
    case 'clickhouse':
      return ['Int32', 'Int64', 'UInt32', 'Float64', 'String', 'LowCardinality(String)', 'Date', 'DateTime', 'UUID', 'Bool']
    default: // postgres
      return ['int4', 'int8', 'numeric', 'varchar', 'text', 'boolean', 'timestamptz', 'date', 'uuid', 'jsonb']
  }
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
  return 'public'
}
