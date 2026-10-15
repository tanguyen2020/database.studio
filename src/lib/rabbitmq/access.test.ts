import { describe, expect, it } from 'vitest'
import {
  describeRegex,
  generatePassword,
  parsePolicyDefinition,
  policySummary,
  presetOf,
  regexError,
  withPolicyKey,
} from './access'

describe('rabbitmq access helpers', () => {
  it('recognises the permission presets and falls back to custom', () => {
    expect(presetOf({ configure: '.*', write: '.*', read: '.*' })).toBe('full')
    expect(presetOf({ configure: '^$', write: '^$', read: '.*' })).toBe('read-only')
    // the broker treats "" as "match nothing", same as ^$
    expect(presetOf({ configure: '', write: '', read: '.*' })).toBe('read-only')
    expect(presetOf({ configure: '^$', write: '.*', read: '^$' })).toBe('publish-only')
    expect(presetOf({ configure: '^app\\.', write: '.*', read: '.*' })).toBe('custom')
  })

  it('describes and validates regexes', () => {
    expect(describeRegex('.*')).toBe('everything')
    expect(describeRegex('^$')).toBe('nothing')
    expect(describeRegex('')).toBe('nothing')
    expect(describeRegex('^orders\\.')).toBe('names matching ^orders\\.')
    expect(regexError('^orders\\.')).toBeNull()
    expect(regexError('([')).not.toBeNull()
  })

  it('parses a policy definition: a non-empty JSON object only', () => {
    expect(parsePolicyDefinition('{"max-length": 5}')).toEqual({ ok: true, value: { 'max-length': 5 } })
    expect(parsePolicyDefinition('{}')).toMatchObject({ ok: false })
    expect(parsePolicyDefinition('[1]')).toMatchObject({ ok: false })
    expect(parsePolicyDefinition('{oops')).toMatchObject({ ok: false })
  })

  it('inserts a key without losing the rest (and keeps an existing value)', () => {
    const t = withPolicyKey('{"message-ttl": 1000}', 'max-length', 10)
    expect(JSON.parse(t)).toEqual({ 'message-ttl': 1000, 'max-length': 10 })
    expect(JSON.parse(withPolicyKey(t, 'max-length', 99))['max-length']).toBe(10)
    expect(JSON.parse(withPolicyKey('not json', 'expires', 5))).toEqual({ expires: 5 })
  })

  it('summarises a definition and generates usable passwords', () => {
    expect(policySummary({ 'max-length': 100, 'dead-letter-exchange': 'dlx' })).toBe('max-length=100 · dead-letter-exchange=dlx')
    const a = generatePassword()
    expect(a).toHaveLength(20)
    expect(a).toMatch(/^[\w.~-]+$/)
    expect(generatePassword()).not.toBe(a)
  })
})
