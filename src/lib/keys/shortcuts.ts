// Keyboard shortcut map (Phase 5 · T21) — pure data + matcher → unit-testable.
// Ctrl == Ctrl hoặc Cmd (mac). Các phím còn thiếu được bind ở App.svelte.

export interface Shortcut {
  id: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string // lowercase
  label: string
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'format', ctrl: true, shift: true, alt: false, key: 'f', label: 'Format SQL' },
  { id: 'copy-json', ctrl: true, shift: true, alt: false, key: 'c', label: 'Copy result as JSON' },
  { id: 'result-grid', ctrl: true, shift: false, alt: true, key: 'g', label: 'Result: Grid' },
  { id: 'result-json', ctrl: true, shift: false, alt: true, key: 'j', label: 'Result: JSON' },
  { id: 'result-single', ctrl: true, shift: false, alt: true, key: 'r', label: 'Result: Single Row' },
  { id: 'find-in-explorer', ctrl: true, shift: false, alt: false, key: 'f', label: 'Find in Explorer' },
  { id: 'toggle-result', ctrl: true, shift: false, alt: false, key: 'j', label: 'Toggle Result panel' },
]

export interface KeyLike {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  key: string
}

/** Trả về shortcut khớp sự kiện phím, hoặc undefined. */
export function findShortcut(e: KeyLike): Shortcut | undefined {
  const ctrl = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  return SHORTCUTS.find((s) => s.ctrl === ctrl && s.shift === e.shiftKey && s.alt === e.altKey && s.key === key)
}
