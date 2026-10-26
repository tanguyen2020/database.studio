// Typed helpers over the generic REST call (ipc.esRequest). Every screen of the
// Elasticsearch workspace goes through here, so the request shapes live in ONE
// place — the integration test (src-tauri/tests/elasticsearch_integration.rs)
// sends exactly these paths/bodies to a real cluster.

import * as ipc from '$lib/ipc'
import { searchProduct } from './flavor'

/** An HTTP error from the cluster, with the readable message Kibana would show. */
export class EsError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message)
  }
}

/** `type: reason` from an Elasticsearch error document (+ the common cases). */
export function describeEsError(status: number, body: unknown, product = 'Elasticsearch'): string {
  const err = (body as { error?: unknown } | null)?.error
  let type = ''
  let reason = ''
  if (err && typeof err === 'object') {
    const e = err as { type?: string; reason?: string; details?: string; root_cause?: { reason?: string }[]; index?: string }
    type = e.type ?? ''
    reason = e.reason ?? e.root_cause?.[0]?.reason ?? ''
    // OpenSearch SQL / PPL keep `reason` generic and put the cause in `details` (SPEC-OPENSEARCH.md O6)
    const details = e.details?.trim()
    if (details && details !== reason) reason = reason ? `${reason} — ${details}` : details
    if (status === 404 && type === 'index_not_found_exception') {
      return `Index${e.index ? ` '${e.index}'` : ''} not found`
    }
  } else if (typeof err === 'string') {
    reason = err
  } else if (body && typeof body === 'object' && (typeof (body as { reason?: unknown }).reason === 'string' || typeof (body as { message?: unknown }).message === 'string')) {
    // OpenSearch security REST API: {"status":"error","reason":"Weak password"} /
    // {"status":"FORBIDDEN","message":"Resource 'admin' is reserved."} (SPEC-OPENSEARCH.md O16)
    const b = body as { reason?: string; message?: string }
    reason = b.reason ?? b.message ?? ''
  } else if (typeof body === 'string') {
    reason = body.slice(0, 300)
  }
  if (status === 401) return 'Authentication failed — check the user and password (or the API key)'
  if (status === 403) return `Not allowed — ${reason || 'the user lacks the privilege for this action'}`
  if (!type && !reason) return `${product} ${status}`
  return type ? `${type}: ${reason}` : `${product} ${status}: ${reason}`
}

/** Encode one path segment (index / template / user names). `*` and `,` stay
 *  readable because they are meaningful in index patterns. */
export function seg(s: string): string {
  return encodeURIComponent(s).replace(/%2A/g, '*').replace(/%2C/g, ',')
}

/** Call and return the JSON body; a non-2xx answer throws an EsError. */
export async function es<T = unknown>(connId: string, method: string, path: string, body?: unknown): Promise<T> {
  const text = body === undefined || body === null ? null : typeof body === 'string' ? body : JSON.stringify(body)
  const r = await ipc.esRequest(connId, method, path, text)
  if (!r.ok) {
    const b = r.json ?? r.text
    throw new EsError(describeEsError(r.status, b, searchProduct(connId).name), r.status, b)
  }
  return (r.json ?? (r.text as unknown)) as T
}

