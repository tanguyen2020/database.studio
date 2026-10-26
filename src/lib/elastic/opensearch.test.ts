// OpenSearch flavor (SPEC-OPENSEARCH.md): the pure parts — product names and query
// languages, plugin answers (jdbc rows, ISM explain, errors), security model and
// request builders, console suggestions. Shapes are the ones measured on 3.9.
import { describe, expect, it } from 'vitest'
import { describeEsError, jdbcTabular } from './api'
import { LANGUAGE_LABEL, languageFor, pipedLanguage, productOf, queryLanguages } from './flavor'
import { ismSummary, parseIsmExplain } from './ism'
import {
  attributesOf,
  attributesText,
  dlsError,
  effectiveRoles,
  isLocked,
  listOf,
  mappingWithUser,
  newUserBody,
  roleBody,
  roleMappingChanges,
  rolesMappedByName,
  strongPassword,
  userPatch,
  type OsMapping,
} from './os-security'
import { OS_RESOURCE_KINDS, seqOf, strip } from './os-resources'
import { withConcurrency } from './resources'
import { endpointsFor, isElasticOnlyPath } from './console'
import { pplToEsql } from './os-demo'

describe('product and query languages', () => {
  it('names the product and its companion UI', () => {
    expect(productOf('opensearch')).toMatchObject({ name: 'OpenSearch', dashboards: 'OpenSearch Dashboards', queryLanguage: 'DQL' })
    expect(productOf('elasticsearch')).toMatchObject({ name: 'Elasticsearch', dashboards: 'Kibana', queryLanguage: 'KQL' })
  })

  it('OpenSearch has PPL + SQL, never ES|QL', () => {
    expect(queryLanguages('opensearch')).toEqual(['ppl', 'sql'])
    expect(queryLanguages('elasticsearch')).toEqual(['esql', 'sql'])
    expect(pipedLanguage('opensearch')).toBe('ppl')
    // a tab saved with ES|QL, opened on OpenSearch, becomes PPL
    expect(languageFor('opensearch', 'esql')).toBe('ppl')
    expect(languageFor('opensearch', 'sql')).toBe('sql')
    expect(languageFor('elasticsearch', 'ppl')).toBe('esql')
    expect(LANGUAGE_LABEL.ppl).toBe('PPL')
  })
})

describe('plugin answers', () => {
  it('jdbc pages become rows; the cursor is kept', () => {
    const r = jdbcTabular({ schema: [{ name: 'title', type: 'text' }, { name: 'year', type: 'integer' }], datarows: [['Emma', 1815], ['Dune']], cursor: 'n:abc' })
    expect(r.cols).toEqual([['title', 'text'], ['year', 'integer']])
    expect(r.rows).toEqual([{ title: 'Emma', year: 1815 }, { title: 'Dune', year: null }])
    expect(r.cursor).toBe('n:abc')
    expect(jdbcTabular({ schema: [], datarows: [] }).cursor).toBeUndefined()
  })

  it('errors read OpenSearch details and the security plugin shapes', () => {
    const sql = { error: { reason: 'Invalid SQL query', details: 'Query must start with SELECT, DELETE, SHOW or DESCRIBE: SELEC', type: 'SQLFeatureNotSupportedException' }, status: 400 }
    expect(describeEsError(400, sql, 'OpenSearch')).toBe('SQLFeatureNotSupportedException: Invalid SQL query — Query must start with SELECT, DELETE, SHOW or DESCRIBE: SELEC')
    expect(describeEsError(400, { status: 'error', reason: 'Weak password' }, 'OpenSearch')).toBe('OpenSearch 400: Weak password')
    expect(describeEsError(403, { status: 'FORBIDDEN', message: "Resource 'all_access' is static." }, 'OpenSearch')).toBe("Not allowed — Resource 'all_access' is static.")
    // the Elasticsearch default is unchanged
    expect(describeEsError(502, 'Bad gateway')).toBe('Elasticsearch 502: Bad gateway')
  })

  it('ISM explain: not managed, attached-but-pending, running, failed', () => {
    const none = parseIsmExplain({ books: { 'index.plugins.index_state_management.policy_id': null, enabled: null }, total_managed_indices: 0 }, 'books')
    expect(none).toMatchObject({ managed: false, pending: false })
    expect(ismSummary(none)).toMatch(/No ISM policy/)
    // measured right after _plugins/_ism/add: the policy id, no state yet
    const pending = parseIsmExplain({ books: { 'index.plugins.index_state_management.policy_id': 'hot', index: 'books', policy_id: 'hot', enabled: true }, total_managed_indices: 1 }, 'books')
    expect(pending).toMatchObject({ managed: true, pending: true, policy: 'hot' })
    expect(ismSummary(pending)).toMatch(/next run/)
    const running = parseIsmExplain({ books: { policy_id: 'hot', enabled: true, state: { name: 'hot' }, action: { name: 'rollover', failed: false }, step: { name: 'attempt_rollover', step_status: 'starting' } } }, 'books')
    expect(running).toMatchObject({ pending: false, state: 'hot', action: 'rollover', step: 'attempt_rollover', failed: false })
    const failed = parseIsmExplain({ books: { policy_id: 'hot', state: { name: 'hot' }, action: { name: 'rollover', failed: true, consumed_retries: 3 }, info: { message: 'Missing rollover_alias' } } }, 'books')
    expect(failed).toMatchObject({ failed: true, retries: 3, info: 'Missing rollover_alias' })
    expect(ismSummary(failed)).toMatch(/failed in action “rollover” after 3 retries/)
  })
})

