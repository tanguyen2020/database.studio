// Read DBeaver's workspace file (.dbeaver/data-sources.json) into Database Studio
// connection profiles — metadata only. Verified against a real DBeaver workspace
// (2026-11-11): host/port/database/url/connectionType/type/config-profile/handlers
// live in `configuration`; the USERNAME and password live in the separate,
// AES-encrypted `credentials-config.json`, so neither is importable here (Hướng 1 —
// metadata only + prompt on connect). SSH tunnels are inline under
// `handlers.ssh_tunnel.properties`, or referenced through `config-profile` →
// `network-profiles[id].handlers.ssh_tunnel.properties`.
//
// Output is a Database Studio v2 *unsealed* connections file (profiles only, no
// secrets) so the existing Import review + applyImported path is reused unchanged.

import type { ConnectionProfile, Environment, SshConfig, SystemType } from '$lib/types'

export interface SkippedSource {
  name: string
  reason: string
}
export interface DbeaverParse {
  profiles: ConnectionProfile[]
  skipped: SkippedSource[]
}

// DBeaver provider id (lower-cased) → our SystemType. Ids confirmed/observed:
// postgresql, mysql, mariaDB, sqlite, oracle, sqlserver, clickhouse, mongodb,
// cassandra, redis, duckdb. Anything else is reported as unsupported.
const PROVIDER_MAP: Record<string, SystemType> = {
  postgresql: 'postgres',
  postgres: 'postgres',
  mysql: 'mysql',
  mysql5: 'mysql',
  mysql8: 'mysql',
  mariadb: 'mariadb',
  sqlserver: 'mssql',
  mssql: 'mssql',
  sqlite: 'sqlite',
  oracle: 'oracle',
  clickhouse: 'clickhouse',
  mongodb: 'mongodb',
  mongo: 'mongodb',
  cassandra: 'cassandra',
  redis: 'redis',
  duckdb: 'duckdb',
}

const DEFAULT_PORT: Partial<Record<SystemType, number>> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mssql: 1433,
  oracle: 1521,
  clickhouse: 8123,
  mongodb: 27017,
  cassandra: 9042,
  redis: 6379,
}

/** DBeaver connection "type" (color category) → our Environment, best-effort. */
export function mapEnv(type: unknown): Environment {
  const t = String(type ?? '').toLowerCase()
  if (t.includes('prod')) return 'production'
  if (t.includes('stag') || t.includes('test') || t.includes('qa') || t.includes('uat')) return 'staging'
  if (t.includes('local')) return 'local'
  return 'development'
}

/** Pull host / port / database out of a JDBC URL when the manual fields are empty
 *  (DBeaver "URL" connections). Best-effort; unparsed parts stay empty. */
export function parseJdbcUrl(url: string): { host: string; port: number; database: string } {
  const out = { host: '', port: 0, database: '' }
  if (!url) return out
  // jdbc:sqlserver://host:1433;databaseName=db;...
  const mss = /jdbc:sqlserver:\/\/([^:;/]+)(?::(\d+))?(?:;.*?databasename=([^;]+))?/i.exec(url)
  if (mss) {
    out.host = mss[1] ?? ''
    out.port = mss[2] ? Number(mss[2]) : 0
    out.database = mss[3] ?? ''
    return out
  }
  // jdbc:oracle:thin:@//host:1521/service  OR  @host:1521:sid
  const ora = /jdbc:oracle:thin:@(?:\/\/)?([^:/]+):(\d+)[:/](.+)$/i.exec(url)
  if (ora) {
    out.host = ora[1] ?? ''
    out.port = Number(ora[2])
    out.database = ora[3] ?? ''
    return out
  }
  // generic jdbc:<driver>://host:port/db?params
  const gen = /jdbc:[^:]+:\/\/([^:/?]+)(?::(\d+))?(?:\/([^?]+))?/i.exec(url)
  if (gen) {
    out.host = gen[1] ?? ''
    out.port = gen[2] ? Number(gen[2]) : 0
    out.database = (gen[3] ?? '').replace(/\/$/, '')
  }
  return out
}

function emptySsh(): SshConfig {
  return { enabled: false, host: '', port: 22, user: '', auth: 'password', key_path: '' }
}

type JsonObj = Record<string, unknown>
const obj = (v: unknown): JsonObj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

/** Resolve the SSH tunnel for one connection: inline properties win, otherwise
 *  the network profile named by `config-profile`. */
