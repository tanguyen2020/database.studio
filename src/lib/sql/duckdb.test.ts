// DuckDB across the pure SQL helpers: every generator emits DuckDB-valid SQL
// (the exact strings are executed on the real engine in
// src-tauri/tests/duckdb_integration.rs → duckdb_generated_statements_run), and
// adding DuckDB left the other engines' output untouched.

import { describe, expect, it } from 'vitest'
import {
  genAlterTable,
  genCreateDatabase,
  genCreateSchema,
  genDropDatabase,
  genDropSchema,
  genRenameDatabase,
  genRenameSchema,
  genSelect,
  hasRealSchemas,
} from './ddl'
import { createTemplate } from './create-templates'
import { dataTypes, defaultColumnType } from './datatypes'
import { toAlterStatement } from './alter'
import { genCreateIndex, genDropIndex } from './indexes'
import { genTruncateStatements, truncateOptions } from './truncate'
import { supportsTxn } from './txn'
import { quoteIfReserved } from './reserved'
import { formatSql } from './format'
import { qualified, quoteIdent } from './dialect'
import { classifyType, mapColumnType } from '$lib/copy/types'
import { conflictSupported, insertPrefix } from '$lib/import/plan'
import { supportsOffset } from '$lib/export/query'
import { editorLanguageId, SQL_SYSTEMS, sqlDialectFor } from '$lib/editor/dialect'
import { rootNodeKey } from '$lib/explorer/expand'

describe('DuckDB DDL generators', () => {
  it('quotes with double quotes and qualifies with the real schema', () => {
    expect(quoteIdent('duckdb', 'my "t"')).toBe('"my ""t"""')
    expect(qualified('duckdb', 'main', 'orders')).toBe('"main"."orders"')
    expect(genSelect('duckdb', 'main', 'orders', [])).toBe('SELECT *\nFROM "main"."orders"\nLIMIT 100;')
  })

  it('has real schemas: create / drop (RESTRICT by default) — rename is explained, not faked', () => {
    expect(hasRealSchemas('duckdb')).toBe(true)
    expect(genCreateSchema('duckdb', 'sales')).toBe('CREATE SCHEMA IF NOT EXISTS "sales";')
    expect(genDropSchema('duckdb', 'sales')).toBe('DROP SCHEMA IF EXISTS "sales" RESTRICT;')
    expect(genDropSchema('duckdb', 'sales', true)).toBe('DROP SCHEMA IF EXISTS "sales" CASCADE;')
    expect(genRenameSchema('duckdb', 'sales', 'x').startsWith('--')).toBe(true)
  })

  it('a database is an attached file: drop = DETACH (file kept); create/rename explain ATTACH', () => {
    expect(genDropDatabase('duckdb', 'other')).toBe('DETACH DATABASE IF EXISTS "other";')
    expect(genCreateDatabase('duckdb', 'lake')).toContain(`ATTACH '<path>/lake.duckdb' AS "lake";`)
    expect(genCreateDatabase('duckdb', 'lake').startsWith('--')).toBe(true)
    expect(genRenameDatabase('duckdb', 'lake', 'lake2').startsWith('--')).toBe(true)
  })

  it('ALTER TABLE / index / truncate statements', () => {
    expect(genAlterTable('duckdb', 'sales', 'orders')).toBe('ALTER TABLE "sales"."orders"\n  ADD COLUMN "new_column" INT;')
    expect(genCreateIndex('duckdb', 'sales', 'orders', { name: 'ix_amount', columns: ['amount'], unique: false })).toBe(
      'CREATE INDEX "ix_amount" ON "sales"."orders" ("amount");',
    )
    expect(genDropIndex('duckdb', 'sales', 'orders', 'ix_amount')).toBe('DROP INDEX IF EXISTS "sales"."ix_amount";')
    expect(truncateOptions('duckdb').map((o) => o.variant)).toEqual(['plain'])
    expect(genTruncateStatements('duckdb', 'sales', 'orders', 'plain')).toEqual(['TRUNCATE TABLE "sales"."orders";'])
  })

  it('create templates: sequences + macros; no procedures / triggers', () => {
    expect(createTemplate('duckdb', 'sequence', 'sales')).toBe('CREATE SEQUENCE "sales"."new_sequence"\n  START WITH 1\n  INCREMENT BY 1;')
    expect(createTemplate('duckdb', 'function', 'sales')).toBe('CREATE OR REPLACE MACRO "sales"."new_function"(a, b) AS\n  a + b;')
    expect(createTemplate('duckdb', 'procedure', 'sales')).toBe('-- DuckDB does not support stored procedures')
    expect(createTemplate('duckdb', 'trigger', 'sales')).toBe('-- DuckDB does not support triggers')
  })

  it('Alter re-runs a definition in place with CREATE OR REPLACE', () => {
    expect(toAlterStatement('duckdb', 'view', 'main', 'v', 'CREATE VIEW v AS SELECT 1;')).toBe('CREATE OR REPLACE VIEW v AS SELECT 1;')
    const macro = 'CREATE OR REPLACE MACRO "main"."m"(x) AS (x * 2);'
    expect(toAlterStatement('duckdb', 'function', 'main', 'm', macro)).toBe(macro)
  })
})

