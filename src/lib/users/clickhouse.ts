// ClickHouse Users & Roles & Grants — pure statement builders.
//
// ClickHouse has SQL-driven RBAC (CREATE USER / ROLE / GRANT). Only users/roles
// stored in local_directory storage are editable by SQL; users defined in
// users.xml are read-only (the manager marks them). Identifiers are backtick-
// quoted (CH escapes ` with a backslash); string literals escape ' and \.

const qi = (name: string) => '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'
const ql = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

// ---- Users -----------------------------------------------------------------

export type ChAuth = 'sha256_password' | 'no_password' | 'plaintext_password'

export interface CreateUserOptions {
  name: string
  auth?: ChAuth
  password?: string | null
  /** HOST clause: undefined = ANY. */
  host?: { kind: 'any' } | { kind: 'ip'; value: string } | { kind: 'like'; value: string }
  defaultRoles?: string[] | 'NONE'
  defaultDatabase?: string | null
}

export function createUser(o: CreateUserOptions): string {
  const parts = [`CREATE USER ${qi(o.name)}`]
  const auth = o.auth ?? 'sha256_password'
  if (auth === 'no_password') parts.push('IDENTIFIED WITH no_password')
  else parts.push(`IDENTIFIED WITH ${auth} BY ${ql(o.password ?? '')}`)
  if (o.host && o.host.kind !== 'any') {
    parts.push(o.host.kind === 'ip' ? `HOST IP ${ql(o.host.value)}` : `HOST LIKE ${ql(o.host.value)}`)
  }
  if (o.defaultRoles === 'NONE') parts.push('DEFAULT ROLE NONE')
  else if (o.defaultRoles && o.defaultRoles.length) parts.push(`DEFAULT ROLE ${o.defaultRoles.map(qi).join(', ')}`)
  if (o.defaultDatabase) parts.push(`DEFAULT DATABASE ${qi(o.defaultDatabase)}`)
  return parts.join(' ')
}

export function alterUserPassword(name: string, auth: ChAuth, password: string): string {
  if (auth === 'no_password') return `ALTER USER ${qi(name)} IDENTIFIED WITH no_password`
  return `ALTER USER ${qi(name)} IDENTIFIED WITH ${auth} BY ${ql(password)}`
}

export function renameUser(from: string, to: string): string {
  return `ALTER USER ${qi(from)} RENAME TO ${qi(to)}`
}

export function dropUser(name: string): string {
  return `DROP USER ${qi(name)}`
}

// ---- Roles -----------------------------------------------------------------

export function createRole(name: string): string {
  return `CREATE ROLE ${qi(name)}`
}

export function dropRole(name: string): string {
  return `DROP ROLE ${qi(name)}`
}

export function grantRole(role: string, grantee: string, admin = false): string {
  return `GRANT ${qi(role)} TO ${qi(grantee)}${admin ? ' WITH ADMIN OPTION' : ''}`
}

export function revokeRole(role: string, grantee: string): string {
  return `REVOKE ${qi(role)} FROM ${qi(grantee)}`
}

export function setDefaultRole(role: 'ALL' | 'NONE' | string, user: string): string {
  const r = role === 'ALL' || role === 'NONE' ? role : qi(role)
  return `SET DEFAULT ROLE ${r} TO ${qi(user)}`
}

// ---- Grants (scope: *.* | db.* | db.table) ---------------------------------

export type Scope = { kind: 'global' } | { kind: 'db'; db: string } | { kind: 'table'; db: string; table: string }

function scopeSql(s: Scope): string {
  switch (s.kind) {
    case 'global':
      return '*.*'
    case 'db':
      return `${qi(s.db)}.*`
    case 'table':
      return `${qi(s.db)}.${qi(s.table)}`
  }
}

export function grant(privs: string[] | 'ALL', scope: Scope, grantee: string, grantOption = false): string {
  const p = privs === 'ALL' ? 'ALL' : privs.join(', ')
  return `GRANT ${p} ON ${scopeSql(scope)} TO ${qi(grantee)}${grantOption ? ' WITH GRANT OPTION' : ''}`
}

