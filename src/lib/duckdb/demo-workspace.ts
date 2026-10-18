// Demo (browser / e2e) answers for the DuckDB workspace statements (overview,
// extensions, settings, import / export, attach, profile). Stateful, so installing
// an extension, changing a setting or attaching a database really changes what
// the next read returns. The SQL is matched on the shapes src/lib/duckdb/sql.ts
// builds; anything else returns undefined and falls through to the generic mock.

import {
  DATABASES_SQL,
  EXTENSIONS_SQL,
  LARGEST_TABLES_SQL,
  MEMORY_SQL,
  OVERVIEW_SQL,
  SETTINGS_SQL,
  TEMP_FILES_SQL,
} from './sql'

interface Db {
  name: string
  path: string | null
  type: string
  readonly: boolean
}
const dbs: Db[] = [
  { name: 'warehouse', path: '/data/warehouse.duckdb', type: 'duckdb', readonly: false },
  { name: 'lake', path: '/data/lake.duckdb', type: 'duckdb', readonly: true },
]
export function duckWorkspaceDbs(): Db[] {
  return dbs
}

interface Ext {
  extension_name: string
  loaded: boolean
  installed: boolean
  description: string
  mode: string
}
const exts: Ext[] = [
  { extension_name: 'core_functions', loaded: true, installed: true, description: 'Core function library', mode: 'STATICALLY_LINKED' },
  { extension_name: 'json', loaded: true, installed: true, description: 'Adds support for JSON operations', mode: 'STATICALLY_LINKED' },
  { extension_name: 'parquet', loaded: true, installed: true, description: 'Adds support for reading and writing parquet files', mode: 'STATICALLY_LINKED' },
  { extension_name: 'httpfs', loaded: false, installed: true, description: 'Adds support for reading and writing files over a HTTP(S) or S3 connection', mode: 'REPOSITORY' },
  { extension_name: 'excel', loaded: false, installed: false, description: 'Adds support for reading and writing Excel files', mode: 'NOT_INSTALLED' },
  { extension_name: 'spatial', loaded: false, installed: false, description: 'Geospatial extension that adds support for working with spatial data and functions', mode: 'NOT_INSTALLED' },
  { extension_name: 'sqlite_scanner', loaded: false, installed: false, description: 'Adds support for reading and writing SQLite database files', mode: 'NOT_INSTALLED' },
  { extension_name: 'postgres_scanner', loaded: false, installed: false, description: 'Adds support for connecting to a Postgres database', mode: 'NOT_INSTALLED' },
]

interface Setting {
  name: string
  value: string
  def: string
  description: string
  input_type: string
}
const settings: Setting[] = [
  { name: 'memory_limit', value: '12.5 GiB', def: '12.5 GiB', description: 'The maximum memory of the system (e.g. 1GB)', input_type: 'VARCHAR' },
  { name: 'threads', value: '8', def: '8', description: 'The number of total threads used by the system.', input_type: 'BIGINT' },
  { name: 'temp_directory', value: '/data/warehouse.duckdb.tmp', def: '/data/warehouse.duckdb.tmp', description: 'Set the directory to which to write temp files', input_type: 'VARCHAR' },
  { name: 'max_temp_directory_size', value: '90% of available disk space', def: '90% of available disk space', description: 'The maximum amount of data stored inside the temp_directory', input_type: 'VARCHAR' },
  { name: 'preserve_insertion_order', value: 'true', def: 'true', description: 'Whether or not to preserve insertion order.', input_type: 'BOOLEAN' },
  { name: 'default_order', value: 'ASC', def: 'ASC', description: 'The order type used when none is specified (ASC or DESC)', input_type: 'VARCHAR' },
  { name: 'enable_progress_bar', value: 'false', def: 'false', description: 'Enables the progress bar, printing progress to the terminal for long queries', input_type: 'BOOLEAN' },
  { name: 'autoinstall_known_extensions', value: 'true', def: 'true', description: 'Whether known extensions are allowed to be automatically installed when a query depends on them', input_type: 'BOOLEAN' },
  { name: 'autoload_known_extensions', value: 'true', def: 'true', description: 'Whether known extensions are allowed to be automatically loaded when a query depends on them', input_type: 'BOOLEAN' },
  { name: 'TimeZone', value: 'Asia/Saigon', def: 'Asia/Saigon', description: 'The current time zone', input_type: 'VARCHAR' },
  { name: 'checkpoint_threshold', value: '16.0 MiB', def: '16.0 MiB', description: 'The WAL size threshold at which to automatically trigger a checkpoint', input_type: 'VARCHAR' },
  { name: 'enable_object_cache', value: 'false', def: 'false', description: 'Whether or not object cache is used to cache e.g. Parquet metadata', input_type: 'BOOLEAN' },
]

