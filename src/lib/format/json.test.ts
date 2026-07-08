import { describe, expect, it } from 'vitest'
import { highlightJson, jsonTokenColor } from './json'

// Re-assemble the token text to prove nothing is dropped or reordered.
const join = (s: string) => highlightJson(s).map((t) => t.text).join('')
const kinds = (s: string) => highlightJson(s).map((t) => t.kind)

describe('highlightJson', () => {
  it('is lossless — tokens rejoin to the original text', () => {
    const src = JSON.stringify({ id: 1000, name: 'a', ok: true, n: null }, null, 2)
    expect(join(src)).toBe(src)
  })

  it('classifies keys, strings, numbers, booleans, null', () => {
    const src = '{"id": 1000, "name": "abc", "ok": true, "bad": false, "n": null}'
    const k = kinds(src)
    expect(k).toContain('key')
    expect(k).toContain('number')
    expect(k).toContain('string')
    expect(k).toContain('boolean')
    expect(k).toContain('null')
  })

  it('splits a key from its trailing colon', () => {
    const toks = highlightJson('{"id": 1}')
    const key = toks.find((t) => t.kind === 'key')!
    expect(key.text).toBe('"id"')
    // the colon is a separate plain token, never folded into the key
    expect(toks.some((t) => t.kind === 'plain' && t.text.includes(':'))).toBe(true)
  })

  it('a bare string value is a string, not a key', () => {
    expect(kinds('"hello"')).toEqual(['string'])
  })

  it('does not treat a colon inside a string value as a key', () => {
    const toks = highlightJson('{"t": "10:23:14"}')
    expect(toks.find((t) => t.text === '"10:23:14"')?.kind).toBe('string')
  })

  it('handles negative and exponent numbers', () => {
    expect(kinds('-3.5e10')).toEqual(['number'])
  })
})

describe('jsonTokenColor', () => {
  it('maps each kind to a syntax var, plain to neutral text', () => {
    expect(jsonTokenColor('string')).toBe('var(--syntax-string)')
    expect(jsonTokenColor('key')).toBe('var(--syntax-function)')
    expect(jsonTokenColor('plain')).toBe('var(--text2)')
  })
})
