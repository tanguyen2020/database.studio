// Date/time display for result grids (Settings → Data → Datetime format / Timezone).
//
// Display only: the value written back by an edit, copied, or exported is always
// the value the server returned. Drivers send ISO-like text — `2026-06-30T10:23:14`,
// `2026-06-30 10:23:14.123`, `2026-06-30T10:23:14+00:00`, `2026-06-30`.
//
// * Timezone only applies to a value that CARRIES an offset (timestamptz,
//   datetimeoffset…): it is shown in local time or in UTC. A value without one has
//   no zone to convert from and is shown as written.
// * Format "ISO 8601" (the default) → `yyyy-MM-dd HH:mm:ss[.fff]`, plus the offset
//   for a zoned value. Anything else is a pattern: yyyy yy MM M dd d HH H hh h mm
//   ss SSS a XXX (offset); other characters are copied; '…' quotes literal text.

export type DisplayTimezone = 'local' | 'utc'

export interface DateTimeDisplay {
  format: string
  timezone: DisplayTimezone
}

/** Patterns offered in Settings (the field still accepts any pattern). */
export const DATETIME_PRESETS = ['ISO 8601', 'yyyy-MM-dd HH:mm:ss', 'dd/MM/yyyy HH:mm:ss', 'MM/dd/yyyy hh:mm:ss a', 'dd.MM.yyyy HH:mm'] as const

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/

/** Column types whose values are dates/timestamps (not plain `time`). */
export function isDateTimeType(type: string | undefined | null): boolean {
  const t = (type ?? '').toLowerCase()
  if (!t) return false
  if (/\btime\b(?! zone)/.test(t) && !/timestamp|datetime/.test(t)) return false // time / time with time zone
  return /timestamp|datetime|smalldatetime|datetimeoffset|^date$|^date\b|nullable\(date/.test(t)
}

interface Parts {
  y: number
  mo: number
  d: number
  h: number
  mi: number
  s: number
  frac: string
  hasTime: boolean
  /** minutes east of UTC shown with the value, or null for a naive value */
  offset: number | null
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function parse(value: string, tz: DisplayTimezone): Parts | null {
  const m = ISO_RE.exec(value.trim())
  if (!m) return null
  const [, Y, Mo, D, H, Mi, S, F, Z] = m
  const hasTime = H !== undefined
  const base: Parts = {
    y: +Y,
    mo: +Mo,
    d: +D,
    h: hasTime ? +H : 0,
    mi: hasTime ? +Mi : 0,
    s: S ? +S : 0,
    frac: F ?? '',
    hasTime,
    offset: null,
  }
  if (!Z || !hasTime) return base
  // zoned: move the instant into the display zone
  const sign = Z === 'Z' ? 1 : Z[0] === '-' ? -1 : 1
  const digits = Z === 'Z' ? '0000' : Z.slice(1).replace(':', '').padEnd(4, '0')
  const srcOffset = sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4))
  const utcMs = Date.UTC(base.y, base.mo - 1, base.d, base.h, base.mi, base.s) - srcOffset * 60_000
  const shown = new Date(utcMs)
  const off = tz === 'utc' ? 0 : -shown.getTimezoneOffset()
  const at = new Date(utcMs + off * 60_000)
  return {
    y: at.getUTCFullYear(),
    mo: at.getUTCMonth() + 1,
    d: at.getUTCDate(),
    h: at.getUTCHours(),
    mi: at.getUTCMinutes(),
    s: at.getUTCSeconds(),
    frac: base.frac,
    hasTime: true,
    offset: off,
  }
}

function offsetText(min: number): string {
  if (min === 0) return 'Z'
  const sign = min < 0 ? '-' : '+'
  const a = Math.abs(min)
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`
}

function applyPattern(p: Parts, pattern: string): string {
  // a date-only value drops the time part of the pattern
  const pat = p.hasTime ? pattern : pattern.replace(/[\sT,]*[Hhms].*$/, '').trim() || 'yyyy-MM-dd'
  const tokens: [RegExp, () => string][] = [
    [/^yyyy/, () => String(p.y)],
    [/^yy/, () => pad(p.y % 100)],
    [/^MM/, () => pad(p.mo)],
    [/^M/, () => String(p.mo)],
    [/^dd/, () => pad(p.d)],
    [/^d/, () => String(p.d)],
    [/^HH/, () => pad(p.h)],
    [/^H/, () => String(p.h)],
    [/^hh/, () => pad(p.h % 12 || 12)],
    [/^h/, () => String(p.h % 12 || 12)],
    [/^mm/, () => pad(p.mi)],
    [/^ss/, () => pad(p.s)],
    [/^SSS/, () => (p.frac + '000').slice(0, 3)],
    [/^a/, () => (p.h < 12 ? 'AM' : 'PM')],
    [/^XXX/, () => (p.offset === null ? '' : offsetText(p.offset))],
  ]
  let out = ''
  let i = 0
  outer: while (i < pat.length) {
    if (pat[i] === "'") {
      const end = pat.indexOf("'", i + 1)
      out += end < 0 ? pat.slice(i + 1) : pat.slice(i + 1, end)
      i = end < 0 ? pat.length : end + 1
      continue
    }
    const rest = pat.slice(i)
    for (const [re, f] of tokens) {
      const m = re.exec(rest)
      if (m) {
        out += f()
        i += m[0].length
        continue outer
      }
    }
    out += pat[i]
    i++
  }
  return out.trim()
}

/**
 * The text a grid shows for a date/time value, or null when `value` is not one
 * this formatter understands (it is then shown as written).
 */
export function formatDateTime(value: string, opts: DateTimeDisplay): string | null {
  const p = parse(value, opts.timezone)
  if (!p) return null
  const fmt = opts.format.trim()
  if (!fmt || /^iso\s*8601$/i.test(fmt)) {
    const date = `${p.y}-${pad(p.mo)}-${pad(p.d)}`
    if (!p.hasTime) return date
    const time = `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${p.frac ? '.' + p.frac : ''}`
    return p.offset === null ? `${date} ${time}` : `${date} ${time} ${offsetText(p.offset)}`
  }
  return applyPattern(p, fmt)
}
