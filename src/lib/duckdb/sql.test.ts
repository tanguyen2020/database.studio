// DuckDB workspace statements. The builders must produce EXACTLY the strings in
// src-tauri/tests/fixtures/duckdb-statements.json — that file is what
// duckdb_integration.rs runs on the real engine, so a builder that drifts from
// it fails here instead of shipping unverified SQL.
//
// After an intentional change: WRITE_DUCK_FIXTURE=1 npx vitest run src/lib/duckdb
// rewrites the fixture from the builders; then run the integration test.

import { describe, expect, it } from 'vitest'
import fixtureText from '../../../src-tauri/tests/fixtures/duckdb-statements.json?raw'
import {
  aliasFromPath,
  attachStatement,
  checkpointStatement,
  columnFamily,
  countFile,
  DATABASES_SQL,
  describeFile,
  detachStatement,
  detectFormat,
  exportDatabaseStatement,
  exportStatement,
  EXTENSIONS_SQL,
  extensionStatements,
  extensionStatus,
  fileReader,
  histogramStatement,
  importDatabaseStatement,
  importSelect,
  importStatement,
  LARGEST_TABLES_SQL,
  lit,
  MEMORY_SQL,
  missingExtension,
  num,
  OVERVIEW_SQL,
  parseSize,
  previewFile,
  resetSettingStatement,
  setSettingStatement,
  SETTINGS_SQL,
  summarizeStatement,
  tableNameFromPath,
  target,
  TEMP_FILES_SQL,
  topValuesStatement,
  type FileSource,
  type ProfileSource,
} from './sql'

const D = '{dir}'
const csv: FileSource = { path: `${D}/Sales 2026.csv`, format: 'csv', csv: { header: 'yes', delimiter: ';' } }
const json: FileSource = { path: `${D}/tags.json`, format: 'json', json: { format: 'array' } }
const sales: ProfileSource = { kind: 'table', schema: 'main', table: 'sales_2026' }

