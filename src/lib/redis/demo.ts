// stream-workspace:redis — stateful Redis mock for the browser/demo build and
// Playwright (SPEC-REDIS-BROWSER.md). Edits, TTL changes, deletes and FLUSHDB change
// what the next SCAN / GET returns, so the Browser can be tested end to end without a
// server. Same reply shapes as src-tauri/src/commands/redis.rs. Never used in Tauri.

import { VALKEY_DEMO_VERSION, isValkeyDemo } from '$lib/valkey/demo'

type Val =
  | { kind: 'string'; value: string }
  | { kind: 'hash'; fields: [string, string][] }
  | { kind: 'list'; items: string[] }
  | { kind: 'set'; members: string[] }
  | { kind: 'zset'; members: [string, number][] }
  | { kind: 'stream'; entries: { id: string; fields: [string, string][] }[] }

interface Entry {
  ttl: number
  value: Val
}

function seed(): Map<number, Map<string, Entry>> {
  const db0 = new Map<string, Entry>([
    ['session:abc123', { ttl: 42, value: { kind: 'string', value: 'demo-value' } }],
    ['session:def456', { ttl: 120, value: { kind: 'string', value: '{"user":1002,"cart":[3,7],"theme":"dark"}' } }],
    ['user:1001', { ttl: -1, value: { kind: 'hash', fields: [['name', 'An'], ['email', 'an@acme.io'], ['role', 'admin']] } }],
    ['user:1002', { ttl: -1, value: { kind: 'hash', fields: [['name', 'Binh'], ['email', 'binh@acme.io'], ['role', 'viewer']] } }],
    ['cache:home', { ttl: 8, value: { kind: 'string', value: 'demo-value' } }],
    ['leaderboard', { ttl: -1, value: { kind: 'zset', members: [['an', 980], ['binh', 870], ['chi', 640]] } }],
    ['queue:emails', { ttl: -1, value: { kind: 'list', items: ['{"to":"an@acme.io","tpl":"welcome"}', '{"to":"binh@acme.io","tpl":"reset"}'] } }],
    ['tags:popular', { ttl: 3600, value: { kind: 'set', members: ['redis', 'svelte', 'tauri'] } }],
    [
      'events:orders',
      {
        ttl: -1,
        value: {
          kind: 'stream',
          entries: [
            { id: '1729497600000-0', fields: [['order', '1001'], ['total', '42.50']] },
            { id: '1729497660000-0', fields: [['order', '1002'], ['total', '18.00']] },
          ],
        },
      },
    ],
  ])
  const db1 = new Map<string, Entry>([
    ['jobs:pending', { ttl: -1, value: { kind: 'list', items: ['resize:42', 'resize:43'] } }],
    ['config:flags', { ttl: -1, value: { kind: 'hash', fields: [['beta', 'on']] } }],
  ])
  return new Map([
    [0, db0],
    [1, db1],
  ])
}

let dbs = seed()
let cur = 0

function db(): Map<string, Entry> {
  let d = dbs.get(cur)
  if (!d) {
    d = new Map()
    dbs.set(cur, d)
  }
  return d
}