const imported = new Map<string, number>() // "schema.table" → rows

const SALES_COLS: [string, string][] = [
  ['order_id', 'BIGINT'],
  ['customer', 'VARCHAR'],
  ['amount', 'DOUBLE'],
  ['ordered_at', 'DATE'],
]
const SALES_ROWS = Array.from({ length: 40 }, (_, i) => ({
  order_id: 1001 + i,
  customer: ['An', 'Bình', 'Chi', 'Dũng'][i % 4],
  amount: Math.round((12 + ((i * 37) % 290) + i / 10) * 100) / 100,
  ordered_at: `2026-0${1 + (i % 6)}-${String(1 + (i % 27)).padStart(2, '0')}`,
}))
const FILE_ROWS = 1240

const PROFILE_COLS = [
  { column_name: 'event_id', column_type: 'BIGINT', min: '1', max: '125000', approx_unique: '128210', avg: '62500.5', std: '36084.536', q25: '31250', q50: '62500', q75: '93750', count: 125000, null_percentage: 0 },
  { column_name: 'user_id', column_type: 'INTEGER', min: '1', max: '2400', approx_unique: '2391', avg: '1203.4', std: '692.2', q25: '601', q50: '1204', q75: '1803', count: 125000, null_percentage: 1.2 },
  { column_name: 'kind', column_type: 'VARCHAR', min: 'click', max: 'view', approx_unique: '4', avg: null, std: null, q25: null, q50: null, q75: null, count: 125000, null_percentage: 0 },
  { column_name: 'amount', column_type: 'DECIMAL(10,2)', min: '0.50', max: '980.00', approx_unique: '8113', avg: '87.31', std: '112.9', q25: '12.40', q50: '44.10', q75: '120.00', count: 125000, null_percentage: 37.5 },
  { column_name: 'created_at', column_type: 'TIMESTAMP', min: '2026-01-01 00:00:04', max: '2026-06-30 23:59:51', approx_unique: '124876', avg: '2026-03-31 11:58:02', std: null, q25: '2026-02-14 08:00:00', q50: '2026-03-31 12:00:00', q75: '2026-05-15 16:00:00', count: 125000, null_percentage: 0 },
  { column_name: 'is_test', column_type: 'BOOLEAN', min: 'false', max: 'true', approx_unique: '2', avg: null, std: null, q25: null, q50: null, q75: null, count: 125000, null_percentage: 0 },
]

type Resp = { ok: boolean; result?: { cols: [string, string][]; rows: Record<string, unknown>[]; total: number }; affected?: number; error?: unknown; duration_ms: number }

function rows(cols: [string, string][], data: Record<string, unknown>[]): Resp {
  return { ok: true, result: { cols, rows: data, total: data.length }, duration_ms: 4 }
}
function affected(n: number): Resp {
  return { ok: true, affected: n, duration_ms: 18 }
}
const okr: Resp = { ok: true, duration_ms: 3 }
function err(message: string, code = 'IO'): Resp {
  return { ok: false, error: { system: 'duckdb', code, message, severity: 'error', raw: message }, duration_ms: 2 }
}
const cols = (...names: string[]): [string, string][] => names.map((n) => [n, 'VARCHAR'])

function unq(s: string): string {
  return s.replace(/^"|"$/g, '').replace(/""/g, '"')
}
function extLoaded(name: string): boolean {
  return exts.find((e) => e.extension_name === name)?.loaded ?? false
}

