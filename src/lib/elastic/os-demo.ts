// OpenSearch demo (opt-in `?opensearch=1`, connection `os1`) — SPEC-OPENSEARCH.md §3.
// Wraps the stateful Elasticsearch demo (same indices, documents, search, cat…) and
// answers what OpenSearch does differently, the way OpenSearch 3.9 was measured to:
// `GET /` says distribution "opensearch"; X-Pack routes answer 400 "no handler found";
// SQL / PPL plugins answer `format=jdbc`; ISM / transforms / rollups / snapshot policies
// refuse an update without `if_seq_no` + `if_primary_term` (409); the security plugin
// keeps users / roles / mappings / action groups / tenants with a password policy.
// NEVER used in the desktop app.

import type { EsOverview, EsResponse } from '$lib/ipc'
import { esDemo } from './demo'

export const OS_DEMO_ID = 'os1'
export const OS_DEMO_VERSION = '3.9.0'

export function osDemoEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('opensearch') === '1'
  } catch {
    return false
  }
}

/** The demo OpenSearch connection or an id derived from it (`os1#tab-…`). */
export function isOsDemo(args: Record<string, unknown> | undefined): boolean {
  const id = String(args?.connId ?? '')
  return id === OS_DEMO_ID || id.startsWith(`${OS_DEMO_ID}#`) || id.startsWith(`${OS_DEMO_ID}::`)
}

type Src = Record<string, unknown>
type Res = { status: number; json?: unknown; text?: string }

class OsErr extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super('os')
  }
}
const fail = (status: number, body: unknown) => new OsErr(status, body)
const errDoc = (status: number, type: string, reason: string) => fail(status, { error: { root_cause: [{ type, reason }], type, reason }, status })
const sec = (status: number, statusText: string, message: string) => fail(status, { status: statusText, message })

// ---- state --------------------------------------------------------------------

interface Versioned {
  body: Src
  seq: number
  term: number
}
let seqN = 10
const versioned = (body: Src): Versioned => ({ body, seq: ++seqN, term: 1 })

const S = {
  seeded: false,
  ism: new Map<string, Versioned>(),
  managed: new Map<string, { policy: string; at: number }>(),
  sm: new Map<string, Versioned>(),
  transforms: new Map<string, Versioned>(),
  rollups: new Map<string, Versioned>(),
  monitors: new Map<string, Versioned>(),
  users: new Map<string, Src>(),
  roles: new Map<string, Src>(),
  mappings: new Map<string, Src>(),
  groups: new Map<string, Src>(),
  tenants: new Map<string, Src>(),
}

