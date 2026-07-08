import { describe, expect, it } from 'vitest'
import { highlightSql, sqlTokenColor } from './sql'

const join = (s: string) => highlightSql(s).map((t) => t.text).join('')

describe('highlightSql', () => {
  it('is lossless — tokens rejoin to the original text', () => {
    const sql = "-- Migration\nCREATE TABLE \"users\" (\n  \"id\" integer PRIMARY KEY\n);\nDROP TABLE legacy;"
    expect(join(sql)).toBe(sql)
  })

  it('classifies comments, keywords, strings, numbers', () => {
    const toks = highlightSql("-- note\nALTER TABLE t ADD COLUMN age integer DEFAULT 18;")
    const kinds = new Set(toks.map((t) => t.kind))
    expect(kinds.has('comment')).toBe(true)
    expect(kinds.has('keyword')).toBe(true)
    expect(kinds.has('number')).toBe(true)
    expect(toks.find((t) => t.kind === 'comment')?.text).toBe('-- note')
  })

  it('a quoted string with keyword-looking words stays a string', () => {
    const toks = highlightSql("INSERT INTO t VALUES ('CREATE TABLE');")
    const str = toks.find((t) => t.kind === 'string')
    expect(str?.text).toBe("'CREATE TABLE'")
  })

  it('merges adjacent same-kind tokens (few spans)', () => {
    // "a b c" is all plain → should collapse to a single plain token
    expect(highlightSql('a b c').filter((t) => t.kind === 'plain').length).toBe(1)
  })

  it('maps kinds to syntax color vars', () => {
    expect(sqlTokenColor('keyword')).toBe('var(--syntax-keyword)')
    expect(sqlTokenColor('string')).toBe('var(--syntax-string)')
    expect(sqlTokenColor('comment')).toBe('var(--syntax-comment)')
    expect(sqlTokenColor('plain')).toBe('var(--text)')
  })
})
