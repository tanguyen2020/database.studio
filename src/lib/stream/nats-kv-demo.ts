// stream-workspace:nats — stateful NATS key-value store for the browser demo
// (SPEC-NATS-WORKSPACE.md). Mirrors how the server behaves so the workspace is
// testable without a server: every put is a new version (revision = sequence of
// the bucket's stream), delete / purge leave a marker, a bucket keeps at most
// `history` versions per key, and watchers hear every change. Never used in Tauri.

import type { NatsAccount, NatsKvEntry, NatsKvStatus, NatsStreamLimits } from '$lib/ipc'

interface DemoBucket {
  status: Omit<NatsKvStatus, 'keys' | 'values' | 'bytes' | 'last_time'>
  seq: number
  /** every version still kept, oldest first (markers included) */
  log: NatsKvEntry[]
}

const MIN = 60_000
const NOW = () => Date.now()

let buckets = new Map<string, DemoBucket>()
const watchers = new Map<string, { bucket: string; pattern: string; cb: (e: NatsKvEntry) => void }>()

function iso(t: number): string {
  return new Date(t).toISOString().replace(/\.\d+Z$/, 'Z')
}

function newBucket(name: string, opts: Partial<DemoBucket['status']> = {}): DemoBucket {
  return {
    seq: 0,
    log: [],
    status: {
      bucket: name,
      description: null,
      history: 1,
      max_age_ms: 0,
      max_bytes: null,
      max_value_size: null,
      storage: 'file',
      replicas: 1,
      created: iso(NOW() - 40 * 24 * 60 * MIN),
      ...opts,
    },
  }
}

function write(b: DemoBucket, key: string, value: string, operation: 'put' | 'delete' | 'purge', at = NOW()): NatsKvEntry {
  b.seq += 1
  const e: NatsKvEntry = { key, value, revision: b.seq, created: iso(at), operation, size: new TextEncoder().encode(value).length }
  if (operation === 'purge') {
    // a purge drops every earlier version of the key and keeps only its marker
    b.log = b.log.filter((x) => x.key !== key)
  }
  b.log.push(e)
  // keep at most `history` versions per key (oldest dropped first)
  const mine = b.log.filter((x) => x.key === key)
  const drop = mine.length - Math.max(1, b.status.history)
  if (drop > 0) {
    const gone = new Set(mine.slice(0, drop))
    b.log = b.log.filter((x) => !gone.has(x))
  }
  return e
}

function seed() {
  buckets = new Map()
  const t0 = NOW() - 3 * 24 * 60 * MIN
  const config = newBucket('config', { history: 10, description: 'Feature flags and runtime settings' })
  write(config, 'feature.flags', '{"enabled":false}', 'put', t0)
  write(config, 'rate.limit', '{"per_minute":600}', 'put', t0 + 5 * MIN)
  write(config, 'feature.flags', '{"enabled":true}', 'put', t0 + 2 * 24 * 60 * MIN)
  write(config, 'maintenance', '{"window":"Sun 02:00-03:00 UTC"}', 'put', t0 + 24 * 60 * MIN)
  write(config, 'legacy.mode', 'on', 'put', t0 + 10 * MIN)
  write(config, 'legacy.mode', '', 'delete', t0 + 26 * 60 * MIN)
  write(config, 'feature.flags', '{"enabled":true,"beta":["checkout"]}', 'put', NOW() - 6 * MIN)
  buckets.set('config', config)

  const sessions = newBucket('sessions', { history: 1, max_age_ms: 30 * MIN, storage: 'memory', replicas: 3, max_bytes: 64 * 1024 * 1024 })
  write(sessions, 'user.1842', '{"user":1842,"cart":3}', 'put', NOW() - 12 * MIN)
  write(sessions, 'user.2210', '{"user":2210,"cart":0}', 'put', NOW() - 2 * MIN)
  buckets.set('sessions', sessions)
}
seed()

/** Reset to the seeded state (unit tests). */
export function natsKvDemoReset() {
  seed()
  watchers.clear()
}

function latest(b: DemoBucket): Map<string, NatsKvEntry> {
  const m = new Map<string, NatsKvEntry>()
  for (const e of b.log) m.set(e.key, e)
  return m
}

