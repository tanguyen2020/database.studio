// Suppress the WebView's own page context menu (Back / Refresh / Save as / Print /
// More tools / Send tab to your devices) inside the desktop app — it is a browser
// affordance that leaks into a native-feeling window, and "Refresh" there reloads
// the app (desktop sessions start with a clean tab list, so a reload throws work
// away). The app's own right-click menus (Explorer tree, Result Grid, tabs…) keep
// working: this only calls preventDefault(), never stopPropagation(), so the
// components' own `contextmenu` handlers still run and open their menu.
//
// Editable fields are left alone on purpose: there the WebView shows the *editing*
// menu (Undo/Cut/Copy/Paste/Select all), which is genuinely useful when pasting a
// host, password or query — and the app has no replacement for it.

/** Editable targets that keep the native Cut/Copy/Paste menu. */
const EDITABLE = 'input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable="true"], [contenteditable=""]'

/** True when the WebView's default menu should be blocked for this event target. */
export function shouldSuppressNativeMenu(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null
  if (!el) return true // right-click on the document/body itself → page menu
  return !el.closest(EDITABLE)
}

/** Install the guard. Returns a disposer (used by tests). */
export function installNativeMenuGuard(root: Document = document): () => void {
  const onContextMenu = (e: Event) => {
    // Bubble phase, and only when nobody handled the click: bits-ui's context-menu
    // trigger starts with `if (e.defaultPrevented) return` (menu.svelte.js), so a
    // capture-phase preventDefault() here silently killed every app menu (Explorer
    // tree, Connections, tabs…). Same trap as the CodeMirror F5 one. Components that
    // do own the right-click already call preventDefault() themselves, which both
    // opens their menu and keeps the WebView menu away.
    if (e.defaultPrevented) return
    if (shouldSuppressNativeMenu(e.target)) e.preventDefault()
  }
  root.addEventListener('contextmenu', onContextMenu)
  return () => root.removeEventListener('contextmenu', onContextMenu)
}
