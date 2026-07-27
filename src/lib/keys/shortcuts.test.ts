import { describe, expect, it } from 'vitest'
import { findShortcut, SHORTCUTS } from './shortcuts'

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
  it('Ctrl+J (no alt) → toggle Result panel (distinct from Ctrl+Alt+J result-json)', () => {
    expect(findShortcut(ev({ ctrlKey: true, key: 'j' }))?.id).toBe('toggle-result')
    expect(findShortcut(ev({ ctrlKey: true, altKey: true, key: 'j' }))?.id).toBe('result-json')
  })
  it('Cmd (metaKey) counts as Ctrl', () => {
    expect(findShortcut(ev({ metaKey: true, shiftKey: true, key: 'f' }))?.id).toBe('format')
  })
  it('plain Ctrl+C (copy) is not a mapped shortcut', () => {
    expect(findShortcut(ev({ ctrlKey: true, key: 'c' }))).toBeUndefined()
  })
  it('Connections shortcuts: Ctrl+Shift+B/N/K/O', () => {
    // B, not E — Ctrl+Shift+E is the editor's Explain binding.
    expect(findShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'b' }))?.id).toBe('connections-focus')
    expect(findShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'e' }))).toBeUndefined()
    expect(findShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'N' }))?.id).toBe('connection-new')
    expect(findShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'k' }))?.id).toBe('connections-filter')
    expect(findShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'o' }))?.id).toBe('connection-toggle')
  })
  it('Connections shortcuts do not shadow the plain-Ctrl bindings', () => {
    // Ctrl+N (no shift) stays "new query tab" (bound in App.svelte, unmapped here).
    expect(findShortcut(ev({ ctrlKey: true, key: 'n' }))).toBeUndefined()
    expect(findShortcut(ev({ ctrlKey: true, key: 'e' }))).toBeUndefined()
    expect(findShortcut(ev({ ctrlKey: true, key: 'o' }))).toBeUndefined()
  })
  it('every shortcut combination is unique', () => {
    const seen = new Set<string>()
    for (const s of SHORTCUTS) {
      const combo = `${s.ctrl}-${s.shift}-${s.alt}-${s.key}`
      expect(seen.has(combo), `duplicate binding for ${combo} (${s.id})`).toBe(false)
      seen.add(combo)
    }
  })
})
