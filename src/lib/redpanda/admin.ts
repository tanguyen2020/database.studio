// Redpanda Admin API in plain language (SPEC-REDPANDA.md). Every screen of the
// Redpanda workspace is built from these pure pieces:
//  - request builders (`rp.*`) — one method + path + body per action, so the vitest
//    fixture and the Rust integration test replay exactly what the app sends;
//  - parsers that turn the measured v26.2.6 shapes into what the screens show;
//  - cluster configuration as a grouped, searchable form (schema + values);
//  - Kafka ACLs in words, with presets ("Consume from a topic", …).

import type { KafkaAcl, RpResponse } from '$lib/ipc'
import { formatBytes, humanDuration } from '$lib/stream/humanize'

export type RpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'
export interface RpCall {
  method: RpMethod
  path: string
  body?: string
}

const seg = (s: string) => encodeURIComponent(s)
const call = (method: RpMethod, path: string, body?: unknown): RpCall =>
  body === undefined ? { method, path } : { method, path, body: JSON.stringify(body) }

export type ScramAlgorithm = 'SCRAM-SHA-256' | 'SCRAM-SHA-512'
export const SCRAM_ALGORITHMS: ScramAlgorithm[] = ['SCRAM-SHA-256', 'SCRAM-SHA-512']

/** Every Admin API call the workspace makes. */
export const rp = {
  brokers: () => call('GET', '/v1/brokers'),
  health: () => call('GET', '/v1/cluster/health_overview'),
  balancer: () => call('GET', '/v1/cluster/partition_balancer/status'),
  license: () => call('GET', '/v1/features/license'),
  maintenanceOn: (id: number) => call('PUT', `/v1/brokers/${id}/maintenance`),
  maintenanceOff: (id: number) => call('DELETE', `/v1/brokers/${id}/maintenance`),
  configSchema: () => call('GET', '/v1/cluster_config/schema'),
  config: (includeDefaults: boolean) => call('GET', `/v1/cluster_config?include_defaults=${includeDefaults}`),
  configStatus: () => call('GET', '/v1/cluster_config/status'),
  setConfig: (upsert: Record<string, unknown>, remove: string[], dryRun = false) =>
    call('PUT', `/v1/cluster_config${dryRun ? '?dry_run=true' : ''}`, { upsert, remove }),
  users: () => call('GET', '/v1/security/users'),
  createUser: (username: string, password: string, algorithm: ScramAlgorithm) =>
    call('POST', '/v1/security/users', { username, password, algorithm }),
  setPassword: (username: string, password: string, algorithm: ScramAlgorithm) =>
    call('PUT', `/v1/security/users/${seg(username)}`, { username, password, algorithm }),
  deleteUser: (username: string) => call('DELETE', `/v1/security/users/${seg(username)}`),
  roles: () => call('GET', '/v1/security/roles'),
  role: (name: string) => call('GET', `/v1/security/roles/${seg(name)}`),
  createRole: (name: string) => call('POST', '/v1/security/roles', { role: name }),
  /** `delete_acls`: also remove the ACLs granted to `RedpandaRole:<name>` */
  deleteRole: (name: string, deleteAcls: boolean) =>
    call('DELETE', `/v1/security/roles/${seg(name)}${deleteAcls ? '?delete_acls=true' : ''}`),
  roleMembers: (name: string, add: string[], remove: string[]) =>
    call('POST', `/v1/security/roles/${seg(name)}/members`, {
      add: add.map((n) => ({ name: n, principal_type: 'User' })),
      remove: remove.map((n) => ({ name: n, principal_type: 'User' })),
    }),
  transforms: () => call('GET', '/v1/transform'),
  deleteTransform: (name: string) => call('DELETE', `/v1/transform/${seg(name)}`),
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Same rules as the backend `describe_admin_error`: Redpanda's message, unwrapped. */
export function rpErrorText(r: Pick<RpResponse, 'status' | 'json' | 'text'>): string {
  if (r.status === 401) return 'Authentication failed — check the SASL user and password (the Admin API requires them)'
  const j = (r.json ?? null) as Record<string, unknown> | null
  const msg = j && typeof j.message === 'string' ? unwrapMessage(j.message) : null
  if (r.status === 403) return `Not allowed — ${msg ?? 'the user is not a superuser'}`
  if (msg) return msg
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    const parts = Object.entries(j)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => `${k}: ${v}`)
    if (parts.length) return parts.join(' · ')
  }
  const t = (r.text ?? '').trim()
  return t ? `Redpanda Admin API ${r.status}: ${t.slice(0, 300)}` : `Redpanda Admin API ${r.status}`
}

