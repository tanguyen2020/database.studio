import { describe, expect, it } from 'vitest'
import { compareSchemas, diffCounts, genMigration, lineDiff, type SchemaSnapshot } from './diff'

const col = (name: string, type: string, pk = false, nullable = true) => ({ name, type, pk, nullable })

const src: SchemaSnapshot = {
  tables: [
    { name: 'users', kind: 'table', columns: [col('id', 'int4', true, false), col('email', 'varchar')] },
    { name: 'orders', kind: 'table', columns: [col('id', 'int4', true, false)] }, // src only
    { name: 'logs', kind: 'table', columns: [col('id', 'int4'), col('msg', 'text')] }, // changed
  ],
}
const tgt: SchemaSnapshot = {
  tables: [
    { name: 'users', kind: 'table', columns: [col('id', 'int4', true, false), col('email', 'varchar')] }, // identical
    { name: 'legacy', kind: 'table', columns: [col('id', 'int4')] }, // tgt only
    { name: 'logs', kind: 'table', columns: [col('id', 'int4'), col('msg', 'varchar')] }, // msg type differs
  ],
}

describe('compareSchemas', () => {
  const diffs = compareSchemas(src, tgt)
  const byName = (n: string) => diffs.find((d) => d.name === n)!

  it('classifies identical / src_only / tgt_only / different', () => {
    expect(byName('users').status).toBe('identical')
    expect(byName('orders').status).toBe('src_only')
    expect(byName('legacy').status).toBe('tgt_only')
    expect(byName('logs').status).toBe('different')
  })

  it('column-level diff detects type change', () => {
    const msg = byName('logs').columns.find((c) => c.name === 'msg')!
    expect(msg.status).toBe('different')
    expect(msg.srcType).toBe('text')
    expect(msg.tgtType).toBe('varchar')
  })

  it('diffCounts', () => {
    expect(diffCounts(diffs)).toEqual({ add: 1, changed: 1, del: 1 })
  })
})

describe('genMigration', () => {
  const diffs = compareSchemas(src, tgt)
  it('CREATE for src_only, DROP for tgt_only, ALTER for different (postgres)', () => {
    const sql = genMigration(diffs, 'postgres')
    expect(sql).toContain('CREATE TABLE "orders"')
    expect(sql).toContain('DROP TABLE "legacy";')
    expect(sql).toContain('ALTER TABLE "logs" ALTER COLUMN "msg" TYPE text;')
  })

  it('MySQL uses MODIFY COLUMN', () => {
    const sql = genMigration(diffs, 'mysql')
    expect(sql).toContain('MODIFY COLUMN `msg` text')
  })

  it('respects selected set', () => {
    const sql = genMigration(diffs, 'postgres', new Set(['orders']))
    expect(sql).toContain('CREATE TABLE "orders"')
    expect(sql).not.toContain('legacy')
  })
})

describe('routines/triggers diff + migration (T19)', () => {
  const s: SchemaSnapshot = {
    tables: [],
    routines: [
      { name: 'add_one', kind: 'function', ddl: 'CREATE FUNCTION add_one(x int) RETURNS int AS $$ SELECT x + 1 $$' },
      { name: 'only_src', kind: 'procedure', ddl: 'CREATE PROCEDURE only_src() AS $$ BEGIN END $$' },
    ],
  }
  const t: SchemaSnapshot = {
    tables: [],
    routines: [
      { name: 'add_one', kind: 'function', ddl: 'CREATE FUNCTION add_one(x int) RETURNS int AS $$ SELECT x + 2 $$' }, // different body
      { name: 'only_tgt', kind: 'function', ddl: 'CREATE FUNCTION only_tgt() RETURNS int AS $$ SELECT 0 $$' },
    ],
  }
  const diffs = compareSchemas(s, t)
  const by = (n: string) => diffs.find((d) => d.name === n)!

  it('classifies routine DDL differences', () => {
    expect(by('add_one').status).toBe('different')
    expect(by('add_one').kind).toBe('function')
    expect(by('only_src').status).toBe('src_only')
    expect(by('only_tgt').status).toBe('tgt_only')
  })

  it('normalizes whitespace/case when comparing DDL', () => {
    const a: SchemaSnapshot = { tables: [], routines: [{ name: 'f', kind: 'function', ddl: 'CREATE  FUNCTION f()\n  RETURNS int' }] }
    const b: SchemaSnapshot = { tables: [], routines: [{ name: 'f', kind: 'function', ddl: 'create function f() returns int' }] }
    expect(compareSchemas(a, b).find((d) => d.name === 'f')!.status).toBe('identical')
  })

  it('migration: source DDL for different/src_only, DROP for tgt_only', () => {
    const sql = genMigration(diffs, 'postgres')
    expect(sql).toContain('SELECT x + 1') // add_one replaced with source body
    expect(sql).toContain('CREATE PROCEDURE only_src') // src_only created
    expect(sql).toContain('DROP FUNCTION IF EXISTS "only_tgt";') // tgt_only dropped
  })
})

describe('lineDiff', () => {
  it('marks add/del/same lines (SOURCE vs TARGET)', () => {
    const d = lineDiff('a\nb\nc', 'a\nx\nc')
    expect(d.filter((l) => l.type === 'same').map((l) => l.text)).toEqual(['a', 'c'])
    expect(d.some((l) => l.type === 'del' && l.text === 'b')).toBe(true)
    expect(d.some((l) => l.type === 'add' && l.text === 'x')).toBe(true)
  })
})
