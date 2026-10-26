// Dev Tools console — the Kibana request format:
//
//   # a comment
//   GET /orders/_search
//   {
//     "query": { "match": { "status": "paid" } }
//   }
//
//   POST _bulk
//   { "index": { "_index": "orders" } }
//   { "status": "paid" }
//
// A request starts at a line beginning with an HTTP method; its body is every line
// up to the next request. Bulk-style bodies are newline-delimited JSON (each JSON
// document collapsed onto one line before sending). `"""…"""` triple-quoted
// strings (Kibana's way to write scripts / multi-line text) become JSON strings.

export const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'] as const
export type Method = (typeof METHODS)[number]

export interface ConsoleRequest {
  method: Method
  path: string
  /** raw body text as typed ('' when none) */
  body: string
  /** 1-based, inclusive line range of the whole request (method line … last body line) */
  startLine: number
  endLine: number
}

const METHOD_LINE = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\b\s*(.*)$/i

/** Split the console text into requests. Comment / blank lines between requests
 *  are skipped; a body line before the first request is ignored (Kibana does the same). */
export function parseConsole(text: string): ConsoleRequest[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ConsoleRequest[] = []
  let cur: ConsoleRequest | null = null
  let bodyLines: string[] = []
  let inTriple = false
  const close = (endIdx: number) => {
    if (!cur) return
    // trim trailing blank / comment lines from the body
    while (bodyLines.length && (!bodyLines[bodyLines.length - 1].trim() || isComment(bodyLines[bodyLines.length - 1]))) {
      bodyLines.pop()
      endIdx--
    }
    cur.body = bodyLines.join('\n')
    cur.endLine = bodyLines.length ? Math.max(cur.startLine, endIdx) : cur.startLine
    out.push(cur)
    cur = null
    bodyLines = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = !inTriple ? METHOD_LINE.exec(line) : null
    if (m && !line.startsWith(' ') && !line.startsWith('\t')) {
      close(i) // previous request ends on the line before
      cur = {
        method: m[1].toUpperCase() as Method,
        path: m[2].trim(),
        body: '',
        startLine: i + 1,
        endLine: i + 1,
      }
      continue
    }
    if (cur) {
      if (!bodyLines.length && (isComment(line) || !line.trim())) {
        // comments / blanks straight after the method line are not body
        continue
      }
      bodyLines.push(line)
      const triples = (line.match(/"""/g) ?? []).length
      if (triples % 2 === 1) inTriple = !inTriple
    }
  }
  close(lines.length)
  return out
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('#') || t.startsWith('//')
}

/** The request the caret is in (or the nearest one above it). */
export function requestAt(reqs: ConsoleRequest[], line: number): ConsoleRequest | null {
  let best: ConsoleRequest | null = null
  for (const r of reqs) {
    if (r.startLine <= line) best = r
    if (line >= r.startLine && line <= r.endLine) return r
  }
  return best
}

/** Requests touched by a selection (for "run selected"). */
export function requestsIn(reqs: ConsoleRequest[], fromLine: number, toLine: number): ConsoleRequest[] {
  return reqs.filter((r) => r.endLine >= fromLine && r.startLine <= toLine)
}

/** Kibana's `"""multi\nline"""` → a JSON string literal. */
export function expandTripleQuotes(body: string): string {
  return body.replace(/"""([\s\S]*?)"""/g, (_, s: string) => JSON.stringify(s))
}

/** Every JSON value in a text, in order (for NDJSON bodies spread over lines). */
export function splitJsonDocs(text: string): string[] | null {
  const docs: string[] = []
  let depth = 0
  let inStr = false
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      if (depth === 0 && start < 0) start = i
      continue
    }
    if (c === '{' || c === '[') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}' || c === ']') {
      depth--
      if (depth < 0) return null
      if (depth === 0) {
        docs.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return depth === 0 ? docs : null
}

export function isNdjsonPath(path: string): boolean {
  const p = path.split('?')[0]
  return /(^|\/)_bulk$/.test(p) || /(^|\/)_msearch(\/template)?$/.test(p)
}

/** Body text → what goes on the wire. JSON is compacted (and validated); bulk
 *  bodies become NDJSON. Returns `error` when the JSON is not valid — the caller
 *  can still send the raw text (Elasticsearch then answers with its own error). */
export function bodyToWire(path: string, body: string): { wire: string | null; error?: string } {
  const raw = expandTripleQuotes(body).trim()
  if (!raw) return { wire: null }
  if (isNdjsonPath(path)) {
    const docs = splitJsonDocs(raw)
    if (!docs) return { wire: raw + '\n', error: 'Unbalanced JSON in the bulk body' }
    try {
      return { wire: docs.map((d) => JSON.stringify(JSON.parse(d))).join('\n') + '\n' }
    } catch (e) {
      return { wire: raw + '\n', error: (e as Error).message }
    }
  }
  try {
    return { wire: JSON.stringify(JSON.parse(raw)) }
  } catch (e) {
    return { wire: raw, error: (e as Error).message }
  }
}

/** Re-indent a request body (Kibana's "Auto indent"). NDJSON stays one doc per line. */
export function formatBody(path: string, body: string): string {
  const raw = expandTripleQuotes(body).trim()
  if (!raw) return body
  if (isNdjsonPath(path)) {
    const docs = splitJsonDocs(raw)
    if (!docs) return body
    try {
      return docs.map((d) => JSON.stringify(JSON.parse(d))).join('\n')
    } catch {
      return body
    }
  }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return body
  }
}

/** Normalise a console path: leading slash, no surrounding whitespace. */
export function normalizePath(path: string): string {
  const p = path.trim()
  if (!p) return '/'
  return p.startsWith('/') ? p : `/${p}`
}

/** `curl` command for a request (Kibana's "Copy as cURL"). Never embeds a password. */
export function toCurl(req: ConsoleRequest, baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/, '') + normalizePath(req.path)
  const parts = [`curl -X${req.method} "${url}"`]
  const { wire } = bodyToWire(req.path, req.body)
  if (wire) {
    const ct = isNdjsonPath(req.path) ? 'application/x-ndjson' : 'application/json'
    parts.push(`-H "Content-Type: ${ct}"`)
    parts.push(`-d '${wire.replace(/'/g, "'\\''")}'`)
  }
  return parts.join(' \\\n  ')
}

// ---- autocomplete vocabulary ---------------------------------------------------

export interface EndpointHint {
  path: string
  methods: Method[]
  doc: string
  /** body template inserted after the path when picked */
  body?: string
}

/** The REST endpoints a developer reaches for (Kibana console's spec, abridged). */
export const ENDPOINTS: EndpointHint[] = [
  { path: '_search', methods: ['GET', 'POST'], doc: 'Search all indices', body: '{\n  "query": {\n    "match_all": {}\n  }\n}' },
  { path: '{index}/_search', methods: ['GET', 'POST'], doc: 'Search an index', body: '{\n  "query": {\n    "match_all": {}\n  }\n}' },
  { path: '{index}/_count', methods: ['GET', 'POST'], doc: 'Count matching documents' },
  { path: '{index}/_doc', methods: ['POST'], doc: 'Index a document (auto id)', body: '{\n  \n}' },
  { path: '{index}/_doc/{id}', methods: ['GET', 'PUT', 'DELETE', 'HEAD'], doc: 'Get / replace / delete a document' },
  { path: '{index}/_update/{id}', methods: ['POST'], doc: 'Partial update', body: '{\n  "doc": {\n    \n  }\n}' },
  { path: '{index}/_mapping', methods: ['GET', 'PUT'], doc: 'Index mapping' },
  { path: '{index}/_settings', methods: ['GET', 'PUT'], doc: 'Index settings' },
  { path: '{index}/_stats', methods: ['GET'], doc: 'Index statistics' },
  { path: '{index}/_refresh', methods: ['POST'], doc: 'Refresh' },
  { path: '{index}/_flush', methods: ['POST'], doc: 'Flush' },
  { path: '{index}/_forcemerge', methods: ['POST'], doc: 'Force merge' },
  { path: '{index}/_open', methods: ['POST'], doc: 'Open a closed index' },
  { path: '{index}/_close', methods: ['POST'], doc: 'Close an index' },
  { path: '{index}/_delete_by_query', methods: ['POST'], doc: 'Delete matching documents', body: '{\n  "query": {\n    "match": {}\n  }\n}' },
  { path: '{index}/_update_by_query', methods: ['POST'], doc: 'Update matching documents' },
  { path: '{index}/_rollover', methods: ['POST'], doc: 'Roll over an alias / data stream' },
  { path: '{index}/_explain/{id}', methods: ['GET', 'POST'], doc: 'Explain a score' },
  { path: '{index}/_validate/query', methods: ['GET', 'POST'], doc: 'Validate a query' },
  { path: '{index}/_field_caps', methods: ['GET', 'POST'], doc: 'Field capabilities' },
  { path: '{index}/_analyze', methods: ['GET', 'POST'], doc: 'Analyze text', body: '{\n  "text": ""\n}' },
  { path: '{index}/_termvectors/{id}', methods: ['GET', 'POST'], doc: 'Term vectors' },
  { path: '_bulk', methods: ['POST', 'PUT'], doc: 'Bulk (NDJSON)' },
  { path: '_msearch', methods: ['GET', 'POST'], doc: 'Multi search (NDJSON)' },
  { path: '_mget', methods: ['GET', 'POST'], doc: 'Multi get' },
  { path: '_reindex', methods: ['POST'], doc: 'Reindex', body: '{\n  "source": { "index": "" },\n  "dest": { "index": "" }\n}' },
  { path: '_aliases', methods: ['POST'], doc: 'Update aliases', body: '{\n  "actions": [\n    { "add": { "index": "", "alias": "" } }\n  ]\n}' },
  { path: '_alias', methods: ['GET'], doc: 'All aliases' },
  { path: '_cat/indices', methods: ['GET'], doc: 'Indices (add ?v for headers)' },
  { path: '_cat/aliases', methods: ['GET'], doc: 'Aliases' },
  { path: '_cat/shards', methods: ['GET'], doc: 'Shards' },
  { path: '_cat/nodes', methods: ['GET'], doc: 'Nodes' },
  { path: '_cat/health', methods: ['GET'], doc: 'Health' },
  { path: '_cat/allocation', methods: ['GET'], doc: 'Disk allocation per node' },
  { path: '_cat/count', methods: ['GET'], doc: 'Document count' },
  { path: '_cat/thread_pool', methods: ['GET'], doc: 'Thread pools' },
  { path: '_cat/templates', methods: ['GET'], doc: 'Templates' },
  { path: '_cat/segments', methods: ['GET'], doc: 'Segments' },
  { path: '_cat/recovery', methods: ['GET'], doc: 'Recoveries' },
  { path: '_cat/pending_tasks', methods: ['GET'], doc: 'Pending cluster tasks' },
  { path: '_cluster/health', methods: ['GET'], doc: 'Cluster health' },
  { path: '_cluster/state', methods: ['GET'], doc: 'Cluster state' },
  { path: '_cluster/stats', methods: ['GET'], doc: 'Cluster statistics' },
  { path: '_cluster/settings', methods: ['GET', 'PUT'], doc: 'Cluster settings' },
  { path: '_cluster/allocation/explain', methods: ['GET', 'POST'], doc: 'Why a shard is (un)assigned' },
  { path: '_cluster/reroute', methods: ['POST'], doc: 'Reroute shards' },
  { path: '_cluster/pending_tasks', methods: ['GET'], doc: 'Pending tasks' },
  { path: '_nodes', methods: ['GET'], doc: 'Nodes info' },
  { path: '_nodes/stats', methods: ['GET'], doc: 'Nodes statistics' },
  { path: '_nodes/hot_threads', methods: ['GET'], doc: 'Hot threads' },
  { path: '_tasks', methods: ['GET'], doc: 'Running tasks' },
  { path: '_tasks/{task_id}/_cancel', methods: ['POST'], doc: 'Cancel a task' },
  { path: '_index_template', methods: ['GET'], doc: 'Index templates' },
  { path: '_index_template/{name}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Index template' },
  { path: '_component_template', methods: ['GET'], doc: 'Component templates' },
  { path: '_component_template/{name}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Component template' },
  { path: '_data_stream', methods: ['GET'], doc: 'Data streams' },
  { path: '_data_stream/{name}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Data stream' },
  { path: '_ingest/pipeline', methods: ['GET'], doc: 'Ingest pipelines' },
  { path: '_ingest/pipeline/{id}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Ingest pipeline' },
  { path: '_ingest/pipeline/{id}/_simulate', methods: ['POST'], doc: 'Simulate a pipeline' },
  { path: '_ilm/policy', methods: ['GET'], doc: 'Lifecycle policies' },
  { path: '_ilm/policy/{name}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Lifecycle policy' },
  { path: '{index}/_ilm/explain', methods: ['GET'], doc: 'Lifecycle state of an index' },
  { path: '_ilm/status', methods: ['GET'], doc: 'ILM status' },
  { path: '_snapshot', methods: ['GET'], doc: 'Snapshot repositories' },
  { path: '_snapshot/{repo}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Snapshot repository' },
  { path: '_snapshot/{repo}/_all', methods: ['GET'], doc: 'Snapshots of a repository' },
  { path: '_snapshot/{repo}/{snapshot}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Snapshot' },
  { path: '_snapshot/{repo}/{snapshot}/_restore', methods: ['POST'], doc: 'Restore a snapshot' },
  { path: '_slm/policy', methods: ['GET'], doc: 'Snapshot lifecycle policies' },
  { path: '_slm/policy/{name}/_execute', methods: ['POST'], doc: 'Run an SLM policy now' },
  { path: '_security/_authenticate', methods: ['GET'], doc: 'Who am I' },
  { path: '_security/user', methods: ['GET'], doc: 'Users' },
  { path: '_security/user/{name}', methods: ['GET', 'PUT', 'DELETE'], doc: 'User' },
  { path: '_security/role', methods: ['GET'], doc: 'Roles' },
  { path: '_security/role/{name}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Role' },
  { path: '_security/api_key', methods: ['GET', 'POST', 'DELETE'], doc: 'API keys' },
  { path: '_security/role_mapping', methods: ['GET'], doc: 'Role mappings' },
  { path: '_security/privilege', methods: ['GET'], doc: 'Application privileges' },
  { path: '_security/user/_has_privileges', methods: ['GET', 'POST'], doc: 'Check privileges' },
  { path: '_sql', methods: ['POST'], doc: 'SQL query', body: '{\n  "query": ""\n}' },
  { path: '_sql/translate', methods: ['POST'], doc: 'SQL → Query DSL' },
  { path: '_query', methods: ['POST'], doc: 'ES|QL query', body: '{\n  "query": "FROM  | LIMIT 10"\n}' },
  { path: '_scripts/{id}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Stored script / search template' },
  { path: '_render/template', methods: ['GET', 'POST'], doc: 'Render a search template' },
  { path: '_transform', methods: ['GET'], doc: 'Transforms' },
  { path: '_transform/{id}/_start', methods: ['POST'], doc: 'Start a transform' },
  { path: '_transform/{id}/_stop', methods: ['POST'], doc: 'Stop a transform' },
  { path: '_enrich/policy', methods: ['GET'], doc: 'Enrich policies' },
  { path: '_enrich/policy/{name}/_execute', methods: ['PUT', 'POST'], doc: 'Execute an enrich policy' },
  { path: '_watcher/watch/{id}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Watch' },
  { path: '_license', methods: ['GET'], doc: 'License' },
  { path: '_xpack', methods: ['GET'], doc: 'Features' },
  { path: '_resolve/index/{name}', methods: ['GET'], doc: 'Resolve indices / aliases / data streams' },
]

/** Elasticsearch-only endpoints (X-Pack) — OpenSearch answers them 400 / 405 (SPEC-OPENSEARCH.md O3–O13). */
export function isElasticOnlyPath(path: string): boolean {
  return /^(\{index\}\/)?_(ilm|slm|security|sql|query|transform|enrich|watcher|license|xpack)(\/|$)/.test(path)
}

/** OpenSearch plugin endpoints (all measured on OpenSearch 3.9). */
export const OS_ENDPOINTS: EndpointHint[] = [
  { path: '_plugins/_sql', methods: ['POST'], doc: 'SQL query (format=jdbc for rows)', body: '{\n  "query": "SELECT * FROM  LIMIT 10"\n}' },
  { path: '_plugins/_sql/_explain', methods: ['POST'], doc: 'Explain a SQL query', body: '{\n  "query": ""\n}' },
  { path: '_plugins/_ppl', methods: ['POST'], doc: 'PPL query', body: '{\n  "query": "source =  | head 10"\n}' },
  { path: '_plugins/_ppl/_explain', methods: ['POST'], doc: 'Explain a PPL query' },
  { path: '_plugins/_ism/policies', methods: ['GET'], doc: 'ISM policies' },
  { path: '_plugins/_ism/policies/{name}', methods: ['GET', 'PUT', 'DELETE'], doc: 'ISM policy' },
  { path: '_plugins/_ism/explain/{index}', methods: ['GET'], doc: 'ISM state of an index' },
  { path: '_plugins/_ism/add/{index}', methods: ['POST'], doc: 'Attach an ISM policy', body: '{\n  "policy_id": ""\n}' },
  { path: '_plugins/_ism/remove/{index}', methods: ['POST'], doc: 'Detach the ISM policy' },
  { path: '_plugins/_ism/retry/{index}', methods: ['POST'], doc: 'Retry a failed ISM action' },
  { path: '_plugins/_sm/policies', methods: ['GET'], doc: 'Snapshot policies' },
  { path: '_plugins/_sm/policies/{name}', methods: ['GET', 'POST', 'PUT', 'DELETE'], doc: 'Snapshot policy' },
  { path: '_plugins/_transform', methods: ['GET'], doc: 'Transforms' },
  { path: '_plugins/_transform/{id}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Transform' },
  { path: '_plugins/_transform/{id}/_start', methods: ['POST'], doc: 'Start a transform' },
  { path: '_plugins/_transform/_preview', methods: ['POST'], doc: 'Preview a transform' },
  { path: '_plugins/_rollup/jobs', methods: ['GET'], doc: 'Rollup jobs' },
  { path: '_plugins/_rollup/jobs/{id}', methods: ['GET', 'PUT', 'DELETE'], doc: 'Rollup job' },
  { path: '_plugins/_alerting/monitors/_search', methods: ['POST'], doc: 'Search monitors', body: '{\n  "query": {\n    "match_all": {}\n  }\n}' },
  { path: '_plugins/_alerting/monitors', methods: ['POST'], doc: 'Create a monitor' },
  { path: '_plugins/_alerting/monitors/alerts', methods: ['GET'], doc: 'Alerts' },
  { path: '_plugins/_security/authinfo', methods: ['GET'], doc: 'Who am I' },
  { path: '_plugins/_security/api/internalusers', methods: ['GET'], doc: 'Internal users' },
  { path: '_plugins/_security/api/internalusers/{name}', methods: ['GET', 'PUT', 'PATCH', 'DELETE'], doc: 'Internal user' },
  { path: '_plugins/_security/api/roles', methods: ['GET'], doc: 'Roles' },
  { path: '_plugins/_security/api/roles/{name}', methods: ['GET', 'PUT', 'PATCH', 'DELETE'], doc: 'Role' },
  { path: '_plugins/_security/api/rolesmapping', methods: ['GET'], doc: 'Role mappings' },
  { path: '_plugins/_security/api/actiongroups', methods: ['GET'], doc: 'Action groups' },
  { path: '_plugins/_security/api/tenants', methods: ['GET'], doc: 'Tenants' },
  { path: '_plugins/_security/api/account', methods: ['GET', 'PUT'], doc: 'Your account / change your password' },
  { path: '_plugins/_knn/stats', methods: ['GET'], doc: 'k-NN statistics' },
]

/** Endpoint suggestions of the server: Elasticsearch, or OpenSearch (no X-Pack, plus its plugins). */
export function endpointsFor(flavor: 'elasticsearch' | 'opensearch'): EndpointHint[] {
  return flavor === 'opensearch' ? [...ENDPOINTS.filter((e) => !isElasticOnlyPath(e.path)), ...OS_ENDPOINTS] : ENDPOINTS
}

/** Query DSL / request-body keys offered inside a JSON body. */
export const BODY_KEYS: { key: string; doc: string; snippet?: string }[] = [
  { key: 'query', doc: 'Query', snippet: '"query": {\n  $0\n}' },
  { key: 'match_all', doc: 'Match every document', snippet: '"match_all": {}' },
  { key: 'match', doc: 'Full-text match', snippet: '"match": {\n  "$1": "$0"\n}' },
  { key: 'match_phrase', doc: 'Phrase match', snippet: '"match_phrase": {\n  "$1": "$0"\n}' },
  { key: 'multi_match', doc: 'Match on several fields', snippet: '"multi_match": {\n  "query": "$1",\n  "fields": [$0]\n}' },
  { key: 'term', doc: 'Exact term', snippet: '"term": {\n  "$1": "$0"\n}' },
  { key: 'terms', doc: 'Any of exact terms', snippet: '"terms": {\n  "$1": [$0]\n}' },
  { key: 'range', doc: 'Range', snippet: '"range": {\n  "$1": {\n    "gte": $0\n  }\n}' },
  { key: 'exists', doc: 'Field exists', snippet: '"exists": {\n  "field": "$0"\n}' },
  { key: 'prefix', doc: 'Prefix', snippet: '"prefix": {\n  "$1": "$0"\n}' },
  { key: 'wildcard', doc: 'Wildcard', snippet: '"wildcard": {\n  "$1": "$0"\n}' },
  { key: 'regexp', doc: 'Regular expression' },
  { key: 'fuzzy', doc: 'Fuzzy' },
  { key: 'ids', doc: 'By ids', snippet: '"ids": {\n  "values": [$0]\n}' },
  { key: 'query_string', doc: 'Lucene syntax', snippet: '"query_string": {\n  "query": "$0"\n}' },
  { key: 'simple_query_string', doc: 'Simple query syntax' },
  { key: 'bool', doc: 'Boolean combination', snippet: '"bool": {\n  "must": [$0],\n  "filter": [],\n  "should": [],\n  "must_not": []\n}' },
  { key: 'must', doc: 'Must match (scores)' },
  { key: 'filter', doc: 'Must match (no score, cached)' },
  { key: 'should', doc: 'Should match' },
  { key: 'must_not', doc: 'Must not match' },
  { key: 'minimum_should_match', doc: 'How many should clauses' },
  { key: 'nested', doc: 'Nested query' },
  { key: 'geo_distance', doc: 'Geo distance' },
  { key: 'function_score', doc: 'Function score' },
  { key: 'knn', doc: 'Approximate kNN (vectors)' },
  { key: 'size', doc: 'Hits to return', snippet: '"size": $0' },
  { key: 'from', doc: 'Offset', snippet: '"from": $0' },
  { key: 'sort', doc: 'Sort', snippet: '"sort": [\n  { "$1": "desc" }\n]' },
  { key: '_source', doc: 'Source filtering', snippet: '"_source": [$0]' },
  { key: 'fields', doc: 'Fields to return' },
  { key: 'track_total_hits', doc: 'Exact total', snippet: '"track_total_hits": true' },
  { key: 'search_after', doc: 'Deep pagination' },
  { key: 'highlight', doc: 'Highlighting', snippet: '"highlight": {\n  "fields": {\n    "$0": {}\n  }\n}' },
  { key: 'aggs', doc: 'Aggregations', snippet: '"aggs": {\n  "$1": {\n    $0\n  }\n}' },
  { key: 'terms_agg', doc: 'terms aggregation', snippet: '"terms": {\n  "field": "$0",\n  "size": 10\n}' },
  { key: 'date_histogram', doc: 'Date histogram', snippet: '"date_histogram": {\n  "field": "$1",\n  "calendar_interval": "day"\n}' },
  { key: 'histogram', doc: 'Histogram' },
  { key: 'avg', doc: 'Average', snippet: '"avg": {\n  "field": "$0"\n}' },
  { key: 'sum', doc: 'Sum', snippet: '"sum": {\n  "field": "$0"\n}' },
  { key: 'min', doc: 'Min' },
  { key: 'max', doc: 'Max' },
  { key: 'stats', doc: 'Stats' },
  { key: 'cardinality', doc: 'Distinct count' },
  { key: 'percentiles', doc: 'Percentiles' },
  { key: 'top_hits', doc: 'Top hits per bucket' },
  { key: 'composite', doc: 'Paginate all buckets' },
  { key: 'mappings', doc: 'Mappings', snippet: '"mappings": {\n  "properties": {\n    $0\n  }\n}' },
  { key: 'properties', doc: 'Fields' },
  { key: 'settings', doc: 'Settings', snippet: '"settings": {\n  "number_of_shards": 1,\n  "number_of_replicas": 1\n}' },
  { key: 'number_of_shards', doc: 'Primary shards' },
  { key: 'number_of_replicas', doc: 'Replicas' },
  { key: 'refresh_interval', doc: 'Refresh interval' },
  { key: 'analysis', doc: 'Analyzers / tokenizers' },
  { key: 'type', doc: 'Field type' },
  { key: 'index_patterns', doc: 'Template patterns' },
  { key: 'processors', doc: 'Ingest processors' },
  { key: 'script', doc: 'Painless script', snippet: '"script": {\n  "source": "$0"\n}' },
]

/** Field types for the mapping editor / autocomplete. */
export const FIELD_TYPES = [
  'text', 'keyword', 'constant_keyword', 'wildcard', 'match_only_text', 'long', 'integer', 'short', 'byte', 'double',
  'float', 'half_float', 'scaled_float', 'unsigned_long', 'date', 'date_nanos', 'boolean', 'binary', 'ip', 'object',
  'nested', 'flattened', 'geo_point', 'geo_shape', 'point', 'shape', 'integer_range', 'float_range', 'long_range',
  'double_range', 'date_range', 'ip_range', 'completion', 'search_as_you_type', 'dense_vector', 'sparse_vector',
  'rank_feature', 'rank_features', 'semantic_text', 'alias', 'version', 'histogram', 'aggregate_metric_double',
  'join', 'percolator', 'token_count',
]

/** Expand `{index}` in an endpoint template with a concrete index. */
export function fillEndpoint(path: string, index?: string | null): string {
  return index ? path.replace('{index}', index) : path
}

/** Kibana console variables: `${name}` in a path or body → its value. Unknown
 *  names are left as typed (Elasticsearch then reports them). */
export function applyVariables(text: string, vars: { name: string; value: string }[]): string {
  if (!vars.length) return text
  const map = new Map(vars.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value]))
  return text.replace(/\$\{([\w.-]+)\}/g, (all, n: string) => (map.has(n) ? map.get(n)! : all))
}

/** Response status → tone for the badge. */
export function statusTone(status: number): 'green' | 'yellow' | 'red' {
  if (status >= 200 && status < 300) return 'green'
  if (status >= 400 && status < 500) return 'yellow'
  return 'red'
}

export const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout',
  409: 'Conflict', 413: 'Payload Too Large', 429: 'Too Many Requests', 500: 'Internal Server Error',
  502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
}
