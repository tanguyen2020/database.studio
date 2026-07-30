// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installNativeMenuGuard, shouldSuppressNativeMenu } from './native-menu'

let dispose: (() => void) | null = null
afterEach(() => {
  dispose?.()
  dispose = null
  document.body.innerHTML = ''
})

function rightClick(el: Element | Document): boolean {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
  el.dispatchEvent(ev)
  return ev.defaultPrevented
}

describe('shouldSuppressNativeMenu', () => {
  it('suppresses on plain page content', () => {
    document.body.innerHTML = '<div id="row"><span id="cell">students</span></div>'
    expect(shouldSuppressNativeMenu(document.getElementById('cell'))).toBe(true)
    expect(shouldSuppressNativeMenu(document.body)).toBe(true)
    expect(shouldSuppressNativeMenu(null)).toBe(true)
  })

  it('keeps the native editing menu in editable fields (Cut/Copy/Paste)', () => {
    document.body.innerHTML = `
      <input id="host" />
      <textarea id="notes"></textarea>
      <div id="editor" contenteditable="true"><span id="tok">SELECT</span></div>
      <input id="ro" readonly />
      <input id="dis" disabled />`
    expect(shouldSuppressNativeMenu(document.getElementById('host'))).toBe(false)
    expect(shouldSuppressNativeMenu(document.getElementById('notes'))).toBe(false)
    // a right-click inside the CodeMirror editor lands on a child token element
    expect(shouldSuppressNativeMenu(document.getElementById('tok'))).toBe(false)
    // read-only / disabled inputs cannot be pasted into → page menu is suppressed
    expect(shouldSuppressNativeMenu(document.getElementById('ro'))).toBe(true)
    expect(shouldSuppressNativeMenu(document.getElementById('dis'))).toBe(true)
  })
})

describe('installNativeMenuGuard', () => {
  it('prevents the default menu on page content but not in an input', () => {
    document.body.innerHTML = '<div id="tree">public</div><input id="host" />'
    dispose = installNativeMenuGuard()
    expect(rightClick(document.getElementById('tree')!)).toBe(true)
    expect(rightClick(document.getElementById('host')!)).toBe(false)
  })

  it('does not stop propagation — the app\'s own context menus still fire', () => {
    document.body.innerHTML = '<div id="row">students</div>'
    dispose = installNativeMenuGuard()
    let appMenuOpened = 0
    document.getElementById('row')!.addEventListener('contextmenu', () => appMenuOpened++)
    expect(rightClick(document.getElementById('row')!)).toBe(true)
    expect(appMenuOpened).toBe(1)
  })

  it('the disposer removes the guard', () => {
    document.body.innerHTML = '<div id="row">students</div>'
    installNativeMenuGuard()()
    expect(rightClick(document.getElementById('row')!)).toBe(false)
  })
})
