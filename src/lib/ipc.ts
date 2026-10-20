// Typed wrappers around Tauri IPC commands (src-tauri/src/commands/*).
// Ngoài Tauri runtime (vite dev browser / Playwright) → demo fixtures để
// pixel-diff so được với prototype (dữ liệu port từ CONNS/TABS của HTML).

import { invoke as tauriInvoke, Channel } from '@tauri-apps/api/core'
import { IS_TAURI, demoInvoke } from './demo'

const invoke: typeof tauriInvoke = (cmd, args, options) =>
  IS_TAURI ? tauriInvoke(cmd, args, options) : demoInvoke(cmd, args as Record<string, unknown>)
import type {
  ColumnInfo,
  ConstraintInfo,
  ExecResponse,
  FunctionInfo,
  IndexInfo,
  PartitionInfo,
  ProfileDraft,
  ProfilePublic,
  QueryError,
  QueryResultSet,
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

export const testConnection = (draft: ProfileDraft, testId?: string) =>
  invoke<TestResult>('test_connection', { draft, testId })

/** Hủy THẬT một lần Test đang chạy ở backend (T10). */
export const cancelTest = (testId: string) => invoke<void>('cancel_test', { testId })

export const pingConnection = (id: string) => invoke<boolean>('ping_connection', { id })

// ---- query -----------------------------------------------------------------

export const execStatement = (connId: string, sql: string, statementIndex?: number) =>
  invoke<ExecResponse>('exec_statement', { connId, sql, statementIndex })

/** One batch of a streamed result set. `cols` comes with the first chunk only. */
export interface RowChunk {
  cols?: [string, string][]
  rows: Record<string, unknown>[]
  received: number
  total: number
}

/** Query-editor execution: a large result arrives in chunks instead of as one
 *  giant IPC response, which is what used to block the webview's single UI
 *  thread (freezing every tab and the Cancel button) while it was parsed.
 *  Outside Tauri there is no channel to stream over → plain `execStatement`. */
export const execStatementStream = (
  connId: string,
  sql: string,
  statementIndex: number | undefined,
  onChunk: (chunk: RowChunk) => void,
): Promise<ExecResponse> => {
  if (!IS_TAURI) return execStatement(connId, sql, statementIndex)
  const channel = new Channel<RowChunk>()
  channel.onmessage = onChunk
  return tauriInvoke<ExecResponse>('exec_statement_stream', {
    connId,
    sql,
    statementIndex,
    onChunk: channel,
  })
}

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

export const redisSelectDb = (connId: string, db: number) =>
  invoke<void>('redis_select_db', { connId, db })
export const redisDatabaseCount = (connId: string) =>
  invoke<number>('redis_database_count', { connId })

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
  /** every subject filter (empty = the whole stream) */
  filter_subjects?: string[]
  /** messages at or below this stream seq are acked */
  ack_floor_stream_seq?: number
  /** highest stream seq handed out (maybe not acked yet) */
  delivered_stream_seq?: number
}

export interface NatsJsMessage {
  seq: number
  subject: string
  payload: string
  time: string
  /** Message key = the `Nats-Msg-Id` header if the publisher set one (empty otherwise). */
  key: string
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
export const natsJsSubjectMessages = (
  connId: string,
  stream: string,
  subject: string,
  limit: number,
  startSeq?: number,
) => invoke<NatsJsMessage[]>('nats_js_subject_messages', { connId, stream, subject, limit, startSeq: startSeq ?? null })
export interface NatsJsPage {
  msgs: NatsJsMessage[]
  /** server round-trips the page search needed (diagnostics) */
  probes: number
  total: number
  last_seq: number
}
/**
 * One page of a subject's messages, newest-first. `endSeq` is the paging cursor:
 * omit it for the newest page, pass `(first seq of the current page) - 1` for the
 * next (older) page. The backend searches the sequence window, so every page holds
 * up to `pageSize` real messages even when the subject is a sparse slice of a
 * busy stream.
 */
export const natsJsSubjectPage = (
  connId: string,
  stream: string,
  subject: string,
  pageSize: number,
  endSeq?: number,
) => invoke<NatsJsPage>('nats_js_subject_page', { connId, stream, subject, pageSize, endSeq: endSeq ?? null })
export interface NatsSubjectCount {
  subject: string
  messages: number
}
export interface NatsStreamSubjects {
  subjects: NatsSubjectCount[]
  /** how many subject names matched in total (the list is capped) */
  matched: number
  /** how many subject names the stream holds under the filter */
  scanned: number
}

/** Subject NAMES under `filter` starting with `prefix` (case-insensitive), with
 *  their message counts. Reads the server's per-subject index — one API call, no
 *  walking of messages: the only way a partial token can find its subject, since
 *  NATS filters match whole tokens and are case-sensitive. */
export const natsJsStreamSubjects = (
  connId: string,
  stream: string,
  filter: string,
  prefix: string,
  limit = 200,
) => invoke<NatsStreamSubjects>('nats_js_stream_subjects', { connId, stream, filter, prefix, limit })

export const natsJsSubjectStats = (connId: string, stream: string, subject: string) =>
  invoke<{ total: number; last_seq: number }>('nats_js_subject_stats', { connId, stream, subject })
export const natsJsPurgeSubject = (connId: string, stream: string, subject: string) =>
  invoke<void>('nats_js_purge_subject', { connId, stream, subject })
export const natsJsRemoveSubject = (connId: string, stream: string, subject: string) =>
  invoke<void>('nats_js_remove_subject', { connId, stream, subject })
/** Add a subject to a stream and publish an initial message to it. */
export const natsJsAddSubject = (connId: string, stream: string, subject: string, payload: string) =>
  invoke<void>('nats_js_add_subject', { connId, stream, subject, payload })

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
  /** false = the broker did not report offsets → the count is UNKNOWN, not 0 */
  offsets_known?: boolean
  offsets_error?: string | null
  internal: boolean
}

