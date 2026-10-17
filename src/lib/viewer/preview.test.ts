import { describe, expect, it } from 'vitest'
import { containerPaths, flattenTree, previewOf } from './preview'

describe('previewOf', () => {
  it('an object reads as typed key / value pairs, strings unquoted', () => {
    const p = previewOf('{"messageId":"019fd5ea","seq":15399,"ok":true,"note":null}')
    expect(p.kind).toBe('object')
    expect(p.parts).toEqual([
      { k: 'messageId', v: '019fd5ea', t: 'string' },
      { k: 'seq', v: '15399', t: 'number' },
      { k: 'ok', v: 'true', t: 'bool' },
      { k: 'note', v: 'null', t: 'null' },
    ])
    expect(p.more).toBe(0)
  })

  it('nested containers are summarised, and only `max` keys are shown', () => {
    const p = previewOf(JSON.stringify({ a: 1, b: { x: 1, y: 2 }, c: [1, 2, 3], d: 4 }), 3)
    expect(p.parts[1]).toEqual({ k: 'b', v: '{2 keys}', t: 'object' })
    expect(p.parts[2]).toEqual({ k: 'c', v: '[3 items]', t: 'array' })
    expect(p.more).toBe(1)
    expect(p.size).toBe(4)
  })

  it('arrays, plain text, empty, and long values', () => {
    expect(previewOf('[1,"a"]')).toMatchObject({ kind: 'array', size: 2, parts: [{ v: '1', t: 'number' }, { v: 'a', t: 'string' }] })
    expect(previewOf('hello  world\n2')).toEqual({ kind: 'text', parts: [{ v: 'hello world 2', t: 'string' }], more: 0 })
    expect(previewOf('{broken')).toMatchObject({ kind: 'text' })
    expect(previewOf('42')).toMatchObject({ kind: 'text' }) // a bare number stays text
    expect(previewOf('   ')).toEqual({ kind: 'empty', parts: [], more: 0 })
    const long = previewOf(JSON.stringify({ s: 'x'.repeat(200) })).parts[0].v
    expect(long.length).toBe(80)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('flattenTree', () => {
  const doc = { user: { name: 'An', tags: ['a', 'b', 'c'] }, 'odd key': 1 }

  it('shows only open containers, in document order, with stable paths', () => {
    const rows = flattenTree(doc, (p) => p === '$' || p === '$.user')
    expect(rows.map((r) => [r.path, r.depth, r.t])).toEqual([
      ['$', 0, 'object'],
      ['$.user', 1, 'object'],
      ['$.user.name', 2, 'string'],
      ['$.user.tags', 2, 'array'],
      ['$["odd key"]', 1, 'number'],
    ])
    expect(rows.find((r) => r.path === '$.user.tags')).toMatchObject({ size: 3, v: '[3 items]' })
  })

  it('caps a long array and says how many are left', () => {
    const rows = flattenTree({ xs: Array.from({ length: 250 }, (_, i) => i) }, () => true, () => 200)
    const items = rows.filter((r) => r.path.startsWith('$.xs['))
    expect(items).toHaveLength(200)
    expect(rows.at(-1)).toMatchObject({ path: '$.xs#more', more: 50 })
  })

  it('containerPaths lists every object / array for Expand all', () => {
    expect(containerPaths(doc)).toEqual(['$', '$.user', '$.user.tags'])
  })
})
