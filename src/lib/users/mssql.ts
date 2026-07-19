// SQL Server Users & Privileges — pure statement builders.
//
// Two tiers: a server-level Login (to authenticate) maps to a database-level
// User (to be granted privileges), plus fixed server roles, fixed + custom
// database roles, and three permission states GRANT / DENY / REVOKE (DENY wins
// over GRANT). Identifiers use [brackets]; passwords use N'…' literals.

const qi = (name: string) => '[' + name.replace(/]/g, ']]') + ']'
const ql = (s: string) => `N'${s.replace(/'/g, "''")}'`

// ---- Server-level: Logins --------------------------------------------------

export interface CreateLoginOptions {
  name: string
  password: string
  checkPolicy?: boolean
  checkExpiration?: boolean
  defaultDatabase?: string | null
}

export function createLogin(o: CreateLoginOptions): string {
  const opts = [`PASSWORD = ${ql(o.password)}`]
  if (o.checkPolicy === false) opts.push('CHECK_POLICY = OFF')
  if (o.checkExpiration === false) opts.push('CHECK_EXPIRATION = OFF')
  if (o.defaultDatabase) opts.push(`DEFAULT_DATABASE = ${qi(o.defaultDatabase)}`)
  return `CREATE LOGIN ${qi(o.name)} WITH ${opts.join(', ')}`
}

/** Windows login: `CREATE LOGIN [DOMAIN\name] FROM WINDOWS`. */
export function createWindowsLogin(name: string, defaultDatabase?: string | null): string {
  const tail = defaultDatabase ? ` WITH DEFAULT_DATABASE = ${qi(defaultDatabase)}` : ''
  return `CREATE LOGIN ${qi(name)} FROM WINDOWS${tail}`
}

export function alterLoginPassword(name: string, password: string): string {
  return `ALTER LOGIN ${qi(name)} WITH PASSWORD = ${ql(password)}`
}

export function setLoginEnabled(name: string, enabled: boolean): string {
  return `ALTER LOGIN ${qi(name)} ${enabled ? 'ENABLE' : 'DISABLE'}`
}

export function dropLogin(name: string): string {
  return `DROP LOGIN ${qi(name)}`
}

// ---- Database-level: Users -------------------------------------------------

export function createUser(name: string, login: string | null, defaultSchema?: string | null): string {
  const schema = defaultSchema ? ` WITH DEFAULT_SCHEMA = ${qi(defaultSchema)}` : ''
  if (login == null) return `CREATE USER ${qi(name)} WITHOUT LOGIN${schema}`
  return `CREATE USER ${qi(name)} FOR LOGIN ${qi(login)}${schema}`
}

export function dropUser(name: string): string {
  return `DROP USER ${qi(name)}`
}

export function remapUser(user: string, login: string): string {
  return `ALTER USER ${qi(user)} WITH LOGIN = ${qi(login)}`
}

// ---- Roles -----------------------------------------------------------------

export function createDbRole(name: string, owner?: string | null): string {
  return owner ? `CREATE ROLE ${qi(name)} AUTHORIZATION ${qi(owner)}` : `CREATE ROLE ${qi(name)}`
}

export function dropDbRole(name: string): string {
  return `DROP ROLE ${qi(name)}`
}

export function setDbRoleMember(role: string, member: string, add: boolean): string {
  return `ALTER ROLE ${qi(role)} ${add ? 'ADD' : 'DROP'} MEMBER ${qi(member)}`
}

export function setServerRoleMember(role: string, login: string, add: boolean): string {
  return `ALTER SERVER ROLE ${qi(role)} ${add ? 'ADD' : 'DROP'} MEMBER ${qi(login)}`
}

// ---- Permissions (GRANT / DENY / REVOKE) -----------------------------------

export type Securable =
  | { kind: 'database'; db: string }
  | { kind: 'schema'; schema: string }
  | { kind: 'object'; schema: string; object: string; cols?: string[] }

function securableSql(s: Securable): string {
  switch (s.kind) {
    case 'database':
      return `DATABASE::${qi(s.db)}`
    case 'schema':
      return `SCHEMA::${qi(s.schema)}`
    case 'object': {
      const cols = s.cols && s.cols.length ? ` (${s.cols.map(qi).join(', ')})` : ''
      return `${qi(s.schema)}.${qi(s.object)}${cols}`
    }
  }
}

export type PermState = 'GRANT' | 'DENY' | 'REVOKE'

