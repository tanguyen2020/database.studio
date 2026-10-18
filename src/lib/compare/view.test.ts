import { describe, expect, it } from 'vitest'
import { columnKey, objectKey, type ObjectDiff } from './diff'
import { changeSummary, childrenOf, destructiveCount, keysOf, listed, objectScript, statusCounts } from './view'

const table = (name: string, status: ObjectDiff['status'], columns: ObjectDiff['columns'] = []): ObjectDiff => ({ kind: 'table', name, status, columns })
const index = (name: string, tbl: string, status: ObjectDiff['status']): ObjectDiff => ({
  kind: 'index',
  name,
  status,
  columns: [],
  idxTable: tbl,
  idxColumns: ['email'],
  idxUnique: false,
})

const users = table('users', 'different', [
  { name: 'id', status: 'identical', srcType: 'int', tgtType: 'int' },
  { name: 'email', status: 'src_only', srcType: 'text' },
  { name: 'age', status: 'different', srcType: 'bigint', tgtType: 'int' },
  { name: 'legacy', status: 'tgt_only', tgtType: 'text' },
])
const orders = table('orders', 'identical', [{ name: 'id', status: 'identical', srcType: 'int', tgtType: 'int' }])
const diffs = [users, orders, index('ix_users_email', 'users', 'src_only'), index('ix_orders_x', 'orders', 'tgt_only'), index('ix_same', 'orders', 'identical')]

describe('schema compare view rules', () => {
  it('summarises what changed in plain words', () => {
    expect(changeSummary(users, childrenOf(diffs, 'users'))).toBe('1 new column · 1 column changed · 1 extra column · 1 index to sync')
    expect(changeSummary(table('t', 'src_only', [{ name: 'a', status: 'src_only' }, { name: 'b', status: 'src_only' }]), { indexes: [], triggers: [] })).toBe('2 columns')
    expect(changeSummary(orders, childrenOf(diffs, 'orders'))).toBe('1 index to sync')
  })

  it('keeps a same table in the change list when one of its indexes changed', () => {
    expect(listed(orders, childrenOf(diffs, 'orders'), 'changes', '')).toBe(true)
    expect(listed(orders, { indexes: [], triggers: [] }, 'changes', '')).toBe(false)
    expect(listed(orders, { indexes: [], triggers: [] }, 'all', '')).toBe(true)
  })

  it('filters by status and by name (also matching child objects)', () => {
    expect(listed(users, childrenOf(diffs, 'users'), 'tgt_only', '')).toBe(false)
    expect(listed(users, childrenOf(diffs, 'users'), 'different', 'USE')).toBe(true)
    expect(listed(users, childrenOf(diffs, 'users'), 'all', 'nope')).toBe(false)
    expect(listed(users, childrenOf(diffs, 'users'), 'all', 'ix_users')).toBe(true)
  })

  it('collects every selection key of an object', () => {
    expect(keysOf(users, childrenOf(diffs, 'users'))).toEqual([
      objectKey(users),
      columnKey('users', 'email'),
      columnKey('users', 'age'),
      columnKey('users', 'legacy'),
      objectKey(diffs[2]),
    ])
  })

  it('shows the script one object contributes, without the migration header', () => {
    const sql = objectScript(users, childrenOf(diffs, 'users'), 'postgres')
    expect(sql).not.toMatch(/Migration: sync TARGET/)
    expect(sql).toContain('ADD COLUMN "email" text')
    expect(sql).toContain('ALTER COLUMN "age" TYPE bigint')
    expect(sql).toContain('DROP COLUMN "legacy"')
    expect(sql).toMatch(/CREATE INDEX .*ix_users_email/)
    expect(objectScript(orders, { indexes: [], triggers: [] }, 'postgres')).toBe('')
  })

  it('counts statuses and destructive statements', () => {
    expect(statusCounts(diffs)).toEqual({ src_only: 1, different: 1, tgt_only: 1, identical: 2 })
    expect(destructiveCount(['DROP TABLE "x";', 'ALTER TABLE "u" DROP COLUMN "a";', 'CREATE INDEX i ON t (a);', 'DROP INDEX i;'])).toBe(2)
    // the first split statement keeps the migration header comments above it
    expect(destructiveCount(['-- Migration: sync TARGET to match SOURCE\n-- Review carefully before running.\n\nDROP TABLE "audit_log"'])).toBe(1)
    // a comment that merely mentions DROP is not a destructive statement
    expect(destructiveCount(['-- DROP TABLE x\nCREATE TABLE y (a int)'])).toBe(0)
  })
})
