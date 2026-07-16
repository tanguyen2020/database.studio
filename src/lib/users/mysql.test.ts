import { describe, expect, it } from 'vitest'
import {
  acct,
  alterPassword,
  createRole,
  createUser,
  dbPreset,
  dropUser,
  grant,
  grantColumns,
  grantRole,
  lockAccount,
  renameUser,
  revoke,
  revokeAll,
  setDefaultRole,
} from './mysql'

describe('mysql/mariadb user builders', () => {
  it('account literal escapes quotes and backslashes', () => {
    expect(acct('app', '%')).toBe(`'app'@'%'`)
    expect(acct("u'x", '10.0.0.%')).toBe(`'u''x'@'10.0.0.%'`)
    expect(acct('a\\b', 'localhost')).toBe(`'a\\\\b'@'localhost'`)
  })

  it('createUser — plugin/password/lock/expire', () => {
    expect(createUser('mysql', { user: 'app', host: '%', password: 'pw' })).toBe(
      `CREATE USER 'app'@'%' IDENTIFIED BY 'pw'`,
    )
    expect(createUser('mysql', { user: 'app', host: '%', password: 'pw', plugin: 'caching_sha2_password' })).toBe(
      `CREATE USER 'app'@'%' IDENTIFIED WITH caching_sha2_password BY 'pw'`,
    )
    expect(createUser('mysql', { user: 'app', host: 'localhost', password: 'pw', accountLocked: true, passwordExpire: 90 })).toBe(
      `CREATE USER 'app'@'localhost' IDENTIFIED BY 'pw' PASSWORD EXPIRE INTERVAL 90 DAY ACCOUNT LOCK`,
    )
    // mariadb unix_socket → no password
    expect(createUser('mariadb', { user: 'svc', host: 'localhost', plugin: 'unix_socket' })).toBe(
      `CREATE USER 'svc'@'localhost' IDENTIFIED VIA unix_socket`,
    )
    // mariadb ignores WITH <plugin> (uses IDENTIFIED BY)
    expect(createUser('mariadb', { user: 'a', host: '%', password: 'pw', plugin: 'ed25519' })).toBe(
      `CREATE USER 'a'@'%' IDENTIFIED BY 'pw'`,
    )
  })

  it('alter password / lock / rename / drop', () => {
    expect(alterPassword('app', '%', 'new')).toBe(`ALTER USER 'app'@'%' IDENTIFIED BY 'new'`)
    expect(lockAccount('app', '%', true)).toBe(`ALTER USER 'app'@'%' ACCOUNT LOCK`)
    expect(lockAccount('app', '%', false)).toBe(`ALTER USER 'app'@'%' ACCOUNT UNLOCK`)
    expect(renameUser('a', 'h1', 'b', 'h2')).toBe(`RENAME USER 'a'@'h1' TO 'b'@'h2'`)
    expect(dropUser('app', '%')).toBe(`DROP USER 'app'@'%'`)
  })

  it('grant at each level + column-level + revoke', () => {
    expect(grant(['SELECT', 'INSERT'], { kind: 'global' }, 'app', '%')).toBe(
      `GRANT SELECT, INSERT ON *.* TO 'app'@'%'`,
    )
    expect(grant(['SELECT'], { kind: 'schema', db: 'appdb' }, 'app', '%', true)).toBe(
      "GRANT SELECT ON `appdb`.* TO 'app'@'%' WITH GRANT OPTION",
    )
    expect(grant('ALL', { kind: 'table', db: 'appdb', table: 't' }, 'app', '%')).toBe(
      "GRANT ALL PRIVILEGES ON `appdb`.`t` TO 'app'@'%'",
    )
    expect(grantColumns([{ priv: 'SELECT', cols: ['a', 'b'] }, { priv: 'UPDATE', cols: ['a'] }], 'db', 't', 'app', '%')).toBe(
      "GRANT SELECT (`a`, `b`), UPDATE (`a`) ON `db`.`t` TO 'app'@'%'",
    )
    expect(revoke('ALL', { kind: 'schema', db: 'db' }, 'app', '%')).toBe(
      "REVOKE ALL PRIVILEGES ON `db`.* FROM 'app'@'%'",
    )
    expect(revokeAll('app', '%')).toBe(`REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'app'@'%'`)
  })

  it('§1.8.2 db presets = one statement each', () => {
    expect(dbPreset('read-only', 'appdb', 'app', '%')).toBe("GRANT SELECT ON `appdb`.* TO 'app'@'%'")
    expect(dbPreset('read-write', 'appdb', 'app', '%')).toBe(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `appdb`.* TO 'app'@'%'",
    )
    expect(dbPreset('read-write-execute', 'appdb', 'app', '%')).toBe(
      "GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON `appdb`.* TO 'app'@'%'",
    )
    expect(dbPreset('full', 'appdb', 'app', '%')).toBe("GRANT ALL PRIVILEGES ON `appdb`.* TO 'app'@'%'")
    expect(dbPreset('revoke-all', 'appdb', 'app', '%')).toBe("REVOKE ALL PRIVILEGES ON `appdb`.* FROM 'app'@'%'")
    // global scope
    expect(dbPreset('read-only', null, 'app', '%')).toBe("GRANT SELECT ON *.* TO 'app'@'%'")
  })

  it('roles + default role (MySQL TO vs MariaDB FOR)', () => {
    expect(createRole('mysql', 'reader')).toBe(`CREATE ROLE 'reader'`)
    expect(grantRole('reader', 'app', '%', true)).toBe(`GRANT 'reader' TO 'app'@'%' WITH ADMIN OPTION`)
    expect(setDefaultRole('mysql', 'ALL', 'app', '%')).toBe(`SET DEFAULT ROLE ALL TO 'app'@'%'`)
    expect(setDefaultRole('mysql', 'reader', 'app', '%')).toBe(`SET DEFAULT ROLE 'reader' TO 'app'@'%'`)
    // MariaDB uses FOR and has no ALL form (falls back to NONE)
    expect(setDefaultRole('mariadb', 'reader', 'app', '%')).toBe(`SET DEFAULT ROLE 'reader' FOR 'app'@'%'`)
    expect(setDefaultRole('mariadb', 'ALL', 'app', '%')).toBe(`SET DEFAULT ROLE NONE FOR 'app'@'%'`)
  })
})
