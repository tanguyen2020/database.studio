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

  // Quoted identifiers: without these the name was split on the characters that
  // forced the quoting in the first place, so the ref never resolved and the
  // table's columns were never offered.
  it('reads backtick-quoted names whose text is not bare-legal (MySQL)', () => {
    // a database name with a hyphen — read bare it became table `ismart` + alias `eco`
    expect(parseTableRefs('SELECT * FROM `ismart-eco`.`course_test` c')).toEqual([
      { schema: 'ismart-eco', table: 'course_test', alias: 'c' },
    ])
  })

  it('reads a backtick database name containing dots', () => {
    expect(parseTableRefs('SELECT * FROM `crm.ismart.edu.vn`.`students`')).toEqual([
      { schema: 'crm.ismart.edu.vn', table: 'students', alias: undefined },
    ])
  })

  it('reads double-quoted names (PG/SQLite/Oracle), keyword names included', () => {
    expect(parseTableRefs('SELECT * FROM "public"."Order" o')).toEqual([
      { schema: 'public', table: 'Order', alias: 'o' },
    ])
    // a quoted keyword IS a table name, not a clause boundary
    expect(parseTableRefs('SELECT * FROM "order"')).toEqual([
      { schema: undefined, table: 'order', alias: undefined },
    ])
  })

  it('reads bracket-quoted names (MSSQL)', () => {
    expect(parseTableRefs('SELECT * FROM [dbo].[my table] t JOIN [dbo].[other] o ON t.id=o.id')).toEqual([
      { schema: 'dbo', table: 'my table', alias: 't' },
      { schema: 'dbo', table: 'other', alias: 'o' },
    ])
  })

  it('does not read tables out of string literals', () => {
    expect(parseTableRefs("SELECT * FROM users u WHERE note = 'from ghost g'")).toEqual([
      { schema: undefined, table: 'users', alias: 'u' },
    ])
  })

  it('survives a literal with an escaped quote (MySQL \\\' and SQL \'\')', () => {
    // a literal that swallowed the rest of the statement would lose the JOIN
    const refs = parseTableRefs("SELECT * FROM users u WHERE note = 'it\\'s here' JOIN orders o ON u.id=o.uid")
    expect(refs.map((r) => r.table)).toContain('orders')
    expect(parseTableRefs("SELECT * FROM users u WHERE n = 'it''s' JOIN orders o ON 1=1").map((r) => r.table)).toEqual([
      'users',
      'orders',
    ])
  })

  it('reads an escaped closing bracket in an MSSQL name', () => {
    expect(parseTableRefs('SELECT * FROM [odd]]name] x')).toEqual([
      { schema: undefined, table: 'odd]name', alias: 'x' },
    ])
  })

  // Shapes that must keep behaving as before this parser was rewritten.
  it('still reads the tables of a CTE body and its use', () => {
    const refs = parseTableRefs('WITH recent AS (SELECT * FROM orders o) SELECT * FROM recent r')
    expect(refs.map((r) => [r.table, r.alias])).toEqual([
      ['orders', 'o'],
      ['recent', 'r'],
    ])
  })

  it('still skips a derived table but reads the joined one', () => {
    const refs = parseTableRefs('SELECT * FROM (SELECT 1) x JOIN customers c ON 1=1')
    expect(refs.map((r) => r.table)).toContain('customers')
  })

  it('keeps case as written (identifiers are case-sensitive when quoted)', () => {
    expect(parseTableRefs('SELECT * FROM Students S')).toEqual([
      { schema: undefined, table: 'Students', alias: 'S' },
    ])
  })

  it('resolves a quoted table by its real name', () => {
    const refs = parseTableRefs('SELECT * FROM `ismart-eco`.`course_test`')
    expect(resolveRef(refs, 'course_test')?.schema).toBe('ismart-eco')
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
