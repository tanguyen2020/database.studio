import { describe, expect, it, beforeEach } from 'vitest'
import { buildQuery, filterLabel, kqlToDsl, KqlError, luceneToDsl } from './kql'
import { bodyToWire, formatBody, isNdjsonPath, normalizePath, parseConsole, requestAt, splitJsonDocs, toCurl } from './console'
import { fieldTypeToken, flattenSource, fmtCompact, getPath, indexNameError, pickInterval, timeRange } from './format'
import { describeEsError, seg } from './api'
import { esDemo, resetEsDemo } from './demo'
import { RESOURCE_KINDS } from './resources'
import type { EsResponse } from '$lib/ipc'

describe('KQL → Query DSL', () => {
  it('empty query matches everything', () => {
    expect(kqlToDsl('')).toEqual({ match_all: {} })
    expect(kqlToDsl('   ')).toEqual({ match_all: {} })
  })
  it('field match, phrase, wildcard, exists, range', () => {
    expect(kqlToDsl('status:paid')).toEqual({ match: { status: 'paid' } })
    expect(kqlToDsl('amount:42')).toEqual({ match: { amount: 42 } })
    expect(kqlToDsl('customer:"Ada Lovelace"')).toEqual({ match_phrase: { customer: 'Ada Lovelace' } })
    expect(kqlToDsl('host:web-*')).toEqual({ wildcard: { host: { value: 'web-*', case_insensitive: true } } })
    expect(kqlToDsl('tags:*')).toEqual({ exists: { field: 'tags' } })
    expect(kqlToDsl('amount >= 100')).toEqual({ range: { amount: { gte: 100 } } })
    expect(kqlToDsl('@timestamp < "2026-01-01"')).toEqual({ range: { '@timestamp': { lt: '2026-01-01' } } })
  })
  it('boolean logic with precedence (and binds tighter than or)', () => {
    expect(kqlToDsl('a:1 or b:2 and c:3')).toEqual({
      bool: { should: [{ match: { a: 1 } }, { bool: { filter: [{ match: { b: 2 } }, { match: { c: 3 } }] } }], minimum_should_match: 1 },
    })
    expect(kqlToDsl('not status:paid')).toEqual({ bool: { must_not: [{ match: { status: 'paid' } }] } })
    expect(kqlToDsl('(a:1 or a:2) and b:3')).toEqual({
      bool: { filter: [{ bool: { should: [{ match: { a: 1 } }, { match: { a: 2 } }], minimum_should_match: 1 } }, { match: { b: 3 } }] },
    })
    // adjacency = AND
    expect(kqlToDsl('status:paid category:Books')).toEqual({ bool: { filter: [{ match: { status: 'paid' } }, { match: { category: 'Books' } }] } })
  })
  it('value lists', () => {
    expect(kqlToDsl('status:(paid or pending)')).toEqual({
      bool: { should: [{ match: { status: 'paid' } }, { match: { status: 'pending' } }], minimum_should_match: 1 },
    })
  })
  it('free text', () => {
    expect(kqlToDsl('timeout')).toEqual({ multi_match: { query: 'timeout', type: 'best_fields', lenient: true } })
    expect(kqlToDsl('"upstream timed out"')).toEqual({ multi_match: { query: 'upstream timed out', type: 'phrase', lenient: true } })
    expect(kqlToDsl('time*')).toEqual({ query_string: { query: 'time*', analyze_wildcard: true } })
  })
  it('reports syntax errors with a position', () => {
    expect(() => kqlToDsl('status:')).toThrow(KqlError)
    expect(() => kqlToDsl('(a:1')).toThrow("Missing ')'")
    expect(() => kqlToDsl('"open')).toThrow('Unterminated')
    try {
      kqlToDsl('a:1 and )')
    } catch (e) {
      expect((e as KqlError).pos).toBe(8)
    }
  })
  it('lucene goes through query_string', () => {
    expect(luceneToDsl('status:paid AND amount:[10 TO 20]')).toEqual({
      query_string: { query: 'status:paid AND amount:[10 TO 20]', analyze_wildcard: true },
    })
    expect(luceneToDsl('')).toEqual({ match_all: {} })
  })
  it('combines query bar, filter pills and time range', () => {
    const q = buildQuery({
      text: 'status:paid',
      language: 'kql',
      filters: [
        { field: 'category', op: 'is', value: 'Books' },
        { field: 'geo.country', op: 'is not', value: 'US' },
        { field: 'email', op: 'exists', disabled: true },
      ],
      timeField: '@timestamp',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-15T00:00:00.000Z',
    })
    expect(q).toEqual({
      bool: {
        filter: [
          { match: { status: 'paid' } },
          { match_phrase: { category: 'Books' } },
          { range: { '@timestamp': { format: 'strict_date_optional_time', gte: '2026-10-01T00:00:00.000Z', lte: '2026-10-15T00:00:00.000Z' } } },
        ],
        must_not: [{ match_phrase: { 'geo.country': 'US' } }],
      },
    })
    expect(buildQuery({ text: '', language: 'kql' })).toEqual({ match_all: {} })
    expect(filterLabel({ field: 'a', op: 'is one of', values: ['x', 'y'] })).toBe('a: is one of x, y')
  })
})

