import { describe, expect, it } from 'vitest'
import { csvCell, toCsv, toSqlInsert, parseCsv } from './rows'

describe('csvCell', () => {
  it('quotes cells with comma/quote/newline and doubles quotes', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell(null)).toBe('')
    expect(csvCell(42)).toBe('42')
  })
})

describe('toCsv', () => {
  it('emits header + rows keyed by header', () => {
    const csv = toCsv(['id', 'name'], [{ id: 1, name: 'A' }, { id: 2, name: 'B,C' }])
    expect(csv).toBe('id,name\n1,A\n2,"B,C"')
  })
  it('header only when no rows', () => {
    expect(toCsv(['a'], [])).toBe('a')
  })
})

describe('parseCsv', () => {
  it('parses headers + rows', () => {
    const { headers, rows } = parseCsv('id,name\n1,Alice\n2,Bob')
    expect(headers).toEqual(['id', 'name'])
    expect(rows).toEqual([['1', 'Alice'], ['2', 'Bob']])
  })
  it('handles quoted fields with commas, newlines and escaped quotes', () => {
    const { rows } = parseCsv('a,b\n"x,y","line1\nline2"\n"say ""hi""",z')
    expect(rows[0]).toEqual(['x,y', 'line1\nline2'])
    expect(rows[1]).toEqual(['say "hi"', 'z'])
  })
  it('skips blank lines and supports custom delimiter', () => {
    const { headers, rows } = parseCsv('a;b\n1;2\n\n3;4', ';')
    expect(headers).toEqual(['a', 'b'])
    expect(rows).toEqual([['1', '2'], ['3', '4']])
  })
})

describe('toSqlInsert', () => {
  it('generates INSERT with escaped literals + NULL', () => {
    const sql = toSqlInsert('t', ['id', 'v'], [{ id: 1, v: "it's" }, { id: 2, v: null }])
    expect(sql).toContain(`INSERT INTO "t" ("id", "v") VALUES (1, 'it''s');`)
    expect(sql).toContain(`VALUES (2, NULL);`)
  })
})
