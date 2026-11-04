// Shortcut labels in the platform's own notation.
//
// Every app shortcut accepts Ctrl OR ⌘ (see findShortcut), and Monaco binds
// CtrlCmd, so on a Mac the key to press is ⌘ — but the labels said "Ctrl+…".
// `kbd('Ctrl+Shift+F')` gives "Ctrl+Shift+F" on Windows/Linux and "⇧⌘F" on a
// Mac (Apple's order: ⌃ ⌥ ⇧ ⌘, then the key, no plus signs).

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  // Test seam (browser build only): `?mac=1` renders the Mac labels.
  if (typeof location !== 'undefined' && /[?&]mac=1\b/.test(location.search)) return true
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return /Mac|iPhone|iPad|iPod/i.test(nav.userAgentData?.platform || navigator.platform || '')
}

export const IS_MAC = detectMac()

const MAC_KEY: Record<string, string> = {
  enter: '↩',
  return: '↩',
  tab: '⇥',
  backspace: '⌫',
  delete: '⌫',
  esc: '⎋',
  escape: '⎋',
  space: 'Space',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
}

/** Keys where "Ctrl" really means ⌃ on a Mac: ⌘Tab is the OS app switcher and
 *  Monaco's suggest is ⌃Space on every platform. */
const REAL_CONTROL = new Set(['tab', 'space'])

function macChord(mods: string[], key: string): string {
  const k = key.toLowerCase()
  let ctrl = false
  let alt = false
  let shift = false
  let cmd = false
  for (const m of mods) {
    const l = m.toLowerCase()
    if (l === 'shift') shift = true
    else if (l === 'alt' || l === 'option' || l === 'opt') alt = true
    else if (l === 'cmd' || l === 'meta' || l === 'ctrl/cmd' || l === 'cmdorctrl') cmd = true
    else if (l === 'ctrl' || l === 'control') {
      if (REAL_CONTROL.has(k)) ctrl = true
      else cmd = true
    }
  }
  const keyLabel = MAC_KEY[k] ?? (key.length === 1 ? key.toUpperCase() : key)
  return `${ctrl ? '⌃' : ''}${alt ? '⌥' : ''}${shift ? '⇧' : ''}${cmd ? '⌘' : ''}${keyLabel}`
}

const CHORD = /((?:(?:Ctrl\/Cmd|CmdOrCtrl|Ctrl|Control|Cmd|Meta|Shift|Alt|Option)\+)+)([^\s+]+)/g

/** Rewrite every chord inside a label ("Run (Ctrl+Enter) · Cancel Ctrl+F5 / Esc"). */
export function kbd(label: string, mac: boolean = IS_MAC): string {
  if (!mac) return label.replace(/Ctrl\/Cmd\+|CmdOrCtrl\+/g, 'Ctrl+')
  return label.replace(CHORD, (_all, mods: string, key: string) => {
    // a chord may cover several keys: "Ctrl+Alt+G/J/R" → ⌥⌘G/J/R
    const parts = key.split('/')
    const head = macChord(mods.split('+').filter(Boolean), parts[0])
    return parts.length > 1 ? `${head}/${parts.slice(1).join('/')}` : head
  })
}

/** Query History: ⌘H is Hide on a Mac (system menu), so the Mac key is ⌘Y — the
 *  same key Safari uses for History. */
export const HISTORY_KEY = IS_MAC ? 'y' : 'h'
