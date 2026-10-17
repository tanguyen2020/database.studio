// Stateful in-memory Elasticsearch for the browser demo / Playwright (opt-in with
// `?elasticsearch=1`). It answers the same REST paths the workspace sends, with
// the same response shapes as a real 8.x cluster, so every screen can be
// exercised end to end without a server. NEVER used in the desktop app.
//
// Query DSL evaluation covers what the UI generates (bool / match / match_phrase /
// multi_match / term(s) / range / exists / wildcard / prefix / ids / query_string)
// plus the aggregations it renders (terms, date_histogram, histogram, metrics).

import type { EsIndex, EsOverview, EsResponse } from '$lib/ipc'
import { evalArithmetic, grokMatch } from './devtools'

export const ES_DEMO_ID = 'es1'

export function esDemoEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('elasticsearch') === '1'
  } catch {
    return false
  }
}

type Src = Record<string, unknown>
interface DIndex {
  name: string
  uuid: string
  created: number
  status: 'open' | 'close'
  settings: Record<string, string>
  mappings: { properties: Record<string, MapProp> }
  aliases: Record<string, { is_write_index?: boolean; filter?: unknown }>
  docs: Map<string, Src>
  versions: Map<string, number>
  seq: number
  stats: { index: number; search: number; get: number; refresh: number; flush: number; merges: number }
}
interface MapProp {
  type?: string
  properties?: Record<string, MapProp>
  fields?: Record<string, MapProp>
  [k: string]: unknown
}
interface Snapshot {
  snapshot: string
  uuid: string
  indices: string[]
  state: string
  start_time_in_millis: number
  end_time_in_millis: number
  data: Record<string, { docs: [string, Src][]; mappings: DIndex['mappings']; settings: Record<string, string> }>
}

const S = {
  indices: new Map<string, DIndex>(),
  templates: new Map<string, Src>(),
  components: new Map<string, Src>(),
  pipelines: new Map<string, Src>(),
  ilm: new Map<string, Src>(),
  repos: new Map<string, { type: string; settings: Src; snapshots: Snapshot[] }>(),
  slm: new Map<string, Src>(),
  scripts: new Map<string, Src>(),
  enrich: new Map<string, Src>(),
  transforms: new Map<string, Src & { state?: string }>(),
  watches: new Map<string, Src & { active?: boolean }>(),
  users: new Map<string, Src & { password?: string; enabled: boolean }>(),
  roles: new Map<string, Src>(),
  apiKeys: [] as Src[],
  roleMappings: new Map<string, Src>(),
  clusterSettings: { persistent: {} as Record<string, unknown>, transient: {} as Record<string, unknown> },
  dataStreams: new Map<string, { generation: number; indices: string[]; template: string; hidden: boolean }>(),
  tasks: new Map<string, Src>(),
  seeded: false,
}

/** Test seam: drop all state (each page load starts from the same seed). */
export function resetEsDemo() {
  for (const v of Object.values(S)) if (v instanceof Map) v.clear()
  S.apiKeys = []
  S.clusterSettings = { persistent: {}, transient: {} }
  S.seeded = false
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let uuidN = 0
const uid = (p = '') => `${p}${(++uuidN).toString(36).padStart(4, '0')}Xk9aQ2Lr${uuidN.toString(16)}`

function mkIndex(name: string, props: Record<string, MapProp>, settings: Record<string, string> = {}): DIndex {
  const ix: DIndex = {
    name,
    uuid: uid('u'),
    created: Date.now() - 12 * 86_400_000,
    status: 'open',
    settings: {
      'index.number_of_shards': '1',
      'index.number_of_replicas': '1',
      'index.refresh_interval': '1s',
      'index.provided_name': name,
      'index.creation_date': String(Date.now() - 12 * 86_400_000),
      ...settings,
    },
    mappings: { properties: props },
    aliases: {},
    docs: new Map(),
    versions: new Map(),
    seq: 0,
    stats: { index: 0, search: 0, get: 0, refresh: 0, flush: 0, merges: 0 },
  }
  ix.settings['index.uuid'] = ix.uuid
  S.indices.set(name, ix)
  return ix
}

function putDoc(ix: DIndex, id: string | null, src: Src): string {
  const _id = id ?? uid('d')
  ix.docs.set(_id, src)
  ix.versions.set(_id, (ix.versions.get(_id) ?? 0) + 1)
  ix.seq++
  ix.stats.index++
  return _id
}

function seed() {
  if (S.seeded) return
  S.seeded = true
  const now = Date.now()
  const r = rng(42)
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]

  const orders = mkIndex('orders', {
    '@timestamp': { type: 'date' },
    order_id: { type: 'keyword' },
    customer: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
    email: { type: 'keyword' },
    status: { type: 'keyword' },
    category: { type: 'keyword' },
    amount: { type: 'double' },
    items: { type: 'integer' },
    paid: { type: 'boolean' },
    geo: { properties: { city: { type: 'keyword' }, country: { type: 'keyword' } } },
  })
  const customers = ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Linus Torvalds', 'Margaret Hamilton', 'Ken Thompson', 'Barbara Liskov']
  const cities = [
    ['Hanoi', 'VN'],
    ['Ho Chi Minh City', 'VN'],
    ['Berlin', 'DE'],
    ['London', 'GB'],
    ['New York', 'US'],
    ['Tokyo', 'JP'],
  ]
  for (let i = 0; i < 240; i++) {
    const c = pick(customers)
    const [city, country] = pick(cities)
    const status = pick(['paid', 'paid', 'paid', 'pending', 'shipped', 'refunded'])
    putDoc(orders, `ord-${String(i + 1).padStart(4, '0')}`, {
      '@timestamp': new Date(now - Math.floor(r() * 30 * 86_400_000)).toISOString(),
      order_id: `ORD-${10000 + i}`,
      customer: c,
      email: `${c.split(' ')[0].toLowerCase()}@example.com`,
      status,
      category: pick(['Books', 'Electronics', 'Clothing', 'Home', 'Toys']),
      amount: Math.round((5 + r() * 495) * 100) / 100,
      items: 1 + Math.floor(r() * 6),
      paid: status !== 'pending',
      geo: { city, country },
    })
  }
  orders.aliases['sales'] = { is_write_index: true }

  const logs = mkIndex('logs-web', {
    '@timestamp': { type: 'date' },
    message: { type: 'text' },
    'log.level': { type: 'keyword' },
    host: { properties: { name: { type: 'keyword' } } },
    http: { properties: { response: { properties: { status_code: { type: 'integer' } } }, method: { type: 'keyword' } } },
    url: { properties: { path: { type: 'keyword' } } },
    client: { properties: { ip: { type: 'ip' } } },
    duration_ms: { type: 'long' },
  })
  const paths = ['/', '/login', '/api/orders', '/api/products', '/checkout', '/search']
  for (let i = 0; i < 300; i++) {
    const code = pick([200, 200, 200, 200, 201, 304, 404, 500])
    const level = code >= 500 ? 'error' : code >= 400 ? 'warn' : 'info'
    const p = pick(paths)
    const m = pick(['GET', 'GET', 'POST', 'PUT', 'DELETE'])
    putDoc(logs, null, {
      '@timestamp': new Date(now - Math.floor(r() * 24 * 3_600_000)).toISOString(),
      message: `${m} ${p} ${code}${level === 'error' ? ' upstream timed out' : ''}`,
      log: { level },
      host: { name: pick(['web-01', 'web-02', 'web-03']) },
      http: { response: { status_code: code }, method: m },
      url: { path: p },
      client: { ip: `10.0.${Math.floor(r() * 4)}.${Math.floor(r() * 250)}` },
      duration_ms: Math.floor(5 + r() * 900),
    })
  }

  const products = mkIndex(
    'products',
    {
      sku: { type: 'keyword' },
      name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      description: { type: 'text' },
      price: { type: 'scaled_float', scaling_factor: 100 },
      stock: { type: 'integer' },
      tags: { type: 'keyword' },
      released: { type: 'date' },
    },
    { 'index.number_of_replicas': '0' },
  )
  const names = ['Mechanical Keyboard', 'Noise Cancelling Headphones', '4K Monitor', 'USB-C Hub', 'Standing Desk', 'Ergonomic Chair']
  names.forEach((n, i) =>
    putDoc(products, `p${i + 1}`, {
      sku: `SKU-${100 + i}`,
      name: n,
      description: `${n} — designed for developers who spend all day at the desk.`,
      price: Math.round((49 + r() * 900) * 100) / 100,
      stock: Math.floor(r() * 400),
      tags: ['office', i % 2 ? 'audio' : 'hardware'],
      released: new Date(now - (i + 1) * 40 * 86_400_000).toISOString().slice(0, 10),
    }),
  )

  const closed = mkIndex('archive-2023', { message: { type: 'text' } })
  putDoc(closed, null, { message: 'old' })
  closed.status = 'close'

  // data stream + its backing index (hidden)
  const backing = `.ds-logs-app-default-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '.')}-000001`
  const ds = mkIndex(backing, { '@timestamp': { type: 'date' }, message: { type: 'text' }, 'service.name': { type: 'keyword' } }, { 'index.hidden': 'true' })
  for (let i = 0; i < 40; i++) {
    putDoc(ds, null, { '@timestamp': new Date(now - i * 900_000).toISOString(), message: `job ${i} done`, service: { name: pick(['billing', 'auth']) } })
  }
  S.dataStreams.set('logs-app-default', { generation: 1, indices: [backing], template: 'logs-app', hidden: false })

  // a system index
  mkIndex('.kibana_8.15.3_001', { type: { type: 'keyword' } }, { 'index.hidden': 'true' })

  S.templates.set('logs-app', {
    index_patterns: ['logs-app-*'],
    data_stream: {},
    priority: 200,
    composed_of: ['logs-mappings'],
    template: { settings: { 'index.lifecycle.name': 'logs-30d' } },
  })
  S.templates.set('orders', { index_patterns: ['orders-*'], priority: 100, template: { settings: { number_of_shards: 1 } } })
  S.components.set('logs-mappings', {
    template: { mappings: { properties: { '@timestamp': { type: 'date' }, message: { type: 'text' } } } },
    _meta: { description: 'Common log fields' },
  })
  S.pipelines.set('orders-enrich', {
    description: 'Normalise order status and stamp ingest time',
    processors: [{ lowercase: { field: 'status' } }, { set: { field: 'ingested_at', value: '{{_ingest.timestamp}}' } }],
  })
  S.pipelines.set('logs-parse', {
    description: 'Parse access log lines',
    processors: [{ grok: { field: 'message', patterns: ['%{WORD:http.method} %{URIPATH:url.path} %{NUMBER:http.response.status_code}'] } }],
  })
  S.ilm.set('logs-30d', {
    version: 1,
    modified_date: new Date(now - 5 * 86_400_000).toISOString(),
    policy: {
      phases: {
        hot: { min_age: '0ms', actions: { rollover: { max_age: '7d', max_primary_shard_size: '50gb' } } },
        warm: { min_age: '7d', actions: { forcemerge: { max_num_segments: 1 } } },
        delete: { min_age: '30d', actions: { delete: {} } },
      },
    },
    in_use_by: { indices: [backing], data_streams: ['logs-app-default'], composable_templates: ['logs-app'] },
  })
  S.repos.set('nightly', { type: 'fs', settings: { location: '/mnt/backups/nightly', compress: true }, snapshots: [] })
  takeSnapshot('nightly', 'snap-2026.10.14', ['orders', 'products'])
  S.slm.set('nightly-snapshots', {
    schedule: '0 30 1 * * ?',
    name: '<nightly-snap-{now/d}>',
    repository: 'nightly',
    config: { indices: ['orders', 'products'] },
    retention: { expire_after: '30d', min_count: 5, max_count: 50 },
  })
  S.scripts.set('orders-by-status', { lang: 'mustache', source: '{"query":{"term":{"status":"{{status}}"}}}' })
  S.users.set('elastic', { username: 'elastic', roles: ['superuser'], full_name: '', email: null, metadata: { _reserved: true }, enabled: true })
  S.users.set('kibana_system', { username: 'kibana_system', roles: ['kibana_system'], full_name: '', email: null, metadata: { _reserved: true }, enabled: true })
  S.users.set('analyst', { username: 'analyst', roles: ['orders_reader', 'viewer'], full_name: 'Data Analyst', email: 'analyst@example.com', metadata: {}, enabled: true, password: 'analyst-pw' })
  S.users.set('ingest_bot', { username: 'ingest_bot', roles: ['logs_writer'], full_name: 'Ingest Bot', email: null, metadata: {}, enabled: false, password: 'bot' })
  S.roles.set('superuser', { cluster: ['all'], indices: [{ names: ['*'], privileges: ['all'], allow_restricted_indices: true }], applications: [{ application: '*', privileges: ['*'], resources: ['*'] }], run_as: ['*'], metadata: { _reserved: true }, transient_metadata: { enabled: true } })
  S.roles.set('viewer', { cluster: [], indices: [{ names: ['*'], privileges: ['read', 'view_index_metadata'] }], applications: [], run_as: [], metadata: { _reserved: true }, transient_metadata: { enabled: true } })
  S.roles.set('orders_reader', { cluster: ['monitor'], indices: [{ names: ['orders', 'sales'], privileges: ['read', 'view_index_metadata'] }], applications: [], run_as: [], metadata: {}, transient_metadata: { enabled: true } })
  S.roles.set('logs_writer', { cluster: [], indices: [{ names: ['logs-*'], privileges: ['create_doc', 'auto_configure'] }], applications: [], run_as: [], metadata: {}, transient_metadata: { enabled: true } })
  S.apiKeys.push({ id: 'k1Ab9', name: 'ingest-pipeline-key', creation: now - 3 * 86_400_000, expiration: now + 27 * 86_400_000, invalidated: false, username: 'elastic', realm: 'reserved', metadata: {} })
  S.tasks.set('n1:4821', { node: 'n1', id: 4821, type: 'transport', action: 'indices:data/write/reindex', description: 'reindex from [orders] to [orders-v2]', start_time_in_millis: now - 42_000, running_time_in_nanos: 42_000_000_000, cancellable: true })
}

