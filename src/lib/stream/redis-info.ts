// Redis server facts in words (SPEC-REDIS-BROWSER.md §2, §4b): header numbers,
// a one-line health sentence (rule U2) and INFO grouped into readable sections
// with short labels (rule U1). The untouched INFO table stays behind "Raw".

import type { RedisInfo, RedisSlowlogEntry } from '$lib/ipc'
import { exactUtc, formatBytes, fullCount, humanDuration, percent, relativeTime } from './humanize'
import { keyspaceCounts } from './redis-keys'

/** Flat lookup `metric → value` over every section. */
export function infoMap(info: RedisInfo | null | undefined): Map<string, string> {
  const m = new Map<string, string>()
  for (const s of info?.sections ?? []) for (const [k, v] of s.entries) m.set(k, v)
  return m
}

function num(m: Map<string, string>, k: string): number | null {
  const v = m.get(k)
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const POLICY: Record<string, string> = {
  noeviction: 'Refuse new writes',
  'allkeys-lru': 'Remove the least recently used keys',
  'allkeys-lfu': 'Remove the least frequently used keys',
  'allkeys-random': 'Remove random keys',
  'volatile-lru': 'Remove least recently used keys that have an expiry',
  'volatile-lfu': 'Remove least frequently used keys that have an expiry',
  'volatile-random': 'Remove random keys that have an expiry',
  'volatile-ttl': 'Remove the keys closest to expiring',
}

/** What Redis does when memory is full, in words. */
export function evictionPolicyText(policy: string | undefined | null): string {
  if (!policy) return '—'
  return POLICY[policy] ?? policy
}

export interface RedisHeaderStats {
  /** keys in every database (sum of the Keyspace section) */
  totalKeys: number | null
  keysByDb: Record<number, number>
  memoryUsed: number | null
  /** 0 = no limit */
  maxMemory: number | null
  clients: number | null
  opsPerSec: number | null
  version: string | null
  role: string | null
}

export function headerStats(info: RedisInfo | null | undefined): RedisHeaderStats {
  const m = infoMap(info)
  const keysByDb = keyspaceCounts(info?.sections.find((s) => s.name.toLowerCase() === 'keyspace')?.entries)
  const dbs = Object.values(keysByDb)
  return {
    totalKeys: info ? dbs.reduce((a, b) => a + b, 0) : null,
    keysByDb,
    memoryUsed: num(m, 'used_memory'),
    maxMemory: num(m, 'maxmemory'),
    clients: num(m, 'connected_clients'),
    opsPerSec: num(m, 'instantaneous_ops_per_sec'),
    version: m.get('redis_version') ?? null,
    role: m.get('role') ?? null,
  }
}

/** "48.2 MB of 2 GB" · "48.2 MB · No limit" */
export function memoryText(used: number | null, max: number | null): { value: string; sub: string } {
  if (used == null) return { value: '?', sub: 'not reported by the server' }
  if (!max) return { value: formatBytes(used), sub: 'No limit set' }
  return { value: formatBytes(used), sub: `of ${formatBytes(max)} (${percent(used, max)})` }
}

export interface RedisHealth {
  tone: 'ok' | 'warn' | 'bad' | 'info'
  headline: string
  detail?: string
}

/** One plain-language sentence about the server (rule U2): ok · needs attention · error. */
export function redisHealth(info: RedisInfo | null | undefined): RedisHealth | null {
  if (!info) return null
  const m = infoMap(info)
  if (m.get('rdb_last_bgsave_status') === 'err')
    return { tone: 'bad', headline: 'The last snapshot to disk failed', detail: 'Changes since the last good snapshot are only in memory. Check disk space and permissions on the server.' }
  if (m.get('aof_last_write_status') === 'err')
    return { tone: 'bad', headline: 'Writing the append-only file failed', detail: 'Redis may refuse writes until the disk problem is fixed.' }
  if (m.get('role') === 'slave' && m.get('master_link_status') === 'down')
    return { tone: 'bad', headline: 'This replica lost its link to the primary', detail: `Data here is no longer updated. Primary: ${m.get('master_host') ?? '?'}:${m.get('master_port') ?? '?'}.` }
  const used = num(m, 'used_memory')
  const max = num(m, 'maxmemory')
  if (used != null && max && used / max >= 0.9)
    return {
      tone: 'warn',
      headline: `Memory is ${percent(used, max)} full`,
      detail: `${formatBytes(used)} of ${formatBytes(max)}. When it is full Redis will: ${evictionPolicyText(m.get('maxmemory_policy')).toLowerCase()}.`,
    }
  const rejected = num(m, 'rejected_connections')
  if (rejected && rejected > 0)
    return { tone: 'warn', headline: `${fullCount(rejected)} connections were refused`, detail: 'The client limit was reached at some point. Raise maxclients or close idle connections.' }
  const clients = num(m, 'connected_clients')
  return {
    tone: 'ok',
    headline: 'Redis is running normally',
    detail: [clients != null ? `${fullCount(clients)} ${clients === 1 ? 'client' : 'clients'} connected` : null, used != null ? `${formatBytes(used)} of memory used` : null]
      .filter(Boolean)
      .join(' · '),
  }
}

export interface InfoFact {
  label: string
  value: string
  help?: string
  tone?: 'ok' | 'warn' | 'bad'
  /** exact value in a tooltip (timestamps) */
  title?: string
}
export interface InfoGroup {
  name: string
  facts: InfoFact[]
}

function yesNo(v: string | undefined): string {
  if (v == null) return '—'
  return v === '1' || v === 'yes' ? 'Yes' : v === '0' || v === 'no' ? 'No' : v
}

/**
 * INFO as five readable groups (Server · Memory · Clients · Persistence · Replication)
 * plus Activity. Facts the server did not report are left out — never shown as 0.
 */
export function serverInfoGroups(info: RedisInfo | null | undefined, now: number = Date.now()): InfoGroup[] {
  const m = infoMap(info)
  const has = (k: string) => m.has(k)
  const groups: InfoGroup[] = []
  const push = (name: string, facts: (InfoFact | null)[]) => {
    const f = facts.filter((x): x is InfoFact => !!x)
    if (f.length) groups.push({ name, facts: f })
  }
  const uptime = num(m, 'uptime_in_seconds')
  push('Server', [
    has('redis_version') ? { label: 'Version', value: `Redis ${m.get('redis_version')}` } : null,
    has('redis_mode') ? { label: 'Mode', value: m.get('redis_mode') === 'standalone' ? 'Single server' : m.get('redis_mode') === 'cluster' ? 'Cluster' : m.get('redis_mode') === 'sentinel' ? 'Sentinel' : m.get('redis_mode')! } : null,
    uptime != null ? { label: 'Running for', value: humanDuration(uptime * 1000), title: `Started ${exactUtc(now - uptime * 1000)}` } : null,
    has('os') ? { label: 'Operating system', value: m.get('os')! } : null,
    has('tcp_port') ? { label: 'Port', value: m.get('tcp_port')! } : null,
  ])
  const used = num(m, 'used_memory')
  const max = num(m, 'maxmemory')
  const frag = num(m, 'mem_fragmentation_ratio')
  push('Memory', [
    used != null ? { label: 'Memory used', value: formatBytes(used), help: 'Memory Redis uses for your data and its own bookkeeping.' } : null,
    max != null ? { label: 'Memory limit', value: max === 0 ? 'No limit' : formatBytes(max), help: 'maxmemory — the most memory Redis may use for data.' } : null,
    used != null && max ? { label: 'Used of limit', value: percent(used, max), tone: used / max >= 0.9 ? 'warn' : 'ok' } : null,
    has('used_memory_peak') ? { label: 'Highest so far', value: formatBytes(num(m, 'used_memory_peak')) } : null,
    has('maxmemory_policy') ? { label: 'When memory is full', value: evictionPolicyText(m.get('maxmemory_policy')), help: `Eviction policy: ${m.get('maxmemory_policy')}` } : null,
    frag != null ? { label: 'Fragmentation', value: `${frag.toFixed(2)}×`, help: 'Memory the operating system holds for Redis divided by what Redis uses. Close to 1 is good; above 1.5 wastes memory.', tone: frag > 1.5 ? 'warn' : undefined } : null,
  ])
  push('Clients', [
    has('connected_clients') ? { label: 'Connected', value: fullCount(num(m, 'connected_clients')) } : null,
    has('maxclients') ? { label: 'Client limit', value: fullCount(num(m, 'maxclients')) } : null,
    has('blocked_clients') ? { label: 'Waiting on a blocking command', value: fullCount(num(m, 'blocked_clients')), help: 'Clients waiting in BLPOP, XREAD BLOCK and similar commands.' } : null,
    has('rejected_connections') ? { label: 'Refused connections', value: fullCount(num(m, 'rejected_connections')), tone: (num(m, 'rejected_connections') ?? 0) > 0 ? 'warn' : undefined } : null,
  ])
  const lastSave = num(m, 'rdb_last_save_time')
  push('Persistence', [
    has('rdb_last_bgsave_status') ? { label: 'Last snapshot', value: m.get('rdb_last_bgsave_status') === 'ok' ? 'Succeeded' : 'Failed', tone: m.get('rdb_last_bgsave_status') === 'ok' ? 'ok' : 'bad' } : null,
    lastSave ? { label: 'Snapshot taken', value: relativeTime(lastSave * 1000, now), title: exactUtc(lastSave * 1000) } : null,
    has('rdb_changes_since_last_save') ? { label: 'Changes since the snapshot', value: fullCount(num(m, 'rdb_changes_since_last_save')), help: 'Writes that are only in memory until the next snapshot.' } : null,
    has('aof_enabled') ? { label: 'Append-only file', value: m.get('aof_enabled') === '1' ? 'On' : 'Off', help: 'When on, every write is also logged to disk.' } : null,
    has('loading') ? { label: 'Loading data from disk', value: yesNo(m.get('loading')) } : null,
  ])
  const role = m.get('role')
  push('Replication', [
    role ? { label: 'Role', value: role === 'master' ? 'Primary' : role === 'slave' ? 'Replica' : role } : null,
    has('connected_slaves') ? { label: 'Replicas connected', value: fullCount(num(m, 'connected_slaves')) } : null,
    has('master_host') ? { label: 'Primary', value: `${m.get('master_host')}:${m.get('master_port') ?? ''}` } : null,
    has('master_link_status') ? { label: 'Link to primary', value: m.get('master_link_status') === 'up' ? 'Connected' : 'Down', tone: m.get('master_link_status') === 'up' ? 'ok' : 'bad' } : null,
  ])
  const hits = num(m, 'keyspace_hits')
  const misses = num(m, 'keyspace_misses')
  push('Activity', [
    has('instantaneous_ops_per_sec') ? { label: 'Commands / second', value: fullCount(num(m, 'instantaneous_ops_per_sec')) } : null,
    has('total_commands_processed') ? { label: 'Commands since start', value: fullCount(num(m, 'total_commands_processed')) } : null,
    hits != null && misses != null && hits + misses > 0 ? { label: 'Lookups that found the key', value: percent(hits, hits + misses), help: 'keyspace_hits ÷ (hits + misses) — the cache hit rate.' } : null,
    has('expired_keys') ? { label: 'Keys expired', value: fullCount(num(m, 'expired_keys')) } : null,
    has('evicted_keys') ? { label: 'Keys removed to free memory', value: fullCount(num(m, 'evicted_keys')), tone: (num(m, 'evicted_keys') ?? 0) > 0 ? 'warn' : undefined } : null,
  ])
  return groups
}

// ---- Slow commands -----------------------------------------------------------

/** 820 → "0.82 ms", 15234 → "15.2 ms", 2_500_000 → "2.5 s". */
export function slowDuration(us: number): string {
  if (us < 1000) return `${(us / 1000).toFixed(2)} ms`
  if (us < 1_000_000) {
    const ms = us / 1000
    return `${ms < 100 ? ms.toFixed(1) : Math.round(ms)} ms`
  }
  return `${(us / 1_000_000).toFixed(1)} s`
}

/** The logged command as one short line: args with spaces are quoted, long args cut. */
export function slowCommand(args: string[], max = 120): string {
  const parts = args.map((a) => {
    const cut = a.length > 40 ? `${a.slice(0, 37)}…` : a
    return /[\s"]/.test(cut) || cut === '' ? `"${cut.replace(/"/g, '\\"')}"` : cut
  })
  const line = parts.join(' ')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** What the server logs, in words (-1 = off, 0 = every command). */
export function slowThresholdText(us: number | null | undefined): string {
  if (us == null) return 'The server does not report its slow-command threshold.'
  if (us < 0) return 'Slow-command logging is turned off on this server.'
  if (us === 0) return 'Every command is logged (threshold 0).'
  return `Commands slower than ${slowDuration(us)} are logged.`
}

export interface SlowRow {
  id: number
  when: string
  whenExact: string
  timestamp: number
  durationUs: number
  duration: string
  command: string
  name: string
  client: string
}

export function slowRows(entries: RedisSlowlogEntry[], now: number = Date.now()): SlowRow[] {
  return entries.map((e) => ({
    id: e.id,
    when: relativeTime(e.timestamp * 1000, now),
    whenExact: exactUtc(e.timestamp * 1000),
    timestamp: e.timestamp,
    durationUs: e.duration_us,
    duration: slowDuration(e.duration_us),
    command: slowCommand(e.args),
    name: (e.args[0] ?? '').toUpperCase(),
    client: [e.client_name, e.client].filter(Boolean).join(' · ') || '—',
  }))
}