function seed() {
  if (S.seeded) return
  S.seeded = true
  S.ism.set(
    'logs-hot-delete',
    versioned({
      policy_id: 'logs-hot-delete',
      description: 'Roll over daily, delete after 30 days',
      default_state: 'hot',
      states: [
        { name: 'hot', actions: [{ rollover: { min_index_age: '1d' } }], transitions: [{ state_name: 'delete', conditions: { min_index_age: '30d' } }] },
        { name: 'delete', actions: [{ delete: {} }], transitions: [] },
      ],
      ism_template: [{ index_patterns: ['logs-*'], priority: 100 }],
      schema_version: 31,
      last_updated_time: Date.now() - 86_400_000,
    }),
  )
  S.monitors.set(
    'mon-errors-1',
    versioned({
      type: 'monitor',
      name: 'Payment errors',
      monitor_type: 'query_level_monitor',
      enabled: true,
      schedule: { period: { interval: 5, unit: 'MINUTES' } },
      inputs: [{ search: { indices: ['orders'], query: { size: 0, query: { term: { status: 'failed' } } } } }],
      triggers: [{ name: 'Any failure', severity: '1', condition: { script: { source: 'ctx.results[0].hits.total.value > 0', lang: 'painless' } }, actions: [] }],
      schema_version: 9,
    }),
  )
  const reserved = { reserved: true, hidden: false, static: false }
  const staticFlags = { reserved: true, hidden: false, static: true }
  S.users.set('admin', { backend_roles: ['admin'], attributes: {}, description: 'Demo admin user', opendistro_security_roles: [], ...reserved })
  S.users.set('analyst', { backend_roles: ['analysts'], attributes: { team: 'payments' }, description: 'Reads orders', opendistro_security_roles: [], reserved: false, hidden: false, static: false })
  S.roles.set('all_access', { description: 'Allow full access to all indices and all cluster APIs', cluster_permissions: ['*'], index_permissions: [{ index_patterns: ['*'], allowed_actions: ['*'], fls: [], masked_fields: [] }], tenant_permissions: [{ tenant_patterns: ['*'], allowed_actions: ['kibana_all_write'] }], ...staticFlags })
  S.roles.set('readall', { description: 'Read access to all indices', cluster_permissions: ['cluster_composite_ops_ro'], index_permissions: [{ index_patterns: ['*'], allowed_actions: ['read'], fls: [], masked_fields: [] }], tenant_permissions: [], ...staticFlags })
  S.roles.set('orders_reader', { description: 'Payments team — reads orders, emails hidden', cluster_permissions: ['cluster_composite_ops_ro'], index_permissions: [{ index_patterns: ['orders*'], allowed_actions: ['read'], dls: '{"term":{"status":"paid"}}', fls: ['~internal_note'], masked_fields: ['email'] }], tenant_permissions: [{ tenant_patterns: ['global_tenant'], allowed_actions: ['kibana_all_read'] }], reserved: false, hidden: false, static: false })
  S.mappings.set('all_access', { users: [], backend_roles: ['admin'], hosts: [], and_backend_roles: [], description: 'Maps admin to all_access', reserved: false, hidden: false })
  S.mappings.set('orders_reader', { users: [], backend_roles: ['analysts'], hosts: [], and_backend_roles: [], reserved: false, hidden: false })
  const ag = (type: string, allowed_actions: string[], description: string) => ({ type, allowed_actions, description, ...staticFlags })
  S.groups.set('read', ag('index', ['indices:data/read*', 'indices:admin/mappings/get*'], 'Allow all read operations'))
  S.groups.set('write', ag('index', ['indices:data/write*', 'indices:admin/mapping/put'], 'Allow writing in all indices'))
  S.groups.set('crud', ag('index', ['read', 'write'], 'Allow all read/write operations on data'))
  S.groups.set('search', ag('index', ['indices:data/read/search*', 'indices:data/read/msearch*'], 'Allow searching'))
  S.groups.set('manage', ag('index', ['indices:monitor/*', 'indices:admin/*'], 'Allow everything but read and write'))
  S.groups.set('cluster_composite_ops_ro', ag('cluster', ['indices:data/read/mget', 'indices:data/read/msearch*'], 'Allow read-only multi requests'))
  S.groups.set('cluster_monitor', ag('cluster', ['cluster:monitor/*'], 'Allow monitoring the cluster'))
  S.groups.set('cluster_all', ag('cluster', ['cluster:*'], 'Allow everything on cluster level'))
  S.groups.set('manage_snapshots', ag('cluster', ['cluster:admin/snapshot/*', 'cluster:admin/repository/*'], 'Allow snapshots'))
  S.tenants.set('global_tenant', { description: 'Global tenant', ...staticFlags })
  S.tenants.set('payments', { description: 'Payments dashboards', reserved: false, hidden: false, static: false })
}

// ---- helpers -------------------------------------------------------------------

function parse(body: string | null): Src {
  if (!body?.trim()) return {}
  try {
    return JSON.parse(body)
  } catch (e) {
    throw errDoc(400, 'json_parse_exception', (e as Error).message)
  }
}

