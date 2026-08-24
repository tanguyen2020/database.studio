// Function-signature autocomplete data (Phase 5 · T21). Pure per-dialect list →
// unit-testable; SqlEditor feeds it into the editor completion sources.

import { staticFunctions } from './functions.catalog'

export interface FnSig {
  name: string
  signature: string
  detail: string
}

/** A function hint with the signature/detail optional — the shape returned by
 *  `list_functions` introspection (some engines give names only). */
export interface FnHint {
  name: string
  signature?: string
  detail?: string
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
  oracle: [
    { name: 'nvl', signature: 'nvl(expr, replacement)', detail: 'null handling' },
    { name: 'nvl2', signature: 'nvl2(expr, if_not_null, if_null)', detail: 'null handling' },
    { name: 'decode', signature: 'decode(expr, search, result, …, default)', detail: 'conditional' },
    { name: 'to_char', signature: 'to_char(expr [, fmt])', detail: 'conversion' },
    { name: 'to_date', signature: 'to_date(text, fmt)', detail: 'conversion' },
    { name: 'to_number', signature: 'to_number(text [, fmt])', detail: 'conversion' },
    { name: 'listagg', signature: 'listagg(expr, delim) WITHIN GROUP (ORDER BY …)', detail: 'aggregate' },
    { name: 'substr', signature: 'substr(str, start [, length])', detail: 'string' },
    { name: 'instr', signature: 'instr(str, substr)', detail: 'string' },
    { name: 'trunc', signature: 'trunc(date_or_number [, fmt])', detail: 'datetime/numeric' },
    { name: 'sysdate', signature: 'sysdate', detail: 'current date' },
    { name: 'systimestamp', signature: 'systimestamp', detail: 'current timestamp' },
  ],
}

/** Danh sách function + chữ ký cho dialect (common + đặc thù hệ). */
export function functionSignatures(system: string): FnSig[] {
  return [...COMMON, ...(BY_SYSTEM[system] ?? [])]
}

/**
 * The full function list to feed autocomplete: merge of
 *  1. static built-ins (MySQL/MariaDB/MSSQL — not introspectable),
 *  2. `dynamic` functions introspected from the live server (`list_functions`:
 *     PG/SQLite/ClickHouse full catalog + extensions; MySQL/MSSQL user functions),
 *  3. curated signatures (best param hints) — these win on the signature.
 * Deduped case-insensitively by name; a name with a real `name(args)` signature
 * beats a bare `name(…)` placeholder. Sorted for stable display.
 */
export function functionCatalog(system: string, dynamic: FnHint[] = []): FnSig[] {
  const byName = new Map<string, FnSig>()
  const hasArgs = (s?: string) => !!s && /\([^…)]*\S/.test(s) // signature with real args, not "name(…)"
  const add = (f: FnHint, curated: boolean) => {
    const key = f.name.toLowerCase()
    const norm: FnSig = { name: f.name, signature: f.signature || `${f.name}()`, detail: f.detail || 'function' }
    const existing = byName.get(key)
    if (!existing) {
      byName.set(key, norm)
      return
    }
    // Curated always wins; otherwise only upgrade to a richer signature.
    if (curated || (!hasArgs(existing.signature) && hasArgs(f.signature))) {
      byName.set(key, { name: existing.name, signature: norm.signature, detail: f.detail || existing.detail })
    }
  }
  for (const f of staticFunctions(system)) add(f, false)
  for (const f of dynamic) add(f, false)
  for (const f of functionSignatures(system)) add(f, true)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
