import { describe, expect, it } from 'vitest'
import { expectsColumnHere } from './column-context'

describe('expectsColumnHere', () => {
  it('is true right after a keyword that introduces a column', () => {
    expect(expectsColumnHere('SELECT * FROM t WHERE ')).toBe(true)
    expect(expectsColumnHere('UPDATE t SET ')).toBe(true)
    expect(expectsColumnHere('SELECT * FROM t WHERE a = 1 AND ')).toBe(true)
    expect(expectsColumnHere('SELECT * FROM a JOIN b ON ')).toBe(true)
    expect(expectsColumnHere('SELECT * FROM t ORDER BY ')).toBe(true)
    expect(expectsColumnHere('SELECT * FROM t GROUP BY ')).toBe(true)
    expect(expectsColumnHere('SELECT ')).toBe(true)
    expect(expectsColumnHere('SELECT a, ')).toBe(true)
    expect(expectsColumnHere('INSERT INTO t (')).toBe(false) // no space yet
    expect(expectsColumnHere('INSERT INTO t ( ')).toBe(true)
  })
  it('is false where a column is not what comes next', () => {
    expect(expectsColumnHere('SELECT * FROM ')).toBe(false) // a table goes here
    expect(expectsColumnHere('UPDATE ')).toBe(false)
    expect(expectsColumnHere('INSERT INTO ')).toBe(false)
    expect(expectsColumnHere('SELECT * FROM t ')).toBe(false) // a clause goes here
    expect(expectsColumnHere('SELECT * FROM t WHERE a')).toBe(false) // mid-word
    expect(expectsColumnHere('SELECT * FROM t WHERE a = ')).toBe(false)
    expect(expectsColumnHere('')).toBe(false)
  })
})
