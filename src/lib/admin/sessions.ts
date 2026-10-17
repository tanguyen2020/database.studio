// Session Monitor: what one row of the engine's session list MEANS, in plain words.
// Every SQL engine's admin query returns the same columns (SESSION_COLUMNS in
// commands/admin.rs); the state vocabulary differs per engine, so it is mapped
// here to a handful of states a person can act on. Pure → unit-testable.

export type SessionState = 'active' | 'waiting' | 'idle-tx' | 'idle' | 'background' | 'other'

export interface SessionRow {
  pid: number | string
  username: string
  database: string
  client: string
  application: string
  state: string
  wait_type: string
  wait_event: string
  kind: 'client' | 'background' | string
  query_ms: number | null
  state_ms: number | null
  is_self: number | boolean
  query: string
}

export const STATE_LABEL: Record<SessionState, string> = {
  active: 'Active',
  waiting: 'Waiting',
  'idle-tx': 'Idle in transaction',
  idle: 'Idle',
  background: 'Background',
  other: 'Other',
}

/** Engines whose Session Monitor returns the shared shape. */
export const RICH_SESSION_SYSTEMS = ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle']
/** Engines that can stop only the running statement (session stays). */
export const CAN_CANCEL_QUERY = ['postgres', 'mysql', 'mariadb', 'oracle']

/** PostgreSQL wait event types that mean "blocked on something", not just idle. */
const PG_BLOCKING = ['Lock', 'LWLock', 'BufferPin', 'IO', 'IPC']

export function sessionState(system: string, r: Pick<SessionRow, 'state' | 'kind' | 'wait_type' | 'wait_event'>): SessionState {
  if (r.kind === 'background') return 'background'
  const s = (r.state ?? '').toLowerCase().trim()
  switch (system) {
    case 'postgres':
      if (s === 'active') return PG_BLOCKING.includes(r.wait_type) ? 'waiting' : 'active'
      if (s.startsWith('idle in transaction')) return 'idle-tx'
      if (s === 'idle') return 'idle'
      return 'other'
    case 'mysql':
    case 'mariadb':
      if (s === 'sleep') return 'idle'
      if (s === 'query' || s === 'execute') return /lock|waiting for/i.test(r.wait_event) ? 'waiting' : 'active'
      return 'other'
    case 'mssql':
      if (s === 'running' || s === 'runnable') return 'active'
      if (s === 'suspended') return 'waiting'
      if (s === 'sleeping' || s === 'dormant') return 'idle'
      return 'other'
    case 'oracle':
      // wait classes that mean blocked by another session (row locks, latches…)
      if (s === 'active') return /application|concurrency|configuration/i.test(r.wait_type ?? '') ? 'waiting' : 'active'
      if (s === 'inactive') return 'idle'
      return 'other'
    default:
      return s === 'active' ? 'active' : s === 'idle' ? 'idle' : 'other'
  }
}

/** 850 ms → "<1s" · 42 s → "42s" · 4 min 3 s → "4m 03s" · "2h 05m" · "3d 4h". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 1) return '<1s'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** The time worth showing for a row: how long the running query has run, or how
 *  long the session has sat idle / idle in a transaction. */
export function rowDuration(st: SessionState, r: Pick<SessionRow, 'query_ms' | 'state_ms'>): number | null {
  if (st === 'active' || st === 'waiting') return r.query_ms ?? r.state_ms
  if (st === 'idle-tx' || st === 'idle') return r.state_ms
  return null
}

/** How alarming a duration is: a query running a minute, or a transaction left
 *  open for a minute, deserves attention; five minutes is a problem. */
export function durationLevel(st: SessionState, ms: number | null): 'ok' | 'warn' | 'bad' {
  if (ms == null || !(st === 'active' || st === 'waiting' || st === 'idle-tx')) return 'ok'
  if (ms >= 5 * 60_000) return 'bad'
  if (ms >= 60_000) return 'warn'
  return 'ok'
}

/** What it waits on, or '' when the "wait" is just an idle session waiting for
 *  its client (noise on every idle row). */
export function waitText(system: string, st: SessionState, r: Pick<SessionRow, 'wait_type' | 'wait_event'>): string {
  const t = (r.wait_type ?? '').trim()
  const e = (r.wait_event ?? '').trim()
  if (st === 'idle' || st === 'background') return ''
  if (system === 'postgres' && (t === 'Client' || t === 'Activity') && st !== 'waiting') return ''
  if (system === 'oracle' && t === 'Idle') return ''
  if (t && e && t !== e) return `${t} · ${e}`
  return t || e
}

export interface SessionCounts {
  all: number
  active: number
  waiting: number
  'idle-tx': number
  idle: number
  background: number
  other: number
}

export function countStates(states: SessionState[]): SessionCounts {
  const c: SessionCounts = { all: 0, active: 0, waiting: 0, 'idle-tx': 0, idle: 0, background: 0, other: 0 }
  for (const s of states) {
    c[s]++
    if (s !== 'background') c.all++
  }
  return c
}

/** Free-text search over the fields a person would type: pid, user, database,
 *  application, client, query. */
export function matchesSession(r: SessionRow, q: string): boolean {
  const n = q.trim().toLowerCase()
  if (!n) return true
  return [r.pid, r.username, r.database, r.application, r.client, r.query].some((v) => String(v ?? '').toLowerCase().includes(n))
}

/** snake_case column → "Snake case" header for the generic admin tables. */
export function humanizeColumn(c: string): string {
  const special: Record<string, string> = {
    pid: 'PID', sid: 'SID', id: 'ID', db: 'Database', ms: 'ms', avg_ms: 'Avg (ms)', cpu_ms: 'CPU (ms)',
    is_superuser: 'Superuser', can_login: 'Can log in', can_create_db: 'Can create DB', can_create_role: 'Can create role',
    is_disabled: 'Disabled', default_version: 'Available version', installed_version: 'Installed version',
    query_id: 'Query ID', query_text: 'Query', count_executions: 'Executions', sync_health: 'Sync health',
    locktype: 'Lock type', relation: 'Relation', granted: 'Granted', elapsed_s: 'Elapsed (s)', read_rows: 'Rows read',
    mutation_id: 'Mutation ID', is_done: 'Done', latest_fail_reason: 'Last failure', create_time: 'Created',
    auth_type: 'Auth type', date_created: 'Created',
  }
  if (special[c]) return special[c]
  const words = c.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
