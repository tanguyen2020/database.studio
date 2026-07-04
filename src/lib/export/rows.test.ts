import { describe, expect, it } from 'vitest'
import { csvCell, toCsv, toSqlInsert } from './rows'

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

describe('toSqlInsert', () => {
  it('generates INSERT with escaped literals + NULL', () => {
    const sql = toSqlInsert('t', ['id', 'v'], [{ id: 1, v: "it's" }, { id: 2, v: null }])
    expect(sql).toContain(`INSERT INTO "t" ("id", "v") VALUES (1, 'it''s');`)
    expect(sql).toContain(`VALUES (2, NULL);`)
  })
})