/** key → what the builders produce for that fixture step */
function built(): Record<string, string> {
  return {
    overview: OVERVIEW_SQL,
    databases: DATABASES_SQL,
    largest_tables: LARGEST_TABLES_SQL,
    memory: MEMORY_SQL,
    temp_files: TEMP_FILES_SQL,
    extensions: EXTENSIONS_SQL,
    settings: SETTINGS_SQL,
    'ext.load_json': extensionStatements('load', 'json')[0],
    'setting.threads': setSettingStatement('threads', '2'),
    'setting.insertion_order': setSettingStatement('preserve_insertion_order', 'false'),
    'setting.reset_threads': resetSettingStatement('threads'),
    'setting.reset_insertion_order': resetSettingStatement('preserve_insertion_order'),
    'file.describe_csv': describeFile(csv),
    'file.preview_csv': previewFile(csv),
    'file.count_csv': countFile(csv),
    'file.preview_json': previewFile(json),
    'import.create': importStatement('create', 'main', 'sales_2026', importSelect(csv)),
    'import.append_columns': importStatement(
      'append',
      'main',
      'sales_2026',
      importSelect(csv, [
        { name: 'id', include: true, type: 'INTEGER', detected: 'BIGINT' },
        { name: 'name', include: true, type: '', detected: 'VARCHAR' },
        { name: 'amount', include: false, type: '', detected: 'DOUBLE' },
        { name: 'day', include: true, type: 'date', detected: 'DATE' },
      ]),
    ),
    'import.replace_json': importStatement('replace', 'main', 'tags', importSelect(json)),
    'import.view': importStatement('view', 'main', 'sales_file', importSelect(csv)),
    'import.glob_union': previewFile({ path: `${D}/*.csv`, format: 'csv', csv: { delimiter: ';' }, filename: true, unionByName: true }),
    'export.parquet': exportStatement({ kind: 'table', schema: 'main', table: 'sales_2026' }, `${D}/sales.parquet`, { format: 'parquet' }),
    'export.csv_query': exportStatement({ kind: 'query', sql: 'SELECT * FROM main.sales_2026 WHERE id = 1;\n' }, `${D}/one.tsv`, {
      format: 'csv',
      delimiter: '\\t',
    }),
    'export.json': exportStatement({ kind: 'table', schema: 'main', table: 'sales_2026' }, `${D}/sales.json`, { format: 'json' }),
    'export.ndjson': exportStatement({ kind: 'table', schema: 'main', table: 'sales_2026' }, `${D}/sales.ndjson`, { format: 'ndjson' }),
    'export.partitioned': exportStatement({ kind: 'table', schema: 'main', table: 'sales_2026' }, `${D}/by_day`, {
      format: 'parquet',
      compression: 'snappy',
      partitionBy: ['day'],
      overwrite: true,
    }),
    'verify.parquet': countFile({ path: `${D}/sales.parquet`, format: 'parquet' }),
    'verify.tsv': previewFile({ path: `${D}/one.tsv`, format: 'csv', csv: { header: 'yes', delimiter: '\\t' } }),
    'verify.json': countFile({ path: `${D}/sales.json`, format: 'json', json: { format: 'array' } }),
    'verify.ndjson': countFile({ path: `${D}/sales.ndjson`, format: 'json', json: { format: 'newline_delimited' } }),
    'verify.partitioned': countFile({ path: `${D}/by_day/*/*.parquet`, format: 'parquet', unionByName: true }),
    'db.attach': attachStatement(`${D}/lake.duckdb`, 'lake'),
    'db.checkpoint_lake': checkpointStatement('lake'),
    'db.export': exportDatabaseStatement(`${D}/lake_export`, 'parquet', 'lake'),
    'db.detach': detachStatement('lake'),
    'db.attach_ro': attachStatement(`${D}/lake.duckdb`, 'lake_ro', { readOnly: true }),
    'db.detach_ro': detachStatement('lake_ro'),
    'db.import': importDatabaseStatement(`${D}/lake_export`),
    'profile.summarize_table': summarizeStatement(sales),
    'profile.summarize_query': summarizeStatement({ kind: 'query', sql: previewFile(csv) }),
    'profile.top_values': topValuesStatement(sales, 'name'),
    'profile.histogram_number': histogramStatement(sales, 'amount', 'number'),
    'profile.histogram_temporal': histogramStatement(sales, 'day', 'temporal'),
    'profile.histogram_query': histogramStatement({ kind: 'query', sql: 'SELECT * FROM main.trips' }, 'id', 'number'),
    'file.preview_xlsx_missing_extension': previewFile({ path: `${D}/book.xlsx`, format: 'xlsx', xlsx: { sheet: 'Data' } }),
    'db.attach_sqlite_missing_extension': attachStatement(`${D}/legacy.db`, 'legacy', { type: 'sqlite', readOnly: true }),
    'db.checkpoint': checkpointStatement(),
    'db.force_checkpoint': checkpointStatement(null, true),
  }
}

const FIXTURE = new URL('../../../src-tauri/tests/fixtures/duckdb-statements.json', import.meta.url)
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

describe('DuckDB workspace statements = the fixture the real engine runs', () => {
  const fixture = JSON.parse(fixtureText) as { steps: { key: string; sql: string }[] }
  const b = built()

  if (env.WRITE_DUCK_FIXTURE) {
    it('rewrites the fixture from the builders', async () => {
      for (const s of fixture.steps) if (b[s.key] !== undefined) s.sql = b[s.key]
      const fsName = 'node:fs'
      const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync: (p: URL, d: string) => void }
      fs.writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n')
    })
  }

  it('every builder output has a fixture step and matches it', () => {
    const steps = new Map(fixture.steps.map((s) => [s.key, s.sql]))
    for (const [key, sql] of Object.entries(b)) {
      expect(steps.has(key), `fixture step ${key}`).toBe(true)
      expect(steps.get(key), key).toBe(sql)
    }
  })

  it('every non-setup fixture step comes from a builder', () => {
    for (const s of fixture.steps) {
      if (s.key.startsWith('setup.')) continue
      expect(b[s.key], `builder for ${s.key}`).toBeDefined()
    }
  })
})

