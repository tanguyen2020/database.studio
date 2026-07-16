import { describe, expect, it } from 'vitest'
import {
  alterPassword,
  createRole,
  createUser,
  defaultRoleAll,
  dropUser,
  grantObjPrivs,
  grantRole,
  grantSysPrivs,
  lockAccount,
  oid,
  revokeObjPrivs,
  schemaPreset,
  setQuota,
} from './oracle'

describe('oracle user builders', () => {
  it('oid folds simple names to uppercase, quotes special', () => {
    expect(oid('hr')).toBe('HR')
    expect(oid('App_User')).toBe('APP_USER')
    expect(oid('weird name')).toBe('"weird name"')
    expect(() => oid('a"b')).toThrow()
  })

  it('createUser — 1..2 statements, password double-quoted, CREATE SESSION', () => {
    expect(createUser({ name: 'app', password: 'pw' })).toEqual([`CREATE USER APP IDENTIFIED BY "pw"`])
    expect(createUser({ name: 'app', password: 'pw', grantCreateSession: true })).toEqual([
      `CREATE USER APP IDENTIFIED BY "pw"`,
      `GRANT CREATE SESSION TO APP`,
    ])
    expect(
      createUser({ name: 'app', password: 'pw', defaultTablespace: 'users', quota: { unlimited: true, tablespace: 'users' }, profile: 'default' }),
    ).toEqual([`CREATE USER APP IDENTIFIED BY "pw" DEFAULT TABLESPACE USERS QUOTA UNLIMITED ON USERS PROFILE DEFAULT`])
    expect(() => createUser({ name: 'app', password: 'a"b' })).toThrow()
  })

  it('alter password / lock / quota / drop', () => {
    expect(alterPassword('app', 'new')).toBe(`ALTER USER APP IDENTIFIED BY "new"`)
    expect(lockAccount('app', true)).toBe(`ALTER USER APP ACCOUNT LOCK`)
    expect(setQuota('app', 'users', false, 100)).toBe(`ALTER USER APP QUOTA 100M ON USERS`)
    expect(setQuota('app', 'users', true)).toBe(`ALTER USER APP QUOTA UNLIMITED ON USERS`)
    expect(dropUser('app', true)).toBe(`DROP USER APP CASCADE`)
  })

  it('roles + system privs (ADMIN OPTION) + object privs (GRANT OPTION)', () => {
    expect(createRole('app_read')).toBe(`CREATE ROLE APP_READ`)
    expect(grantSysPrivs(['CREATE SESSION', 'CREATE TABLE'], 'app', true)).toBe(
      `GRANT CREATE SESSION, CREATE TABLE TO APP WITH ADMIN OPTION`,
    )
    expect(grantRole('app_read', 'app')).toBe(`GRANT APP_READ TO APP`)
    expect(defaultRoleAll('app')).toBe(`ALTER USER APP DEFAULT ROLE ALL`)
    expect(grantObjPrivs(['SELECT', 'UPDATE'], 'hr', 'emp', 'app', { cols: ['sal'], grantOption: true })).toBe(
      `GRANT SELECT, UPDATE (SAL) ON HR.EMP TO APP WITH GRANT OPTION`,
    )
    expect(revokeObjPrivs('ALL', 'hr', 'emp', 'app')).toBe(`REVOKE ALL ON HR.EMP FROM APP`)
  })

  it('§1.8.4 presets = per-object batches', () => {
    expect(schemaPreset('read-only', 'hr', 'app', ['emp', 'dept'])).toEqual([
      `GRANT SELECT ON HR.EMP TO APP`,
      `GRANT SELECT ON HR.DEPT TO APP`,
    ])
    expect(schemaPreset('read-write', 'hr', 'app', ['emp'])).toEqual([
      `GRANT SELECT, INSERT, UPDATE, DELETE ON HR.EMP TO APP`,
    ])
    expect(schemaPreset('read-write-execute', 'hr', 'app', ['emp'], ['calc'])).toEqual([
      `GRANT SELECT, INSERT, UPDATE, DELETE ON HR.EMP TO APP`,
      `GRANT EXECUTE ON HR.CALC TO APP`,
    ])
    expect(schemaPreset('revoke-all', 'hr', 'app', ['emp'], ['calc'])).toEqual([
      `REVOKE ALL ON HR.EMP FROM APP`,
      `REVOKE EXECUTE ON HR.CALC FROM APP`,
    ])
  })
})
