// ClickHouse advanced ops (Phase 5 · T7c-pt2) — sinh SQL native cho context menu
// (port dòng 3388-3394 + 3447-3448). Thuần → unit-test. Người dùng review/sửa
// partition trước khi chạy (mở trong SQL editor như prototype).
import { quoteIdent } from './dialect'

/** Table đủ điều kiện (schema.table nếu có schema khác 'default'/rỗng). */
function q(schema: string, table: string): string {
  const t = quoteIdent('clickhouse', table)
  return schema && schema !== 'default' ? `${quoteIdent('clickhouse', schema)}.${t}` : t
}

/** Placeholder partition — người dùng sửa trong editor (prototype dùng '202606'). */
const PART = "'202606'"

export function optimizeFinal(schema: string, table: string): string {
  return `OPTIMIZE TABLE ${q(schema, table)} FINAL;`
}

export function showPartitions(table: string): string {
  return (
    `SELECT partition, name, rows, formatReadableSize(bytes_on_disk) AS size, active\n` +
    `FROM system.parts\nWHERE table = '${table}' AND active\nORDER BY partition DESC;`
  )
}

export function showEngine(table: string): string {
  return (
    `SELECT name, engine, partition_key, sorting_key, total_rows, formatReadableSize(total_bytes) AS size\n` +
    `FROM system.tables\nWHERE name = '${table}';`
  )
}

export function showMutations(table: string): string {
  return (
    `SELECT mutation_id, command, is_done, create_time, latest_fail_reason\n` +
    `FROM system.mutations\nWHERE table = '${table}'\nORDER BY create_time DESC;`
  )
}

export function detachPartition(schema: string, table: string): string {
  return `ALTER TABLE ${q(schema, table)} DETACH PARTITION ${PART};`
}

export function dropPartition(schema: string, table: string): string {
  return `ALTER TABLE ${q(schema, table)} DROP PARTITION ${PART};`
}

export function freezePartition(schema: string, table: string): string {
  return `ALTER TABLE ${q(schema, table)} FREEZE PARTITION ${PART};`
}

/** Mutation async thay cho UPDATE/DELETE kiểu OLTP (CLICKHOUSE_SPEC_ADDENDUM). */
export function mutationUpdate(schema: string, table: string, set: string, where: string): string {
  return `ALTER TABLE ${q(schema, table)} UPDATE ${set} WHERE ${where};`
}
export function mutationDelete(schema: string, table: string, where: string): string {
  return `ALTER TABLE ${q(schema, table)} DELETE WHERE ${where};`
}

/** Dictionary ops (port dòng 3447-3448). */
export function dictShowDefinition(schema: string, name: string): string {
  return `SHOW CREATE DICTIONARY ${q(schema, name)};`
}
export function dictReload(name: string): string {
  return `SYSTEM RELOAD DICTIONARY ${name};`
}

/** Có nên gợi ý SELECT … FINAL? (engine có merge trùng key). */
export function needsFinal(engine: string | undefined): boolean {
  if (!engine) return false
  return /Replacing|Summing|Aggregating|Collapsing/.test(engine)
}
