import { describe, expect, it } from 'vitest'
import { editableSource, matchResultColumns } from './editable-result'

const src = (sql: string, system = 'postgres') => editableSource(sql, system)
const table = (sql: string, system = 'postgres') => {
  const r = src(sql, system)
  return r.ok ? r.source : null
}

describe('editableSource — single-table SELECTs are editable', () => {
  it('reads the table, schema and alias of plain selects', () => {
    expect(table('SELECT * FROM students')).toEqual({ schema: null, table: 'students' })
    expect(table('select id, first_name from public.students where id > 2 order by id, first_name limit 50 offset 10;')).toEqual({
      schema: 'public',
      table: 'students',
    })
    expect(table('SELECT s.id, s.config FROM students s')).toEqual({ schema: null, table: 'students' })
    expect(table('SELECT s.* FROM students AS s WHERE s.id IN (SELECT id FROM other)')).toEqual({ schema: null, table: 'students' })
    expect(table('SELECT students.id FROM students')).toEqual({ schema: null, table: 'students' })
    expect(table('SELECT public.students.id FROM public.students')).toEqual({ schema: 'public', table: 'students' })
  })

  it('keeps quoted names and folds unquoted ones like the engine does', () => {
    expect(table('SELECT * FROM "Order Items"')).toEqual({ schema: null, table: 'Order Items' })
    expect(table('SELECT * FROM Students')).toEqual({ schema: null, table: 'students' }) // PG folds to lower
    expect(table('SELECT * FROM emp', 'oracle')).toEqual({ schema: null, table: 'EMP' }) // Oracle to upper
    expect(table('SELECT * FROM `ismart-eco`.`course_test`', 'mysql')).toEqual({ schema: 'ismart-eco', table: 'course_test' })
    expect(table('SELECT TOP (100) [id], [name] FROM [dbo].[users] WITH (NOLOCK)', 'mssql')).toEqual({ schema: 'dbo', table: 'users' })
    expect(table('SELECT TOP 10 PERCENT * FROM users', 'mssql')).toEqual({ schema: null, table: 'users' })
  })

  it('accepts clauses that keep one row per table row', () => {
    expect(table('SELECT * FROM t LIMIT 10, 20', 'mysql')).not.toBeNull()
    expect(table("SELECT * FROM t WHERE RIGHT(name, 1) = 'a' AND LEFT(code, 2) = 'x'")).not.toBeNull()
    expect(table('SELECT * FROM t FOR UPDATE')).not.toBeNull()
    expect(table('SELECT * FROM t FETCH FIRST 10 ROWS ONLY', 'oracle')).not.toBeNull()
    expect(table('SELECT * FROM t FINAL', 'clickhouse')).not.toBeNull()
    expect(table("SELECT * FROM t -- join in a comment\nWHERE note = 'group by'")).not.toBeNull()
  })
})

describe('editableSource — everything else stays read-only, with a reason', () => {
  const reason = (sql: string, system = 'postgres') => {
    const r = src(sql, system)
    return r.ok ? null : r.reason
  }
  it('rejects joins, grouping, set operations and several tables', () => {
    expect(reason('SELECT * FROM a JOIN b ON a.id = b.id')).toMatch(/joins/)
    expect(reason('SELECT * FROM a LEFT OUTER JOIN b ON true')).toMatch(/joins/)
    expect(reason('SELECT * FROM a, b')).toMatch(/more than one table/)
    expect(reason('SELECT a FROM t GROUP BY a')).toMatch(/grouped/)
    expect(reason('SELECT * FROM a UNION SELECT * FROM b')).toMatch(/combines/)
    expect(reason('SELECT DISTINCT a FROM t')).toMatch(/DISTINCT/)
    expect(reason('WITH x AS (SELECT 1) SELECT * FROM x')).toMatch(/WITH/)
    expect(reason('SELECT * FROM (SELECT * FROM t) s')).toMatch(/subquery/)
    expect(reason('SELECT * FROM generate_series(1, 3)')).toMatch(/table function/)
    expect(reason('SELECT * FROM t ARRAY JOIN arr', 'clickhouse')).toMatch(/joins/)
  })
  it('rejects computed or renamed columns', () => {
    expect(reason('SELECT count(*) FROM t')).toMatch(/plain columns/)
    expect(reason('SELECT id, price * 2 FROM t')).toMatch(/plain columns/)
    expect(reason('SELECT id AS student_id FROM t')).toMatch(/plain columns/)
    expect(reason('SELECT id student_id FROM t')).toMatch(/plain columns/)
    expect(reason("SELECT id, 'x' FROM t")).toMatch(/plain columns/)
  })
  it('rejects columns qualified by another table, other databases and non-SELECTs', () => {
    expect(reason('SELECT x.id FROM students s')).toMatch(/another table/)
    expect(reason('SELECT * FROM otherdb.dbo.users', 'mssql')).toMatch(/another database/)
    expect(reason('UPDATE t SET a = 1')).toMatch(/SELECT/)
    expect(reason('SELECT 1')).toMatch(/SELECT/)
    expect(reason('SELECT * FROM t', 'cassandra')).toMatch(/engine/)
  })
})

describe('matchResultColumns', () => {
  const cols = [
    { name: 'id', is_pk: true },
    { name: 'first_name', is_pk: false },
    { name: 'config', is_pk: false },
  ]
  it('returns the key under the name the result uses', () => {
    expect(matchResultColumns(['id', 'config'], cols, 'postgres')).toEqual({ ok: true, pkCols: ['id'] })
    // MySQL compares column names case-insensitively: the result's spelling is kept
    expect(matchResultColumns(['ID', 'config'], cols, 'mysql')).toEqual({ ok: true, pkCols: ['ID'] })
  })
  it('refuses when the key is missing, the table has none, or a column is not the table’s', () => {
    expect(matchResultColumns(['first_name'], cols, 'postgres')).toMatchObject({ ok: false, reason: expect.stringMatching(/primary key \(id\)/) })
    expect(matchResultColumns(['ID'], cols, 'postgres')).toMatchObject({ ok: false, reason: expect.stringMatching(/not a column/) })
    expect(
      matchResultColumns(['a'], [{ name: 'a', is_pk: false }], 'postgres'),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/no primary key/) })
    expect(matchResultColumns(['id', 'id'], cols, 'postgres')).toMatchObject({ ok: false, reason: expect.stringMatching(/two columns/) })
    expect(matchResultColumns(['id'], [], 'postgres')).toMatchObject({ ok: false })
  })
})