export function revoke(privs: string[] | 'ALL', scope: Scope, grantee: string): string {
  const p = privs === 'ALL' ? 'ALL' : privs.join(', ')
  return `REVOKE ${p} ON ${scopeSql(scope)} FROM ${qi(grantee)}`
}

// ---- §1.8.2 full grid columns + per-column grant/revoke ---------------------
// UPDATE/DELETE are ALTER mutations → access_type is `ALTER UPDATE`/`ALTER DELETE`.
export const CH_GRID_COLUMNS: { key: string; label: string; tip: string }[] = [
  { key: 'SELECT', label: 'SELECT', tip: 'SELECT' },
  { key: 'INSERT', label: 'INSERT', tip: 'INSERT' },
  { key: 'ALTER UPDATE', label: 'UPDATE', tip: 'ALTER UPDATE (mutation)' },
  { key: 'ALTER DELETE', label: 'DELETE', tip: 'ALTER DELETE (mutation)' },
  { key: 'ALTER', label: 'ALTER', tip: 'ALTER (DDL)' },
  { key: 'CREATE TABLE', label: 'crtTBL', tip: 'CREATE TABLE' },
  { key: 'CREATE VIEW', label: 'crtVIEW', tip: 'CREATE VIEW' },
  { key: 'DROP TABLE', label: 'dropTBL', tip: 'DROP TABLE' },
  { key: 'TRUNCATE', label: 'TRUNC', tip: 'TRUNCATE' },
  { key: 'OPTIMIZE', label: 'OPTIM', tip: 'OPTIMIZE' },
  { key: 'SHOW', label: 'SHOW', tip: 'SHOW' },
]
export function grantColumn(db: string, priv: string, grantee: string): string {
  return grant([priv], { kind: 'db', db }, grantee)
}
export function revokeColumn(db: string, priv: string, grantee: string): string {
  return revoke([priv], { kind: 'db', db }, grantee)
}

// ---- §1.8.2 database-scope presets -----------------------------------------
// Note: ClickHouse UPDATE/DELETE are mutations → the privileges are named
// `ALTER UPDATE` / `ALTER DELETE`. No EXECUTE object-privilege exists.

export type PresetKind = 'read-only' | 'read-write' | 'full' | 'revoke-all'

// ---- Grant wizard: access level × action (GRANT / REVOKE), db or table -------
// A scope string is "*" (all databases), "db" (a database) or "db.table".
// UPDATE/DELETE map to the ALTER UPDATE / ALTER DELETE mutation privileges.
export const CH_LEVEL_PRIVS: Record<string, string[] | 'ALL'> = {
  'read-only': ['SELECT'],
  'read-write': ['SELECT', 'INSERT', 'ALTER UPDATE', 'ALTER DELETE'],
  full: 'ALL',
}
export function parseScope(scope: string): Scope {
  if (scope === '*') return { kind: 'global' }
  if (scope.endsWith('.*')) return { kind: 'db', db: scope.slice(0, -2) } // db.* = whole database
  const i = scope.indexOf('.')
  if (i < 0) return { kind: 'db', db: scope }
  return { kind: 'table', db: scope.slice(0, i), table: scope.slice(i + 1) }
}
export function accessStatement(action: 'grant' | 'revoke', level: string, scope: string, grantee: string): string {
  const privs = CH_LEVEL_PRIVS[level] ?? ['SELECT']
  const s = parseScope(scope)
  return action === 'revoke' ? revoke(privs, s, grantee) : grant(privs, s, grantee)
}

export function dbPreset(kind: PresetKind, db: string | null, grantee: string): string {
  const scope: Scope = db == null ? { kind: 'global' } : { kind: 'db', db }
  switch (kind) {
    case 'read-only':
      return grant(['SELECT'], scope, grantee)
    case 'read-write':
      return grant(['SELECT', 'INSERT', 'ALTER UPDATE', 'ALTER DELETE'], scope, grantee)
    case 'full':
      return grant('ALL', scope, grantee)
    case 'revoke-all':
      return revoke('ALL', scope, grantee)
  }
}