describe('versioned updates (O14)', () => {
  it('reads seq / term and appends them to the path', () => {
    expect(seqOf({ _seq_no: 14, _primary_term: 1 })).toEqual({ seq: 14, term: 1 })
    expect(seqOf({})).toBeNull()
    expect(withConcurrency('/_plugins/_ism/policies/p', { seq: 14, term: 1 })).toBe('/_plugins/_ism/policies/p?if_seq_no=14&if_primary_term=1')
    expect(withConcurrency('/x?a=1', { seq: 2, term: 3 })).toBe('/x?a=1&if_seq_no=2&if_primary_term=3')
    expect(withConcurrency('/x', null)).toBe('/x')
  })

  it('every versioned kind declares how to read its version; server-written fields are dropped', () => {
    for (const key of ['ism', 'sm', 'transforms', 'rollups']) expect(OS_RESOURCE_KINDS.find((k) => k.key === key)?.concurrency, key).toBeTypeOf('function')
    expect(strip({ policy_id: 'p', last_updated_time: 1, schema_version: 31, description: 'd', error_notification: null }, ['policy_id', 'last_updated_time', 'schema_version'])).toEqual({ description: 'd' })
    const ism = OS_RESOURCE_KINDS.find((k) => k.key === 'ism')!
    const rows = ism.parseList({ policies: [{ _id: 'p', policy: { policy_id: 'p', states: [{ name: 'hot' }, { name: 'delete' }], ism_template: [{ index_patterns: ['logs-*'] }], schema_version: 31 } }] })
    expect(rows[0]).toMatchObject({ name: 'p', meta: 'hot → delete · applies to logs-*' })
    expect((rows[0].body as { policy: object }).policy).not.toHaveProperty('schema_version')
  })

  it('monitors are listed from search hits and addressed by their generated id', () => {
    const mon = OS_RESOURCE_KINDS.find((k) => k.key === 'monitors')!
    const rows = mon.parseList({ hits: { hits: [{ _id: 'abc', _source: { type: 'monitor', name: 'Errors', monitor_type: 'query_level_monitor', enabled: true, schedule: { period: { interval: 5, unit: 'MINUTES' } } } }, { _id: 'wf', _source: { type: 'workflow', name: 'x' } }] } })
    expect(rows).toEqual([{ name: 'Errors', id: 'abc', meta: 'query level monitor', badges: ['enabled'] }])
    expect(mon.createPath?.('Errors')).toBe('/_plugins/_alerting/monitors')
    expect(mon.savePath?.('abc')).toBe('/_plugins/_alerting/monitors/abc')
    // no Elasticsearch-only kinds on OpenSearch
    expect(OS_RESOURCE_KINDS.map((k) => k.key)).not.toContain('ilm')
    expect(OS_RESOURCE_KINDS.map((k) => k.key)).not.toContain('watches')
    expect(OS_RESOURCE_KINDS.map((k) => k.key)).not.toContain('enrich')
  })
})

