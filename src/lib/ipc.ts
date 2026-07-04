// Typed wrappers around Tauri IPC commands (src-tauri/src/commands/*).
// Ngoài Tauri runtime (vite dev browser / Playwright) → demo fixtures để
// pixel-diff so được với prototype (dữ liệu port từ CONNS/TABS của HTML).

import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { IS_TAURI, demoInvoke } from './demo'

const invoke: typeof tauriInvoke = (cmd, args, options) =>
  IS_TAURI ? tauriInvoke(cmd, args, options) : demoInvoke(cmd, args as Record<string, unknown>)
import type {
  ColumnInfo,
  ConstraintInfo,
  ExecResponse,
  IndexInfo,
  ProfileDraft,
  ProfilePublic,
  RoutineInfo,
  SchemaInfo,
  SequenceInfo,
  TableInfo,
  TestResult,
  TriggerInfo,
} from './types'

// ---- connections -----------------------------------------------------------

export const listConnections = () => invoke<ProfilePublic[]>('list_connections')

export const saveConnection = (draft: ProfileDraft) =>
  invoke<ProfilePublic>('save_connection', { draft })

export const deleteConnection = (id: string) => invoke<void>('delete_connection', { id })

export const duplicateConnection = (id: string) =>
  invoke<ProfilePublic>('duplicate_connection', { id })

export const connect = (id: string) => invoke<number>('connect', { id })

export const disconnect = (id: string) => invoke<void>('disconnect', { id })

export const reconnect = (id: string) => invoke<number>('reconnect', { id })

/** One-off connection from an unsaved draft — ephemeral, never persisted. */
export const quickConnect = (draft: ProfileDraft) =>
  invoke<ProfilePublic>('quick_connect', { draft })

export const testConnection = (draft: ProfileDraft) =>
  invoke<TestResult>('test_connection', { draft })

export const pingConnection = (id: string) => invoke<boolean>('ping_connection', { id })

// ---- query -----------------------------------------------------------------

export const execStatement = (connId: string, sql: string, statementIndex?: number) =>
  invoke<ExecResponse>('exec_statement', { connId, sql, statementIndex })

export const cancelQuery = (connId: string) =>
  invoke<{ cancelled: boolean }>('cancel_query', { connId })

// ---- redis (Phase 3) --------------------------------------------------------

export interface RedisScanResult {
  cursor: number
  keys: { name: string; key_type: string; ttl: number }[]
  dbsize: number
}

/** One SCAN round (cursor-based, never KEYS *). cursor 0 = start / finished. */
export const redisScan = (connId: string, pattern: string, cursor: number, count: number) =>
  invoke<RedisScanResult>('redis_scan', { connId, pattern, cursor, count })

/** Typed value per Redis type (tagged by `kind`). */
export type RedisValue =
  | { kind: 'string'; value: string }
  | { kind: 'hash'; fields: [string, string][] }
  | { kind: 'list'; items: string[] }
  | { kind: 'set'; members: string[] }
  | { kind: 'zset'; members: [string, number][] }
  | { kind: 'stream'; entries: { id: string; fields: [string, string][] }[] }
  | { kind: 'none' }

export interface RedisKeyValue {
  key_type: string
  ttl: number
  value: RedisValue
}

export const redisGet = (connId: string, key: string) =>
  invoke<RedisKeyValue>('redis_get', { connId, key })

export const redisDel = (connId: string, key: string) =>
  invoke<number>('redis_del', { connId, key })

/** secs > 0 → EXPIRE; secs <= 0 → PERSIST. */
export const redisSetTtl = (connId: string, key: string, secs: number) =>
  invoke<void>('redis_set_ttl', { connId, key, secs })

/** Per-type edit op (tag `op` matches backend RedisEditOp camelCase). */
export type RedisEditOp =
  | { op: 'setString'; value: string }
  | { op: 'hSet'; field: string; value: string }
  | { op: 'hDel'; field: string }
  | { op: 'rPush'; value: string }
  | { op: 'lSet'; index: number; value: string }
  | { op: 'lRem'; value: string }
  | { op: 'sAdd'; member: string }
  | { op: 'sRem'; member: string }
  | { op: 'zAdd'; member: string; score: number }
  | { op: 'zRem'; member: string }
  | { op: 'xAdd'; fields: [string, string][] }
  | { op: 'xDel'; id: string }

