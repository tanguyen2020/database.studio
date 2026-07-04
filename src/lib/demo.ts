// Demo fixtures — chỉ dùng khi chạy NGOÀI Tauri (vite dev trong browser /
// Playwright visual test). Dữ liệu port nguyên từ mảng CONNS (dòng 3729-3741)
// + TABS (dòng 3745-3757) của Database Studio.dc.html để pixel-diff từng màn
// so được với prototype. KHÔNG bao giờ chạy trong app Tauri thật.

import type { ProfilePublic, SystemType } from './types'

export const IS_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const conn = (
  id: string,
  name: string,
  system: SystemType,
  host: string,
  port: number,
  database: string,
  user: string,
  group: string,
  env: ProfilePublic['env'],
  opts: Partial<ProfilePublic> = {},
): ProfilePublic => ({
  id,
  name,
  system,
  host,
  port,
  database,
  user,
  group,
  env,
  ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', password_enc: '', key_path: '' },
  ssl: false,
  ssl_ca: '',
  ssl_cert: '',
  ssl_key: '',
  sqlite_path: '',
  sqlite_mode: 'read-write',
  mssql_auth: 'sql',
  has_password: true,
  connected: false,
  ...opts,
})

/** CONNS c1-c11 của prototype — Phase 1-2 chỉ seed các hệ đã available. */
export const DEMO_PROFILES: ProfilePublic[] = [
  conn('c1', 'Postgres', 'postgres', '10.0.1.5', 5432, 'sis_prod', 'app_ro', 'Production', 'production', {
    ssh: { enabled: true, host: 'bastion.acme.io', port: 22, user: 'app_ro', auth: 'key', password_enc: '', key_path: '~/.ssh/id_ed25519' },
    connected: true,
    latency_ms: 42,
  }),
  conn('c2', 'MySQL', 'mysql', 'localhost', 3306, 'library_db', 'root', 'Local', 'development', {
    connected: true,
    latency_ms: 8,
  }),
  conn('c3', 'MSSQL', 'mssql', '10.0.2.9', 1433, 'exams_reporting', 'sa', 'Analytics', 'staging', {
    ssl: true,
    connected: false,
  }),
  conn('c4', 'Cache Redis', 'redis', '10.0.1.7', 6379, 'db0', 'default', 'Cache', 'production', {
    connected: true,
    latency_ms: 3,
  }),
  conn('c5', 'Events Kafka', 'kafka', 'kafka-1', 9092, 'cluster', 'svc-kafka', 'Streaming', 'production', {
    ssl: true,
    connected: true,
    latency_ms: 15,
  }),
  conn('c6', 'Messaging NATS', 'nats', 'nats', 4222, 'default', 'svc-nats', 'Streaming', 'production', {
    connected: true,
    latency_ms: 5,
  }),
  conn('c7', 'Staging Postgres', 'postgres', '10.0.3.4', 5432, 'sis_staging', 'app_rw', 'Staging', 'staging', {
    connected: true,
    latency_ms: 28,
  }),
  conn('c8', 'Analytics ClickHouse', 'clickhouse', '10.0.4.2', 8123, 'lms_analytics', 'default', 'Analytics', 'staging', {
    connected: true,
    latency_ms: 11,
  }),
  conn('c9', 'MariaDB App', 'mariadb', '10.0.3.8', 3306, 'cms_db', 'root', 'Development', 'development', {
    connected: true,
    latency_ms: 6,
  }),
  conn('c10', 'Local SQLite', 'sqlite', '', 0, 'main', '', 'Local', 'local', {
    sqlite_path: '/data/attendance.db',
    connected: true,
    latency_ms: 1,
    has_password: false,
  }),
  conn('c11', 'Profiles Cassandra', 'cassandra', '10.0.5.3', 9042, 'campus_ks', 'cassandra', 'Wide Column', 'production', {
    ssl: true,
    connected: true,
    latency_ms: 9,
  }),
]

