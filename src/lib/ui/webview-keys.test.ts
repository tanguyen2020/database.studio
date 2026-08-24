// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installWebViewKeyGuard, isBrowserChromeKey } from './webview-keys'
import { findShortcut } from '$lib/keys/shortcuts'

const key = (k: string, mod: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key: k,
  ctrlKey: !!mod.ctrl,
  metaKey: false,
  shiftKey: !!mod.shift,
  altKey: !!mod.alt,
})

describe('isBrowserChromeKey', () => {
  it('blocks reload (F5 / Ctrl+R, with or without modifiers)', () => {
    expect(isBrowserChromeKey(key('F5'))).toBe(true)
    expect(isBrowserChromeKey(key('F5', { ctrl: true }))).toBe(true)
    expect(isBrowserChromeKey(key('F5', { shift: true }))).toBe(true)
    expect(isBrowserChromeKey(key('r', { ctrl: true }))).toBe(true)
    expect(isBrowserChromeKey(key('R', { ctrl: true, shift: true }))).toBe(true)
  })

  it('blocks save-as / print / open / view-source / devtools', () => {
    expect(isBrowserChromeKey(key('s', { ctrl: true }))).toBe(true)
    expect(isBrowserChromeKey(key('p', { ctrl: true }))).toBe(true)
    expect(isBrowserChromeKey(key('P', { ctrl: true, shift: true }))).toBe(true)
    expect(isBrowserChromeKey(key('o', { ctrl: true }))).toBe(true)
    expect(isBrowserChromeKey(key('u', { ctrl: true }))).toBe(true)
    expect(isBrowserChromeKey(key('F12'))).toBe(true)
    expect(isBrowserChromeKey(key('i', { ctrl: true, shift: true }))).toBe(true)
    expect(isBrowserChromeKey(key('j', { ctrl: true, shift: true }))).toBe(true)
  })

  it('leaves plain typing and app keys alone', () => {
    expect(isBrowserChromeKey(key('r'))).toBe(false) // typing "r"
    expect(isBrowserChromeKey(key('s'))).toBe(false)
    expect(isBrowserChromeKey(key('Enter'))).toBe(false)
    expect(isBrowserChromeKey(key('F9'))).toBe(false)
    // Ctrl+Alt+R = "Result: Single Row", Ctrl+Alt+J = "Result: JSON"
    expect(isBrowserChromeKey(key('r', { ctrl: true, alt: true }))).toBe(false)
    expect(isBrowserChromeKey(key('j', { ctrl: true, alt: true }))).toBe(false)
  })

  it('never shadows a registered app shortcut', () => {
    // every entry of the app's shortcut map must survive the guard
    const combos = [
      key('f', { ctrl: true, shift: true }),
      key('c', { ctrl: true, shift: true }), // Copy result as JSON (NOT DevTools here)
      key('g', { ctrl: true, alt: true }),
      key('j', { ctrl: true, alt: true }),
      key('r', { ctrl: true, alt: true }),
      key('f', { ctrl: true }),
      key('j', { ctrl: true }),
      key('b', { ctrl: true, shift: true }),
      key('n', { ctrl: true, shift: true }),
      key('k', { ctrl: true, shift: true }),
      key('o', { ctrl: true, shift: true }),
    ]
    for (const c of combos) {
      expect(findShortcut(c), `${JSON.stringify(c)} should be an app shortcut`).toBeDefined()
      expect(isBrowserChromeKey(c), `${JSON.stringify(c)} must not be blocked`).toBe(false)
    }
  })
})

describe('installWebViewKeyGuard', () => {
  let dispose: (() => void) | null = null
  afterEach(() => {
    dispose?.()
    dispose = null
  })

  function press(k: string, mod: Partial<{ ctrl: boolean; shift: boolean }> = {}, target: EventTarget = document.body) {
    const ev = new KeyboardEvent('keydown', { key: k, ctrlKey: !!mod.ctrl, shiftKey: !!mod.shift, bubbles: true, cancelable: true })
    target.dispatchEvent(ev)
    return ev.defaultPrevented
  }

  it('blocks a key nothing in the app handled', () => {
    dispose = installWebViewKeyGuard()
    expect(press('F5')).toBe(true) // reload blocked
    expect(press('r', { ctrl: true })).toBe(true)
  })

  it('stays out of the way when the app handled the key first (editor F5 = Run)', () => {
    // The guard listens on window in the bubble phase, so an element handler runs
    // first. The editor ignores keys whose default is already prevented — if the
    // guard ran in the capture phase it would silently break F5 = Run query.
    dispose = installWebViewKeyGuard()
    const editor = document.createElement('div')
    document.body.appendChild(editor)
    let ran = 0
    editor.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return // exactly what @codemirror/view does
      ran++
      e.preventDefault() // the editor claims the key (its own Run handler)
    })
    expect(press('F5', {}, editor)).toBe(true)
    expect(ran).toBe(1) // the query ran
    editor.remove()
  })

  it('does not touch app shortcuts or typing', () => {
    dispose = installWebViewKeyGuard()
    expect(press('c', { ctrl: true, shift: true })).toBe(false)
    expect(press('a')).toBe(false)
  })

  it('the disposer removes the guard (dev build behaviour)', () => {
    installWebViewKeyGuard()()
    expect(press('r', { ctrl: true })).toBe(false)
  })
})