function unwrapMessage(m: string): string {
  let inner = m
  try {
    const v = JSON.parse(m) as { message?: unknown }
    if (v && typeof v.message === 'string') inner = v.message
  } catch {
    /* not nested */
  }
  return inner.replace(/^Unexpected cluster error: /, '')
}

/** Data transforms are switched off: the API says so with a 400. */
export function transformsDisabled(r: Pick<RpResponse, 'status' | 'json'>): boolean {
  const m = (r.json as { message?: unknown } | null)?.message
  return r.status === 400 && typeof m === 'string' && m.includes('data transforms disabled')
}

// ---------------------------------------------------------------------------
// Health, brokers, license, balancer
// ---------------------------------------------------------------------------

export interface RpHealth {
  healthy: boolean
  reasons: string[]
  controllerId: number | null
  nodes: number[]
  nodesDown: number[]
  highDisk: number[]
  recoveryMode: number[]
  leaderless: number
  underReplicated: number
}

const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [])

export function parseHealth(json: unknown): RpHealth | null {
  const j = json as Record<string, unknown> | null
  if (!j || typeof j !== 'object' || typeof j.is_healthy !== 'boolean') return null
  return {
    healthy: j.is_healthy,
    reasons: Array.isArray(j.unhealthy_reasons) ? j.unhealthy_reasons.map(String) : [],
    controllerId: typeof j.controller_id === 'number' && j.controller_id >= 0 ? j.controller_id : null,
    nodes: nums(j.all_nodes),
    nodesDown: nums(j.nodes_down),
    highDisk: nums(j.high_disk_usage_nodes),
    recoveryMode: nums(j.nodes_in_recovery_mode),
    leaderless: typeof j.leaderless_count === 'number' ? j.leaderless_count : 0,
    underReplicated: typeof j.under_replicated_count === 'number' ? j.under_replicated_count : 0,
  }
}

const REASONS: Record<string, string> = {
  nodes_down: 'some brokers are down',
  leaderless_partitions: 'some partitions have no leader',
  under_replicated_partitions: 'some partitions are missing copies',
  high_disk_usage_nodes: 'some brokers are running out of disk',
  nodes_in_recovery_mode: 'some brokers are in recovery mode',
  no_elected_controller: 'no controller is elected',
  no_health_report: 'the controller has no health report yet',
}
export function reasonText(r: string): string {
  return REASONS[r] ?? r.replace(/_/g, ' ')
}

export interface RpBroker {
  id: number
  cores: number | null
  alive: boolean
  membership: string
  draining: boolean
  /** "v26.2.6" */
  version: string
  diskFree: number | null
  diskTotal: number | null
  address: string
  recovery: boolean
}

