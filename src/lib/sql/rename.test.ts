// Rename statements: unit checks + the fixture the real engines run
// (src-tauri/tests/rename_integration.rs runs setup → statements → checks on a real
// server, so a statement that only LOOKS right fails there).
//
// After an intentional change: WRITE_RENAME_FIXTURE=1 npx vitest run src/lib/sql/rename
// rewrites the fixture; then run the integration test.

import { describe, expect, it } from 'vitest'
import fixtureText from '../../../src-tauri/tests/fixtures/rename-statements.json?raw'
import { genRenameTable, isRunnable, oracleName } from './rename'
import { genRenameRoutine } from './routines'
import { genRenameDatabase, genRenameSchema } from './ddl'

describe('genRenameTable', () => {
  it('quotes both names per dialect and keeps the table in its schema', () => {
    expect(genRenameTable('postgres', 'public', 'students', 'pupils')).toBe('ALTER TABLE "public"."students" RENAME TO "pupils";')
    expect(genRenameTable('duckdb', 'main', 't', 'u')).toBe('ALTER TABLE "main"."t" RENAME TO "u";')
    expect(genRenameTable('sqlite', 'main', 't', 'u')).toBe('ALTER TABLE "t" RENAME TO "u";')
    // ALTER TABLE db.t RENAME TO u would move it to the session's database
    expect(genRenameTable('mysql', 'app', 't', 'u')).toBe('RENAME TABLE `app`.`t` TO `app`.`u`;')
    expect(genRenameTable('clickhouse', 'db', 't', 'u')).toBe('RENAME TABLE `db`.`t` TO `db`.`u`;')
    expect(genRenameTable('mssql', 'dbo', "it's", "o'k")).toBe("EXEC sp_rename N'[dbo].[it''s]', N'o''k';")
    expect(genRenameTable('oracle', 'APP', 'STUDENTS', 'pupils')).toBe('ALTER TABLE "APP"."STUDENTS" RENAME TO "PUPILS";')
    expect(genRenameTable('postgres', 'public', 'a"b', ' c"d ')).toBe('ALTER TABLE "public"."a""b" RENAME TO "c""d";')
  })

  it('engines without a table rename get an explanation, not a statement', () => {
    expect(isRunnable(genRenameTable('cassandra', 'ks', 't', 'u'))).toBe(false)
    expect(isRunnable(genRenameTable('postgres', 'public', 't', 'u'))).toBe(true)
    expect(isRunnable(genRenameDatabase('mysql', 'app', 'x'))).toBe(false)
  })

  it('Oracle folds a plain identifier to upper case and keeps anything else as typed', () => {
    expect(oracleName('pupils_2026')).toBe('PUPILS_2026')
    expect(oracleName('Mixed Case')).toBe('Mixed Case')
    expect(oracleName('1abc')).toBe('1abc')
  })

  it('MSSQL routine rename escapes quotes and brackets the old name', () => {
    expect(genRenameRoutine('mssql', 'dbo', 'procedure', 'p', 'q')).toBe("EXEC sp_rename N'[dbo].[p]', N'q';")
    expect(genRenameRoutine('mssql', 'My App', 'procedure', "p'1", "q'2")).toBe("EXEC sp_rename N'[My App].[p''1]', N'q''2';")
  })
})

// ---------------------------------------------------------------------------
// Fixture for the real engines
// ---------------------------------------------------------------------------

interface Case {
  system: 'postgres' | 'mysql' | 'mssql' | 'sqlite' | 'duckdb' | 'clickhouse'
  name: string
  setup: string[]
  statements: string[]
  /** first cell of the first row, as text */
  checks: { sql: string; expect: string }[]
}