function takeSnapshot(repo: string, name: string, indices: string[]): Snapshot {
  const rp = S.repos.get(repo)!
  const t = Date.now()
  const snap: Snapshot = {
    snapshot: name,
    uuid: uid('s'),
    indices: indices.filter((i) => S.indices.has(i)),
    state: 'SUCCESS',
    start_time_in_millis: t - 1200,
    end_time_in_millis: t,
    data: {},
  }
  for (const i of snap.indices) {
    const ix = S.indices.get(i)!
    snap.data[i] = { docs: [...ix.docs.entries()].map(([k, v]) => [k, structuredClone(v)]), mappings: structuredClone(ix.mappings), settings: { ...ix.settings } }
  }
  rp.snapshots.push(snap)
  return snap
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class HttpErr extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super('http')
  }
}

const err = (status: number, type: string, reason: string, extra: Src = {}) =>
  new HttpErr(status, { error: { root_cause: [{ type, reason, ...extra }], type, reason, ...extra }, status })

const notFoundIndex = (name: string) => err(404, 'index_not_found_exception', `no such index [${name}]`, { 'resource.type': 'index_or_alias', 'resource.id': name, index: name })

function getPath(src: unknown, path: string): unknown {
  const p = path.endsWith('.keyword') ? path.slice(0, -8) : path
  if (src && typeof src === 'object' && p in (src as object)) return (src as Src)[p]
  let cur: unknown = src
  for (const part of p.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Src)[part]
  }
  return cur
}

function flatProps(props: Record<string, MapProp>, prefix = '', out: [string, string][] = []): [string, string][] {
  for (const [k, v] of Object.entries(props)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (v.properties && (!v.type || v.type === 'object' || v.type === 'nested')) {
      if (v.type === 'nested') out.push([p, 'nested'])
      flatProps(v.properties, p, out)
    } else {
      out.push([p, v.type ?? 'object'])
      for (const [fk, fv] of Object.entries(v.fields ?? {})) out.push([`${p}.${fk}`, fv.type ?? 'keyword'])
    }
  }
  return out
}

function typeOf(ix: DIndex, field: string): string {
  return flatProps(ix.mappings.properties).find(([f]) => f === field)?.[1] ?? ''
}

/** Dynamic mapping for new fields (like ES: strings → text + keyword, numbers → long/float…). */
function mapDynamic(ix: DIndex, src: Src, props = ix.mappings.properties) {
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue
    if (!props[k]) {
      if (typeof v === 'number') props[k] = { type: Number.isInteger(v) ? 'long' : 'float' }
      else if (typeof v === 'boolean') props[k] = { type: 'boolean' }
      else if (typeof v === 'string')
        props[k] = !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v) ? { type: 'date' } : { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } }
      else if (typeof v === 'object' && !Array.isArray(v)) props[k] = { properties: {} }
      else if (Array.isArray(v) && v.length && typeof v[0] === 'string') props[k] = { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } }
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && props[k]?.properties) mapDynamic(ix, v as Src, props[k].properties!)
  }
}

function wildToRe(w: string, ci = false): RegExp {
  const esc = w.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, ci ? 'i' : '')
}

/** index expression → concrete indices (patterns, comma lists, aliases, data streams). */
function resolve(expr: string, opts: { allowNone?: boolean; includeHidden?: boolean; includeClosed?: boolean } = {}): DIndex[] {
  seed()
  const out = new Map<string, DIndex>()
  const parts = (expr || '_all').split(',').map((s) => s.trim()).filter(Boolean)
  for (const p of parts) {
    if (p === '_all' || p === '*' || p.includes('*')) {
      const re = wildToRe(p === '_all' ? '*' : p)
      for (const ix of S.indices.values()) {
        const hidden = ix.settings['index.hidden'] === 'true' || ix.name.startsWith('.')
        if (hidden && !opts.includeHidden && !p.startsWith('.')) continue
        if (re.test(ix.name)) out.set(ix.name, ix)
      }
      for (const [dn, d] of S.dataStreams) if (re.test(dn)) for (const b of d.indices) out.set(b, S.indices.get(b)!)
      for (const ix of S.indices.values()) for (const a of Object.keys(ix.aliases)) if (re.test(a)) out.set(ix.name, ix)
      continue
    }
    const ix = S.indices.get(p)
    if (ix) {
      out.set(ix.name, ix)
      continue
    }
    const ds = S.dataStreams.get(p)
    if (ds) {
      for (const b of ds.indices) out.set(b, S.indices.get(b)!)
      continue
    }
    let viaAlias = false
    for (const x of S.indices.values())
      if (x.aliases[p]) {
        out.set(x.name, x)
        viaAlias = true
      }
    if (!viaAlias && !opts.allowNone) throw notFoundIndex(p)
  }
  const list = [...out.values()].filter(Boolean)
  if (!opts.includeClosed) {
    const closed = list.find((i) => i.status === 'close')
    if (closed && !expr.includes('*')) throw err(400, 'index_closed_exception', `closed`, { index: closed.name })
    return list.filter((i) => i.status === 'open')
  }
  return list
}

// ---------------------------------------------------------------------------
// query evaluation
// ---------------------------------------------------------------------------

const lc = (v: unknown) => String(v ?? '').toLowerCase()
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v])

function textOf(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object') return Object.values(v as Src).map(textOf).join(' ')
  return String(v)
}

function eq(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  if (typeof a === 'boolean') return String(a) === String(b)
  return String(a) === String(b)
}

function cmp(a: unknown, b: unknown): number {
  const na = typeof a === 'number' ? a : Number.isNaN(Number(a)) ? Date.parse(String(a)) : Number(a)
  const nb = typeof b === 'number' ? b : Number.isNaN(Number(b)) ? Date.parse(String(b)) : Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return String(a).localeCompare(String(b))
}

function fieldValue(doc: Src, field: string) {
  return getPath(doc, field)
}

function matchQuery(doc: Src, ix: DIndex, field: string, query: unknown, phrase = false): boolean {
  const t = typeOf(ix, field)
  const v = fieldValue(doc, field)
  if (v == null) return false
  const values = asArr(v)
  const isText = t === 'text' || t === 'match_only_text' || t === ''
  if (!isText && !field.endsWith('*')) return values.some((x) => eq(x, query))
  const hay = values.map(lc)
  const q = lc(query)
  if (phrase) return hay.some((h) => h.includes(q))
  const tokens = q.split(/\s+/).filter(Boolean)
  return hay.some((h) => tokens.some((tk) => h.split(/[^\p{L}\p{N}_.@-]+/u).includes(tk) || h.includes(tk)))
}

function anyField(doc: Src, pred: (v: string) => boolean): boolean {
  const all: string[] = []
  const walk = (o: unknown) => {
    if (o == null) return
    if (Array.isArray(o)) o.forEach(walk)
    else if (typeof o === 'object') Object.values(o as Src).forEach(walk)
    else all.push(lc(o))
  }
  walk(doc)
  return all.some(pred)
}