export const kafkaCluster = (connId: string) => invoke<KafkaCluster>('kafka_cluster', { connId })
export const kafkaTopics = (connId: string) => invoke<KafkaTopic[]>('kafka_topics', { connId })
export const kafkaCreateTopic = (connId: string, name: string, partitions: number, replication: number) =>
  invoke<void>('kafka_create_topic', { connId, name, partitions, replication })
export const kafkaDeleteTopic = (connId: string, name: string) =>
  invoke<void>('kafka_delete_topic', { connId, name })
/** Raise a topic's partition count (Kafka can only add). Resolves to the old count. */
export const kafkaSetPartitions = (connId: string, name: string, partitions: number) =>
  invoke<number>('kafka_set_partitions', { connId, name, partitions })
export const kafkaPurgeTopic = (connId: string, name: string) =>
  invoke<void>('kafka_purge_topic', { connId, name })
// Delete records in one partition up to (and including) `offset` — Kafka's only
// per-message deletion (truncates the log prefix: this record + all older in that partition).
export const kafkaDeleteRecords = (connId: string, name: string, partition: number, offset: number) =>
  invoke<void>('kafka_delete_records', { connId, name, partition, offset })

export interface KafkaMsg {
  conn_id: string
  partition: number
  offset: number
  timestamp: number
  key: string
  value: string
  headers: [string, string][]
}

export interface KafkaPage {
  msgs: KafkaMsg[]
  /** Σ(high − low) of the browsed partitions; **−1 = unknown** (never read as "empty"). */
  retained: number
  /** first offset of this window — pass as `until` to page older */
  window_start: number
  has_older: boolean
  at_newest: boolean
  /** why offsets could not be read (`retained` is −1 then) */
  offsets_error?: string | null
}

/**
 * Read ONE page of messages instead of streaming the whole log.
 * `until` < 0 = newest page; otherwise it is the window's exclusive upper offset.
 */
export const kafkaFetchPage = (
  connId: string,
  topic: string,
  partition: number | null,
  until: number,
  limit: number,
) => invoke<KafkaPage>('kafka_fetch_page', { connId, topic, partition, until, limit })

/**
 * Consume topic → messages arrive BATCHED via the `kafka-msgs` event.
 * from: recent|earliest|latest|offset. In `recent` mode `offset` is the number of
 * newest records to start from (per topic, split across partitions).
 */
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
  /** topics assigned to its live members (empty when idle) */
  topics?: string[]
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
/** lag of one group on ONE topic (cheap: that topic's partitions only) */
export const kafkaGroupTopicLag = (connId: string, group: string, topic: string) =>
  invoke<KafkaLag[]>('kafka_group_topic_lag', { connId, group, topic })
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

export const cqlExec = (
  connId: string,
  cql: string,
  pageSize?: number,
  pageToken?: string,
  consistency?: string,
) => invoke<CqlExecResponse>('cql_exec', { connId, cql, pageSize, pageToken, consistency })
export const cassandraKeyspaces = (connId: string) =>
  invoke<string[]>('cassandra_keyspaces', { connId })
export const cassandraTree = (connId: string, keyspace: string) =>
  invoke<CassKeyspaceTree>('cassandra_tree', { connId, keyspace })
export const cassandraRing = (connId: string) => invoke<RingNode[]>('cassandra_ring', { connId })
export const cassandraTableDdl = (connId: string, keyspace: string, table: string) =>
  invoke<string>('cassandra_table_ddl', { connId, keyspace, table })
/** DDL viewer cho object bất kỳ: kind ∈ table|view|type|index|function|aggregate. */
export const cassandraObjectDdl = (connId: string, keyspace: string, kind: string, name: string) =>
  invoke<string>('cassandra_object_ddl', { connId, keyspace, kind, name })
