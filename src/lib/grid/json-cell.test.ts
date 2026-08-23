import { describe, expect, it } from 'vitest'
import {
  formatJson,
  hasJsonBadge,
  isJsonDocument,
  isJsonType,
  jsonCellMode,
  jsonValueChanged,
  minifyJson,
  parseEditorText,
  toEditorText,
} from './json-cell'

describe('isJsonType', () => {
  it('accepts the JSON types the drivers report', () => {
    for (const t of ['json', 'jsonb', 'JSON', 'JSONB', 'Nullable(JSON)', 'json not null'])
      expect(isJsonType(t), t).toBe(true)
  })
  it('rejects columns that merely hold text', () => {
    for (const t of ['nvarchar', 'text', 'varchar(200)', 'jsonpath', 'int4', '', undefined, null])
      expect(isJsonType(t as string | undefined), String(t)).toBe(false)
  })
})

describe('jsonCellMode', () => {
  it('a declared JSON column edits as a document — even when NULL', () => {
    expect(jsonCellMode('jsonb', { a: 1 })).toBe('json')
    expect(jsonCellMode('jsonb', null)).toBe('json')
    expect(jsonCellMode('json', '{"a":1}')).toBe('json') // MySQL can hand back text
  })
  it('a text column holding a document edits as text (MSSQL/SQLite)', () => {
    expect(jsonCellMode('nvarchar', '{"a":1}')).toBe('text')
    expect(jsonCellMode('text', '[1,2]')).toBe('text')
  })
  it('plain values and non-JSON structures stay view-only', () => {
    expect(jsonCellMode('varchar', 'An')).toBe('none')
    expect(jsonCellMode('text', '{not json')).toBe('none')
    expect(jsonCellMode('int4', 5)).toBe('none')
    expect(jsonCellMode('text[]', ['a', 'b'])).toBe('none') // a pg array is not JSON
    expect(jsonCellMode('varchar', null)).toBe('none')
  })
})

describe('hasJsonBadge', () => {
  it('shows on decoded documents and on any non-null JSON column', () => {
    expect(hasJsonBadge('jsonb', { a: 1 })).toBe(true)
    expect(hasJsonBadge('text[]', ['a'])).toBe(true)
    expect(hasJsonBadge('jsonb', 42)).toBe(true) // a jsonb scalar is still JSON
    expect(hasJsonBadge('jsonb', null)).toBe(false)
    expect(hasJsonBadge('varchar', 'An')).toBe(false)
  })
})

describe('toEditorText', () => {
  it('pretty-prints a document', () => {
    expect(toEditorText({ a: 1 }, 'json')).toBe('{\n  "a": 1\n}')
    expect(toEditorText('{"a":1}', 'json')).toBe('{\n  "a": 1\n}')
  })
  it('leaves a text column exactly as stored (no silent reformat)', () => {
    expect(toEditorText('{"a":1}', 'text')).toBe('{"a":1}')
  })
  it('NULL opens empty', () => {
    expect(toEditorText(null, 'json')).toBe('')
    expect(toEditorText(undefined, 'json')).toBe('')
  })
})

describe('parseEditorText', () => {
  it('empty saves NULL', () => {
    expect(parseEditorText('   ', 'json')).toEqual({ ok: true, value: null })
  })
  it('a json column stores the parsed document', () => {
    expect(parseEditorText('{"a": [1,2]}', 'json')).toEqual({ ok: true, value: { a: [1, 2] } })
  })
  it('a text column stores the string as typed', () => {
    const r = parseEditorText('  {"a": 1}  ', 'text')
    expect(r).toEqual({ ok: true, value: '{"a": 1}' })
  })
  it('invalid JSON reports the parser error instead of saving', () => {
    const r = parseEditorText('{"a": }', 'json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })
})

describe('format / minify', () => {
  it('round-trips', () => {
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(minifyJson('{\n  "a": 1\n}')).toBe('{"a":1}')
  })
  it('returns null on invalid input so the caller keeps the draft', () => {
    expect(formatJson('{')).toBeNull()
    expect(minifyJson('nope')).toBeNull()
    expect(formatJson('')).toBeNull()
  })
})

describe('isJsonDocument / jsonValueChanged', () => {
  it('only objects and arrays count as documents', () => {
    expect(isJsonDocument('{"a":1}')).toBe(true)
    expect(isJsonDocument('[1]')).toBe(true)
    expect(isJsonDocument('42')).toBe(false)
    expect(isJsonDocument('"str"')).toBe(false)
  })
  it('key order and formatting do not matter, values do', () => {
    expect(jsonValueChanged({ a: 1 }, { a: 1 })).toBe(false)
    expect(jsonValueChanged({ a: 2 }, { a: 1 })).toBe(true)
    expect(jsonValueChanged(null, undefined)).toBe(false)
  })
})
