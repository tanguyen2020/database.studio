// Function-signature autocomplete data (Phase 5 · T21). Pure per-dialect list →
// unit-testable; SqlEditor feeds it into a CodeMirror completion source.

export interface FnSig {
  name: string
  signature: string
  detail: string
}

const COMMON: FnSig[] = [
  { name: 'count', signature: 'count(*)', detail: 'aggregate' },
  { name: 'sum', signature: 'sum(expr)', detail: 'aggregate' },
  { name: 'avg', signature: 'avg(expr)', detail: 'aggregate' },
  { name: 'min', signature: 'min(expr)', detail: 'aggregate' },
  { name: 'max', signature: 'max(expr)', detail: 'aggregate' },
  { name: 'coalesce', signature: 'coalesce(a, b, …)', detail: 'null handling' },
  { name: 'upper', signature: 'upper(text)', detail: 'string' },
  { name: 'lower', signature: 'lower(text)', detail: 'string' },
]

const BY_SYSTEM: Record<string, FnSig[]> = {
  postgres: [
    { name: 'string_agg', signature: 'string_agg(expr, delimiter)', detail: 'aggregate' },
    { name: 'jsonb_build_object', signature: 'jsonb_build_object(key, value, …)', detail: 'json' },
    { name: 'generate_series', signature: 'generate_series(start, stop [, step])', detail: 'set-returning' },
    { name: 'now', signature: 'now()', detail: 'current timestamp' },
  ],
  mysql: [
    { name: 'group_concat', signature: 'group_concat(expr SEPARATOR sep)', detail: 'aggregate' },
    { name: 'ifnull', signature: 'ifnull(a, b)', detail: 'null handling' },
    { name: 'now', signature: 'now()', detail: 'current timestamp' },
  ],
  mariadb: [
    { name: 'group_concat', signature: 'group_concat(expr SEPARATOR sep)', detail: 'aggregate' },
    { name: 'ifnull', signature: 'ifnull(a, b)', detail: 'null handling' },
    { name: 'now', signature: 'now()', detail: 'current timestamp' },
  ],
  mssql: [
    { name: 'isnull', signature: 'isnull(check, replacement)', detail: 'null handling' },
    { name: 'string_agg', signature: 'string_agg(expr, separator)', detail: 'aggregate' },
    { name: 'getdate', signature: 'getdate()', detail: 'current timestamp' },
  ],
  sqlite: [
    { name: 'ifnull', signature: 'ifnull(a, b)', detail: 'null handling' },
    { name: 'group_concat', signature: 'group_concat(expr, separator)', detail: 'aggregate' },
    { name: 'strftime', signature: 'strftime(format, timestring)', detail: 'datetime' },
  ],
  clickhouse: [
    { name: 'uniqExact', signature: 'uniqExact(expr)', detail: 'aggregate' },
    { name: 'toDateTime', signature: 'toDateTime(expr)', detail: 'conversion' },
    { name: 'arrayJoin', signature: 'arrayJoin(arr)', detail: 'array' },
  ],
}

/** Danh sách function + chữ ký cho dialect (common + đặc thù hệ). */
export function functionSignatures(system: string): FnSig[] {
  return [...COMMON, ...(BY_SYSTEM[system] ?? [])]
}