export const cassandraColumns = (connId: string, keyspace: string, table: string) =>
  invoke<CassColumn[]>('cassandra_columns', { connId, keyspace, table })

// ---- MongoDB (document store) ----------------------------------------------

export interface MongoExecResponse {
  ok: boolean
  result?: QueryResultSet
  affected?: number
  error?: QueryError
  duration_ms: number
  /** Cursor token for the next page (undefined = single batch / finished). */
  next_cursor?: string
  warnings: string[]
}

/** Run a mongosh-style statement (`db.coll.find({...})`, aggregate, insertOne…).
 *  `database` targets a specific DB (the collection viewer); omit to use the
 *  connection's default database (the query editor). */
export const mongoExec = (
  connId: string,
  query: string,
  database?: string,
  batchSize?: number,
  cursorToken?: string,
) =>
  invoke<MongoExecResponse>('mongo_exec', {
    connId,
    query,
    database: database ?? null,
    batchSize,
    cursorToken,
  })

// ---- Foreign keys (ER Diagram · Schema Compare — Phase 5) -------------------

export interface ForeignKey {
  name: string
  from_table: string
  from_column: string
  to_table: string
  to_column: string
}

export const listForeignKeys = (connId: string, schema: string) =>
  invoke<ForeignKey[]>('list_foreign_keys', { connId, schema })

// ---- Index Scanner/Analyzer (Phase 5 · T7b) --------------------------------

export interface IndexScanRow {
  name: string
  table: string
  columns: string[]
  index_type: string
  unique: boolean
  primary: boolean
  size_bytes?: number
  usage?: number
  fragmentation_pct?: number
  valid: boolean
  flags: string[]
}
export interface MissingIndexSuggestion {
  table: string
  columns: string[]
  reason: string
  estimated_benefit?: number
}
export interface IndexScanResult {
  system: string
  scope: string
  indexes: IndexScanRow[]
  summary: { total: number; total_size_bytes: number; unused: number; redundant: number; fragmented: number; invalid: number }
  suggestions?: MissingIndexSuggestion[]
}

export const scanIndexes = (connId: string, schema: string) =>
  invoke<IndexScanResult>('scan_indexes', { connId, schema })

/** Show Definition (T18): text định nghĩa thật của view/trigger/procedure/function. */
export const objectDefinition = (connId: string, schema: string, kind: string, name: string) =>
  invoke<string>('object_definition', { connId, schema, kind, name })
/** Real CREATE statement for one index (incl. INCLUDE / filtered WHERE / method);
 *  empty string when unavailable (caller reconstructs from columns). */
export const indexDefinition = (connId: string, schema: string, table: string, name: string) =>
  invoke<string>('index_definition', { connId, schema, table, name })

/** Backup & Restore (T22). */
export interface BackupToolStatus {
  tool: string | null
  available: boolean
}
export const backupToolStatus = (connId: string) =>
  invoke<BackupToolStatus>('backup_tool_status', { connId })
export interface BackupToolInfo {
  name: string
  path: string | null
  version: string | null
  found: boolean
  /** The copy shipped inside the installer (not one installed on the machine). */
  bundled: boolean
}
export interface ServerBackup {
  path: string
  finished: string
  size: number | null
}
/** What Backup & Restore can do on one connection + database right now. */
export interface BackupPlan {
  system: string
  database: string
  method: 'tool' | 'server' | 'in-process' | 'built-in' | 'unsupported'
  method_label: string
  server_side: boolean
  backup_tool: BackupToolInfo | null
  restore_tools: BackupToolInfo[]
  backup_ready: boolean
  restore_ready: boolean
  default_dir: string
  /** Folder on this computer (differs from default_dir for server-side engines). */
  local_dir: string
  server_version: string | null
  warnings: string[]
  install_hint: string | null
  recent: ServerBackup[]
  disks: string[]
  needs_connection: boolean
  connected: boolean
}
/** Options sent with a backup / restore. Every field is optional. */
export interface BackupOptions {
  database?: string
  format?: string
  content?: 'all' | 'schema' | 'data'
  clean?: boolean
  owner?: boolean
  copyOnly?: boolean
  compression?: boolean
  disk?: string
  toolDir?: string
  jobId?: string
  singleTransaction?: boolean
  asDatabase?: string
}
export interface BackupOutcome {
  message: string
  path: string
  bytes: number | null
  duration_ms: number
  server_side: boolean
  log: string
  notes: string[]
  items: number | null
}
export const backupPlan = (connId: string, database?: string, toolDir?: string) =>
  invoke<BackupPlan>('backup_plan', { connId, database: database ?? null, toolDir: toolDir ?? null })
