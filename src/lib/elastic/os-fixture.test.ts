// OpenSearch request fixture (SPEC-OPENSEARCH.md §3): every request the OpenSearch
// screens send, built by the SAME code the app runs (os-resources.ts kinds, the ISM
// lifecycle tab, the SQL / PPL calls, the security builders). The Rust integration
// test src-tauri/tests/opensearch_integration.rs replays this file against a real
// OpenSearch container, step by step, and checks each answer.
//
// Change the screens on purpose? Rewrite the fixture:
//   WRITE_OS_FIXTURE=1 npx vitest run src/lib/elastic/os-fixture.test.ts
import { describe, expect, it } from 'vitest'
import fixtureText from '../../../src-tauri/tests/fixtures/opensearch-requests.json?raw'
import { OS_RESOURCE_KINDS } from './os-resources'
import type { ResourceKind } from './resources'
import { mappingWithUser, newUserBody, roleBody, userPatch } from './os-security'

/** One request. `__name__` placeholders are filled from earlier answers (`save`). */
interface Step {
  title: string
  method: string
  path: string
  body?: unknown
  /** NDJSON body (bulk) */
  ndjson?: string
  /** accepted statuses */
  expect: number[]
  /** the answer must contain this text */
  contains?: string
  /** read `_seq_no` / `_primary_term` from GET {concurrency} and append them — how the
   *  app updates ISM / SM / transforms / rollups (O14) */
  concurrency?: string
  /** remember a JSON field of the answer under a name (`_id` of a created monitor) */
  save?: { name: string; field: string }
}

// vitest runs from the repo root (jsdom gives import.meta.url an http: URL, so no file URL here)
const FIXTURE = 'src-tauri/tests/fixtures/opensearch-requests.json'
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

/** Starter definitions the app proposes, with the blanks a user fills in. */
function filled(kind: ResourceKind, name: string): unknown {
  const t = structuredClone(kind.template?.(name) ?? {}) as Record<string, any>
  switch (kind.key) {
    case 'sm':
      t.snapshot_config.repository = 'it_repo'
      break
    case 'transforms':
      t.transform.source_index = 'books'
      t.transform.target_index = 'it_books_by_genre'
      t.transform.schedule.interval.start_time = 1_700_000_000
      t.transform.groups = [{ terms: { source_field: 'genre', target_field: 'genre' } }]
      break
    case 'rollups':
      t.rollup.source_index = 'books'
      t.rollup.target_index = 'it_books_rollup'
      t.rollup.schedule.interval.start_time = 1_700_000_000
      t.rollup.dimensions = [{ date_histogram: { source_field: 'published', fixed_interval: '1d' } }]
      t.rollup.metrics = [{ source_field: 'pages', metrics: [{ avg: {} }, { min: {} }, { max: {} }, { sum: {} }, { value_count: {} }] }]
      break
    case 'monitors':
      t.inputs[0].search.indices = ['books']
      break
    case 'index-templates':
      t.index_patterns = ['it-tpl-*']
      break
    case 'snapshot-repos':
      t.settings.location = '/tmp/os-snapshots/it_repo'
      break
  }
  return t
}

/** A small edit, the way a user changes a description / schedule in the editor. */
function edited(kind: ResourceKind, body: any): unknown {
  const b = structuredClone(body)
  if (kind.key === 'ism') b.policy.description = 'edited in the app'
  else if (kind.key === 'transforms') b.transform.description = 'edited in the app'
  else if (kind.key === 'rollups') b.rollup.description = 'edited in the app'
  else if (kind.key === 'sm') b.description = 'edited in the app'
  else if (kind.key === 'monitors') b.name = 'it monitor (edited)'
  return b
}

