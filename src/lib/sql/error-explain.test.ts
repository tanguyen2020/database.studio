import { describe, expect, it } from 'vitest'
import { cleanErrorMessage, errorExcerpt, explainQueryError } from './error-explain'
import type { QueryError } from '$lib/types'
import type { SplitStatement } from './statements'

const err = (system: string, message: string, code?: string, extra: Partial<QueryError> = {}): QueryError => ({
  system,
  message,
  code,
  severity: 'error',
  raw: message,
  ...extra,
})

describe('explainQueryError', () => {
  it('classifies by the error code of every engine', () => {
    const cases: [QueryError, string][] = [
      [err('postgres', 'relation "x" does not exist', '42P01'), 'missing-table'],
      [err('postgres', 'column "y" does not exist', '42703'), 'missing-column'],
      [err('postgres', 'syntax error at or near "SELEC"', '42601'), 'syntax'],
      [err('postgres', 'duplicate key value violates unique constraint "pk"', '23505'), 'unique'],
      [err('postgres', 'cannot drop schema public because other objects depend on it', '2BP01'), 'dependency'],
      [err('mysql', "Table 'db.x' doesn't exist", '42S02'), 'missing-table'],
      [err('mysql', "Duplicate entry '1' for key 'PRIMARY'", '23000'), 'unique'],
      [err('mssql', "Invalid object name 'x'.", '208'), 'missing-table'],
      [err('mssql', 'Cannot insert the value NULL into column', '515'), 'not-null'],
      [err('oracle', 'ORA-00942: table or view does not exist', 'ORA-00942'), 'missing-table'],
      [err('postgres', 'Connection lost — the server closed it', 'CONNECTION_LOST'), 'connection'],
      [err('postgres', 'canceling statement due to user request', 'CANCELLED'), 'cancelled'],
    ]
    for (const [e, cat] of cases) expect(explainQueryError(e).category, e.message).toBe(cat)
  })

  it('falls back to the message when the engine gives no code (SQLite, DuckDB, Oracle in text)', () => {
    expect(explainQueryError(err('sqlite', 'no such table: orders')).category).toBe('missing-table')
    expect(explainQueryError(err('sqlite', 'UNIQUE constraint failed: users.email')).category).toBe('unique')
    expect(explainQueryError(err('sqlite', 'near "SELEC": syntax error')).category).toBe('syntax')
    expect(explainQueryError(err('oracle', 'ORA-00001: unique constraint (APP.PK) violated')).category).toBe('unique')
  })

  it('lets the message decide for the ambiguous MySQL 42000 (syntax OR access)', () => {
    expect(explainQueryError(err('mysql', 'You have an error in your SQL syntax; check the manual', '42000')).category).toBe('syntax')
    expect(explainQueryError(err('mysql', "SELECT command denied to user 'u'@'%' for table 'x'", '42000')).category).toBe('permission')
  })

  it('keeps the driver hint, otherwise gives a generic one; unknown errors stay honest', () => {
    expect(explainQueryError(err('postgres', 'x', '42P01', { hint: 'Driver hint' })).hint).toBe('Driver hint')
    expect(explainQueryError(err('postgres', 'relation "x" does not exist', '42P01')).hint).toMatch(/schema/)
    const other = explainQueryError(err('postgres', 'something odd happened'))
    expect(other.category).toBe('other')
    expect(other.title).toBe('Statement failed')
    expect(other.message).toBe('something odd happened')
  })

  it('never rewrites the server message, only strips transport prefixes', () => {
    expect(cleanErrorMessage('Error: driver error: error returned from database: relation "x" does not exist')).toBe(
      'relation "x" does not exist',
    )
    expect(explainQueryError(err('postgres', 'driver error: relation "a.b" does not exist', '42P01')).message).toBe(
      'relation "a.b" does not exist',
    )
  })
})

describe('errorExcerpt', () => {
  const stmt: SplitStatement = { sql: 'SELECT id,\n  name\nFROM no_such_t\nWHERE id = 1', from: 0, to: 40, startLine: 10, startCol: 1 }

  it('numbers lines as in the editor and puts the caret under the reported column', () => {
    const x = errorExcerpt(stmt, err('postgres', 'm', '42P01', { position: { line: 3, col: 6 } }))!
    expect(x.map((l) => l.line)).toEqual([11, 12, 13])
    const hit = x.find((l) => l.error)!
    expect(hit.line).toBe(12)
    expect(hit.text).toBe('FROM no_such_t')
    expect(hit.caret).toBe(6)
    expect(hit.text.slice(hit.caret! - 1)).toBe('no_such_t')
  })

  it('marks the line but draws no caret when the engine only knows the line', () => {
    const x = errorExcerpt(stmt, err('mssql', 'm', '208', { position: { line: 3, col: 1 } }))!
    expect(x.find((l) => l.error)?.caret).toBeUndefined()
  })

  it('is null when there is no position to point at', () => {
    expect(errorExcerpt(stmt, err('postgres', 'm'))).toBeNull()
    expect(errorExcerpt(stmt, err('postgres', 'm', undefined, { position: { line: 9, col: 1 } }))).toBeNull()
  })
})
