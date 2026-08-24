// Monaco themes take concrete hex colors — they reject `var(--x)`, `rgb(...)` and
// `color-mix(...)`. The app's palette lives entirely in CSS custom properties
// (tokens.css + the theme-aware overrides in app.css), so the editor resolves a
// token through the browser (computed `color`, which is always a plain rgb/rgba)
// and normalises whatever comes back here.

/** Clamp to a 2-digit lowercase hex byte. */
function byte(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)))
  return v.toString(16).padStart(2, '0')
}

/**
 * Normalise any CSS color the browser can report into `#rrggbb` (or `#rrggbbaa`
 * when it carries alpha) — the only shapes Monaco's theme validator accepts.
 * Returns null for anything unparseable (so callers can fall back).
 */
export function toHex(css: string | null | undefined): string | null {
  const s = (css ?? '').trim().toLowerCase()
  if (!s) return null

  if (s.startsWith('#')) {
    const h = s.slice(1)
    if (/^[0-9a-f]{3}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
    if (/^[0-9a-f]{4}$/.test(h)) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`
    if (/^[0-9a-f]{6}$/.test(h) || /^[0-9a-f]{8}$/.test(h)) return `#${h}`
    return null
  }

  // rgb(r, g, b) / rgba(r, g, b, a) / rgb(r g b / a) — what getComputedStyle returns
  const m = /^rgba?\(([^)]+)\)$/.exec(s)
  if (!m) return null
  const parts = m[1]
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
  if (parts.length < 3) return null
  const num = (p: string, scale: number) =>
    p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p)
  const r = num(parts[0], 255)
  const g = num(parts[1], 255)
  const b = num(parts[2], 255)
  if (![r, g, b].every((n) => Number.isFinite(n))) return null
  let out = `#${byte(r)}${byte(g)}${byte(b)}`
  if (parts.length >= 4) {
    const a = num(parts[3], 1)
    if (Number.isFinite(a) && a < 1) out += byte(a * 255)
  }
  return out
}

/**
 * Resolve a CSS custom property to hex by asking the browser to compute it.
 * Works for plain hex tokens, `var()` chains AND `color-mix()` values.
 * `fallback` is returned when the token is missing or unparseable.
 */
export function resolveCssColor(name: string, fallback: string, root?: HTMLElement): string {
  if (typeof document === 'undefined') return fallback
  const host = root ?? document.body ?? document.documentElement
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;left:-9999px;top:-9999px;color:var(${name})`
  host.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  return toHex(computed) ?? fallback
}
