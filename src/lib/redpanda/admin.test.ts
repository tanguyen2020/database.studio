// Redpanda Admin API helpers (SPEC-REDPANDA.md). Parsers are fed the shapes measured
// on redpandadata/redpanda v26.2.6. The request fixture is built by the SAME builders
// the screens use; src-tauri/tests/redpanda_integration.rs replays it against a real
// Redpanda container, step by step.
//
// Change the screens on purpose? Rewrite the fixture:
//   WRITE_RP_FIXTURE=1 npx vitest run src/lib/redpanda/admin.test.ts
import { describe, expect, it } from 'vitest'
import fixtureText from '../../../src-tauri/tests/fixtures/redpanda-requests.json?raw'
import {
  ACL_PRESETS,
  aclBindings,
  aclSentence,
  balancerText,
  brokerStatus,
  configGroupOf,
  configLabel,
  configRows,
  configValueText,
  diskUsed,
  filterConfig,
  grantProblem,
  licenseSummary,
  parseBalancer,
  parseBrokers,
  parseConfigInput,
  parseConfigStatus,
  parseHealth,
  parseLicense,
  parseRoleMembers,
  parseRoles,
  parseSchema,
  parseTransforms,
  parseUsers,
  restartSummary,
  roleNameProblem,
  rp,
  rpErrorText,
  transformsDisabled,
  userNameProblem,
  type ConfigProp,
  type RpCall,
} from './admin'

// ---- measured on v26.2.6 ----
const BROKERS = [
  {
    node_id: 0,
    num_cores: 1,
    internal_rpc_address: '127.0.0.1',
    internal_rpc_port: 33145,
    membership_status: 'active',
    is_alive: true,
    recovery_mode_enabled: false,
    disk_space: [{ path: '/var/lib/redpanda/data', free: 1006523060224, total: 1081101176832 }],
    version: 'v26.2.6 - 06e1aca30b726c8de9dc9db5c2b83b4da8edf6d0',
    maintenance_status: { draining: false },
    in_fips_mode: 'disabled',
  },
]
const HEALTH = {
  is_healthy: true,
  unhealthy_reasons: [],
  controller_id: 0,
  all_nodes: [0],
  nodes_down: [],
  high_disk_usage_nodes: [],
  nodes_in_recovery_mode: [],
  leaderless_partitions: [],
  leaderless_count: 0,
  under_replicated_partitions: [],
  under_replicated_count: 0,
  bytes_in_cloud_storage: -1,
}
const SCHEMA = {
  properties: {
    log_retention_ms: {
      description: 'The amount of time to keep a log file before deleting it (in milliseconds).',
      nullable: true,
      needs_restart: false,
      visibility: 'user',
      is_secret: false,
      gets_restored: true,
      units: 'ms',
      type: 'integer',
      aliases: ['delete_retention_ms'],
      default_value: '604800000',
      is_enterprise: false,
    },
    audit_failure_policy: {
      description: 'Defines the policy for rejecting audit log messages when the audit log queue is full.',
      nullable: false,
      needs_restart: false,
      visibility: 'user',
      is_secret: false,
      gets_restored: true,
      type: 'string',
      enum_values: ['reject', 'permit'],
      default_value: '"reject"',
      is_enterprise: false,
    },
    abort_index_segment_size: {
      description: 'Capacity (in number of txns) of an abort index segment.',
      nullable: false,
      needs_restart: true,
      visibility: 'tunable',
      is_secret: false,
      gets_restored: true,
      type: 'integer',
      default_value: '50000',
      is_enterprise: false,
    },
    sasl_mechanisms: {
      description: 'A list of supported SASL mechanisms.',
      nullable: false,
      needs_restart: false,
      visibility: 'user',
      is_secret: false,
      type: 'array',
      items: { type: 'string', enum_values: ['GSSAPI', 'SCRAM', 'OAUTHBEARER', 'PLAIN'] },
      default_value: '["SCRAM"]',
      is_enterprise: false,
    },
    cloud_storage_secret_key: {
      description: 'Cloud provider secret key.',
      nullable: true,
      needs_restart: true,
      visibility: 'user',
      is_secret: true,
      type: 'string',
      default_value: 'null',
      is_enterprise: false,
    },
    auto_create_topics_enabled: {
      description: 'Allow automatic topic creation.',
      nullable: false,
      needs_restart: false,
      visibility: 'user',
      is_secret: false,
      type: 'boolean',
      default_value: 'false',
      is_enterprise: false,
    },
  },
}

