// Redpanda demo (opt-in `?redpanda=1`) — a Kafka-engine connection whose server is
// Redpanda (SPEC-REDPANDA.md). Topics, messages and consumer groups come from the
// shared Kafka mock; this file serves the Admin API (same shapes as measured on
// v26.2.6) and Kafka ACLs, with state, so creating a user / changing a setting /
// adding an ACL changes what the next read returns.
//
// Seams: `?redpanda=down` — broker 3 is down (cluster unhealthy);
//        `?redpandaTransforms=off` — data transforms are disabled (the default 400).

import type { KafkaAcl, RpResponse } from '$lib/ipc'

export const RP_DEMO_ID = 'rp1'
export const RP_DEMO_VERSION = 'v26.2.6'

function param(name: string): string | null {
  return typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(name)
}
export function redpandaDemoEnabled(): boolean {
  const v = param('redpanda')
  return v === '1' || v === 'down'
}
export function isRedpandaDemo(args: Record<string, unknown> | undefined): boolean {
  const id = String(args?.connId ?? '')
  return id === RP_DEMO_ID || id.startsWith(`${RP_DEMO_ID}#`) || id.startsWith(`${RP_DEMO_ID}::`)
}

// ---- schema (a faithful subset of /v1/cluster_config/schema) ----
type Prop = Record<string, unknown>
const P = (type: string, def: unknown, description: string, extra: Prop = {}): Prop => ({
  description,
  nullable: false,
  needs_restart: false,
  visibility: 'user',
  is_secret: false,
  gets_restored: true,
  type,
  default_value: JSON.stringify(def),
  is_enterprise: false,
  ...extra,
})
const SCHEMA: Record<string, Prop> = {
  log_retention_ms: P('integer', 604800000, 'The amount of time to keep a log file before deleting it (in milliseconds). If set to `-1`, no time limit is applied.', { units: 'ms', nullable: true }),
  retention_bytes: P('integer', null, 'Default maximum number of bytes per partition on disk before triggering deletion of the oldest messages.', { nullable: true }),
  log_segment_size: P('integer', 134217728, 'Default log segment size in bytes for topics which do not set segment.bytes.', { minimum: 1048576 }),
  log_cleanup_policy: P('string', 'delete', 'Default cleanup policy for topic logs.', { enum_values: ['delete', 'compact', 'compact,delete'] }),
  log_compaction_interval_ms: P('integer', 10000, 'How often to trigger background compaction.', { units: 'ms', visibility: 'tunable' }),
  storage_min_free_bytes: P('integer', 5368709120, 'Threshold of minimum bytes free space before rejecting producers.'),
  default_topic_partitions: P('integer', 1, 'Default number of partitions per topic.', { minimum: 1 }),
  default_topic_replications: P('integer', 1, 'Default replication factor for new topics.', { minimum: 1 }),
  auto_create_topics_enabled: P('boolean', false, 'Allow automatic topic creation when a client produces to a topic that does not exist.'),
  kafka_batch_max_bytes: P('integer', 1048576, 'Maximum size of a batch processed by the server.'),
  kafka_connections_max: P('integer', null, 'Maximum number of Kafka client connections per broker.', { nullable: true }),
  group_max_session_timeout_ms: P('integer', 300000, 'The maximum allowed session timeout for registered consumers.', { units: 'ms' }),
  enable_transactions: P('boolean', true, 'Enable support for transactions.', { needs_restart: true }),
  transaction_coordinator_delete_retention_ms: P('integer', 604800000, 'Delete segments older than this.', { units: 'ms', visibility: 'tunable' }),
  raft_heartbeat_interval_ms: P('integer', 150, 'Milliseconds for raft leader heartbeats.', { units: 'ms', visibility: 'tunable', needs_restart: true }),
  partition_autobalancing_mode: P('string', 'node_add', 'Mode of partition balancing for the cluster.', { enum_values: ['off', 'node_add', 'continuous'] }),
  enable_sasl: P('boolean', false, 'Enable SASL authentication for Kafka connections.'),
  kafka_enable_authorization: P('boolean', null, 'Flag to require authorization for Kafka connections.', { nullable: true }),
  superusers: P('array', [], 'List of superuser usernames.', { items: { type: 'string' } }),
  sasl_mechanisms: P('array', ['SCRAM'], 'A list of supported SASL mechanisms.', { items: { type: 'string', enum_values: ['GSSAPI', 'SCRAM', 'OAUTHBEARER', 'PLAIN'] } }),
  admin_api_require_auth: P('boolean', false, 'Whether Admin API clients must provide HTTP basic authentication headers.'),
  cloud_storage_enabled: P('boolean', false, 'Enable object storage.', { needs_restart: true, is_enterprise: true }),
  cloud_storage_secret_key: P('string', null, 'Cloud provider secret key.', { nullable: true, is_secret: true, needs_restart: true }),
  schema_registry_normalize_on_startup: P('boolean', false, 'Normalize schemas as they are read from the topic on startup.', { needs_restart: true }),
  data_transforms_enabled: P('boolean', false, 'Enables WebAssembly-powered data transforms directly in the broker.', { needs_restart: true }),
  audit_enabled: P('boolean', false, 'Enables or disables audit logging.', { is_enterprise: true }),
}