/** Answer for a workspace statement, or undefined (generic mock). */
export function duckWorkspaceExec(raw: string): Resp | undefined {
  const sql = raw.trim().replace(/;+\s*$/, '')
  if (sql === OVERVIEW_SQL)
    return rows(cols('version', 'platform', 'database', 'schema', 'threads', 'memory_limit', 'tables', 'views', 'est_rows', 'extensions_loaded'), [
      {
        version: 'v1.5.6',
        platform: 'windows_amd64',
        database: 'warehouse',
        schema: 'main',
        threads: Number(settings.find((s) => s.name === 'threads')!.value),
        memory_limit: settings.find((s) => s.name === 'memory_limit')!.value,
        tables: 3 + imported.size,
        views: 1,
        est_rows: 3_137_200 + [...imported.values()].reduce((a, b) => a + b, 0),
        extensions_loaded: exts.filter((e) => e.loaded).length,
      },
    ])
  if (sql === DATABASES_SQL)
    return rows(cols('name', 'path', 'type', 'readonly', 'database_size', 'wal_size', 'block_size', 'total_blocks', 'used_blocks', 'free_blocks', 'memory_usage', 'current'),
      dbs.map((d, i) => ({
        ...d,
        database_size: i === 0 ? '48.5 MiB' : d.type === 'duckdb' ? '212.0 MiB' : '0 bytes',
        wal_size: i === 0 ? '1.2 MiB' : '0 bytes',
        block_size: 262144,
        total_blocks: i === 0 ? 194 : 848,
        used_blocks: i === 0 ? 181 : 848,
        free_blocks: i === 0 ? 13 : 0,
        memory_usage: '6.8 MiB',
        current: d.name === 'warehouse',
      })))
  if (sql === LARGEST_TABLES_SQL)
    return rows(cols('database_name', 'schema_name', 'table_name', 'estimated_size', 'column_count', 'index_count'), [
      { database_name: 'lake', schema_name: 'main', table_name: 'trips', estimated_size: 3_000_000, column_count: 14, index_count: 0 },
      { database_name: 'warehouse', schema_name: 'main', table_name: 'events', estimated_size: 125_000, column_count: 6, index_count: 1 },
      ...[...imported].map(([k, n]) => ({ database_name: 'warehouse', schema_name: k.split('.')[0], table_name: k.split('.')[1], estimated_size: n, column_count: 4, index_count: 0 })),
      { database_name: 'warehouse', schema_name: 'staging', table_name: 'raw_events', estimated_size: 9800, column_count: 6, index_count: 0 },
      { database_name: 'warehouse', schema_name: 'main', table_name: 'users', estimated_size: 2400, column_count: 5, index_count: 1 },
    ])
  if (sql === MEMORY_SQL)
    return rows(cols('tag', 'memory_usage_bytes', 'temporary_storage_bytes'), [
      { tag: 'BASE_TABLE', memory_usage_bytes: 5_242_880, temporary_storage_bytes: 0 },
      { tag: 'HASH_TABLE', memory_usage_bytes: 1_310_720, temporary_storage_bytes: 0 },
      { tag: 'PARQUET_READER', memory_usage_bytes: 262_144, temporary_storage_bytes: 0 },
      { tag: 'ORDER_BY', memory_usage_bytes: 0, temporary_storage_bytes: 0 },
    ])
  if (sql === TEMP_FILES_SQL) return rows(cols('path', 'size'), [])
  if (sql === EXTENSIONS_SQL)
    return rows(cols('extension_name', 'loaded', 'installed', 'install_path', 'description', 'aliases', 'extension_version', 'install_mode', 'installed_from'),
      [...exts]
        .sort((a, b) => Number(b.loaded) - Number(a.loaded) || Number(b.installed) - Number(a.installed) || a.extension_name.localeCompare(b.extension_name))
        .map((e) => ({
          extension_name: e.extension_name,
          loaded: e.loaded,
          installed: e.installed,
          install_path: e.mode === 'STATICALLY_LINKED' ? '(BUILT-IN)' : e.installed ? `~/.duckdb/extensions/v1.5.6/windows_amd64/${e.extension_name}.duckdb_extension` : '',
          description: e.description,
          aliases: [],
          extension_version: e.installed ? 'v1.5.6' : '',
          install_mode: e.mode,
          installed_from: e.mode === 'REPOSITORY' ? 'core' : '',
        })))
  if (sql === SETTINGS_SQL)
    return rows(cols('name', 'value', 'description', 'input_type', 'scope'),
      [...settings].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ name: s.name, value: s.value, description: s.description, input_type: s.input_type, scope: 'GLOBAL' })))

  let m: RegExpMatchArray | null
  if ((m = sql.match(/^SET GLOBAL (\w+) = '((?:[^']|'')*)'$/))) {
    const st = settings.find((s) => s.name === m![1])
    if (!st) return err(`Catalog Error: unrecognized configuration parameter "${m[1]}"`, 'Catalog')
    const v = m[2].replace(/''/g, "'")
    if (st.input_type === 'BIGINT' && !/^\d+$/.test(v)) return err(`Conversion Error: Could not convert string '${v}' to INT64`, 'Conversion')
    st.value = st.input_type === 'BOOLEAN' ? String(/^(true|1|on)$/i.test(v)) : v
    return okr
  }
  if ((m = sql.match(/^RESET GLOBAL (\w+)$/))) {
    const st = settings.find((s) => s.name === m![1])
    if (st) st.value = st.def
    return okr
  }
  if ((m = sql.match(/^(FORCE )?INSTALL (\w+)$/))) {
    const e = exts.find((x) => x.extension_name === m![2])
    if (!e) return err(`HTTP Error: Failed to download extension "${m[2]}" at URL "http://extensions.duckdb.org/v1.5.6/windows_amd64/${m[2]}.duckdb_extension.gz" (HTTP 404)`, 'HTTP')
    e.installed = true
    if (e.mode === 'NOT_INSTALLED') e.mode = 'REPOSITORY'
    return okr
  }
  if ((m = sql.match(/^LOAD (\w+)$/))) {
    const e = exts.find((x) => x.extension_name === m![1])
    if (!e?.installed) return err(`IO Error: Extension "~/.duckdb/extensions/v1.5.6/windows_amd64/${m[1]}.duckdb_extension" not found.`)
    e.loaded = true
    return okr
  }
  if (/^UPDATE EXTENSIONS/.test(sql)) return rows(cols('extension_name', 'repository', 'update_result'), [])
  if (/^(FORCE )?CHECKPOINT/.test(sql)) return okr

  if (/^SELECT database_name AS name, \(database_name = current_database\(\)\) AS current, readonly FROM duckdb_databases\(\)/.test(sql))
    return rows(cols('name', 'current', 'readonly'), dbs.map((d) => ({ name: d.name, current: d.name === 'warehouse', readonly: d.readonly })))
  if (/^SELECT database_name AS name FROM duckdb_databases\(\)/.test(sql))
    return rows(cols('name'), [...dbs.map((d) => ({ name: d.name })), { name: 'system' }, { name: 'temp' }])
  if (/^SELECT schema_name FROM duckdb_schemas\(\)/.test(sql)) return rows(cols('schema_name'), sql.includes("'warehouse'") ? [{ schema_name: 'main' }, { schema_name: 'staging' }] : [{ schema_name: 'main' }])
  if (/^SELECT table_name FROM duckdb_tables\(\)/.test(sql)) {
    const sc = sql.match(/schema_name = '([^']*)'/)?.[1] ?? 'main'
    const base = sc === 'main' ? ['events', 'users'] : sc === 'staging' ? ['raw_events'] : []
    return rows(cols('table_name'), [...base, ...[...imported.keys()].filter((k) => k.startsWith(`${sc}.`)).map((k) => k.split('.')[1])].map((t) => ({ table_name: t })))
  }
  if (/^SELECT column_name FROM duckdb_columns\(\)/.test(sql)) return rows(cols('column_name'), PROFILE_COLS.map((c) => ({ column_name: c.column_name })))

  // ---- files ---------------------------------------------------------------
  const reader = sql.match(/read_(csv|parquet|json|xlsx)\('((?:[^']|'')*)'/)
  if (reader) {
    const kind = reader[1]
    const path = reader[2]
    if (kind === 'xlsx' && !extLoaded('excel'))
      return err('Catalog Error: Table Function with name "read_xlsx" is not in the catalog, but it exists in the excel extension.\n\nPlease try installing and loading the excel extension:\nINSTALL excel;\nLOAD excel;', 'Catalog')
    if (/^https?:|^s3:/.test(path) && !extLoaded('httpfs')) return err(`Missing Extension Error: File ${path} requires the extension httpfs to be loaded`, 'Missing Extension')
    if (/missing/i.test(path)) return err(`IO Error: No files found that match the pattern "${path}"`)
    if (/^DESCRIBE /.test(sql))
      return rows(cols('column_name', 'column_type', 'null', 'key', 'default', 'extra'), SALES_COLS.map(([n, t]) => ({ column_name: n, column_type: t, null: 'YES', key: null, default: null, extra: null })))
    if (/^SELECT count\(\*\) AS "rows" FROM/.test(sql)) return rows([['rows', 'BIGINT']], [{ rows: FILE_ROWS }])
    if (/^SELECT \* FROM read_/.test(sql)) return rows(SALES_COLS, SALES_ROWS)
    if ((m = sql.match(/^(CREATE TABLE|CREATE OR REPLACE TABLE|INSERT INTO) "([^"]+)"\."([^"]+)"(?:\."([^"]+)")?/))) {
      const [schema, table] = m[4] ? [m[3], m[4]] : [m[2], m[3]]
      if (m[1] === 'CREATE TABLE' && imported.has(`${schema}.${table}`)) return err(`Catalog Error: Table with name "${table}" already exists!`, 'Catalog')
      imported.set(`${schema}.${table}`, (m[1] === 'INSERT INTO' ? imported.get(`${schema}.${table}`) ?? 0 : 0) + FILE_ROWS)
      return affected(FILE_ROWS)
    }
    if (/^CREATE OR REPLACE VIEW /.test(sql)) return okr
  }
  if ((m = sql.match(/^COPY ([\s\S]+) TO '((?:[^']|'')*)' \(/))) {
    if (/^\/?nope|^Z:/.test(m[2])) return err(`IO Error: Cannot open file "${m[2]}": The system cannot find the path specified.`)
    return affected(m[1].startsWith('(') ? 40 : 125_000)
  }
  if (/^EXPORT DATABASE |^IMPORT DATABASE /.test(sql)) return okr
  if ((m = sql.match(/^ATTACH '((?:[^']|'')*)' AS ("(?:[^"]|"")*")(?: \(([^)]*)\))?$/))) {
    const alias = unq(m[2])
    const opts = m[3] ?? ''
    if (/TYPE sqlite/.test(opts) && !extLoaded('sqlite_scanner'))
      return err('IO Error: Extension "~/.duckdb/extensions/v1.5.6/windows_amd64/sqlite_scanner.duckdb_extension" not found.')
    if (dbs.some((d) => d.name.toLowerCase() === alias.toLowerCase())) return err(`Binder Error: Failed to attach database: database with name "${alias}" already exists`, 'Binder')
    dbs.push({ name: alias, path: m[1].replace(/''/g, "'"), type: /TYPE sqlite/.test(opts) ? 'sqlite' : 'duckdb', readonly: /READ_ONLY/.test(opts) })
    return okr
  }
  if ((m = sql.match(/^DETACH DATABASE IF EXISTS ("(?:[^"]|"")*")$/))) {
    const alias = unq(m[1])
    const i = dbs.findIndex((d) => d.name === alias)
    if (i > 0) dbs.splice(i, 1)
    return okr
  }

  // ---- profile -------------------------------------------------------------
  if (/^SUMMARIZE /.test(sql))
    return rows(cols('column_name', 'column_type', 'min', 'max', 'approx_unique', 'avg', 'std', 'q25', 'q50', 'q75', 'count', 'null_percentage'), PROFILE_COLS)
  if (/ AS bucket, /.test(sql)) {
    const col = sql.match(/CAST\("([^"]+)"/)?.[1] ?? ''
    const temporal = sql.includes('epoch(')
    const lo = temporal ? 1767225604 : col === 'amount' ? 0.5 : 1
    const hi = temporal ? 1782863991 : col === 'amount' ? 980 : col === 'user_id' ? 2400 : 125000
    return rows([['bucket', 'INTEGER'], ['lo', 'DOUBLE'], ['hi', 'DOUBLE'], ['n', 'BIGINT']],
      Array.from({ length: 20 }, (_, i) => ({ bucket: i, lo, hi, n: col === 'amount' ? Math.round(20000 * Math.exp(-i / 3)) : 5000 + ((i * 1777) % 2600) })))
  }
  if ((m = sql.match(/^SELECT "([^"]+)" AS value, count\(\*\) AS n FROM/))) {
    const vals = m[1] === 'kind' ? [['view', 61204], ['click', 40110], ['purchase', 18630], ['signup', 5056]] : m[1] === 'is_test' ? [[false, 124310], [true, 690]] : [['An', 10], ['Bình', 10]]
    return rows([['value', 'VARCHAR'], ['n', 'BIGINT']], vals.map(([value, n]) => ({ value, n })))
  }
  if (/^DESCRIBE /.test(sql)) return rows(cols('column_name', 'column_type'), SALES_COLS.map(([n, t]) => ({ column_name: n, column_type: t })))
  return undefined
}
