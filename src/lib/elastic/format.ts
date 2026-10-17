// Display helpers for the Elasticsearch workspace (Kibana-style).

import { formatBytes } from '$lib/format/bytes'
import type { EuiToken } from './eui-icons'

export { formatBytes }

/** 12,345 · '—' when unknown. */
export function fmtCount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US')
}

/** 1.2K · 3.4M — compact numbers for the sidebar. */
export function fmtCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  if (n < 1000) return String(n)
  const units = ['K', 'M', 'B', 'T']
  let v = n
  let u = -1
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000
    u++
  }
  const r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10
  return `${r}${units[u]}`
}

/** CSS colour (theme-aware token) of a health status. */
export function healthColor(h: string | null | undefined): string {
  switch ((h ?? '').toLowerCase()) {
    case 'green':
      return 'var(--es-green)'
    case 'yellow':
      return 'var(--es-yellow)'
    case 'red':
      return 'var(--es-red)'
    default:
      return 'var(--muted)'
  }
}

export function healthLabel(h: string | null | undefined): string {
  const v = (h ?? '').toLowerCase()
  if (v === 'green') return 'Healthy'
  if (v === 'yellow') return 'Warning'
  if (v === 'red') return 'Critical'
  return 'Unknown'
}

/** Kibana-style field type token: the EUI token glyph to draw, a short text label
 *  (for plain-text places), its colour and a tooltip. Mirrors Kibana's FieldIcon. */
export function fieldTypeToken(type: string): { label: string; token: EuiToken; color: string; title: string } {
  const t = (type || '').toLowerCase()
  const r = (label: string, token: EuiToken, color: string, title = t) => ({ label, token, color, title })
  if (t === 'text' || t === 'match_only_text' || t === 'search_as_you_type') return r('t', 'string', 'var(--es-type-text)')
  if (t === 'semantic_text') return r('t', 'semanticText', 'var(--es-type-text)')
  if (t === 'keyword' || t === 'constant_keyword' || t === 'wildcard') return r('k', 'keyword', 'var(--es-type-keyword)')
  if (t === 'version') return r('k', 'keyword', 'var(--es-type-keyword)')
  if (/(long|integer|short|byte|double|float|half_float|scaled_float|unsigned_long)$/.test(t)) return r('#', 'number', 'var(--es-type-number)')
  if (t === 'token_count') return r('#', 'tokenCount', 'var(--es-type-number)')
  if (t === 'date' || t === 'date_nanos') return r('◷', 'date', 'var(--es-type-date)')
  if (t === 'boolean') return r('b', 'boolean', 'var(--es-type-bool)')
  if (t === 'ip') return r('ip', 'ip', 'var(--es-type-ip)')
  if (t === 'geo_point' || t === 'geo_shape') return r('⊕', 'geo', 'var(--es-type-geo)')
  if (t === 'point' || t === 'shape') return r('⊕', 'shape', 'var(--es-type-geo)')
  if (t === 'nested') return r('{}', 'nested', 'var(--es-type-object)')
  if (t === 'object') return r('{}', 'object', 'var(--es-type-object)')
  if (t === 'flattened') return r('{}', 'flattened', 'var(--es-type-object)')
  if (t === 'dense_vector') return r('v', 'vectorDense', 'var(--es-type-geo)')
  if (t === 'sparse_vector') return r('v', 'vectorSparse', 'var(--es-type-geo)')
  if (t.endsWith('_range')) return r('↔', 'range', 'var(--es-type-number)')
  if (t === 'histogram' || t === 'aggregate_metric_double') return r('h', 'histogram', 'var(--es-type-number)')
  if (t === 'binary') return r('01', 'binary', 'var(--es-type-object)')
  if (t === 'completion') return r('c', 'completion', 'var(--es-type-text)')
  if (t === 'join') return r('j', 'join', 'var(--es-type-object)')
  if (t === 'percolator') return r('p', 'percolator', 'var(--es-type-object)')
  if (t === 'rank_feature') return r('r', 'rankFeature', 'var(--es-type-number)')
  if (t === 'rank_features') return r('r', 'rankFeatures', 'var(--es-type-number)')
  if (t === 'alias') return r('a', 'alias', 'var(--es-type-object)')
  return r('?', 'field', 'var(--muted)', t || 'unknown')
}

