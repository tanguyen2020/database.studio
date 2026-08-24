import { describe, expect, it } from 'vitest'
import { PostgreSQL, schemaCompletionSource } from '@codemirror/lang-sql'
import { HeadlessDoc, minimalChange, runSources } from './cm-headless'

describe('minimalChange', () => {
  it('reports one localised replacement (so Lezer can reuse the parse tree)', () => {
    expect(minimalChange('SELECT a FROM t', 'SELECT ab FROM t')).toEqual({ from: 8, to: 8, insert: 'b' })
    expect(minimalChange('SELECT ab FROM t', 'SELECT a FROM t')).toEqual({ from: 8, to: 9, insert: '' })
    expect(minimalChange('abc', 'axc')).toEqual({ from: 1, to: 2, insert: 'x' })
  })

  it('is null for an unchanged document', () => {
    expect(minimalChange('SELECT 1', 'SELECT 1')).toBeNull()
  })

  it('handles empty documents in both directions', () => {
    expect(minimalChange('', 'a')).toEqual({ from: 0, to: 0, insert: 'a' })
    expect(minimalChange('a', '')).toEqual({ from: 0, to: 1, insert: '' })
  })

  it('replays to exactly the new document', () => {
    const cases: [string, string][] = [
      ['SELECT * FROM students', 'SELECT * FROM students WHERE id = 1'],
      ['line1\nline2\nline3', 'line1\nCHANGED\nline3'],
      ['aaa', 'aa'],
      ['SELECT 1;', 'SELECT 1;\nSELECT 2;'],
    ]
    for (const [a, b] of cases) {
      const ch = minimalChange(a, b)!
      expect(a.slice(0, ch.from) + ch.insert + a.slice(ch.to)).toBe(b)
    }
  })
})

describe('HeadlessDoc', () => {
  it('keeps its document in step with the editor text', () => {
    const doc = new HeadlessDoc(PostgreSQL.extension, 'SELECT 1')
    expect(doc.sync('SELECT 2').doc.toString()).toBe('SELECT 2')
    expect(doc.sync('SELECT 2').doc.toString()).toBe('SELECT 2') // idempotent
    const ctx = doc.context('SELECT * FROM students', 22, false)
    expect(ctx.pos).toBe(22)
    expect(ctx.state.doc.toString()).toBe('SELECT * FROM students')
  })

  it('clamps a position past the end of the document', () => {
    const doc = new HeadlessDoc(PostgreSQL.extension, '')
    expect(doc.context('SELECT', 999, false).pos).toBe(6)
  })

  it('drives the real lang-sql schema source (the behaviour Monaco borrows)', async () => {
    const doc = new HeadlessDoc(PostgreSQL.extension)
    const source = schemaCompletionSource({
      dialect: PostgreSQL,
      schema: { public: { students: { self: { label: 'students', type: 'type' }, children: [{ label: 'first_name', type: 'property' }] } } },
      defaultSchema: 'public',
    })
    const sql = 'SELECT * FROM students s WHERE s.'
    const results = await runSources([source], doc.context(sql, sql.length, false))
    expect(results).toHaveLength(1)
    expect(results[0].options.map((o) => o.label)).toContain('first_name')
  })
})

describe('runSources', () => {
  it('skips a throwing source instead of losing the whole popup', async () => {
    const doc = new HeadlessDoc(PostgreSQL.extension)
    const ctx = doc.context('SELECT a', 8, false)
    const results = await runSources(
      [
        () => {
          throw new Error('boom')
        },
        () => ({ from: 7, options: [{ label: 'alpha' }] }),
      ],
      ctx,
    )
    expect(results.map((r) => r.options[0].label)).toEqual(['alpha'])
  })

  it('awaits an async source and drops empty/null answers', async () => {
    const doc = new HeadlessDoc(PostgreSQL.extension)
    const ctx = doc.context('SELECT a', 8, false)
    const results = await runSources(
      [
        () => null,
        () => ({ from: 7, options: [] }),
        async () => ({ from: 7, options: [{ label: 'later' }] }),
        undefined,
      ],
      ctx,
    )
    expect(results.map((r) => r.options[0].label)).toEqual(['later'])
  })
})