function statusOf(b: DemoBucket): NatsKvStatus {
  const last = b.log[b.log.length - 1]
  return {
    ...b.status,
    keys: latest(b).size,
    values: b.log.length,
    bytes: b.log.reduce((s, e) => s + e.size + e.key.length + 40, 0),
    last_time: last ? last.created : '',
  }
}

function need(name: unknown): DemoBucket {
  const b = buckets.get(String(name ?? ''))
  if (!b) throw new Error(`Key-value bucket '${String(name)}' could not be opened: stream not found`)
  return b
}

function keyMatches(pattern: string, key: string): boolean {
  if (!pattern || pattern === '>') return true
  const f = pattern.split('.')
  const t = key.split('.')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '>') return t.length > i
    if (i >= t.length) return false
    if (f[i] !== '*' && f[i] !== t[i]) return false
  }
  return f.length === t.length
}

function notify(bucket: string, e: NatsKvEntry) {
  for (const w of watchers.values()) {
    if (w.bucket === bucket && keyMatches(w.pattern, e.key)) {
      // async like a real event
      setTimeout(() => w.cb({ ...e }), 30)
    }
  }
}

/** Change a key from "outside the app" (e2e seam: another client wrote it). */
export function natsKvDemoExternalPut(bucket: string, key: string, value: string): NatsKvEntry {
  const b = need(bucket)
  const e = write(b, key, value, 'put')
  notify(bucket, e)
  return e
}

/** listeners attached before the watch command arrived */
const pending = new Map<string, (e: NatsKvEntry) => void>()

/** Subscribe a watch session to the demo bus (ipc.onNatsKvWatch outside Tauri). */
export function natsKvDemoSubscribe(session: string, onEntry: (e: NatsKvEntry) => void): () => void {
  const w = watchers.get(session)
  if (w) w.cb = onEntry
  else pending.set(session, onEntry)
  return () => {
    pending.delete(session)
    const cur = watchers.get(session)
    if (cur && cur.cb === onEntry) cur.cb = () => {}
  }
}

/** Retention limits the demo streams report (extra fields of nats_js_streams). */
export function natsDemoStreamLimits(name: string, messages: number): NatsStreamLimits {
  const presets: Record<string, NatsStreamLimits> = {
    ORDERS: { max_age_ms: 7 * 24 * 60 * MIN, max_msgs: -1, max_bytes: 10 * 1024 ** 3, max_msgs_per_subject: -1, replicas: 3, discard: 'old' },
    EVENTS: { max_age_ms: 24 * 60 * MIN, max_msgs: 100_000, max_bytes: -1, max_msgs_per_subject: -1, replicas: 1, discard: 'old' },
    INBOX: { max_age_ms: 0, max_msgs: -1, max_bytes: -1, max_msgs_per_subject: 100, replicas: 1, discard: 'new' },
  }
  const p = presets[name] ?? { max_age_ms: 0, max_msgs: -1, max_bytes: -1, max_msgs_per_subject: -1, replicas: 1, discard: 'old' }
  return {
    max_msg_size: -1,
    duplicate_window_ms: 2 * MIN,
    description: null,
    first_seq: messages ? 1 : 0,
    last_seq: messages,
    last_time: messages ? iso(NOW() - 4 * MIN) : '',
    created: iso(NOW() - 90 * 24 * 60 * MIN),
    subjects_count: 0,
    sealed: false,
    deny_delete: false,
    deny_purge: false,
    ...p,
  }
}

/** Account usage for the demo server. */
export function natsDemoAccount(streams: { bytes: number; storage: string }[], consumers: number): NatsAccount {
  const kv = [...buckets.values()].map(statusOf)
  const file = streams.filter((s) => s.storage !== 'Memory').reduce((a, s) => a + s.bytes, 0) + kv.filter((k) => k.storage === 'file').reduce((a, k) => a + k.bytes, 0)
  const mem = streams.filter((s) => s.storage === 'Memory').reduce((a, s) => a + s.bytes, 0) + kv.filter((k) => k.storage === 'memory').reduce((a, k) => a + k.bytes, 0)
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('natsNoJs')) {
    return { enabled: false, reason: 'jetstream not enabled for account (code 503, error code 10039)', memory: 0, storage: 0, streams: 0, consumers: 0, max_memory: null, max_storage: null, max_streams: null, max_consumers: null, domain: null, api_total: 0, api_errors: 0 }
  }
  return {
    enabled: true,
    reason: null,
    memory: mem,
    storage: file,
    streams: streams.length + kv.length,
    consumers,
    max_memory: 1024 ** 3,
    max_storage: 10 * 1024 ** 3,
    max_streams: null,
    max_consumers: null,
    domain: null,
    api_total: 18_421,
    api_errors: 3,
  }
}

