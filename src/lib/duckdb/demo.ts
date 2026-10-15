// Demo (browser / e2e) answers for the DuckDB connection. The generic demo mock
// is shaped like a Postgres server; DuckDB differs where the UI must show it does:
// its databases are the opened file + ATTACHed ones, its default schema is `main`,
// its functions are macros. Everything not answered here falls through to the
// generic mock (columns, exec, …), which is fine for a relational tree.
//
// Opt-in with `?duckdb=1` so every existing spec keeps the connection list it has.

export const DUCK_DEMO_ID = 'dk1'

export function duckDemoEnabled(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('duckdb') === '1'
}

/** True when a command targets the DuckDB demo connection (base, per-tab or
 *  per-database sub-connection). */
export function isDuckConn(connId: unknown): boolean {
  const id = String(connId ?? '')
  return id === DUCK_DEMO_ID || id.startsWith(`${DUCK_DEMO_ID}#`) || id.startsWith(`${DUCK_DEMO_ID}::`)
}

const TABLES_MAIN = [
  { name: 'events', kind: 'table', row_estimate: 125000, locked: false },
  { name: 'users', kind: 'table', row_estimate: 2400, locked: false },
  { name: 'daily_summary', kind: 'view', row_estimate: null, locked: false },
]
const TABLES_STAGING = [{ name: 'raw_events', kind: 'table', row_estimate: 9800, locked: false }]
const TABLES_LAKE = [{ name: 'trips', kind: 'table', row_estimate: 3_000_000, locked: false }]

/** Answer for a DuckDB command, or `undefined` to fall through to the generic mock. */
export function duckDemo(cmd: string, args: Record<string, unknown>): unknown {
  const cid = String(args.connId ?? '')
  const onLake = cid.endsWith('::lake')
  switch (cmd) {
    case 'list_databases':
      return [
        { name: 'warehouse', current: true },
        { name: 'lake', current: false },
      ]
    case 'attach_database': {
      const db = String(args.database ?? '')
      return db === 'warehouse' ? cid : `${cid}::${db}`
    }
    case 'list_schemas':
      return onLake
        ? [{ name: 'main', is_default: true }]
        : [
            { name: 'main', is_default: true },
            { name: 'staging', is_default: false },
          ]
    case 'list_tables': {
      if (onLake) return TABLES_LAKE
      return String(args.schema ?? '') === 'staging' ? TABLES_STAGING : TABLES_MAIN
    }
    case 'list_routines':
      // user macros are DuckDB's functions (no procedures)
      return String(args.schema ?? '') === 'main'
        ? [{ schema: 'main', name: 'add_tax', kind: 'function', params: [{ name: 'amount', data_type: '', mode: 'IN' }] }]
        : []
    case 'list_triggers':
      return [] // DuckDB has no triggers
    case 'list_sequences':
      return String(args.schema ?? '') === 'main' ? [{ schema: 'main', name: 'event_id_seq' }] : []
    default:
      return undefined
  }
}
