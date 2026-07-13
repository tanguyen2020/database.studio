import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { sql, MySQL, schemaCompletionSource, type SQLNamespace } from '@codemirror/lang-sql'
import { escapeSchemaKey } from './completion-schema'

// Replicate the two pieces of @codemirror/lang-sql (dist/index.js) that matter:
//  - addNamespaceObject splits a namespace key on UNESCAPED dots, then unescapes
//    `\.` back to `.` for each resulting segment (lines ~510 + ~519).
//  - defaultSchema = top.child(name) keys a level by the RAW name (no split, no
//    unescape).
// The fix works iff, after escaping the namespace key, the segment lang-sql
// derives for the level equals the RAW defaultSchema name — so they converge.
function langSqlSegments(key: string): string[] {
  return key
    .replace(/\\?\./g, (p) => (p === '.' ? '\0' : p))
    .split('\0')
    .map((seg) => seg.replace(/\\\./g, '.'))
}

describe('escapeSchemaKey', () => {
  it('leaves a plain name unchanged', () => {
    expect(escapeSchemaKey('public')).toBe('public')
    expect(escapeSchemaKey('dbo')).toBe('dbo')
  })

  it('escapes every dot in a dotted database name', () => {
    expect(escapeSchemaKey('crm.ismart.edu.vn')).toBe('crm\\.ismart\\.edu\\.vn')
    expect(escapeSchemaKey('bo.review')).toBe('bo\\.review')
  })

  it('keeps a dotted name as ONE lang-sql segment (no fake nesting)', () => {
    // Without escaping, lang-sql would split into 4 levels.
    expect(langSqlSegments('crm.ismart.edu.vn')).toEqual(['crm', 'ismart', 'edu', 'vn'])
    // Escaped: a single segment, unescaped back to the real name.
    expect(langSqlSegments(escapeSchemaKey('crm.ismart.edu.vn'))).toEqual(['crm.ismart.edu.vn'])
    expect(langSqlSegments(escapeSchemaKey('bo.review'))).toEqual(['bo.review'])
  })

  it('escaped namespace key converges with a RAW defaultSchema name', () => {
    // The level key lang-sql ends up using (last unescaped segment) must equal
    // the raw defaultSchema string, or unqualified table completion finds nothing.
    for (const name of ['public', 'crm.ismart.edu.vn', 'bo.review', 'my_db']) {
      const segments = langSqlSegments(escapeSchemaKey(name))
      expect(segments).toHaveLength(1)
      expect(segments[0]).toBe(name) // raw defaultSchema === level key
    }
  })

  it('round-trips a name with a stray backslash not followed by a dot', () => {
    // lang-sql only touches `\.`; a lone backslash is left alone both ways.
    expect(langSqlSegments(escapeSchemaKey('a\\b.c'))).toEqual(['a\\b.c'])
  })
})

// End-to-end against the REAL @codemirror/lang-sql: build the schema completion
// source exactly as SqlWorkspace does, drive it over `select * from tm`, and
// check whether the dotted-DB `tm_biz_collect` table is offered.
function labelsFor(schemaKey: string): string[] {
  const schema: SQLNamespace = {
    // one database (schema-as-database) whose name has dots, two tables in it
    [schemaKey]: {
      tm_biz_collect: { self: { label: 'tm_biz_collect', type: 'type' }, children: [] },
      tm_activities: { self: { label: 'tm_activities', type: 'type' }, children: [] },
    },
  }
  // defaultSchema stays RAW (real dots) — see completion-schema.ts.
  const source = schemaCompletionSource({ dialect: MySQL, schema, defaultSchema: 'crm.ismart.edu.vn' })
  const doc = 'select * from tm'
  const state = EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [sql({ dialect: MySQL })] })
  const result = source(new CompletionContext(state, doc.length, true))
  if (!result || result instanceof Promise) return [] // schemaCompletionSource is synchronous
  return result.options.map((o) => o.label)
}

describe('lang-sql schema completion with a dotted database name', () => {
  it('suggests the database tables when the namespace key is escaped', () => {
    // The fix: escaped key + raw defaultSchema → tables surface unqualified.
    const labels = labelsFor(escapeSchemaKey('crm.ismart.edu.vn'))
    expect(labels).toContain('tm_biz_collect')
    expect(labels).toContain('tm_activities')
  })

  it('does NOT suggest them with a raw dotted key (reproduces the bug)', () => {
    // Control: without escaping, lang-sql explodes `crm.ismart.edu.vn` into a fake
    // nested path, so the tables are unreachable from an unqualified position.
    const labels = labelsFor('crm.ismart.edu.vn')
    expect(labels).not.toContain('tm_biz_collect')
    expect(labels).not.toContain('tm_activities')
  })
})