/** Serve a nats_kv_* command; throws like the backend would on a bad request. */
export function natsKvDemo(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'nats_kv_buckets':
      return [...buckets.keys()].sort()
    case 'nats_kv_bucket_list':
      return [...buckets.values()].map(statusOf).sort((a, b) => a.bucket.localeCompare(b.bucket))
    case 'nats_kv_status':
      return statusOf(need(args.bucket))
    case 'nats_kv_create':
    case 'nats_kv_create_bucket': {
      const cfg = (args.config ?? { bucket: args.bucket }) as Record<string, unknown>
      const name = String(cfg.bucket ?? '').trim()
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Failed to create key-value bucket '${name}': invalid bucket name`)
      if (buckets.has(name)) {
        if (cmd === 'nats_kv_create') return null
        throw new Error(`Failed to create key-value bucket '${name}': stream name already in use with a different configuration`)
      }
      const b = newBucket(name, {
        description: (cfg.description as string) || null,
        history: Math.min(64, Math.max(1, Number(cfg.history ?? 1))),
        max_age_ms: Number(cfg.max_age_secs ?? 0) * 1000,
        storage: cfg.storage === 'memory' ? 'memory' : 'file',
        max_bytes: Number(cfg.max_bytes ?? 0) > 0 ? Number(cfg.max_bytes) : null,
        replicas: Math.min(5, Math.max(1, Number(cfg.replicas ?? 1))),
        created: iso(NOW()),
      })
      buckets.set(name, b)
      return cmd === 'nats_kv_create' ? null : statusOf(b)
    }
    case 'nats_kv_delete_bucket':
      need(args.bucket)
      buckets.delete(String(args.bucket))
      return null
    case 'nats_kv_keys':
      return [...latest(need(args.bucket)).values()].filter((e) => e.operation === 'put').map((e) => e.key).sort()
    case 'nats_kv_get': {
      const e = latest(need(args.bucket)).get(String(args.key))
      return e && e.operation === 'put' ? e.value : null
    }
    case 'nats_kv_entries': {
      const all = [...latest(need(args.bucket)).values()].sort((a, b) => a.key.localeCompare(b.key))
      const limit = Number(args.limit ?? 2000) || 2000
      return { entries: all.slice(0, limit), truncated: all.length > limit }
    }
    case 'nats_kv_entry':
      return latest(need(args.bucket)).get(String(args.key)) ?? null
    case 'nats_kv_history':
      return need(args.bucket).log.filter((e) => e.key === String(args.key))
    case 'nats_kv_put':
    case 'nats_kv_put_version': {
      const name = String(args.bucket)
      const e = write(need(name), String(args.key), String(args.value ?? ''), 'put')
      notify(name, e)
      return cmd === 'nats_kv_put' ? null : e.revision
    }
    case 'nats_kv_delete':
    case 'nats_kv_purge': {
      const name = String(args.bucket)
      const e = write(need(name), String(args.key), '', cmd === 'nats_kv_delete' ? 'delete' : 'purge')
      notify(name, e)
      return null
    }
    case 'nats_kv_watch': {
      const session = String(args.session)
      need(args.bucket)
      const cb = pending.get(session) ?? watchers.get(session)?.cb ?? (() => {})
      pending.delete(session)
      watchers.set(session, { bucket: String(args.bucket), pattern: String(args.pattern ?? '>'), cb })
      return null
    }
    case 'nats_kv_unwatch':
      watchers.delete(String(args.session))
      return null
  }
  throw new Error(`demo: command "${cmd}" not mocked yet`)
}

if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
  // e2e seam: simulate another client changing a key while the app watches it
  ;(window as unknown as Record<string, unknown>).__natsKvDemoPut = natsKvDemoExternalPut
}
