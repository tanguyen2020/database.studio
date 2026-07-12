// Cross-connection table copy (T25) — map a source column type to the
// destination dialect and build the destination CREATE TABLE. Pure →
// unit-testable; the dialog runs the DDL then streams the data.
import type { ColumnInfo } from '$lib/types'
import { genCreate } from '$lib/sql/ddl'

/** Normalize a source type to a coarse family used for dialect mapping. */
export type TypeFamily = 'int' | 'bigint' | 'float' | 'decimal' | 'bool' | 'text' | 'date' | 'time' | 'timestamp' | 'json' | 'uuid' | 'bytes'

export function classifyType(srcType: string): TypeFamily {
  const t = srcType.toLowerCase().trim()
  if (/\b(bigint|int8|bigserial|long)\b/.test(t)) return 'bigint'
  if (/\b(smallint|int2|integer|int4|int|serial|mediumint|tinyint)\b/.test(t)) return 'int'
  if (/\b(numeric|decimal|money)\b/.test(t)) return 'decimal'
  if (/\b(real|double|float|float4|float8)\b/.test(t)) return 'float'
  if (/\b(bool|boolean|bit)\b/.test(t)) return 'bool'
  if (/\b(uuid|uniqueidentifier)\b/.test(t)) return 'uuid'
  if (/\b(json|jsonb)\b/.test(t)) return 'json'
  if (/\b(timestamp|datetime|timestamptz)\b/.test(t)) return 'timestamp'
  if (/\bdate\b/.test(t)) return 'date'
  if (/\btime\b/.test(t)) return 'time'
  if (/\b(bytea|blob|binary|varbinary|image)\b/.test(t)) return 'bytes'
  return 'text'
}

// Per-dialect concrete type for each family.
const DIALECT_TYPES: Record<string, Record<TypeFamily, string>> = {
  postgres: { int: 'integer', bigint: 'bigint', float: 'double precision', decimal: 'numeric', bool: 'boolean', text: 'text', date: 'date', time: 'time', timestamp: 'timestamp', json: 'jsonb', uuid: 'uuid', bytes: 'bytea' },
  mysql: { int: 'INT', bigint: 'BIGINT', float: 'DOUBLE', decimal: 'DECIMAL(38,10)', bool: 'TINYINT(1)', text: 'TEXT', date: 'DATE', time: 'TIME', timestamp: 'DATETIME', json: 'JSON', uuid: 'CHAR(36)', bytes: 'BLOB' },
  mariadb: { int: 'INT', bigint: 'BIGINT', float: 'DOUBLE', decimal: 'DECIMAL(38,10)', bool: 'TINYINT(1)', text: 'TEXT', date: 'DATE', time: 'TIME', timestamp: 'DATETIME', json: 'JSON', uuid: 'CHAR(36)', bytes: 'BLOB' },
  mssql: { int: 'int', bigint: 'bigint', float: 'float', decimal: 'decimal(38,10)', bool: 'bit', text: 'nvarchar(max)', date: 'date', time: 'time', timestamp: 'datetime2', json: 'nvarchar(max)', uuid: 'uniqueidentifier', bytes: 'varbinary(max)' },
  sqlite: { int: 'INTEGER', bigint: 'INTEGER', float: 'REAL', decimal: 'NUMERIC', bool: 'INTEGER', text: 'TEXT', date: 'TEXT', time: 'TEXT', timestamp: 'TEXT', json: 'TEXT', uuid: 'TEXT', bytes: 'BLOB' },
  clickhouse: { int: 'Int32', bigint: 'Int64', float: 'Float64', decimal: 'Decimal(38,10)', bool: 'UInt8', text: 'String', date: 'Date', time: 'String', timestamp: 'DateTime', json: 'String', uuid: 'UUID', bytes: 'String' },
}

/** Map a source column type to the destination dialect's concrete type. */
export function mapColumnType(srcType: string, destSystem: string): string {
  const family = classifyType(srcType)
  const table = DIALECT_TYPES[destSystem] ?? DIALECT_TYPES.postgres
  return table[family]
}

/** Rewrite source columns with destination-dialect types (dropping FK flags —
 *  data copy only; keys/constraints are the user's follow-up). */
export function mapColumns(srcCols: ColumnInfo[], destSystem: string): ColumnInfo[] {
  return srcCols.map((c) => ({ ...c, data_type: mapColumnType(c.data_type, destSystem), is_fk: false, default: undefined }))
}

/** Destination CREATE TABLE DDL for the copied table (dry-run preview + run). */
export function buildCopyDdl(destSystem: string, destSchema: string, destTable: string, srcCols: ColumnInfo[]): string {
  return genCreate(destSystem, destSchema, destTable, mapColumns(srcCols, destSystem))
}