export const redisEdit = (connId: string, key: string, op: RedisEditOp) =>
  invoke<void>('redis_edit', { connId, key, op })

/** CLI console — run a raw command (args already split), returns RESP text. */
export const redisCommand = (connId: string, args: string[]) =>
  invoke<string>('redis_command', { connId, args })

export const redisMemoryUsage = (connId: string, key: string) =>
  invoke<number | null>('redis_memory_usage', { connId, key })

export const redisFlushDb = (connId: string) => invoke<void>('redis_flushdb', { connId })

/** Pub/Sub — subscribe channels/patterns; messages arrive via `redis-pubsub` event. */
export const redisSubscribe = (connId: string, channels: string[], patterns: string[]) =>
  invoke<void>('redis_subscribe', { connId, channels, patterns })

export const redisUnsubscribe = (connId: string) =>
  invoke<void>('redis_unsubscribe', { connId })

export const redisPublish = (connId: string, channel: string, message: string) =>
  invoke<number>('redis_publish', { connId, channel, message })

/** Payload of the `redis-pubsub` Tauri event. */
export interface RedisPubSubMsg {
  conn_id: string
  channel: string
  payload: string
}

// ---- nats (Phase 3) ---------------------------------------------------------

export interface NatsInfo {
  version: string
  server_name: string
  host: string
  port: number
  max_payload: number
  client_id: number
  go: string
}

export const natsInfo = (connId: string) => invoke<NatsInfo>('nats_info', { connId })

/** Subscribe subject/wildcard; messages arrive via `nats-msg` event. */
export const natsSubscribe = (connId: string, subject: string) =>
  invoke<void>('nats_subscribe', { connId, subject })

export const natsUnsubscribe = (connId: string) => invoke<void>('nats_unsubscribe', { connId })

export const natsPublish = (connId: string, subject: string, payload: string, reply?: string) =>
  invoke<void>('nats_publish', { connId, subject, payload, reply: reply || null })

export const natsRequest = (connId: string, subject: string, payload: string, timeoutMs: number) =>
  invoke<string>('nats_request', { connId, subject, payload, timeoutMs })

/** Payload of the `nats-msg` Tauri event. */
export interface NatsMsg {
  conn_id: string
  subject: string
  reply: string
  payload: string
}

// ---- nats JetStream (Phase 3 · T10) ----------------------------------------

export interface NatsJsStream {
  name: string
  subjects: string[]
  retention: string
  storage: string
  messages: number
  bytes: number
  consumers: number
}

export interface NatsJsConsumer {
  name: string
  deliver_policy: string
  ack_policy: string
  filter_subject: string
  num_pending: number
  num_ack_pending: number
}

export interface NatsJsMessage {
  seq: number
  subject: string
  payload: string
  time: string
}

export const natsJsStreams = (connId: string) =>
  invoke<NatsJsStream[]>('nats_js_streams', { connId })

export const natsJsConsumers = (connId: string, stream: string) =>
  invoke<NatsJsConsumer[]>('nats_js_consumers', { connId, stream })

export const natsJsPeek = (connId: string, stream: string, seq: number) =>
  invoke<NatsJsMessage>('nats_js_peek', { connId, stream, seq })

// JetStream management (T9)
export const natsJsCreateStream = (connId: string, name: string, subjects: string[]) =>
  invoke<void>('nats_js_create_stream', { connId, name, subjects })
export const natsJsDeleteStream = (connId: string, name: string) =>
  invoke<void>('nats_js_delete_stream', { connId, name })
export const natsJsPurgeStream = (connId: string, name: string) =>
  invoke<void>('nats_js_purge_stream', { connId, name })