function cases(): Case[] {
  return [
    {
      system: 'postgres',
      name: 'table, schema and function with spaces and quotes',
      setup: [
        'CREATE SCHEMA "My App"',
        'CREATE TABLE "My App"."order items" (id int PRIMARY KEY)',
        'INSERT INTO "My App"."order items" VALUES (1)',
        'CREATE FUNCTION "My App"."f old"(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1 $$',
        'CREATE SCHEMA "spare"',
      ],
      statements: [
        genRenameTable('postgres', 'My App', 'order items', `it's "new"`),
        genRenameRoutine('postgres', 'My App', 'function', 'f old', 'f new', ['integer']),
        genRenameSchema('postgres', 'spare', 'spare 2'),
      ],
      checks: [
        { sql: `SELECT COUNT(*) FROM "My App"."it's ""new"""`, expect: '1' },
        { sql: `SELECT COUNT(*) FROM pg_tables WHERE tablename = 'order items'`, expect: '0' },
        { sql: 'SELECT "My App"."f new"(1)', expect: '2' },
        { sql: `SELECT COUNT(*) FROM pg_namespace WHERE nspname = 'spare 2'`, expect: '1' },
      ],
    },
    {
      system: 'mysql',
      name: 'table stays in its own database (not the session default)',
      setup: ['CREATE DATABASE app', 'CREATE TABLE app.`order items` (id int PRIMARY KEY)', 'INSERT INTO app.`order items` VALUES (1)'],
      statements: [genRenameTable('mysql', 'app', 'order items', "it's new")],
      checks: [
        { sql: "SELECT COUNT(*) FROM app.`it's new`", expect: '1' },
        { sql: "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'testdb'", expect: '0' },
      ],
    },
    {
      system: 'mssql',
      name: 'table and procedure in a schema with a space, names with quotes',
      setup: [
        'CREATE SCHEMA [My App]',
        'CREATE TABLE [My App].[order items] (id int PRIMARY KEY)',
        'INSERT INTO [My App].[order items] VALUES (1)',
        "CREATE PROCEDURE [My App].[p old] AS SELECT 7",
      ],
      statements: [
        genRenameTable('mssql', 'My App', 'order items', "it's new"),
        genRenameRoutine('mssql', 'My App', 'procedure', 'p old', "p's new"),
      ],
      checks: [
        { sql: "SELECT COUNT(*) FROM [My App].[it's new]", expect: '1' },
        { sql: "SELECT COUNT(*) FROM sys.procedures WHERE name = 'p''s new'", expect: '1' },
        { sql: "SELECT COUNT(*) FROM sys.tables WHERE name = 'order items'", expect: '0' },
      ],
    },
    {
      system: 'sqlite',
      name: 'table',
      setup: ['CREATE TABLE "order items" (id int PRIMARY KEY)', 'INSERT INTO "order items" VALUES (1)'],
      statements: [genRenameTable('sqlite', 'main', 'order items', "it's new")],
      checks: [{ sql: `SELECT COUNT(*) FROM "it's new"`, expect: '1' }],
    },
    {
      system: 'duckdb',
      name: 'table in a schema with a space',
      setup: ['CREATE SCHEMA "My App"', 'CREATE TABLE "My App"."order items" (id int)', 'INSERT INTO "My App"."order items" VALUES (1)'],
      statements: [genRenameTable('duckdb', 'My App', 'order items', "it's new")],
      checks: [{ sql: `SELECT COUNT(*) FROM "My App"."it's new"`, expect: '1' }],
    },
    {
      system: 'clickhouse',
      name: 'table stays in its database',
      setup: ['CREATE DATABASE app', 'CREATE TABLE app.`order items` (id UInt32) ENGINE = MergeTree ORDER BY id', 'INSERT INTO app.`order items` VALUES (1)'],
      statements: [genRenameTable('clickhouse', 'app', 'order items', "it's new")],
      checks: [{ sql: "SELECT count() FROM app.`it's new`", expect: '1' }],
    },
  ]
}

const proc = (globalThis as { process?: { env?: Record<string, string | undefined>; cwd?: () => string } }).process
const env = proc?.env ?? {}
const FIXTURE = `${proc?.cwd?.() ?? '.'}/src-tauri/tests/fixtures/rename-statements.json`

describe('rename statements = the fixture the real engines run', () => {
  const now = cases()
  if (env.WRITE_RENAME_FIXTURE) {
    it('rewrites the fixture', async () => {
      const fsName = 'node:fs'
      const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync: (p: string, d: string) => void }
      fs.writeFileSync(FIXTURE, JSON.stringify({ cases: now }, null, 2) + '\n')
    })
    return
  }
  it('the generators still emit exactly what the engines were tested with', () => {
    expect(now).toEqual((JSON.parse(fixtureText) as { cases: Case[] }).cases)
  })
})
