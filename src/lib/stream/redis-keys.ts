// Redis Browser wording (SPEC-REDIS-BROWSER.md §4b, rules U1/U4): data types in
// words, "Expires in 23 min" instead of a raw TTL, databases named "Database 0".
// Pure so the Browser, its detail panel and the sidebar agree on every label.

import { exactUtc, fullCount } from './humanize'

export type RedisKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream'

const TYPE_LABEL: Record<string, string> = {
  string: 'Text',
  hash: 'Hash',
  list: 'List',
  set: 'Set',
  zset: 'Sorted set',
  stream: 'Stream',
}

const TYPE_HELP: Record<string, string> = {
  string: 'A single value: text, a number or a serialized blob.',
  hash: 'A small record of named fields and their values.',
  list: 'An ordered list of values; new values go to the start or the end.',
  set: 'A collection of unique values with no order.',
  zset: 'Unique values kept ordered by a numeric score (rankings, timelines).',
  stream: 'An append-only log of entries, each with its own id and fields.',
}

/** Theme-aware colour per type (token only — rule U5: the label carries the meaning). */
const TYPE_COLOR: Record<string, string> = {
  string: 'var(--sacc-blue)',
  hash: 'var(--sacc-yellow)',
  list: 'var(--sacc-cyan)',
  set: 'var(--sacc-mauve)',
  zset: 'var(--sacc-red)',
  stream: 'var(--sacc-orange)',
}

/** The types the Browser can filter by, in the order people meet them. */
export const REDIS_TYPES: RedisKeyType[] = ['string', 'hash', 'list', 'set', 'zset', 'stream']

/** "Text" for `string`, "Sorted set" for `zset`; an unknown type keeps its own name. */
export function typeLabel(t: string | null | undefined): string {
  if (!t || t === 'none') return 'Unknown'
  return TYPE_LABEL[t] ?? t.charAt(0).toUpperCase() + t.slice(1)
}

/** One sentence explaining the type (tooltip). */
export function typeHelp(t: string | null | undefined): string {
  return (t && TYPE_HELP[t]) || 'A Redis data type this app does not render in detail.'
}

export function typeColor(t: string | null | undefined): string {
  return (t && TYPE_COLOR[t]) || 'var(--text2)'
}

/**
 * A remaining TTL in seconds as words: 42 → "42 sec", 1380 → "23 min",
 * 7200 → "2 h", 90000 → "1 day". Rounds down so "23 min" never over-promises.
 */
export function durationWords(secs: number): string {
  if (secs < 60) return `${secs} sec`
  if (secs < 3600) return `${Math.floor(secs / 60)} min`
  if (secs < 86400) {
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    return m && h < 10 ? `${h} h ${m} min` : `${h} h`
  }
  const d = Math.floor(secs / 86400)
  return `${d} day${d === 1 ? '' : 's'}`
}

export interface ExpiryText {
  /** "Never", "Expired", "23 min" */
  text: string
  /** exact expiry time in UTC, or a sentence for keys that never expire */
  title: string
  tone: 'quiet' | 'soon' | 'gone' | 'normal'
}

/**
 * The "Expires in" cell. Redis TTL: -1 = no expiry, -2 = key no longer exists.
 * `now` is injectable so the exact time is testable.
 */
export function expiresIn(ttl: number | null | undefined, now: number = Date.now()): ExpiryText {
  if (ttl == null || !Number.isFinite(ttl)) return { text: '—', title: 'Expiry unknown', tone: 'quiet' }
  if (ttl === -1) return { text: 'Never', title: 'This key has no expiry', tone: 'quiet' }
  if (ttl < 0) return { text: 'Expired', title: 'The key no longer exists (it expired or was deleted)', tone: 'gone' }
  return {
    text: durationWords(ttl),
    title: `Expires at ${exactUtc(now + ttl * 1000)}`,
    tone: ttl < 60 ? 'soon' : 'normal',
  }
}

/** Header wording of the detail panel: "Expires in 23 min" · "Never expires". */
export function expirySentence(ttl: number | null | undefined): string {
  if (ttl === -1) return 'Never expires'
  if (ttl === -2) return 'Expired'
  if (ttl == null || ttl < 0) return 'Expiry unknown'
  return `Expires in ${durationWords(ttl)}`
}

/** "Database 0 · 12,480 keys" (the key count only when known). */
export function databaseLabel(db: number, keys?: number | null): string {
  return keys == null ? `Database ${db}` : `Database ${db} · ${fullCount(keys)} ${keys === 1 ? 'key' : 'keys'}`
}

/**
 * Key counts per logical database from the INFO "Keyspace" section
 * (`db0:keys=12,expires=2,avg_ttl=0`). Databases that hold no keys are absent.
 */
export function keyspaceCounts(entries: [string, string][] | undefined): Record<number, number> {
  const out: Record<number, number> = {}
  for (const [name, value] of entries ?? []) {
    const db = /^db(\d+)$/.exec(name)
    const keys = /(?:^|,)keys=(\d+)/.exec(value)
    if (db && keys) out[Number(db[1])] = Number(keys[1])
  }
  return out
}

/**
 * Count, unit and noun of a key's contents for the detail facts: a hash has fields,
 * a sorted set members, a stream entries.
 */
export function itemNoun(t: string | null | undefined, n: number): string {
  const nouns: Record<string, [string, string]> = {
    hash: ['field', 'fields'],
    set: ['member', 'members'],
    zset: ['member', 'members'],
    stream: ['entry', 'entries'],
    list: ['item', 'items'],
  }
  const [one, many] = (t && nouns[t]) || ['item', 'items']
  return `${fullCount(n)} ${n === 1 ? one : many}`
}