export function permission(
  state: PermState,
  perms: string[],
  securable: Securable,
  principal: string,
  grantOption = false,
): string {
  const p = perms.join(', ')
  const target = securableSql(securable)
  if (state === 'REVOKE') {
    return `REVOKE ${p} ON ${target} FROM ${qi(principal)}`
  }
  const go = state === 'GRANT' && grantOption ? ' WITH GRANT OPTION' : ''
  return `${state} ${p} ON ${target} TO ${qi(principal)}${go}`
}

// ---- §1.8.4 full grid columns + per-column GRANT/DENY/REVOKE ----------------
export const MSSQL_GRID_COLUMNS: { key: string; label: string; tip: string }[] = [
  { key: 'SELECT', label: 'SELECT', tip: 'SELECT' },
  { key: 'INSERT', label: 'INSERT', tip: 'INSERT' },
  { key: 'UPDATE', label: 'UPDATE', tip: 'UPDATE' },
  { key: 'DELETE', label: 'DELETE', tip: 'DELETE' },
  { key: 'EXECUTE', label: 'EXECUTE', tip: 'EXECUTE' },
  { key: 'ALTER', label: 'ALTER', tip: 'ALTER' },
  { key: 'REFERENCES', label: 'REFS', tip: 'REFERENCES' },
  { key: 'VIEW DEFINITION', label: 'viewDEF', tip: 'VIEW DEFINITION' },
  { key: 'CONTROL', label: 'CONTROL', tip: 'CONTROL' },
]
export function grantColumn(schema: string, priv: string, principal: string): string {
  return permission('GRANT', [priv], { kind: 'schema', schema }, principal)
}
export function revokeColumn(schema: string, priv: string, principal: string): string {
  return permission('REVOKE', [priv], { kind: 'schema', schema }, principal)
}
export function denyColumn(schema: string, priv: string, principal: string): string {
  return permission('DENY', [priv], { kind: 'schema', schema }, principal)
}

// ---- §1.8.4 schema-scope presets -------------------------------------------

export type PresetKind = 'read-only' | 'read-write' | 'read-write-execute' | 'full' | 'revoke-all'

export function schemaPreset(kind: PresetKind, schema: string, principal: string): string {
  const s: Securable = { kind: 'schema', schema }
  switch (kind) {
    case 'read-only':
      return permission('GRANT', ['SELECT'], s, principal)
    case 'read-write':
      return permission('GRANT', ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], s, principal)
    case 'read-write-execute':
      return permission('GRANT', ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE'], s, principal)
    case 'full':
      return permission('GRANT', ['CONTROL'], s, principal)
    case 'revoke-all':
      return permission(
        'REVOKE',
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'ALTER', 'REFERENCES', 'VIEW DEFINITION', 'CONTROL'],
        s,
        principal,
      )
  }
}

// ---- Grant wizard: access level × action (GRANT / DENY / REVOKE) ------------
// The wizard offers a privilege SET (level) and an ACTION; a schema OR object
// securable. Scope strings are "schema.*" (whole schema) or "schema.object".
export const LEVEL_PERMS: Record<string, string[]> = {
  'read-only': ['SELECT'],
  'read-write': ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  'read-write-execute': ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE'],
  full: ['CONTROL'],
}

/** Parse a wizard scope string into a securable: "schema.*" → whole schema,
 *  "schema.object" → a specific object, bare "schema" → whole schema. */
export function parseSecurable(scope: string): Securable {
  if (scope.endsWith('.*')) return { kind: 'schema', schema: scope.slice(0, -2) }
  const i = scope.indexOf('.')
  if (i < 0) return { kind: 'schema', schema: scope }
  return { kind: 'object', schema: scope.slice(0, i), object: scope.slice(i + 1) }
}

/** One GRANT/DENY/REVOKE statement for a level's privilege set on a securable. */
export function accessStatement(
  action: 'grant' | 'deny' | 'revoke',
  level: string,
  securable: Securable,
  principal: string,
): string {
  const perms = LEVEL_PERMS[level] ?? ['SELECT']
  return permission(action.toUpperCase() as PermState, perms, securable, principal)
}

/** Fixed server / database role name lists (for membership checkboxes). */
export const FIXED_SERVER_ROLES = [
  'sysadmin', 'serveradmin', 'securityadmin', 'processadmin', 'setupadmin', 'bulkadmin', 'diskadmin', 'dbcreator',
]
export const FIXED_DB_ROLES = [
  'db_owner', 'db_datareader', 'db_datawriter', 'db_ddladmin', 'db_securityadmin', 'db_accessadmin',
  'db_backupoperator', 'db_denydatareader', 'db_denydatawriter',
]
