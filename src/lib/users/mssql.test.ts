import { describe, expect, it } from 'vitest'
import {
  accessStatement,
  alterLoginPassword,
  createDbRole,
  createLogin,
  createUser,
  createWindowsLogin,
  dropLogin,
  dropUser,
  parseSecurable,
  permission,
  schemaPreset,
  setDbRoleMember,
  setLoginEnabled,
  setServerRoleMember,
} from './mssql'

describe('mssql user builders', () => {
  it('createLogin — password + policy + default db', () => {
    expect(createLogin({ name: 'app', password: "p'wd" })).toBe(`CREATE LOGIN [app] WITH PASSWORD = N'p''wd'`)
    expect(createLogin({ name: 'app', password: 'x', checkPolicy: false, defaultDatabase: 'AppDb' })).toBe(
      `CREATE LOGIN [app] WITH PASSWORD = N'x', CHECK_POLICY = OFF, DEFAULT_DATABASE = [AppDb]`,
    )
    expect(createWindowsLogin('DOMAIN\\svc')).toBe(`CREATE LOGIN [DOMAIN\\svc] FROM WINDOWS`)
    expect(alterLoginPassword('app', 'new')).toBe(`ALTER LOGIN [app] WITH PASSWORD = N'new'`)
    expect(setLoginEnabled('app', false)).toBe(`ALTER LOGIN [app] DISABLE`)
    expect(dropLogin('app')).toBe(`DROP LOGIN [app]`)
  })

  it('createUser — for login / without login / default schema', () => {
    expect(createUser('app', 'app_login')).toBe(`CREATE USER [app] FOR LOGIN [app_login]`)
    expect(createUser('app', 'app_login', 'dbo')).toBe(`CREATE USER [app] FOR LOGIN [app_login] WITH DEFAULT_SCHEMA = [dbo]`)
    expect(createUser('contained', null)).toBe(`CREATE USER [contained] WITHOUT LOGIN`)
    expect(dropUser('app')).toBe(`DROP USER [app]`)
  })

  it('roles — create + membership (db + server)', () => {
    expect(createDbRole('audit')).toBe(`CREATE ROLE [audit]`)
    expect(createDbRole('audit', 'dbo')).toBe(`CREATE ROLE [audit] AUTHORIZATION [dbo]`)
    expect(setDbRoleMember('db_datareader', 'app', true)).toBe(`ALTER ROLE [db_datareader] ADD MEMBER [app]`)
    expect(setDbRoleMember('audit', 'app', false)).toBe(`ALTER ROLE [audit] DROP MEMBER [app]`)
    expect(setServerRoleMember('sysadmin', 'app_login', true)).toBe(`ALTER SERVER ROLE [sysadmin] ADD MEMBER [app_login]`)
  })

  it('permission — GRANT / DENY / REVOKE across securables', () => {
    expect(permission('GRANT', ['SELECT'], { kind: 'schema', schema: 'dbo' }, 'app')).toBe(
      `GRANT SELECT ON SCHEMA::[dbo] TO [app]`,
    )
    expect(permission('GRANT', ['SELECT', 'INSERT'], { kind: 'object', schema: 'dbo', object: 't' }, 'app', true)).toBe(
      `GRANT SELECT, INSERT ON [dbo].[t] TO [app] WITH GRANT OPTION`,
    )
    // column-level
    expect(permission('GRANT', ['SELECT'], { kind: 'object', schema: 'dbo', object: 't', cols: ['a', 'b'] }, 'app')).toBe(
      `GRANT SELECT ON [dbo].[t] ([a], [b]) TO [app]`,
    )
    // DENY wins over grant
    expect(permission('DENY', ['SELECT'], { kind: 'object', schema: 'dbo', object: 'secret' }, 'app')).toBe(
      `DENY SELECT ON [dbo].[secret] TO [app]`,
    )
    // REVOKE uses FROM
    expect(permission('REVOKE', ['SELECT'], { kind: 'schema', schema: 'dbo' }, 'app')).toBe(
      `REVOKE SELECT ON SCHEMA::[dbo] FROM [app]`,
    )
    // database-level
    expect(permission('GRANT', ['CREATE TABLE'], { kind: 'database', db: 'AppDb' }, 'app')).toBe(
      `GRANT CREATE TABLE ON DATABASE::[AppDb] TO [app]`,
    )
  })

  it('§1.8.4 full grid columns + per-column GRANT/DENY/REVOKE', async () => {
    const m = await import('./mssql')
    expect(m.MSSQL_GRID_COLUMNS.map((c) => c.key)).toContain('VIEW DEFINITION')
    expect(m.grantColumn('dbo', 'SELECT', 'app')).toBe(`GRANT SELECT ON SCHEMA::[dbo] TO [app]`)
    expect(m.denyColumn('dbo', 'DELETE', 'app')).toBe(`DENY DELETE ON SCHEMA::[dbo] TO [app]`)
    expect(m.revokeColumn('dbo', 'SELECT', 'app')).toBe(`REVOKE SELECT ON SCHEMA::[dbo] FROM [app]`)
  })

  it('§1.8.4 schema presets', () => {
    expect(schemaPreset('read-only', 'dbo', 'app')).toBe(`GRANT SELECT ON SCHEMA::[dbo] TO [app]`)
    expect(schemaPreset('read-write', 'dbo', 'app')).toBe(`GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[dbo] TO [app]`)
    expect(schemaPreset('read-write-execute', 'dbo', 'app')).toBe(
      `GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::[dbo] TO [app]`,
    )
    expect(schemaPreset('full', 'dbo', 'app')).toBe(`GRANT CONTROL ON SCHEMA::[dbo] TO [app]`)
    expect(schemaPreset('revoke-all', 'dbo', 'app')).toBe(
      `REVOKE SELECT, INSERT, UPDATE, DELETE, EXECUTE, ALTER, REFERENCES, VIEW DEFINITION, CONTROL ON SCHEMA::[dbo] FROM [app]`,
    )
  })

  it('grant wizard — parseSecurable + accessStatement (Grant/Deny/Revoke × level, schema/object)', () => {
    // scope string → securable
    expect(parseSecurable('dbo.*')).toEqual({ kind: 'schema', schema: 'dbo' })
    expect(parseSecurable('dbo')).toEqual({ kind: 'schema', schema: 'dbo' })
    expect(parseSecurable('dbo.Orders')).toEqual({ kind: 'object', schema: 'dbo', object: 'Orders' })
    // Grant on a whole schema
    expect(accessStatement('grant', 'read-only', parseSecurable('dbo.*'), 'app')).toBe(
      `GRANT SELECT ON SCHEMA::[dbo] TO [app]`,
    )
    // Deny on a specific object (DENY wins)
    expect(accessStatement('deny', 'read-only', parseSecurable('dbo.Orders'), 'app')).toBe(
      `DENY SELECT ON [dbo].[Orders] TO [app]`,
    )
    // Revoke a read-write set on a schema (uses FROM)
    expect(accessStatement('revoke', 'read-write', parseSecurable('sales.*'), 'app')).toBe(
      `REVOKE SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[sales] FROM [app]`,
    )
    // Full = CONTROL
    expect(accessStatement('grant', 'full', parseSecurable('dbo.*'), 'app')).toBe(`GRANT CONTROL ON SCHEMA::[dbo] TO [app]`)
  })
})