function resolveSsh(cfg: JsonObj, networkProfiles: JsonObj): SshConfig {
  const inlineTunnel = obj(obj(cfg.handlers).ssh_tunnel)
  let tunnel = inlineTunnel
  if (!obj(inlineTunnel.properties).host) {
    const profId = str(cfg['config-profile'])
    if (profId) {
      const prof = obj(networkProfiles[profId]) // keyed by id; fall back to name match
      const byName = prof.handlers
        ? prof
        : (Object.values(networkProfiles).map(obj).find((p) => str(p.name) === profId) ?? {})
      tunnel = obj(obj((obj(byName).handlers as JsonObj) ?? {}).ssh_tunnel)
    }
  }
  const props = obj(tunnel.properties)
  if (!tunnel.enabled || !str(props.host)) return emptySsh()
  const authType = str(props.authType).toUpperCase()
  return {
    enabled: true,
    host: str(props.host),
    port: Number(props.port) || 22,
    user: str(props.userName ?? props.user),
    auth: authType.includes('PUBLIC') || authType.includes('KEY') ? 'key' : 'password',
    key_path: str(props.keyPath),
  }
}

let seq = 0
function tempId(): string {
  seq += 1
  return `dbeaver-${Date.now().toString(36)}-${seq}`
}

/** Parse one DBeaver `data-sources.json` string → profiles (no secrets) + the
 *  connections that were skipped and why. Throws a friendly error on bad JSON. */
export function parseDbeaver(jsonText: string): DbeaverParse {
  let doc: JsonObj
  try {
    doc = obj(JSON.parse(jsonText))
  } catch {
    throw new Error('This does not look like a DBeaver data-sources.json file (not valid JSON).')
  }
  const connections = obj(doc.connections)
  if (Object.keys(connections).length === 0) {
    throw new Error('No connections found. Point to DBeaver’s data-sources.json (in .dbeaver inside the workspace).')
  }
  const networkProfiles = obj(doc['network-profiles'])
  const profiles: ConnectionProfile[] = []
  const skipped: SkippedSource[] = []

  for (const raw of Object.values(connections)) {
    const con = obj(raw)
    const name = str(con.name) || 'Unnamed'
    const provider = str(con.provider).toLowerCase()
    const system = PROVIDER_MAP[provider]
    if (!system) {
      skipped.push({ name, reason: `unsupported engine (${str(con.provider) || 'unknown'})` })
      continue
    }
    const cfg = obj(con.configuration)
    let host = str(cfg.host)
    let port = Number(cfg.port) || 0
    let database = str(cfg.database)
    const url = str(cfg.url)
    if ((!host || !port) && url && str(cfg.configurationType).toUpperCase() === 'URL') {
      const u = parseJdbcUrl(url)
      host = host || u.host
      port = port || u.port
      database = database || u.database
    }
    // sqlite/duckdb keep the file path, not host/port
    const isFile = system === 'sqlite' || system === 'duckdb'
    const sqlitePath = isFile ? str(cfg.path) || database || host : ''
    if (!isFile && !port) port = DEFAULT_PORT[system] ?? 0

    const sslHandler = obj(obj(cfg.handlers).ssl)
    const profile: ConnectionProfile = {
      id: tempId(),
      name,
      system,
      host: isFile ? '' : host,
      port: isFile ? 0 : port,
      database: isFile ? '' : database,
      user: '', // DBeaver keeps the username in the encrypted credentials file
      group: '',
      env: mapEnv(cfg.type),
      ssh: resolveSsh(cfg, networkProfiles),
      ssl: sslHandler.enabled === true,
      ssl_ca: '',
      ssl_cert: '',
      ssl_key: '',
      sqlite_path: sqlitePath,
      sqlite_mode: 'read-write',
      mssql_auth: '',
      schema_registry_url: '',
      cassandra_dc: '',
      cassandra_consistency: '',
    }
    profiles.push(profile)
  }
  return { profiles, skipped }
}

/** Wrap profiles (no secrets) into a Database Studio v2 *unsealed* file string, so
 *  the existing Import pipeline (inspectConnectionsFile → review → import) reads
 *  them exactly like a Database Studio export that carried no passwords. */
export function toConnectionsFile(profiles: ConnectionProfile[], now = new Date()): string {
  return JSON.stringify({
    format: 'database-studio-connections',
    version: 2,
    exported_at: now.toISOString(),
    count: profiles.length,
    profiles,
  })
}
