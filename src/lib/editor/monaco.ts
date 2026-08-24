// Monaco bootstrap.
//
// Imported lean on purpose: the editor itself plus the SQL/JS *monarch*
// tokenizers, and NOT `editor.main.js` (which drags in the TypeScript, JSON, CSS
// and HTML language services — megabytes we never use). The theme is built from
// the app's CSS tokens so light/dark match the rest of the chrome, and it is
// rebuilt whenever the theme toggles.

import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/mysql/mysql.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/pgsql/pgsql.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import MonacoEditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { resolveCssColor } from './color'

export { monaco }

/** Single theme name, redefined in place whenever light/dark flips. */
export const DS_THEME = 'ds'

let workersInstalled = false

/** Wire the editor worker (bundled by Vite, same-origin — CSP-safe). */
export function installMonacoWorkers() {
  if (workersInstalled) return
  workersInstalled = true
  const g = self as unknown as { MonacoEnvironment?: { getWorker: () => Worker } }
  g.MonacoEnvironment = { getWorker: () => new MonacoEditorWorker() }
}

/**
 * Give back the keys the app owns. Monaco ships editor bindings that would
 * otherwise shadow a global shortcut whenever the editor has focus (which is most
 * of the time in a query tab): Ctrl+Shift+K deletes a line instead of focusing the
 * connections filter, and F1 opens Monaco's own command palette. Removing the
 * binding lets the event reach the app's window handler.
 */
export function releaseAppKeybindings() {
  monaco.editor.addKeybindingRules([
    { keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyK, command: null },
    { keybinding: monaco.KeyCode.F1, command: null },
  ])
}

/** hex without the leading '#' — the shape Monaco token rules require. */
function bare(name: string, fallback: string): string {
  return resolveCssColor(name, fallback).replace('#', '')
}

/** Define (or redefine) the app theme from the current CSS custom properties. */
export function defineDsTheme() {
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

  monaco.editor.defineTheme(DS_THEME, {
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
      // mongosh (JavaScript monarch)
      { token: 'regexp', foreground: bare('--syntax-string', '#98c379') },
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
    },
  })
  monaco.editor.setTheme(DS_THEME)
}

/**
 * Keep the theme in step with the app's light/dark toggle (which flips the `dark`
 * class on <html>). Returns a disposer.
 */
export function watchDsTheme(): () => void {
  if (typeof MutationObserver === 'undefined') return () => {}
  const obs = new MutationObserver(() => defineDsTheme())
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => obs.disconnect()
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
