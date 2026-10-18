// DuckDB workspace — every statement the DuckDB-specific screens run (overview,
// extensions, settings, file import / export, attach, profiling). Pure: the
// components only pass user choices in and run what comes out.
//
// The exact strings are pinned in src-tauri/tests/fixtures/duckdb-statements.json:
// duckdb.test.ts checks these builders produce them and
// src-tauri/tests/duckdb_integration.rs runs them on the real engine.

/** A DuckDB identifier, always double-quoted (`"a""b"`). */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** A DuckDB string literal (`'it''s'`). Backslashes are literal in DuckDB strings,
 *  so a Windows path needs no escaping beyond the quote. */
export function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** `"db"."schema"."table"` — the database part only when one is given, so the
 *  statement also works on a connection that already `USE`s that database. */
export function target(schema: string, table: string, database?: string | null): string {
  const parts = database ? [database, schema, table] : [schema, table]
  return parts.map(ident).join('.')
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export type FileFormat = 'csv' | 'parquet' | 'json' | 'xlsx'

export const FILE_FORMATS: { id: FileFormat; label: string; extensions: string[] }[] = [
  { id: 'csv', label: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt', 'csv.gz', 'tsv.gz'] },
  { id: 'parquet', label: 'Parquet', extensions: ['parquet', 'pq'] },
  { id: 'json', label: 'JSON / NDJSON', extensions: ['json', 'jsonl', 'ndjson', 'json.gz', 'jsonl.gz'] },
  { id: 'xlsx', label: 'Excel (.xlsx)', extensions: ['xlsx'] },
]

/** Format from the file name (or glob / URL). Unknown → null (the user picks). */
export function detectFormat(path: string): FileFormat | null {
  const p = path.trim().toLowerCase().replace(/[?#].*$/, '')
  for (const f of FILE_FORMATS) {
    if (f.extensions.some((e) => p.endsWith(`.${e}`))) return f.id
  }
  return null
}

export interface CsvOptions {
  /** 'auto' lets DuckDB's sniffer decide. */
  header: 'auto' | 'yes' | 'no'
  /** '' = auto-detect. `\t` is a tab. */
  delimiter: string
  /** '' = auto-detect. */
  quote: string
  skip: number
  allVarchar: boolean
}

export interface JsonOptions {
  format: 'auto' | 'array' | 'newline_delimited'
}

export interface XlsxOptions {
  /** '' = first sheet */
  sheet: string
  header: 'auto' | 'yes' | 'no'
}

export interface FileSource {
  path: string
  format: FileFormat
  csv?: Partial<CsvOptions>
  json?: Partial<JsonOptions>
  xlsx?: Partial<XlsxOptions>
  /** add a `filename` column (useful with globs) */
  filename?: boolean
  /** match columns of several files by name instead of position */
  unionByName?: boolean
}

export const DEFAULT_CSV: CsvOptions = { header: 'auto', delimiter: '', quote: '', skip: 0, allVarchar: false }

/** The table function reading a file: `read_csv('…', header = true)` — only the
 *  options the user changed, so the sniffer keeps deciding everything else. */
export function fileReader(src: FileSource): string {
  const args: string[] = [lit(src.path)]
  if (src.format === 'csv') {
    const o = { ...DEFAULT_CSV, ...(src.csv ?? {}) }
    if (o.header !== 'auto') args.push(`header = ${o.header === 'yes'}`)
    if (o.delimiter) args.push(`delim = ${lit(o.delimiter === '\\t' ? '\t' : o.delimiter)}`)
    if (o.quote) args.push(`quote = ${lit(o.quote)}`)
    if (o.skip > 0) args.push(`skip = ${Math.floor(o.skip)}`)
    if (o.allVarchar) args.push('all_varchar = true')
  } else if (src.format === 'json') {
    const f = src.json?.format ?? 'auto'
    if (f !== 'auto') args.push(`format = ${lit(f)}`)
  } else if (src.format === 'xlsx') {
    const sheet = src.xlsx?.sheet?.trim()
    if (sheet) args.push(`sheet = ${lit(sheet)}`)
    const h = src.xlsx?.header ?? 'auto'
    if (h !== 'auto') args.push(`header = ${h === 'yes'}`)
  }
  if (src.format !== 'xlsx') {
    if (src.filename) args.push('filename = true')
    if (src.unionByName) args.push('union_by_name = true')
  }
  const fn = src.format === 'csv' ? 'read_csv' : src.format === 'parquet' ? 'read_parquet' : src.format === 'json' ? 'read_json' : 'read_xlsx'
  return `${fn}(${args.join(', ')})`
}

/** Column names + types DuckDB infers for the file. */
export function describeFile(src: FileSource): string {
  return `DESCRIBE SELECT * FROM ${fileReader(src)}`
}

export function previewFile(src: FileSource, limit = 100): string {
  return `SELECT * FROM ${fileReader(src)} LIMIT ${limit}`
}

export function countFile(src: FileSource): string {
  return `SELECT count(*) AS "rows" FROM ${fileReader(src)}`
}

export interface ImportColumn {
  name: string
  include: boolean
  /** '' = keep the detected type */
  type: string
  /** detected type (to know whether `type` changes anything) */
  detected: string
}

/** SELECT list for an import: `*` unless the user dropped or re-typed columns. */
export function importSelect(src: FileSource, columns?: ImportColumn[]): string {
  const reader = fileReader(src)
  const changed = columns?.some((c) => !c.include || (c.type.trim() && c.type.trim().toUpperCase() !== c.detected.toUpperCase()))
  if (!columns || !changed) return `SELECT * FROM ${reader}`
  const list = columns
    .filter((c) => c.include)
    .map((c) => {
      const t = c.type.trim()
      return t && t.toUpperCase() !== c.detected.toUpperCase() ? `CAST(${ident(c.name)} AS ${t}) AS ${ident(c.name)}` : ident(c.name)
    })
  return `SELECT ${list.join(', ')} FROM ${reader}`
}

export type ImportMode = 'create' | 'replace' | 'append' | 'view'

export const IMPORT_MODES: { id: ImportMode; label: string; help: string }[] = [
  { id: 'create', label: 'New table', help: 'Creates the table from the file. Fails if a table with that name exists.' },
  { id: 'replace', label: 'Replace table', help: 'Drops and recreates the table with the file’s contents.' },
  { id: 'append', label: 'Append to table', help: 'Inserts the rows into an existing table, matching columns by name.' },
  { id: 'view', label: 'View over the file', help: 'Keeps the data in the file: the view reads it on every query.' },
]

export function importStatement(mode: ImportMode, schema: string, table: string, select: string, database?: string | null): string {
  const t = target(schema, table, database)
  switch (mode) {
    case 'create':
      return `CREATE TABLE ${t} AS ${select}`
    case 'replace':
      return `CREATE OR REPLACE TABLE ${t} AS ${select}`
    case 'append':
      return `INSERT INTO ${t} BY NAME ${select}`
    case 'view':
      return `CREATE OR REPLACE VIEW ${t} AS ${select}`
  }
}

/** A table name from a file name: `Sales 2026 (final).csv` → `sales_2026_final`. */
export function tableNameFromPath(path: string): string {
  const base = path.replace(/[?#].*$/, '').split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.(gz|zst)$/i, '').replace(/\.[^.]+$/, '')
  const clean = stem
    .replace(/[*?[\]{}]/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!clean) return 'imported'
  return /^[0-9]/.test(clean) ? `t_${clean}` : clean
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportFormat = 'parquet' | 'csv' | 'json' | 'ndjson'

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'parquet', label: 'Parquet', ext: 'parquet' },
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'json', label: 'JSON (array)', ext: 'json' },
  { id: 'ndjson', label: 'NDJSON (one object per line)', ext: 'ndjson' },
]

export type ParquetCompression = 'zstd' | 'snappy' | 'gzip' | 'uncompressed'

export interface ExportOptions {
  format: ExportFormat
  compression?: ParquetCompression
  /** Parquet / CSV: write one folder per value (Hive partitioning) */
  partitionBy?: string[]
  overwrite?: boolean
  header?: boolean
  delimiter?: string
}

export type ExportSource = { kind: 'table'; schema: string; table: string; database?: string | null } | { kind: 'query'; sql: string }

/** `COPY … TO 'path' (FORMAT …)`. A query source is wrapped in parentheses; its
 *  trailing `;` (as typed in the editor) is dropped. */
export function exportStatement(source: ExportSource, path: string, o: ExportOptions): string {
  const from =
    source.kind === 'table' ? target(source.schema, source.table, source.database) : `(${source.sql.trim().replace(/;+\s*$/, '')})`
  const opts: string[] = []
  if (o.format === 'parquet') {
    opts.push('FORMAT parquet', `COMPRESSION ${o.compression ?? 'zstd'}`)
  } else if (o.format === 'csv') {
    opts.push('FORMAT csv', `HEADER ${o.header ?? true}`)
    const d = o.delimiter ?? ','
    if (d !== ',') opts.push(`DELIMITER ${lit(d === '\\t' ? '\t' : d)}`)
  } else if (o.format === 'json') {
    opts.push('FORMAT json', 'ARRAY true')
  } else {
    opts.push('FORMAT json')
  }
  const parts = (o.partitionBy ?? []).filter(Boolean)
  if (parts.length && (o.format === 'parquet' || o.format === 'csv')) opts.push(`PARTITION_BY (${parts.map(ident).join(', ')})`)
  if (o.overwrite) opts.push('OVERWRITE_OR_IGNORE true')
  return `COPY ${from} TO ${lit(path)} (${opts.join(', ')})`
}

/** Whole database → a folder of files + schema.sql/load.sql (re-importable). */
export function exportDatabaseStatement(dir: string, format: 'parquet' | 'csv', database?: string | null): string {
  const db = database ? `${ident(database)} TO ` : ''
  return `EXPORT DATABASE ${db}${lit(dir)} (FORMAT ${format})`
}

export function importDatabaseStatement(dir: string): string {
  return `IMPORT DATABASE ${lit(dir)}`
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

export type AttachType = 'duckdb' | 'sqlite'

export function attachStatement(path: string, alias: string, opts: { readOnly?: boolean; type?: AttachType } = {}): string {
  const o: string[] = []
  if (opts.type && opts.type !== 'duckdb') o.push(`TYPE ${opts.type}`)
  if (opts.readOnly) o.push('READ_ONLY')
  return `ATTACH ${lit(path)} AS ${ident(alias)}${o.length ? ` (${o.join(', ')})` : ''}`
}

export function detachStatement(name: string): string {
  return `DETACH DATABASE IF EXISTS ${ident(name)}`
}

export function checkpointStatement(database?: string | null, force = false): string {
  return `${force ? 'FORCE ' : ''}CHECKPOINT${database ? ` ${ident(database)}` : ''}`
}

/** Alias for an attached file: its name without extension, as an identifier. */
export function aliasFromPath(path: string): string {
  return tableNameFromPath(path).replace(/^t_/, 'db_') || 'attached'
}

// ---------------------------------------------------------------------------
// Settings & extensions
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z_][a-z0-9_]*$/i

/** `SET GLOBAL name = 'value'` — DuckDB casts the literal to the setting's type. */
export function setSettingStatement(name: string, value: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid setting name: ${name}`)
  return `SET GLOBAL ${name} = ${lit(value)}`
}

export function resetSettingStatement(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid setting name: ${name}`)
  return `RESET GLOBAL ${name}`
}

/** Settings most people come for — shown first, in this order. */
export const COMMON_SETTINGS = [
  'memory_limit',
  'threads',
  'temp_directory',
  'max_temp_directory_size',
  'preserve_insertion_order',
  'default_order',
  'default_null_order',
  'enable_progress_bar',
  'enable_object_cache',
  'autoinstall_known_extensions',
  'autoload_known_extensions',
  'TimeZone',
  'Calendar',
]

export type ExtensionAction = 'install' | 'load' | 'install-load' | 'update' | 'force-install'

export function extensionStatements(action: ExtensionAction, name: string): string[] {
  if (!/^[a-z0-9_]+$/i.test(name)) throw new Error(`invalid extension name: ${name}`)
  switch (action) {
    case 'install':
      return [`INSTALL ${name}`]
    case 'load':
      return [`LOAD ${name}`]
    case 'install-load':
      return [`INSTALL ${name}`, `LOAD ${name}`]
    case 'force-install':
      return [`FORCE INSTALL ${name}`, `LOAD ${name}`]
    case 'update':
      return [`UPDATE EXTENSIONS (${name})`]
  }
}

/** The extension an error says is missing, or null.
 *  - `… is not in the catalog, but it exists in the excel extension.`
 *  - `File https://… requires the extension httpfs to be loaded`
 *  - `Extension "…\sqlite_scanner.duckdb_extension" not found.` */
export function missingExtension(message: string | null | undefined): string | null {
  const m = String(message ?? '')
  const a = m.match(/exists in the ([a-z0-9_]+) extension/i)
  if (a) return a[1].toLowerCase()
  const b = m.match(/requires the extension ([a-z0-9_]+)/i)
  if (b) return b[1].toLowerCase()
  const c = m.match(/Extension "[^"]*?([a-z0-9_]+)\.duckdb_extension" not found/i)
  if (c) return c[1].toLowerCase()
  const d = m.match(/Extension "([a-z0-9_]+)" not found/i)
  if (d) return d[1].toLowerCase()
  const e = m.match(/Please try installing and loading the ([a-z0-9_]+) extension/i)
  if (e) return e[1].toLowerCase()
  return null
}

// ---------------------------------------------------------------------------
// Workspace queries (read-only)
// ---------------------------------------------------------------------------

export const OVERVIEW_SQL =
  'SELECT version() AS version, (SELECT platform FROM pragma_platform()) AS platform, current_database() AS database, ' +
  "current_schema() AS schema, current_setting('threads') AS threads, current_setting('memory_limit') AS memory_limit, " +
  '(SELECT count(*) FROM duckdb_tables() WHERE NOT internal) AS tables, (SELECT count(*) FROM duckdb_views() WHERE NOT internal) AS views, ' +
  '(SELECT coalesce(sum(estimated_size), 0) FROM duckdb_tables() WHERE NOT internal) AS est_rows, ' +
  '(SELECT count(*) FROM duckdb_extensions() WHERE loaded) AS extensions_loaded'

export const DATABASES_SQL =
  'SELECT d.database_name AS name, d.path, d.type, d.readonly, s.database_size, s.wal_size, s.block_size, s.total_blocks, ' +
  's.used_blocks, s.free_blocks, s.memory_usage, (d.database_name = current_database()) AS current ' +
  'FROM duckdb_databases() d LEFT JOIN pragma_database_size() s ON s.database_name = d.database_name ' +
  'WHERE NOT d.internal ORDER BY current DESC, name'

export const LARGEST_TABLES_SQL =
  'SELECT database_name, schema_name, table_name, estimated_size, column_count, index_count FROM duckdb_tables() ' +
  'WHERE NOT internal ORDER BY estimated_size DESC, database_name, schema_name, table_name LIMIT 10'

export const MEMORY_SQL =
  'SELECT tag, memory_usage_bytes, temporary_storage_bytes FROM duckdb_memory() ORDER BY memory_usage_bytes DESC, tag'

export const TEMP_FILES_SQL = 'SELECT path, size FROM duckdb_temporary_files() ORDER BY size DESC'

export const EXTENSIONS_SQL =
  'SELECT extension_name, loaded, installed, install_path, description, aliases, extension_version, install_mode, installed_from ' +
  'FROM duckdb_extensions() ORDER BY loaded DESC, installed DESC, extension_name'

export const SETTINGS_SQL = 'SELECT name, value, description, input_type, scope FROM duckdb_settings() ORDER BY name'

// ---------------------------------------------------------------------------
// Profiling
// ---------------------------------------------------------------------------

/** What to profile: a table/view or any SELECT (a file reader included). */
export type ProfileSource = { kind: 'table'; schema: string; table: string; database?: string | null } | { kind: 'query'; sql: string }

export function profileFrom(src: ProfileSource): string {
  return src.kind === 'table' ? target(src.schema, src.table, src.database) : `(${src.sql.trim().replace(/;+\s*$/, '')}) AS q`
}

export function summarizeStatement(src: ProfileSource): string {
  return src.kind === 'table'
    ? `SUMMARIZE ${profileFrom(src)}`
    : `SUMMARIZE ${src.sql.trim().replace(/;+\s*$/, '')}`
}

export function topValuesStatement(src: ProfileSource, column: string, limit = 10): string {
  return `SELECT ${ident(column)} AS value, count(*) AS n FROM ${profileFrom(src)} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${limit}`
}

export type ColumnFamily = 'number' | 'temporal' | 'text' | 'boolean' | 'nested' | 'other'

export function columnFamily(type: string): ColumnFamily {
  const t = type.trim().toUpperCase()
  if (/\[\]$|^(STRUCT|MAP|LIST|UNION|ARRAY)\b/.test(t)) return 'nested'
  if (/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)\b/.test(t)) return 'number'
  if (/^(DATE|TIMESTAMP|TIMESTAMPTZ|DATETIME)\b/.test(t)) return 'temporal'
  if (/^BOOL/.test(t)) return 'boolean'
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|UUID|JSON|ENUM)\b/.test(t)) return 'text'
  return 'other'
}