describe('Redpanda parsers', () => {
  it('brokers, health, license and balancer read the measured shapes', () => {
    const [b] = parseBrokers(BROKERS)
    expect(b).toMatchObject({ id: 0, cores: 1, alive: true, version: 'v26.2.6', draining: false, address: '127.0.0.1:33145' })
    expect(Math.round((diskUsed(b) ?? 0) * 100)).toBe(7)
    expect(brokerStatus(b).label).toBe('Running')
    expect(brokerStatus({ ...b, draining: true }).label).toBe('In maintenance')
    expect(brokerStatus({ ...b, alive: false }).tone).toBe('bad')

    const h = parseHealth(HEALTH)!
    expect(h.healthy).toBe(true)
    expect(h.controllerId).toBe(0)
    expect(parseHealth({ nope: 1 })).toBeNull()

    const now = Date.UTC(2026, 9, 26)
    const lic = parseLicense({ loaded: true, license: { format_version: 0, org: 'Redpanda Built-In Evaluation Period', type: 'free_trial', expires: now / 1000 + 10 * 86400, sha256: '' } })!
    expect(licenseSummary(lic, now)).toMatchObject({ title: 'Trial', tone: 'warn' })
    expect(licenseSummary(lic, now).detail).toContain('Expires in 10 days')
    expect(licenseSummary({ ...lic, expires: now - 2 * 86400_000 }, now).tone).toBe('bad')
    expect(licenseSummary(null).title).toBe('Community edition')

    const bal = parseBalancer({ status: 'ready', violations: {}, seconds_since_last_tick: 1, current_reassignments_count: 0 })
    expect(balancerText(bal)).toBe('Ready — partitions are balanced')
    expect(balancerText(parseBalancer({ status: 'in_progress', current_reassignments_count: 4 }))).toBe('Moving partitions · 4 moving')
  })

  it('users, roles, members and transforms', () => {
    expect(parseUsers(['bob', 'alice'])).toEqual(['alice', 'bob'])
    expect(parseRoles({ roles: [{ name: 'readers' }] })).toEqual(['readers'])
    expect(parseRoleMembers({ name: 'readers', members: [{ name: 'bob', principal_type: 'User' }] })).toEqual([{ name: 'bob', type: 'User' }])
    expect(parseTransforms([])).toEqual([])
    const [t] = parseTransforms([
      { name: 'redact', input_topic: 'in', output_topics: ['out'], status: [{ node_id: 0, partition: 0, status: 'running', lag: 2 }, { node_id: 0, partition: 1, status: 'errored', lag: 0 }], environment: [{ key: 'A', value: '1' }] },
    ])
    expect(t).toMatchObject({ name: 'redact', input: 'in', outputs: ['out'], running: 1, errored: 1, lag: 2 })
  })

  it('names are checked before anything is sent', () => {
    expect(userNameProblem('', [])).toBeTruthy()
    expect(userNameProblem('alice smith', [])).toContain('letters')
    expect(userNameProblem('bob', ['bob'])).toContain('already exists')
    expect(userNameProblem('svc.billing@corp', [])).toBeNull()
    expect(roleNameProblem('readers', ['readers'])).toContain('already exists')
  })

  it('errors read like Redpanda writes them, unwrapped', () => {
    expect(rpErrorText({ status: 409, json: { message: '{"message":"Role already exists","code":40901}', code: 409 } })).toBe('Role already exists')
    expect(rpErrorText({ status: 500, json: { message: 'Unexpected cluster error: User already exists', code: 500 } })).toBe('User already exists')
    expect(rpErrorText({ status: 400, json: { log_retention_ms: 'expected type integer' } })).toBe('log_retention_ms: expected type integer')
    expect(rpErrorText({ status: 401, json: null })).toContain('Authentication failed')
    const off = { status: 400, json: { message: 'data transforms disabled - use `rpk cluster config set data_transforms_enabled true` to enable', code: 400 } }
    expect(transformsDisabled(off)).toBe(true)
    expect(transformsDisabled({ status: 200, json: [] })).toBe(false)
  })
})