export const natsJsCreateConsumer = (connId: string, stream: string, durable: string, filter: string) =>
  invoke<void>('nats_js_create_consumer', { connId, stream, durable, filter })
export const natsJsDeleteConsumer = (connId: string, stream: string, name: string) =>
  invoke<void>('nats_js_delete_consumer', { connId, stream, name })
export const natsJsDeleteMessage = (connId: string, stream: string, seq: number) =>
  invoke<void>('nats_js_delete_message', { connId, stream, seq })

// KV Store (T9)
export const natsKvBuckets = (connId: string) => invoke<string[]>('nats_kv_buckets', { connId })
export const natsKvCreate = (connId: string, bucket: string) => invoke<void>('nats_kv_create', { connId, bucket })
export const natsKvDeleteBucket = (connId: string, bucket: string) => invoke<void>('nats_kv_delete_bucket', { connId, bucket })
export const natsKvKeys = (connId: string, bucket: string) => invoke<string[]>('nats_kv_keys', { connId, bucket })
export const natsKvGet = (connId: string, bucket: string, key: string) => invoke<string | null>('nats_kv_get', { connId, bucket, key })
export const natsKvPut = (connId: string, bucket: string, key: string, value: string) => invoke<void>('nats_kv_put', { connId, bucket, key, value })
export const natsKvDelete = (connId: string, bucket: string, key: string) => invoke<void>('nats_kv_delete', { connId, bucket, key })

// Object Store (T9)
export interface NatsObjInfo {
  name: string
  size: number
  chunks: number
}
export const natsObjBuckets = (connId: string) => invoke<string[]>('nats_obj_buckets', { connId })
export const natsObjCreate = (connId: string, bucket: string) => invoke<void>('nats_obj_create', { connId, bucket })
export const natsObjDeleteBucket = (connId: string, bucket: string) => invoke<void>('nats_obj_delete_bucket', { connId, bucket })
export const natsObjList = (connId: string, bucket: string) => invoke<NatsObjInfo[]>('nats_obj_list', { connId, bucket })
export const natsObjPutFile = (connId: string, bucket: string, name: string, path: string) => invoke<void>('nats_obj_put_file', { connId, bucket, name, path })
export const natsObjGetFile = (connId: string, bucket: string, name: string, path: string) => invoke<void>('nats_obj_get_file', { connId, bucket, name, path })
export const natsObjDelete = (connId: string, bucket: string, name: string) => invoke<void>('nats_obj_delete', { connId, bucket, name })

// ---- kafka (Phase 4) --------------------------------------------------------

export interface KafkaBroker {
  id: number
  host: string
  port: number
}
export interface KafkaCluster {
  brokers: KafkaBroker[]
  controller_id: number
  topic_count: number
  partition_count: number
}
export interface KafkaPartition {
  id: number
  leader: number
  replicas: number[]
  isr: number[]
  low: number
  high: number
  lag: number
}
export interface KafkaTopic {
  name: string
  partitions: KafkaPartition[]
  internal: boolean
}

export const kafkaCluster = (connId: string) => invoke<KafkaCluster>('kafka_cluster', { connId })
export const kafkaTopics = (connId: string) => invoke<KafkaTopic[]>('kafka_topics', { connId })
export const kafkaCreateTopic = (connId: string, name: string, partitions: number, replication: number) =>
  invoke<void>('kafka_create_topic', { connId, name, partitions, replication })
export const kafkaDeleteTopic = (connId: string, name: string) =>
  invoke<void>('kafka_delete_topic', { connId, name })

export interface KafkaMsg {
  conn_id: string
  partition: number
  offset: number
  timestamp: number
  key: string
  value: string
  headers: [string, string][]
}

/** Consume topic → messages arrive via `kafka-msg` event. from: earliest|latest|offset. */
export const kafkaConsume = (
  connId: string,
  topic: string,
  from: string,
  offset: number,
  partition: number | null,
) => invoke<void>('kafka_consume', { connId, topic, from, offset, partition })

export const kafkaStopConsume = (connId: string) => invoke<void>('kafka_stop_consume', { connId })