/** Live progress of a backup / restore (commands/backup.rs BackupProgress). */
export interface BackupProgress {
  jobId: string
  stage: string
  done: number
  total: number | null
  /** "tables" · "collections" · "keys" · "bytes" · "statements" · "%" · "" */
  unit: string
  current: string | null
}
// In the app the progress travels over a Tauri Channel; the demo calls back directly.
function progressArg(cb?: (p: BackupProgress) => void): unknown {
  if (!IS_TAURI) return cb ?? null
  const ch = new Channel<BackupProgress>()
  if (cb) ch.onmessage = cb
  return ch
}
export const backupDatabase = (connId: string, dest: string, options?: BackupOptions, onProgress?: (p: BackupProgress) => void) =>
  invoke<BackupOutcome>('backup_database', { connId, dest, options: options ?? null, onProgress: progressArg(onProgress) })
export const restoreDatabase = (connId: string, src: string, options?: BackupOptions, onProgress?: (p: BackupProgress) => void) =>
  invoke<BackupOutcome>('restore_database', { connId, src, options: options ?? null, onProgress: progressArg(onProgress) })
export const cancelBackup = (jobId: string) => invoke<boolean>('cancel_backup', { jobId })
/** Show a file in Explorer / Finder. Tauri-only. */
export const revealPath = (path: string) => invoke<void>('reveal_path', { path })

/** Admin views (T23): sessions/locks/users/extensions từ system views thật. */
export const adminView = (connId: string, view: string) =>
  invoke<{ cols: [string, string][]; rows: Record<string, unknown>[]; total: number }>('admin_view', { connId, view })
/** `mode`: 'terminate' (default) ends the session; 'cancel' stops only the
 *  statement it is running (PG pg_cancel_backend, MySQL KILL QUERY, Oracle
 *  CANCEL SQL). MSSQL has no query-only cancel. */
export const killSession = (connId: string, pid: number, mode?: 'cancel' | 'terminate') =>
  invoke<null>('kill_session', { connId, pid, mode: mode ?? null })

// ---- Drop Database when other sessions hold it ------------------------------
/** `in_use` = the drop failed because OTHER sessions use the database — list them
 *  with `databaseSessions`, kill with `killSession`, then drop again. MySQL/MariaDB
 *  run the drop with a bounded lock wait so a held lock never freezes the connection. */
export interface DropDatabaseOutcome {
  dropped: boolean
  in_use: boolean
  error?: QueryError
}
export const dropDatabase = (connId: string, statement: string) =>
  invoke<DropDatabaseOutcome>('drop_database', { connId, statement })
/** Sessions (other than ours) connected to / holding locks on `database`. */
export const databaseSessions = (connId: string, database: string) =>
  invoke<{ cols: [string, string][]; rows: Record<string, unknown>[]; total: number }>('database_sessions', { connId, database })

// ---- Users / Roles & Privileges (User Manager) -----------------------------
// Read-side introspection: per (system, view) → result set. `arg` = principal
// name for per-user views (SHOW GRANTS FOR, dba_role_privs WHERE grantee, …).
export const usersView = (connId: string, view: string, arg?: string) =>
  invoke<{ cols: [string, string][]; rows: Record<string, unknown>[]; total: number }>('users_view', {
    connId,
    view,
    arg: arg ?? null,
  })

// MongoDB User Manager (U5) — command-based (not SQL). A role ref is either a
// string (a role in `database`) or { role, db }.
export type MongoRoleRef = string | { role: string; db: string }
export const mongoUsers = (connId: string) =>
  invoke<{ cols: [string, string][]; rows: Record<string, unknown>[]; total: number }>('mongo_users', { connId })
export const mongoRoles = (connId: string, database: string) =>
  invoke<{ cols: [string, string][]; rows: Record<string, unknown>[]; total: number }>('mongo_roles', { connId, database })
export const mongoCreateUser = (connId: string, database: string, user: string, pwd: string, roles: MongoRoleRef[]) =>
  invoke<null>('mongo_create_user', { connId, database, user, pwd, roles })
export const mongoChangePassword = (connId: string, database: string, user: string, pwd: string) =>
  invoke<null>('mongo_change_password', { connId, database, user, pwd })
export const mongoDropUser = (connId: string, database: string, user: string) =>
  invoke<null>('mongo_drop_user', { connId, database, user })
export const mongoGrantRoles = (connId: string, database: string, user: string, roles: MongoRoleRef[]) =>
  invoke<null>('mongo_grant_roles', { connId, database, user, roles })
export const mongoRevokeRoles = (connId: string, database: string, user: string, roles: MongoRoleRef[]) =>
  invoke<null>('mongo_revoke_roles', { connId, database, user, roles })

// ---- Query Plan Visualizer (Phase 5 · T1) ----------------------------------

