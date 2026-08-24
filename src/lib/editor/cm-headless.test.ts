import { describe, expect, it } from 'vitest'
import { PostgreSQL, schemaCompletionSource } from '@codemirror/lang-sql'
import { HeadlessDoc, minimalChange, normalizeEol, runSources } from './cm-headless'

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
    const ctx = doc.context('SELECT * FROM students', 1, 23, false)
    expect(ctx.pos).toBe(22)
    expect(ctx.state.doc.toString()).toBe('SELECT * FROM students')
  })

  it('clamps a position past the end of the document', () => {
    const doc = new HeadlessDoc(PostgreSQL.extension, '')
    expect(doc.context('SELECT', 1, 999, false).pos).toBe(6)
    expect(doc.context('SELECT', 99, 1, false).pos).toBe(0)
  })

  it('drives the real lang-sql schema source (the behaviour Monaco borrows)', async () => {
    const doc = new HeadlessDoc(PostgreSQL.extension)
    const source = schemaCompletionSource({
      dialect: PostgreSQL,
      schema: { public: { students: { self: { label: 'students', type: 'type' }, children: [{ label: 'first_name', type: 'property' }] } } },
      defaultSchema: 'public',
    })
    const sql = 'SELECT * FROM students s WHERE s.'
    const results = await runSources([source], doc.context(sql, 1, sql.length + 1, false))
    expect(results).toHaveLength(1)
    expect(results[0].options.map((o) => o.label)).toContain('first_name')
  })
})

describe('runSources', () => {
  it('skips a throwing source instead of losing the whole popup', async () => {
    const doc = new HeadlessDoc(PostgreSQL.extension)
    const ctx = doc.context('SELECT a', 1, 9, false)
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
    const ctx = doc.context('SELECT a', 1, 9, false)
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

// The bug this API shape exists to prevent: Monaco keeps CRLF documents (2 chars
// per line break) while CodeMirror normalises to LF (1), so an OFFSET taken from
// one and used in the other drifts by one char per line above the caret. That
// drift made completion ranges cover the wrong text and Monaco dropped every
// suggestion ("No suggestions." on any line below a line break).
describe('CRLF documents (Monaco) vs LF (CodeMirror)', () => {
  it('normalizeEol collapses CRLF and lone CR', () => {
    expect(normalizeEol('a\r\nb')).toBe('a\nb')
    expect(normalizeEol('a\rb')).toBe('a\nb')
    expect(normalizeEol('a\nb')).toBe('a\nb')
    expect(normalizeEol('')).toBe('')
  })

  it('maps a caret on line 4 of a CRLF document to the right offset and back', () => {
    const doc = new HeadlessDoc(PostgreSQL.extension)
    // 'select * from academic_sessions;' + 3 CRLF breaks + 'select * from stu'
    const crlf = 'select * from academic_sessions;\r\n\r\n\r\nselect * from stu'
    const ctx = doc.context(crlf, 4, 18, false) // caret after 'stu'
    expect(ctx.state.doc.lines).toBe(4)
    // in LF coordinates line 4 starts at 32+3 = 35, so the caret sits at 52
    expect(ctx.pos).toBe(52)
    // …and mapping back lands on the same line/column the editor asked about
    expect(doc.positionOf(ctx.pos)).toEqual({ lineNumber: 4, column: 18 })
    // the word start (49) maps back to column 15 — where 'stu' really begins
    expect(doc.positionOf(49)).toEqual({ lineNumber: 4, column: 15 })
  })

  it('lang-sql suggests tables on a later line of a CRLF document', async () => {
    const doc = new HeadlessDoc(PostgreSQL.extension)
    const source = schemaCompletionSource({
      dialect: PostgreSQL,
      schema: { public: { students: { self: { label: 'students', type: 'type' }, children: [] } } },
      defaultSchema: 'public',
    })
    const crlf = 'select * from academic_sessions;\r\n\r\n\r\nselect * from stu'
    const results = await runSources([source], doc.context(crlf, 4, 18, false))
    expect(results).toHaveLength(1)
    expect(results[0].options.map((o) => o.label)).toContain('students')
    // the replaced range starts at the word, i.e. column 15 on line 4
    expect(doc.positionOf(results[0].from)).toEqual({ lineNumber: 4, column: 15 })
  })
})