/** TABS t1/t2/t_ma1 của prototype (các tab SQL thuộc hệ Phase 1-2). */
export const DEMO_TABS = [
  {
    id: 't1',
    connectionId: 'c1',
    connectionName: 'Postgres',
    systemType: 'postgres',
    contentType: 'sql-editor',
    title: 'students · SELECT',
    isPinned: false,
    isDirty: true,
    state: {
      query:
        "SELECT * FROM students WHERE status = 'active';\nSELECT id, first_name, last_name, email FROM students LIMIT 100;\nUPDATE enrollments SET grade = 'A' WHERE course_id = 3;\nSELECT code, title, department, credits FROM courses;",
    },
  },
  {
    id: 't2',
    connectionId: 'c1',
    connectionName: 'Postgres',
    systemType: 'postgres',
    contentType: 'sql-editor',
    title: 'top students · query',
    isPinned: false,
    isDirty: false,
    state: {
      query:
        "SELECT first_name, last_name, gpa, grade_level\nFROM students\nWHERE status = 'active'\nORDER BY gpa DESC\nLIMIT 25;",
    },
  },
  // t3-t6: tab hệ phase-sau — hiện trong TAB BAR cho khớp prototype
  // (contentType tạm sql-editor; workspace riêng đến ở Phase 3-5)
  {
    id: 't3',
    connectionId: 'c4',
    connectionName: 'Cache Redis',
    systemType: 'redis',
    contentType: 'sql-editor',
    title: 'session:* · keys',
    isPinned: false,
    isDirty: false,
    state: { query: '' },
  },
  {
    id: 't4',
    connectionId: 'c5',
    connectionName: 'Events Kafka',
    systemType: 'kafka',
    contentType: 'sql-editor',
    title: 'topic · enrollment.events',
    isPinned: false,
    isDirty: false,
    state: { query: '' },
  },
  {
    id: 't5',
    connectionId: 'c6',
    connectionName: 'Messaging NATS',
    systemType: 'nats',
    contentType: 'sql-editor',
    title: 'campus.>',
    isPinned: false,
    isDirty: false,
    state: { query: '' },
  },
  {
    id: 't6',
    connectionId: 'c1',
    connectionName: 'Postgres',
    systemType: 'postgres',
    contentType: 'sql-editor',
    title: 'sis_prod · ER Diagram',
    isPinned: false,
    isDirty: false,
    state: { query: '' },
  },
  {
    id: 't_ma1',
    connectionId: 'c9',
    connectionName: 'MariaDB App',
    systemType: 'mariadb',
    contentType: 'sql-editor',
    title: 'articles · query',
    isPinned: false,
    isDirty: false,
    state: { query: 'SELECT * FROM articles LIMIT 100;' },
  },
  {
    id: 't_sl1',
    connectionId: 'c10',
    connectionName: 'Local SQLite',
    systemType: 'sqlite',
    contentType: 'sql-editor',
    title: 'attendance.db · SQL',
    isPinned: false,
    isDirty: false,
    state: { query: 'SELECT * FROM attendance LIMIT 50;' },
  },
]

const appState: Record<string, string> = { theme: 'dark', active_tab: 't1' }

/**
 * Mock trả lời cho từng IPC command khi không có Tauri runtime.
 * Chỉ đủ cho render/visual — thao tác ghi là no-op.
 */
