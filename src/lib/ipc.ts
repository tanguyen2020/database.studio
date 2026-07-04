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
