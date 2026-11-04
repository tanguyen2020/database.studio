import { describe, expect, it } from 'vitest'
import { kbd } from './label'

describe('kbd — shortcut labels per platform', () => {
  it('Windows / Linux keep the existing text', () => {
    expect(kbd('New SQL tab (Ctrl+T)', false)).toBe('New SQL tab (Ctrl+T)')
    expect(kbd('Ctrl+Shift+F', false)).toBe('Ctrl+Shift+F')
    expect(kbd('Save (Ctrl/Cmd+S)', false)).toBe('Save (Ctrl+S)')
  })

  it('Mac uses ⌘ in Apple order, no plus signs', () => {
    expect(kbd('Ctrl+T', true)).toBe('⌘T')
    expect(kbd('Ctrl+Shift+F', true)).toBe('⇧⌘F')
    expect(kbd('Ctrl+Alt+G', true)).toBe('⌥⌘G')
    expect(kbd('Ctrl+Enter', true)).toBe('⌘↩')
    expect(kbd('Ctrl+,', true)).toBe('⌘,')
    expect(kbd('Save (Ctrl/Cmd+S)', true)).toBe('Save (⌘S)')
  })

  it('rewrites every chord in a sentence and keeps the rest', () => {
    expect(kbd('Cancel (Ctrl+F5 / Esc)', true)).toBe('Cancel (⌘F5 / Esc)')
    expect(kbd('Ctrl+T / Ctrl+W', true)).toBe('⌘T / ⌘W')
    expect(kbd('Ctrl+Alt+G/J/R', true)).toBe('⌥⌘G/J/R')
    expect(kbd('Ctrl+1..9', true)).toBe('⌘1..9')
    expect(kbd('Press Ctrl+S in the SQL editor', true)).toBe('Press ⌘S in the SQL editor')
  })

  it('Ctrl+Tab and Ctrl+Space stay ⌃ (⌘Tab is the OS app switcher)', () => {
    expect(kbd('Ctrl+Tab', true)).toBe('⌃⇥')
    expect(kbd('Ctrl+Space', true)).toBe('⌃Space')
  })
})
