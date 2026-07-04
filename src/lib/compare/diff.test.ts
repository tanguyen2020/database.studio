import { describe, expect, it } from 'vitest'
import { compareSchemas, diffCounts, genMigration, type SchemaSnapshot } from './diff'

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
