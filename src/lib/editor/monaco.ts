// Monaco loader.
//
// Monaco is ~4 MB of JavaScript. The app opens with NO tab (see tabs.restore in
// the desktop build), so paying for it during boot buys nothing — it is loaded on
// demand, the first time a query editor mounts, and every later editor reuses the
// same module. Everything here is therefore async-first: callers `await
// loadMonaco()` and receive the API object.
//
// Imported lean on purpose: the editor plus the SQL/JS *monarch* tokenizers, and
// NOT `editor.main.js`, which drags in the TypeScript, JSON, CSS and HTML language
// services we never use.

import type * as Monaco from 'monaco-editor'
import { resolveCssColor } from './color'

export type MonacoApi = typeof Monaco

/** Single theme name, redefined in place whenever light/dark flips. */
export const DS_THEME = 'ds'

let api: MonacoApi | null = null
let inFlight: Promise<MonacoApi> | null = null

/** The API if it is already loaded — for code that must not trigger the download. */
export function loadedMonaco(): MonacoApi | null {
  return api
}

/** Load Monaco once; concurrent callers share the same download. */
export function loadMonaco(): Promise<MonacoApi> {
  if (api) return Promise.resolve(api)
  if (inFlight) return inFlight
  inFlight = (async () => {
    const [, , , , , mod, worker] = await Promise.all([
      import('monaco-editor/esm/vs/editor/editor.all.js'),
      import('monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/pgsql/pgsql.contribution.js'),
      import('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'),
      import('monaco-editor/esm/vs/editor/editor.api.js'),
      import('monaco-editor/esm/vs/editor/editor.worker?worker'),
    ])
    const g = self as unknown as { MonacoEnvironment?: { getWorker: () => Worker } }
    // the editor worker, bundled by Vite as a same-origin file (CSP-safe)
    g.MonacoEnvironment = { getWorker: () => new worker.default() }
    api = mod as unknown as MonacoApi
    return api
  })()
  return inFlight
}

/**
 * Give back the keys the app owns. Monaco ships editor bindings that would
 * otherwise shadow a global shortcut whenever the editor has focus (which is most
 * of the time in a query tab): Ctrl+Shift+K deletes a line instead of focusing the
 * connections filter, and F1 opens Monaco's own command palette. Removing the
 * binding lets the event reach the app's window handler.
 */
export function releaseAppKeybindings(m: MonacoApi) {
  m.editor.addKeybindingRules([
    { keybinding: m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.KeyK, command: null },
    { keybinding: m.KeyCode.F1, command: null },
  ])
}

/** hex without the leading '#' — the shape Monaco token rules require. */
function bare(name: string, fallback: string): string {
  return resolveCssColor(name, fallback).replace('#', '')
}

