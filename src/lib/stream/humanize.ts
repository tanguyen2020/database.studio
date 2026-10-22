// Plain-language formatting for the Cache & Streaming workspaces
// (SPEC-STREAM-SHELL.md §1b, rule U4): numbers people can read at a glance,
// durations in words instead of milliseconds, times relative to now.

export { formatBytes } from '$lib/format/bytes'

/** 12904 → "12.9k", 1530000 → "1.5M"; below 1,000 the exact number. */
export function compactCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs < 1000) return sign + String(Math.round(abs))
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ]
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const v = abs / size
      const text = v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toString()
      return sign + text + suffix
    }
  }
  return sign + String(abs)
}

/** Full number with thousands separators: 12904 → "12,904". */
export function fullCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}

/** "1 message" / "3 messages". */
export function plural(n: number, one: string, many = one + 's'): string {
  return `${fullCount(n)} ${n === 1 ? one : many}`
}

const DURATION_UNITS: [number, string][] = [
  [7 * 24 * 3600_000, 'week'],
  [24 * 3600_000, 'day'],
  [3600_000, 'hour'],
  [60_000, 'minute'],
  [1000, 'second'],
]

/**
 * A duration in milliseconds as words: 604800000 → "7 days", 5400000 → "1.5 hours".
 * Negative values mean "forever" in Kafka/RabbitMQ settings (-1 = unlimited).
 */
export function humanDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 0) return 'Forever'
  if (ms === 0) return '0 seconds'
  if (ms < 1000) return `${Math.round(ms)} ms`
  for (const [size, unit] of DURATION_UNITS) {
    if (ms >= size) {
      const v = ms / size
      // retention settings read better in days ("7 days", "30 days") below 8 weeks
      if (unit === 'week' && v < 8) continue
      const rounded = Math.round(v * 10) / 10
      const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
      return `${text} ${unit}${rounded === 1 ? '' : 's'}`
    }
  }
  return `${ms} ms`
}

/** "just now", "6 min ago", "3 h ago", "2 days ago" (and "in 5 min" for the future). */
export function relativeTime(when: number | Date, now: number = Date.now()): string {
  const t = when instanceof Date ? when.getTime() : when
  if (!Number.isFinite(t)) return '—'
  const diff = now - t
  const future = diff < 0
  const s = Math.abs(diff) / 1000
  let text: string
  if (s < 45) return future ? 'in a few seconds' : 'just now'
  else if (s < 3600) text = `${Math.round(s / 60)} min`
  else if (s < 86400) text = `${Math.round(s / 3600)} h`
  else if (s < 86400 * 45) {
    const d = Math.round(s / 86400)
    text = `${d} day${d === 1 ? '' : 's'}`
  } else {
    const m = Math.round(s / (86400 * 30))
    text = `${m} month${m === 1 ? '' : 's'}`
  }
  return future ? `in ${text}` : `${text} ago`
}

/** Exact UTC timestamp for tooltips: "2026-10-21 08:14:03 UTC". */
export function exactUtc(when: number | Date): string {
  const d = when instanceof Date ? when : new Date(when)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

/** "75%" of a part/whole, clamped to [0, 100]; '—' when the whole is unknown/zero. */
export function percent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return '—'
  const p = Math.max(0, Math.min(100, (part / whole) * 100))
  return `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`
}
