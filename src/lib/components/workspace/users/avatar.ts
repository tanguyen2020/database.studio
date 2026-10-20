// Pure helpers for principal avatars (Users & Privileges).

/** Accent tokens an avatar can take — all theme-aware (light + dark). */
export const AVATAR_HUES = [
  'var(--sacc-blue)',
  'var(--sacc-green)',
  'var(--sacc-purple)',
  'var(--sacc-orange)',
  'var(--sacc-cyan)',
  'var(--sacc-mauve)',
  'var(--sacc-amber)',
  'var(--sacc-red)',
] as const

/** Stable hue for a name (FNV-1a), so a principal keeps its colour everywhere. */
export function avatarHue(name: string): string {
  let h = 0x811c9dc5
  for (const ch of name.toLowerCase()) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193)
  }
  return AVATAR_HUES[(h >>> 0) % AVATAR_HUES.length]
}

/**
 * Up to two initials. Principal names are identifiers (`app_user`, `svc.reporting`,
 * `alice@%`, `DOMAIN\bob`, `APP_USER`), so split on the usual separators and take
 * the first letter of the first two words; a single word gives its first two
 * letters. The host / auth-database part after `@` is ignored.
 */
export function initialsOf(name: string): string {
  const base = name.split('@')[0].split('\\').pop() ?? ''
  const words = base.split(/[\s._\-:/]+/).filter((w) => /[\p{L}\p{N}]/u.test(w))
  if (!words.length) return '?'
  const first = (w: string) => [...w.replace(/[^\p{L}\p{N}]/gu, '')][0] ?? ''
  if (words.length === 1) return [...words[0].replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('').toUpperCase() || '?'
  return (first(words[0]) + first(words[1])).toUpperCase()
}
