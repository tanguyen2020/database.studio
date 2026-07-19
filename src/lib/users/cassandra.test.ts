import { describe, expect, it } from 'vitest'
import {
  parseResource,
  resourceAccessStatement,
  alterRole,
  createRole,
  dropRole,
  grantPermission,
  grantRole,
  keyspacePreset,
  revokePermission,
  revokeRole,
  rid,
} from './cassandra'

describe('cassandra role builders', () => {
  it('rid quotes only when needed', () => {
    expect(rid('app_role')).toBe('app_role')
    expect(rid('Weird Role')).toBe('"Weird Role"')
  })

  it('createRole — password + login + superuser', () => {
    expect(createRole({ name: 'app', password: "p'w", login: true })).toBe(
      `CREATE ROLE app WITH PASSWORD = 'p''w' AND LOGIN = true AND SUPERUSER = false`,
    )
    expect(createRole({ name: 'grp', login: false })).toBe(`CREATE ROLE grp WITH LOGIN = false AND SUPERUSER = false`)
  })

  it('alterRole emits only changes + null when none', () => {
    expect(alterRole('app', { password: 'new' })).toBe(`ALTER ROLE app WITH PASSWORD = 'new'`)
    expect(alterRole('app', { login: false, superuser: true })).toBe(`ALTER ROLE app WITH LOGIN = false AND SUPERUSER = true`)
    expect(alterRole('app', {})).toBeNull()
  })

  it('drop + role membership', () => {
    expect(dropRole('app')).toBe(`DROP ROLE IF EXISTS app`)
    expect(dropRole('app', false)).toBe(`DROP ROLE app`)
    expect(grantRole('analysts', 'app')).toBe(`GRANT analysts TO app`)
    expect(revokeRole('analysts', 'app')).toBe(`REVOKE analysts FROM app`)
  })

  it('permissions across resources', () => {
    expect(grantPermission('SELECT', { kind: 'keyspace', keyspace: 'ks' }, 'app')).toBe(
      `GRANT SELECT ON KEYSPACE ks TO app`,
    )
    expect(grantPermission('MODIFY', { kind: 'table', keyspace: 'ks', table: 't' }, 'app')).toBe(
      `GRANT MODIFY ON TABLE ks.t TO app`,
    )
    expect(grantPermission('ALL PERMISSIONS', { kind: 'all-keyspaces' }, 'app')).toBe(
      `GRANT ALL PERMISSIONS ON ALL KEYSPACES TO app`,
    )
    expect(revokePermission('SELECT', { kind: 'keyspace', keyspace: 'ks' }, 'app')).toBe(
      `REVOKE SELECT ON KEYSPACE ks FROM app`,
    )
  })

  it('§1.8.2 full grid columns + per-column grant/revoke', async () => {
    const m = await import('./cassandra')
    expect(m.CASS_GRID_COLUMNS.map((c) => c.key)).toEqual(['SELECT', 'MODIFY', 'CREATE', 'ALTER', 'DROP', 'AUTHORIZE', 'DESCRIBE'])
    expect(m.grantColumn('ks', 'MODIFY', 'app')).toBe(`GRANT MODIFY ON KEYSPACE ks TO app`)
    expect(m.revokeColumn('ks', 'SELECT', 'app')).toBe(`REVOKE SELECT ON KEYSPACE ks FROM app`)
  })

  it('§1.8.2 keyspace presets (MODIFY = all writes)', () => {
    expect(keyspacePreset('read-only', 'ks', 'app')).toBe(`GRANT SELECT ON KEYSPACE ks TO app`)
    expect(keyspacePreset('read-write', 'ks', 'app')).toBe(`GRANT MODIFY ON KEYSPACE ks TO app`)
    expect(keyspacePreset('full', 'ks', 'app')).toBe(`GRANT ALL PERMISSIONS ON KEYSPACE ks TO app`)
    expect(keyspacePreset('revoke-all', 'ks', 'app')).toBe(`REVOKE ALL PERMISSIONS ON KEYSPACE ks FROM app`)
  })

  it('grant wizard — parseResource + resourceAccessStatement (Grant/Revoke, all/keyspace/table)', () => {
    expect(parseResource('*')).toEqual({ kind: 'all-keyspaces' })
    expect(parseResource('ks')).toEqual({ kind: 'keyspace', keyspace: 'ks' })
    expect(parseResource('ks.tbl')).toEqual({ kind: 'table', keyspace: 'ks', table: 'tbl' })
    expect(resourceAccessStatement('grant', 'read-only', 'ks', 'app')).toBe(`GRANT SELECT ON KEYSPACE ks TO app`)
    expect(resourceAccessStatement('grant', 'read-write', 'ks.tbl', 'app')).toBe(`GRANT MODIFY ON TABLE ks.tbl TO app`)
    expect(resourceAccessStatement('grant', 'full', '*', 'app')).toBe(`GRANT ALL PERMISSIONS ON ALL KEYSPACES TO app`)
    expect(resourceAccessStatement('revoke', 'read-only', 'ks.tbl', 'app')).toBe(`REVOKE SELECT ON TABLE ks.tbl FROM app`)
  })
})