/** Redis glob → RegExp (`*`, `?`, `[...]`). */
function globRe(pattern: string): RegExp {
  const p = pattern || '*'
  let re = ''
  for (const ch of p) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else if (ch === '[' || ch === ']') re += ch
    else re += ch.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function size(v: Val): number {
  switch (v.kind) {
    case 'string':
      return v.value.length
    case 'hash':
      return v.fields.reduce((s, [f, x]) => s + f.length + x.length, 0)
    case 'list':
      return v.items.reduce((s, x) => s + x.length, 0)
    case 'set':
      return v.members.reduce((s, x) => s + x.length, 0)
    case 'zset':
      return v.members.reduce((s, [m]) => s + m.length + 8, 0)
    case 'stream':
      return v.entries.reduce((s, e) => s + e.id.length + e.fields.reduce((a, [f, x]) => a + f.length + x.length, 0), 0)
  }
}

function encoding(v: Val): string {
  switch (v.kind) {
    case 'string':
      return /^-?\d+$/.test(v.value) ? 'int' : v.value.length <= 44 ? 'embstr' : 'raw'
    case 'set':
      return v.members.every((m) => /^-?\d+$/.test(m)) ? 'intset' : 'listpack'
    case 'stream':
      return 'stream'
    default:
      return 'listpack'
  }
}

function bytes(e: Entry): number {
  return 48 + size(e.value) * 2
}

function keyspaceLines(): string {
  return [...dbs.entries()]
    .filter(([, d]) => d.size > 0)
    .map(([n, d]) => `db${n}:keys=${d.size},expires=${[...d.values()].filter((e) => e.ttl >= 0).length},avg_ttl=0`)
    .join('\n')
}

function infoText(valkey = false): string {
  const now = Math.floor(Date.now() / 1000)
  // Valkey keeps redis_version for old clients and reports server_mode (measured on 8.1)
  const server = valkey
    ? `redis_version:7.2.4
server_name:valkey
valkey_version:${VALKEY_DEMO_VERSION}
server_mode:standalone`
    : `redis_version:7.2.4
redis_mode:standalone`
  return `# Server
${server}
os:Linux 6.1.0 x86_64
tcp_port:6379
uptime_in_seconds:${3 * 86400 + 4 * 3600}

# Clients
connected_clients:7
maxclients:10000
blocked_clients:1

# Memory
used_memory:50541363
used_memory_human:48.20M
used_memory_peak:61203442
maxmemory:2147483648
maxmemory_policy:allkeys-lru
mem_fragmentation_ratio:1.12

# Persistence
loading:0
rdb_changes_since_last_save:14
rdb_last_save_time:${now - 360}
rdb_last_bgsave_status:ok
aof_enabled:0
aof_last_write_status:ok

# Stats
total_commands_processed:1843221
instantaneous_ops_per_sec:412
rejected_connections:0
expired_keys:2210
evicted_keys:0
keyspace_hits:91234
keyspace_misses:4520

# Replication
role:master
connected_slaves:0

# Keyspace
${keyspaceLines()}
`
}

function sections(text: string) {
  const out: { name: string; entries: [string, string][] }[] = []
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (t.startsWith('#')) {
      out.push({ name: t.slice(1).trim(), entries: [] })
      continue
    }
    const i = t.indexOf(':')
    if (!t || i < 0 || !out.length) continue
    out[out.length - 1].entries.push([t.slice(0, i), t.slice(i + 1)])
  }
  return out.filter((s) => s.entries.length > 0)
}

const SLOW = [
  { id: 41, ago: 75, duration_us: 182_400, args: ['KEYS', '*'], client: '10.0.4.21:51022', client_name: 'admin-cli' },
  { id: 40, ago: 610, duration_us: 24_310, args: ['HGETALL', 'user:1001'], client: '10.0.4.12:40211', client_name: 'api-7f9c' },
  { id: 39, ago: 3_900, duration_us: 15_234, args: ['ZRANGE', 'leaderboard', '0', '-1', 'WITHSCORES'], client: '10.0.4.12:40211', client_name: 'api-7f9c' },
  { id: 38, ago: 7_400, duration_us: 11_020, args: ['SET', 'cache:home', '<html><body>A very long cached page body that keeps going and going</body></html>', 'EX', '60'], client: '10.0.4.30:39001', client_name: '' },
]

