import { describe, expect, it } from 'vitest'
import { canKillDatabaseSessions, inUseExplanation, toDbSessions } from './db-sessions'

describe('toDbSessions', () => {
  it('normalizes the common aliases and keeps numbers numeric', () => {
    const s = toDbSessions([
      { pid: 4821, username: 'app', client: '10.0.0.5', program: 'psql', state: 'idle', started: '2026-10-15 08:00:00', query: 'SELECT 1', holds_lock: 1 },
    ])
    expect(s).toEqual([
      { pid: 4821, username: 'app', client: '10.0.0.5', program: 'psql', state: 'idle', started: '2026-10-15 08:00:00', seconds: null, query: 'SELECT 1', holdsLock: true },
    ])
  })

  it('accepts string pids, UPPERCASE (Oracle) keys and boolean locks', () => {
    const s = toDbSessions([{ PID: '57', USERNAME: 'APP ', HOLDS_LOCK: '0', SECONDS: '12' }])
    expect(s[0]).toMatchObject({ pid: 57, username: 'APP', holdsLock: false, seconds: 12 })
    expect(toDbSessions([{ pid: 1, holds_lock: true }])[0].holdsLock).toBe(true)
  })

  it('drops rows that cannot be killed (no usable pid)', () => {
    expect(toDbSessions([{ pid: null }, { pid: 'abc' }, { username: 'x' }, { pid: 3 }]).map((x) => x.pid)).toEqual([3])
  })
})

describe('engine coverage', () => {
  it('lists/kills on the engines with a per-database session notion only', () => {
    for (const s of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle']) expect(canKillDatabaseSessions(s)).toBe(true)
    for (const s of ['sqlite', 'clickhouse', 'mongodb', 'redis']) expect(canKillDatabaseSessions(s)).toBe(false)
  })

  it('explains the block in the engine terms', () => {
    expect(inUseExplanation('postgres', 'app', 2)).toContain('2 other sessions')
    expect(inUseExplanation('mysql', 'app', 1)).toContain('locked by 1 other session')
    expect(inUseExplanation('oracle', 'APP', 1)).toContain('logged in')
  })
})