describe('Dev Tools console', () => {
  const text = `# list indices
GET _cat/indices?v

GET /orders/_search
{
  "query": { "match": { "status": "paid" } }
}

// bulk
POST _bulk
{ "index": { "_index": "orders" } }
{ "status": "paid",
  "amount": 1 }
`
  it('splits requests with line ranges', () => {
    const r = parseConsole(text)
    expect(r.map((x) => [x.method, x.path, x.startLine, x.endLine])).toEqual([
      ['GET', '_cat/indices?v', 2, 2],
      ['GET', '/orders/_search', 4, 7],
      ['POST', '_bulk', 10, 13],
    ])
    expect(r[1].body).toContain('"match"')
    expect(requestAt(r, 6)?.path).toBe('/orders/_search')
    expect(requestAt(r, 8)?.path).toBe('/orders/_search') // between requests → the one above
    expect(requestAt(r, 1)).toBeNull()
  })
  it('compacts JSON bodies and turns bulk bodies into NDJSON', () => {
    const r = parseConsole(text)
    expect(bodyToWire(r[1].path, r[1].body)).toEqual({ wire: '{"query":{"match":{"status":"paid"}}}' })
    expect(bodyToWire(r[2].path, r[2].body).wire).toBe('{"index":{"_index":"orders"}}\n{"status":"paid","amount":1}\n')
    expect(bodyToWire('/x/_search', '{ bad').error).toBeTruthy()
    expect(bodyToWire('/x', '')).toEqual({ wire: null })
    expect(isNdjsonPath('/idx/_msearch/template')).toBe(true)
    expect(isNdjsonPath('/bulk_orders/_search')).toBe(false)
  })
  it('triple-quoted strings become JSON strings', () => {
    const w = bodyToWire('/_scripts/x', '{ "script": { "source": """\nctx._source.a = 1;\n""" } }')
    expect(JSON.parse(w.wire!)).toEqual({ script: { source: '\nctx._source.a = 1;\n' } })
  })
  it('auto-indent, split docs, curl', () => {
    expect(formatBody('/x/_search', '{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(splitJsonDocs('{"a":"}"} [1,2]')).toEqual(['{"a":"}"}', '[1,2]'])
    expect(splitJsonDocs('{"a":1')).toBeNull()
    expect(normalizePath('_cat/indices')).toBe('/_cat/indices')
    const c = toCurl({ method: 'POST', path: '_search', body: '{"q":"it\'s"}', startLine: 1, endLine: 1 }, 'http://h:9200/')
    expect(c).toContain('curl -XPOST "http://h:9200/_search"')
    expect(c).toContain(`-d '{"q":"it'\\''s"}'`)
  })
  it('a method word inside a body is not a new request', () => {
    const r = parseConsole('POST x/_doc\n{\n  "verb": "GET"\n}\n')
    expect(r).toHaveLength(1)
  })
})

describe('format helpers', () => {
  it('formats', () => {
    expect(fmtCompact(999)).toBe('999')
    expect(fmtCompact(1234)).toBe('1.2K')
    expect(fmtCompact(2_500_000)).toBe('2.5M')
    expect(fieldTypeToken('keyword').label).toBe('k')
    expect(fieldTypeToken('long').label).toBe('#')
    expect(fieldTypeToken('date').label).toBe('◷')
    expect(flattenSource({ a: { b: 1, c: [1, 2] }, d: null })).toEqual({ 'a.b': 1, 'a.c': [1, 2], d: null })
    expect(getPath({ a: { b: 2 } }, 'a.b')).toBe(2)
    expect(getPath({ 'log.level': 'x' }, 'log.level')).toBe('x')
    expect(pickInterval(24 * 3600_000)).toBe('30m')
    expect(pickInterval(30 * 86_400_000)).toBe('12h')
    const t = timeRange('24h', Date.parse('2026-10-15T00:00:00Z'))
    expect(t.from).toBe('2026-10-14T00:00:00.000Z')
    expect(timeRange('all')).toEqual({ from: null, to: null })
    expect(indexNameError('Orders')).toMatch(/lowercase/)
    expect(indexNameError('a b')).toMatch(/spaces/)
    expect(indexNameError('_x')).toMatch(/cannot start/)
    expect(indexNameError('logs-2026.10')).toBeNull()
    expect(seg('logs-*')).toBe('logs-*')
    expect(seg('a/b')).toBe('a%2Fb')
    expect(describeEsError(404, { error: { type: 'index_not_found_exception', reason: 'no such index [x]', index: 'x' } })).toBe("Index 'x' not found")
    expect(describeEsError(400, { error: { type: 'parsing_exception', reason: 'bad' } })).toBe('parsing_exception: bad')
    expect(describeEsError(401, {})).toMatch(/Authentication failed/)
  })
})

describe('in-memory cluster (demo)', () => {
  beforeEach(() => resetEsDemo())
  const call = (method: string, path: string, body?: unknown) =>
    esDemo('es_request', { method, path, body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body) }) as EsResponse
  const j = (r: EsResponse) => r.json as Record<string, any>

  it('searches with the DSL the UI builds, sorts, pages and aggregates', () => {
    const q = buildQuery({ text: 'status:paid', language: 'kql' })
    const r = call('POST', '/orders/_search', { query: q, size: 5, sort: [{ amount: 'desc' }], track_total_hits: true, aggs: { s: { terms: { field: 'status' } } } })
    expect(r.ok).toBe(true)
    const hits = j(r).hits.hits
    expect(hits).toHaveLength(5)
    expect(hits.every((h: any) => h._source.status === 'paid')).toBe(true)
    const amounts = hits.map((h: any) => h._source.amount)
    expect([...amounts].sort((a: number, b: number) => b - a)).toEqual(amounts)
    const total = j(r).hits.total.value
    const buckets = j(r).aggregations.s.buckets
    expect(buckets).toEqual([{ key: 'paid', doc_count: total }])
    const all = j(call('POST', '/orders/_count', {})).count
    expect(all).toBe(240)
  })
  it('document CRUD round trip + dynamic mapping', () => {
    const c = call('POST', '/orders/_doc?refresh=wait_for', { status: 'paid', note_new: 'hi' })
    expect(c.status).toBe(201)
    const id = j(c)._id
    expect(j(call('GET', `/orders/_doc/${id}`))._source.note_new).toBe('hi')
    expect((esDemo('es_mapping_fields', { index: 'orders' }) as [string, string][]).some(([f]) => f === 'note_new')).toBe(true)
    call('PUT', `/orders/_doc/${id}`, { status: 'refunded' })
    expect(j(call('GET', `/orders/_doc/${id}`))._version).toBe(2)
    expect(call('DELETE', `/orders/_doc/${id}`).ok).toBe(true)
    expect(call('GET', `/orders/_doc/${id}`).status).toBe(404)
  })
  it('index lifecycle: create, close (search refused), open, delete; errors are ES-shaped', () => {
    expect(call('PUT', '/tmp-1', { settings: { number_of_replicas: 0 }, mappings: { properties: { a: { type: 'keyword' } } } }).ok).toBe(true)
    expect(j(call('PUT', '/tmp-1', {})).error.type).toBe('resource_already_exists_exception')
    expect(call('POST', '/tmp-1/_close').ok).toBe(true)
    expect(call('POST', '/tmp-1/_search', {}).status).toBe(400)
    expect(call('POST', '/tmp-1/_open').ok).toBe(true)
    expect(call('DELETE', '/tmp-1').ok).toBe(true)
    expect(j(call('GET', '/tmp-1/_search')).error.type).toBe('index_not_found_exception')
    expect(call('PUT', '/orders/_mapping', { properties: { status: { type: 'long' } } }).status).toBe(400)
    expect(call('GET', '/orders/_nothing').status).toBe(400)
    expect(call('GET', '/nope/_search').status).toBe(404)
  })
  it('bulk NDJSON, _cat text, SQL and ES|QL', () => {
    const r = call('POST', '/_bulk', '{"index":{"_index":"b1","_id":"1"}}\n{"n":1}\n{"index":{"_index":"b1"}}\n{"n":2}\n')
    expect(j(r).errors).toBe(false)
    expect(j(call('POST', '/b1/_count', {})).count).toBe(2)
    const cat = call('GET', '/_cat/indices?v')
    expect(cat.json).toBeNull()
    expect(cat.text).toContain('health')
    const sql = j(call('POST', '/_sql?format=json', { query: 'SELECT status, COUNT(*) AS n FROM orders GROUP BY status' }))
    expect(sql.columns.map((c: any) => c.name)).toEqual(['status', 'n'])
    expect(sql.rows.reduce((s: number, r: any[]) => s + r[1], 0)).toBe(240)
    const esql = j(call('POST', '/_query?format=json', { query: 'FROM orders | STATS n = COUNT(*) BY status | SORT n DESC | LIMIT 2' }))
    expect(esql.values).toHaveLength(2)
    expect(call('POST', '/_sql?format=json', { query: 'SELEC x' }).status).toBe(400)
  })
  it('templates, pipelines (+simulate), ILM, data streams, snapshots, security', () => {
    for (const k of RESOURCE_KINDS) {
      const r = call('GET', k.listPath)
      expect(r.ok, k.key).toBe(true)
      expect(Array.isArray(k.parseList(r.json))).toBe(true)
    }
    const sim = j(call('POST', '/_ingest/pipeline/orders-enrich/_simulate', { docs: [{ _source: { status: 'PAID' } }] }))
    expect(sim.docs[0].doc._source.status).toBe('paid')
    expect(call('PUT', '/_data_stream/nomatch').status).toBe(400)
    expect(call('PUT', '/_data_stream/logs-app-x').ok).toBe(true)
    expect(j(call('POST', '/logs-app-x/_rollover')).rolled_over).toBe(true)
    expect(j(call('PUT', '/_snapshot/nightly/s2?wait_for_completion=true', { indices: 'products' })).snapshot.state).toBe('SUCCESS')
    call('DELETE', '/products')
    expect(call('POST', '/_snapshot/nightly/s2/_restore', { indices: 'products' }).ok).toBe(true)
    expect(j(call('POST', '/products/_count', {})).count).toBe(6)
    expect(call('PUT', '/_security/user/bob', { password: 'short' }).status).toBe(400)
    expect(j(call('PUT', '/_security/user/bob', { password: 'longenough', roles: ['viewer'] })).created).toBe(true)
    expect(call('DELETE', '/_security/user/elastic').status).toBe(400)
    const key = j(call('POST', '/_security/api_key', { name: 'k', expiration: '1d' }))
    expect(key.encoded).toBeTruthy()
    expect(j(call('DELETE', '/_security/api_key', { ids: [key.id] })).invalidated_api_keys).toEqual([key.id])
  })
})

describe('console variables & status', async () => {
  const { applyVariables, statusTone } = await import('./console')
  it('substitutes ${vars}', () => {
    expect(applyVariables('GET /${idx}/_search?size=${n}', [{ name: 'idx', value: 'orders' }, { name: 'n', value: '5' }])).toBe('GET /orders/_search?size=5')
    expect(applyVariables('${missing}', [{ name: 'idx', value: 'x' }])).toBe('${missing}')
    expect(statusTone(201)).toBe('green')
    expect(statusTone(404)).toBe('yellow')
    expect(statusTone(500)).toBe('red')
  })
})

describe('dev tools helpers', async () => {
  const { flattenProfile, evalArithmetic, grokMatch } = await import('./devtools')
  it('flattens a search profile depth-first', () => {
    const rows = flattenProfile({
      shards: [{ id: '[n1][orders][0]', searches: [{ query: [{ type: 'BooleanQuery', description: 'b', time_in_nanos: 10, children: [{ type: 'TermQuery', description: 't', time_in_nanos: 4 }] }], collector: [{ name: 'TopDocs', reason: 'top', time_in_nanos: 2 }] }] }],
    })
    expect(rows.map((r) => [r.shard, r.depth, r.type, r.nanos])).toEqual([
      ['orders[0]', 0, 'BooleanQuery', 10],
      ['orders[0]', 1, 'TermQuery', 4],
      ['orders[0]', 0, 'TopDocs', 2],
    ])
    expect(flattenProfile(null)).toEqual([])
  })
  it('evaluates demo painless arithmetic without eval', () => {
    expect(evalArithmetic('return params.x * params.y + 1;', { x: 6, y: 7 })).toBe(43)
    expect(evalArithmetic('// c\nreturn (2 + 3) * -2;', {})).toBe(-10)
    expect(evalArithmetic('return doc.x;', {})).toBeNull()
    expect(evalArithmetic('alert(1)', {})).toBeNull()
  })
  it('matches grok patterns (built-in + custom)', () => {
    expect(grokMatch('%{IP:client} %{WORD:method} %{URIPATHPARAM:request} %{NUMBER:bytes}', '55.3.244.1 GET /index.html?x=1 15824')).toEqual({
      client: '55.3.244.1', method: 'GET', request: '/index.html?x=1', bytes: '15824',
    })
    expect(grokMatch('%{WORD:a}', 'two words')).toBeNull()
    expect(grokMatch('%{QUEUE:q}', 'AB12', { QUEUE: '[A-Z0-9]+' })).toEqual({ q: 'AB12' })
    expect(() => grokMatch('%{NOPE:x}', 'a')).toThrow(/Unable to find pattern/)
  })
})

describe('demo cluster: dev tools endpoints and resize', () => {
  beforeEach(() => resetEsDemo())
  const call = (method: string, path: string, body?: unknown) =>
    esDemo('es_request', { method, path, body: body === undefined ? null : JSON.stringify(body) }) as EsResponse
  const j = (r: EsResponse) => r.json as Record<string, any>
  it('profile, grok simulate, painless, analyze, clone needs a write block', () => {
    expect(j(call('POST', '/orders/_search', { profile: true, size: 0 })).profile.shards).toHaveLength(1)
    const g = j(call('POST', '/_ingest/pipeline/_simulate', { pipeline: { processors: [{ grok: { field: 'message', patterns: ['%{WORD:verb} %{NUMBER:n}'] } }] }, docs: [{ _source: { message: 'GET 5' } }, { _source: { message: '??' } }] }))
    expect(g.docs[0].doc._source.verb).toBe('GET')
    expect(g.docs[1].error.reason).toMatch(/do not match/)
    expect(j(call('POST', '/_scripts/painless/_execute', { script: { source: 'return params.a + 1;', params: { a: 1 } } })).result).toBe('2')
    expect(j(call('POST', '/_analyze', { analyzer: 'standard', text: 'Quick Fox' })).tokens.map((t: any) => t.token)).toEqual(['quick', 'fox'])
    expect(call('POST', '/products/_clone/products-copy').status).toBe(500) // as Elasticsearch answers
    call('PUT', '/products/_settings', { 'index.blocks.write': true })
    expect(call('POST', '/products/_clone/products-copy').ok).toBe(true)
    expect(j(call('POST', '/products-copy/_count', {})).count).toBe(6)
  })
})
