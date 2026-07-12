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
  schema_registry_url: '',
  cassandra_dc: '',
  cassandra_consistency: '',
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
  conn('c12', 'Events MongoDB', 'mongodb', '10.0.6.2', 27017, 'app', 'mongo', 'Document', 'production', {
    connected: true,
    latency_ms: 5,
    has_password: false,
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

// Stateful demo JetStream stream list so create/delete actually mutate it — a deleted
// stream must NOT reappear on refresh (mirrors the real backend). Reset per page load.
interface DemoNatsStream {
  name: string
  subjects: string[]
  retention: string
  storage: string
  messages: number
  bytes: number
  consumers: number
}
let demoNatsStreams: DemoNatsStream[] = [
  { name: 'ORDERS', subjects: ['orders.eu', 'orders.us'], retention: 'Limits', storage: 'File', messages: 1240, bytes: 98304, consumers: 2 },
  { name: 'EVENTS', subjects: ['events.*'], retention: 'WorkQueue', storage: 'Memory', messages: 57, bytes: 8192, consumers: 1 },
]

interface DemoKafkaPartition {
  id: number
  leader: number
  replicas: number[]
  isr: number[]
  low: number
  high: number
  lag: number
}
interface DemoKafkaTopic {
  name: string
  internal: boolean
  partitions: DemoKafkaPartition[]
}
let demoKafkaTopics: DemoKafkaTopic[] = [
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
]

/**
 * Mock trả lời cho từng IPC command khi không có Tauri runtime.
 * Chỉ đủ cho render/visual — thao tác ghi là no-op.
 */
export function demoInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Test observability (demo/browser only): count IPC calls per command so e2e can
  // assert that actions like Refresh actually re-hit the backend. No effect in Tauri.
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __ipcCalls?: Record<string, number> }
    w.__ipcCalls = w.__ipcCalls ?? {}
    w.__ipcCalls[cmd] = (w.__ipcCalls[cmd] ?? 0) + 1
  }
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
    case 'cancel_test':
      return ok(null)
    case 'save_connection':
      return ok((args?.draft as { profile: unknown })?.profile)
    case 'quick_connect': {
      const p = (args?.draft as { profile: ProfilePublic })?.profile
      return ok({ ...p, id: `quick-demo-${p?.name ?? ''}`, connected: true, latency_ms: 7, has_password: false })
    }
    case 'duplicate_connection':
      return ok({ ...DEMO_PROFILES[0], id: 'copy', name: 'Copy' })
    case 'list_databases':
      return ok([
        { name: 'app', current: true },
        { name: 'analytics', current: false },
        { name: 'postgres', current: false },
      ])
    case 'open_database': {
      const db = String(args?.database ?? 'db')
      const base = DEMO_PROFILES[0]
      return ok({ ...base, id: `quick-demo-db-${db}`, name: `${base.name} · ${db}`, database: db, connected: true, latency_ms: 7, has_password: false })
    }
    case 'attach_database': {
      const db = String(args?.database ?? 'db')
      const cid = String(args?.connId ?? '')
      // current database ('app' in the demo list) → same connection; else sub-id
      return ok(db === 'app' ? cid : `${cid}::${db}`)
    }
    case 'open_tab_connection': {
      const cid = String(args?.connId ?? '')
      const tabId = String(args?.tabId ?? '')
      return ok(`${cid}#tab-${tabId}`)
    }
    case 'close_tab_connection':
      return ok(null)
    case 'list_schemas':
      return ok([{ name: 'public', is_default: true }])
    case 'list_tables':
      return ok([
        { name: 'students', kind: 'table', row_estimate: 3842, locked: false, engine: 'MergeTree', data_length: 1114112 },
        { name: 'courses', kind: 'table', row_estimate: 214, locked: false, engine: 'ReplacingMergeTree', data_length: 65536 },
        { name: 'enrollments', kind: 'table', row_estimate: 12480, locked: false, engine: 'MergeTree', data_length: 3686400 },
        // reserved/keyword-named tables — autocomplete must quote them per dialect.
        // `schedule` is a keyword only in MySQL/MariaDB; `order` is reserved in
        // every engine (PG/SQLite "order", MySQL/MariaDB/CH `order`, MSSQL [order]).
        { name: 'schedule', kind: 'table', row_estimate: 168, locked: false, engine: 'MergeTree', data_length: 16384 },
        { name: 'order', kind: 'table', row_estimate: 920, locked: false, engine: 'MergeTree', data_length: 327680 },
        { name: 'vw_active_students', kind: 'view', row_estimate: null, locked: false, engine: 'MaterializedView' },
        { name: 'vw_recent_enrollments', kind: 'view', row_estimate: null, locked: false, engine: 'View' },
      ])
    case 'list_columns': {
      // Table-aware columns so the ER diagram shows real PK↔FK relationships:
      // enrollments holds FKs (student_id, course_id) referencing students.id /
      // courses.id. Other tables keep the generic demo shape.
      const colTable = String(args?.table ?? '')
      if (colTable === 'enrollments')
        return ok([
          { name: 'id', data_type: 'int4', nullable: false, default: null, is_pk: true, is_fk: false, auto_increment: true },
          { name: 'student_id', data_type: 'int4', nullable: false, default: null, is_pk: false, is_fk: true },
          { name: 'course_id', data_type: 'int4', nullable: false, default: null, is_pk: false, is_fk: true },
          { name: 'grade', data_type: 'varchar(2)', nullable: true, default: null, is_pk: false, is_fk: false },
          { name: 'enrolled_on', data_type: 'date', nullable: false, default: null, is_pk: false, is_fk: false },
        ])
      if (colTable === 'courses')
        return ok([
          { name: 'id', data_type: 'int4', nullable: false, default: null, is_pk: true, is_fk: false, auto_increment: true },
          { name: 'code', data_type: 'varchar(12)', nullable: false, default: null, is_pk: false, is_fk: false },
          { name: 'title', data_type: 'varchar(120)', nullable: false, default: null, is_pk: false, is_fk: false },
          { name: 'credits', data_type: 'int4', nullable: false, default: null, is_pk: false, is_fk: false },
          { name: 'department', data_type: 'varchar(60)', nullable: true, default: null, is_pk: false, is_fk: false },
        ])
      return ok([
        // identity PK — Generate Test Data excludes auto-increment columns by default
        { name: 'id', data_type: 'int4', nullable: false, default: null, is_pk: true, is_fk: false, auto_increment: true },
        { name: 'first_name', data_type: 'varchar(80)', nullable: false, default: null, is_pk: false, is_fk: false },
        { name: 'status', data_type: 'varchar(20)', nullable: true, default: null, is_pk: false, is_fk: false },
        { name: 'is_active', data_type: 'bool', nullable: false, default: null, is_pk: false, is_fk: false },
        // reserved-word column name — autocomplete must insert it quoted
        { name: 'order', data_type: 'int4', nullable: true, default: null, is_pk: false, is_fk: false },
      ])
    }
    case 'index_definition': {
      // Real index DDL (demo): shows INCLUDE + partial WHERE that a column-only
      // reconstruction would miss.
      const nm = String(args?.name ?? 'idx')
      const sch = String(args?.schema ?? 'public')
      const tbl = String(args?.table ?? 'students')
      return ok(
        `CREATE UNIQUE INDEX ${nm} ON ${sch}.${tbl} USING btree (email) INCLUDE (first_name) WHERE deleted_at IS NULL;`,
      )
    }
    case 'scan_indexes':
      return ok({
        system: 'postgres',
        scope: 'public',
        indexes: [
          { name: 'students_pkey', table: 'students', columns: ['id'], index_type: 'BTREE', unique: true, primary: true, size_bytes: 16384, usage: 89231, valid: true, flags: [] },
          { name: 'idx_students_email', table: 'students', columns: ['email'], index_type: 'BTREE', unique: true, primary: false, size_bytes: 24576, usage: 4210, valid: true, flags: [] },
          { name: 'idx_students_name', table: 'students', columns: ['last_name'], index_type: 'BTREE', unique: false, primary: false, size_bytes: 32768, usage: 0, valid: true, flags: ['unused'] },
          { name: 'idx_enroll_sc', table: 'enrollments', columns: ['student_id', 'course_id'], index_type: 'BTREE', unique: false, primary: false, size_bytes: 49152, usage: 1200, valid: true, flags: [] },
          { name: 'idx_enroll_s', table: 'enrollments', columns: ['student_id'], index_type: 'BTREE', unique: false, primary: false, size_bytes: 40960, usage: 33, valid: true, flags: ['redundant'] },
        ],
        summary: { total: 5, total_size_bytes: 163840, unused: 1, redundant: 1, fragmented: 0, invalid: 0 },
        suggestions: [
          { table: 'enrollments', columns: [], reason: '840 seq scans (12 index scans), avg 5200 rows/scan read over ~12480 rows — consider adding an index on the filter column' },
        ],
      })
    case 'admin_view': {
      const view = String(args?.view ?? 'sessions')
      if (view === 'users')
        return ok({ cols: [['role', 'text'], ['is_superuser', 'bool'], ['can_login', 'bool']], rows: [
          { role: 'postgres', is_superuser: true, can_login: true },
          { role: 'app_ro', is_superuser: false, can_login: true },
        ], total: 2 })
      if (view === 'extensions')
        return ok({ cols: [['name', 'text'], ['default_version', 'text'], ['installed_version', 'text']], rows: [
          { name: 'plpgsql', default_version: '1.0', installed_version: '1.0' },
          { name: 'citext', default_version: '1.6', installed_version: null },
        ], total: 2 })
      if (view === 'locks')
        return ok({ cols: [['pid', 'int4'], ['locktype', 'text'], ['mode', 'text'], ['granted', 'bool']], rows: [
          { pid: 4821, locktype: 'relation', mode: 'AccessShareLock', granted: true },
        ], total: 1 })
      if (view === 'agent_jobs')
        return ok({ cols: [['name', 'text'], ['enabled', 'bit'], ['category', 'text']], rows: [
          { name: 'nightly_reindex', enabled: true, category: 'Maintenance' },
        ], total: 1 })
      if (view === 'query_store')
        return ok({ cols: [['query_id', 'int'], ['query_text', 'text'], ['count_executions', 'int'], ['avg_ms', 'decimal']], rows: [
          { query_id: 7, query_text: 'SELECT * FROM exams WHERE score > @p', count_executions: 1240, avg_ms: 18.42 },
        ], total: 1 })
      if (view === 'availability_groups')
        return ok({ cols: [['name', 'text'], ['role', 'text'], ['sync_health', 'text']], rows: [], total: 0 })
      if (view === 'memory')
        return ok({ cols: [['metric', 'text'], ['value', 'text']], rows: [
          { metric: 'used_memory', value: '2097152' },
          { metric: 'used_memory_human', value: '2.00M' },
          { metric: 'maxmemory_policy', value: 'noeviction' },
        ], total: 3 })
      return ok({ cols: [['pid', 'int4'], ['username', 'text'], ['database', 'text'], ['state', 'text'], ['query', 'text']], rows: [
        { pid: 4821, username: 'app_ro', database: 'sis_prod', state: 'active', query: 'SELECT * FROM students' },
        { pid: 4830, username: 'app_ro', database: 'sis_prod', state: 'idle', query: '' },
      ], total: 2 })
    }
    case 'kill_session':
      return ok(null)
    case 'backup_tool_status':
      return ok({ tool: 'pg_dump', available: true })
    case 'backup_database':
      return ok(`✓ backup → ${String(args?.dest ?? 'backup.sql')} (demo)`)
    case 'restore_database':
      return ok(`✓ restored ← ${String(args?.src ?? 'backup.sql')} (demo)`)
    case 'object_definition': {
      const kind = String(args?.kind ?? 'object')
      const name = String(args?.name ?? 'obj')
      if (kind === 'view') return ok(`SELECT id, first_name, gpa\nFROM students\nWHERE status = 'active'`)
      if (kind === 'trigger') return ok(`CREATE TRIGGER ${name} BEFORE INSERT ON students\nFOR EACH ROW EXECUTE FUNCTION log_insert();`)
      return ok(`CREATE OR REPLACE FUNCTION ${name}(x integer)\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT x + 1 $function$`)
    }
    case 'list_foreign_keys':
      return ok([
        { name: 'fk_enrollments_student', from_table: 'enrollments', from_column: 'student_id', to_table: 'students', to_column: 'id' },
        { name: 'fk_enrollments_course', from_table: 'enrollments', from_column: 'course_id', to_table: 'courses', to_column: 'id' },
      ])
    case 'list_indexes':
      return ok([
        { name: 'students_pkey', method: 'btree', columns: ['id'], unique: true, primary: true },
        { name: 'idx_students_gpa', method: 'btree', columns: ['gpa'], unique: false, primary: false },
      ])
    case 'list_constraints':
      return ok([{ name: 'students_pkey', kind: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' }])
    case 'list_partitions':
      // Only the demo 'enrollments' table is partitioned (RANGE by year).
      return ok(
        (args?.table as string) === 'enrollments'
          ? [
              { name: 'enrollments_2023', method: 'RANGE', key: 'RANGE (enrolled_on)', expression: "FOR VALUES FROM ('2023-01-01') TO ('2024-01-01')", rows: 4120, position: 1 },
              { name: 'enrollments_2024', method: 'RANGE', key: 'RANGE (enrolled_on)', expression: "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')", rows: 5230, position: 2 },
              { name: 'enrollments_2025', method: 'RANGE', key: 'RANGE (enrolled_on)', expression: "FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')", rows: 3130, position: 3 },
            ]
          : [],
      )
    case 'list_routines':
      return ok([
        { schema: 'public', name: 'add_one', kind: 'function', params: [{ name: 'x', data_type: 'int4' }], return_type: 'int4' },
        { schema: 'public', name: 'current_load', kind: 'function', params: [], return_type: 'float8' },
        { schema: 'public', name: 'refresh_stats', kind: 'procedure', params: [] },
        { schema: 'public', name: 'recompute_ranks', kind: 'procedure', params: [] },
      ])
    case 'list_functions':
      // A small slice standing in for the server catalog (pg_proc etc.). The real
      // engines return hundreds; the frontend merges these with its static set.
      return ok([
        { name: 'to_char', signature: 'to_char(timestamp, text)', detail: 'function' },
        { name: 'date_trunc', signature: 'date_trunc(text, timestamp)', detail: 'function' },
        { name: 'jsonb_agg', signature: 'jsonb_agg(anyelement)', detail: 'aggregate' },
        { name: 'regexp_replace', signature: 'regexp_replace(text, text, text)', detail: 'function' },
        { name: 'split_part', signature: 'split_part(text, text, integer)', detail: 'function' },
      ])
    case 'list_triggers':
      return ok([
        { schema: 'public', name: 'trg_audit', table: 'students', event: 'BEFORE INSERT' },
        { schema: 'public', name: 'trg_updated_at', table: 'courses', event: 'BEFORE UPDATE' },
      ])
    case 'list_sequences':
      return ok([])
    case 'exec_statement': {
      // Collation unification (MySQL/MariaDB) — feed the audit dialog demo data.
      const stmtSql = String(args?.sql ?? '')
      // Table Data Viewer footer: a plain COUNT(*) → a fixed demo total.
      if (/^\s*SELECT\s+COUNT\(\*\)/i.test(stmtSql)) {
        return ok({ ok: true, result: { cols: [['c', 'int8']], rows: [{ c: 3842 }], total: 1 }, duration_ms: 4 })
      }
      if (/information_schema\.SCHEMATA/i.test(stmtSql) && /DEFAULT_COLLATION_NAME/i.test(stmtSql)) {
        return ok({ ok: true, result: { cols: [['charset', 'text'], ['collation', 'text']], rows: [{ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }], total: 1 }, duration_ms: 3 })
      }
      if (/information_schema\.COLLATIONS/i.test(stmtSql)) {
        return ok({ ok: true, result: { cols: [['name', 'text'], ['is_default', 'text']], rows: [{ name: 'utf8mb4_0900_ai_ci', is_default: 'Yes' }, { name: 'utf8mb4_general_ci', is_default: '' }, { name: 'utf8mb4_unicode_ci', is_default: '' }], total: 3 }, duration_ms: 3 })
      }
      if (/GROUP_CONCAT\(DISTINCT c\.COLLATION_NAME/i.test(stmtSql)) {
        return ok({
          ok: true,
          result: {
            cols: [['table_name', 'text'], ['table_collation', 'text'], ['column_collations', 'text']],
            rows: [
              { table_name: 'sequences', table_collation: 'utf8mb4_0900_ai_ci', column_collations: 'utf8mb4_0900_ai_ci' },
              { table_name: 'audit_log', table_collation: 'utf8mb4_general_ci', column_collations: 'utf8mb4_general_ci' },
            ],
            total: 2,
          },
          duration_ms: 4,
        })
      }
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
            { id: 2, first_name: 'Binh', gpa: 3.7 },
            { id: 3, first_name: 'Chi', gpa: null },
          ],
          total: 3,
        },
        duration_ms: 12,
      })
    }
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
    case 'redis_select_db':
    case 'redis_subscribe':
    case 'redis_unsubscribe':
      return ok(null)
    case 'redis_database_count':
      return ok(16)
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
      return ok(demoNatsStreams.map((s) => ({ ...s, subjects: [...s.subjects] })))
    case 'nats_js_subject_messages': {
      // Simulate server-side pagination: a subject with 250 retained messages;
      // return only the page starting at `startSeq` (ascending), bounded by `limit`.
      // Time increases monotonically with sequence (1s apart) so newest-by-time
      // equals highest-sequence.
      const TOTAL = 250
      const base = Date.UTC(2026, 5, 30, 10, 0, 0)
      const limit = Math.max(1, Number(args?.limit ?? 100))
      const startSeq = Math.max(1, Number(args?.startSeq ?? 1))
      const subj = (args?.subject as string) ?? 'orders.eu'
      const out = []
      for (let seq = startSeq; seq < startSeq + limit && seq <= TOTAL; seq++) {
        const i = seq - 1
        out.push({
          seq,
          subject: subj,
          payload: `{"id":${1000 + i}}`,
          time: new Date(base + seq * 1000).toISOString(),
          key: `msg-${1000 + i}`,
        })
      }
      return ok(out)
    }
    case 'nats_js_subject_stats':
      return ok({ total: 250, last_seq: 250 })
    case 'nats_js_purge_subject':
    case 'nats_js_remove_subject':
    case 'nats_js_add_subject':
      return ok(null)
    case 'nats_js_consumers':
      return ok([
        { name: 'order-processor', deliver_policy: 'All', ack_policy: 'Explicit', filter_subject: 'orders.new', num_pending: 12, num_ack_pending: 0 },
        { name: 'audit', deliver_policy: 'New', ack_policy: 'None', filter_subject: '', num_pending: 0, num_ack_pending: 0 },
      ])
    case 'nats_js_peek':
      return ok({ seq: (args?.seq as number) ?? 1, subject: 'orders.new', payload: '{"id":1001,"total":42.5}', time: '2026-06-30T10:23:14Z', key: 'msg-1001' })
    case 'nats_js_create_stream': {
      const name = String(args?.name ?? '')
      const subjects = (args?.subjects as string[]) ?? []
      if (name && !demoNatsStreams.some((s) => s.name === name)) {
        demoNatsStreams = [...demoNatsStreams, { name, subjects, retention: 'Limits', storage: 'File', messages: 0, bytes: 0, consumers: 0 }]
      }
      return ok(null)
    }
    case 'nats_js_delete_stream': {
      const name = String(args?.name ?? '')
      demoNatsStreams = demoNatsStreams.filter((s) => s.name !== name) // real removal
      return ok(null)
    }
    case 'nats_js_purge_stream':
    case 'nats_js_create_consumer':
    case 'nats_js_delete_consumer':
    case 'nats_js_delete_message':
    case 'nats_kv_create':
    case 'nats_kv_delete_bucket':
    case 'nats_kv_put':
    case 'nats_kv_delete':
    case 'nats_obj_create':
    case 'nats_obj_delete_bucket':
    case 'nats_obj_put_file':
    case 'nats_obj_get_file':
    case 'nats_obj_delete':
      return ok(null)
    case 'nats_kv_buckets':
      return ok(['config', 'sessions'])
    case 'nats_kv_keys':
      return ok(['feature.flags', 'rate.limit', 'maintenance'])
    case 'nats_kv_get':
      return ok('{"enabled":true}')
    case 'nats_obj_buckets':
      return ok(['uploads', 'backups'])
    case 'nats_obj_list':
      return ok([
        { name: 'report-2026.pdf', size: 284512, chunks: 3 },
        { name: 'avatar.png', size: 10240, chunks: 1 },
      ])
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
      return ok(demoKafkaTopics.map((t) => ({ ...t, partitions: t.partitions.map((p) => ({ ...p })) })))
    case 'kafka_create_topic': {
      const name = String(args?.name ?? '')
      const parts = Math.max(1, Number(args?.partitions ?? 1))
      if (name && !demoKafkaTopics.some((t) => t.name === name)) {
        demoKafkaTopics = [
          ...demoKafkaTopics,
          { name, internal: false, partitions: Array.from({ length: parts }, (_, i) => ({ id: i, leader: (i % 3) + 1, replicas: [1], isr: [1], low: 0, high: 0, lag: 0 })) },
        ]
      }
      return ok(null)
    }
    case 'kafka_delete_topic': {
      const name = String(args?.name ?? '')
      demoKafkaTopics = demoKafkaTopics.filter((t) => t.name !== name) // real removal
      return ok(null)
    }
    case 'kafka_purge_topic':
    case 'kafka_delete_records':
    case 'kafka_consume':
    case 'kafka_stop_consume':
      return ok(null)
    case 'kafka_produce':
      return ok({ partition: 0, offset: 15201 })
    case 'kafka_consumer_groups':
      return ok([
        { name: 'payment-processor', state: 'Stable', protocol: 'range', members: [
          { member_id: 'consumer-1-abc', client_id: 'svc-payments', host: '/10.0.1.20' },
          { member_id: 'consumer-2-def', client_id: 'svc-payments', host: '/10.0.1.21' },
        ] },
        { name: 'audit-log', state: 'Empty', protocol: '', members: [] },
      ])
    case 'kafka_group_lag':
      return ok([
        { topic: 'payments', partition: 0, committed: 15100, high: 15200, lag: 100 },
        { topic: 'payments', partition: 1, committed: 15290, high: 15301, lag: 11 },
        { topic: 'payments', partition: 2, committed: 15400, high: 15400, lag: 0 },
      ])
    case 'kafka_reset_offset':
      return ok(null)
    case 'kafka_sr_subjects':
      return ok([
        { name: 'enrollment.events-value', fmt: 'AVRO', latest: 3, compat: 'BACKWARD' },
        { name: 'grade.posted-value', fmt: 'AVRO', latest: 2, compat: 'FULL' },
        { name: 'payment.received-value', fmt: 'PROTOBUF', latest: 1, compat: 'BACKWARD' },
        { name: 'attendance.scan-value', fmt: 'JSON', latest: 2, compat: 'NONE' },
      ])
    case 'kafka_sr_versions': {
      const subj = (args?.subject as string) ?? ''
      const vers: Record<string, number[]> = {
        'enrollment.events-value': [1, 2, 3],
        'grade.posted-value': [1, 2],
        'payment.received-value': [1],
        'attendance.scan-value': [1, 2],
      }
      return ok(vers[subj] ?? [1])
    }
    case 'kafka_sr_schema': {
      const a = { subject: (args?.subject as string) ?? '', version: (args?.version as number) ?? 1 }
      const reg: Record<string, { fmt: string; compat: string; schema: string }> = {
        'enrollment.events-value': {
          fmt: 'AVRO', compat: 'BACKWARD',
          schema: '{\n  "type": "record",\n  "name": "EnrollmentEvent",\n  "namespace": "edu.greenfield.sis",\n  "fields": [\n    { "name": "student_id", "type": "long" },\n    { "name": "course_code", "type": "string" },\n    { "name": "action", "type": { "type": "enum", "name": "Action", "symbols": ["enroll","drop","waitlist"] } },\n    { "name": "term", "type": "string" },\n    { "name": "ts", "type": { "type": "long", "logicalType": "timestamp-millis" } }\n  ]\n}',
        },
        'grade.posted-value': {
          fmt: 'AVRO', compat: 'FULL',
          schema: '{\n  "type": "record",\n  "name": "GradePosted",\n  "namespace": "edu.greenfield.sis",\n  "fields": [\n    { "name": "student_id", "type": "long" },\n    { "name": "course_id", "type": "long" },\n    { "name": "grade", "type": "string" },\n    { "name": "posted_at", "type": { "type": "long", "logicalType": "timestamp-millis" } }\n  ]\n}',
        },
        'payment.received-value': {
          fmt: 'PROTOBUF', compat: 'BACKWARD',
          schema: 'syntax = "proto3";\npackage edu.greenfield.finance;\n\nmessage PaymentReceived {\n  int64 student_id = 1;\n  double amount = 2;\n  string method = 3;\n  int64 ts = 4;\n}',
        },
        'attendance.scan-value': {
          fmt: 'JSON', compat: 'NONE',
          schema: '{\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "title": "AttendanceScan",\n  "type": "object",\n  "properties": {\n    "student_id": { "type": "integer" },\n    "device": { "type": "string" },\n    "status": { "enum": ["present","late","absent"] }\n  },\n  "required": ["student_id","status"]\n}',
        },
      }
      const r = reg[a.subject] ?? reg['enrollment.events-value']
      return ok({ subject: a.subject, version: a.version, id: 1000 + a.version, fmt: r.fmt, schema: r.schema, compat: r.compat })
    }
    // ---- Cassandra (Phase 4b) ----
    case 'cql_exec': {
      const cql = String((args?.cql as string) ?? '').toLowerCase()
      const pageToken = (args?.pageToken as string | undefined) ?? undefined
      // JOIN/subquery đã bị lint chặn ở editor; ở đây engine cũng từ chối rõ.
      if (/\bjoin\b/.test(cql)) {
        return ok({
          ok: false,
          error: { message: 'CQL does not support JOIN', detail: 'InvalidRequest' },
          duration_ms: 1,
          warnings: [],
        })
      }
      // WHERE trên cột không-index thiếu ALLOW FILTERING → lỗi từ "driver".
      if (/where/.test(cql) && /\bname\s*=/.test(cql) && !/allow\s+filtering/.test(cql)) {
        return ok({
          ok: false,
          error: {
            message:
              'Cannot execute this query as it might involve data filtering... use ALLOW FILTERING',
            detail: 'InvalidRequest',
          },
          duration_ms: 2,
          warnings: [],
        })
      }
      // Page 1 (no token) → 25 rows + a next-page token; page 2 (token present) →
      // 25 more rows and NO token (paging terminates), so "Load next page" resolves.
      const base = pageToken ? 25 : 0
      const rows = Array.from({ length: 25 }, (_, k) => {
        const i = base + k
        return {
          student_id: `s${1000 + i}`,
          email: `student.${i}@student.greenfield.edu`,
          name: `Student ${i}`,
          grade_level: 9 + (i % 4),
          created_at: '2026-05-01T08:00:00+00:00',
        }
      })
      const warnings = /allow\s+filtering/.test(cql)
        ? ['Query uses ALLOW FILTERING and may be slow (full cluster scan)']
        : []
      return ok({
        ok: true,
        result: {
          cols: [
            ['student_id', 'Uuid'],
            ['email', 'Text'],
            ['name', 'Text'],
            ['grade_level', 'Int'],
            ['created_at', 'Timestamp'],
          ],
          rows,
          total: rows.length,
        },
        duration_ms: 12,
        next_page: pageToken ? undefined : 'DEMO_PAGE_2',
        warnings,
      })
    }
    case 'cassandra_keyspaces':
      return ok(['campus_ks', 'library_ks'])
    case 'cassandra_tree':
      return ok({
        keyspace: String((args?.keyspace as string) ?? 'campus_ks'),
        replication: "{ 'class': 'NetworkTopologyStrategy', 'dc1': '3' }",
        tables: [
          {
            name: 'students_by_id',
            columns: [
              { name: 'student_id', data_type: 'uuid', kind: 'partition_key', clustering_order: '', position: 0 },
              { name: 'email', data_type: 'text', kind: 'regular', clustering_order: '', position: -1 },
              { name: 'name', data_type: 'text', kind: 'regular', clustering_order: '', position: -1 },
              { name: 'grade_level', data_type: 'int', kind: 'regular', clustering_order: '', position: -1 },
              { name: 'created_at', data_type: 'timestamp', kind: 'regular', clustering_order: '', position: -1 },
            ],
          },
          {
            name: 'grades_by_student',
            columns: [
              { name: 'student_id', data_type: 'uuid', kind: 'partition_key', clustering_order: '', position: 0 },
              { name: 'term_course', data_type: 'text', kind: 'clustering', clustering_order: 'asc', position: 0 },
              { name: 'grade', data_type: 'text', kind: 'regular', clustering_order: '', position: -1 },
              { name: 'points', data_type: 'decimal', kind: 'regular', clustering_order: '', position: -1 },
            ],
          },
          {
            name: 'sessions',
            columns: [
              { name: 'session_id', data_type: 'uuid', kind: 'partition_key', clustering_order: '', position: 0 },
              { name: 'student_id', data_type: 'uuid', kind: 'regular', clustering_order: '', position: -1 },
              { name: 'last_seen', data_type: 'timestamp', kind: 'regular', clustering_order: '', position: -1 },
            ],
          },
        ],
        views: [{ name: 'students_by_email', base_table: 'students_by_id' }],
        types: [{ name: 'address', fields: [['street', 'text'], ['city', 'text']] }],
        functions: [{ name: 'avg_state', kind: 'function', signature: 'avg_state(double, double)' }],
        indexes: [{ name: 'grades_grade_idx', table: 'grades_by_student', kind: 'COMPOSITES', target: 'grade' }],
      })
    case 'cassandra_ring':
      return ok([
        { host: '10.0.5.1', dc: 'dc1', rack: 'rack1', state: 'UN', load: '256 tokens', owns: '33.3%', version: '4.1.3' },
        { host: '10.0.5.2', dc: 'dc1', rack: 'rack2', state: 'UN', load: '256 tokens', owns: '33.3%', version: '4.1.3' },
        { host: '10.0.5.3', dc: 'dc2', rack: 'rack1', state: 'UN', load: '256 tokens', owns: '33.4%', version: '4.1.3' },
      ])
    case 'cassandra_table_ddl':
      return ok(
        'CREATE TABLE campus_ks.grades_by_student (\n  student_id uuid,\n  term_course text,\n  grade text,\n  points decimal,\n  PRIMARY KEY ((student_id), term_course)\n)\nWITH CLUSTERING ORDER BY (term_course ASC);',
      )
    case 'cassandra_object_ddl': {
      const kind = String((args?.kind as string) ?? 'table')
      const nm = String((args?.name as string) ?? 'obj')
      const ks = String((args?.keyspace as string) ?? 'campus_ks')
      if (kind === 'type') return ok(`CREATE TYPE ${ks}.${nm} (\n  street text,\n  city text\n);`)
      if (kind === 'view')
        return ok(
          `CREATE MATERIALIZED VIEW ${ks}.${nm} AS\nSELECT student_id, email\nFROM ${ks}.students_by_id\nWHERE email IS NOT NULL AND student_id IS NOT NULL\nPRIMARY KEY ((email), student_id);`,
        )
      if (kind === 'index') return ok(`CREATE INDEX ${nm} ON ${ks}.grades_by_student (grade);`)
      if (kind === 'function')
        return ok(`CREATE FUNCTION ${ks}.${nm} (s text)\n  CALLED ON NULL INPUT\n  RETURNS text\n  LANGUAGE java\n  AS $$ return s; $$;`)
      return ok(
        `CREATE TABLE ${ks}.${nm} (\n  student_id uuid,\n  email text,\n  PRIMARY KEY ((student_id))\n);`,
      )
    }
    case 'cassandra_columns':
      // Mirrors the demo `cql_exec` result for students_by_id so the editable grid
      // targets a real primary key (student_id).
      return ok([
        { name: 'student_id', data_type: 'uuid', kind: 'partition_key', clustering_order: '', position: 0 },
        { name: 'email', data_type: 'text', kind: 'regular', clustering_order: '', position: -1 },
        { name: 'name', data_type: 'text', kind: 'regular', clustering_order: '', position: -1 },
        { name: 'grade_level', data_type: 'int', kind: 'regular', clustering_order: '', position: -1 },
        { name: 'created_at', data_type: 'timestamp', kind: 'regular', clustering_order: '', position: -1 },
      ])
    case 'explain_plan': {
      const actual = !!(args?.actual as boolean)
      const epCid = String(args?.connId ?? '').split(/::|#/)[0]
      const epSys = DEMO_PROFILES.find((p) => p.id === epCid)?.system ?? 'postgres'
      // Cassandra has no planner → tracing (diagnostics), not a cost-based plan.
      if (epSys === 'cassandra') {
        return ok({
          system: 'cassandra',
          mode: 'tracing',
          root: {
            operation: 'SeqScan',
            native_op: 'CQL Read',
            extra: { activity: 'Execute CQL query' },
            is_hotspot: true,
            children: [
              { operation: 'TraceEvent', native_op: 'Parsing CQL query', actual_time_ms: 0.05, extra: { source: '10.0.5.3' }, is_hotspot: false, children: [] },
              { operation: 'TraceEvent', native_op: 'Scanning all ranges (ALLOW FILTERING)', actual_time_ms: 4.2, extra: { source: '10.0.5.3' }, is_hotspot: false, children: [] },
            ],
          },
          summary: { total_time_ms: 4.2, warnings: ['ALLOW FILTERING: scans all partitions (no partition key) — expensive'] },
          raw: '50us 10.0.5.3 Parsing CQL query\n4200us 10.0.5.3 Scanning all ranges (ALLOW FILTERING)',
        })
      }
      return ok({
        system: 'postgres',
        mode: actual ? 'actual' : 'estimated',
        root: {
          operation: 'HashJoin',
          native_op: 'Hash Join',
          estimated_rows: 214,
          actual_rows: actual ? 214 : undefined,
          estimated_cost: 512.4,
          cost_pct: 24.2,
          actual_time_ms: actual ? 8.2 : undefined,
          extra: { 'Hash Cond': '(e.student_id = s.id)' },
          is_hotspot: false,
          children: [
            {
              operation: 'SeqScan',
              native_op: 'Seq Scan',
              estimated_rows: 50000,
              actual_rows: actual ? 48210 : undefined,
              estimated_cost: 380.0,
              cost_pct: 74.2,
              extra: { 'Relation Name': 'enrollments', Filter: "(status = 'active')" },
              is_hotspot: true,
              children: [],
            },
            {
              operation: 'IndexScan',
              native_op: 'Index Scan',
              estimated_rows: 1,
              estimated_cost: 8.3,
              cost_pct: 1.6,
              extra: { 'Index Name': 'students_pkey' },
              is_hotspot: false,
              children: [],
            },
          ],
        },
        summary: {
          total_cost: 512.4,
          total_time_ms: actual ? 8.2 : undefined,
          warnings: ['Seq Scan on enrollments (~50000 rows)'],
        },
        missing_index: {
          impact_pct: 92.5,
          table: 'enrollments',
          ddl: 'CREATE INDEX ix_enrollments_status ON enrollments (status);',
          reason: 'A selective filter on status has no supporting index.',
        },
        raw: '[{"Plan":{"Node Type":"Hash Join","Total Cost":512.4,"Plan Rows":214}}]',
      })
    }
    case 'explain_capability': {
      const cid = String(args?.connId ?? '').split(/::|#/)[0]
      const sys = DEMO_PROFILES.find((p) => p.id === cid)?.system ?? 'postgres'
      const cap = (system: string) => {
        switch (system) {
          case 'postgres':
          case 'mariadb':
          case 'mysql':
          case 'mssql':
            // P3.3 — MySQL (EXPLAIN ANALYZE) + MSSQL (STATISTICS XML) now support actual
            return { has_planner: true, supports_actual: true, actual_kind: 'analyze', cost_basis: 'cost' }
          case 'sqlite':
          case 'clickhouse':
            return { has_planner: true, supports_actual: false, actual_kind: 'none', cost_basis: 'rows_proxy' }
          case 'cassandra':
            return { has_planner: false, supports_actual: true, actual_kind: 'tracing', cost_basis: 'duration' }
          default:
            return { has_planner: false, supports_actual: false, actual_kind: 'none', cost_basis: 'none' }
        }
      }
      return ok(cap(sys))
    }
    case 'ch_dictionaries':
      return ok(['geo_regions', 'user_agents'])
    case 'ch_table_meta': {
      const tbl = (args?.table as string) ?? 'lms_events'
      return ok({
        engine: 'MergeTree',
        engine_full: 'MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY (event_type, student_id) TTL event_date + toIntervalDay(90) SETTINGS index_granularity = 8192',
        partition_key: 'toYYYYMM(event_date)',
        sorting_key: 'event_type, student_id',
        create_sql: `CREATE TABLE analytics.${tbl} (event_date Date, event_type LowCardinality(String)) ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY (event_type, student_id) TTL event_date + toIntervalDay(90) DELETE, event_date + toIntervalDay(30) TO VOLUME 'cold' SETTINGS index_granularity = 8192`,
        ttl_rules: [
          { expr: 'event_date + toIntervalDay(90)', action: 'DELETE', human: 'Delete data when: event_date + toIntervalDay(90)' },
          { expr: 'event_date + toIntervalDay(30)', action: 'MOVE', human: "Move part to disk/volume when: event_date + toIntervalDay(30) (TO VOLUME 'cold')" },
        ],
      })
    }
    // MongoDB query editor / collection viewer (browser & Playwright demo path).
    case 'mongo_exec': {
      const q = String(args?.query ?? '')
      if (/\.(insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|createIndex|createCollection|renameCollection|drop)\s*\(/i.test(q))
        return ok({ ok: true, affected: 1, duration_ms: 3, warnings: [] })
      if (/countDocuments/i.test(q))
        return ok({ ok: true, result: { cols: [['count', 'long']], rows: [{ count: 2 }], total: 1 }, duration_ms: 2, warnings: [] })
      return ok({
        ok: true,
        result: {
          cols: [['_id', 'objectId'], ['name', 'string'], ['age', 'int']],
          rows: [
            { _id: { $oid: '507f1f77bcf86cd799439011' }, name: 'Ann', age: 30 },
            { _id: { $oid: '507f1f77bcf86cd799439012' }, name: 'Bob', age: 25 },
          ],
          total: 2,
        },
        duration_ms: 4,
        warnings: [],
      })
    }
    default:
      return Promise.reject(new Error(`demo: command "${cmd}" not mocked yet`))
  }
}
