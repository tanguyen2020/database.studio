import { describe, expect, it } from 'vitest'
import { formatClipboard, rawCell, toMarkdownTable, toSqlUpdate, toTsv, type CopyInput } from './clipboard'

const HEADERS = ['id', 'name', 'active']
const ROWS: Record<string, unknown>[] = [
  { id: 1, name: "O'Brien", active: true },
  { id: 2, name: 'Ann', active: false, extra: 'ignored' },
]

describe('rawCell', () => {
  it('null → empty, objects → JSON, scalars → string', () => {
    expect(rawCell(null)).toBe('')
    expect(rawCell(undefined)).toBe('')
    expect(rawCell(42)).toBe('42')
    expect(rawCell({ a: 1 })).toBe('{"a":1}')
  })
})

describe('toTsv', () => {
  it('tab-separated with header row', () => {
    const out = toTsv(HEADERS, ROWS)
    expect(out.split('\n')[0]).toBe('id\tname\tactive')
    expect(out.split('\n')[1]).toBe("1\tO'Brien\ttrue")
  })
  it('flattens tabs/newlines inside cells so the grid stays aligned', () => {
    const out = toTsv(['v'], [{ v: 'a\tb\nc' }], false)
    expect(out).toBe('a b c')
  })
})

describe('toMarkdownTable', () => {
  it('emits header, separator, and escaped body rows', () => {
    const out = toMarkdownTable(['a', 'b'], [{ a: 'x|y', b: 'l1\nl2' }])
    const lines = out.split('\n')
    expect(lines[0]).toBe('| a | b |')
    expect(lines[1]).toBe('| --- | --- |')
    expect(lines[2]).toBe('| x\\|y | l1<br>l2 |')
  })
})

describe('toSqlUpdate', () => {
  it('SET non-key columns, WHERE key columns, quotes literals', () => {
    const out = toSqlUpdate('users', HEADERS, [ROWS[0]], ['id'])
    expect(out).toBe(`UPDATE "users" SET "name" = 'O''Brien', "active" = TRUE WHERE "id" = 1;`)
  })
  it('with no key columns, every column keys the WHERE', () => {
    const out = toSqlUpdate('t', ['a'], [{ a: 5 }])
    expect(out).toBe(`UPDATE "t" SET "a" = 5 WHERE "a" = 5;`)
  })
})

describe('formatClipboard', () => {
  const input: CopyInput = { headers: HEADERS, rows: ROWS, table: 'users', keyColumns: ['id'] }

  it('csv delimits with commas and quotes embedded specials', () => {
    const out = formatClipboard('csv', input)
    expect(out.split('\n')[0]).toBe('id,name,active')
    expect(out).toContain("O'Brien")
  })

  it('json keeps only the chosen headers (drops extra columns)', () => {
    const out = formatClipboard('json', input)
    const parsed = JSON.parse(out)
    expect(Object.keys(parsed[1])).toEqual(HEADERS)
    expect(parsed[1]).not.toHaveProperty('extra')
  })

  it('sql-insert emits one INSERT per row into the given table', () => {
    const out = formatClipboard('sql-insert', input)
    expect(out.split('\n')).toHaveLength(2)
    expect(out).toContain('INSERT INTO "users" ("id", "name", "active") VALUES (1,')
  })

  it('sql-update uses key columns in WHERE', () => {
    const out = formatClipboard('sql-update', input)
    expect(out).toContain('WHERE "id" = 1;')
  })

  it('markdown produces a GFM table', () => {
    expect(formatClipboard('markdown', input).split('\n')[1]).toBe('| --- | --- | --- |')
  })

  it('falls back to a placeholder table name when none is given', () => {
    const out = formatClipboard('sql-insert', { headers: ['a'], rows: [{ a: 1 }] })
    expect(out).toContain('INSERT INTO "table"')
  })
})