describe('DuckDB in the shared helpers', () => {
  it('type catalog for the Table Designer', () => {
    const t = dataTypes('duckdb')
    for (const ty of ['INTEGER', 'HUGEINT', 'DECIMAL', 'VARCHAR', 'TIMESTAMPTZ', 'UUID', 'JSON', 'INTEGER[]']) expect(t).toContain(ty)
    expect(new Set(t).size).toBe(t.length)
    expect(defaultColumnType('duckdb')).toBe('INTEGER')
  })

  it('copy table maps DuckDB types to families and families to DuckDB types', () => {
    expect(classifyType('HUGEINT')).toBe('bigint')
    expect(classifyType('UBIGINT')).toBe('bigint')
    expect(classifyType('UINTEGER')).toBe('int')
    expect(classifyType('DECIMAL(18,3)')).toBe('decimal')
    expect(classifyType('TIMESTAMP WITH TIME ZONE')).toBe('timestamp')
    expect(mapColumnType('jsonb', 'duckdb')).toBe('JSON')
    expect(mapColumnType('uuid', 'duckdb')).toBe('UUID')
    expect(mapColumnType('nvarchar(max)', 'duckdb')).toBe('VARCHAR')
  })

  it('import skips duplicates with INSERT OR IGNORE; export pages with LIMIT/OFFSET; transactions tracked', () => {
    expect(conflictSupported('duckdb')).toBe(true)
    expect(insertPrefix('duckdb', 'skip')).toBe('INSERT OR IGNORE INTO')
    expect(insertPrefix('duckdb', 'error')).toBe('INSERT INTO')
    expect(supportsOffset('duckdb')).toBe(true)
    expect(supportsTxn('duckdb')).toBe(true)
  })

  it('auto-quotes DuckDB reserved words only (unreserved words stay bare)', () => {
    expect(quoteIfReserved('duckdb', 'order')).toBe('"order"')
    expect(quoteIfReserved('duckdb', 'qualify')).toBe('"qualify"')
    expect(quoteIfReserved('duckdb', 'summarize')).toBe('"summarize"')
    // type_function keywords break as a bare column too (verified on the engine)
    expect(quoteIfReserved('duckdb', 'at')).toBe('"at"')
    expect(quoteIfReserved('duckdb', 'left')).toBe('"left"')
    // column_name keywords work bare
    expect(quoteIfReserved('duckdb', 'between')).toBe('between')
    expect(quoteIfReserved('duckdb', 'schedule')).toBe('schedule')
    expect(quoteIfReserved('duckdb', 'type')).toBe('type')
  })

  it('formats with sql-formatter\'s DuckDB dialect', () => {
    expect(formatSql('duckdb', 'select a from t where b=1')).toBe('SELECT\n  a\nFROM\n  t\nWHERE\n  b = 1')
  })

  it('editor: its own language id + a PostgreSQL-based dialect with DuckDB\'s words', () => {
    expect(SQL_SYSTEMS).toContain('duckdb')
    expect(editorLanguageId('duckdb')).toBe('ds-duckdb')
    const spec = sqlDialectFor('duckdb').spec
    expect(spec.keywords).toMatch(/\bsummarize\b/)
    expect(spec.keywords).toMatch(/\bqualify\b/)
    expect(spec.types).toMatch(/\bhugeint\b/)
    expect(spec.identifierQuotes ?? '"').toBe('"')
  })

  it('explorer nests the schemas under the current database', () => {
    expect(rootNodeKey('duckdb')).toBe('curdb')
  })
})

describe('other engines are unchanged by DuckDB', () => {
  it('SQLite / PG / MySQL outputs stay as before', () => {
    expect(hasRealSchemas('sqlite')).toBe(false)
    expect(genDropDatabase('postgres', 'x')).toBe('DROP DATABASE IF EXISTS "x";')
    expect(insertPrefix('sqlite', 'skip')).toBe('INSERT OR IGNORE INTO')
    expect(insertPrefix('postgres', 'skip')).toBe('INSERT INTO')
    expect(createTemplate('clickhouse', 'sequence', 'db')).toBe('-- Clickhouse does not support standalone sequences')
    expect(defaultColumnType('sqlite')).toBe('INTEGER')
    expect(classifyType('UInt64')).toBe('text')
    expect(quoteIfReserved('mysql', 'schedule')).toBe('`schedule`')
  })
})
