import { describe, expect, it } from 'vitest'
import {
  alterUserPassword,
  createRole,
  createUser,
  dbPreset,
  dropUser,
  grant,
  grantRole,
  renameUser,
  revoke,
  setDefaultRole,
} from './clickhouse'

describe('clickhouse user builders', () => {
  it('createUser — auth / host / default role / db', () => {
    expect(createUser({ name: 'app', password: 'pw' })).toBe(
      `CREATE USER \`app\` IDENTIFIED WITH sha256_password BY 'pw'`,
    )
    expect(createUser({ name: 'app', auth: 'no_password' })).toBe(`CREATE USER \`app\` IDENTIFIED WITH no_password`)
    expect(
      createUser({ name: 'app', password: 'pw', host: { kind: 'ip', value: '10.0.0.1' }, defaultRoles: ['reader'], defaultDatabase: 'analytics' }),
    ).toBe(`CREATE USER \`app\` IDENTIFIED WITH sha256_password BY 'pw' HOST IP '10.0.0.1' DEFAULT ROLE \`reader\` DEFAULT DATABASE \`analytics\``)
    // escaping of quote in password + backtick in name
    expect(createUser({ name: 'a`b', password: "p'w" })).toBe(
      "CREATE USER `a\\`b` IDENTIFIED WITH sha256_password BY 'p\\'w'",
    )
  })

  it('alter password / rename / drop', () => {
    expect(alterUserPassword('app', 'sha256_password', 'new')).toBe(
      `ALTER USER \`app\` IDENTIFIED WITH sha256_password BY 'new'`,
    )
    expect(renameUser('a', 'b')).toBe(`ALTER USER \`a\` RENAME TO \`b\``)
    expect(dropUser('app')).toBe(`DROP USER \`app\``)
  })

  it('roles + grant role + default role', () => {
    expect(createRole('reader')).toBe(`CREATE ROLE \`reader\``)
    expect(grantRole('reader', 'app', true)).toBe(`GRANT \`reader\` TO \`app\` WITH ADMIN OPTION`)
    expect(setDefaultRole('ALL', 'app')).toBe(`SET DEFAULT ROLE ALL TO \`app\``)
    expect(setDefaultRole('reader', 'app')).toBe(`SET DEFAULT ROLE \`reader\` TO \`app\``)
  })

  it('grant / revoke by scope', () => {
    expect(grant(['SELECT'], { kind: 'db', db: 'analytics' }, 'app')).toBe(
      `GRANT SELECT ON \`analytics\`.* TO \`app\``,
    )
    expect(grant('ALL', { kind: 'table', db: 'a', table: 't' }, 'app', true)).toBe(
      `GRANT ALL ON \`a\`.\`t\` TO \`app\` WITH GRANT OPTION`,
    )
    expect(revoke('ALL', { kind: 'global' }, 'app')).toBe(`REVOKE ALL ON *.* FROM \`app\``)
  })

  it('§1.8.2 full grid columns + per-column grant/revoke', async () => {
    const m = await import('./clickhouse')
    expect(m.CH_GRID_COLUMNS.map((c) => c.key)).toContain('ALTER UPDATE')
    expect(m.grantColumn('analytics', 'SELECT', 'app')).toBe(`GRANT SELECT ON \`analytics\`.* TO \`app\``)
    expect(m.grantColumn('analytics', 'ALTER UPDATE', 'app')).toBe(`GRANT ALTER UPDATE ON \`analytics\`.* TO \`app\``)
    expect(m.revokeColumn('analytics', 'INSERT', 'app')).toBe(`REVOKE INSERT ON \`analytics\`.* FROM \`app\``)
  })

  it('§1.8.2 presets (UPDATE/DELETE are ALTER mutations)', () => {
    expect(dbPreset('read-only', 'analytics', 'app')).toBe(`GRANT SELECT ON \`analytics\`.* TO \`app\``)
    expect(dbPreset('read-write', 'analytics', 'app')).toBe(
      `GRANT SELECT, INSERT, ALTER UPDATE, ALTER DELETE ON \`analytics\`.* TO \`app\``,
    )
    expect(dbPreset('full', 'analytics', 'app')).toBe(`GRANT ALL ON \`analytics\`.* TO \`app\``)
    expect(dbPreset('revoke-all', 'analytics', 'app')).toBe(`REVOKE ALL ON \`analytics\`.* FROM \`app\``)
  })
})
