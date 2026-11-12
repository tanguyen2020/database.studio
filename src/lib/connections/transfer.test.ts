import { describe, expect, it } from 'vitest'
import {
  exportFileName,
  filePasswordProblem,
  planImport,
  renameAdded,
  targetKey,
  targetLabel,
  uniqueName,
  type ImportFileItem,
} from './transfer'
import type { ConnectionProfile } from '$lib/types'

function prof(over: Partial<ConnectionProfile>): ConnectionProfile {
  return {
    id: '',
    name: 'X',
    system: 'postgres',
    host: '10.0.0.1',
    port: 5432,
    database: 'app',
    user: 'app',
    group: '',
    env: 'development',
    ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', password_enc: '', key_path: '' },
    ssl: false,
    ssl_ca: '',
    ssl_cert: '',
    ssl_key: '',
    sqlite_path: '',
    sqlite_mode: 'read-write',
    mssql_auth: '',
    schema_registry_url: '',
    cassandra_dc: '',
    cassandra_consistency: '',
    ...over,
  } as ConnectionProfile
}

const item = (over: Partial<ConnectionProfile>, has_password = true): ImportFileItem => ({
  profile: prof(over),
  has_password,
  has_ssh_password: false,
  missing_files: [],
})

describe('targetKey', () => {
  it('same server, database and user = same connection, whatever the name or host case', () => {
    expect(targetKey(prof({ name: 'A', host: 'DB.acme.io' }))).toBe(targetKey(prof({ name: 'B', host: 'db.acme.io ' })))
    expect(targetKey(prof({ user: 'ro' }))).not.toBe(targetKey(prof({ user: 'rw' })))
    expect(targetKey(prof({ port: 5433 }))).not.toBe(targetKey(prof({})))
    expect(targetKey(prof({ system: 'mysql' }))).not.toBe(targetKey(prof({})))
  })
  it('embedded databases match on the file path', () => {
    const a = prof({ system: 'sqlite', host: '', sqlite_path: 'C:\\Data\\App.db' })
    const b = prof({ system: 'sqlite', host: 'x', sqlite_path: 'c:/data/app.db' })
    expect(targetKey(a)).toBe(targetKey(b))
  })
})

describe('uniqueName', () => {
  it('keeps a free name and numbers a taken one', () => {
    expect(uniqueName('Prod', ['Staging'])).toBe('Prod')
    expect(uniqueName('Prod', ['prod'])).toBe('Prod (2)')
    expect(uniqueName('Prod', ['Prod', 'Prod (2)'])).toBe('Prod (3)')
    expect(uniqueName('Prod (2)', ['Prod (2)'])).toBe('Prod (3)')
    expect(uniqueName('  ', [])).toBe('Connection')
  })
})

describe('planImport', () => {
  const existing = [
    { ...prof({ id: 'e1', name: 'Prod', host: 'prod-db' }), has_password: true },
    { ...prof({ id: 'e2', name: 'Reporting', host: 'rep-db' }), has_password: false },
  ]

  it('skips what is already here, replaces when only the file has the password, adds the rest', () => {
    const rows = planImport(
      [
        item({ name: 'Prod', host: 'prod-db' }),
        item({ name: 'Reporting copy', host: 'rep-db' }),
        item({ name: 'Staging', host: 'stg-db' }),
      ],
      existing,
    )
    expect(rows.map((r) => r.action)).toEqual(['skip', 'replace', 'add'])
    expect(rows[0].match).toEqual({ id: 'e1', name: 'Prod' })
    expect(rows[1].match).toEqual({ id: 'e2', name: 'Reporting' })
    expect(rows[2].match).toBeNull()
  })

  it('a different server under a taken name is added under a new name', () => {
    const rows = planImport([item({ name: 'Prod', host: 'other' }), item({ name: 'Prod', host: 'third' })], existing)
    expect(rows.map((r) => [r.action, r.name])).toEqual([
      ['add', 'Prod (2)'],
      ['add', 'Prod (3)'],
    ])
  })

  it('renameAdded renumbers after an action changes', () => {
    let rows = planImport([item({ name: 'Prod', host: 'prod-db' }), item({ name: 'Prod', host: 'other' })], existing)
    expect(rows[1].name).toBe('Prod (2)')
    rows = renameAdded(
      rows.map((r) => (r.index === 0 ? { ...r, action: 'add' as const } : r)),
      existing.map((e) => e.name),
    )
    expect(rows.map((r) => r.name)).toEqual(['Prod (2)', 'Prod (3)'])
  })
})

describe('filePasswordProblem', () => {
  it('needs 8+ characters typed twice the same', () => {
    expect(filePasswordProblem('', '')).toMatch(/Choose/)
    expect(filePasswordProblem('short', 'short')).toMatch(/at least 8/)
    expect(filePasswordProblem('longenough', 'longenougX')).toMatch(/do not match/)
    expect(filePasswordProblem('longenough', 'longenough')).toBeNull()
    // characters, not bytes
    expect(filePasswordProblem('mậtkhẩuaa', 'mậtkhẩuaa')).toBeNull()
  })
})

describe('labels', () => {
  it('exportFileName carries the date', () => {
    expect(exportFileName(new Date(2026, 10, 7))).toBe('database-studio-connections-2026-11-07.json')
  })
  it('targetLabel says where it connects', () => {
    expect(targetLabel(prof({}))).toBe('app @ 10.0.0.1:5432 / app')
    expect(targetLabel(prof({ system: 'duckdb', sqlite_path: '' }))).toBe('In-memory')
  })
})
