import { describe, expect, it } from 'vitest'
import { mapEnv, parseDbeaver, parseJdbcUrl, toConnectionsFile } from './dbeaver'

// Modeled on a real DBeaver data-sources.json (keys verified 2026-11-11):
// configuration.{host,port(string),database,url,configurationType,type,config-profile,handlers};
// SSH in network-profiles[config-profile].handlers.ssh_tunnel.properties.
const REAL = JSON.stringify({
  connections: {
    'pg-1': {
      provider: 'postgresql',
      driver: 'postgres-jdbc',
      name: 'Prod PG',
      'save-password': true,
      configuration: {
        host: 'db.example.com',
        port: '5433',
        database: 'shop',
        url: 'jdbc:postgresql://db.example.com:5433/shop',
        configurationType: 'MANUAL',
        type: 'prod',
        'config-profile': '76.6',
        'auth-model': 'native',
        handlers: { ssh_tunnel: { type: 'TUNNEL', enabled: true, 'save-password': false } },
      },
    },
    'ch-url': {
      provider: 'clickhouse',
      name: 'Analytics (URL)',
      configuration: {
        host: '',
        port: '',
        database: '',
        url: 'jdbc:clickhouse://ch.example.com:8123/metrics',
        configurationType: 'URL',
        type: 'dev',
      },
    },
    'ignore-me': {
      provider: 'snowflake',
      name: 'Warehouse',
      configuration: { host: 'x', port: '443' },
    },
  },
  'network-profiles': {
    '76.6': {
      name: 'office',
      handlers: {
        ssh_tunnel: {
          type: 'TUNNEL',
          enabled: true,
          properties: { host: 'bastion.example.com', port: '2222', authType: 'PUBLIC_KEY', keyPath: '/home/me/.ssh/id', userName: 'jump' },
        },
      },
    },
  },
})

describe('parseDbeaver', () => {
  it('reads manual connections, maps the engine, resolves SSH via the network profile', () => {
    const { profiles, skipped } = parseDbeaver(REAL)
    expect(profiles).toHaveLength(2)
    const pg = profiles.find((p) => p.name === 'Prod PG')!
    expect(pg.system).toBe('postgres')
    expect(pg.host).toBe('db.example.com')
    expect(pg.port).toBe(5433)
    expect(pg.database).toBe('shop')
    expect(pg.env).toBe('production')
    expect(pg.user).toBe('') // username is in the encrypted credentials file
    expect(pg.ssh).toEqual({ enabled: true, host: 'bastion.example.com', port: 2222, user: 'jump', auth: 'key', key_path: '/home/me/.ssh/id' })
    expect(skipped).toEqual([{ name: 'Warehouse', reason: 'unsupported engine (snowflake)' }])
  })

  it('fills host/port/database from the JDBC URL for URL-type connections', () => {
    const ch = parseDbeaver(REAL).profiles.find((p) => p.name === 'Analytics (URL)')!
    expect(ch.system).toBe('clickhouse')
    expect(ch.host).toBe('ch.example.com')
    expect(ch.port).toBe(8123)
    expect(ch.database).toBe('metrics')
  })

  it('defaults the port when neither the field nor the URL has one', () => {
    const doc = JSON.stringify({ connections: { a: { provider: 'mysql', name: 'M', configuration: { host: 'h' } } } })
    expect(parseDbeaver(doc).profiles[0].port).toBe(3306)
  })

  it('treats sqlite/duckdb as a file path, not host/port', () => {
    const doc = JSON.stringify({ connections: { s: { provider: 'sqlite', name: 'Local', configuration: { path: '/data/app.db' } } } })
    const p = parseDbeaver(doc).profiles[0]
    expect(p.system).toBe('sqlite')
    expect(p.sqlite_path).toBe('/data/app.db')
    expect(p.host).toBe('')
    expect(p.port).toBe(0)
  })

  it('reads an inline SSH tunnel (no network profile)', () => {
    const doc = JSON.stringify({
      connections: {
        a: {
          provider: 'mysql',
          name: 'M',
          configuration: {
            host: 'h',
            port: '3306',
            handlers: { ssh_tunnel: { enabled: true, properties: { host: 'gw', port: '22', authType: 'PASSWORD', userName: 'deploy' } } },
          },
        },
      },
    })
    expect(parseDbeaver(doc).profiles[0].ssh).toEqual({ enabled: true, host: 'gw', port: 22, user: 'deploy', auth: 'password', key_path: '' })
  })

  it('leaves SSH off when the tunnel is disabled or has no host', () => {
    const doc = JSON.stringify({ connections: { a: { provider: 'mysql', name: 'M', configuration: { host: 'h', port: '3306', handlers: { ssh_tunnel: { enabled: false } } } } } })
    expect(parseDbeaver(doc).profiles[0].ssh.enabled).toBe(false)
  })

  it('throws a friendly error on bad JSON and on a file with no connections', () => {
    expect(() => parseDbeaver('not json')).toThrow(/DBeaver/)
    expect(() => parseDbeaver('{"connections":{}}')).toThrow(/No connections/)
  })
})

describe('parseJdbcUrl', () => {
  it('parses postgres, sqlserver, oracle and generic forms', () => {
    expect(parseJdbcUrl('jdbc:postgresql://h:5432/db')).toEqual({ host: 'h', port: 5432, database: 'db' })
    expect(parseJdbcUrl('jdbc:sqlserver://h:1433;databaseName=sales;encrypt=true')).toEqual({ host: 'h', port: 1433, database: 'sales' })
    expect(parseJdbcUrl('jdbc:oracle:thin:@//h:1521/XEPDB1')).toEqual({ host: 'h', port: 1521, database: 'XEPDB1' })
    expect(parseJdbcUrl('jdbc:mysql://h:3306/app?useSSL=true')).toEqual({ host: 'h', port: 3306, database: 'app' })
  })
})

describe('mapEnv', () => {
  it('maps DBeaver connection types', () => {
    expect(mapEnv('prod')).toBe('production')
    expect(mapEnv('qa')).toBe('staging')
    expect(mapEnv('test')).toBe('staging')
    expect(mapEnv('dev')).toBe('development')
    expect(mapEnv('local')).toBe('local')
    expect(mapEnv(undefined)).toBe('development')
  })
})

describe('toConnectionsFile', () => {
  it('wraps profiles into an unsealed Database Studio v2 file', () => {
    const { profiles } = parseDbeaver(REAL)
    const file = JSON.parse(toConnectionsFile(profiles, new Date('2026-01-02T03:04:05Z')))
    expect(file.format).toBe('database-studio-connections')
    expect(file.version).toBe(2)
    expect(file.count).toBe(2)
    expect(file.profiles).toHaveLength(2)
    expect(file.encrypted).toBeUndefined() // no secrets
  })
})