/** Updates of ISM / transforms / rollups / SM need the version they replace (measured O14). */
function checkVersion(v: Versioned | undefined, q: URLSearchParams, name: string, sm = false) {
  if (!v) return
  const seq = q.get('if_seq_no')
  const term = q.get('if_primary_term')
  if (seq == null || term == null) {
    if (sm) throw errDoc(400, 'action_request_validation_exception', 'Validation Failed: 1: Sequence number and primary term must be provided when updating a snapshot management policy;')
    throw errDoc(409, 'version_conflict_engine_exception', `[${name}]: version conflict, document already exists (current version [1])`)
  }
  if (Number(seq) !== v.seq || Number(term) !== v.term)
    throw errDoc(409, 'version_conflict_engine_exception', `[${name}]: version conflict, required seqNo [${seq}], primary term [${term}]. current document has seqNo [${v.seq}] and primary term [${v.term}]`)
}

const es = (method: string, path: string, body?: unknown): Res => {
  const r = esDemo('es_request', { method, path, body: body === undefined ? null : JSON.stringify(body) }) as EsResponse
  return { status: r.status, json: r.json ?? undefined, text: r.text ?? undefined }
}

/** `{columns, rows|values}` → OpenSearch `format=jdbc`. */
function toJdbc(j: { columns?: { name: string; type: string }[]; rows?: unknown[][]; values?: unknown[][] }): Src {
  const rows = j.rows ?? j.values ?? []
  return { schema: (j.columns ?? []).map((c) => ({ name: c.name, type: c.type })), datarows: rows, total: rows.length, size: rows.length, status: 200 }
}

/** The PPL subset the query examples use → ES|QL for the shared demo engine. */
export function pplToEsql(ppl: string): string {
  const parts = ppl.split('|').map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    let m: RegExpExecArray | null
    if ((m = /^(?:search\s+)?source\s*=\s*(\S+)/i.exec(p))) out.push(`FROM ${m[1]}`)
    else if ((m = /^where\s+(.+)$/i.exec(p))) out.push(`WHERE ${m[1]}`)
    else if ((m = /^fields\s+(.+)$/i.exec(p))) out.push(`KEEP ${m[1].replace(/^\+\s*/, '')}`)
    else if ((m = /^head(?:\s+(\d+))?$/i.exec(p))) out.push(`LIMIT ${m[1] ?? 10}`)
    else if ((m = /^sort\s+(-|\+)?\s*(\S+)$/i.exec(p))) out.push(`SORT ${m[2]}${m[1] === '-' ? ' DESC' : ''}`)
    else if ((m = /^stats\s+count\(\)(?:\s+as\s+(\w+))?(?:\s+by\s+(\S+))?$/i.exec(p))) out.push(`STATS ${m[1] ?? 'count()'} = COUNT(*)${m[2] ? ` BY ${m[2]}` : ''}`)
    else if ((m = /^top\s+(\d+)\s+(\S+)$/i.exec(p))) out.push(`STATS count = COUNT(*) BY ${m[2]}`, 'SORT count DESC', `LIMIT ${m[1]}`)
    else throw errDoc(400, 'SyntaxCheckException', `[${p}] is not a valid term at this part of the query`)
  }
  return out.join(' | ')
}

function list<T>(map: Map<string, T>) {
  return Object.fromEntries([...map].map(([k, v]) => [k, v]))
}

const PASSWORD_RE = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/

