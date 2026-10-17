import { describe, expect, it } from 'vitest'
import { countStates, durationLevel, fmtDuration, humanizeColumn, matchesSession, rowDuration, sessionState, waitText, type SessionRow } from './sessions'

const row = (o: Partial<SessionRow>): SessionRow => ({
  pid: 1, username: 'app', database: 'db', client: '', application: '', state: '', wait_type: '', wait_event: '',
  kind: 'client', query_ms: null, state_ms: null, is_self: 0, query: '', ...o,
})

describe('sessionState', () => {
  it('postgres: active / waiting on a lock / idle in transaction / idle / background', () => {
    expect(sessionState('postgres', row({ state: 'active' }))).toBe('active')
    expect(sessionState('postgres', row({ state: 'active', wait_type: 'Lock' }))).toBe('waiting')
    expect(sessionState('postgres', row({ state: 'active', wait_type: 'Client' }))).toBe('active')
    expect(sessionState('postgres', row({ state: 'idle in transaction' }))).toBe('idle-tx')
    expect(sessionState('postgres', row({ state: 'idle in transaction (aborted)' }))).toBe('idle-tx')
    expect(sessionState('postgres', row({ state: 'idle', wait_type: 'Client' }))).toBe('idle')
    expect(sessionState('postgres', row({ state: '', kind: 'background' }))).toBe('background')
  })
  it('mysql / mssql / oracle vocabularies', () => {
    expect(sessionState('mysql', row({ state: 'Sleep' }))).toBe('idle')
    expect(sessionState('mysql', row({ state: 'Query', wait_event: 'Waiting for table metadata lock' }))).toBe('waiting')
    expect(sessionState('mariadb', row({ state: 'Query', wait_event: 'Sending data' }))).toBe('active')
    expect(sessionState('mssql', row({ state: 'running' }))).toBe('active')
    expect(sessionState('mssql', row({ state: 'suspended' }))).toBe('waiting')
    expect(sessionState('mssql', row({ state: 'sleeping' }))).toBe('idle')
    expect(sessionState('oracle', row({ state: 'inactive' }))).toBe('idle')
    expect(sessionState('oracle', row({ state: 'active', wait_type: 'Application' }))).toBe('waiting')
  })
})

describe('durations', () => {
  it('formats like a person reads time', () => {
    expect(fmtDuration(null)).toBe('')
    expect(fmtDuration(400)).toBe('<1s')
    expect(fmtDuration(42_000)).toBe('42s')
    expect(fmtDuration(243_000)).toBe('4m 03s')
    expect(fmtDuration(7_500_000)).toBe('2h 05m')
    expect(fmtDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h')
  })
  it('running queries use query time; idle sessions use time in state', () => {
    expect(rowDuration('active', { query_ms: 5000, state_ms: 9000 })).toBe(5000)
    expect(rowDuration('idle-tx', { query_ms: 5000, state_ms: 9000 })).toBe(9000)
    expect(rowDuration('background', { query_ms: 5000, state_ms: 9000 })).toBeNull()
  })
  it('a long query or an open transaction is flagged; a long idle session is not', () => {
    expect(durationLevel('active', 30_000)).toBe('ok')
    expect(durationLevel('active', 90_000)).toBe('warn')
    expect(durationLevel('idle-tx', 6 * 60_000)).toBe('bad')
    expect(durationLevel('idle', 6 * 60_000)).toBe('ok')
  })
})

describe('waitText / counts / search / headers', () => {
  it('hides the noise of idle sessions waiting for their client', () => {
    expect(waitText('postgres', 'idle', { wait_type: 'Client', wait_event: 'ClientRead' })).toBe('')
    expect(waitText('postgres', 'active', { wait_type: 'Client', wait_event: 'ClientRead' })).toBe('')
    expect(waitText('postgres', 'waiting', { wait_type: 'Lock', wait_event: 'relation' })).toBe('Lock · relation')
    expect(waitText('mysql', 'waiting', { wait_type: '', wait_event: 'Waiting for table metadata lock' })).toBe('Waiting for table metadata lock')
  })
  it('counts every state; background is not part of "all"', () => {
    expect(countStates(['active', 'idle', 'idle', 'background'])).toMatchObject({ all: 3, active: 1, idle: 2, background: 1 })
  })
  it('search covers pid, user, database, application, client and query', () => {
    const r = row({ pid: 4821, username: 'erplite', database: 'pay', application: 'psql', client: '10.0.0.5', query: 'UPDATE sync_queue' })
    for (const q of ['4821', 'ERP', 'pay', 'psql', '10.0.0', 'sync_queue']) expect(matchesSession(r, q)).toBe(true)
    expect(matchesSession(r, 'nope')).toBe(false)
  })
  it('turns snake_case into readable headers', () => {
    expect(humanizeColumn('pid')).toBe('PID')
    expect(humanizeColumn('is_superuser')).toBe('Superuser')
    expect(humanizeColumn('default_tablespace')).toBe('Default tablespace')
  })
})