describe('security model', () => {
  const mappings: Record<string, OsMapping> = {
    all_access: { users: [], backend_roles: ['admin'], hosts: [] },
    readers: { users: ['ann'], backend_roles: [], hosts: [] },
    support: { users: [], backend_roles: ['help'], hosts: [] },
  }

  it('effective roles: by name, by backend role, assigned on the user', () => {
    const eff = effectiveRoles('ann', { backend_roles: ['help'], attributes: {}, opendistro_security_roles: ['own'] }, mappings)
    expect(eff).toEqual([
      { role: 'own', via: 'assigned on the user' },
      { role: 'readers', via: 'mapped to the user' },
      { role: 'support', via: 'via backend role help' },
    ])
    expect(rolesMappedByName('ann', mappings)).toEqual(['readers'])
  })

  it('role checkboxes change only the mappings that need it, keeping the rest of each mapping', () => {
    expect(roleMappingChanges(['a', 'b'], ['b', 'c'])).toEqual({ add: ['c'], remove: ['a'] })
    const m = mappingWithUser({ users: ['x'], backend_roles: ['help'], hosts: ['h'], description: 'd' }, 'ann', true)
    expect(m).toEqual({ users: ['x', 'ann'], backend_roles: ['help'], hosts: ['h'], description: 'd' })
    expect(mappingWithUser(m, 'ann', false).users).toEqual(['x'])
    expect(mappingWithUser(undefined, 'ann', true)).toEqual({ users: ['ann'], backend_roles: [], hosts: [] })
  })

  it('builders: new user, patch (password only when given), role without empty DLS / FLS', () => {
    expect(newUserBody('P@ss', ['dev'], { team: 'a' }, ' ')).toEqual({ password: 'P@ss', backend_roles: ['dev'], attributes: { team: 'a' } })
    expect(userPatch(['dev'], {}, 'd').map((o) => o.path)).toEqual(['/backend_roles', '/attributes', '/description'])
    expect(userPatch(['dev'], {}, '', 'N3w!pass').at(-1)).toEqual({ op: 'add', path: '/password', value: 'N3w!pass' })
    const r = roleBody({
      cluster_permissions: ['cluster_monitor'],
      index_permissions: [{ index_patterns: ['logs-*'], allowed_actions: ['read'], dls: ' ', fls: [], masked_fields: ['email'] }, { index_patterns: [], allowed_actions: ['read'] }],
      tenant_permissions: [{ tenant_patterns: [], allowed_actions: ['kibana_all_read'] }],
    })
    expect(r).toEqual({ cluster_permissions: ['cluster_monitor'], index_permissions: [{ index_patterns: ['logs-*'], allowed_actions: ['read'], masked_fields: ['email'] }], tenant_permissions: [] })
  })

  it('inputs: lists, attributes, DLS validation, locked objects, strong passwords', () => {
    expect(listOf(' a, b ,,a\nc ')).toEqual(['a', 'b', 'c'])
    expect(attributesOf('team=a\nbad\n region = eu ')).toEqual({ team: 'a', region: 'eu' })
    expect(attributesText({ team: 'a' })).toBe('team=a')
    expect(dlsError('{"term":{"t":"a"}}')).toBeNull()
    expect(dlsError('[1]')).toMatch(/query object/)
    expect(dlsError('{nope')).toMatch(/not valid JSON/)
    expect(isLocked({ static: true })).toBe(true)
    expect(isLocked({ reserved: false, static: false, hidden: false })).toBe(false)
    for (let i = 0; i < 20; i++) expect(strongPassword()).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{18}$/)
  })
})

describe('console suggestions', () => {
  it('OpenSearch drops the X-Pack endpoints and adds its plugins', () => {
    const os = endpointsFor('opensearch').map((e) => e.path)
    expect(os).toContain('_plugins/_ppl')
    expect(os).toContain('_plugins/_ism/explain/{index}')
    expect(os).toContain('_search')
    expect(os.some((p) => isElasticOnlyPath(p))).toBe(false)
    expect(endpointsFor('elasticsearch').map((e) => e.path)).toContain('_query')
    expect(isElasticOnlyPath('{index}/_ilm/explain')).toBe(true)
    expect(isElasticOnlyPath('_snapshot')).toBe(false)
  })
})

describe('demo PPL (only what the examples use)', () => {
  it('translates to the shared demo engine', () => {
    expect(pplToEsql('source = books | where pages > 100 | fields title, pages | sort - pages | head 5')).toBe('FROM books | WHERE pages > 100 | KEEP title, pages | SORT pages DESC | LIMIT 5')
    expect(pplToEsql('source=books | stats count() as n by genre')).toBe('FROM books | STATS n = COUNT(*) BY genre')
    expect(pplToEsql('source = books | top 3 genre')).toBe('FROM books | STATS count = COUNT(*) BY genre | SORT count DESC | LIMIT 3')
  })
})
