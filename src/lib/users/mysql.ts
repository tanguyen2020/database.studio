// MySQL / MariaDB Users & Privileges — pure statement builders.
//
// An account is a (user, host) pair rendered as 'user'@'host'. MySQL 8 and
// MariaDB share most grammar; the differences (default-role syntax, role
// catalog, auth plugins) are handled via the `system` argument. Identifiers
// (db/table) use backticks; account name + password are string literals where
// both ' and \ must be escaped.

const isMaria = (system: string) => system === 'mariadb'

/** Backtick-quote a schema/table/role identifier. */
export function qi(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`'
}

/** String literal: escape backslash then single-quote (MySQL string rules). */
export function ql(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/** Account literal 'user'@'host'. */
export function acct(user: string, host: string): string {
  return `${ql(user)}@${ql(host)}`
}

// ---- Users -----------------------------------------------------------------

export interface CreateUserOptions {
  user: string
  host: string
  password?: string | null
  /** Auth plugin: mysql → caching_sha2_password|mysql_native_password|sha256_password;
   *  mariadb → mysql_native_password|ed25519|unix_socket. */
  plugin?: string | null
  requireSsl?: boolean
  accountLocked?: boolean
  /** PASSWORD EXPIRE policy: 'never' | 'default' | number (days) | undefined. */
  passwordExpire?: 'never' | 'default' | number | null
}

export function createUser(system: string, o: CreateUserOptions): string {
  const a = acct(o.user, o.host)
  let auth: string
  if (o.plugin === 'unix_socket') {
    auth = 'IDENTIFIED VIA unix_socket'
  } else if (o.plugin && !isMaria(system)) {
    auth = o.password ? `IDENTIFIED WITH ${o.plugin} BY ${ql(o.password)}` : `IDENTIFIED WITH ${o.plugin}`
  } else {
    auth = o.password ? `IDENTIFIED BY ${ql(o.password)}` : ''
  }
  const parts = [`CREATE USER ${a}`]
  if (auth) parts.push(auth)
  if (o.requireSsl) parts.push('REQUIRE SSL')
  if (o.passwordExpire === 'never') parts.push('PASSWORD EXPIRE NEVER')
  else if (o.passwordExpire === 'default') parts.push('PASSWORD EXPIRE DEFAULT')
  else if (typeof o.passwordExpire === 'number') parts.push(`PASSWORD EXPIRE INTERVAL ${Math.trunc(o.passwordExpire)} DAY`)
  if (o.accountLocked) parts.push('ACCOUNT LOCK')
  return parts.join(' ')
}

export function alterPassword(user: string, host: string, password: string): string {
  return `ALTER USER ${acct(user, host)} IDENTIFIED BY ${ql(password)}`
}

export function lockAccount(user: string, host: string, locked: boolean): string {
  return `ALTER USER ${acct(user, host)} ACCOUNT ${locked ? 'LOCK' : 'UNLOCK'}`
}

export function expirePassword(user: string, host: string): string {
  return `ALTER USER ${acct(user, host)} PASSWORD EXPIRE`
}

export function renameUser(fromU: string, fromH: string, toU: string, toH: string): string {
  return `RENAME USER ${acct(fromU, fromH)} TO ${acct(toU, toH)}`
}

export function dropUser(user: string, host: string): string {
  return `DROP USER ${acct(user, host)}`
}

// ---- Grants ----------------------------------------------------------------

export type GrantLevel = { kind: 'global' } | { kind: 'schema'; db: string } | { kind: 'table'; db: string; table: string }

function levelSql(l: GrantLevel): string {
  switch (l.kind) {
    case 'global':
      return '*.*'
    case 'schema':
      return `${qi(l.db)}.*`
    case 'table':
      return `${qi(l.db)}.${qi(l.table)}`
  }
}

export function grant(privs: string[] | 'ALL', level: GrantLevel, user: string, host: string, grantOption = false): string {
  const p = privs === 'ALL' ? 'ALL PRIVILEGES' : privs.join(', ')
  return `GRANT ${p} ON ${levelSql(level)} TO ${acct(user, host)}${grantOption ? ' WITH GRANT OPTION' : ''}`
}

export function grantColumns(privWithCols: { priv: string; cols: string[] }[], db: string, table: string, user: string, host: string): string {
  const p = privWithCols.map((x) => `${x.priv} (${x.cols.map(qi).join(', ')})`).join(', ')
  return `GRANT ${p} ON ${qi(db)}.${qi(table)} TO ${acct(user, host)}`
}

export function revoke(privs: string[] | 'ALL', level: GrantLevel, user: string, host: string): string {
  const p = privs === 'ALL' ? 'ALL PRIVILEGES' : privs.join(', ')
  return `REVOKE ${p} ON ${levelSql(level)} FROM ${acct(user, host)}`
}

export function revokeAll(user: string, host: string): string {
  return `REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${acct(user, host)}`
}

// ---- §1.8.2 database-scope presets -----------------------------------------

export type PresetKind = 'read-only' | 'read-write' | 'read-write-execute' | 'full' | 'revoke-all'

/** Preset for a database scope (or global when db is null). Returns one GRANT/
 *  REVOKE statement — MySQL grants the whole scope in a single statement. */
export function dbPreset(kind: PresetKind, db: string | null, user: string, host: string): string {
  const level: GrantLevel = db == null ? { kind: 'global' } : { kind: 'schema', db }
  switch (kind) {
    case 'read-only':
      return grant(['SELECT'], level, user, host)
    case 'read-write':
      return grant(['SELECT', 'INSERT', 'UPDATE', 'DELETE'], level, user, host)
    case 'read-write-execute':
      return grant(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE'], level, user, host)
    case 'full':
      return grant('ALL', level, user, host)
    case 'revoke-all':
      return revoke('ALL', level, user, host)
  }
}

// ---- Roles -----------------------------------------------------------------

export function createRole(system: string, role: string, host?: string): string {
  return host ? `CREATE ROLE ${acct(role, host)}` : `CREATE ROLE ${ql(role)}`
}

export function dropRole(role: string, host?: string): string {
  return host ? `DROP ROLE ${acct(role, host)}` : `DROP ROLE ${ql(role)}`
}

export function grantRole(role: string, user: string, host: string, admin = false): string {
  return `GRANT ${ql(role)} TO ${acct(user, host)}${admin ? ' WITH ADMIN OPTION' : ''}`
}

export function revokeRole(role: string, user: string, host: string): string {
  return `REVOKE ${ql(role)} FROM ${acct(user, host)}`
}

/** Default role. MySQL: `SET DEFAULT ROLE {ALL|<r>|NONE} TO 'u'@'h'`.
 *  MariaDB: `SET DEFAULT ROLE {<r>|NONE} FOR 'u'@'h'` (keyword FOR, no ALL). */
export function setDefaultRole(system: string, role: 'ALL' | 'NONE' | string, user: string, host: string): string {
  const target = role === 'ALL' || role === 'NONE' ? role : ql(role)
  if (isMaria(system)) {
    // MariaDB has no ALL form; ALL falls back to NONE-less behaviour is not valid,
    // so callers pass a concrete role or NONE for MariaDB.
    const r = role === 'ALL' ? 'NONE' : target
    return `SET DEFAULT ROLE ${r} FOR ${acct(user, host)}`
  }
  return `SET DEFAULT ROLE ${target} TO ${acct(user, host)}`
}