function edit(key: string, op: Record<string, unknown>) {
  const d = db()
  const e = d.get(key)
  const o = op.op as string
  const str = (k: string) => String(op[k] ?? '')
  const ensure = <K extends Val['kind']>(kind: K, empty: Extract<Val, { kind: K }>): Extract<Val, { kind: K }> => {
    if (e && e.value.kind === kind) return e.value as Extract<Val, { kind: K }>
    if (e) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
    d.set(key, { ttl: -1, value: empty })
    return empty
  }
  switch (o) {
    case 'setString':
      d.set(key, { ttl: e?.ttl ?? -1, value: { kind: 'string', value: str('value') } })
      return
    case 'hSet': {
      const h = ensure('hash', { kind: 'hash', fields: [] })
      const i = h.fields.findIndex(([f]) => f === str('field'))
      if (i >= 0) h.fields[i] = [str('field'), str('value')]
      else h.fields.push([str('field'), str('value')])
      return
    }
    case 'hDel':
      if (e?.value.kind === 'hash') e.value.fields = e.value.fields.filter(([f]) => f !== str('field'))
      break
    case 'rPush':
      ensure('list', { kind: 'list', items: [] }).items.push(str('value'))
      return
    case 'lSet':
      if (e?.value.kind === 'list') e.value.items[Number(op.index)] = str('value')
      return
    case 'lRem':
      if (e?.value.kind === 'list') e.value.items = e.value.items.filter((x) => x !== str('value'))
      break
    case 'sAdd': {
      const s = ensure('set', { kind: 'set', members: [] })
      if (!s.members.includes(str('member'))) s.members.push(str('member'))
      return
    }
    case 'sRem':
      if (e?.value.kind === 'set') e.value.members = e.value.members.filter((x) => x !== str('member'))
      break
    case 'zAdd': {
      const z = ensure('zset', { kind: 'zset', members: [] })
      z.members = [...z.members.filter(([m]) => m !== str('member')), [str('member'), Number(op.score) || 0] as [string, number]].sort((a, b) => a[1] - b[1])
      return
    }
    case 'zRem':
      if (e?.value.kind === 'zset') e.value.members = e.value.members.filter(([m]) => m !== str('member'))
      break
    case 'xAdd':
      ensure('stream', { kind: 'stream', entries: [] }).entries.push({ id: `${Date.now()}-0`, fields: (op.fields as [string, string][]) ?? [] })
      return
    case 'xDel':
      if (e?.value.kind === 'stream') e.value.entries = e.value.entries.filter((x) => x.id !== str('id'))
      break
    // same contract as the Lua scripts in drivers/redis.rs
    case 'lSetAt':
    case 'lDelAt': {
      if (e?.value.kind !== 'list') throw new Error(CHANGED)
      const i = Number(op.index)
      if (e.value.items[i] !== str('expected')) throw new Error(CHANGED)
      if (o === 'lSetAt') e.value.items[i] = str('value')
      else e.value.items.splice(i, 1)
      break
    }
    case 'hReplace': {
      if (e?.value.kind !== 'hash') throw new Error(CHANGED)
      const from = str('from'), to = str('to')
      if (from !== to && e.value.fields.some(([f]) => f === to)) throw new Error(TAKEN)
      const i = e.value.fields.findIndex(([f]) => f === from)
      if (i < 0) throw new Error(CHANGED)
      e.value.fields[i] = [to, str('value')]
      break
    }
    case 'sReplace': {
      if (e?.value.kind !== 'set') throw new Error(CHANGED)
      const from = str('from'), to = str('to')
      if (from === to) break
      if (e.value.members.includes(to)) throw new Error(TAKEN)
      const i = e.value.members.indexOf(from)
      if (i < 0) throw new Error(CHANGED)
      e.value.members[i] = to
      break
    }
    case 'zReplace': {
      if (e?.value.kind !== 'zset') throw new Error(CHANGED)
      const from = str('from'), to = str('to')
      if (from !== to && e.value.members.some(([m]) => m === to)) throw new Error(TAKEN)
      if (!e.value.members.some(([m]) => m === from)) throw new Error(CHANGED)
      e.value.members = [...e.value.members.filter(([m]) => m !== from), [to, Number(op.score) || 0] as [string, number]].sort((a, b) => a[1] - b[1])
      break
    }
  }
  // like Redis: a collection that became empty no longer exists
  const after = d.get(key)?.value
  if (after && size(after) === 0 && after.kind !== 'string') d.delete(key)
}

const TAKEN = 'That name is already used in this key. Pick another one.'
const CHANGED = 'This item changed on the server since it was read. Refresh the key and try again.'

function fmt(v: unknown): string {
  if (v == null) return '(nil)'
  if (typeof v === 'number') return `(integer) ${v}`
  return `"${v}"`
}