export interface PlanNode {
  operation: string
  native_op: string
  estimated_rows?: number
  actual_rows?: number
  estimated_cost?: number
  cost_self?: number
  cost_pct?: number
  actual_time_ms?: number
  extra: Record<string, unknown>
  children: PlanNode[]
  is_hotspot: boolean
}
export interface MissingIndex {
  impact_pct: number
  table: string
  ddl: string
  reason: string
}
export interface QueryPlan {
  system: string
  mode: 'estimated' | 'actual' | 'tracing' | 'not_applicable'
  root?: PlanNode
  summary: { total_cost?: number; total_time_ms?: number; warnings: string[] }
  raw: string
  missing_index?: MissingIndex
}

export const explainPlan = (connId: string, sql: string, actual: boolean) =>
  invoke<QueryPlan>('explain_plan', { connId, sql, actual })

/** Năng lực EXPLAIN của một connection (P1.1) — UI dùng để bật/tắt toggle Actual. */
export interface EngineCapability {
  has_planner: boolean
  supports_actual: boolean
  actual_kind: 'none' | 'analyze' | 'tracing'
  cost_basis: 'cost' | 'duration' | 'rows_proxy' | 'none'
}
export const explainCapability = (connId: string) =>
  invoke<EngineCapability>('explain_capability', { connId })

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

/** CH editable-grid → mutation async (ALTER TABLE … UPDATE/DELETE) để review/chạy. */
export const chGenerateMutations = (connId: string, changes: GridChange[]) =>
  invoke<string>('ch_generate_mutations', { connId, changes })

export const chDictionaries = (connId: string, schema: string) =>
  invoke<string[]>('ch_dictionaries', { connId, schema })

// ---- schema (Object Explorer) ----------------------------------------------

export interface DatabaseInfo {
  name: string
  current: boolean
}

/** All databases on the server (Postgres). `current` marks the connected one. */
export const listDatabases = (connId: string) => invoke<DatabaseInfo[]>('list_databases', { connId })

/** Open another database on the same server as a new (ephemeral) connection. */
export const openDatabase = (connId: string, database: string) =>
  invoke<ProfilePublic>('open_database', { connId, database })

/** Attach an internal sub-connection to another database (not shown in the
 *  sidebar) and return its id, for per-database introspection in the Explorer.
 *  Returns `connId` unchanged for the connection's own current database. */
export const attachDatabase = (connId: string, database: string) =>
  invoke<string>('attach_database', { connId, database })

// Per-tab dedicated connection (item 6): each Query Editor tab runs on its own
// physical connection so a hung query can't block other tabs / the Explorer.
/** Opens (or reuses) a Query Editor tab's own connection. `initSql` is the
 *  session setup (PG/DuckDB `SET search_path …`): the backend runs it only when it
 *  CHANGES and replays it after a reconnect — so a Run no longer pays a round
 *  trip for it every time. `null` = no setup. */
export const openTabConnection = (connId: string, tabId: string, database: string, initSql: string | null = null) =>
  invoke<string>('open_tab_connection', { connId, tabId, database, initSql })
export const closeTabConnection = (connId: string) =>
  invoke<void>('close_tab_connection', { connId })

// ---- streaming export (T24) — Tauri-only; bounded-memory stream to a file ----
/** Stream a query to `path` in `format` (csv|json|sql). `onProgress` gets rows
 *  written so far; cancel via `cancelExport(exportId)`. Returns total rows. */
export const exportQueryToFile = (
  connId: string,
  sql: string,
  path: string,
  format: 'csv' | 'json' | 'sql',
  table: string | null,
  exportId: string,
  onProgress: (rows: number) => void,
  database?: string,
): Promise<number> => {
  const channel = new Channel<number>()
  channel.onmessage = onProgress
  return tauriInvoke<number>('export_query_to_file', {
    connId,
    sql,
    path,
    format,
    table,
    database: database ?? null,
    exportId,
    onProgress: channel,
  })
}

export const cancelExport = (exportId: string) => invoke<void>('cancel_export', { exportId })

/** Write UTF-8 text to a file (used by Ctrl+S save-to-file). Tauri-only. */
export const writeTextFile = (path: string, contents: string) =>
  invoke<void>('write_text_file', { path, contents })
/** Write binary content (base64) — image exports where WebView2 can't do a real download. */
export const writeFileBase64 = (path: string, base64: string) =>
  invoke<void>('write_file_base64', { path, base64 })

export const listSchemas = (connId: string) => invoke<SchemaInfo[]>('list_schemas', { connId })

/** `sizes: false` skips each table's on-disk size (`data_length` comes back
 *  null) where computing it is costly — PostgreSQL stats every table's files for
 *  it. The Explorer tree never shows the size; omit the option to get it. */
export const listTables = (connId: string, schema: string, opts?: { sizes?: boolean }) =>
  invoke<TableInfo[]>('list_tables', opts?.sizes === false ? { connId, schema, sizes: false } : { connId, schema })

export const listColumns = (connId: string, schema: string, table: string) =>
  invoke<ColumnInfo[]>('list_columns', { connId, schema, table })