export function parseBrokers(json: unknown): RpBroker[] {
  if (!Array.isArray(json)) return []
  return json
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && typeof (b as { node_id?: unknown }).node_id === 'number')
    .map((b) => {
      const disks = Array.isArray(b.disk_space) ? (b.disk_space as { free?: number; total?: number }[]) : []
      const free = disks.reduce((s, d) => s + (d.free ?? 0), 0)
      const total = disks.reduce((s, d) => s + (d.total ?? 0), 0)
      const m = b.maintenance_status as { draining?: boolean } | undefined
      return {
        id: b.node_id as number,
        cores: typeof b.num_cores === 'number' ? b.num_cores : null,
        alive: b.is_alive !== false,
        membership: typeof b.membership_status === 'string' ? b.membership_status : 'active',
        draining: !!m?.draining,
        version: typeof b.version === 'string' ? b.version.split(' - ')[0].trim() : '',
        diskFree: disks.length ? free : null,
        diskTotal: disks.length ? total : null,
        address: typeof b.internal_rpc_address === 'string' ? `${b.internal_rpc_address}${typeof b.internal_rpc_port === 'number' ? `:${b.internal_rpc_port}` : ''}` : '',
        recovery: b.recovery_mode_enabled === true,
      }
    })
    .sort((a, b) => a.id - b.id)
}

/** Disk used as a share 0..1, or null when the broker did not say. */
export function diskUsed(b: RpBroker): number | null {
  if (b.diskTotal == null || b.diskFree == null || b.diskTotal <= 0) return null
  return Math.min(1, Math.max(0, 1 - b.diskFree / b.diskTotal))
}

export function brokerStatus(b: RpBroker): { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (!b.alive) return { label: 'Down', tone: 'bad' }
  if (b.draining) return { label: 'In maintenance', tone: 'warn' }
  if (b.membership === 'draining') return { label: 'Being removed', tone: 'warn' }
  if (b.membership === 'removed') return { label: 'Removed', tone: 'muted' }
  if (b.recovery) return { label: 'Recovery mode', tone: 'warn' }
  return { label: 'Running', tone: 'ok' }
}

export interface RpLicense {
  loaded: boolean
  org: string
  /** "free_trial" | "enterprise" | … */
  type: string
  /** expiry, epoch milliseconds */
  expires: number | null
}

export function parseLicense(json: unknown): RpLicense | null {
  const j = json as { loaded?: boolean; license?: { org?: string; type?: string; expires?: number } } | null
  if (!j || typeof j !== 'object' || typeof j.loaded !== 'boolean') return null
  const l = j.license ?? {}
  return { loaded: j.loaded, org: l.org ?? '', type: l.type ?? '', expires: typeof l.expires === 'number' && l.expires > 0 ? l.expires * 1000 : null }
}

