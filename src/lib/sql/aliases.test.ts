import { describe, it, expect } from 'vitest'
import { parseTableRefs, resolveRef } from './aliases'

describe('parseTableRefs', () => {
  it('reads a bare table with an alias', () => {
    expect(parseTableRefs('SELECT * FROM users u')).toEqual([{ schema: undefined, table: 'users', alias: 'u' }])
  })

  it('reads AS alias', () => {
    expect(parseTableRefs('SELECT * FROM users AS u')).toEqual([{ schema: undefined, table: 'users', alias: 'u' }])
  })

  it('reads a schema-qualified table', () => {
    expect(parseTableRefs('SELECT * FROM public.users u')).toEqual([{ schema: 'public', table: 'users', alias: 'u' }])
  })

  it('reads a table with no alias', () => {
    expect(parseTableRefs('SELECT * FROM users')).toEqual([{ schema: undefined, table: 'users', alias: undefined }])
  })

  it('does not treat a clause keyword as an alias', () => {
    expect(parseTableRefs('SELECT * FROM users WHERE id = 1')).toEqual([
      { schema: undefined, table: 'users', alias: undefined },
    ])
  })

  it('reads a JOIN with aliases and ON', () => {
    const refs = parseTableRefs('SELECT * FROM orders o JOIN customers c ON o.cid = c.id')
    expect(refs).toEqual([
      { schema: undefined, table: 'orders', alias: 'o' },
      { schema: undefined, table: 'customers', alias: 'c' },
    ])
  })

  it('reads a comma-separated FROM list', () => {
    const refs = parseTableRefs('SELECT * FROM a x, b.c y, d')
    expect(refs).toEqual([
      { schema: undefined, table: 'a', alias: 'x' },
      { schema: 'b', table: 'c', alias: 'y' },
      { schema: undefined, table: 'd', alias: undefined },
    ])
  })

  it('handles multiple joins', () => {
    const refs = parseTableRefs(
      'SELECT * FROM t1 a LEFT JOIN t2 b ON a.k=b.k INNER JOIN t3 c ON b.k=c.k',
    )
    expect(refs.map((r) => [r.table, r.alias])).toEqual([
      ['t1', 'a'],
      ['t2', 'b'],
      ['t3', 'c'],
    ])
  })

  it('ignores comments', () => {
    const refs = parseTableRefs('SELECT * FROM users u -- FROM ghost g\n WHERE 1=1')
    expect(refs).toEqual([{ schema: undefined, table: 'users', alias: 'u' }])
  })
})

describe('resolveRef', () => {
  const refs = parseTableRefs('SELECT * FROM orders o JOIN customers c ON o.cid = c.id')

  it('resolves by alias', () => {
    expect(resolveRef(refs, 'o')).toEqual({ schema: undefined, table: 'orders', alias: 'o' })
    expect(resolveRef(refs, 'c')).toEqual({ schema: undefined, table: 'customers', alias: 'c' })
  })

  it('resolves by table name', () => {
    expect(resolveRef(refs, 'orders')).toEqual({ schema: undefined, table: 'orders', alias: 'o' })
  })

  it('is case-insensitive', () => {
    expect(resolveRef(refs, 'O')?.table).toBe('orders')
  })

  it('returns undefined for an unknown prefix', () => {
    expect(resolveRef(refs, 'zzz')).toBeUndefined()
  })

  it('prefers an alias match over a bare table match', () => {
    const r = parseTableRefs('SELECT * FROM a b, x a')
    // prefix "a": alias of the second ref (table x) wins over table "a"
    expect(resolveRef(r, 'a')).toEqual({ schema: undefined, table: 'x', alias: 'a' })
  })
})
