import { describe, expect, it } from 'vitest'
import { classifyDanger, dangerousStatements } from './danger'

describe('classifyDanger', () => {
  it('flags DELETE without WHERE', () => {
    expect(classifyDanger('DELETE FROM users')).toBe('delete')
    expect(classifyDanger('delete from users;')).toBe('delete')
  })
  it('allows DELETE with WHERE', () => {
    expect(classifyDanger('DELETE FROM users WHERE id = 1')).toBeNull()
    expect(classifyDanger("DELETE FROM users\nWHERE name = 'x'")).toBeNull()
  })
  it('flags TRUNCATE always', () => {
    expect(classifyDanger('TRUNCATE users')).toBe('truncate')
    expect(classifyDanger('TRUNCATE TABLE public.users')).toBe('truncate')
  })
  it('flags MySQL multi-table DELETE and DELETE … USING forms without WHERE', () => {
    expect(classifyDanger('DELETE t FROM t JOIN u ON t.id = u.id')).toBe('delete')
    expect(classifyDanger('DELETE FROM t USING u')).toBe('delete')
  })
  it('is not fooled by WHERE inside a string literal', () => {
    expect(classifyDanger("DELETE FROM logs -- keep WHERE noise")).toBe('delete')
    expect(classifyDanger("DELETE FROM logs /* WHERE */ ")).toBe('delete')
    expect(classifyDanger("DELETE FROM t WHERE note = 'has no where'")).toBeNull()
  })
  it('ignores SELECT/UPDATE/INSERT', () => {
    expect(classifyDanger('SELECT * FROM users')).toBeNull()
    expect(classifyDanger('UPDATE users SET a = 1')).toBeNull()
    expect(classifyDanger("INSERT INTO users VALUES (1)")).toBeNull()
  })
})

describe('dangerousStatements', () => {
  it('returns each dangerous statement with its batch index', () => {
    const stmts = [
      { sql: 'SELECT 1' },
      { sql: 'DELETE FROM a' },
      { sql: 'DELETE FROM b WHERE id = 1' },
      { sql: 'TRUNCATE c' },
    ]
    expect(dangerousStatements(stmts)).toEqual([
      { index: 1, kind: 'delete', sql: 'DELETE FROM a' },
      { index: 3, kind: 'truncate', sql: 'TRUNCATE c' },
    ])
  })
  it('returns [] when nothing is dangerous', () => {
    expect(dangerousStatements([{ sql: 'SELECT 1' }, { sql: 'DELETE FROM a WHERE 1=1' }])).toEqual([])
  })
})
