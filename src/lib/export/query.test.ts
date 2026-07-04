import { describe, expect, it } from 'vitest'
import { buildExportSelect, supportsOffset } from './query'
import { toCsv, toSqlInsert } from './rows'

describe('buildExportSelect', () => {
  it('all columns, no filter → SELECT *', () => {
    expect(buildExportSelect({ system: 'postgres', schema: 'public', table: 'students' })).toBe(
      'SELECT * FROM "public"."students"',
    )
  })

  it('column subset + WHERE + LIMIT (Postgres)', () => {
    const sql = buildExportSelect({
      system: 'postgres',
      schema: 'public',
      table: 'students',
      columns: ['id', 'gpa'],
      where: "status = 'active'",
      limit: 100,
    })
    expect(sql).toBe(`SELECT "id", "gpa" FROM "public"."students" WHERE status = 'active' LIMIT 100`)
  })

  it('offset paging appended for streaming', () => {
    const sql = buildExportSelect({ system: 'mysql', schema: 'db', table: 't', limit: 5000, offset: 10000 })
    expect(sql).toBe('SELECT * FROM `db`.`t` LIMIT 5000 OFFSET 10000')
  })

  it('MSSQL uses TOP (no offset)', () => {
    const sql = buildExportSelect({ system: 'mssql', schema: 'dbo', table: 'exams', columns: ['id'], limit: 50 })
    expect(sql).toBe('SELECT TOP 50 [id] FROM [dbo].[exams]')
  })

  it('SQLite main schema → no qualifier', () => {
    expect(buildExportSelect({ system: 'sqlite', schema: 'main', table: 't', columns: ['a'] })).toBe(
      'SELECT "a" FROM "t"',
    )
  })

  it('supportsOffset: relational+CH yes, MSSQL/Cassandra no', () => {
    expect(supportsOffset('postgres')).toBe(true)
    expect(supportsOffset('clickhouse')).toBe(true)
    expect(supportsOffset('mssql')).toBe(false)
    expect(supportsOffset('cassandra')).toBe(false)
  })
})

describe('serialization with column subset', () => {
  const headers = ['id', 'first_name', 'gpa']
  const rows = [
    { id: 1, first_name: 'An', gpa: 3.9 },
    { id: 2, first_name: "O'Brien", gpa: null },
  ]

  it('CSV honors a chosen column subset', () => {
    const csv = toCsv(['id', 'gpa'], rows)
    expect(csv).toBe('id,gpa\n1,3.9\n2,')
  })

  it('SQL INSERT honors a chosen column subset', () => {
    const sql = toSqlInsert('students', ['id', 'first_name'], rows)
    expect(sql).toContain('INSERT INTO "students" ("id", "first_name") VALUES (1, \'An\');')
    expect(sql).toContain(`INSERT INTO "students" ("id", "first_name") VALUES (2, 'O''Brien');`)
    expect(sql).not.toContain('gpa')
  })
})