export function licenseSummary(l: RpLicense | null, now = Date.now()): { title: string; detail: string; tone: 'ok' | 'warn' | 'bad' | 'muted' } {
  if (!l || !l.loaded) return { title: 'Community edition', detail: 'No enterprise license is loaded — enterprise features stay off.', tone: 'muted' }
  const type = l.type === 'free_trial' ? 'Trial' : l.type === 'enterprise' ? 'Enterprise' : l.type ? l.type.replace(/_/g, ' ') : 'License'
  if (l.expires == null) return { title: type, detail: l.org || 'License loaded', tone: 'ok' }
  const days = Math.floor((l.expires - now) / 86_400_000)
  if (days < 0) return { title: `${type} — expired`, detail: `Expired ${-days} day${days === -1 ? '' : 's'} ago${l.org ? ` · ${l.org}` : ''}`, tone: 'bad' }
  return { title: type, detail: `${days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`}${l.org ? ` · ${l.org}` : ''}`, tone: days <= 14 ? 'warn' : 'ok' }
}

export interface RpBalancer {
  status: string
  reassignments: number
  violations: number
}
export function parseBalancer(json: unknown): RpBalancer | null {
  const j = json as { status?: string; current_reassignments_count?: number; violations?: Record<string, unknown[]> } | null
  if (!j || typeof j.status !== 'string') return null
  const violations = Object.values(j.violations ?? {}).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0)
  return { status: j.status, reassignments: j.current_reassignments_count ?? 0, violations }
}
const BALANCER: Record<string, string> = {
  ready: 'Ready — partitions are balanced',
  in_progress: 'Moving partitions',
  starting: 'Starting',
  stalled: 'Stalled — cannot move partitions',
  off: 'Off',
}
export function balancerText(b: RpBalancer | null): string {
  if (!b) return 'Unknown'
  const base = BALANCER[b.status] ?? b.status.replace(/_/g, ' ')
  return b.reassignments > 0 ? `${base} · ${b.reassignments} moving` : base
}

// ---------------------------------------------------------------------------
// Users, roles, transforms
// ---------------------------------------------------------------------------

export function parseUsers(json: unknown): string[] {
  return Array.isArray(json) ? json.map(String).sort((a, b) => a.localeCompare(b)) : []
}
export function parseRoles(json: unknown): string[] {
  const roles = (json as { roles?: { name?: string }[] } | null)?.roles
  return Array.isArray(roles) ? roles.map((r) => String(r.name ?? '')).filter(Boolean).sort((a, b) => a.localeCompare(b)) : []
}
export interface RpRoleMember {
  name: string
  type: string
}
export function parseRoleMembers(json: unknown): RpRoleMember[] {
  const m = (json as { members?: { name?: string; principal_type?: string }[] } | null)?.members
  return Array.isArray(m) ? m.map((x) => ({ name: String(x.name ?? ''), type: String(x.principal_type ?? 'User') })).filter((x) => x.name) : []
}

/** A SCRAM user name Redpanda accepts (letters, digits and . _ @ -). */
export function userNameProblem(name: string, taken: string[]): string | null {
  const n = name.trim()
  if (!n) return 'Enter a user name.'
  if (!/^[A-Za-z0-9._@-]+$/.test(n)) return 'Use letters, digits and . _ @ - only.'
  if (taken.includes(n)) return `A user named ${n} already exists.`
  return null
}
export function roleNameProblem(name: string, taken: string[]): string | null {
  const n = name.trim()
  if (!n) return 'Enter a role name.'
  if (!/^[A-Za-z0-9._-]+$/.test(n)) return 'Use letters, digits and . _ - only.'
  if (taken.includes(n)) return `A role named ${n} already exists.`
  return null
}
export function passwordProblem(p: string): string | null {
  if (p.length < 8) return 'Use at least 8 characters.'
  return null
}

export interface RpTransform {
  name: string
  input: string
  outputs: string[]
  running: number
  errored: number
  lag: number
  env: { key: string; value: string }[]
}
export function parseTransforms(json: unknown): RpTransform[] {
  if (!Array.isArray(json)) return []
  return json.map((t: Record<string, unknown>) => {
    const status = Array.isArray(t.status) ? (t.status as { status?: string; lag?: number }[]) : []
    return {
      name: String(t.name ?? ''),
      input: String(t.input_topic ?? ''),
      outputs: Array.isArray(t.output_topics) ? t.output_topics.map(String) : [],
      running: status.filter((s) => s.status === 'running').length,
      errored: status.filter((s) => s.status === 'errored').length,
      lag: status.reduce((s, x) => s + (typeof x.lag === 'number' ? x.lag : 0), 0),
      env: Array.isArray(t.environment) ? (t.environment as { key?: string; value?: string }[]).map((e) => ({ key: String(e.key ?? ''), value: String(e.value ?? '') })) : [],
    }
  })
}

// ---------------------------------------------------------------------------
// Cluster configuration
// ---------------------------------------------------------------------------

export interface ConfigProp {
  key: string
  description: string
  type: 'integer' | 'number' | 'boolean' | 'string' | 'array' | string
  units: string | null
  defaultValue: unknown
  nullable: boolean
  needsRestart: boolean
  /** "user" (shown) or "tunable" (advanced) */
  visibility: string
  secret: boolean
  enterprise: boolean
  enumValues: string[] | null
  itemEnum: string[] | null
  minimum: number | null
  maximum: number | null
  example: string | null
}

export function parseSchema(json: unknown): ConfigProp[] {
  const props = (json as { properties?: Record<string, Record<string, unknown>> } | null)?.properties
  if (!props || typeof props !== 'object') return []
  return Object.entries(props)
    .map(([key, p]) => {
      let def: unknown = p.default_value
      if (typeof def === 'string') {
        try {
          def = JSON.parse(def)
        } catch {
          /* plain text default */
        }
      }
      const items = p.items as { enum_values?: unknown } | undefined
      return {
        key,
        description: String(p.description ?? ''),
        type: String(p.type ?? 'string'),
        units: typeof p.units === 'string' ? p.units : null,
        defaultValue: def,
        nullable: p.nullable === true,
        needsRestart: p.needs_restart === true,
        visibility: String(p.visibility ?? 'user'),
        secret: p.is_secret === true,
        enterprise: p.is_enterprise === true,
        enumValues: Array.isArray(p.enum_values) ? p.enum_values.map(String) : null,
        itemEnum: Array.isArray(items?.enum_values) ? (items!.enum_values as unknown[]).map(String) : null,
        minimum: typeof p.minimum === 'number' ? p.minimum : null,
        maximum: typeof p.maximum === 'number' ? p.maximum : null,
        example: typeof p.example === 'string' ? p.example : null,
      }
    })
    .sort((a, b) => a.key.localeCompare(b.key))
}

export interface ConfigGroupDef {
  id: string
  title: string
  description: string
}

export const CONFIG_GROUPS: ConfigGroupDef[] = [
  { id: 'retention', title: 'Storage & retention', description: 'How long and how much the cluster keeps, segment sizes and compaction.' },
  { id: 'topics', title: 'Topics & partitions', description: 'Defaults for new topics: partitions, copies, auto-creation.' },
  { id: 'clients', title: 'Kafka API & clients', description: 'Producers, consumers, consumer groups and transactions.' },
  { id: 'replication', title: 'Replication & balancing', description: 'How copies stay in sync and how partitions move between brokers.' },
  { id: 'security', title: 'Security', description: 'Authentication, authorization, superusers and TLS.' },
  { id: 'tiered', title: 'Tiered storage', description: 'Offloading old data to object storage.' },
  { id: 'services', title: 'HTTP services', description: 'Schema Registry, HTTP Proxy and the Admin API.' },
  { id: 'transforms', title: 'Data transforms', description: 'WebAssembly transforms running inside the brokers.' },
  { id: 'audit', title: 'Audit log', description: 'Recording who did what.' },
  { id: 'other', title: 'Other', description: 'Everything else.' },
]

const GROUP_RULES: [RegExp, string][] = [
  [/^(cloud_storage|cloud_topics|cloud_)/, 'tiered'],
  [/^audit_/, 'audit'],
  [/^data_transforms/, 'transforms'],
  [/^(schema_registry|pandaproxy|http_|admin_api|iceberg_rest)/, 'services'],
  [/(sasl|superusers|oidc|tls|authorization|_auth|kerberos|mtls|principal|password|scram|fips)/, 'security'],
  [/^(raft_|replicat|leader|partition_autobalanc|partition_balanc|node_|members_|rpc_|health_|controller_)/, 'replication'],
  [/^(default_topic|auto_create_topics|topic_|create_topic|minimum_topic|kafka_topics|cluster_id|enable_rack|default_num_)/, 'topics'],
  [/^(kafka_|fetch_|group_|transaction|tx_|id_allocator|max_transactions|produce_|consumer_|enable_idempotence|enable_transactions|quota|target_quota)/, 'clients'],
  [/^(log_|retention|storage_|segment|compact|delete_retention|disk_|space_|write_caching|max_compacted|min_cleanable|tombstone)/, 'retention'],
]

export function configGroupOf(key: string): string {
  for (const [re, g] of GROUP_RULES) if (re.test(key)) return g
  return 'other'
}

/** "log_retention_ms" → "Log retention". */
export function configLabel(key: string): string {
  const bytes = /_bytes$/.test(key)
  const words = key
    .replace(/_(ms|sec|secs|s|bytes|mb)$/, '')
    .split('_')
    .filter(Boolean)
  let text = words.join(' ')
  // the value already reads "5 GB"; say it is a size unless the name does
  if (bytes && !/size|free|limit/.test(text)) text += ' size'
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function isByteKey(p: Pick<ConfigProp, 'key' | 'type'>): boolean {
  return (p.type === 'integer' || p.type === 'number') && /(bytes|_size$|_size_|memory)/.test(p.key)
}

/** A value as a person reads it: "7 days", "10 MB", "On", "Not set", "(hidden)". */
export function configValueText(p: ConfigProp, v: unknown): string {
  if (p.secret) return v == null || v === '' ? 'Not set' : '(hidden)'
  if (v === null || v === undefined) return 'Not set'
  if (p.type === 'boolean' || typeof v === 'boolean') return v === true || v === 'true' ? 'On' : 'Off'
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : 'None'
  if (typeof v === 'object') return JSON.stringify(v)
  if (typeof v === 'number') {
    if (v === -1 && (p.units || isByteKey(p))) return 'No limit'
    if (p.units === 'ms') return humanDuration(v)
    if (p.units === 's') return humanDuration(v * 1000)
    if (isByteKey(p)) return formatBytes(v)
    return v.toLocaleString('en-US')
  }
  return String(v)
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export interface ConfigRow extends ConfigProp {
  group: string
  label: string
  value: unknown
  /** set on the cluster (not the default) */
  isSet: boolean
}

export function configRows(schema: ConfigProp[], values: Record<string, unknown>, explicit: Record<string, unknown>): ConfigRow[] {
  return schema.map((p) => {
    const value = p.key in values ? values[p.key] : p.defaultValue
    return { ...p, group: configGroupOf(p.key), label: configLabel(p.key), value, isSet: p.key in explicit && !same(explicit[p.key], p.defaultValue) }
  })
}

export interface ConfigFilter {
  text: string
  onlyChanged: boolean
  advanced: boolean
}
export function filterConfig(rows: ConfigRow[], f: ConfigFilter): ConfigRow[] {
  const q = f.text.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.onlyChanged && !r.isSet) return false
    if (!f.advanced && r.visibility !== 'user' && !r.isSet && !q) return false
    if (!q) return true
    return r.key.toLowerCase().includes(q) || r.label.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
  })
}

/** What the edit box starts with. */
export function configDraft(p: ConfigProp, v: unknown): string {
  if (v === null || v === undefined) return ''
  if (p.type === 'array') return Array.isArray(v) ? (v.every((x) => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v)) : String(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Turn what was typed into the value to send, or a sentence explaining the problem. */
export function parseConfigInput(p: ConfigProp, raw: string): { value: unknown } | { error: string } {
  const t = raw.trim()
  const name = configLabel(p.key)
  if (t === '') {
    if (p.nullable) return { value: null }
    return { error: `“${name}” needs a value.` }
  }
  switch (p.type) {
    case 'boolean':
      if (t === 'true' || t === 'false') return { value: t === 'true' }
      return { error: `“${name}” is On or Off.` }
    case 'integer':
    case 'number': {
      const n = Number(t)
      if (!Number.isFinite(n)) return { error: `“${name}” needs a number.` }
      if (p.type === 'integer' && !Number.isInteger(n)) return { error: `“${name}” needs a whole number.` }
      if (p.minimum != null && n < p.minimum) return { error: `“${name}” must be at least ${p.minimum}.` }
      if (p.maximum != null && n > p.maximum) return { error: `“${name}” must be at most ${p.maximum}.` }
      return { value: n }
    }
    case 'array': {
      if (t.startsWith('[')) {
        try {
          const v = JSON.parse(t)
          if (Array.isArray(v)) return { value: v }
        } catch {
          /* fall through */
        }
        return { error: `“${name}” is a list — separate values with commas, or write a JSON array.` }
      }
      const items = t.split(',').map((x) => x.trim()).filter(Boolean)
      const bad = p.itemEnum ? items.filter((x) => !p.itemEnum!.includes(x)) : []
      if (bad.length) return { error: `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not allowed for “${name}”. Use: ${p.itemEnum!.join(', ')}.` }
      return { value: items }
    }
    default:
      if (p.enumValues && !p.enumValues.includes(t)) return { error: `Pick one of: ${p.enumValues.join(', ')}.` }
      return { value: t }
  }
}

export interface RpConfigStatus {
  node: number
  restart: boolean
  version: number
  invalid: string[]
  unknown: string[]
}
export function parseConfigStatus(json: unknown): RpConfigStatus[] {
  if (!Array.isArray(json)) return []
  return json.map((s: Record<string, unknown>) => ({
    node: Number(s.node_id ?? 0),
    restart: s.restart === true,
    version: Number(s.config_version ?? 0),
    invalid: Array.isArray(s.invalid) ? s.invalid.map(String) : [],
    unknown: Array.isArray(s.unknown) ? s.unknown.map(String) : [],
  }))
}
export function restartSummary(st: RpConfigStatus[]): string | null {
  const need = st.filter((s) => s.restart).map((s) => s.node)
  if (!need.length) return null
  return need.length === st.length
    ? `Restart ${st.length === 1 ? 'the broker' : `all ${st.length} brokers`} for some changes to take effect.`
    : `Restart broker${need.length === 1 ? '' : 's'} ${need.join(', ')} for some changes to take effect.`
}

// ---------------------------------------------------------------------------
// Kafka ACLs in words
// ---------------------------------------------------------------------------

export type AclResource = 'TOPIC' | 'GROUP' | 'CLUSTER' | 'TRANSACTIONAL_ID'
export const ACL_RESOURCES: { value: AclResource; label: string; hint: string }[] = [
  { value: 'TOPIC', label: 'Topic', hint: 'Read, write or manage topics.' },
  { value: 'GROUP', label: 'Consumer group', hint: 'Join a consumer group and commit read positions.' },
  { value: 'CLUSTER', label: 'Cluster', hint: 'Cluster-wide actions such as creating topics.' },
  { value: 'TRANSACTIONAL_ID', label: 'Transactional ID', hint: 'Producers using transactions.' },
]

/** Operations that mean something for each resource type (Kafka's authorizer). */
export const OPERATIONS_FOR: Record<AclResource, string[]> = {
  TOPIC: ['READ', 'WRITE', 'CREATE', 'DELETE', 'ALTER', 'DESCRIBE', 'DESCRIBE_CONFIGS', 'ALTER_CONFIGS', 'ALL'],
  GROUP: ['READ', 'DESCRIBE', 'DELETE', 'ALL'],
  CLUSTER: ['CREATE', 'ALTER', 'DESCRIBE', 'CLUSTER_ACTION', 'DESCRIBE_CONFIGS', 'ALTER_CONFIGS', 'IDEMPOTENT_WRITE', 'ALL'],
  TRANSACTIONAL_ID: ['WRITE', 'DESCRIBE', 'ALL'],
}

const OP_TEXT: Record<string, string> = {
  ALL: 'Everything',
  READ: 'Read',
  WRITE: 'Write',
  CREATE: 'Create',
  DELETE: 'Delete',
  ALTER: 'Alter',
  DESCRIBE: 'See it exists',
  DESCRIBE_CONFIGS: 'Read settings',
  ALTER_CONFIGS: 'Change settings',
  CLUSTER_ACTION: 'Cluster actions',
  IDEMPOTENT_WRITE: 'Idempotent writes',
}
export function operationText(op: string): string {
  return OP_TEXT[op] ?? op.replace(/_/g, ' ').toLowerCase()
}
export function resourceText(t: string): string {
  return ACL_RESOURCES.find((r) => r.value === t)?.label ?? t.replace(/_/g, ' ').toLowerCase()
}

/** "User:alice" → { kind: "User", name: "alice" }. */
export function splitPrincipal(p: string): { kind: string; name: string } {
  const i = p.indexOf(':')
  return i < 0 ? { kind: 'User', name: p } : { kind: p.slice(0, i), name: p.slice(i + 1) }
}

/** One sentence per binding: "Allow alice to read topics starting with orders-". */
export function aclSentence(a: KafkaAcl): string {
  const who = splitPrincipal(a.principal)
  const whoText = who.name === '*' ? 'everyone' : who.kind === 'RedpandaRole' ? `role ${who.name}` : who.name
  const what =
    a.resource_type === 'CLUSTER'
      ? 'the cluster'
      : a.resource_name === '*'
        ? `every ${resourceText(a.resource_type).toLowerCase()}`
        : a.pattern_type === 'PREFIXED'
          ? `${resourceText(a.resource_type).toLowerCase()}s starting with ${a.resource_name}`
          : `${resourceText(a.resource_type).toLowerCase()} ${a.resource_name}`
  const host = a.host && a.host !== '*' ? ` from ${a.host}` : ''
  return `${a.permission === 'DENY' ? 'Deny' : 'Allow'} ${whoText} — ${operationText(a.operation).toLowerCase()} on ${what}${host}`
}

export interface AclPreset {
  id: string
  label: string
  description: string
  /** the bindings it creates for a topic + (optional) group */
  build: (topic: string, pattern: 'LITERAL' | 'PREFIXED', group: string) => { resource_type: AclResource; resource_name: string; pattern_type: string; operation: string }[]
}

export const ACL_PRESETS: AclPreset[] = [
  {
    id: 'consume',
    label: 'Consume from a topic',
    description: 'Read the topic and commit positions in a consumer group.',
    build: (topic, pattern, group) => [
      { resource_type: 'TOPIC', resource_name: topic, pattern_type: pattern, operation: 'READ' },
      { resource_type: 'TOPIC', resource_name: topic, pattern_type: pattern, operation: 'DESCRIBE' },
      { resource_type: 'GROUP', resource_name: group || '*', pattern_type: group && group !== '*' ? 'LITERAL' : 'LITERAL', operation: 'READ' },
    ],
  },
  {
    id: 'produce',
    label: 'Produce to a topic',
    description: 'Write messages to the topic.',
    build: (topic, pattern) => [
      { resource_type: 'TOPIC', resource_name: topic, pattern_type: pattern, operation: 'WRITE' },
      { resource_type: 'TOPIC', resource_name: topic, pattern_type: pattern, operation: 'DESCRIBE' },
    ],
  },
  {
    id: 'manage',
    label: 'Manage a topic',
    description: 'Everything on the topic: read, write, change settings, delete.',
    build: (topic, pattern) => [{ resource_type: 'TOPIC', resource_name: topic, pattern_type: pattern, operation: 'ALL' }],
  },
]

/** The ACL bindings a grant creates — one per operation. */
export function aclBindings(principal: string, host: string, permission: 'ALLOW' | 'DENY', items: { resource_type: string; resource_name: string; pattern_type: string; operation: string }[]): KafkaAcl[] {
  const seen = new Set<string>()
  const out: KafkaAcl[] = []
  for (const i of items) {
    const a: KafkaAcl = { ...i, resource_name: i.resource_type === 'CLUSTER' ? 'kafka-cluster' : i.resource_name, principal, host: host || '*', permission }
    const k = aclKey(a)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(a)
    }
  }
  return out
}

export function aclKey(a: KafkaAcl): string {
  return [a.principal, a.resource_type, a.resource_name, a.pattern_type, a.operation, a.permission, a.host].join('|')
}

/** Problems with a grant, before it is sent. */
export function grantProblem(principalName: string, resourceName: string, resourceType: string, ops: string[]): string | null {
  if (!principalName.trim()) return 'Choose who gets access.'
  if (resourceType !== 'CLUSTER' && !resourceName.trim()) return `Name the ${resourceText(resourceType).toLowerCase()} (or * for all).`
  if (!ops.length) return 'Pick at least one thing to allow.'
  return null
}