function command(args: string[]): string {
  const name = (args[0] ?? '').toUpperCase()
  const d = db()
  const k = args[1] ?? ''
  switch (name) {
    case 'PING':
      return 'PONG'
    case 'DBSIZE':
      return fmt(d.size)
    case 'GET': {
      const e = d.get(k)
      if (e && e.value.kind !== 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
      return fmt(e?.value.kind === 'string' ? e.value.value : null)
    }
    case 'SET':
      d.set(k, { ttl: -1, value: { kind: 'string', value: args[2] ?? '' } })
      return 'OK'
    case 'DEL':
      return fmt(args.slice(1).filter((x) => d.delete(x)).length)
    case 'EXISTS':
      return fmt(args.slice(1).filter((x) => d.has(x)).length)
    case 'TTL':
      return fmt(d.get(k)?.ttl ?? -2)
    case 'TYPE':
      return d.get(k)?.value.kind ?? 'none'
    case 'RENAME':
    case 'RENAMENX': {
      const e = d.get(k)
      if (!e) throw new Error('ERR no such key')
      const to = args[2] ?? ''
      if (name === 'RENAMENX' && d.has(to)) return fmt(0)
      d.delete(k)
      d.set(to, e)
      return name === 'RENAMENX' ? fmt(1) : 'OK'
    }
    case 'KEYS': {
      const re = globRe(k)
      const list = [...d.keys()].filter((x) => re.test(x)).sort()
      return list.length ? list.map((x, i) => `${i + 1}) "${x}"`).join('\n') : '(empty)'
    }
    case 'INFO':
      return `"${infoText()}"`
    case 'HGETALL': {
      const e = d.get(k)
      if (e?.value.kind !== 'hash') return '(empty)'
      return e.value.fields.flat().map((x, i) => `${i + 1}) "${x}"`).join('\n')
    }
    case '':
      throw new Error('Empty command')
    default:
      if (/^[A-Z]+$/.test(name) && name.length <= 16) return 'OK'
      throw new Error(`ERR unknown command '${args[0]}'`)
  }
}

/** Reset to the seed (tests start each page fresh anyway; exposed for unit use). */
export function resetRedisDemo() {
  dbs = seed()
  cur = 0
}

/**
 * Answer one `redis_*` command. Returns `undefined` for commands this mock does not
 * own (the generic demo switch answers those). Throws with a Redis-like message on
 * error, which the caller turns into a rejected promise.
 */
export function redisDemo(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'redis_scan': {
      // A keyspace too large to finish in one capped walk: SCAN keeps handing back a
      // non-zero cursor (MATCH is applied after the buckets are read), so the browser
      // stops at its round cap and must show the partial-scan badge + "Scan more".
      const pat = (args.pattern as string) ?? ''
      if (pat.startsWith('big:')) {
        const c = (args.cursor as number) ?? 0
        return { cursor: c + 500, dbsize: 200_040, keys: [{ name: `big:${String(c).padStart(6, '0')}`, key_type: 'string', ttl: -1 }] }
      }
      const re = globRe(pat)
      const d = db()
      return {
        cursor: 0,
        dbsize: d.size,
        keys: [...d.entries()].filter(([k]) => re.test(k)).map(([name, e]) => ({ name, key_type: e.value.kind, ttl: e.ttl })),
      }
    }
    case 'redis_get': {
      const e = db().get((args.key as string) ?? '')
      if (!e) return { key_type: 'none', ttl: -2, value: { kind: 'none' } }
      return { key_type: e.value.kind, ttl: e.ttl, value: JSON.parse(JSON.stringify(e.value)) }
    }
    case 'redis_del':
      return db().delete((args.key as string) ?? '') ? 1 : 0
    case 'redis_set_ttl': {
      const e = db().get((args.key as string) ?? '')
      if (e) e.ttl = Number(args.secs) > 0 ? Number(args.secs) : -1
      return null
    }
    case 'redis_edit':
      edit((args.key as string) ?? '', (args.op as Record<string, unknown>) ?? {})
      return null
    case 'redis_flushdb':
      db().clear()
      return null
    case 'redis_select_db':
      cur = Number(args.db) || 0
      return null
    case 'redis_database_count':
      return 16
    case 'redis_memory_usage': {
      const e = db().get((args.key as string) ?? '')
      return e ? bytes(e) : null
    }
    case 'redis_command':
      return command(((args.args as string[]) ?? []).map(String))
    case 'redis_info':
      return { sections: sections(infoText(isValkeyDemo(args))) }
    case 'redis_server_info':
      return isValkeyDemo(args)
        ? { flavor: 'valkey', version: VALKEY_DEMO_VERSION, label: `Valkey ${VALKEY_DEMO_VERSION}` }
        : { flavor: 'redis', version: '7.2.4', label: 'Redis 7.2.4' }
    case 'redis_slowlog': {
      const now = Math.floor(Date.now() / 1000)
      const n = Number(args.count) || 50
      return {
        entries: SLOW.slice(0, n).map(({ ago, ...e }) => ({ ...e, timestamp: now - ago })),
        threshold_us: 10_000,
        max_len: 128,
      }
    }
    case 'redis_key_meta': {
      const d = db()
      return ((args.keys as string[]) ?? []).map((key) => {
        const e = d.get(key)
        return { key, bytes: e ? bytes(e) : null, encoding: e ? encoding(e.value) : null }
      })
    }
    case 'redis_subscribe':
    case 'redis_unsubscribe':
      return null
    case 'redis_publish':
      return 1
    default:
      return undefined
  }
}