// ---- state ----
const state = {
  users: ['analytics', 'billing-svc', 'admin'],
  roles: new Map<string, string[]>([
    ['readers', ['analytics']],
    ['ops', ['admin']],
  ]),
  /** explicitly set config values (not defaults) */
  config: new Map<string, unknown>([
    ['log_retention_ms', 259200000],
    ['default_topic_partitions', 3],
    ['default_topic_replications', 3],
    ['enable_sasl', true],
    ['superusers', ['admin']],
    ['data_transforms_enabled', true],
  ]),
  configVersion: 7,
  restart: false,
  draining: new Set<number>(),
  transforms: [
    {
      name: 'redact-pii',
      input_topic: 'orders',
      output_topics: ['orders-clean'],
      status: [
        { node_id: 1, partition: 0, status: 'running', lag: 0 },
        { node_id: 2, partition: 1, status: 'running', lag: 3 },
        { node_id: 3, partition: 2, status: 'running', lag: 0 },
      ],
      environment: [{ key: 'MASK', value: 'email,phone' }],
    },
  ],
}

export let demoAcls: KafkaAcl[] = [
  { resource_type: 'TOPIC', resource_name: 'orders', pattern_type: 'LITERAL', principal: 'User:analytics', host: '*', operation: 'READ', permission: 'ALLOW' },
  { resource_type: 'TOPIC', resource_name: 'orders', pattern_type: 'LITERAL', principal: 'User:analytics', host: '*', operation: 'DESCRIBE', permission: 'ALLOW' },
  { resource_type: 'GROUP', resource_name: 'analytics-', pattern_type: 'PREFIXED', principal: 'User:analytics', host: '*', operation: 'READ', permission: 'ALLOW' },
  { resource_type: 'TOPIC', resource_name: 'payments', pattern_type: 'LITERAL', principal: 'User:billing-svc', host: '*', operation: 'WRITE', permission: 'ALLOW' },
  { resource_type: 'TOPIC', resource_name: 'payments', pattern_type: 'LITERAL', principal: 'RedpandaRole:readers', host: '*', operation: 'READ', permission: 'ALLOW' },
  { resource_type: 'CLUSTER', resource_name: 'kafka-cluster', pattern_type: 'LITERAL', principal: 'User:admin', host: '*', operation: 'ALL', permission: 'ALLOW' },
]

const res = (status: number, json: unknown = null): RpResponse => ({ status, ok: status >= 200 && status < 300, json, text: null, took_ms: 3 })
const err = (status: number, message: string) => res(status, { message, code: status })

function brokers() {
  const down = param('redpanda') === 'down'
  return [1, 2, 3].map((id) => ({
    node_id: id,
    num_cores: 4,
    internal_rpc_address: `redpanda-${id - 1}`,
    internal_rpc_port: 33145,
    membership_status: 'active',
    is_alive: !(down && id === 3),
    recovery_mode_enabled: false,
    disk_space: [{ path: '/var/lib/redpanda/data', free: id === 2 ? 64e9 : 412e9, total: 500e9 }],
    version: `${RP_DEMO_VERSION} - 06e1aca30b726c8de9dc9db5c2b83b4da8edf6d0`,
    maintenance_status: { draining: state.draining.has(id), finished: state.draining.has(id) },
    in_fips_mode: 'disabled',
  }))
}

function health() {
  const down = param('redpanda') === 'down'
  return {
    is_healthy: !down,
    unhealthy_reasons: down ? ['nodes_down', 'under_replicated_partitions'] : [],
    controller_id: 1,
    all_nodes: [1, 2, 3],
    nodes_down: down ? [3] : [],
    high_disk_usage_nodes: [],
    nodes_in_recovery_mode: [],
    leaderless_partitions: [],
    leaderless_count: 0,
    under_replicated_partitions: [],
    under_replicated_count: down ? 6 : 0,
    bytes_in_cloud_storage: -1,
  }
}

function defaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, p] of Object.entries(SCHEMA)) out[k] = JSON.parse(String(p.default_value))
  return out
}

function checkType(key: string, v: unknown): string | null {
  const p = SCHEMA[key]
  if (!p) return 'unknown property'
  if (v === null) return p.nullable ? null : 'expected non-null value'
  switch (p.type) {
    case 'integer':
      return Number.isInteger(v) ? null : 'expected type integer'
    case 'boolean':
      return typeof v === 'boolean' ? null : 'expected type boolean'
    case 'array':
      return Array.isArray(v) ? null : 'expected type array'
    default:
      if (Array.isArray(p.enum_values) && !p.enum_values.includes(v)) return `expected one of ${p.enum_values.join(', ')}`
      return typeof v === 'string' ? null : 'expected type string'
  }
}

function admin(method: string, rawPath: string, body: string | null): RpResponse {
  const [path, query = ''] = rawPath.split('?')
  const q = new URLSearchParams(query)
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent) // ['v1', …]
  const data = body ? (JSON.parse(body) as Record<string, unknown>) : {}
  const m = method.toUpperCase()

  if (path === '/v1/brokers' && m === 'GET') return res(200, brokers())
  if (parts[1] === 'brokers' && parts[3] === 'maintenance') {
    const id = Number(parts[2])
    if (m === 'PUT') {
      if (state.draining.size > 0 && !state.draining.has(id)) return err(400, 'Another node is already in maintenance mode')
      state.draining.add(id)
      return res(200)
    }
    if (m === 'DELETE') {
      state.draining.delete(id)
      return res(200)
    }
  }
  if (path === '/v1/cluster/health_overview') return res(200, health())
  if (path === '/v1/cluster/partition_balancer/status')
    return res(200, { status: 'ready', violations: {}, seconds_since_last_tick: 2, current_reassignments_count: 0, partitions_pending_force_recovery_count: 0 })
  if (path === '/v1/features/license')
    return res(200, { loaded: true, license: { format_version: 0, org: 'Redpanda Built-In Evaluation Period', type: 'free_trial', expires: Math.floor(Date.now() / 1000) + 21 * 86400, sha256: '' } })

  // ---- cluster config ----
  if (path === '/v1/cluster_config/schema') return res(200, { properties: SCHEMA })
  if (path === '/v1/cluster_config/status') return res(200, [1, 2, 3].map((id) => ({ node_id: id, restart: state.restart, config_version: state.configVersion, invalid: [], unknown: [], pending: [] })))
  if (path === '/v1/cluster_config' && m === 'GET') {
    const explicit = Object.fromEntries(state.config)
    return res(200, q.get('include_defaults') === 'false' ? explicit : { ...defaults(), ...explicit })
  }
  if (path === '/v1/cluster_config' && m === 'PUT') {
    const upsert = (data.upsert ?? {}) as Record<string, unknown>
    const remove = (data.remove ?? []) as string[]
    const errors: Record<string, string> = {}
    for (const [k, v] of Object.entries(upsert)) {
      const e = checkType(k, v)
      if (e) errors[k] = e
    }
    if (Object.keys(errors).length) return res(400, errors)
    if (q.get('dry_run') === 'true') return res(200, {})
    for (const [k, v] of Object.entries(upsert)) state.config.set(k, v)
    for (const k of remove) state.config.delete(k)
    state.configVersion++
    if ([...Object.keys(upsert), ...remove].some((k) => SCHEMA[k]?.needs_restart)) state.restart = true
    return res(200, { config_version: state.configVersion })
  }

  // ---- users ----
  if (path === '/v1/security/users' && m === 'GET') return res(200, [...state.users])
  if (path === '/v1/security/users' && m === 'POST') {
    const u = String(data.username ?? '')
    if (state.users.includes(u)) return err(500, 'Unexpected cluster error: User already exists')
    state.users.push(u)
    return res(200)
  }
  if (parts[1] === 'security' && parts[2] === 'users' && parts[3]) {
    const u = parts[3]
    if (!state.users.includes(u)) return err(404, 'User does not exist')
    if (m === 'PUT') return res(200)
    if (m === 'DELETE') {
      state.users = state.users.filter((x) => x !== u)
      for (const mem of state.roles.values()) {
        const i = mem.indexOf(u)
        if (i >= 0) mem.splice(i, 1)
      }
      return res(200)
    }
  }

  // ---- roles ----
  if (path === '/v1/security/roles' && m === 'GET') return res(200, { roles: [...state.roles.keys()].map((name) => ({ name })) })
  if (path === '/v1/security/roles' && m === 'POST') {
    const r = String(data.role ?? '')
    // measured: an empty role can be created again (201); one with members is refused
    if ((state.roles.get(r) ?? []).length) return err(409, JSON.stringify({ message: 'Role already exists', code: 40901 }))
    if (state.roles.has(r)) return res(201, { role: r })
    state.roles.set(r, [])
    return res(201, { role: r })
  }
  if (parts[1] === 'security' && parts[2] === 'roles' && parts[3]) {
    const r = parts[3]
    const members = state.roles.get(r)
    if (parts[4] === 'members') {
      if (!members) return err(404, 'Role not found')
      if (m === 'GET') return res(200, { members: members.map((name) => ({ name, principal_type: 'User' })) })
      const add = ((data.add ?? []) as { name: string }[]).map((x) => x.name)
      const rem = ((data.remove ?? []) as { name: string }[]).map((x) => x.name)
      state.roles.set(r, [...members.filter((x) => !rem.includes(x)), ...add.filter((x) => !members.includes(x))])
      return res(200, { role: r, added: add.map((name) => ({ name, principal_type: 'User' })), removed: rem.map((name) => ({ name, principal_type: 'User' })) })
    }
    if (m === 'GET') return members ? res(200, { name: r, members: members.map((name) => ({ name, principal_type: 'User' })) }) : err(404, 'Role not found')
    if (m === 'DELETE') {
      state.roles.delete(r)
      if (q.get('delete_acls') === 'true') demoAcls = demoAcls.filter((a) => a.principal !== `RedpandaRole:${r}`)
      return res(204)
    }
  }

  // ---- transforms ----
  if (parts[1] === 'transform') {
    if (param('redpandaTransforms') === 'off' || state.config.get('data_transforms_enabled') !== true)
      return err(400, 'data transforms disabled - use `rpk cluster config set data_transforms_enabled true` to enable')
    if (path === '/v1/transform' && m === 'GET') return res(200, state.transforms)
    if (m === 'DELETE' && parts[2]) {
      // measured: deleting an unknown transform also answers 200
      state.transforms = state.transforms.filter((t) => t.name !== parts[2])
      return res(200)
    }
  }
  return err(404, `Not found: ${m} ${path}`)
}