function security(segs: string[], M: string, b: Src): Res {
  const kind = segs[0]
  const name = segs[1]
  const stores: Record<string, Map<string, Src>> = { internalusers: S.users, roles: S.roles, rolesmapping: S.mappings, actiongroups: S.groups, tenants: S.tenants }
  if (kind === 'account') return { status: 200, json: { user_name: 'admin', is_reserved: true, backend_roles: ['admin'], roles: ['all_access'], tenants: { global_tenant: true } } }
  const store = stores[kind]
  if (!store) throw fail(400, { error: `no handler found for uri [/_plugins/_security/api/${segs.join('/')}] and method [${M}]` })
  if (!name) return { status: 200, json: list(store) }
  const cur = store.get(name)
  if (M === 'GET') {
    if (!cur) throw sec(404, 'NOT_FOUND', `${kind === 'internalusers' ? 'user' : 'Resource'} '${name}' not found.`)
    return { status: 200, json: { [name]: cur } }
  }
  if (cur && (cur.static || (cur.reserved && kind !== 'rolesmapping'))) throw sec(403, 'FORBIDDEN', `Resource '${name}' is ${cur.static ? 'static' : 'reserved'}.`)
  if (M === 'DELETE') {
    if (!cur) throw sec(404, 'NOT_FOUND', `Resource '${name}' not found.`)
    store.delete(name)
    return { status: 200, json: { status: 'OK', message: `'${name}' deleted.` } }
  }
  if (kind === 'internalusers') {
    if (M === 'PATCH') {
      if (!cur) throw sec(404, 'NOT_FOUND', `user '${name}' not found.`)
      const next = { ...cur }
      for (const op of b as unknown as { op: string; path: string; value: unknown }[]) {
        const key = op.path.replace(/^\//, '')
        if (key === 'password') {
          if (!PASSWORD_RE.test(String(op.value))) throw fail(400, { status: 'error', reason: 'Weak password' })
        } else next[key] = op.value
      }
      store.set(name, next)
      return { status: 200, json: { status: 'OK', message: `'${name}' updated.` } }
    }
    const pw = String(b.password ?? '')
    if (!cur && !pw) throw fail(400, { status: 'error', reason: 'Please specify either "hash" or "password" when creating a new internal user.' })
    if (pw && pw.toLowerCase().includes(name.toLowerCase())) throw fail(400, { status: 'error', reason: 'Password is similar to user name' })
    if (pw && !PASSWORD_RE.test(pw)) throw fail(400, { status: 'error', reason: 'Weak password' })
    const { password: _pw, ...rest } = b
    void _pw
    store.set(name, { backend_roles: [], attributes: {}, opendistro_security_roles: [], ...rest, reserved: false, hidden: false, static: false })
    return { status: cur ? 200 : 201, json: { status: cur ? 'OK' : 'CREATED', message: `'${name}' ${cur ? 'updated' : 'created'}.` } }
  }
  if (kind === 'roles') {
    for (const p of (b.index_permissions as Src[] | undefined) ?? []) {
      if (typeof p.dls === 'string' && p.dls.trim()) {
        try {
          JSON.parse(p.dls)
        } catch {
          throw fail(400, { status: 'error', reason: 'Invalid DLS query' })
        }
      }
    }
  }
  store.set(name, { ...b, reserved: false, hidden: false, static: false })
  return { status: cur ? 200 : 201, json: { status: cur ? 'OK' : 'CREATED', message: `'${name}' ${cur ? 'updated' : 'created'}.` } }
}

function versionedRoute(map: Map<string, Versioned>, key: 'policy' | 'transform' | 'rollup', idField: string, name: string, M: string, q: URLSearchParams, b: Src): Res {
  const cur = map.get(name)
  const wrap = (v: Versioned) => ({ _id: name, _version: 1, _seq_no: v.seq, _primary_term: v.term, [key]: v.body })
  if (M === 'GET') {
    if (!cur) throw errDoc(404, 'status_exception', `${key === 'policy' ? 'Policy' : key === 'transform' ? 'Transform' : 'Rollup'} not found`)
    return { status: 200, json: wrap(cur) }
  }
  if (M === 'DELETE') {
    if (!cur) throw errDoc(404, 'status_exception', 'not found')
    map.delete(name)
    return { status: 200, json: { _id: name, result: 'deleted' } }
  }
  checkVersion(cur, q, name)
  const body = { ...((b[key] as Src) ?? {}), [idField]: name, schema_version: 31, last_updated_time: Date.now() }
  const v = versioned(body)
  map.set(name, v)
  return { status: cur ? 200 : 201, json: wrap(v) }
}

function route(method: string, rawPath: string, bodyText: string | null): Res | null {
  seed()
  const [pathPart, qs = ''] = rawPath.split('?')
  const q = new URLSearchParams(qs)
  const segs = pathPart.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  const M = method.toUpperCase()
  const b = () => parse(bodyText)
  const s0 = segs[0] ?? ''

  if (!segs.length && (M === 'GET' || M === 'HEAD')) {
    return {
      status: 200,
      json: {
        name: 'os-node-1',
        cluster_name: 'search-cluster',
        cluster_uuid: 'AN3liRcpSYeE95DOTZ6gRw',
        version: { distribution: 'opensearch', number: OS_DEMO_VERSION, build_type: 'tar', lucene_version: '10.5.1', minimum_wire_compatibility_version: '2.19.0', minimum_index_compatibility_version: '2.0.0' },
        tagline: 'The OpenSearch Project: https://opensearch.org/',
      },
    }
  }
  // X-Pack routes do not exist on OpenSearch (measured: 400 / 405)
  if (/^_(ilm|slm|security|enrich|watcher|transform)$/.test(s0) || (s0 === '_sql' && M === 'POST') || (s0 === '_query' && M === 'POST') || /^_(license|xpack)$/.test(s0)) {
    throw fail(400, { error: `no handler found for uri [${pathPart}] and method [${M}]` })
  }
  if (/^\{?[^_]/.test(s0) && segs[1] === '_ilm') throw fail(400, { error: `no handler found for uri [${pathPart}] and method [${M}]` })
  // `GET _ingest/pipeline` is 404 {} while there is none (measured O15)
  if (s0 === '_ingest' && segs[1] === 'pipeline' && segs.length === 2 && M === 'GET') {
    const r = es('GET', '/_ingest/pipeline')
    if (r.status === 200 && r.json && !Object.keys(r.json as Src).length) return { status: 404, json: {} }
    return r
  }
  if (s0 !== '_plugins') return null
  const p = segs[1]

  if (p === '_sql') {
    if (segs[2] === 'close') return { status: 200, json: { succeeded: true } }
    const body = b()
    if (segs[2] === '_explain') return { status: 200, json: { root: { name: 'ProjectOperator', description: { fields: '[…]' }, children: [{ name: 'OpenSearchIndexScan', description: { request: `OpenSearchQueryRequest(query=${String(body.query ?? '')})` }, children: [] }] } } }
    if (body.cursor) return { status: 200, json: { schema: [], datarows: [], total: 0, size: 0, status: 200 } }
    const query = String(body.query ?? '').trim()
    if (!/^(select|show|describe|delete)\b/i.test(query)) throw fail(400, { error: { reason: 'Invalid SQL query', details: `Query must start with SELECT, DELETE, SHOW or DESCRIBE: ${query}`, type: 'SQLFeatureNotSupportedException' }, status: 400 })
    const sql = query.replace(/^show\s+tables\s+like\s+.*/i, 'SHOW TABLES').replace(/^describe\s+tables\s+like\s+(\S+).*/i, 'DESCRIBE "$1"').replace(/`/g, '"')
    const r = es('POST', '/_sql?format=json', { query: sql })
    if (r.status !== 200) return r
    return { status: 200, json: toJdbc(r.json as Src) }
  }
  if (p === '_ppl') {
    const body = b()
    const esql = pplToEsql(String(body.query ?? ''))
    if (segs[2] === '_explain') return { status: 200, json: { calcite: { logical: esql, physical: `CalciteEnumerableIndexScan(${esql})` } } }
    const r = es('POST', '/_query?format=json', { query: esql })
    if (r.status !== 200) {
      const reason = ((r.json as Src)?.error as Src)?.reason ?? 'query failed'
      throw fail(400, { error: { reason: String(reason), details: String(reason), type: 'SemanticCheckException' }, status: 400 })
    }
    return { status: 200, json: toJdbc(r.json as Src) }
  }
  if (p === '_ism') {
    const op = segs[2]
    if (op === 'policies') {
      if (!segs[3]) return { status: 200, json: { policies: [...S.ism].map(([id, v]) => ({ _id: id, _seq_no: v.seq, _primary_term: v.term, policy: v.body })), total_policies: S.ism.size } }
      return versionedRoute(S.ism, 'policy', 'policy_id', segs[3], M, q, b())
    }
    const index = segs[3] ?? ''
    if (op === 'explain') {
      const m = S.managed.get(index)
      if (!m) return { status: 200, json: { [index]: { 'index.plugins.index_state_management.policy_id': null, enabled: null }, total_managed_indices: 0 } }
      // ISM records the attachment ~1–2 s later and starts on its next run (measured)
      const started = Date.now() - m.at > 1000
      return { status: 200, json: { [index]: { 'index.plugins.index_state_management.policy_id': m.policy, index, policy_id: m.policy, enabled: true, ...(started ? { state: { name: 'hot', start_time: m.at }, action: { name: 'rollover', start_time: m.at, failed: false }, info: { message: 'Successfully initialized policy: ' + m.policy } } : {}) }, total_managed_indices: 1 } }
    }
    if (op === 'add' || op === 'change_policy') {
      const pol = String(b().policy_id ?? '')
      if (!S.ism.has(pol)) return { status: 200, json: { updated_indices: 0, failures: true, failed_indices: [{ index_name: index, reason: `Policy ${pol} does not exist` }] } }
      S.managed.set(index, { policy: pol, at: Date.now() })
      return { status: 200, json: { updated_indices: 1, failures: false, failed_indices: [] } }
    }
    if (op === 'remove') {
      S.managed.delete(index)
      return { status: 200, json: { updated_indices: 1, failures: false, failed_indices: [] } }
    }
    if (op === 'retry') return { status: 200, json: { updated_indices: 0, failures: true, failed_indices: [{ index_name: index, reason: 'This index has no metadata information' }] } }
  }
  if (p === '_sm' && segs[2] === 'policies') {
    const name = segs[3]
    if (!name) return { status: 200, json: { policies: [...S.sm].map(([n, v]) => ({ _id: `${n}-sm-policy`, _seq_no: v.seq, _primary_term: v.term, sm_policy: v.body })), total_policies: S.sm.size } }
    const action = segs[4]
    if (action === '_explain') return { status: 200, json: { policies: [{ name, enabled: S.sm.get(name)?.body.enabled !== false }] } }
    if (action === '_start' || action === '_stop') {
      const v = S.sm.get(name)
      if (v) v.body = { ...v.body, enabled: action === '_start' }
      return { status: 200, json: { acknowledged: true } }
    }
    const cur = S.sm.get(name)
    if (M === 'GET') {
      if (!cur) throw errDoc(404, 'status_exception', 'Snapshot management policy not found')
      return { status: 200, json: { _id: `${name}-sm-policy`, _seq_no: cur.seq, _primary_term: cur.term, sm_policy: cur.body } }
    }
    if (M === 'DELETE') {
      S.sm.delete(name)
      return { status: 200, json: { _id: `${name}-sm-policy`, result: 'deleted' } }
    }
    if (M === 'POST' && cur) throw errDoc(409, 'version_conflict_engine_exception', `[${name}-sm-policy]: version conflict, document already exists`)
    if (M === 'PUT') checkVersion(cur, q, name, true)
    const v = versioned({ ...b(), name, enabled: true, schema_version: 31 })
    S.sm.set(name, v)
    return { status: 201, json: { _id: `${name}-sm-policy`, _seq_no: v.seq, _primary_term: v.term, sm_policy: v.body } }
  }
  if (p === '_transform') {
    const id = segs[2]
    if (!id) return { status: 200, json: { total_transforms: S.transforms.size, transforms: [...S.transforms].map(([n, v]) => ({ _id: n, _seq_no: v.seq, _primary_term: v.term, transform: v.body })) } }
    if (id === '_preview') return { status: 200, json: { documents: [{ _doc_count: 3, key: 'preview' }] } }
    if (segs[3] === '_explain') return { status: 200, json: { [id]: { metadata_id: null, transform_metadata: null } } }
    if (segs[3] === '_start' || segs[3] === '_stop') return { status: 200, json: { acknowledged: true } }
    return versionedRoute(S.transforms, 'transform', 'transform_id', id, M, q, b())
  }
  if (p === '_rollup' && segs[2] === 'jobs') {
    const id = segs[3]
    if (!id) return { status: 200, json: { total_rollups: S.rollups.size, rollups: [...S.rollups].map(([n, v]) => ({ _id: n, _seq_no: v.seq, _primary_term: v.term, rollup: v.body })) } }
    if (segs[4] === '_explain') return { status: 200, json: { [id]: { metadata_id: null, rollup_metadata: null } } }
    if (segs[4] === '_start' || segs[4] === '_stop') return { status: 200, json: { acknowledged: true } }
    return versionedRoute(S.rollups, 'rollup', 'rollup_id', id, M, q, b())
  }
  if (p === '_alerting' && segs[2] === 'monitors') {
    const id = segs[3]
    if (id === '_search')
      return { status: 200, json: { hits: { total: { value: S.monitors.size, relation: 'eq' }, hits: [...S.monitors].map(([mid, v]) => ({ _index: '.opendistro-alerting-config', _id: mid, _source: v.body })) } } }
    if (id === 'alerts') return { status: 200, json: { alerts: [], totalAlerts: 0 } }
    if (!id && M === 'POST') {
      const mid = `mon-${(++seqN).toString(36)}`
      const v = versioned({ ...b(), schema_version: 9 })
      S.monitors.set(mid, v)
      return { status: 201, json: { _id: mid, _version: 1, _seq_no: v.seq, _primary_term: v.term, monitor: v.body } }
    }
    const cur = id ? S.monitors.get(id) : undefined
    if (segs[4] === '_execute') return { status: 200, json: { monitor_name: cur?.body.name, error: null, input_results: { results: [{ hits: { total: { value: 2, relation: 'eq' } } }] }, trigger_results: {} } }
    if (!cur) throw errDoc(404, 'status_exception', 'Monitor not found.')
    if (M === 'GET') return { status: 200, json: { _id: id, _version: 1, _seq_no: cur.seq, _primary_term: cur.term, monitor: cur.body } }
    if (M === 'DELETE') {
      S.monitors.delete(id!)
      return { status: 200, json: { _id: id, result: 'deleted' } }
    }
    const v = versioned({ ...b(), schema_version: 9 })
    S.monitors.set(id!, v)
    return { status: 200, json: { _id: id, _seq_no: v.seq, _primary_term: v.term, monitor: v.body } }
  }
  if (p === '_security') {
    if (segs[2] === 'authinfo') return { status: 200, json: { user_name: 'admin', backend_roles: ['admin'], roles: ['all_access'] } }
    if (segs[2] === 'api') return security(segs.slice(3), M, M === 'GET' || M === 'DELETE' ? {} : b())
  }
  if (p === '_knn' && segs[2] === 'stats') return { status: 200, json: { _nodes: { total: 1, successful: 1, failed: 0 }, circuit_breaker_triggered: false } }
  throw fail(400, { error: `no handler found for uri [${pathPart}] and method [${M}]` })
}

/** Answer an es_* command for the OpenSearch demo connection, or undefined to use the shared demo. */
export function osDemo(cmd: string, args: Record<string, unknown>): unknown {
  if (cmd === 'es_server_info') return { flavor: 'opensearch', version: OS_DEMO_VERSION, label: `OpenSearch ${OS_DEMO_VERSION}` }
  if (cmd === 'es_overview') {
    const o = esDemo('es_overview', args) as EsOverview
    return { ...o, info: { ...o.info, name: 'os-node-1', cluster_name: 'search-cluster', version: OS_DEMO_VERSION, distribution: 'opensearch', lucene_version: '10.5.1', build_flavor: '', tagline: 'The OpenSearch Project: https://opensearch.org/' } }
  }
  if (cmd !== 'es_request') return undefined
  const started = performance.now()
  let r: Res | null
  try {
    r = route(String(args.method ?? 'GET'), String(args.path ?? '/'), (args.body as string | null) ?? null)
  } catch (e) {
    if (e instanceof OsErr) r = { status: e.status, json: e.body }
    else throw e
  }
  if (!r) return undefined
  const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '')
  const res: EsResponse = {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    json: r.json ?? null,
    text: r.text ?? null,
    took_ms: Math.max(1, Math.round(performance.now() - started)),
    content_type: r.text ? 'text/plain; charset=UTF-8' : 'application/json',
    warnings: [],
    bytes: text.length,
  }
  return res
}