export const listIndexes = (connId: string, schema: string, table: string) =>
  invoke<IndexInfo[]>('list_indexes', { connId, schema, table })

export const listConstraints = (connId: string, schema: string, table: string) =>
  invoke<ConstraintInfo[]>('list_constraints', { connId, schema, table })

export const listPartitions = (connId: string, schema: string, table: string) =>
  invoke<PartitionInfo[]>('list_partitions', { connId, schema, table })

export const listRoutines = (connId: string, schema: string) =>
  invoke<RoutineInfo[]>('list_routines', { connId, schema })

export const listFunctions = (connId: string, schema: string) =>
  invoke<FunctionInfo[]>('list_functions', { connId, schema })

export const listTriggers = (connId: string, schema: string) =>
  invoke<TriggerInfo[]>('list_triggers', { connId, schema })

export const listSequences = (connId: string, schema: string) =>
  invoke<SequenceInfo[]>('list_sequences', { connId, schema })

/** One object of a schema, name + kind only (Generate Scripts object list). */
export interface ObjectName {
  kind: 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'sequence'
  name: string
}
/** Every table / view / routine / trigger / sequence of a schema in ONE call, names
 *  only — no row counts, sizes or routine parameters (those cost a lot on a big
 *  schema and a picker does not need them). */
export const listObjectNames = (connId: string, schema: string) =>
  invoke<ObjectName[]>('list_object_names', { connId, schema })

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
  /** SQL type of the column (e.g. "uuid", "int8"). Postgres uses it to cast the
   *  bound parameter ($1::uuid) so comparisons like `uuid = $1` don't fail. */
  type?: string
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

// ---- RabbitMQ (Management HTTP API — src-tauri/src/commands/rabbitmq.rs) ----

export interface RabbitOverview {
  rabbitmq_version: string
  erlang_version: string
  cluster_name: string
  node: string
  management_version: string
  messages: number
  messages_ready: number
  messages_unacknowledged: number
  queues: number
  exchanges: number
  connections: number
  channels: number
  consumers: number
  /** vhost the connection opened on */
  vhost: string
  /** exchange types the broker offers (built-ins + plugin types) */
  exchange_types: string[]
}

export interface RabbitQueue {
  name: string
  vhost: string
  /** classic | quorum | stream */
  queue_type: string
  durable: boolean
  auto_delete: boolean
  exclusive: boolean
  state: string
  /** null when the broker does not report it (stats not collected yet) */
  messages: number | null
  messages_ready: number | null
  messages_unacknowledged: number | null
  consumers: number | null
  memory: number | null
  node: string
  policy: string
  arguments: Record<string, unknown>
}

export interface RabbitExchange {
  /** '' = the default exchange */
  name: string
  vhost: string
  exchange_type: string
  durable: boolean
  auto_delete: boolean
  internal: boolean
  arguments: Record<string, unknown>
}

export interface RabbitBinding {
  source: string
  destination: string
  destination_type: string
  routing_key: string
  properties_key: string
  arguments: Record<string, unknown>
}

export interface RabbitMessage {
  payload: string
  /** 'string' | 'base64' */
  payload_encoding: string
  payload_bytes: number
  redelivered: boolean
  exchange: string
  routing_key: string
  /** messages left in the queue after this one */
  message_count: number
  properties: Record<string, unknown>
}

/** requeue = peek (messages stay) · ack = consume (removed) · reject = drop */
export type RabbitGetMode = 'requeue' | 'ack' | 'reject'

export const rabbitOverview = (connId: string) => invoke<RabbitOverview>('rabbit_overview', { connId })

export const rabbitVhosts = (connId: string) => invoke<string[]>('rabbit_vhosts', { connId })

export const rabbitQueues = (connId: string, vhost: string) =>
  invoke<RabbitQueue[]>('rabbit_queues', { connId, vhost })

export const rabbitQueue = (connId: string, vhost: string, queue: string) =>
  invoke<RabbitQueue>('rabbit_queue', { connId, vhost, queue })

export const rabbitExchanges = (connId: string, vhost: string) =>
  invoke<RabbitExchange[]>('rabbit_exchanges', { connId, vhost })

export const rabbitQueueBindings = (connId: string, vhost: string, queue: string) =>
  invoke<RabbitBinding[]>('rabbit_queue_bindings', { connId, vhost, queue })

export const rabbitExchangeBindings = (connId: string, vhost: string, exchange: string) =>
  invoke<RabbitBinding[]>('rabbit_exchange_bindings', { connId, vhost, exchange })

export const rabbitGetMessages = (connId: string, vhost: string, queue: string, count: number, mode: RabbitGetMode) =>
  invoke<RabbitMessage[]>('rabbit_get_messages', { connId, vhost, queue, count, mode })