describe('Cluster configuration', () => {
  const schema = parseSchema(SCHEMA)
  const byKey = (k: string) => schema.find((p) => p.key === k) as ConfigProp

  it('reads the schema: defaults decoded, groups, labels', () => {
    expect(byKey('log_retention_ms')).toMatchObject({ type: 'integer', units: 'ms', defaultValue: 604800000, nullable: true })
    expect(byKey('audit_failure_policy').defaultValue).toBe('reject')
    expect(byKey('sasl_mechanisms').itemEnum).toEqual(['GSSAPI', 'SCRAM', 'OAUTHBEARER', 'PLAIN'])
    expect(configGroupOf('log_retention_ms')).toBe('retention')
    expect(configGroupOf('sasl_mechanisms')).toBe('security')
    expect(configGroupOf('cloud_storage_secret_key')).toBe('tiered')
    expect(configGroupOf('kafka_batch_max_bytes')).toBe('clients')
    expect(configLabel('log_retention_ms')).toBe('Log retention')
    expect(configLabel('retention_bytes')).toBe('Retention size')
    expect(configLabel('storage_min_free_bytes')).toBe('Storage min free')
  })

  it('values in words', () => {
    expect(configValueText(byKey('log_retention_ms'), 604800000)).toBe('7 days')
    expect(configValueText(byKey('log_retention_ms'), -1)).toBe('No limit')
    expect(configValueText(byKey('log_retention_ms'), null)).toBe('Not set')
    expect(configValueText(byKey('auto_create_topics_enabled'), true)).toBe('On')
    expect(configValueText(byKey('sasl_mechanisms'), ['SCRAM', 'PLAIN'])).toBe('SCRAM, PLAIN')
    expect(configValueText(byKey('cloud_storage_secret_key'), 'abc')).toBe('(hidden)')
  })

  it('rows know what is changed; the filter hides tunables unless asked or changed', () => {
    const rows = configRows(schema, { log_retention_ms: 172800000, abort_index_segment_size: 50000 }, { log_retention_ms: 172800000 })
    expect(rows.find((r) => r.key === 'log_retention_ms')?.isSet).toBe(true)
    expect(rows.find((r) => r.key === 'audit_failure_policy')?.isSet).toBe(false)
    const plain = filterConfig(rows, { text: '', onlyChanged: false, advanced: false })
    expect(plain.some((r) => r.key === 'abort_index_segment_size')).toBe(false)
    expect(filterConfig(rows, { text: '', onlyChanged: false, advanced: true }).some((r) => r.key === 'abort_index_segment_size')).toBe(true)
    expect(filterConfig(rows, { text: 'abort index', onlyChanged: false, advanced: false }).map((r) => r.key)).toEqual(['abort_index_segment_size'])
    expect(filterConfig(rows, { text: '', onlyChanged: true, advanced: false }).map((r) => r.key)).toEqual(['log_retention_ms'])
  })

  it('typed input becomes the value to send, or a sentence', () => {
    expect(parseConfigInput(byKey('log_retention_ms'), '172800000')).toEqual({ value: 172800000 })
    expect(parseConfigInput(byKey('log_retention_ms'), '1.5')).toHaveProperty('error')
    expect(parseConfigInput(byKey('log_retention_ms'), '')).toEqual({ value: null })
    expect(parseConfigInput(byKey('auto_create_topics_enabled'), 'true')).toEqual({ value: true })
    expect(parseConfigInput(byKey('audit_failure_policy'), 'maybe')).toHaveProperty('error')
    expect(parseConfigInput(byKey('sasl_mechanisms'), 'SCRAM, PLAIN')).toEqual({ value: ['SCRAM', 'PLAIN'] })
    expect((parseConfigInput(byKey('sasl_mechanisms'), 'SCRAM, LDAP') as { error: string }).error).toContain('LDAP is not allowed')
  })

  it('restart status in a sentence', () => {
    const st = parseConfigStatus([{ node_id: 0, restart: true, config_version: 3, invalid: [], unknown: [], pending: [] }])
    expect(restartSummary(st)).toBe('Restart the broker for some changes to take effect.')
    expect(restartSummary(parseConfigStatus([{ node_id: 0, restart: false }]))).toBeNull()
  })
})

