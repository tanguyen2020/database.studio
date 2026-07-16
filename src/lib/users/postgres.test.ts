import { describe, expect, it } from 'vitest'
import {
  alterPassword,
  alterRoleOptions,
  createRole,
  dropRole,
  dropRoleOwned,
  grantConnect,
  grantMembership,
  grantOnTable,
  presetReadOnly,
  presetReadWrite,
  presetReadWriteExecute,
  presetRevokeAll,
  presetFull,
  renameRole,
  revokeMembership,
  schemaPreset,
} from './postgres'

describe('postgres user builders', () => {
  it('createRole emits only set options, quotes name + password', () => {
    expect(createRole('app_user', { login: true, password: "p'wd" })).toBe(
      `CREATE ROLE "app_user" LOGIN PASSWORD 'p''wd'`,
    )
    // group role (no login) with membership
    expect(createRole('readers', { login: false, inRole: ['base'] })).toBe(
      `CREATE ROLE "readers" NOLOGIN IN ROLE "base"`,
    )
    // no options → bare
    expect(createRole('plain', {})).toBe(`CREATE ROLE "plain"`)
    // full flag set
    expect(createRole('adm', { login: true, superuser: true, createdb: true, createrole: true, connectionLimit: 5 })).toBe(
      `CREATE ROLE "adm" LOGIN SUPERUSER CREATEDB CREATEROLE CONNECTION LIMIT 5`,
    )
  })

  it('createRole quotes weird names', () => {
    expect(createRole('we"ird', { login: true })).toBe(`CREATE ROLE "we""ird" LOGIN`)
  })

  it('alterRoleOptions emits negations + null when no change', () => {
    expect(alterRoleOptions('r', { login: false, superuser: true })).toBe(`ALTER ROLE "r" NOLOGIN SUPERUSER`)
    expect(alterRoleOptions('r', { createdb: false })).toBe(`ALTER ROLE "r" NOCREATEDB`)
    expect(alterRoleOptions('r', {})).toBeNull()
  })

  it('password / valid until / rename / drop', () => {
    expect(alterPassword('r', 'secret')).toBe(`ALTER ROLE "r" PASSWORD 'secret'`)
    expect(renameRole('a', 'b')).toBe(`ALTER ROLE "a" RENAME TO "b"`)
    expect(dropRole('r')).toBe(`DROP ROLE "r"`)
    expect(dropRoleOwned('r', 'postgres')).toEqual([
      `REASSIGN OWNED BY "r" TO "postgres"`,
      `DROP OWNED BY "r"`,
      `DROP ROLE "r"`,
    ])
  })

  it('membership + grant on table', () => {
    expect(grantMembership('readers', 'app', true)).toBe(`GRANT "readers" TO "app" WITH ADMIN OPTION`)
    expect(revokeMembership('readers', 'app')).toBe(`REVOKE "readers" FROM "app"`)
    expect(grantOnTable('public', 't', ['SELECT', 'INSERT'], 'app')).toBe(
      `GRANT SELECT, INSERT ON TABLE "public"."t" TO "app"`,
    )
    expect(grantOnTable('public', 't', 'ALL', 'app', true)).toBe(
      `GRANT ALL PRIVILEGES ON TABLE "public"."t" TO "app" WITH GRANT OPTION`,
    )
  })

  it('preset read-only = exact statements', () => {
    expect(presetReadOnly('public', 'app')).toEqual([
      `GRANT USAGE ON SCHEMA "public" TO "app"`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "app"`,
      `GRANT SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "app"`,
    ])
  })

  it('preset read-only + future tables adds default privileges for owner', () => {
    expect(presetReadOnly('public', 'app', { futureTables: true, owner: 'postgres' })).toEqual([
      `GRANT USAGE ON SCHEMA "public" TO "app"`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "app"`,
      `GRANT SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "app"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT ON TABLES TO "app"`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT USAGE, SELECT ON SEQUENCES TO "app"`,
    ])
  })

  it('preset read-write includes read + write statements', () => {
    expect(presetReadWrite('public', 'app')).toEqual([
      `GRANT USAGE ON SCHEMA "public" TO "app"`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "app"`,
      `GRANT SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "app"`,
      `GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "app"`,
      `GRANT USAGE ON ALL SEQUENCES IN SCHEMA "public" TO "app"`,
    ])
  })

  it('preset read-write + execute appends EXECUTE on all functions', () => {
    const out = presetReadWriteExecute('public', 'app')
    expect(out.at(-1)).toBe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "public" TO "app"`)
  })

  it('preset full grants CREATE + ALL', () => {
    expect(presetFull('public', 'app')).toEqual([
      `GRANT USAGE, CREATE ON SCHEMA "public" TO "app"`,
      `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" TO "app"`,
      `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "public" TO "app"`,
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "public" TO "app"`,
    ])
  })

  it('preset revoke-all also revokes default privileges per owner', () => {
    const out = presetRevokeAll('public', 'app', ['postgres'])
    expect(out).toContain(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM "app"`)
    expect(out).toContain(`REVOKE USAGE, CREATE ON SCHEMA "public" FROM "app"`)
    expect(out).toContain(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "app"`,
    )
  })

  it('grantConnect + schemaPreset dispatch', () => {
    expect(grantConnect('appdb', 'app')).toBe(`GRANT CONNECT ON DATABASE "appdb" TO "app"`)
    expect(schemaPreset('read-only', 'public', 'app')).toEqual(presetReadOnly('public', 'app'))
    expect(schemaPreset('full', 'public', 'app')).toEqual(presetFull('public', 'app'))
    expect(schemaPreset('revoke-all', 'public', 'app', { owners: ['postgres'] })).toEqual(
      presetRevokeAll('public', 'app', ['postgres']),
    )
  })
})