function queryString(doc: Src, ix: DIndex, q: string, defaultAnd: boolean): boolean {
  const text = q.trim()
  if (!text || text === '*') return true
  // split on top-level OR / AND (no grouping beyond that — enough for the demo)
  const orParts = text.split(/\s+OR\s+/)
  if (orParts.length > 1) return orParts.some((p) => queryString(doc, ix, p, defaultAnd))
  const andParts = text.split(/\s+AND\s+/)
  if (andParts.length > 1) return andParts.every((p) => queryString(doc, ix, p, defaultAnd))
  const terms = text.match(/(?:[^\s"]+:"[^"]*"|"[^"]*"|\S+)/g) ?? []
  const evalTerm = (raw: string): boolean => {
    let neg = false
    let t = raw
    if (t.startsWith('-') || t.startsWith('!')) {
      neg = true
      t = t.slice(1)
    }
    if (/^NOT$/i.test(t)) return true
    let res: boolean
    const m = /^([\w.@*]+):(.*)$/.exec(t)
    if (m) {
      const [, f, rawV] = m
      const v = rawV.replace(/^"|"$/g, '')
      if (v === '*') res = fieldValue(doc, f) != null
      else if (v.includes('*')) res = asArr(fieldValue(doc, f)).some((x) => wildToRe(v, true).test(String(x ?? '')))
      else if (/^[[{]/.test(v)) {
        const r = /^[[{]\s*(\S+)\s+TO\s+(\S+?)\s*[\]}]$/.exec(v)
        res = !!r && asArr(fieldValue(doc, f)).some((x) => (r[1] === '*' || cmp(x, r[1]) >= 0) && (r[2] === '*' || cmp(x, r[2]) <= 0))
      } else res = matchQuery(doc, ix, f, v, rawV.startsWith('"'))
    } else {
      const v = t.replace(/^"|"$/g, '').toLowerCase()
      res = v.includes('*') ? anyField(doc, (x) => wildToRe(v, true).test(x)) : anyField(doc, (x) => x.includes(v))
    }
    return neg ? !res : res
  }
  const filtered = terms.filter((t) => !/^NOT$/i.test(t))
  const negateNext = terms.map((t, i) => (i > 0 && /^NOT$/i.test(terms[i - 1]) ? `-${t}` : t)).filter((t) => !/^NOT$/i.test(t))
  const list = negateNext.length === filtered.length ? negateNext : filtered
  return defaultAnd ? list.every(evalTerm) : list.some(evalTerm)
}

function matches(doc: Src, id: string, ix: DIndex, q: Src | undefined): boolean {
  if (!q || !Object.keys(q).length) return true
  const [type, body] = Object.entries(q)[0] as [string, Src]
  switch (type) {
    case 'match_all':
      return true
    case 'match_none':
      return false
    case 'bool': {
      const list = (k: string) => asArr(body[k] ?? []).filter(Boolean) as Src[]
      const must = [...list('must'), ...list('filter')]
      if (!must.every((c) => matches(doc, id, ix, c))) return false
      if (list('must_not').some((c) => matches(doc, id, ix, c))) return false
      const should = list('should')
      const msm = body.minimum_should_match != null ? Number(body.minimum_should_match) : must.length ? 0 : should.length ? 1 : 0
      return should.filter((c) => matches(doc, id, ix, c)).length >= msm
    }
    case 'term': {
      const [f, v] = Object.entries(body)[0]
      const val = v && typeof v === 'object' ? (v as Src).value : v
      return asArr(fieldValue(doc, f)).some((x) => eq(x, val))
    }
    case 'terms': {
      const [f, vs] = Object.entries(body).filter(([k]) => k !== 'boost')[0]
      return asArr(fieldValue(doc, f)).some((x) => (vs as unknown[]).some((v) => eq(x, v)))
    }
    case 'match':
    case 'match_phrase':
    case 'match_phrase_prefix': {
      const [f, v] = Object.entries(body)[0]
      const val = v && typeof v === 'object' ? (v as Src).query : v
      return matchQuery(doc, ix, f, val, type !== 'match')
    }
    case 'multi_match': {
      const query = lc(body.query)
      const fields = (body.fields as string[] | undefined) ?? []
      if (fields.length) return fields.some((f) => matchQuery(doc, ix, f.replace(/\^.*$/, ''), query, body.type === 'phrase'))
      return body.type === 'phrase' ? anyField(doc, (x) => x.includes(query)) : query.split(/\s+/).some((tk) => anyField(doc, (x) => x.includes(tk)))
    }
    case 'query_string':
    case 'simple_query_string':
      return queryString(doc, ix, String(body.query ?? ''), String(body.default_operator ?? 'OR').toUpperCase() === 'AND')
    case 'range': {
      const [f, r] = Object.entries(body)[0] as [string, Src]
      return asArr(fieldValue(doc, f)).some((x) => {
        if (x == null) return false
        const norm = (b: unknown) => (typeof b === 'string' && b.startsWith('now') ? new Date(nowMath(b)).toISOString() : b)
        if (r.gte != null && cmp(x, norm(r.gte)) < 0) return false
        if (r.gt != null && cmp(x, norm(r.gt)) <= 0) return false
        if (r.lte != null && cmp(x, norm(r.lte)) > 0) return false
        if (r.lt != null && cmp(x, norm(r.lt)) >= 0) return false
        return true
      })
    }
    case 'exists':
      return fieldValue(doc, String(body.field)) != null
    case 'wildcard': {
      const [f, v] = Object.entries(body)[0]
      const val = v && typeof v === 'object' ? String((v as Src).value ?? (v as Src).wildcard) : String(v)
      const ci = !!(v && typeof v === 'object' && (v as Src).case_insensitive)
      return asArr(fieldValue(doc, f)).some((x) => wildToRe(val, ci).test(String(x ?? '')))
    }
    case 'prefix': {
      const [f, v] = Object.entries(body)[0]
      const val = v && typeof v === 'object' ? String((v as Src).value) : String(v)
      return asArr(fieldValue(doc, f)).some((x) => lc(x).startsWith(lc(val)))
    }
    case 'ids':
      return (body.values as string[]).includes(id)
    case 'nested':
      return matches(doc, id, ix, body.query as Src)
    default:
      throw err(400, 'parsing_exception', `unknown query [${type}]`, { line: 1, col: 1 })
  }
}

function nowMath(expr: string): number {
  const m = /^now(?:-(\d+)([smhdwMy]))?/.exec(expr)
  if (!m || !m[1]) return Date.now()
  const n = Number(m[1])
  const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, M: 30 * 86_400_000, y: 365 * 86_400_000 }
  return Date.now() - n * unit[m[2]]
}

interface Hit {
  ix: DIndex
  id: string
  src: Src
}

function intervalMs(v: string): number {
  const m = /^(\d+)?\s*(ms|s|m|h|d|w|M|q|y|second|minute|hour|day|week|month|quarter|year)$/.exec(v)
  if (!m) return 86_400_000
  const n = Number(m[1] ?? 1)
  const unit: Record<string, number> = {
    ms: 1, s: 1000, second: 1000, m: 60_000, minute: 60_000, h: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000,
    w: 7 * 86_400_000, week: 7 * 86_400_000, M: 30 * 86_400_000, month: 30 * 86_400_000, q: 91 * 86_400_000, quarter: 91 * 86_400_000,
    y: 365 * 86_400_000, year: 365 * 86_400_000,
  }
  return n * unit[m[2]]
}

function aggregate(hits: Hit[], aggs: Record<string, Src>): Src {
  const out: Src = {}
  for (const [name, def] of Object.entries(aggs ?? {})) {
    const sub = (def.aggs ?? def.aggregations) as Record<string, Src> | undefined
    const [type, cfg] = Object.entries(def).find(([k]) => k !== 'aggs' && k !== 'aggregations' && k !== 'meta') as [string, Src]
    const field = cfg?.field as string
    const vals = () => hits.flatMap((h) => asArr(getPath(h.src, field))).filter((v) => v != null)
    const nums = () => vals().map(Number).filter((n) => !Number.isNaN(n))
    switch (type) {
      case 'terms': {
        const counts = new Map<string, { key: unknown; hits: Hit[] }>()
        for (const h of hits)
          for (const v of new Set(asArr(getPath(h.src, field)).filter((x) => x != null).map((x) => JSON.stringify(x)))) {
            const e = counts.get(v) ?? { key: JSON.parse(v), hits: [] as Hit[] }
            e.hits.push(h)
            counts.set(v, e)
          }
        const size = Number(cfg.size ?? 10)
        const sorted = [...counts.values()].sort((a, b) => b.hits.length - a.hits.length || String(a.key).localeCompare(String(b.key)))
        out[name] = {
          doc_count_error_upper_bound: 0,
          sum_other_doc_count: sorted.slice(size).reduce((s, e) => s + e.hits.length, 0),
          buckets: sorted.slice(0, size).map((e) => ({ key: e.key, doc_count: e.hits.length, ...(sub ? aggregate(e.hits, sub) : {}) })),
        }
        break
      }
      case 'date_histogram':
      case 'histogram': {
        const step = type === 'histogram' ? Number(cfg.interval) : intervalMs(String(cfg.fixed_interval ?? cfg.calendar_interval ?? cfg.interval ?? '1d'))
        const buckets = new Map<number, Hit[]>()
        for (const h of hits) {
          const raw = getPath(h.src, field)
          if (raw == null) continue
          const n = type === 'histogram' ? Number(raw) : Date.parse(String(raw))
          if (Number.isNaN(n)) continue
          const k = Math.floor(n / step) * step
          buckets.set(k, [...(buckets.get(k) ?? []), h])
        }
        const keys = [...buckets.keys()].sort((a, b) => a - b)
        const filled: number[] = []
        if (keys.length) for (let k = keys[0]; k <= keys[keys.length - 1]; k += step) filled.push(k)
        out[name] = {
          buckets: filled.map((k) => ({
            key: k,
            ...(type === 'date_histogram' ? { key_as_string: new Date(k).toISOString() } : {}),
            doc_count: (buckets.get(k) ?? []).length,
            ...(sub ? aggregate(buckets.get(k) ?? [], sub) : {}),
          })),
        }
        break
      }
      case 'auto_date_histogram': {
        const ts = hits.map((h) => Date.parse(String(getPath(h.src, field) ?? ''))).filter((n) => !Number.isNaN(n))
        if (!ts.length) {
          out[name] = { buckets: [], interval: '1d' }
          break
        }
        const min = Math.min(...ts)
        const max = Math.max(...ts)
        const want = Number(cfg.buckets ?? 10)
        const steps: [number, string][] = [[1000, '1s'], [60_000, '1m'], [300_000, '5m'], [1_800_000, '30m'], [3_600_000, '1h'], [10_800_000, '3h'], [43_200_000, '12h'], [86_400_000, '1d'], [604_800_000, '7d'], [2_592_000_000, '30d'], [31_536_000_000, '1y']]
        const [step, label] = steps.find(([ms]) => (max - min) / ms <= want) ?? steps[steps.length - 1]
        const counts = new Map<number, number>()
        for (const t of ts) {
          const k = Math.floor(t / step) * step
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
        const buckets: Src[] = []
        for (let k = Math.floor(min / step) * step; k <= max; k += step) buckets.push({ key: k, key_as_string: new Date(k).toISOString(), doc_count: counts.get(k) ?? 0 })
        out[name] = { buckets, interval: label }
        break
      }
      case 'avg': {
        const n = nums()
        out[name] = { value: n.length ? n.reduce((a, b) => a + b, 0) / n.length : null }
        break
      }
      case 'sum':
        out[name] = { value: nums().reduce((a, b) => a + b, 0) }
        break
      case 'min': {
        const n = nums()
        out[name] = { value: n.length ? Math.min(...n) : null }
        break
      }
      case 'max': {
        const n = nums()
        out[name] = { value: n.length ? Math.max(...n) : null }
        break
      }
      case 'value_count':
        out[name] = { value: vals().length }
        break
      case 'cardinality':
        out[name] = { value: new Set(vals().map((v) => JSON.stringify(v))).size }
        break
      case 'stats':
      case 'extended_stats': {
        const n = nums()
        const sum = n.reduce((a, b) => a + b, 0)
        out[name] = { count: n.length, min: n.length ? Math.min(...n) : null, max: n.length ? Math.max(...n) : null, avg: n.length ? sum / n.length : null, sum }
        break
      }
      case 'filter':
        out[name] = (() => {
          const f = hits.filter((h) => matches(h.src, h.id, h.ix, cfg))
          return { doc_count: f.length, ...(sub ? aggregate(f, sub) : {}) }
        })()
        break
      default:
        throw err(400, 'parsing_exception', `Unknown aggregation type [${type}]`)
    }
  }
  return out
}

function sortHits(hits: Hit[], sort: unknown) {
  const specs = asArr(sort ?? []).filter(Boolean) as (string | Src)[]
  if (!specs.length) return
  const keys = specs.map((s) => {
    if (typeof s === 'string') return { f: s, desc: s === '_score' }
    const [f, o] = Object.entries(s)[0]
    const order = typeof o === 'string' ? o : String((o as Src).order ?? 'asc')
    return { f, desc: order === 'desc' }
  })
  hits.sort((a, b) => {
    for (const k of keys) {
      if (k.f === '_score' || k.f === '_doc') continue
      const va = k.f === '_id' ? a.id : getPath(a.src, k.f)
      const vb = k.f === '_id' ? b.id : getPath(b.src, k.f)
      if (va == null && vb == null) continue
      if (va == null) return 1
      if (vb == null) return -1
      const c = cmp(va, vb)
      if (c) return k.desc ? -c : c
    }
    return 0
  })
}

function pickSource(src: Src, spec: unknown): Src | undefined {
  if (spec === false) return undefined
  if (Array.isArray(spec)) {
    const out: Src = {}
    for (const f of spec as string[]) {
      const v = getPath(src, f)
      if (v !== undefined) out[f] = v
    }
    return out
  }
  return src
}

function runSearch(expr: string, body: Src) {
  seed()
  const idxs = resolve(expr, { allowNone: expr.includes('*') || expr === '_all' })
  const all: Hit[] = []
  for (const ix of idxs) {
    ix.stats.search++
    for (const [id, src] of ix.docs) if (matches(src, id, ix, body.query as Src)) all.push({ ix, id, src })
  }
  sortHits(all, body.sort)
  const from = Number(body.from ?? 0)
  const size = Number(body.size ?? 10)
  const page = all.slice(from, from + size)
  const res: Src = {
    took: 1 + (all.length % 7),
    timed_out: false,
    _shards: { total: idxs.length, successful: idxs.length, skipped: 0, failed: 0 },
    hits: {
      total: { value: all.length, relation: 'eq' },
      max_score: page.length ? 1 : null,
      hits: page.map((h) => ({
        _index: h.ix.name,
        _id: h.id,
        _score: body.sort ? null : 1,
        ...(body.version || body.seq_no_primary_term ? { _version: h.ix.versions.get(h.id) ?? 1 } : {}),
        _source: pickSource(h.src, body._source),
        ...(body.sort ? { sort: asArr(body.sort).map((s) => getPath(h.src, typeof s === 'string' ? s : Object.keys(s as Src)[0])) } : {}),
      })),
    },
  }
  const aggs = (body.aggs ?? body.aggregations) as Record<string, Src> | undefined
  if (aggs) res.aggregations = aggregate(all, aggs)
  if (body.profile) {
    const q = (body.query as Src | undefined) ?? { match_all: {} }
    const qType = Object.keys(q)[0] ?? 'match_all'
    const luceneName: Record<string, string> = { match_all: 'MatchAllDocsQuery', bool: 'BooleanQuery', term: 'TermQuery', match: 'TermQuery', range: 'IndexOrDocValuesQuery', wildcard: 'AutomatonQuery', query_string: 'BooleanQuery', multi_match: 'DisjunctionMaxQuery', exists: 'FieldExistsQuery' }
    res.profile = {
      shards: idxs.map((ix, n) => ({
        id: `[Zr3qP0x8][${ix.name}][0]`,
        searches: [
          {
            query: [
              {
                type: luceneName[qType] ?? 'BooleanQuery',
                description: JSON.stringify(q).slice(0, 120),
                time_in_nanos: 120_000 + ix.docs.size * 950 + n * 3000,
                children: qType === 'bool' ? (((q.bool as Src).filter ?? (q.bool as Src).must ?? []) as Src[]).map((c, k) => ({ type: luceneName[Object.keys(c)[0]] ?? 'TermQuery', description: JSON.stringify(c).slice(0, 120), time_in_nanos: 40_000 + k * 9000 + ix.docs.size * 300, children: [] })) : [],
              },
            ],
            collector: [{ name: 'QueryPhaseCollector', reason: 'search_query_phase', time_in_nanos: 30_000 + ix.docs.size * 120 }],
          },
        ],
        aggregations: [],
      })),
    }
  }
  return { res, count: all.length, hits: all }
}

// ---------------------------------------------------------------------------
// _cat
// ---------------------------------------------------------------------------

function storeBytes(ix: DIndex) {
  let n = 0
  for (const d of ix.docs.values()) n += JSON.stringify(d).length
  return n * 3 + 4096
}

function health(ix: DIndex) {
  if (ix.status === 'close') return ''
  return Number(ix.settings['index.number_of_replicas'] ?? '1') > 0 ? 'yellow' : 'green'
}

function catIndexRow(ix: DIndex) {
  const closed = ix.status === 'close'
  return {
    health: closed ? null : health(ix),
    status: ix.status,
    index: ix.name,
    uuid: ix.uuid,
    pri: ix.settings['index.number_of_shards'] ?? '1',
    rep: ix.settings['index.number_of_replicas'] ?? '1',
    'docs.count': closed ? null : String(ix.docs.size),
    'docs.deleted': closed ? null : '0',
    'store.size': closed ? null : String(storeBytes(ix)),
    'pri.store.size': closed ? null : String(storeBytes(ix)),
    'creation.date.string': new Date(ix.created).toISOString(),
  }
}

function cat(what: string, q: URLSearchParams): unknown {
  const all = [...S.indices.values()]
  switch (what) {
    case 'indices':
      return all.map(catIndexRow)
    case 'shards':
      return all.flatMap((ix) => {
        const rows = [{ index: ix.name, shard: '0', prirep: 'p', state: ix.status === 'close' ? 'CLOSED' : 'STARTED', docs: String(ix.docs.size), store: String(storeBytes(ix)), ip: '10.0.12.7', node: 'es-node-1' }]
        if (Number(ix.settings['index.number_of_replicas'] ?? '1') > 0 && ix.status === 'open')
          rows.push({ index: ix.name, shard: '0', prirep: 'r', state: 'UNASSIGNED', docs: '', store: '', ip: '', node: '' })
        return rows
      })
    case 'nodes':
      return [{ ip: '10.0.12.7', 'heap.percent': '41', 'ram.percent': '72', cpu: '6', load_1m: '0.42', 'node.role': 'cdfhilmrstw', master: '*', name: 'es-node-1' }]
    case 'aliases':
      return all.flatMap((ix) => Object.keys(ix.aliases).map((a) => ({ alias: a, index: ix.name, filter: '-', 'routing.index': '-', 'routing.search': '-', is_write_index: String(!!ix.aliases[a].is_write_index) })))
    case 'health':
      return [{ epoch: String(Math.floor(Date.now() / 1000)), cluster: 'studio-cluster', status: 'yellow', 'node.total': '1', 'node.data': '1', shards: String(all.length), pri: String(all.length), unassign: String(all.filter((i) => i.status === 'open').length) }]
    case 'allocation':
      return [{ shards: String(all.length), 'disk.indices': String(all.reduce((s, i) => s + storeBytes(i), 0)), 'disk.used': '48318382080', 'disk.avail': '158913789952', 'disk.total': '207232172032', 'disk.percent': '23', host: '10.0.12.7', ip: '10.0.12.7', node: 'es-node-1' }]
    case 'count':
      return [{ epoch: '0', timestamp: '00:00:00', count: String(all.reduce((s, i) => s + i.docs.size, 0)) }]
    case 'templates':
      return [...S.templates.entries()].map(([n, t]) => ({ name: n, index_patterns: JSON.stringify(t.index_patterns), order: String(t.priority ?? 0), version: '', composed_of: JSON.stringify(t.composed_of ?? []) }))
    case 'thread_pool':
      return ['search', 'write', 'get', 'management'].map((n) => ({ node_name: 'es-node-1', name: n, active: '0', queue: '0', rejected: '0' }))
    default:
      void q
      throw err(400, 'illegal_argument_exception', `no handler for _cat/${what}`)
  }
}

function catText(rows: Record<string, unknown>[], verbose: boolean): string {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0])
  const w = cols.map((c) => Math.max(verbose ? c.length : 0, ...rows.map((r) => String(r[c] ?? '').length)))
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(w[i])).join(' ').trimEnd()
  const out = rows.map((r) => line(cols.map((c) => String(r[c] ?? ''))))
  return (verbose ? [line(cols), ...out] : out).join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// SQL / ES|QL (subset)
// ---------------------------------------------------------------------------

function sqlRun(query: string): { columns: { name: string; type: string }[]; rows: unknown[][] } {
  const q = query.trim().replace(/;$/, '')
  if (/^show\s+tables/i.test(q)) {
    const list = [...S.indices.values()].filter((i) => !i.name.startsWith('.'))
    return {
      columns: [{ name: 'catalog', type: 'keyword' }, { name: 'name', type: 'keyword' }, { name: 'type', type: 'keyword' }, { name: 'kind', type: 'keyword' }],
      rows: [...list.map((i) => ['studio-cluster', i.name, 'TABLE', 'INDEX']), ...[...S.indices.values()].flatMap((i) => Object.keys(i.aliases).map((a) => ['studio-cluster', a, 'VIEW', 'ALIAS']))],
    }
  }
  const d = /^(?:describe|desc|show\s+columns\s+from)\s+"?([\w.*-]+)"?$/i.exec(q)
  if (d) {
    const ix = resolve(d[1])[0]
    return {
      columns: [{ name: 'column', type: 'keyword' }, { name: 'type', type: 'keyword' }, { name: 'mapping', type: 'keyword' }],
      rows: flatProps(ix.mappings.properties).map(([f, t]) => [f, sqlType(t), t]),
    }
  }
  const m = /^select\s+(.+?)\s+from\s+"?([\w.*,-]+)"?(?:\s+where\s+(.+?))?(?:\s+group\s+by\s+([\w.]+))?(?:\s+order\s+by\s+([\w.()*"]+)(\s+desc|\s+asc)?)?(?:\s+limit\s+(\d+))?$/i.exec(q)
  if (!m) throw err(400, 'parsing_exception', `line 1:1: mismatched input '${q.split(/\s+/)[0]}' expecting {'SELECT', 'SHOW', 'DESCRIBE'}`)
  const [, sel, from, where, group, order, dir, limit] = m
  const idxs = resolve(from)
  let hits: Hit[] = idxs.flatMap((ix) => [...ix.docs].map(([id, src]) => ({ ix, id, src })))
  if (where) {
    const conds = where.split(/\s+and\s+/i).map((c) => /^"?([\w.]+)"?\s*(=|!=|<>|>=|<=|>|<|like)\s*(.+)$/i.exec(c.trim()))
    if (conds.some((c) => !c)) throw err(400, 'parsing_exception', `line 1:${q.toLowerCase().indexOf('where') + 7}: unsupported condition`)
    hits = hits.filter((h) =>
      conds.every((c) => {
        const [, f, op, rawV] = c!
        const v = rawV.trim().replace(/^'|'$/g, '')
        const x = getPath(h.src, f)
        switch (op.toLowerCase()) {
          case '=':
            return eq(x, v)
          case '!=':
          case '<>':
            return !eq(x, v)
          case '>':
            return cmp(x, v) > 0
          case '<':
            return cmp(x, v) < 0
          case '>=':
            return cmp(x, v) >= 0
          case '<=':
            return cmp(x, v) <= 0
          case 'like':
            return new RegExp(`^${v.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i').test(String(x ?? ''))
        }
        return false
      }),
    )
  }
  const items = sel.split(',').map((s) => s.trim())
  const mapping = flatProps(idxs[0]?.mappings.properties ?? {}).filter(([f]) => !f.endsWith('.keyword'))
  if (group) {
    const groups = new Map<string, Hit[]>()
    for (const h of hits) {
      const k = JSON.stringify(getPath(h.src, group) ?? null)
      groups.set(k, [...(groups.get(k) ?? []), h])
    }
    const cols = items.map((it) => {
      const a = /\s+as\s+"?(\w+)"?$/i.exec(it)
      return { expr: it.replace(/\s+as\s+"?\w+"?$/i, ''), name: a ? a[1] : it }
    })
    let rows = [...groups.entries()].map(([k, hs]) =>
      cols.map((c) => {
        const cm = /^(count|sum|avg|min|max)\((\*|[\w.]+)\)$/i.exec(c.expr)
        if (!cm) return JSON.parse(k)
        const ns = hs.map((h) => Number(getPath(h.src, cm[2]))).filter((n) => !Number.isNaN(n))
        switch (cm[1].toLowerCase()) {
          case 'count':
            return hs.length
          case 'sum':
            return ns.reduce((a, b) => a + b, 0)
          case 'avg':
            return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null
          case 'min':
            return Math.min(...ns)
          default:
            return Math.max(...ns)
        }
      }),
    )
    if (order) {
      const oi = cols.findIndex((c) => c.name === order || c.expr === order)
      rows.sort((a, b) => cmp(a[oi], b[oi]) * (dir?.trim().toLowerCase() === 'desc' ? -1 : 1))
    }
    if (limit) rows = rows.slice(0, Number(limit))
    return { columns: cols.map((c) => ({ name: c.name, type: /^count/i.test(c.expr) ? 'long' : 'keyword' })), rows }
  }
  const cm = /^count\(\*\)(?:\s+as\s+"?(\w+)"?)?$/i.exec(sel.trim())
  if (cm) return { columns: [{ name: cm[1] ?? 'COUNT(*)', type: 'long' }], rows: [[hits.length]] }
  const fields = items.length === 1 && items[0] === '*' ? mapping.map(([f]) => f) : items.map((s) => s.replace(/"/g, ''))
  if (order) sortHits(hits, [{ [order.replace(/"/g, '')]: dir?.trim().toLowerCase() === 'desc' ? 'desc' : 'asc' }])
  const lim = limit ? Number(limit) : 1000
  return {
    columns: fields.map((f) => ({ name: f, type: sqlType(mapping.find(([x]) => x === f)?.[1] ?? 'keyword') })),
    rows: hits.slice(0, lim).map((h) => fields.map((f) => getPath(h.src, f) ?? null)),
  }
}

function sqlType(t: string) {
  if (t === 'date') return 'datetime'
  if (t === 'scaled_float') return 'scaled_float'
  return t || 'keyword'
}

function esqlRun(query: string): { columns: { name: string; type: string }[]; values: unknown[][] } {
  const stages = query.split('|').map((s) => s.trim()).filter(Boolean)
  const head = /^from\s+([\w.*,-]+)/i.exec(stages[0] ?? '')
  if (!head) throw err(400, 'parsing_exception', `line 1:1: mismatched input '${(stages[0] ?? '').split(/\s+/)[0]}' expecting {'explain', 'from', 'row', 'show'}`)
  const idxs = resolve(head[1])
  let mapping = flatProps(idxs[0]?.mappings.properties ?? {}).filter(([f]) => !f.endsWith('.keyword'))
  let rows: Src[] = idxs.flatMap((ix) => [...ix.docs.values()].map((src) => Object.fromEntries(mapping.map(([f]) => [f, getPath(src, f) ?? null]))))
  let cols = mapping.map(([f, t]) => ({ name: f, type: t === 'text' ? 'text' : t }))
  let limit = 1000
  for (const st of stages.slice(1)) {
    const [kw] = st.split(/\s+/)
    const rest = st.slice(kw.length).trim()
    switch (kw.toLowerCase()) {
      case 'where': {
        const c = /^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(rest)
        if (!c) throw err(400, 'verification_exception', `Found 1 problem\nline 1: unsupported WHERE [${rest}]`)
        const v = c[3].trim().replace(/^"|"$/g, '')
        rows = rows.filter((r) => {
          const x = r[c[1]]
          const k = cmp(x, v)
          switch (c[2]) {
            case '==':
              return eq(x, v)
            case '!=':
              return !eq(x, v)
            case '>':
              return k > 0
            case '<':
              return k < 0
            case '>=':
              return k >= 0
            default:
              return k <= 0
          }
        })
        break
      }
      case 'keep': {
        const keep = rest.split(',').map((s) => s.trim())
        cols = keep.map((k) => cols.find((c) => c.name === k) ?? { name: k, type: 'keyword' })
        break
      }
      case 'sort': {
        const [f, d] = rest.split(/\s+/)
        rows.sort((a, b) => cmp(a[f], b[f]) * (d?.toLowerCase() === 'desc' ? -1 : 1))
        break
      }
      case 'limit':
        limit = Number(rest)
        break
      case 'stats': {
        const sm = /^(\w+)\s*=\s*(count|sum|avg|min|max)\((\*|[\w.]+)\)(?:\s+by\s+([\w.]+))?$/i.exec(rest)
        if (!sm) throw err(400, 'verification_exception', `Found 1 problem\nline 1: unsupported STATS [${rest}]`)
        const [, alias, fn, field, by] = sm
        const groups = new Map<string, Src[]>()
        for (const r of rows) {
          const k = by ? JSON.stringify(r[by] ?? null) : '_'
          groups.set(k, [...(groups.get(k) ?? []), r])
        }
        rows = [...groups.entries()].map(([k, rs]) => {
          const ns = rs.map((r) => Number(r[field])).filter((n) => !Number.isNaN(n))
          const val =
            fn.toLowerCase() === 'count' ? rs.length : fn.toLowerCase() === 'sum' ? ns.reduce((a, b) => a + b, 0) : fn.toLowerCase() === 'avg' ? ns.reduce((a, b) => a + b, 0) / (ns.length || 1) : fn.toLowerCase() === 'min' ? Math.min(...ns) : Math.max(...ns)
          return by ? { [alias]: val, [by]: JSON.parse(k) } : { [alias]: val }
        })
        cols = [{ name: alias, type: fn.toLowerCase() === 'count' ? 'long' : 'double' }, ...(by ? [{ name: by, type: 'keyword' }] : [])]
        mapping = []
        break
      }
      default:
        throw err(400, 'parsing_exception', `line 1: unknown command [${kw}]`)
    }
  }
  return { columns: cols, values: rows.slice(0, limit).map((r) => cols.map((c) => r[c.name] ?? null)) }
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

function parseBody(body: string | null | undefined): Src {
  if (!body || !body.trim()) return {}
  try {
    return JSON.parse(body)
  } catch (e) {
    throw err(400, 'x_content_parse_exception', `[1:1] ${(e as Error).message}`)
  }
}

function info() {
  return {
    name: 'es-node-1',
    cluster_name: 'studio-cluster',
    cluster_uuid: 'Zr3qP0x8TT2s0dyrzXk1ZQ',
    version: { number: '8.15.3', build_flavor: 'default', build_type: 'docker', lucene_version: '9.11.1', minimum_wire_compatibility_version: '7.17.0', minimum_index_compatibility_version: '7.0.0' },
    tagline: 'You Know, for Search',
  }
}

function clusterHealth() {
  const open = [...S.indices.values()].filter((i) => i.status === 'open')
  const unassigned = open.filter((i) => Number(i.settings['index.number_of_replicas'] ?? '1') > 0).length
  return {
    cluster_name: 'studio-cluster',
    status: unassigned ? 'yellow' : 'green',
    timed_out: false,
    number_of_nodes: 1,
    number_of_data_nodes: 1,
    active_primary_shards: open.length,
    active_shards: open.length,
    relocating_shards: 0,
    initializing_shards: 0,
    unassigned_shards: unassigned,
    delayed_unassigned_shards: 0,
    number_of_pending_tasks: 0,
    number_of_in_flight_fetch: 0,
    task_max_waiting_in_queue_millis: 0,
    active_shards_percent_as_number: Math.round((open.length / Math.max(1, open.length + unassigned)) * 1000) / 10,
  }
}

function nodeStats() {
  return {
    _nodes: { total: 1, successful: 1, failed: 0 },
    cluster_name: 'studio-cluster',
    nodes: {
      n1: {
        name: 'es-node-1',
        host: '10.0.12.7',
        ip: '10.0.12.7:9300',
        roles: ['data', 'data_content', 'data_hot', 'ingest', 'master', 'ml', 'remote_cluster_client', 'transform'],
        version: '8.15.3',
        attributes: { 'ml.machine_memory': '8589934592' },
        jvm: { uptime_in_millis: 3 * 86_400_000 + 4_200_000, mem: { heap_used_in_bytes: 431_000_000, heap_max_in_bytes: 1_073_741_824, heap_used_percent: 40 }, gc: { collectors: { young: { collection_count: 312 } } } },
        os: { cpu: { percent: 6, load_average: { '1m': 0.42, '5m': 0.38, '15m': 0.31 } }, mem: { total_in_bytes: 8_589_934_592, used_percent: 72 } },
        fs: { total: { total_in_bytes: 207_232_172_032, available_in_bytes: 158_913_789_952, free_in_bytes: 158_913_789_952 } },
        indices: { docs: { count: [...S.indices.values()].reduce((s, i) => s + i.docs.size, 0) }, store: { size_in_bytes: [...S.indices.values()].reduce((s, i) => s + storeBytes(i), 0) } },
        thread_pool: { search: { active: 0, queue: 0, rejected: 0 }, write: { active: 0, queue: 0, rejected: 0 } },
      },
    },
  }
}

function route(method: string, rawPath: string, bodyText: string | null): { status: number; json?: unknown; text?: string } {
  seed()
  const [pathPart, qs = ''] = rawPath.split('?')
  const q = new URLSearchParams(qs)
  const segs = pathPart.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  const M = method.toUpperCase()
  const b = () => parseBody(bodyText)
  const ok = (json: unknown) => ({ status: 200, json })
  const ack = () => ok({ acknowledged: true })
  const s0 = segs[0] ?? ''

  if (!segs.length) {
    if (M === 'GET' || M === 'HEAD') return ok(info())
  }

  // ---- cluster / nodes / cat / tasks ----
  if (s0 === '_cluster') {
    const s1 = segs[1]
    if (s1 === 'health') return ok(clusterHealth())
    if (s1 === 'stats')
      return ok({
        indices: { count: S.indices.size, docs: { count: [...S.indices.values()].reduce((s, i) => s + i.docs.size, 0) }, store: { size_in_bytes: [...S.indices.values()].reduce((s, i) => s + storeBytes(i), 0) } },
        nodes: { count: { total: 1 } },
      })
    if (s1 === 'settings') {
      if (M === 'PUT') {
        const p = b()
        for (const k of ['persistent', 'transient'] as const) Object.assign(S.clusterSettings[k], (p[k] as Src) ?? {})
        return ok({ acknowledged: true, ...S.clusterSettings })
      }
      return ok({ ...S.clusterSettings, ...(q.get('include_defaults') ? { defaults: { 'cluster.routing.allocation.enable': 'all', 'action.destructive_requires_name': 'true' } } : {}) })
    }
    if (s1 === 'state') return ok({ cluster_name: 'studio-cluster', metadata: { stored_scripts: Object.fromEntries(S.scripts) } })
    if (s1 === 'pending_tasks') return ok({ tasks: [] })
    if (s1 === 'allocation' && segs[2] === 'explain') {
      const ix = [...S.indices.values()].find((i) => i.status === 'open' && Number(i.settings['index.number_of_replicas'] ?? '1') > 0)
      if (!ix) return { status: 400, json: { error: { type: 'illegal_argument_exception', reason: 'No shard was specified in the request and there are no unassigned shards' }, status: 400 } }
      return ok({ index: ix.name, shard: 0, primary: false, current_state: 'unassigned', unassigned_info: { reason: 'INDEX_CREATED', last_allocation_status: 'no_attempt' }, can_allocate: 'no', allocate_explanation: 'Elasticsearch isn\'t allowed to allocate this shard to any of the nodes in the cluster. Choose a node to which you expect this shard to be allocated, find this node in the node-by-node explanation, and address the reasons which prevent Elasticsearch from allocating this shard there.', node_allocation_decisions: [{ node_name: 'es-node-1', node_decision: 'no', deciders: [{ decider: 'same_shard', decision: 'NO', explanation: 'a copy of this shard is already allocated to this node' }] }] })
    }
    if (s1 === 'reroute') return ack()
  }
  if (s0 === '_nodes') return ok(nodeStats())
  if (s0 === '_cat') {
    const rows = cat(segs[1] ?? '', q) as Record<string, unknown>[]
    if (q.get('format') === 'json') return ok(rows)
    return { status: 200, text: catText(rows, q.has('v')) }
  }
  if (s0 === '_tasks') {
    if (segs[2] === '_cancel') {
      const t = S.tasks.get(segs[1])
      if (!t) return { status: 404, json: { error: { type: 'resource_not_found_exception', reason: `task [${segs[1]}] is not found` }, status: 404 } }
      S.tasks.delete(segs[1])
      return ok({ nodes: { n1: { tasks: { [segs[1]]: t } } } })
    }
    return ok({ nodes: { n1: { name: 'es-node-1', tasks: Object.fromEntries(S.tasks) } } })
  }
  if (s0 === '_license') return ok({ license: { status: 'active', type: 'basic', issued_to: 'studio-cluster', issue_date: '2026-01-01T00:00:00.000Z' } })
  if (s0 === '_xpack') return ok({ features: { security: { available: true, enabled: true }, ml: { available: false, enabled: true }, watcher: { available: false, enabled: true } }, license: { type: 'basic', status: 'active' } })

  // ---- aliases ----
  if (s0 === '_aliases' && M === 'POST') {
    for (const a of (b().actions as Src[]) ?? []) {
      const [op, cfg] = Object.entries(a)[0] as [string, Src]
      const ixs = resolve(String(cfg.index ?? (cfg.indices as string[])?.join(',') ?? ''), { includeClosed: true })
      const alias = String(cfg.alias ?? '')
      for (const ix of ixs) {
        if (op === 'add') ix.aliases[alias] = { ...(cfg.is_write_index != null ? { is_write_index: !!cfg.is_write_index } : {}), ...(cfg.filter ? { filter: cfg.filter } : {}) }
        else if (op === 'remove') {
          if (!ix.aliases[alias]) throw err(404, 'aliases_not_found_exception', `aliases [${alias}] missing`)
          delete ix.aliases[alias]
        } else if (op === 'remove_index') S.indices.delete(ix.name)
      }
    }
    return ack()
  }
  if (s0 === '_alias' || segs[1] === '_alias') {
    const target = s0 === '_alias' ? [...S.indices.values()] : resolve(s0, { includeClosed: true })
    if (segs[1] === '_alias' && (M === 'PUT' || M === 'POST')) {
      for (const ix of target) ix.aliases[segs[2]] = {}
      return ack()
    }
    if (segs[1] === '_alias' && M === 'DELETE') {
      for (const ix of target) delete ix.aliases[segs[2]]
      return ack()
    }
    const name = s0 === '_alias' ? segs[1] : segs[2]
    return ok(Object.fromEntries(target.filter((ix) => !name || ix.aliases[name]).map((ix) => [ix.name, { aliases: name ? { [name]: ix.aliases[name] } : ix.aliases }])))
  }

  // ---- templates ----
  if (s0 === '_index_template') {
    if (segs[1] === '_simulate_index') {
      const tpl = [...S.templates.entries()].find(([, t]) => (t.index_patterns as string[]).some((p) => wildToRe(p).test(segs[2])))
      const comp = ((tpl?.[1].composed_of as string[]) ?? []).map((c) => S.components.get(c)?.template as Src).filter(Boolean)
      const merged: Src = { settings: {}, mappings: { properties: {} }, aliases: {} }
      for (const t of [...comp, (tpl?.[1].template as Src) ?? {}]) {
        Object.assign(merged.settings as Src, t.settings ?? {})
        Object.assign(((merged.mappings as Src).properties as Src), ((t.mappings as Src)?.properties as Src) ?? {})
      }
      return ok({ template: merged, overlapping: [] })
    }
    if (segs[1] === '_simulate') {
      const t = S.templates.get(segs[2] ?? '')
      if (!t) throw err(404, 'resource_not_found_exception', `index template matching [${segs[2]}] not found`)
      return ok({ template: t.template ?? {}, overlapping: [] })
    }
    return crud(S.templates, segs[1], M, b, (n, v) => ({ name: n, index_template: v }), 'index_templates', 'index template matching')
  }
  if (s0 === '_component_template') return crud(S.components, segs[1], M, b, (n, v) => ({ name: n, component_template: v }), 'component_templates', 'component template matching')

  // ---- ingest ----
  if (s0 === '_ingest' && segs[1] === 'pipeline') {
    const isSim = segs[2] === '_simulate' || segs[3] === '_simulate'
    if (isSim) {
      const body = b()
      const pipeline = (segs[2] === '_simulate' ? body.pipeline : S.pipelines.get(segs[2])) as Src | undefined
      if (!pipeline) throw err(404, 'resource_not_found_exception', `pipeline [${segs[2]}] does not exist`)
      const docs = ((body.docs as Src[]) ?? []).map((d) => {
        const src = structuredClone((d._source as Src) ?? {})
        try {
          for (const p of (pipeline.processors as Src[]) ?? []) applyProcessor(src, p)
        } catch (e) {
          return { error: { root_cause: [{ type: 'illegal_argument_exception', reason: (e as Error).message }], type: 'illegal_argument_exception', reason: (e as Error).message } }
        }
        return { doc: { _index: '_index', _id: '_id', _version: '-3', _source: src, _ingest: { timestamp: new Date().toISOString() } } }
      })
      return ok({ docs })
    }
    if (!segs[2] && M === 'GET') return ok(Object.fromEntries(S.pipelines))
    return crudMap(S.pipelines, segs[2], M, b, 'pipeline')
  }

  // ---- ILM / SLM ----
  if (s0 === '_ilm') {
    if (segs[1] === 'status') return ok({ operation_mode: 'RUNNING' })
    if (segs[1] === 'policy') {
      if (M === 'PUT') {
        S.ilm.set(segs[2], { version: (Number(S.ilm.get(segs[2])?.version ?? 0) + 1), modified_date: new Date().toISOString(), policy: (b().policy as Src) ?? {}, in_use_by: { indices: [], data_streams: [], composable_templates: [] } })
        return ack()
      }
      if (M === 'DELETE') {
        if (!S.ilm.delete(segs[2])) throw err(404, 'resource_not_found_exception', `Lifecycle policy not found: ${segs[2]}`)
        return ack()
      }
      if (segs[2]) {
        const p = S.ilm.get(segs[2])
        if (!p) throw err(404, 'resource_not_found_exception', `Lifecycle policy not found: ${segs[2]}`)
        return ok({ [segs[2]]: p })
      }
      return ok(Object.fromEntries(S.ilm))
    }
  }
  if (segs[1] === '_ilm' && segs[2] === 'explain') {
    return ok({ indices: Object.fromEntries(resolve(s0, { includeHidden: true }).map((ix) => [ix.name, ix.settings['index.lifecycle.name'] ? { index: ix.name, managed: true, policy: ix.settings['index.lifecycle.name'], phase: 'hot', action: 'rollover', step: 'check-rollover-ready' } : { index: ix.name, managed: false }])) })
  }
  if (s0 === '_slm' && segs[1] === 'policy') {
    if (segs[3] === '_execute') {
      const p = S.slm.get(segs[2])
      if (!p) throw err(404, 'resource_not_found_exception', `snapshot lifecycle policy or policies [${segs[2]}] not found`)
      const snap = takeSnapshot(String(p.repository), `nightly-snap-${new Date().toISOString().slice(0, 10)}-${uid().slice(0, 4).toLowerCase()}`, (p.config as Src)?.indices as string[] ?? [])
      return ok({ snapshot_name: snap.snapshot })
    }
    if (M === 'PUT') {
      S.slm.set(segs[2], b())
      return ack()
    }
    if (M === 'DELETE') {
      S.slm.delete(segs[2])
      return ack()
    }
    const list = segs[2] ? [[segs[2], S.slm.get(segs[2])]] : [...S.slm.entries()]
    return ok(Object.fromEntries(list.filter(([, v]) => v).map(([n, v]) => [n, { version: 1, modified_date_millis: Date.now(), policy: v, next_execution_millis: Date.now() + 3_600_000 }])))
  }

  // ---- data streams ----
  if (s0 === '_data_stream') {
    const name = segs[1]
    if (segs[2] === '_stats') {
      const d = S.dataStreams.get(name)
      if (!d) throw notFoundIndex(name)
      const ixs = d.indices.map((i) => S.indices.get(i)!).filter(Boolean)
      return ok({ data_stream_count: 1, backing_indices: ixs.length, total_store_size_bytes: ixs.reduce((s, i) => s + storeBytes(i), 0), data_streams: [{ data_stream: name, backing_indices: ixs.length, store_size_bytes: ixs.reduce((s, i) => s + storeBytes(i), 0), maximum_timestamp: Date.now() }] })
    }
    if (M === 'PUT') {
      const tpl = [...S.templates.entries()].find(([, t]) => t.data_stream && (t.index_patterns as string[]).some((p) => wildToRe(p).test(name)))
      if (!tpl) throw err(400, 'illegal_argument_exception', `no matching index template found for data stream [${name}]`)
      const backing = `.ds-${name}-${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}-000001`
      mkIndex(backing, { '@timestamp': { type: 'date' } }, { 'index.hidden': 'true' })
      S.dataStreams.set(name, { generation: 1, indices: [backing], template: tpl[0], hidden: false })
      return ack()
    }
    if (M === 'DELETE') {
      const d = S.dataStreams.get(name)
      if (!d) throw notFoundIndex(name)
      for (const i of d.indices) S.indices.delete(i)
      S.dataStreams.delete(name)
      return ack()
    }
    const list = [...S.dataStreams.entries()].filter(([n]) => !name || wildToRe(name).test(n))
    if (name && !name.includes('*') && !list.length) throw notFoundIndex(name)
    return ok({
      data_streams: list.map(([n, d]) => ({
        name: n,
        timestamp_field: { name: '@timestamp' },
        indices: d.indices.map((i) => ({ index_name: i, index_uuid: S.indices.get(i)?.uuid ?? '' })),
        generation: d.generation,
        status: 'GREEN',
        template: d.template,
        ilm_policy: 'logs-30d',
        hidden: d.hidden,
        system: false,
      })),
    })
  }

  // ---- snapshots ----
  if (s0 === '_snapshot') {
    const repo = segs[1]
    if (!repo) return ok(Object.fromEntries([...S.repos.entries()].map(([n, r]) => [n, { type: r.type, settings: r.settings }])))
    const rp = S.repos.get(repo)
    if (!segs[2]) {
      if (M === 'PUT' || M === 'POST') {
        const p = b()
        S.repos.set(repo, { type: String(p.type ?? 'fs'), settings: (p.settings as Src) ?? {}, snapshots: rp?.snapshots ?? [] })
        return ack()
      }
      if (!rp) throw err(404, 'repository_missing_exception', `[${repo}] missing`)
      if (M === 'DELETE') {
        S.repos.delete(repo)
        return ack()
      }
      return ok({ [repo]: { type: rp.type, settings: rp.settings } })
    }
    if (!rp) throw err(404, 'repository_missing_exception', `[${repo}] missing`)
    if (segs[2] === '_verify') return ok({ nodes: { n1: { name: 'es-node-1' } } })
    if (segs[2] === '_cleanup') return ok({ results: { deleted_bytes: 0, deleted_blobs: 0 } })
    const snapView = (s: Snapshot) => ({ snapshot: s.snapshot, uuid: s.uuid, repository: repo, indices: s.indices, data_streams: [], include_global_state: false, state: s.state, start_time_in_millis: s.start_time_in_millis, end_time_in_millis: s.end_time_in_millis, duration_in_millis: s.end_time_in_millis - s.start_time_in_millis, failures: [], shards: { total: s.indices.length, failed: 0, successful: s.indices.length } })
    if (segs[2] === '_all' || segs[2] === '*') return ok({ snapshots: rp.snapshots.map(snapView), total: rp.snapshots.length, remaining: 0 })
    const snapName = segs[2]
    if (segs[3] === '_restore') {
      const s = rp.snapshots.find((x) => x.snapshot === snapName)
      if (!s) throw err(404, 'snapshot_missing_exception', `[${repo}:${snapName}] is missing`)
      const p = b()
      const want = p.indices ? String(p.indices).split(',').map((x) => x.trim()) : s.indices
      for (const i of want) {
        if (!s.data[i]) continue
        if (S.indices.get(i)?.status === 'open') throw err(500, 'snapshot_restore_exception', `[${repo}:${snapName}/${s.uuid}] cannot restore index [${i}] because an open index with same name already exists in the cluster. Either close or delete the existing index or restore the index under a different name by providing a rename pattern and replacement name`)
        const renamed = p.rename_pattern ? i.replace(new RegExp(String(p.rename_pattern)), String(p.rename_replacement ?? '')) : i
        const ix = mkIndex(renamed, structuredClone(s.data[i].mappings.properties), { ...s.data[i].settings })
        for (const [id, src] of s.data[i].docs) putDoc(ix, id, structuredClone(src))
      }
      return ok({ snapshot: { snapshot: snapName, indices: want, shards: { total: want.length, failed: 0, successful: want.length } } })
    }
    if (M === 'PUT' || M === 'POST') {
      if (rp.snapshots.some((x) => x.snapshot === snapName)) throw err(400, 'invalid_snapshot_name_exception', `[${repo}:${snapName}] Invalid snapshot name [${snapName}], snapshot with the same name already exists`)
      const p = b()
      const idx = p.indices ? resolve(String(p.indices), { allowNone: true }).map((i) => i.name) : [...S.indices.values()].filter((i) => !i.name.startsWith('.')).map((i) => i.name)
      const s = takeSnapshot(repo, snapName, idx)
      return ok(q.get('wait_for_completion') === 'true' ? { snapshot: snapView(s) } : { accepted: true })
    }
    if (M === 'DELETE') {
      const before = rp.snapshots.length
      rp.snapshots = rp.snapshots.filter((x) => x.snapshot !== snapName)
      if (rp.snapshots.length === before) throw err(404, 'snapshot_missing_exception', `[${repo}:${snapName}] is missing`)
      return ack()
    }
    const s = rp.snapshots.find((x) => x.snapshot === snapName)
    if (!s) throw err(404, 'snapshot_missing_exception', `[${repo}:${snapName}] is missing`)
    return ok({ snapshots: [snapView(s)] })
  }

  // ---- scripts / enrich / transforms / watcher ----
  if (s0 === '_scripts' && segs[1] === 'painless' && segs[2] === '_execute') {
    const p = b()
    const script = (p.script as Src) ?? {}
    if (p.context === 'filter') return ok({ result: true })
    if (p.context === 'score') return ok({ result: 1.0 })
    const v = evalArithmetic(String(script.source ?? ''), (script.params as Record<string, unknown>) ?? {})
    if (v === null) throw err(400, 'script_exception', 'compile error', { script: String(script.source ?? ''), lang: 'painless' })
    return ok({ result: Number.isInteger(v) ? String(v) : String(v) })
  }
  if (s0 === '_analyze') {
    const text = String(b().text ?? '')
    let off = 0
    return ok({ tokens: text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((t, i) => ({ token: t, start_offset: (off = text.toLowerCase().indexOf(t, off)), end_offset: off + t.length, type: /^\d+$/.test(t) ? '<NUM>' : '<ALPHANUM>', position: i })) })
  }
  if (s0 === '_scripts') {
    if (M === 'PUT' || M === 'POST') {
      S.scripts.set(segs[1], (b().script as Src) ?? {})
      return ack()
    }
    if (M === 'DELETE') {
      if (!S.scripts.delete(segs[1])) throw err(404, 'resource_not_found_exception', `stored script [${segs[1]}] does not exist`)
      return ack()
    }
    const sc = S.scripts.get(segs[1])
    return sc ? ok({ _id: segs[1], found: true, script: sc }) : { status: 404, json: { _id: segs[1], found: false } }
  }
  if (s0 === '_enrich' && segs[1] === 'policy') {
    if (segs[3] === '_execute') return ok({ status: { phase: 'COMPLETE' } })
    if (M === 'PUT') {
      const p = b()
      const [type, cfg] = Object.entries(p)[0] as [string, Src]
      S.enrich.set(segs[2], { config: { [type]: { name: segs[2], ...cfg } } })
      return ack()
    }
    if (M === 'DELETE') {
      S.enrich.delete(segs[2])
      return ack()
    }
    return ok({ policies: [...S.enrich.entries()].filter(([n]) => !segs[2] || n === segs[2]).map(([, v]) => v) })
  }
  if (s0 === '_transform') {
    const id = segs[1]
    if (id === '_preview') return ok({ preview: [{ key: 'example', count: 3 }], generated_dest_index: { mappings: { properties: {} } } })
    if (segs[2] === '_start' || segs[2] === '_stop') {
      const t = S.transforms.get(id)
      if (!t) throw err(404, 'resource_not_found_exception', `Transform with id [${id}] could not be found`)
      t.state = segs[2] === '_start' ? 'started' : 'stopped'
      return ack()
    }
    if (segs[2] === '_stats') return ok({ count: 1, transforms: [{ id, state: S.transforms.get(id)?.state ?? 'stopped', stats: { documents_processed: 0 } }] })
    if (M === 'PUT') {
      S.transforms.set(id, { ...b(), state: 'stopped' })
      return ack()
    }
    if (M === 'DELETE') {
      S.transforms.delete(id)
      return ack()
    }
    return ok({ count: S.transforms.size, transforms: [...S.transforms.entries()].map(([n, t]) => ({ id: n, ...t })) })
  }
  if (s0 === '_watcher') {
    if (segs[1] === '_query') return ok({ count: S.watches.size, watches: [...S.watches.entries()].map(([n, w]) => ({ _id: n, watch: w, status: { state: { active: w.active !== false } } })) })
    if (segs[1] === 'watch') {
      const id = segs[2]
      if (segs[3] === '_execute') return ok({ _id: id, watch_record: { state: 'executed', result: { condition: { met: true } } } })
      if (segs[3] === '_activate' || segs[3] === '_deactivate') {
        const w = S.watches.get(id)
        if (w) w.active = segs[3] === '_activate'
        return ok({ status: { state: { active: segs[3] === '_activate' } } })
      }
      if (M === 'PUT') {
        S.watches.set(id, { ...b(), active: true })
        return ok({ _id: id, _version: 1, created: true })
      }
      if (M === 'DELETE') {
        S.watches.delete(id)
        return ok({ _id: id, found: true })
      }
      const w = S.watches.get(id)
      return w ? ok({ _id: id, found: true, watch: w }) : { status: 404, json: { _id: id, found: false } }
    }
  }

  // ---- security ----
  if (s0 === '_security') return security(segs, M, b, q)

  // ---- SQL / ES|QL ----
  if (s0 === '_sql') {
    if (segs[1] === 'close') return ok({ succeeded: true })
    if (segs[1] === 'translate') {
      const query = String(b().query ?? '')
      const m = /from\s+"?([\w.*-]+)"?(?:\s+where\s+"?([\w.]+)"?\s*=\s*'([^']*)')?/i.exec(query)
      return ok({ size: 1000, ...(m?.[2] ? { query: { term: { [m[2]]: { value: m[3] } } } } : {}), _source: false, fields: [{ field: '*' }], sort: [{ _doc: { order: 'asc' } }] })
    }
    const body = b()
    if (body.cursor) return ok({ rows: [] })
    const r = sqlRun(String(body.query ?? ''))
    const fetch = Number(body.fetch_size ?? 1000)
    return ok({ columns: r.columns, rows: r.rows.slice(0, fetch), ...(r.rows.length > fetch ? { cursor: 'demo-cursor' } : {}) })
  }
  if (s0 === '_query') {
    const r = esqlRun(String(b().query ?? ''))
    return ok({ took: 4, columns: r.columns, values: r.values })
  }

  // ---- multi-index document APIs ----
  if (s0 === '_bulk' || segs[1] === '_bulk') return bulk(segs[1] === '_bulk' ? s0 : null, bodyText ?? '', q)
  if (s0 === '_search' || s0 === '_count') {
    const { res, count } = runSearch('_all', b())
    return ok(s0 === '_count' ? { count, _shards: res._shards } : res)
  }
  if (s0 === '_reindex') {
    const p = b()
    const src = p.source as Src
    const { hits } = runSearch(String(src.index), { query: src.query, size: 100000 })
    const destName = String((p.dest as Src).index)
    const dest = S.indices.get(destName) ?? mkIndex(destName, structuredClone(hits[0]?.ix.mappings.properties ?? {}))
    let created = 0
    for (const h of hits) {
      if (!dest.docs.has(h.id)) created++
      putDoc(dest, h.id, structuredClone(h.src))
    }
    return ok({ took: 12, timed_out: false, total: hits.length, updated: hits.length - created, created, deleted: 0, batches: 1, failures: [] })
  }
  if (s0 === '_mget') {
    const docs = ((b().docs as Src[]) ?? []).map((d) => {
      const ix = S.indices.get(String(d._index))
      const src = ix?.docs.get(String(d._id))
      return src ? { _index: ix!.name, _id: d._id, _version: ix!.versions.get(String(d._id)), found: true, _source: src } : { _index: d._index, _id: d._id, found: false }
    })
    return ok({ docs })
  }
  if (s0 === '_resolve' && segs[1] === 'index') {
    const r = resolve(segs[2], { allowNone: true, includeHidden: true, includeClosed: true })
    return ok({ indices: r.map((i) => ({ name: i.name, attributes: [i.status], aliases: Object.keys(i.aliases) })), aliases: [], data_streams: [...S.dataStreams.keys()].filter((n) => wildToRe(segs[2]).test(n)).map((n) => ({ name: n, backing_indices: S.dataStreams.get(n)!.indices, timestamp_field: '@timestamp' })) })
  }

  // ---- per-index ----
  if (s0 && !s0.startsWith('_')) return indexRoute(segs, M, b, q, bodyText)

  return { status: 400, json: { error: `no handler found for uri [${rawPath}] and method [${M}]` } }
}

function crud(
  map: Map<string, Src>,
  name: string | undefined,
  M: string,
  b: () => Src,
  view: (n: string, v: Src) => Src,
  listKey: string,
  label: string,
) {
  if (M === 'PUT' || M === 'POST') {
    map.set(name!, b())
    return { status: 200, json: { acknowledged: true } }
  }
  if (M === 'DELETE') {
    if (!map.delete(name!)) throw err(404, 'resource_not_found_exception', `${label} [${name}] not found`)
    return { status: 200, json: { acknowledged: true } }
  }
  const list = [...map.entries()].filter(([n]) => !name || wildToRe(name).test(n))
  if (name && !name.includes('*') && !list.length) throw err(404, 'resource_not_found_exception', `${label} [${name}] not found`)
  return { status: 200, json: { [listKey]: list.map(([n, v]) => view(n, v)) } }
}

function crudMap(map: Map<string, Src>, name: string, M: string, b: () => Src, label: string) {
  if (M === 'PUT') {
    map.set(name, b())
    return { status: 200, json: { acknowledged: true } }
  }
  if (M === 'DELETE') {
    if (!map.delete(name)) throw err(404, 'resource_not_found_exception', `${label} [${name}] is missing`)
    return { status: 200, json: { acknowledged: true } }
  }
  const v = map.get(name)
  if (!v) return { status: 404, json: {} }
  return { status: 200, json: { [name]: v } }
}

function applyProcessor(src: Src, p: Src) {
  const [type, cfg] = Object.entries(p)[0] as [string, Src]
  const f = String(cfg.field ?? '')
  const set = (path: string, v: unknown) => {
    const parts = path.split('.')
    let cur = src
    for (const k of parts.slice(0, -1)) cur = (cur[k] ??= {}) as Src
    cur[parts[parts.length - 1]] = v
  }
  switch (type) {
    case 'set':
      set(f, String(cfg.value ?? '') === '{{_ingest.timestamp}}' ? new Date().toISOString() : cfg.value)
      break
    case 'uppercase':
      if (getPath(src, f) != null) set(f, String(getPath(src, f)).toUpperCase())
      break
    case 'lowercase':
      if (getPath(src, f) != null) set(f, String(getPath(src, f)).toLowerCase())
      break
    case 'remove':
      delete src[f]
      break
    case 'rename':
      set(String(cfg.target_field), getPath(src, f))
      delete src[f]
      break
    case 'trim':
      if (getPath(src, f) != null) set(f, String(getPath(src, f)).trim())
      break
    case 'grok': {
      const value = String(getPath(src, f) ?? '')
      for (const pat of (cfg.patterns as string[]) ?? []) {
        const m = grokMatch(pat, value, (cfg.pattern_definitions as Record<string, string>) ?? {})
        if (m) {
          for (const [k, v] of Object.entries(m)) set(k, v)
          return
        }
      }
      throw new Error(`Provided Grok expressions do not match field value: [${value}]`)
    }
    default:
      break
  }
}

function bulk(defaultIndex: string | null, text: string, q: URLSearchParams) {
  const lines = text.split('\n').filter((l) => l.trim())
  const items: Src[] = []
  let errors = false
  for (let i = 0; i < lines.length; i++) {
    let action: Src
    try {
      action = JSON.parse(lines[i])
    } catch {
      throw err(400, 'illegal_argument_exception', `Malformed action/metadata line [${i + 1}], expected START_OBJECT but found [VALUE_STRING]`)
    }
    const [op, meta] = Object.entries(action)[0] as [string, Src]
    const idxName = String(meta._index ?? defaultIndex ?? '')
    const id = meta._id != null ? String(meta._id) : null
    let ix = S.indices.get(idxName)
    if (op === 'delete') {
      const found = !!ix?.docs.delete(String(id))
      items.push({ delete: { _index: idxName, _id: id, result: found ? 'deleted' : 'not_found', status: found ? 200 : 404 } })
      continue
    }
    const src = JSON.parse(lines[++i] ?? '{}')
    if (!ix) {
      if (S.dataStreams.has(idxName)) ix = S.indices.get(S.dataStreams.get(idxName)!.indices.slice(-1)[0])
      else ix = mkIndex(idxName, {})
    }
    if (op === 'create' && id && ix!.docs.has(id)) {
      errors = true
      items.push({ create: { _index: idxName, _id: id, status: 409, error: { type: 'version_conflict_engine_exception', reason: `[${id}]: version conflict, document already exists` } } })
      continue
    }
    if (op === 'update') {
      const cur = ix!.docs.get(String(id))
      if (!cur) {
        errors = true
        items.push({ update: { _index: idxName, _id: id, status: 404, error: { type: 'document_missing_exception', reason: `[${id}]: document missing` } } })
        continue
      }
      putDoc(ix!, String(id), { ...cur, ...((src as Src).doc as Src) })
      items.push({ update: { _index: idxName, _id: id, result: 'updated', status: 200 } })
      continue
    }
    const existed = id != null && ix!.docs.has(id)
    mapDynamic(ix!, src)
    const nid = putDoc(ix!, id, src)
    items.push({ [op]: { _index: ix!.name, _id: nid, _version: ix!.versions.get(nid), result: existed ? 'updated' : 'created', status: existed ? 200 : 201 } })
  }
  void q
  return { status: 200, json: { took: 3, errors, items } }
}

function indexRoute(segs: string[], M: string, b: () => Src, q: URLSearchParams, bodyText: string | null): { status: number; json?: unknown; text?: string } {
  const name = segs[0]
  const op = segs[1]
  const ok = (json: unknown) => ({ status: 200, json })

  if (!op) {
    if (M === 'PUT') {
      if (S.indices.has(name)) throw err(400, 'resource_already_exists_exception', `index [${name}/${S.indices.get(name)!.uuid}] already exists`, { index: name })
      if (name !== name.toLowerCase()) throw err(400, 'invalid_index_name_exception', `Invalid index name [${name}], must be lowercase`, { index: name })
      const p = b()
      const settings: Record<string, string> = {}
      const flat = (o: Src, pre = '') => {
        for (const [k, v] of Object.entries(o ?? {})) {
          const key = pre ? `${pre}.${k}` : k
          if (v && typeof v === 'object') flat(v as Src, key)
          else settings[key.startsWith('index.') ? key : `index.${key}`] = String(v)
        }
      }
      flat((p.settings as Src) ?? {})
      const ix = mkIndex(name, structuredClone(((p.mappings as Src)?.properties as Record<string, MapProp>) ?? {}), settings)
      ix.created = Date.now()
      for (const [a, v] of Object.entries((p.aliases as Src) ?? {})) ix.aliases[a] = (v as Src) ?? {}
      return ok({ acknowledged: true, shards_acknowledged: true, index: name })
    }
    if (M === 'DELETE') {
      const ixs = resolve(name, { includeClosed: true, includeHidden: true })
      for (const ix of ixs) S.indices.delete(ix.name)
      return ok({ acknowledged: true })
    }
    if (M === 'HEAD') {
      return { status: S.indices.has(name) ? 200 : 404 }
    }
    const ixs = resolve(name, { includeClosed: true, includeHidden: true })
    return ok(Object.fromEntries(ixs.map((ix) => [ix.name, { aliases: ix.aliases, mappings: ix.mappings, settings: unflatten(ix.settings) }])))
  }

  if (op === '_open' || op === '_close') {
    const ixs = resolve(name, { includeClosed: true })
    for (const ix of ixs) ix.status = op === '_open' ? 'open' : 'close'
    return ok({ acknowledged: true, shards_acknowledged: true, ...(op === '_close' ? { indices: Object.fromEntries(ixs.map((i) => [i.name, { closed: true }])) } : {}) })
  }

  const ixs = resolve(name, { includeHidden: true })
  const first = ixs[0]

  switch (op) {
    case '_search': {
      const body = b()
      if (q.get('q')) body.query = { query_string: { query: q.get('q') } }
      if (q.get('size')) body.size = Number(q.get('size'))
      return ok(runSearch(name, body).res)
    }
    case '_count':
      return ok({ count: runSearch(name, { ...b(), size: 0 }).count, _shards: { total: ixs.length, successful: ixs.length, skipped: 0, failed: 0 } })
    case '_mapping': {
      if (M === 'PUT') {
        const props = (b().properties as Record<string, MapProp>) ?? {}
        for (const ix of ixs) {
          for (const [f, def] of Object.entries(props)) {
            const cur = ix.mappings.properties[f]
            if (cur?.type && def.type && cur.type !== def.type)
              throw err(400, 'illegal_argument_exception', `mapper [${f}] cannot be changed from type [${cur.type}] to [${def.type}]`)
            ix.mappings.properties[f] = { ...cur, ...def }
          }
        }
        return ok({ acknowledged: true })
      }
      return ok(Object.fromEntries(ixs.map((ix) => [ix.name, { mappings: ix.mappings }])))
    }
    case '_settings': {
      if (M === 'PUT') {
        const p = b()
        const flat = (o: Src, pre = '') => {
          for (const [k, v] of Object.entries(o ?? {})) {
            const key = pre ? `${pre}.${k}` : k
            if (v && typeof v === 'object') flat(v as Src, key)
            else for (const ix of ixs) {
              const full = key.startsWith('index.') ? key : `index.${key}`
              if (full === 'index.number_of_shards') throw err(400, 'illegal_argument_exception', "Can't update non dynamic settings [[index.number_of_shards]] for open indices")
              if (v === null) delete ix.settings[full]
              else ix.settings[full] = String(v)
            }
          }
        }
        flat(p)
        return ok({ acknowledged: true })
      }
      return ok(Object.fromEntries(ixs.map((ix) => [ix.name, { settings: q.get('flat_settings') === 'true' ? ix.settings : unflatten(ix.settings) }])))
    }
    case '_stats':
      return ok({
        _shards: { total: ixs.length, successful: ixs.length, failed: 0 },
        _all: {
          primaries: { docs: { count: ixs.reduce((s, i) => s + i.docs.size, 0), deleted: 0 }, store: { size_in_bytes: ixs.reduce((s, i) => s + storeBytes(i), 0) } },
          total: {
            docs: { count: ixs.reduce((s, i) => s + i.docs.size, 0), deleted: 0 },
            store: { size_in_bytes: ixs.reduce((s, i) => s + storeBytes(i), 0) },
            segments: { count: ixs.length * 3 },
            indexing: { index_total: ixs.reduce((s, i) => s + i.stats.index, 0), index_time_in_millis: ixs.reduce((s, i) => s + i.stats.index * 2, 0) },
            search: { query_total: ixs.reduce((s, i) => s + i.stats.search, 0), query_time_in_millis: ixs.reduce((s, i) => s + i.stats.search * 3, 0) },
            get: { total: ixs.reduce((s, i) => s + i.stats.get, 0) },
            refresh: { total: ixs.reduce((s, i) => s + i.stats.refresh, 0) },
            flush: { total: ixs.reduce((s, i) => s + i.stats.flush, 0) },
            merges: { total: ixs.reduce((s, i) => s + i.stats.merges, 0) },
          },
        },
      })
    case '_refresh':
    case '_flush':
    case '_forcemerge':
      for (const ix of ixs) ix.stats[op === '_refresh' ? 'refresh' : op === '_flush' ? 'flush' : 'merges']++
      return ok({ _shards: { total: ixs.length, successful: ixs.length, failed: 0 } })
    case '_cache':
      return ok({ _shards: { total: ixs.length, successful: ixs.length, failed: 0 } })
    case '_doc':
    case '_create': {
      const id = segs[2]
      if (M === 'POST' && !id) {
        const src = b()
        if (q.get('pipeline')) for (const p of (S.pipelines.get(q.get('pipeline')!)?.processors as Src[]) ?? []) applyProcessor(src, p)
        mapDynamic(first, src)
        const nid = putDoc(first, null, src)
        return { status: 201, json: { _index: first.name, _id: nid, _version: 1, result: 'created', _shards: { total: 2, successful: 1, failed: 0 }, _seq_no: first.seq, _primary_term: 1 } }
      }
      if (M === 'PUT' || M === 'POST') {
        const existed = first.docs.has(id)
        if (op === '_create' && existed) throw err(409, 'version_conflict_engine_exception', `[${id}]: version conflict, document already exists (current version [${first.versions.get(id)}])`)
        const src = b()
        if (q.get('pipeline')) for (const p of (S.pipelines.get(q.get('pipeline')!)?.processors as Src[]) ?? []) applyProcessor(src, p)
        mapDynamic(first, src)
        putDoc(first, id, src)
        return { status: existed ? 200 : 201, json: { _index: first.name, _id: id, _version: first.versions.get(id), result: existed ? 'updated' : 'created', _seq_no: first.seq, _primary_term: 1 } }
      }
      if (M === 'DELETE') {
        const existed = first.docs.delete(id)
        return { status: existed ? 200 : 404, json: { _index: first.name, _id: id, result: existed ? 'deleted' : 'not_found' } }
      }
      const found = ixs.find((ix) => ix.docs.has(id))
      if (!found) return { status: 404, json: { _index: first.name, _id: id, found: false } }
      found.stats.get++
      if (M === 'HEAD') return { status: 200 }
      return ok({ _index: found.name, _id: id, _version: found.versions.get(id), _seq_no: found.seq, _primary_term: 1, found: true, _source: found.docs.get(id) })
    }
    case '_update': {
      const id = segs[2]
      const cur = first.docs.get(id)
      if (!cur) throw err(404, 'document_missing_exception', `[${id}]: document missing`, { index: first.name })
      const p = b()
      putDoc(first, id, { ...cur, ...((p.doc as Src) ?? {}) })
      return ok({ _index: first.name, _id: id, _version: first.versions.get(id), result: 'updated' })
    }
    case '_delete_by_query': {
      const { hits } = runSearch(name, { query: b().query, size: 100000 })
      for (const h of hits) h.ix.docs.delete(h.id)
      return ok({ took: 5, timed_out: false, total: hits.length, deleted: hits.length, batches: 1, failures: [] })
    }
    case '_update_by_query': {
      const p = b()
      const { hits } = runSearch(name, { query: p.query, size: 100000 })
      const script = String((p.script as Src)?.source ?? '')
      const m = /ctx\._source\.([\w.]+)\s*=\s*'([^']*)'/.exec(script)
      for (const h of hits) if (m) putDoc(h.ix, h.id, { ...h.src, [m[1]]: m[2] })
      return ok({ took: 5, timed_out: false, total: hits.length, updated: hits.length, batches: 1, failures: [] })
    }
    case '_rollover': {
      const ds = S.dataStreams.get(name)
      if (!ds) throw err(400, 'illegal_argument_exception', `rollover target [${name}] does not exist`)
      const old = ds.indices[ds.indices.length - 1]
      ds.generation++
      const next = `.ds-${name}-${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}-${String(ds.generation).padStart(6, '0')}`
      mkIndex(next, structuredClone(S.indices.get(old)?.mappings.properties ?? {}), { 'index.hidden': 'true' })
      ds.indices.push(next)
      return ok({ acknowledged: true, shards_acknowledged: true, old_index: old, new_index: next, rolled_over: true, dry_run: false, conditions: {} })
    }
    case '_analyze': {
      const text = String(b().text ?? '')
      let off = 0
      return ok({ tokens: text.toLowerCase().split(/\W+/).filter(Boolean).map((t, i) => ({ token: t, start_offset: (off = text.toLowerCase().indexOf(t, off)), end_offset: off + t.length, type: '<ALPHANUM>', position: i })) })
    }
    case '_field_caps':
      return ok({ indices: ixs.map((i) => i.name), fields: Object.fromEntries(flatProps(first.mappings.properties).map(([f, t]) => [f, { [t]: { type: t, searchable: true, aggregatable: t !== 'text' } }])) })
    case '_validate':
      try {
        for (const [id, src] of first.docs) matches(src, id, first, b().query as Src)
        return ok({ valid: true, _shards: { total: 1, successful: 1, failed: 0 } })
      } catch (e) {
        return ok({ valid: false, error: ((e as HttpErr).body as Src)?.error })
      }
    case '_explain':
      return ok({ _index: first.name, _id: segs[2], matched: true, explanation: { value: 1, description: 'ConstantScore', details: [] } })
    case '_clone':
    case '_shrink':
    case '_split': {
      const target = segs[2]
      if (!target) throw err(400, 'action_request_validation_exception', 'Validation Failed: 1: target index is missing;')
      if (first.settings['index.blocks.write'] !== 'true')
        throw err(500, 'illegal_state_exception', `index ${first.name} must be read-only to resize index. use "index.blocks.write=true"`)
      if (S.indices.has(target)) throw err(400, 'resource_already_exists_exception', `index [${target}] already exists`, { index: target })
      const p = b()
      const shards = String(((p.settings as Src)?.['index.number_of_shards'] ?? ((p.settings as Src)?.index as Src)?.number_of_shards ?? (op === '_clone' ? first.settings['index.number_of_shards'] : 1)) as string)
      const replicas = String(((p.settings as Src)?.['index.number_of_replicas'] ?? 1) as string)
      const ix = mkIndex(target, structuredClone(first.mappings.properties), { ...first.settings, 'index.number_of_shards': shards, 'index.number_of_replicas': replicas, 'index.provided_name': target, 'index.blocks.write': 'false' })
      for (const [id, src] of first.docs) putDoc(ix, id, structuredClone(src))
      return ok({ acknowledged: true, shards_acknowledged: true, index: target })
    }
    case '_ilm':
      break
    default:
      break
  }
  void bodyText
  return { status: 400, json: { error: `no handler found for uri [/${segs.join('/')}] and method [${M}]` } }
}

function unflatten(flat: Record<string, string>): Src {
  const out: Src = {}
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split('.')
    let cur = out
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Src
    cur[parts[parts.length - 1]] = v
  }
  return out
}

function security(segs: string[], M: string, b: () => Src, q: URLSearchParams): { status: number; json?: unknown } {
  const ok = (json: unknown) => ({ status: 200, json })
  const s1 = segs[1]
  if (s1 === '_authenticate')
    return ok({ username: 'elastic', roles: ['superuser'], full_name: null, email: null, metadata: { _reserved: true }, enabled: true, authentication_realm: { name: 'reserved', type: 'reserved' }, lookup_realm: { name: 'reserved', type: 'reserved' }, authentication_type: 'realm' })
  if (s1 === 'user') {
    const name = segs[2]
    if (name === '_has_privileges') return ok({ username: 'elastic', has_all_requested: true, cluster: {}, index: {} })
    if (segs[3] === '_password') {
      const u = S.users.get(name)
      if (!u) throw err(404, 'resource_not_found_exception', `user [${name}] not found`)
      u.password = String(b().password ?? '')
      return ok({})
    }
    if (segs[3] === '_enable' || segs[3] === '_disable') {
      const u = S.users.get(name)
      if (!u) throw err(404, 'resource_not_found_exception', `user [${name}] not found`)
      u.enabled = segs[3] === '_enable'
      return ok({})
    }
    if (M === 'PUT' || M === 'POST') {
      const p = b()
      const existed = S.users.has(name)
      const prev = S.users.get(name)
      if (!existed && !p.password && !p.password_hash) throw err(400, 'action_request_validation_exception', 'Validation Failed: 1: password must be specified unless you are updating an existing user;')
      if (p.password && String(p.password).length < 6) throw err(400, 'action_request_validation_exception', 'Validation Failed: 1: passwords must be at least [6] characters long;')
      S.users.set(name, {
        username: name,
        roles: (p.roles as string[]) ?? prev?.roles ?? [],
        full_name: (p.full_name as string) ?? prev?.full_name ?? null,
        email: (p.email as string) ?? prev?.email ?? null,
        metadata: (p.metadata as Src) ?? prev?.metadata ?? {},
        enabled: p.enabled === undefined ? (prev?.enabled ?? true) : !!p.enabled,
        password: (p.password as string) ?? prev?.password,
      })
      return ok({ created: !existed })
    }
    if (M === 'DELETE') {
      const u = S.users.get(name)
      if (!u) return { status: 404, json: { found: false } }
      if ((u.metadata as Src)?._reserved) throw err(400, 'illegal_argument_exception', `user [${name}] is reserved and cannot be deleted`)
      S.users.delete(name)
      return ok({ found: true })
    }
    const view = (u: Src) => Object.fromEntries(Object.entries(u).filter(([k]) => k !== 'password'))
    if (name) {
      const names = name.split(',')
      const found = names.filter((n) => S.users.has(n))
      if (!found.length) return { status: 404, json: {} }
      return ok(Object.fromEntries(found.map((n) => [n, view(S.users.get(n)!)])))
    }
    return ok(Object.fromEntries([...S.users.entries()].map(([n, u]) => [n, view(u)])))
  }
  if (s1 === 'role') {
    const name = segs[2]
    if (M === 'PUT' || M === 'POST') {
      const existed = S.roles.has(name)
      if ((S.roles.get(name)?.metadata as Src)?._reserved) throw err(400, 'illegal_argument_exception', `role [${name}] is reserved and cannot be modified`)
      const p = b()
      S.roles.set(name, { cluster: p.cluster ?? [], indices: p.indices ?? [], applications: p.applications ?? [], run_as: p.run_as ?? [], metadata: p.metadata ?? {}, transient_metadata: { enabled: true } })
      return ok({ role: { created: !existed } })
    }
    if (M === 'DELETE') {
      if ((S.roles.get(name)?.metadata as Src)?._reserved) throw err(400, 'illegal_argument_exception', `role [${name}] is reserved and cannot be deleted`)
      return ok({ found: S.roles.delete(name) })
    }
    if (name) {
      const r = S.roles.get(name)
      return r ? ok({ [name]: r }) : { status: 404, json: {} }
    }
    return ok(Object.fromEntries(S.roles))
  }
  if (s1 === 'api_key') {
    if (M === 'POST' || M === 'PUT') {
      const p = b()
      const id = uid('k')
      const key = 'demo' + uid('s')
      const expMs = p.expiration ? Number(/^(\d+)d$/.exec(String(p.expiration))?.[1] ?? 0) * 86_400_000 : 0
      S.apiKeys.push({ id, name: p.name, creation: Date.now(), expiration: expMs ? Date.now() + expMs : null, invalidated: false, username: 'elastic', realm: 'reserved', metadata: p.metadata ?? {}, role_descriptors: p.role_descriptors ?? {} })
      return ok({ id, name: p.name, api_key: key, encoded: btoa(`${id}:${key}`), ...(expMs ? { expiration: Date.now() + expMs } : {}) })
    }
    if (M === 'DELETE') {
      const p = b()
      const ids = (p.ids as string[]) ?? (p.id ? [String(p.id)] : [])
      const hit = S.apiKeys.filter((k) => !k.invalidated && (ids.includes(String(k.id)) || (p.name && k.name === p.name)))
      for (const k of hit) k.invalidated = true
      return ok({ invalidated_api_keys: hit.map((k) => k.id), previously_invalidated_api_keys: [], error_count: 0 })
    }
    const name = q.get('name')
    return ok({ api_keys: S.apiKeys.filter((k) => !name || k.name === name) })
  }
  if (s1 === 'role_mapping') {
    const name = segs[2]
    if (M === 'PUT' || M === 'POST') {
      S.roleMappings.set(name, b())
      return ok({ role_mapping: { created: true } })
    }
    if (M === 'DELETE') return ok({ found: S.roleMappings.delete(name) })
    return ok(Object.fromEntries([...S.roleMappings.entries()].filter(([n]) => !name || n === name)))
  }
  if (s1 === 'privilege') {
    if (segs[2] === '_builtin')
      return ok({
        cluster: ['all', 'monitor', 'manage', 'manage_index_templates', 'manage_ingest_pipelines', 'manage_ilm', 'manage_security', 'manage_api_key', 'manage_own_api_key', 'read_ilm', 'monitor_snapshot', 'create_snapshot', 'manage_slm'],
        index: ['all', 'read', 'write', 'index', 'create', 'create_doc', 'delete', 'delete_index', 'create_index', 'manage', 'monitor', 'view_index_metadata', 'auto_configure', 'maintenance', 'manage_ilm'],
      })
    return ok({})
  }
  return { status: 400, json: { error: `no handler found for uri [/${segs.join('/')}] and method [${M}]` } }
}

// ---------------------------------------------------------------------------
// entry point (called from demo.ts for every es_* command)
// ---------------------------------------------------------------------------

export function esDemo(cmd: string, args: Record<string, unknown>): unknown {
  seed()
  switch (cmd) {
    case 'es_overview': {
      const h = clusterHealth()
      const all = [...S.indices.values()]
      const ov: EsOverview = {
        info: { name: 'es-node-1', cluster_name: 'studio-cluster', cluster_uuid: 'Zr3qP0x8TT2s0dyrzXk1ZQ', version: '8.15.3', distribution: 'elasticsearch', lucene_version: '9.11.1', build_flavor: 'default', tagline: 'You Know, for Search' },
        status: h.status,
        number_of_nodes: 1,
        number_of_data_nodes: 1,
        active_primary_shards: h.active_primary_shards,
        active_shards: h.active_shards,
        relocating_shards: 0,
        initializing_shards: 0,
        unassigned_shards: h.unassigned_shards,
        number_of_pending_tasks: 0,
        active_shards_percent: h.active_shards_percent_as_number,
        indices: all.length,
        docs: all.reduce((s, i) => s + i.docs.size, 0),
        store_bytes: all.reduce((s, i) => s + storeBytes(i), 0),
        warning: null,
      }
      return ov
    }
    case 'es_indices':
      return [...S.indices.values()]
        .map((ix) => {
          const r = catIndexRow(ix)
          const num = (v: string | null) => (v == null ? null : Number(v))
          const ds = /^\.ds-(.+)-\d{4}\.\d{2}\.\d{2}-\d+$/.exec(ix.name)?.[1] ?? null
          const out: EsIndex = {
            name: ix.name,
            health: r.health ?? '',
            status: ix.status,
            uuid: ix.uuid,
            primaries: Number(r.pri),
            replicas: Number(r.rep),
            docs_count: num(r['docs.count']),
            docs_deleted: num(r['docs.deleted']),
            store_bytes: num(r['store.size']),
            pri_store_bytes: num(r['pri.store.size']),
            created: r['creation.date.string'],
            hidden: ix.name.startsWith('.'),
            data_stream: ds,
          }
          return out
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    case 'es_mapping_fields': {
      const ixs = resolve(String(args.index ?? ''), { includeHidden: true, includeClosed: true })
      const seen = new Map<string, string>()
      for (const ix of ixs) for (const [f, t] of flatProps(ix.mappings.properties)) if (!seen.has(f)) seen.set(f, t)
      return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    }
    case 'es_request': {
      const started = performance.now()
      let r: { status: number; json?: unknown; text?: string }
      try {
        r = route(String(args.method ?? 'GET'), String(args.path ?? '/'), (args.body as string | null) ?? null)
      } catch (e) {
        if (e instanceof HttpErr) r = { status: e.status, json: e.body }
        else throw e
      }
      const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '')
      const res: EsResponse = {
        status: r.status,
        ok: r.status >= 200 && r.status < 300,
        json: r.json ?? null,
        text: r.text ?? null,
        took_ms: Math.max(1, Math.round(performance.now() - started)),
        content_type: r.text ? 'text/plain; charset=UTF-8' : 'application/json',
        warnings: String(args.path ?? '').includes('_xpack') ? ['[GET /_xpack] is deprecated! Use [GET /_license] instead.'] : [],
        bytes: text.length,
      }
      return res
    }
    default:
      throw new Error(`unknown elasticsearch demo command ${cmd}`)
  }
}