export interface KafkaProduceResult {
  partition: number
  offset: number
}
export const kafkaProduce = (
  connId: string,
  topic: string,
  key: string,
  value: string,
  partition: number | null,
) => invoke<KafkaProduceResult>('kafka_produce', { connId, topic, key, value, partition })

export interface KafkaMember {
  member_id: string
  client_id: string
  host: string
}
export interface KafkaGroup {
  name: string
  state: string
  protocol: string
  members: KafkaMember[]
}
export interface KafkaLag {
  topic: string
  partition: number
  committed: number
  high: number
  lag: number
}

export const kafkaConsumerGroups = (connId: string) =>
  invoke<KafkaGroup[]>('kafka_consumer_groups', { connId })
export const kafkaGroupLag = (connId: string, group: string) =>
  invoke<KafkaLag[]>('kafka_group_lag', { connId, group })
export const kafkaResetOffset = (
  connId: string,
  group: string,
  topic: string,
  partition: number,
  target: string,
  offset: number,
) => invoke<void>('kafka_reset_offset', { connId, group, topic, partition, target, offset })

// ---- Kafka Schema Registry (T7) --------------------------------------------

export interface SrSubject {
  name: string
  fmt: string
  latest: number
  compat: string
}

export interface SrSchema {
  subject: string
  version: number
  id: number
  fmt: string
  schema: string
  compat: string
}

export const kafkaSrSubjects = (connId: string) =>
  invoke<SrSubject[]>('kafka_sr_subjects', { connId })
export const kafkaSrVersions = (connId: string, subject: string) =>
  invoke<number[]>('kafka_sr_versions', { connId, subject })
export const kafkaSrSchema = (connId: string, subject: string, version: number) =>
  invoke<SrSchema>('kafka_sr_schema', { connId, subject, version })

// ---- Cassandra (Phase 4b) --------------------------------------------------

export interface CqlExecResponse {
  ok: boolean
  result?: { cols: [string, string][]; rows: Record<string, unknown>[]; total: number }
  error?: { message: string; detail?: string; statement_index?: number }
  duration_ms: number
  next_page?: string
  warnings: string[]
}

export interface CassColumn {
  name: string
  data_type: string
  kind: string // partition_key | clustering | regular | static
  clustering_order: string
  position: number
}
export interface CassTable {
  name: string
  columns: CassColumn[]
}
export interface CassView {
  name: string
  base_table: string
}
export interface CassType {
  name: string
  fields: [string, string][]
}
export interface CassFunction {
  name: string
  kind: string
  signature: string
}
export interface CassIndex {
  name: string
  table: string
  kind: string
  target: string
}
export interface CassKeyspaceTree {
  keyspace: string
  replication: string
  tables: CassTable[]
  views: CassView[]
  types: CassType[]
  functions: CassFunction[]
  indexes: CassIndex[]
}
export interface RingNode {
  host: string
  dc: string
  rack: string
  state: string
  load: string
  owns: string
  version: string
}

export const cqlExec = (connId: string, cql: string, pageSize?: number, pageToken?: string) =>
  invoke<CqlExecResponse>('cql_exec', { connId, cql, pageSize, pageToken })
export const cassandraKeyspaces = (connId: string) =>
  invoke<string[]>('cassandra_keyspaces', { connId })
export const cassandraTree = (connId: string, keyspace: string) =>
  invoke<CassKeyspaceTree>('cassandra_tree', { connId, keyspace })
export const cassandraRing = (connId: string) => invoke<RingNode[]>('cassandra_ring', { connId })
export const cassandraTableDdl = (connId: string, keyspace: string, table: string) =>
  invoke<string>('cassandra_table_ddl', { connId, keyspace, table })

// ---- ClickHouse advanced (Phase 5 · T7c) -----------------------------------

export interface TtlRule {
  expr: string
  action: string // DELETE | MOVE | GROUP BY | RECOMPRESS
  human: string
}
export interface ChTableMeta {
  engine: string
  engine_full: string
  partition_key: string
  sorting_key: string
  create_sql: string
  ttl_rules: TtlRule[]
}

