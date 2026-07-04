import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from './settings.svelte'

describe('mergeSettings', () => {
  it('returns defaults for empty/invalid input', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings('nope')).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('overrides valid keys with matching type', () => {
    const m = mergeSettings({ fontSize: 16, wordWrap: true, timezone: 'utc' })
    expect(m.fontSize).toBe(16)
    expect(m.wordWrap).toBe(true)
    expect(m.timezone).toBe('utc')
    // untouched keeps default
    expect(m.tabSize).toBe(DEFAULT_SETTINGS.tabSize)
  })

  it('ignores wrong-typed / unknown keys', () => {
    const m = mergeSettings({ fontSize: 'big', bogus: 1, defaultPageSize: 250 })
    expect(m.fontSize).toBe(DEFAULT_SETTINGS.fontSize) // string ignored
    expect(m.defaultPageSize).toBe(250)
    expect((m as unknown as Record<string, unknown>).bogus).toBeUndefined()
  })
})
