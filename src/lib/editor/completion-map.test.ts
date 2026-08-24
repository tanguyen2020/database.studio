import { describe, expect, it } from 'vitest'
import { couldMatch, mapCompletions, rankOf, type CmResult } from './completion-map'

const res = (from: number, options: CmResult['options'], to?: number): CmResult => ({ from, options, ...(to != null ? { to } : {}) })

describe('rankOf', () => {
  it('orders columns above tables above functions above keywords', () => {
    expect(rankOf('property')).toBeLessThan(rankOf('type'))
    expect(rankOf('type')).toBeLessThan(rankOf('function'))
    expect(rankOf('function')).toBeLessThan(rankOf('keyword'))
  })
})

describe('mapCompletions', () => {
  it('keeps the CodeMirror ranking in the array order Monaco tie-breaks on', () => {
    const items = mapCompletions(
      [
        res(0, [
          { label: 'select', type: 'keyword', boost: -1 },
          { label: 'lower', type: 'function' },
          { label: 'students', type: 'type', boost: 150 },
          { label: 'first_name', type: 'property', boost: 200 },
        ]),
      ],
      '', // nothing typed: no prefix filtering, pure ranking
    )
    expect(items.map((i) => i.label)).toEqual(['first_name', 'students', 'lower', 'select'])
  })

  it('treats a negative boost as a language word, never as an identifier', () => {
    // lang-sql's keyword source labels SQL *types* with type:'type' and boost -1;
    // ranking those as tables would push `bigint`/`array` above the real tables.
    const items = mapCompletions(
      [res(0, [{ label: 'bigint', type: 'type', boost: -1 }, { label: 'students', type: 'type', boost: 150 }])],
      '',
    )
    expect(items.map((i) => i.label)).toEqual(['students', 'bigint'])
  })

  it('inserts `apply` (the quoted identifier) and keeps the plain label for filtering', () => {
    const [item] = mapCompletions([res(14, [{ label: 'order', type: 'type', boost: 150, apply: '"order"' }])], 'ord')
    expect(item.label).toBe('order')
    expect(item.insertText).toBe('"order"')
    expect(item.from).toBe(14)
  })

  it('falls back to the label when `apply` is not a plain string', () => {
    const [item] = mapCompletions([res(0, [{ label: 'snippet', apply: () => {} }])], 's')
    expect(item.insertText).toBe('snippet')
  })

  it('carries a source-extended end offset (quoted identifier swallows its closing quote)', () => {
    const [item] = mapCompletions([res(10, [{ label: 'order', apply: '"order"' }], 18)], 'ord')
    expect(item.to).toBe(18)
  })

  it('collapses a name offered twice, keeping the more specific entry', () => {
    const items = mapCompletions(
      [
        res(0, [{ label: 'order', type: 'keyword', boost: -1 }]),
        res(0, [{ label: 'order', type: 'type', boost: 150, apply: '"order"' }]),
      ],
      'ord',
    )
    expect(items).toHaveLength(1)
    expect(items[0].insertText).toBe('"order"')
  })

  it('preselects the identifier the typed prefix continues', () => {
    // Monaco sorts by fuzzy score first, so an exact-match function of another
    // name (`ORD`) outranks the prefix-matched table `order`; preselect is the
    // only lever that still points Tab/Enter at the identifier.
    const items = mapCompletions(
      [
        res(0, [{ label: 'ORD', type: 'function' }]),
        res(0, [{ label: 'order', type: 'type', boost: 150, apply: '`order`' }]),
      ],
      'ord',
    )
    expect(items.find((i) => i.preselect)?.label).toBe('order')
    expect(items.filter((i) => i.preselect)).toHaveLength(1)
  })

  it('preselects nothing when nothing is typed, or when no identifier matches', () => {
    const nothingTyped = mapCompletions([res(0, [{ label: 'students', type: 'type', boost: 150 }])], '')
    expect(nothingTyped.some((i) => i.preselect)).toBe(false)
    const noMatch = mapCompletions([res(0, [{ label: 'students', type: 'type', boost: 150 }])], 'zz')
    expect(noMatch.some((i) => i.preselect)).toBe(false)
  })

  it('ignores empty and null results', () => {
    expect(mapCompletions([null, undefined, res(0, [])], 'a')).toEqual([])
  })

  it('drops only what the editor would drop anyway (fuzzy-match prerequisite)', () => {
    const items = mapCompletions(
      [
        res(0, [
          { label: 'first_name', type: 'property', boost: 200 }, // prefix match
          { label: 'date_format', type: 'function' }, // subsequence match (d-f… no) — see below
          { label: 'tbl_9', type: 'type', boost: 150 }, // cannot match 'fir'
        ]),
      ],
      'fir',
    )
    // 'fir' is a subsequence of first_name only; the others cannot fuzzy-match
    expect(items.map((i) => i.label)).toEqual(['first_name'])
  })

  it('keeps out-of-order-but-fuzzy candidates, and everything when nothing is typed', () => {
    const fuzzy = mapCompletions([res(0, [{ label: 'date_trunc', type: 'function' }])], 'dtr')
    expect(fuzzy.map((i) => i.label)).toEqual(['date_trunc'])
    const all = mapCompletions([res(0, [{ label: 'zzz' }, { label: 'qqq' }])], '')
    expect(all).toHaveLength(2)
  })

  it('couldMatch is case-insensitive and subsequence-based', () => {
    expect(couldMatch('GETDATE', 'getd')).toBe(true)
    expect(couldMatch('students', 'STU'.toLowerCase())).toBe(true)
    expect(couldMatch('date_trunc', 'dtc')).toBe(true) // out of order chars, in order overall
    expect(couldMatch('students', 'xyz')).toBe(false)
    expect(couldMatch('tbl_9', 'fir')).toBe(false)
    expect(couldMatch('anything', '')).toBe(true)
    // non-ASCII labels still fold correctly
    expect(couldMatch('Ärzte', 'ä')).toBe(true)
    expect(couldMatch('Ärzte', 'q')).toBe(false)
  })

  it('maps detail and string info onto the fields Monaco renders', () => {
    const [item] = mapCompletions([res(0, [{ label: 'date_trunc', type: 'function', detail: 'date_trunc(text, timestamp)', info: 'datetime' }])], 'date')
    expect(item.detail).toBe('date_trunc(text, timestamp)')
    expect(item.documentation).toBe('datetime')
    expect(item.kind).toBe('function')
  })
})