/** Define (or redefine) the app theme from the current CSS custom properties. */
export function defineDsTheme(m: MonacoApi = api!) {
  if (!m) return
  const dark = document.documentElement.classList.contains('dark')
  const c = (name: string, fallback: string) => resolveCssColor(name, fallback)

  const surface = c('--surface', dark ? '#161a23' : '#ffffff')
  const text = c('--text', dark ? '#e6e9f0' : '#1f2937')
  const raised = c('--raised', dark ? '#222838' : '#ffffff')
  const border2 = c('--border2', dark ? '#333b4d' : '#d2d8e4')
  const hover = c('--hover', dark ? '#1f2533' : '#eef1f7')
  const primary = c('--primary', dark ? '#5b7cff' : '#3858e9')
  const muted = c('--muted', dark ? '#6b7486' : '#8a93a6')
  const text2 = c('--text2', dark ? '#b9c0cf' : '#4b5563')
  const error = c('--error', '#e05252')
  const warn = c('--warn2', '#d19a66')
  const sel = c('--grid-select', primary)

  m.editor.defineTheme(DS_THEME, {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: bare('--text', text) },
      { token: 'keyword', foreground: bare('--syntax-keyword', '#c678dd'), fontStyle: 'bold' },
      { token: 'operator', foreground: bare('--syntax-operator', '#56b6c2') },
      { token: 'delimiter', foreground: bare('--syntax-operator', '#56b6c2') },
      { token: 'string', foreground: bare('--syntax-string', '#98c379') },
      { token: 'number', foreground: bare('--syntax-number', '#d19a66') },
      { token: 'comment', foreground: bare('--syntax-comment', '#7f8a9e'), fontStyle: 'italic' },
      { token: 'predefined', foreground: bare('--syntax-function', '#61afef') },
      { token: 'type', foreground: bare('--syntax-type', '#e5c07b') },
      { token: 'identifier', foreground: bare('--text', text) },
      { token: 'identifier.quote', foreground: bare('--syntax-string', '#98c379') },
      // mongosh (JavaScript monarch) + JSON values
      { token: 'regexp', foreground: bare('--syntax-string', '#98c379') },
      { token: 'string.key', foreground: bare('--syntax-function', '#61afef') },
      { token: 'string.value', foreground: bare('--syntax-string', '#98c379') },
    ],
    colors: {
      'editor.background': surface,
      'editor.foreground': text,
      'editorGutter.background': surface,
      'editorLineNumber.foreground': muted,
      'editorLineNumber.activeForeground': text2,
      'editor.lineHighlightBackground': hover,
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': text,
      'editor.selectionBackground': sel + '55',
      'editor.inactiveSelectionBackground': sel + '33',
      'editor.selectionHighlightBackground': sel + '22',
      'editor.wordHighlightBackground': sel + '22',
      'editorBracketMatch.background': primary + '33',
      'editorBracketMatch.border': primary,
      'editorIndentGuide.background1': border2,
      'editorWhitespace.foreground': border2,
      'editorError.foreground': error,
      'editorWarning.foreground': warn,
      'editorWidget.background': raised,
      'editorWidget.foreground': text,
      'editorWidget.border': border2,
      'editorHoverWidget.background': raised,
      'editorHoverWidget.border': border2,
      'editorSuggestWidget.background': raised,
      'editorSuggestWidget.border': border2,
      'editorSuggestWidget.foreground': text,
      'editorSuggestWidget.selectedBackground': sel,
      'editorSuggestWidget.selectedForeground': '#ffffff',
      'editorSuggestWidget.highlightForeground': primary,
      'editorSuggestWidget.focusHighlightForeground': '#ffffff',
      'list.hoverBackground': hover,
      'input.background': surface,
      'input.foreground': text,
      'input.border': border2,
      focusBorder: primary,
      'scrollbarSlider.background': border2 + '99',
      'scrollbarSlider.hoverBackground': border2,
      'scrollbarSlider.activeBackground': primary,
      'diffEditor.insertedTextBackground': '#28a74533',
      'diffEditor.removedTextBackground': '#d7373733',
    },
  })
  m.editor.setTheme(DS_THEME)
}

let themeWatch: (() => void) | null = null

/**
 * Keep the theme in step with the app's light/dark toggle (which flips the `dark`
 * class on <html>). Installed once; returns a disposer.
 */
export function watchDsTheme(): () => void {
  if (themeWatch) return themeWatch
  if (typeof MutationObserver === 'undefined') return () => {}
  const obs = new MutationObserver(() => defineDsTheme())
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  themeWatch = () => {
    obs.disconnect()
    themeWatch = null
  }
  return themeWatch
}

/** Editor font (family + size) resolved from the app's tokens. */
export function editorFont(): { fontFamily: string; fontSize: number } {
  const probe = document.createElement('span')
  probe.style.cssText =
    'position:absolute;left:-9999px;top:-9999px;font-family:var(--font-mono);font-size:var(--px-13)'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const fontFamily = cs.fontFamily || 'monospace'
  const fontSize = parseFloat(cs.fontSize) || 13
  probe.remove()
  return { fontFamily, fontSize }
}