function buildSteps(): Step[] {
  const s: Step[] = []
  // ---- data the screens work on ----
  s.push({ title: 'create the books index', method: 'PUT', path: '/books', expect: [200], body: { settings: { number_of_replicas: 0 }, mappings: { properties: { title: { type: 'text', fields: { keyword: { type: 'keyword' } } }, genre: { type: 'keyword' }, pages: { type: 'integer' }, published: { type: 'date' } } } } })
  const docs = Array.from({ length: 40 }, (_, i) => [{ index: {} }, { title: `Book ${i}`, genre: ['scifi', 'drama', 'poetry'][i % 3], pages: 100 + i, published: `2024-01-${String((i % 28) + 1).padStart(2, '0')}` }])
  s.push({ title: 'bulk 40 books', method: 'POST', path: '/books/_bulk?refresh=true', ndjson: docs.flat().map((l) => JSON.stringify(l)).join('\n') + '\n', expect: [200], contains: '"errors":false' })

  // ---- SQL / PPL (query tab + Query Editor) ----
  s.push({ title: 'SQL page 1 (jdbc + cursor)', method: 'POST', path: '/_plugins/_sql?format=jdbc', body: { query: 'SELECT title, pages FROM books ORDER BY pages', fetch_size: 15 }, expect: [200], contains: '"cursor"' })
  s.push({ title: 'SQL explain', method: 'POST', path: '/_plugins/_sql/_explain', body: { query: 'SELECT genre FROM books' }, expect: [200] })
  s.push({ title: 'SQL error carries details', method: 'POST', path: '/_plugins/_sql?format=jdbc', body: { query: 'SELEC x FROM books' }, expect: [400], contains: '"details"' })
  s.push({ title: 'PPL stats', method: 'POST', path: '/_plugins/_ppl', body: { query: 'source = books | stats count() as n by genre | sort - n' }, expect: [200], contains: '"datarows"' })
  s.push({ title: 'PPL explain', method: 'POST', path: '/_plugins/_ppl/_explain', body: { query: 'source = books | fields title' }, expect: [200] })

  // ---- the repository the snapshot policy needs ----
  s.push({ title: 'snapshot repository', method: 'PUT', path: '/_snapshot/it_repo', body: { type: 'fs', settings: { location: '/tmp/os-snapshots/it_repo', compress: true } }, expect: [200] })

  // ---- every management kind: list, create, read, update (with version), actions, delete ----
  for (const kind of OS_RESOURCE_KINDS) {
    const name = `it-${kind.key}`
    const list: Step = { title: `${kind.label}: list`, method: kind.listMethod ?? 'GET', path: kind.listPath, expect: kind.emptyOn404 ? [200, 404] : [200] }
    if (kind.listBody) list.body = kind.listBody
    s.push(list)
    if (!kind.savePath || kind.saveNoBody) continue
    if (kind.key === 'snapshot-repos' || kind.key === 'scripts' || kind.key === 'component-templates' || kind.key === 'pipelines') {
      // shared with Elasticsearch — exercised once, no version semantics
      s.push({ title: `${kind.label}: create`, method: kind.saveMethod ?? 'PUT', path: kind.savePath(name), body: filled(kind, name), expect: [200, 201] })
      if (kind.deletePath) s.push({ title: `${kind.label}: delete`, method: 'DELETE', path: kind.deletePath(name), expect: [200] })
      continue
    }
    const body = filled(kind, name)
    const created: Step = { title: `${kind.label}: create`, method: kind.createMethod ?? kind.saveMethod ?? 'PUT', path: kind.createPath ? kind.createPath(name) : kind.savePath(name), body, expect: [200, 201] }
    // monitors get a generated id — later paths use it
    const key = kind.key === 'monitors' ? '__monitor__' : name
    if (kind.key === 'monitors') created.save = { name: 'monitor', field: '_id' }
    s.push(created)
    if (kind.getPath) s.push({ title: `${kind.label}: read`, method: 'GET', path: kind.getPath(key), expect: [200] })
    if (kind.concurrency) {
      // what OpenSearch does without the version — the reason the app reads it first
      s.push({ title: `${kind.label}: update WITHOUT version is refused`, method: kind.saveMethod ?? 'PUT', path: kind.savePath(key), body: edited(kind, body), expect: [400, 409] })
    }
    s.push({ title: `${kind.label}: update`, method: kind.saveMethod ?? 'PUT', path: kind.savePath(key), body: edited(kind, body), expect: [200, 201], ...(kind.concurrency && kind.getPath ? { concurrency: kind.getPath(key) } : {}) })
    for (const a of kind.actions ?? []) {
      const ab = a.body ? a.body(key, body) : undefined
      s.push({ title: `${kind.label}: ${a.label}`, method: a.method, path: a.path(key), ...(ab !== undefined ? { body: ab } : {}), expect: [200] })
    }
    if (kind.deletePath) s.push({ title: `${kind.label}: delete`, method: 'DELETE', path: kind.deletePath(key), expect: [200] })
  }

  // ---- ISM on one index (the index page Lifecycle tab) ----
  const ism = OS_RESOURCE_KINDS.find((k) => k.key === 'ism')!
  s.push({ title: 'ISM: policy for the lifecycle tab', method: 'PUT', path: ism.savePath!('it-lifecycle'), body: filled(ism, 'it-lifecycle'), expect: [200, 201] })
  s.push({ title: 'ISM: second policy', method: 'PUT', path: ism.savePath!('it-archive'), body: filled(ism, 'it-archive'), expect: [200, 201] })
  s.push({ title: 'ISM: apply to books', method: 'POST', path: '/_plugins/_ism/add/books', body: { policy_id: 'it-lifecycle' }, expect: [200], contains: '"failures":false' })
  s.push({ title: 'ISM: explain books', method: 'GET', path: '/_plugins/_ism/explain/books', expect: [200] })
  s.push({ title: 'ISM: change policy', method: 'POST', path: '/_plugins/_ism/change_policy/books', body: { policy_id: 'it-archive' }, expect: [200], contains: '"failures":false' })
  s.push({ title: 'ISM: remove', method: 'POST', path: '/_plugins/_ism/remove/books', expect: [200], contains: '"failures":false' })
  return s
}

