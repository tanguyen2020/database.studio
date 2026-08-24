import { describe, expect, it } from 'vitest'
import { toHex } from './color'

// Monaco rejects a theme color it cannot parse (and throws while defining the
// theme, which would leave the editor unstyled), so every shape the browser can
// report has to normalise here.
describe('toHex', () => {
  it('normalises the rgb/rgba shapes getComputedStyle returns', () => {
    expect(toHex('rgb(255, 0, 0)')).toBe('#ff0000')
    expect(toHex('rgb(1, 2, 3)')).toBe('#010203')
    expect(toHex('rgba(0, 0, 0, 1)')).toBe('#000000')
    // alpha below 1 is kept — Monaco understands #rrggbbaa
    expect(toHex('rgba(91, 124, 255, 0.5)')).toBe('#5b7cff80')
    // the space/slash syntax (color-mix results come back this way)
    expect(toHex('rgb(91 124 255 / 0.2)')).toBe('#5b7cff33')
  })

  it('expands and passes through hex', () => {
    expect(toHex('#fff')).toBe('#ffffff')
    expect(toHex('#ABCDEF')).toBe('#abcdef')
    expect(toHex('#12345678')).toBe('#12345678')
    expect(toHex('#f00c')).toBe('#ff0000cc')
  })

  it('clamps out-of-range channels instead of emitting invalid hex', () => {
    expect(toHex('rgb(300, -20, 0)')).toBe('#ff0000')
  })

  it('returns null for anything unparseable, so callers fall back', () => {
    expect(toHex('')).toBeNull()
    expect(toHex(null)).toBeNull()
    expect(toHex('var(--surface)')).toBeNull()
    expect(toHex('color-mix(in srgb, red 50%, blue)')).toBeNull()
    expect(toHex('#12345')).toBeNull()
    expect(toHex('rgb(1, 2)')).toBeNull()
  })
})