export function demoInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const ok = (v: unknown) => Promise.resolve(v as T)
  switch (cmd) {
    case 'list_connections':
      return ok(DEMO_PROFILES)
    case 'load_tabs':
      return ok(DEMO_TABS)
    case 'get_app_state':
      return ok(appState[(args?.key as string) ?? ''] ?? null)
    case 'set_app_state':
    case 'save_tabs':
    case 'delete_connection':
    case 'disconnect':
      return ok(null)
    case 'connect':
    case 'reconnect':
      return ok(12)
    case 'ping_connection':
      return ok(true)
    case 'test_connection':
      return ok({ ok: true, latency_ms: 12, server_version: 'demo' })
    case 'save_connection':
      return ok((args?.draft as { profile: unknown })?.profile)
    case 'quick_connect': {
      const p = (args?.draft as { profile: ProfilePublic })?.profile
      return ok({ ...p, id: `quick-demo-${p?.name ?? ''}`, connected: true, latency_ms: 7, has_password: false })
    }
    case 'duplicate_connection':
      return ok({ ...DEMO_PROFILES[0], id: 'copy', name: 'Copy' })
    case 'list_schemas':
      return ok([{ name: 'public', is_default: true }])
    case 'list_tables':
      return ok([
        { name: 'students', kind: 'table', row_estimate: 3842, locked: false },
        { name: 'courses', kind: 'table', row_estimate: 214, locked: false },
        { name: 'enrollments', kind: 'table', row_estimate: 12480, locked: false },
        { name: 'vw_active_students', kind: 'view', row_estimate: null, locked: false },
      ])
    case 'list_columns':
      return ok([
        { name: 'id', data_type: 'int4', nullable: false, default: null, is_pk: true, is_fk: false },
        { name: 'first_name', data_type: 'varchar(80)', nullable: false, default: null, is_pk: false, is_fk: false },
        { name: 'status', data_type: 'varchar(20)', nullable: true, default: null, is_pk: false, is_fk: false },
      ])
    case 'list_indexes':
    case 'list_constraints':
    case 'list_routines':
    case 'list_triggers':
    case 'list_sequences':
      return ok([])
    case 'exec_statement':
      return ok({
        ok: true,
        result: {
          cols: [
            ['id', 'int4'],
            ['first_name', 'varchar'],
            ['gpa', 'numeric'],
          ],
          rows: [
            { id: 1, first_name: 'An', gpa: 3.9 },
            { id: 2, first_name: 'Bình', gpa: 3.7 },
            { id: 3, first_name: 'Chi', gpa: null },
          ],
          total: 3,
        },
        duration_ms: 12,
      })
    case 'cancel_query':
      return ok({ cancelled: true })
    case 'list_history':
      // port HISTORY của prototype (dòng 3761)
      return ok([
        { connection_id: 'c1', system: 'postgres', sql: "SELECT * FROM students WHERE status='active'", duration_ms: 22, row_count: 214, ok: true, error: null, executed_at: '2026-06-30 10:23:14' },
        { connection_id: 'c1', system: 'postgres', sql: 'SELECT first_name, last_name, gpa FROM students ORDER BY gpa DESC LIMIT 25', duration_ms: 6, row_count: 25, ok: true, error: null, executed_at: '2026-06-30 10:21:02' },
        { connection_id: 'c1', system: 'postgres', sql: "UPDATE enrollments SET grade='A' WHERE course_id=3", duration_ms: 9, row_count: 18, ok: true, error: null, executed_at: '2026-06-30 10:18:47' },
        { connection_id: 'c8', system: 'clickhouse', sql: 'SELECT event_type, count() FROM lms_events GROUP BY event_type', duration_ms: 18, row_count: 7, ok: true, error: null, executed_at: '2026-06-30 10:15:30' },
        { connection_id: 'c1', system: 'postgres', sql: 'SELECT department, count(id) FROM courses GROUP BY department', duration_ms: 5, row_count: 7, ok: true, error: null, executed_at: '2026-06-30 10:12:09' },
      ])
    case 'list_snippets':
      return ok([
        { id: 's1', name: 'Active students', sql: "SELECT * FROM students WHERE status='active';", system: 'postgres', updated_at: '2026-06-29 09:00:00' },
        { id: 's2', name: 'Top GPA', sql: 'SELECT first_name, gpa FROM students ORDER BY gpa DESC LIMIT 25;', system: 'postgres', updated_at: '2026-06-28 14:30:00' },
      ])
    case 'save_snippet':
    case 'delete_snippet':
      return ok(null)
    case 'preview_grid_changes': {
      const changes = (args?.changes as Array<{ kind: string; table: string }>) ?? []
      return ok(changes.map((c) => `-- ${c.kind.toUpperCase()} ${c.table} (demo preview)`))
    }
    case 'apply_grid_changes':
      return ok(((args?.changes as unknown[]) ?? []).length)
    case 'exec_filtered':
      return demoInvoke('exec_statement', args)
    case 'redis_scan':
      // port key store demo của prototype (user:*, session:*, cache:*)
      return ok({
        cursor: 0,
        dbsize: 6,
        keys: [
          { name: 'session:abc123', key_type: 'string', ttl: 42 },
          { name: 'session:def456', key_type: 'string', ttl: 120 },
          { name: 'user:1001', key_type: 'hash', ttl: -1 },
          { name: 'user:1002', key_type: 'hash', ttl: -1 },
          { name: 'cache:home', key_type: 'string', ttl: 8 },
          { name: 'leaderboard', key_type: 'zset', ttl: -1 },
        ],
      })
    case 'redis_get': {
      const key = (args?.key as string) ?? ''
      if (key.startsWith('user:'))
        return ok({ key_type: 'hash', ttl: -1, value: { kind: 'hash', fields: [['name', 'An'], ['email', 'an@acme.io'], ['role', 'admin']] } })
      if (key === 'leaderboard')
        return ok({ key_type: 'zset', ttl: -1, value: { kind: 'zset', members: [['an', 980], ['binh', 870], ['chi', 640]] } })
      return ok({ key_type: 'string', ttl: 42, value: { kind: 'string', value: 'demo-value' } })
    }
    case 'redis_del':
      return ok(1)
    case 'redis_set_ttl':
    case 'redis_edit':
    case 'redis_flushdb':
    case 'redis_subscribe':
    case 'redis_unsubscribe':
      return ok(null)
    case 'redis_publish':
      return ok(1)
    case 'redis_command': {
      const a = (args?.args as string[]) ?? []
      const cmd = (a[0] ?? '').toUpperCase()
      if (cmd === 'PING') return ok('PONG')
      if (cmd === 'GET') return ok('"demo-value"')
      if (cmd === 'DBSIZE') return ok('(integer) 6')
      return ok('OK')
    }
    case 'redis_memory_usage':
      return ok(128)
    case 'nats_info':
      return ok({ version: '2.10.14', server_name: 'nats-demo', host: '10.0.1.9', port: 4222, max_payload: 1048576, client_id: 42, go: 'go1.22' })
    case 'nats_subscribe':
    case 'nats_unsubscribe':
    case 'nats_publish':
      return ok(null)
    case 'nats_request':
      return ok('{"ok":true,"demo":"reply"}')
    case 'nats_js_streams':
      return ok([
        { name: 'ORDERS', subjects: ['orders.>'], retention: 'Limits', storage: 'File', messages: 1240, bytes: 98304, consumers: 2 },
        { name: 'EVENTS', subjects: ['events.*'], retention: 'WorkQueue', storage: 'Memory', messages: 57, bytes: 8192, consumers: 1 },
      ])
    case 'nats_js_consumers':
      return ok([
        { name: 'order-processor', deliver_policy: 'All', ack_policy: 'Explicit', filter_subject: 'orders.new', num_pending: 12, num_ack_pending: 0 },
        { name: 'audit', deliver_policy: 'New', ack_policy: 'None', filter_subject: '', num_pending: 0, num_ack_pending: 0 },
      ])
    case 'nats_js_peek':
      return ok({ seq: (args?.seq as number) ?? 1, subject: 'orders.new', payload: '{"id":1001,"total":42.5}', time: '2026-06-30T10:23:14Z' })
    case 'kafka_cluster':
      return ok({
        brokers: [
          { id: 1, host: 'kafka-1', port: 9092 },
          { id: 2, host: 'kafka-2', port: 9092 },
          { id: 3, host: 'kafka-3', port: 9092 },
        ],
        controller_id: 1,
        topic_count: 2,
        partition_count: 18,
      })
    case 'kafka_topics':
      return ok([
        {
          name: 'payments',
          internal: false,
          partitions: Array.from({ length: 3 }, (_, i) => ({ id: i, leader: (i % 3) + 1, replicas: [1, 2, 3], isr: [1, 2, 3], low: 0, high: 15200 + i * 100, lag: 15200 + i * 100 })),
        },
        {
          name: 'enrollment.events',
          internal: false,
          partitions: Array.from({ length: 2 }, (_, i) => ({ id: i, leader: (i % 3) + 1, replicas: [1, 2], isr: [1, 2], low: 40, high: 980 + i * 50, lag: 940 + i * 50 })),
        },
      ])
    case 'kafka_create_topic':
    case 'kafka_delete_topic':
      return ok(null)
    default:
      return Promise.reject(new Error(`demo: chưa mock command "${cmd}"`))
  }
}