/** NDJSON body (bulk / msearch) from a list of objects. */
export function ndjson(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

// ---- search -------------------------------------------------------------

export interface EsHit {
  _index: string
  _id: string
  _score: number | null
  _source?: Record<string, unknown>
  fields?: Record<string, unknown[]>
  highlight?: Record<string, string[]>
  sort?: unknown[]
  _version?: number
  _seq_no?: number
  _primary_term?: number
}

export interface EsSearchResult {
  took: number
  timed_out: boolean
  hits: { total?: { value: number; relation: 'eq' | 'gte' } | number; max_score: number | null; hits: EsHit[] }
  aggregations?: Record<string, unknown>
  _shards?: { total: number; successful: number; failed: number; skipped?: number }
}

export const search = (connId: string, index: string, body: unknown) =>
  es<EsSearchResult>(connId, 'POST', `/${seg(index)}/_search`, body)

export function totalOf(r: EsSearchResult): { value: number; exact: boolean } {
  const t = r.hits.total
  if (typeof t === 'number') return { value: t, exact: true }
  if (!t) return { value: r.hits.hits.length, exact: false }
  return { value: t.value, exact: t.relation === 'eq' }
}

// ---- documents -----------------------------------------------------------

export const getDoc = (connId: string, index: string, id: string) =>
  es<{ _id: string; _index: string; _version: number; _source: Record<string, unknown>; found: boolean }>(
    connId,
    'GET',
    `/${seg(index)}/_doc/${seg(id)}`,
  )

/** Create (POST, auto id) or replace (PUT) a document; waits for refresh so the
 *  next search sees it. */
export const saveDoc = (connId: string, index: string, id: string | null, source: unknown) =>
  id
    ? es<{ _id: string; result: string }>(connId, 'PUT', `/${seg(index)}/_doc/${seg(id)}?refresh=wait_for`, source)
    : es<{ _id: string; result: string }>(connId, 'POST', `/${seg(index)}/_doc?refresh=wait_for`, source)

export const deleteDoc = (connId: string, index: string, id: string) =>
  es(connId, 'DELETE', `/${seg(index)}/_doc/${seg(id)}?refresh=wait_for`)

// ---- index management ----------------------------------------------------

export interface MappingProps {
  [field: string]: { type?: string; properties?: MappingProps; fields?: MappingProps; [k: string]: unknown }
}

export async function getMapping(connId: string, index: string): Promise<{ properties: MappingProps; raw: unknown }> {
  const r = await es<Record<string, { mappings?: { properties?: MappingProps } }>>(connId, 'GET', `/${seg(index)}/_mapping`)
  // a pattern / alias may resolve to several indices: merge their fields
  const properties: MappingProps = {}
  for (const v of Object.values(r ?? {})) Object.assign(properties, v.mappings?.properties ?? {})
  return { properties, raw: r }
}

export const putMapping = (connId: string, index: string, body: unknown) =>
  es(connId, 'PUT', `/${seg(index)}/_mapping`, body)

export async function getSettings(connId: string, index: string): Promise<Record<string, string>> {
  const r = await es<Record<string, { settings: Record<string, string> }>>(
    connId,
    'GET',
    `/${seg(index)}/_settings?flat_settings=true`,
  )
  return Object.values(r ?? {})[0]?.settings ?? {}
}

export const putSettings = (connId: string, index: string, body: unknown) =>
  es(connId, 'PUT', `/${seg(index)}/_settings`, body)

export const createIndex = (connId: string, index: string, body: unknown) => es(connId, 'PUT', `/${seg(index)}`, body)
export const deleteIndex = (connId: string, index: string) => es(connId, 'DELETE', `/${seg(index)}`)

export type IndexAction = 'refresh' | 'flush' | 'forcemerge' | 'clear-cache' | 'open' | 'close'

export function indexActionPath(index: string, a: IndexAction): string {
  const i = `/${seg(index)}`
  switch (a) {
    case 'refresh':
      return `${i}/_refresh`
    case 'flush':
      return `${i}/_flush`
    case 'forcemerge':
      return `${i}/_forcemerge?max_num_segments=1`
    case 'clear-cache':
      return `${i}/_cache/clear`
    case 'open':
      return `${i}/_open?wait_for_active_shards=1`
    case 'close':
      return `${i}/_close`
  }
}

export const indexAction = (connId: string, index: string, a: IndexAction) =>
  es(connId, 'POST', indexActionPath(index, a))

export interface AliasEntry {
  alias: string
  index: string
  is_write_index?: boolean
  filter?: unknown
}

export async function aliases(connId: string): Promise<AliasEntry[]> {
  const r = await es<Record<string, { aliases: Record<string, { is_write_index?: boolean; filter?: unknown }> }>>(
    connId,
    'GET',
    '/_alias',
  )
  const out: AliasEntry[] = []
  for (const [index, v] of Object.entries(r ?? {})) {
    for (const [alias, a] of Object.entries(v.aliases ?? {})) out.push({ alias, index, ...a })
  }
  return out.sort((a, b) => a.alias.localeCompare(b.alias) || a.index.localeCompare(b.index))
}

export const addAlias = (connId: string, index: string, alias: string, extra: Record<string, unknown> = {}) =>
  es(connId, 'POST', '/_aliases', { actions: [{ add: { index, alias, ...extra } }] })

export const removeAlias = (connId: string, index: string, alias: string) =>
  es(connId, 'POST', '/_aliases', { actions: [{ remove: { index, alias } }] })

export interface IndexStats {
  docs: number
  deleted: number
  storeBytes: number
  segments: number
  indexTotal: number
  indexTimeMs: number
  searchTotal: number
  searchTimeMs: number
  getTotal: number
  refreshTotal: number
  flushTotal: number
  mergesTotal: number
}

export async function indexStats(connId: string, index: string): Promise<IndexStats> {
  type T = { _all?: { primaries?: Record<string, Record<string, number>>; total?: Record<string, Record<string, number>> } }
  const r = await es<T>(connId, 'GET', `/${seg(index)}/_stats`)
  const p = r._all?.primaries ?? {}
  const t = r._all?.total ?? {}
  const n = (o: Record<string, Record<string, number>>, a: string, b: string) => Number(o?.[a]?.[b] ?? 0)
  return {
    docs: n(p, 'docs', 'count'),
    deleted: n(p, 'docs', 'deleted'),
    storeBytes: n(t, 'store', 'size_in_bytes'),
    segments: n(t, 'segments', 'count'),
    indexTotal: n(t, 'indexing', 'index_total'),
    indexTimeMs: n(t, 'indexing', 'index_time_in_millis'),
    searchTotal: n(t, 'search', 'query_total'),
    searchTimeMs: n(t, 'search', 'query_time_in_millis'),
    getTotal: n(t, 'get', 'total'),
    refreshTotal: n(t, 'refresh', 'total'),
    flushTotal: n(t, 'flush', 'total'),
    mergesTotal: n(t, 'merges', 'total'),
  }
}

// ---- SQL / ES|QL -------------------------------------------------------------

export interface TabularResult {
  cols: [string, string][]
  rows: Record<string, unknown>[]
  cursor?: string
}

function tabular(v: { columns?: { name: string; type: string }[]; rows?: unknown[][]; values?: unknown[][]; cursor?: string }): TabularResult {
  const cols = (v.columns ?? []).map((c) => [c.name, c.type] as [string, string])
  const raw = v.rows ?? v.values ?? []
  const rows = raw.map((r) => Object.fromEntries(cols.map(([n], i) => [n, r[i] ?? null])))
  return { cols, rows, cursor: v.cursor }
}

export async function sqlQuery(connId: string, query: string, fetchSize = 500): Promise<TabularResult> {
  return tabular(await es(connId, 'POST', '/_sql?format=json', { query, fetch_size: fetchSize }))
}

export async function sqlNext(connId: string, cursor: string, cols: [string, string][]): Promise<TabularResult> {
  const r = tabular(await es(connId, 'POST', '/_sql?format=json', { cursor }))
  return { ...r, cols } // continuation pages carry no columns
}

export const sqlTranslate = (connId: string, query: string) => es(connId, 'POST', '/_sql/translate', { query })

export async function esqlQuery(connId: string, query: string): Promise<TabularResult> {
  return tabular(await es(connId, 'POST', '/_query?format=json', { query }))
}

// ---- OpenSearch SQL / PPL plugins (SPEC-OPENSEARCH.md O3–O5) --------------------

/** `format=jdbc` answer: `{schema:[{name,type}], datarows:[[…]], cursor}`. */
export function jdbcTabular(v: { schema?: { name: string; type: string }[]; datarows?: unknown[][]; cursor?: string }): TabularResult {
  const cols = (v.schema ?? []).map((c) => [c.name, c.type] as [string, string])
  const rows = (v.datarows ?? []).map((r) => Object.fromEntries(cols.map(([n], i) => [n, r[i] ?? null])))
  return { cols, rows, cursor: v.cursor || undefined }
}

export async function osSqlQuery(connId: string, query: string, fetchSize = 500): Promise<TabularResult> {
  return jdbcTabular(await es(connId, 'POST', '/_plugins/_sql?format=jdbc', { query, fetch_size: fetchSize }))
}

export async function osSqlNext(connId: string, cursor: string, cols: [string, string][]): Promise<TabularResult> {
  const r = jdbcTabular(await es(connId, 'POST', '/_plugins/_sql?format=jdbc', { cursor }))
  return { ...r, cols: r.cols.length ? r.cols : cols }
}

export const osSqlExplain = (connId: string, query: string) => es(connId, 'POST', '/_plugins/_sql/_explain', { query })

export async function pplQuery(connId: string, query: string): Promise<TabularResult> {
  return jdbcTabular(await es(connId, 'POST', '/_plugins/_ppl', { query }))
}

export const pplExplain = (connId: string, query: string) => es(connId, 'POST', '/_plugins/_ppl/_explain', { query })