export function isDateType(t: string) {
  return t === 'date' || t === 'date_nanos'
}

export function isNumericType(t: string) {
  return /(long|integer|short|byte|double|float|half_float|scaled_float|unsigned_long)$/.test(t)
}

/** Aggregatable fields (for "top values", sort): keyword, numbers, dates, booleans, ip. */
export function isAggregatable(t: string) {
  return t === 'keyword' || t === 'constant_keyword' || isNumericType(t) || isDateType(t) || t === 'boolean' || t === 'ip'
}

// ---- time ranges (Kibana's quick select) ------------------------------------------

export interface TimePreset {
  key: string
  label: string
  /** milliseconds back from now; null = no range */
  ms: number | null
}

export const TIME_PRESETS: TimePreset[] = [
  { key: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { key: '1h', label: 'Last 1 hour', ms: 3_600_000 },
  { key: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { key: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { key: '90d', label: 'Last 90 days', ms: 90 * 86_400_000 },
  { key: '1y', label: 'Last 1 year', ms: 365 * 86_400_000 },
  { key: '5y', label: 'Last 5 years', ms: 5 * 365 * 86_400_000 },
  { key: 'all', label: 'All time', ms: null },
]

export function timeRange(key: string, now = Date.now()): { from: string | null; to: string | null } {
  const p = TIME_PRESETS.find((x) => x.key === key)
  if (!p || p.ms == null) return { from: null, to: null }
  return { from: new Date(now - p.ms).toISOString(), to: new Date(now).toISOString() }
}

/** A histogram interval that gives ~30–60 bars over the span. */
export function pickInterval(spanMs: number): string {
  const steps: [number, string][] = [
    [1000, '1s'],
    [5000, '5s'],
    [30_000, '30s'],
    [60_000, '1m'],
    [5 * 60_000, '5m'],
    [15 * 60_000, '15m'],
    [30 * 60_000, '30m'],
    [3_600_000, '1h'],
    [3 * 3_600_000, '3h'],
    [12 * 3_600_000, '12h'],
    [86_400_000, '1d'],
    [7 * 86_400_000, '7d'],
    [30 * 86_400_000, '30d'],
    [365 * 86_400_000, '365d'],
  ]
  for (const [ms, label] of steps) {
    if (spanMs / ms <= 60) return label
  }
  return '365d'
}

export function fmtTimestamp(v: unknown): string {
  if (v == null || v === '') return '—'
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v))
  if (Number.isNaN(d.getTime())) return String(v)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const mon = d.toLocaleString('en-US', { month: 'short' })
  return `${mon} ${d.getDate()}, ${d.getFullYear()} @ ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

// ---- documents ----------------------------------------------------------------------

/** Flatten a document's _source into dotted keys (arrays of scalars stay arrays). */
export function flattenSource(src: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) flattenSource(v, key, out)
      else out[key] = v
    }
  } else if (prefix) {
    out[prefix] = src
  }
  return out
}

export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** Read a dotted path from a _source object (`user.name`). */
export function getPath(src: unknown, path: string): unknown {
  if (src && typeof src === 'object' && path in (src as object)) return (src as Record<string, unknown>)[path]
  let cur: unknown = src
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Strip the trailing `.keyword` (multi-field) — the value lives on the parent. */
export function sourcePathOf(field: string): string {
  return field.endsWith('.keyword') ? field.slice(0, -'.keyword'.length) : field
}

/** Elasticsearch index name rules (lowercase, no spaces or \ / * ? " < > | , #, not starting with - _ +). */
export function indexNameError(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Enter a name'
  if (n !== n.toLowerCase()) return 'Index names must be lowercase'
  if (/[\\/*?"<>| ,#:]/.test(n)) return 'Index names cannot contain spaces or \\ / * ? " < > | , # :'
  if (/^[-_+]/.test(n)) return 'Index names cannot start with -, _ or +'
  if (n === '.' || n === '..') return 'Not a valid index name'
  if (new TextEncoder().encode(n).length > 255) return 'Index names are limited to 255 bytes'
  return null
}