const matches = (a: KafkaAcl, f: Partial<KafkaAcl>) =>
  (!f.resource_type || f.resource_type === 'ANY' || f.resource_type === a.resource_type) &&
  (!f.resource_name || f.resource_name === a.resource_name) &&
  (!f.pattern_type || f.pattern_type === 'ANY' || f.pattern_type === a.pattern_type) &&
  (!f.principal || f.principal === a.principal) &&
  (!f.host || f.host === a.host) &&
  (!f.operation || f.operation === 'ANY' || f.operation === a.operation) &&
  (!f.permission || f.permission === 'ANY' || f.permission === a.permission)

/** Redpanda + Kafka ACL commands, or undefined when the command is not ours. */
export function redpandaDemo(cmd: string, args: Record<string, unknown>): unknown {
  switch (cmd) {
    case 'redpanda_server_info':
      return isRedpandaDemo(args)
        ? { flavor: 'redpanda', version: RP_DEMO_VERSION, label: `Redpanda ${RP_DEMO_VERSION}`, brokers: 3 }
        : { flavor: 'kafka', version: '', label: 'Apache Kafka', brokers: 0 }
    case 'redpanda_admin_request':
      if (!isRedpandaDemo(args)) throw new Error('Cannot reach the Redpanda Admin API at http://kafka-1:9644 — check the Admin API URL (port 9644)')
      return admin(String(args.method ?? 'GET'), String(args.path ?? '/'), (args.body as string | null) ?? null)
    case 'kafka_acls': {
      const f = (args.filter ?? {}) as Partial<KafkaAcl>
      return demoAcls.filter((a) => matches(a, f)).map((a) => ({ ...a }))
    }
    case 'kafka_create_acls': {
      const add = (args.acls ?? []) as KafkaAcl[]
      for (const a of add) {
        if (a.resource_type === 'CLUSTER' && a.resource_name !== 'kafka-cluster') throw new Error('Name the resource (topic, group, transactional id) — or kafka-cluster for CLUSTER')
        if (!demoAcls.some((x) => JSON.stringify(x) === JSON.stringify(a))) demoAcls.push({ ...a })
      }
      return add.length
    }
    case 'kafka_delete_acls': {
      const filters = (args.filters ?? []) as Partial<KafkaAcl>[]
      const removed = demoAcls.filter((a) => filters.some((f) => matches(a, f)))
      demoAcls = demoAcls.filter((a) => !removed.includes(a))
      return removed
    }
  }
  return undefined
}
