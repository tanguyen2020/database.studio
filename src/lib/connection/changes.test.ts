import { describe, expect, it } from 'vitest'
import { connectionChanged } from './changes'

const base = {
  id: 'c1',
  name: 'Prod',
  group: '',
  env: 'production',
  system: 'postgres',
  host: 'db1',
  port: 5432,
  database: 'app',
  user: 'u',
  ssl: false,
  ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', key_path: '' },
  cassandra_dc: '',
} as never

describe('connectionChanged', () => {
  it('ignores labels: name / group / environment', () => {
    expect(connectionChanged(base, { ...(base as object), name: 'Prod 2', group: 'x', env: 'development' })).toBe(false)
  })

  it('a different database, host, port or user is a change', () => {
    for (const patch of [{ database: 'billing' }, { host: 'db2' }, { port: 6432 }, { user: 'v' }]) {
      expect(connectionChanged(base, { ...(base as object), ...patch })).toBe(true)
    }
  })

  it('SSH and engine-specific fields count too (not only a fixed list)', () => {
    expect(
      connectionChanged(base, { ...(base as object), ssh: { ...(base as { ssh: object }).ssh, enabled: true } } as never),
    ).toBe(true)
    expect(connectionChanged(base, { ...(base as object), cassandra_dc: 'dc2' })).toBe(true)
    expect(connectionChanged(base, { ...(base as object), some_new_field: 'x' } as never)).toBe(true)
  })

  it('live state from the backend is not config', () => {
    expect(connectionChanged({ ...(base as object), connected: true, latency_ms: 4 } as never, base)).toBe(false)
  })

  it('a key only one side has, at its empty default, is not a change', () => {
    expect(connectionChanged(base, { ...(base as object), schema_registry_url: '' } as never)).toBe(false)
  })

  it('typing a password always counts; no previous profile never does', () => {
    expect(connectionChanged(base, base, { password: 'new' })).toBe(true)
    expect(connectionChanged(base, base, { sshPassword: 'x' })).toBe(true)
    expect(connectionChanged(base, base, { password: null })).toBe(false)
    expect(connectionChanged(undefined, base)).toBe(false)
  })
})

describe('cassandra_flavor is a label, not a connection setting', () => {
  it('learning that the server is ScyllaDB does not ask to reconnect', () => {
    const before = { system: 'cassandra' as const, host: 'h', port: 9042, cassandra_flavor: '' }
    expect(connectionChanged(before, { ...before, cassandra_flavor: 'scylla' })).toBe(false)
    expect(connectionChanged(before, { ...before, port: 19042 })).toBe(true)
  })
})