export const rabbitPublish = (
  connId: string,
  vhost: string,
  exchange: string,
  routingKey: string,
  payload: string,
  properties?: Record<string, unknown>,
  payloadEncoding: 'string' | 'base64' = 'string',
) =>
  invoke<{ routed: boolean }>('rabbit_publish', {
    connId,
    vhost,
    exchange,
    routingKey,
    payload,
    payloadEncoding,
    properties: properties ?? {},
  })

export const rabbitPurgeQueue = (connId: string, vhost: string, queue: string) =>
  invoke<void>('rabbit_purge_queue', { connId, vhost, queue })

export const rabbitDeleteQueue = (connId: string, vhost: string, queue: string) =>
  invoke<void>('rabbit_delete_queue', { connId, vhost, queue })

export const rabbitDeleteExchange = (connId: string, vhost: string, exchange: string) =>
  invoke<void>('rabbit_delete_exchange', { connId, vhost, exchange })

export const rabbitDeclareQueue = (
  connId: string,
  vhost: string,
  name: string,
  queueType: string,
  durable: boolean,
  autoDelete: boolean,
  args?: Record<string, unknown>,
) => invoke<void>('rabbit_declare_queue', { connId, vhost, name, queueType, durable, autoDelete, arguments: args ?? {} })

export const rabbitDeclareExchange = (
  connId: string,
  vhost: string,
  name: string,
  exchangeType: string,
  durable: boolean,
  autoDelete: boolean,
  internal: boolean,
  args?: Record<string, unknown>,
) => invoke<void>('rabbit_declare_exchange', { connId, vhost, name, exchangeType, durable, autoDelete, internal, arguments: args ?? {} })

export const rabbitBindQueue = (connId: string, vhost: string, exchange: string, queue: string, routingKey: string) =>
  invoke<void>('rabbit_bind_queue', { connId, vhost, exchange, queue, routingKey })

export const rabbitUnbindQueue = (connId: string, vhost: string, exchange: string, queue: string, propertiesKey: string) =>
  invoke<void>('rabbit_unbind_queue', { connId, vhost, exchange, queue, propertiesKey })

// ---- RabbitMQ live listening (watch = copy via a tap queue · consume = ack) ----

export type RabbitLiveMode = 'watch' | 'consume'

export interface RabbitLiveRequest {
  session: string
  mode: RabbitLiveMode
  vhost: string
  queue?: string
  exchange?: string
  routing_keys?: string[]
}

export interface RabbitLiveInfo {
  session: string
  mode: RabbitLiveMode
  /** queue actually read: the queue itself (consume) or the tap (watch) */
  source: string
  tap_queue: string | null
  /** what the tap was bound with (watch) */
  bindings: RabbitBinding[]
}

export interface RabbitLiveBatch {
  session: string
  msgs: RabbitMessage[]
  /** running total for the session */
  received: number
}

export interface RabbitLiveStatus {
  session: string
  /** warn = transient, still running · error = stopped · stopped = ended normally */
  state: 'warn' | 'error' | 'stopped'
  message: string
}

export const rabbitLiveStart = (connId: string, request: RabbitLiveRequest) =>
  invoke<RabbitLiveInfo>('rabbit_live_start', { connId, request })

export const rabbitLiveStop = (session: string) => invoke<void>('rabbit_live_stop', { session })

/** Subscribe to one live session's batches + status. In the desktop app these are
 *  Tauri events from the backend task; in the browser demo they come from the demo
 *  broker, so the whole flow is testable without a server. Returns an unsubscribe. */
export async function onRabbitLive(
  session: string,
  onBatch: (b: RabbitLiveBatch) => void,
  onStatus: (s: RabbitLiveStatus) => void,
): Promise<() => void> {
  if (!IS_TAURI) {
    const { rabbitDemoSubscribe } = await import('./rabbitmq/demo')
    return rabbitDemoSubscribe(session, onBatch, onStatus)
  }
  const { listen } = await import('@tauri-apps/api/event')
  const off1 = await listen<RabbitLiveBatch>('rabbit-live', (e) => {
    if (e.payload.session === session) onBatch(e.payload)
  })
  const off2 = await listen<RabbitLiveStatus>('rabbit-live-status', (e) => {
    if (e.payload.session === session) onStatus(e.payload)
  })
  return () => {
    off1()
    off2()
  }
}

// ---- RabbitMQ users · permissions · topic permissions · policies · vhosts ----

export interface RabbitWhoami {
  name: string
  tags: string[]
}

export interface RabbitUser {
  name: string
  tags: string[]
  /** false = cannot log in with a password (certificate / external auth only) */
  has_password: boolean
}

export interface RabbitPermission {
  user: string
  vhost: string
  configure: string
  write: string
  read: string
}

export interface RabbitTopicPermission {
  user: string
  vhost: string
  exchange: string
  write: string
  read: string
}