/** Security plugin requests (secured cluster), built by os-security.ts. */
function buildSecurity() {
  const API = '/_plugins/_security/api'
  return {
    password: 'Zq7!mVt#pL2xWw',
    newPassword: 'Hn4@rKd8%sQv1Z',
    createUser: { method: 'PUT', path: `${API}/internalusers/it_reader`, body: newUserBody('Zq7!mVt#pL2xWw', ['it_team'], { team: 'books' }, 'integration user') },
    patchUser: { method: 'PATCH', path: `${API}/internalusers/it_reader`, body: userPatch(['it_team', 'readers'], { team: 'books' }, '', 'Hn4@rKd8%sQv1Z') },
    weakPassword: { method: 'PATCH', path: `${API}/internalusers/it_reader`, body: userPatch(['it_team'], {}, '', 'short') },
    role: {
      method: 'PUT',
      path: `${API}/roles/it_books_reader`,
      body: roleBody({
        description: 'reads scifi books, pages hidden',
        cluster_permissions: ['cluster_composite_ops_ro'],
        index_permissions: [{ index_patterns: ['books'], allowed_actions: ['read'], dls: '{"term":{"genre":"scifi"}}', fls: ['~pages'], masked_fields: [] }],
        tenant_permissions: [{ tenant_patterns: ['global_tenant'], allowed_actions: ['kibana_all_read'] }],
      }),
    },
    mapping: { method: 'PUT', path: `${API}/rolesmapping/it_books_reader`, body: mappingWithUser(undefined, 'it_reader', true) },
    unmapping: { method: 'PUT', path: `${API}/rolesmapping/it_books_reader`, body: mappingWithUser(mappingWithUser(undefined, 'it_reader', true), 'it_reader', false) },
    actionGroup: { method: 'PUT', path: `${API}/actiongroups/it_read_only`, body: { allowed_actions: ['indices:data/read/*'], type: 'index', description: 'integration' } },
    tenant: { method: 'PUT', path: `${API}/tenants/it_team`, body: { description: 'Integration team' } },
  }
}

describe('OpenSearch request fixture', () => {
  it('matches the requests the screens send (rewrite with WRITE_OS_FIXTURE=1)', async () => {
    const fixture = { steps: buildSteps(), security: buildSecurity() }
    const text = JSON.stringify(fixture, null, 2) + '\n'
    if (env.WRITE_OS_FIXTURE === '1') {
      const fsName = 'node:fs'
      const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync: (p: string, d: string) => void }
      fs.writeFileSync(FIXTURE, text)
      return
    }
    expect(fixtureText.replace(/\r\n/g, '\n')).toBe(text)
  })

  it('updates of versioned kinds read the version first', () => {
    const steps = buildSteps()
    for (const key of ['ism', 'sm', 'transforms', 'rollups']) {
      const kind = OS_RESOURCE_KINDS.find((k) => k.key === key)!
      const upd = steps.find((s) => s.title === `${kind.label}: update`)!
      expect(upd.concurrency, key).toBeTruthy()
    }
    // monitors are addressed by their generated id after creation
    expect(steps.find((s) => s.title === 'Alerting monitors: delete')?.path).toContain('__monitor__')
  })
})
