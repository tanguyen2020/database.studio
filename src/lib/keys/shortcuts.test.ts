import { describe, expect, it } from 'vitest'
import { findShortcut } from './shortcuts'

const ev = (over: Partial<Parameters<typeof findShortcut>[0]>) => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  key: '',
  ...over,
})

describe('findShortcut', () => {
  it('Ctrl+Shift+F → format (not find)', () => {
    expect(findShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'F' }))?.id).toBe('format')
  })
  it('Ctrl+F (no shift) → find-in-explorer', () => {
    expect(findShortcut(ev({ ctrlKey: true, key: 'f' }))?.id).toBe('find-in-explorer')
  })
  it('Ctrl+Shift+C → copy result as JSON', () => {
    expect(findShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'c' }))?.id).toBe('copy-json')
  })
  it('Ctrl+Alt+G/J/R → result grid/json/single', () => {
    expect(findShortcut(ev({ ctrlKey: true, altKey: true, key: 'g' }))?.id).toBe('result-grid')
    expect(findShortcut(ev({ ctrlKey: true, altKey: true, key: 'j' }))?.id).toBe('result-json')
    expect(findShortcut(ev({ ctrlKey: true, altKey: true, key: 'r' }))?.id).toBe('result-single')
  })
  it('Cmd (metaKey) counts as Ctrl', () => {
    expect(findShortcut(ev({ metaKey: true, shiftKey: true, key: 'f' }))?.id).toBe('format')
  })
  it('plain Ctrl+C (copy) is not a mapped shortcut', () => {
    expect(findShortcut(ev({ ctrlKey: true, key: 'c' }))).toBeUndefined()
  })
})
