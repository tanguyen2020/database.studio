// Browser-chrome keyboard shortcuts leak into the desktop window the same way the
// page context menu did: Ctrl+R / F5 reload the WebView (a desktop session starts
// with a clean tab list, so a reload throws open tabs away), Ctrl+S opens "Save as",
// Ctrl+P the print dialog, Ctrl+U view-source. None of those are app features.
//
// Blocked in the RELEASE desktop build only — `tauri dev` keeps them, because
// Ctrl+R to reload the frontend is part of the dev loop (see main.ts).
//
// The guard listens on `window` in the BUBBLE phase — i.e. after every app handler —
// and only prevents the default when nothing in the app claimed the key. That order is
// mandatory: the editor ignores any key whose default is already prevented
// (`eventBelongsToEditor` in @codemirror/view returns false on `event.defaultPrevented`),
// so a capture-phase guard silently killed F5 = Run query. Verified by e2e.

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/** True for keys that only the browser chrome reacts to — never an app shortcut.
 *
 *  Deliberately NOT listed:
 *  - `Ctrl+Shift+C` → the app's "Copy result as JSON" (DevTools is off in release).
 *  - `Ctrl+F`, `Ctrl+T`, `Ctrl+N`, `Ctrl+W`, `Ctrl+1..9` → app shortcuts that
 *    already call preventDefault() themselves (App.svelte / editor keymaps).
 *  - Zoom (`Ctrl+±`, `Ctrl+0`) → the app has its own scale control, but WebView
 *    zoom is harmless and some users rely on it. */
export function isBrowserChromeKey(e: KeyEventLike): boolean {
  const ctrl = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  // Reload — with or without modifiers (F5 / Ctrl+F5 / Shift+F5 / Ctrl+R / Ctrl+Shift+R).
  if (key === 'f5') return true
  if (ctrl && !e.altKey && key === 'r') return true
  // Save page / print / open file / view source.
  if (ctrl && !e.altKey && !e.shiftKey && (key === 's' || key === 'p' || key === 'o' || key === 'u')) return true
  if (ctrl && !e.altKey && e.shiftKey && key === 'p') return true
  // DevTools (already unavailable in a release build — block the keys too).
  if (key === 'f12') return true
  if (ctrl && e.shiftKey && !e.altKey && (key === 'i' || key === 'j')) return true
  return false
}

/** Install the guard. Returns a disposer (used by tests). */
export function installWebViewKeyGuard(root: Window = window): () => void {
  const onKeyDown = (e: Event) => {
    // An app handler already took this key (it called preventDefault) → nothing to do;
    // the browser action is dead either way. Only leftover keys get blocked here.
    if (!e.defaultPrevented && isBrowserChromeKey(e as KeyboardEvent)) e.preventDefault()
  }
  root.addEventListener('keydown', onKeyDown)
  return () => root.removeEventListener('keydown', onKeyDown)
}