export interface RabbitPolicy {
  name: string
  vhost: string
  pattern: string
  apply_to: string
  priority: number
  definition: Record<string, unknown>
}

export interface RabbitVhost {
  name: string
  description: string
  messages: number | null
}

export const rabbitWhoami = (connId: string) => invoke<RabbitWhoami>('rabbit_whoami', { connId })
export const rabbitVhostList = (connId: string) => invoke<RabbitVhost[]>('rabbit_vhost_list', { connId })
export const rabbitCreateVhost = (connId: string, name: string, description: string) =>
  invoke<void>('rabbit_create_vhost', { connId, name, description })
export const rabbitDeleteVhost = (connId: string, name: string) => invoke<void>('rabbit_delete_vhost', { connId, name })

export const rabbitUsers = (connId: string) => invoke<RabbitUser[]>('rabbit_users', { connId })
export const rabbitCreateUser = (connId: string, name: string, password: string, tags: string[]) =>
  invoke<void>('rabbit_create_user', { connId, name, password, tags })
export const rabbitSetUserPassword = (connId: string, name: string, password: string) =>
  invoke<void>('rabbit_set_user_password', { connId, name, password })
export const rabbitSetUserTags = (connId: string, name: string, tags: string[]) =>
  invoke<void>('rabbit_set_user_tags', { connId, name, tags })
export const rabbitDeleteUser = (connId: string, name: string) => invoke<void>('rabbit_delete_user', { connId, name })

export const rabbitPermissions = (connId: string) => invoke<RabbitPermission[]>('rabbit_permissions', { connId })
export const rabbitSetPermission = (connId: string, vhost: string, user: string, configure: string, write: string, read: string) =>
  invoke<void>('rabbit_set_permission', { connId, vhost, user, configure, write, read })
export const rabbitDeletePermission = (connId: string, vhost: string, user: string) =>
  invoke<void>('rabbit_delete_permission', { connId, vhost, user })

export const rabbitTopicPermissions = (connId: string) =>
  invoke<RabbitTopicPermission[]>('rabbit_topic_permissions', { connId })
export const rabbitSetTopicPermission = (connId: string, vhost: string, user: string, exchange: string, write: string, read: string) =>
  invoke<void>('rabbit_set_topic_permission', { connId, vhost, user, exchange, write, read })
export const rabbitDeleteTopicPermissions = (connId: string, vhost: string, user: string) =>
  invoke<void>('rabbit_delete_topic_permissions', { connId, vhost, user })

export const rabbitPolicies = (connId: string, vhost: string) => invoke<RabbitPolicy[]>('rabbit_policies', { connId, vhost })
export const rabbitSetPolicy = (
  connId: string,
  vhost: string,
  name: string,
  pattern: string,
  applyTo: string,
  priority: number,
  definition: Record<string, unknown>,
) => invoke<void>('rabbit_set_policy', { connId, vhost, name, pattern, applyTo, priority, definition })
export const rabbitDeletePolicy = (connId: string, vhost: string, name: string) =>
  invoke<void>('rabbit_delete_policy', { connId, vhost, name })

// ---- Elasticsearch (REST API — src-tauri/src/commands/elasticsearch.rs) ----

export interface EsInfo {
  name: string
  cluster_name: string
  cluster_uuid: string
  version: string
  /** 'elasticsearch' | 'opensearch' */
  distribution: string
  lucene_version: string
  build_flavor: string
  tagline: string
}

export interface EsOverview {
  info: EsInfo
  /** green | yellow | red | '' (health refused) */
  status: string
  number_of_nodes: number
  number_of_data_nodes: number
  active_primary_shards: number
  active_shards: number
  relocating_shards: number
  initializing_shards: number
  unassigned_shards: number
  number_of_pending_tasks: number
  active_shards_percent: number
  indices: number | null
  docs: number | null
  store_bytes: number | null
  warning: string | null
}

export interface EsIndex {
  name: string
  health: string
  status: string
  uuid: string
  primaries: number | null
  replicas: number | null
  docs_count: number | null
  docs_deleted: number | null
  store_bytes: number | null
  pri_store_bytes: number | null
  created: string
  hidden: boolean
  data_stream: string | null
}

/** Raw answer of a REST call — returned whatever the HTTP status. */
export interface EsResponse {
  status: number
  ok: boolean
  json: unknown | null
  text: string | null
  took_ms: number
  content_type: string
  warnings: string[]
  bytes: number
}

export const esRequest = (connId: string, method: string, path: string, body?: string | null) =>
  invoke<EsResponse>('es_request', { connId, method, path, body: body ?? null })

export const esOverview = (connId: string) => invoke<EsOverview>('es_overview', { connId })

export const esIndices = (connId: string) => invoke<EsIndex[]>('es_indices', { connId })

export const esMappingFields = (connId: string, index: string) =>
  invoke<[string, string][]>('es_mapping_fields', { connId, index })