export const chTableMeta = (connId: string, schema: string, table: string) =>
  invoke<ChTableMeta>('ch_table_meta', { connId, schema, table })

// ---- schema (Object Explorer) ----------------------------------------------

export const listSchemas = (connId: string) => invoke<SchemaInfo[]>('list_schemas', { connId })

export const listTables = (connId: string, schema: string) =>
  invoke<TableInfo[]>('list_tables', { connId, schema })

export const listColumns = (connId: string, schema: string, table: string) =>
  invoke<ColumnInfo[]>('list_columns', { connId, schema, table })

export const listIndexes = (connId: string, schema: string, table: string) =>
  invoke<IndexInfo[]>('list_indexes', { connId, schema, table })

export const listConstraints = (connId: string, schema: string, table: string) =>
  invoke<ConstraintInfo[]>('list_constraints', { connId, schema, table })

export const listRoutines = (connId: string, schema: string) =>
  invoke<RoutineInfo[]>('list_routines', { connId, schema })

export const listTriggers = (connId: string, schema: string) =>
  invoke<TriggerInfo[]>('list_triggers', { connId, schema })

export const listSequences = (connId: string, schema: string) =>
  invoke<SequenceInfo[]>('list_sequences', { connId, schema })

// ---- tabs + app state --------------------------------------------------------

export interface PersistedTab {
  id: string
  is_pinned: boolean
  payload: unknown
}

export const saveTabs = (tabs: PersistedTab[]) => invoke<void>('save_tabs', { tabs })

export const loadTabs = <T = unknown>() => invoke<T[]>('load_tabs')

export const getAppState = (key: string) => invoke<string | null>('get_app_state', { key })

export const setAppState = (key: string, value: string) =>
  invoke<void>('set_app_state', { key, value })

// ---- query history + saved queries (snippets) --------------------------------

export interface HistoryEntry {
  connection_id: string
  system: string
  sql: string
  duration_ms: number | null
  row_count: number | null
  ok: boolean
  error: string | null
  executed_at: string
}

export interface Snippet {
  id: string
  name: string
  sql: string
  system: string | null
  updated_at: string
}

export const listHistory = (opts?: { connId?: string; search?: string; limit?: number }) =>
  invoke<HistoryEntry[]>('list_history', {
    connId: opts?.connId ?? null,
    search: opts?.search ?? null,
    limit: opts?.limit ?? null,
  })

// ---- editable grid ----------------------------------------------------------

export type GridChange =
  | { kind: 'update'; schema: string | null; table: string; pk: GridCol[]; set: GridCol[] }
  | { kind: 'insert'; schema: string | null; table: string; values: GridCol[] }
  | { kind: 'delete'; schema: string | null; table: string; pk: GridCol[] }

export interface GridCol {
  name: string
  value: unknown
}

export interface FilterCond {
  col: string
  op: string
  value: unknown
}
export interface SortSpec {
  col: string
  desc: boolean
}

export const execFiltered = (opts: {
  connId: string
  schema: string | null
  table: string
  filters: FilterCond[]
  combinatorOr: boolean
  sorts: SortSpec[]
  limit: number
  offset: number
}) =>
  invoke<ExecResponse>('exec_filtered', {
    connId: opts.connId,
    schema: opts.schema,
    table: opts.table,
    filters: opts.filters,
    combinatorOr: opts.combinatorOr,
    sorts: opts.sorts,
    limit: opts.limit,
    offset: opts.offset,
  })

export const previewGridChanges = (connId: string, changes: GridChange[]) =>
  invoke<string[]>('preview_grid_changes', { connId, changes })

export const applyGridChanges = (connId: string, changes: GridChange[]) =>
  invoke<number>('apply_grid_changes', { connId, changes })

export const listSnippets = () => invoke<Snippet[]>('list_snippets')

export const saveSnippet = (snippet: Snippet) => invoke<void>('save_snippet', { snippet })

export const deleteSnippet = (id: string) => invoke<void>('delete_snippet', { id })