describe('DuckDB statement builders', () => {
  it('quotes identifiers and literals', () => {
    expect(lit("it's C:\\x")).toBe("'it''s C:\\x'")
    expect(target('main', 'a"b')).toBe('"main"."a""b"')
    expect(target('main', 't', 'lake')).toBe('"lake"."main"."t"')
  })

  it('reader emits only the options the user changed', () => {
    expect(fileReader({ path: 'a.csv', format: 'csv' })).toBe("read_csv('a.csv')")
    expect(fileReader({ path: 'a.csv', format: 'csv', csv: { header: 'no', skip: 2, allVarchar: true, quote: '"' } })).toBe(
      `read_csv('a.csv', header = false, quote = '"', skip = 2, all_varchar = true)`,
    )
    expect(fileReader({ path: 'a.parquet', format: 'parquet' })).toBe("read_parquet('a.parquet')")
    expect(fileReader({ path: 'b.xlsx', format: 'xlsx', filename: true })).toBe("read_xlsx('b.xlsx')")
  })

  it('import keeps SELECT * until a column is dropped or re-typed', () => {
    const cols = [{ name: 'a', include: true, type: 'bigint', detected: 'BIGINT' }]
    expect(importSelect({ path: 'x.parquet', format: 'parquet' }, cols)).toBe("SELECT * FROM read_parquet('x.parquet')")
    expect(importStatement('create', 'main', 't', 'SELECT 1', 'lake')).toBe('CREATE TABLE "lake"."main"."t" AS SELECT 1')
  })

  it('detects the file format and derives names', () => {
    expect(detectFormat('C:\\data\\x.CSV')).toBe('csv')
    expect(detectFormat('s3://b/k/part-0.parquet')).toBe('parquet')
    expect(detectFormat('/a/b.jsonl.gz')).toBe('json')
    expect(detectFormat('/a/b.xlsx')).toBe('xlsx')
    expect(detectFormat('/a/b.dat')).toBeNull()
    expect(tableNameFromPath('C:\\x\\Doanh thu Quý 1 (final).csv')).toBe('doanh_thu_quy_1_final')
    expect(tableNameFromPath('/x/2026-sales.csv.gz')).toBe('t_2026_sales')
    expect(tableNameFromPath('/x/*.parquet')).toBe('imported')
    expect(aliasFromPath('/x/2026.duckdb')).toBe('db_2026')
    expect(aliasFromPath('/x/Lake House.duckdb')).toBe('lake_house')
  })

  it('refuses names that are not identifiers', () => {
    expect(() => setSettingStatement('threads; DROP', '1')).toThrow()
    expect(() => extensionStatements('install', "x'")).toThrow()
    expect(extensionStatements('install-load', 'httpfs')).toEqual(['INSTALL httpfs', 'LOAD httpfs'])
    expect(extensionStatements('update', 'spatial')).toEqual(['UPDATE EXTENSIONS (spatial)'])
  })

  it('names the extension an error is asking for', () => {
    expect(missingExtension('Catalog Error: Table Function with name "read_xlsx" is not in the catalog, but it exists in the excel extension.')).toBe('excel')
    expect(missingExtension('Missing Extension Error: File https://x/a.parquet requires the extension httpfs to be loaded')).toBe('httpfs')
    expect(missingExtension('IO Error: Extension "C:\\Users\\u\\.duckdb\\extensions\\v1.5.6\\windows_amd64\\sqlite_scanner.duckdb_extension" not found.')).toBe(
      'sqlite_scanner',
    )
    expect(missingExtension('Binder Error: column x not found')).toBeNull()
  })

  it('reads driver values', () => {
    expect(num('12')).toBe(12)
    expect(num(null)).toBeNull()
    expect(parseSize('1.5 MiB')).toBe(1572864)
    expect(parseSize('512 bytes')).toBe(512)
    expect(parseSize('2.0 GB')).toBe(2_000_000_000)
    expect(parseSize('n/a')).toBeNull()
    expect(extensionStatus({ loaded: true, installed: true })).toBe('loaded')
    expect(extensionStatus({ loaded: false, installed: true })).toBe('installed')
    expect(extensionStatus({ loaded: false, installed: false })).toBe('available')
    expect(columnFamily('DECIMAL(18,3)')).toBe('number')
    expect(columnFamily('TIMESTAMP WITH TIME ZONE')).toBe('temporal')
    expect(columnFamily('INTEGER[]')).toBe('nested')
    expect(columnFamily('VARCHAR')).toBe('text')
  })
})