describe('Kafka ACLs in words', () => {
  it('presets create the bindings a reader / writer needs', () => {
    const consume = ACL_PRESETS.find((p) => p.id === 'consume')!
    const b = aclBindings('User:alice', '', 'ALLOW', consume.build('orders', 'LITERAL', 'billing'))
    expect(b.map((a) => `${a.resource_type}:${a.resource_name}:${a.operation}`)).toEqual(['TOPIC:orders:READ', 'TOPIC:orders:DESCRIBE', 'GROUP:billing:READ'])
    expect(b.every((a) => a.host === '*' && a.permission === 'ALLOW')).toBe(true)
    // a cluster grant always names kafka-cluster
    expect(aclBindings('User:a', '*', 'ALLOW', [{ resource_type: 'CLUSTER', resource_name: '', pattern_type: 'LITERAL', operation: 'CREATE' }])[0].resource_name).toBe('kafka-cluster')
  })

  it('each binding reads as a sentence', () => {
    expect(aclSentence({ resource_type: 'TOPIC', resource_name: 'orders-', pattern_type: 'PREFIXED', principal: 'User:alice', host: '*', operation: 'READ', permission: 'ALLOW' })).toBe(
      'Allow alice — read on topics starting with orders-',
    )
    expect(aclSentence({ resource_type: 'CLUSTER', resource_name: 'kafka-cluster', pattern_type: 'LITERAL', principal: 'RedpandaRole:ops', host: '10.0.0.5', operation: 'ALL', permission: 'DENY' })).toBe(
      'Deny role ops — everything on the cluster from 10.0.0.5',
    )
    expect(grantProblem('', 'orders', 'TOPIC', ['READ'])).toBeTruthy()
    expect(grantProblem('alice', '', 'TOPIC', ['READ'])).toContain('topic')
    expect(grantProblem('alice', '', 'CLUSTER', ['CREATE'])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Request fixture — replayed by src-tauri/tests/redpanda_integration.rs
// ---------------------------------------------------------------------------

interface Step extends RpCall {
  title: string
  expect: number[]
  contains?: string
}
const FIXTURE = 'src-tauri/tests/fixtures/redpanda-requests.json'
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

function buildSteps(): Step[] {
  const s = (title: string, c: RpCall, expect: number[], contains?: string): Step => ({ title, ...c, expect, ...(contains ? { contains } : {}) })
  const schema = parseSchema(SCHEMA)
  const retention = schema.find((p) => p.key === 'log_retention_ms')!
  const twoDays = parseConfigInput(retention, '172800000') as { value: unknown }
  return [
    s('detect: brokers', rp.brokers(), [200], 'version'),
    s('overview: health', rp.health(), [200], 'is_healthy'),
    s('overview: partition balancer', rp.balancer(), [200], 'status'),
    s('overview: license', rp.license(), [200], 'loaded'),
    s('configuration: schema', rp.configSchema(), [200], 'log_retention_ms'),
    s('configuration: values with defaults', rp.config(true), [200], 'log_retention_ms'),
    s('configuration: values set on the cluster', rp.config(false), [200], 'cluster_id'),
    s('configuration: status', rp.configStatus(), [200], 'config_version'),
    s('configuration: dry run refuses a wrong type', rp.setConfig({ log_retention_ms: 'two days' }, [], true), [400], 'expected type integer'),
    s('configuration: dry run accepts', rp.setConfig({ log_retention_ms: twoDays.value }, [], true), [200]),
    s('configuration: save', rp.setConfig({ log_retention_ms: twoDays.value }, []), [200], 'config_version'),
    s('configuration: reads back the saved value', rp.config(false), [200], '172800000'),
    s('configuration: back to the default', rp.setConfig({}, ['log_retention_ms']), [200], 'config_version'),
    s('users: create', rp.createUser('it_alice', 'Alice-Pass-123', 'SCRAM-SHA-256'), [200]),
    s('users: list', rp.users(), [200], 'it_alice'),
    // measured: the same name + the same password answers 200 (idempotent); another password is refused
    s('users: create again with the same password is accepted', rp.createUser('it_alice', 'Alice-Pass-123', 'SCRAM-SHA-256'), [200]),
    s('users: create again with another password is refused', rp.createUser('it_alice', 'Other-Pass-999', 'SCRAM-SHA-256'), [409, 500], 'already exists'),
    s('users: change password', rp.setPassword('it_alice', 'Alice-Pass-456', 'SCRAM-SHA-512'), [200]),
    s('roles: create', rp.createRole('it_readers'), [200, 201]),
    // measured: creating an empty role again is idempotent; once it has members it is refused
    s('roles: create again while empty is accepted', rp.createRole('it_readers'), [200, 201]),
    s('roles: add a member', rp.roleMembers('it_readers', ['it_alice'], []), [200]),
    s('roles: create again with members is refused', rp.createRole('it_readers'), [409], 'already exists'),
    s('roles: role with its members', rp.role('it_readers'), [200], 'it_alice'),
    s('roles: list', rp.roles(), [200], 'it_readers'),
    s('roles: remove the member', rp.roleMembers('it_readers', [], ['it_alice']), [200]),
    s('roles: delete with its ACLs', rp.deleteRole('it_readers', true), [200, 204]),
    s('users: delete', rp.deleteUser('it_alice'), [200, 204]),
    s('brokers: maintenance on a single node is refused', rp.maintenanceOn(0), [400], 'single node'),
    s('transforms: list (or switched off)', rp.transforms(), [200, 400]),
    s('transforms: delete an unknown one', rp.deleteTransform('it-none'), [200, 400, 404]),
  ]
}

describe('Redpanda request fixture', () => {
  it('matches the requests the screens send (rewrite with WRITE_RP_FIXTURE=1)', async () => {
    // ACL bindings the grant dialog creates: the consume preset (prefixed topic, one
    // group) + a cluster grant to a Redpanda role
    const acls = [
      ...aclBindings('User:it_bob', '*', 'ALLOW', ACL_PRESETS.find((p) => p.id === 'consume')!.build('it-orders-', 'PREFIXED', 'it-billing')),
      ...aclBindings('RedpandaRole:it_ops', '*', 'DENY', [{ resource_type: 'CLUSTER', resource_name: '', pattern_type: 'LITERAL', operation: 'ALTER_CONFIGS' }]),
    ]
    const text = JSON.stringify({ steps: buildSteps(), acls }, null, 2) + '\n'
    if (env.WRITE_RP_FIXTURE === '1') {
      const fsName = 'node:fs'
      const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync: (p: string, d: string) => void }
      fs.writeFileSync(FIXTURE, text)
      return
    }
    expect(fixtureText.replace(/\r\n/g, '\n')).toBe(text)
  })
})
