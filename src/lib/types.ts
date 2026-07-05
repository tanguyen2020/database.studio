// Shared types mirroring backend/src/drivers/types.rs + connections/profile.rs.
// The exec contract shape is locked by the spec:
//   { ok, result?: { cols: [[name,type]], rows, total }, error? }

export type SystemType =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'mssql'
  | 'sqlite'
  | 'clickhouse'
  | 'cassandra'
  | 'redis'
  | 'kafka'
  | 'nats'

export type Environment = 'production' | 'staging' | 'development' | 'local'
export type SqliteMode = 'read-write' | 'read-only' | 'in-memory'

export interface SshConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  auth: 'password' | 'key'
  password_enc?: string
  key_path: string
}

export interface ConnectionProfile {
  id: string
  name: string
  system: SystemType
  host: string
  port: number
  database: string
  user: string
  group: string
  env: Environment
  ssh: SshConfig
  ssl: boolean
  /** TLS material — path only (files not copied). Empty = none / system CA. */
  ssl_ca: string
  ssl_cert: string
  ssl_key: string
  sqlite_path: string
  sqlite_mode: SqliteMode
  mssql_auth: string
  schema_registry_url: string
  cassandra_dc: string
  cassandra_consistency: string
}

/** Profile as returned by the backend: never carries ciphertext. */
export interface ProfilePublic extends ConnectionProfile {
  has_password: boolean
  connected: boolean
  latency_ms?: number
  /** Client-only: one-off "Quick Connect" — lives in memory, never persisted. */
  ephemeral?: boolean
}

export interface ProfileDraft {
  profile: ConnectionProfile
  /** undefined/null = keep the stored password */
  password?: string | null
  ssh_password?: string | null
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

export type ColumnDef = [name: string, type: string]

export interface QueryResultSet {
  cols: ColumnDef[]
  rows: Record<string, unknown>[]
  total: number
}

export interface ErrorPosition {
  line: number
  col: number
}

/** Normalized execution error (addendum §2.1). `raw` feeds "View raw". */
export interface QueryError {
  system: string
  statement_index?: number
  code?: string
  message: string
  /** Position within the statement; UI adds the statement's document offset. */
  position?: ErrorPosition
  hint?: string
  severity: 'error' | 'warning'
  raw: string
}

export interface ExecResponse {
  ok: boolean
  result?: QueryResultSet
  affected?: number
  error?: QueryError
  duration_ms: number
}

export interface TestResult {
  ok: boolean
  latency_ms?: number
  server_version?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Object Explorer catalog types
// ---------------------------------------------------------------------------

export interface SchemaInfo {
  name: string
  is_default: boolean
}

export interface TableInfo {
  schema: string
  name: string
  kind: 'table' | 'view' | 'system'
  row_estimate?: number
  locked: boolean
  /** ClickHouse engine (for explorer badge) */
  engine?: string
}

export interface ColumnInfo {
  name: string
  data_type: string
  nullable: boolean
  default?: string
  is_pk: boolean
  is_fk: boolean
  ordinal: number
}

export interface IndexInfo {
  name: string
  method: string
  columns: string[]
  unique: boolean
  primary: boolean
}

export interface ConstraintInfo {
  name: string
  kind: string
  definition?: string
}

export interface ParamInfo {
  name: string
  data_type: string
  mode: string
  default?: string
}

export interface RoutineInfo {
  schema: string
  name: string
  kind: 'procedure' | 'function' | 'table_function' | 'scalar_function'
  params: ParamInfo[]
  return_type?: string
}

export interface TriggerInfo {
  schema: string
  name: string
  table: string
  event: string
}

export interface SequenceInfo {
  schema: string
  name: string
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type TabContentType =
  | 'sql-editor'
  | 'table-viewer'
  | 'history'
  | 'saved'
  | 'redis'
  | 'redis-pubsub'
  | 'nats'
  | 'kafka'
  | 'kafka-consumer'
  | 'kafka-producer'
  | 'kafka-schema-registry'
  | 'cassandra-ring'
  | 'table-designer'
  | 'query-plan'
  | 'er-diagram'
  | 'schema-compare'
  | 'index-scanner'
  | 'index-manager'
  | 'admin'

export interface TabState {
  id: string
  connectionId: string | null
  connectionName: string
  systemType: SystemType | 'orphan'
  contentType: TabContentType
  title: string
  isPinned: boolean
  isDirty: boolean
  /** Split view: pane index (0 = left/top, 1 = right/bottom). undefined = 0. */
  pane?: number
  /** Editor buffer, selected schema/table, scroll position, ... */
  state: Record<string, unknown>
}