/** Equal-width histogram over a number or date/time column: bucket 0…bins-1 +
 *  count, plus the range (`lo`/`hi`, epoch seconds for date/time). */
export function histogramStatement(src: ProfileSource, column: string, family: 'number' | 'temporal', bins = 20): string {
  const c = ident(column)
  const v = family === 'temporal' ? `epoch(CAST(${c} AS TIMESTAMP))` : `CAST(${c} AS DOUBLE)`
  const from = profileFrom(src)
  return (
    `SELECT CAST(least(floor((${v} - s.lo) / nullif(s.hi - s.lo, 0) * ${bins}), ${bins - 1}) AS INTEGER) AS bucket, ` +
    `any_value(s.lo) AS lo, any_value(s.hi) AS hi, count(*) AS n FROM ${from}, ` +
    `(SELECT min(${v}) AS lo, max(${v}) AS hi FROM ${from}) AS s WHERE ${c} IS NOT NULL GROUP BY 1 ORDER BY 1`
  )
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** A JSON value from the driver as a number (BIGINT can arrive as a string). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1'
}

/** `"1.2 MiB"` (as pragma_database_size reports) → bytes, for sorting/bars. */
export function parseSize(text: unknown): number | null {
  const m = String(text ?? '').trim().match(/^([0-9.]+)\s*(bytes?|[KMGTP]i?B)$/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toUpperCase()
  if (unit.startsWith('BYTE')) return n
  const pow = 'KMGTP'.indexOf(unit[0]) + 1
  const base = unit.includes('I') ? 1024 : 1000
  return Math.round(n * base ** pow)
}

/** Extension status in words (the badge on the Extensions page). */
export function extensionStatus(row: { loaded?: unknown; installed?: unknown; install_mode?: unknown }): 'loaded' | 'installed' | 'available' {
  if (bool(row.loaded)) return 'loaded'
  if (bool(row.installed)) return 'installed'
  return 'available'
}
