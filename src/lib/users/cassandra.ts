// Cassandra Roles & Permissions — pure CQL builders.
//
// Cassandra has ONE principal type: a role (a role with LOGIN = a "user"). All
// commands run via cql_exec. Role names are double-quoted when they contain
// anything but [A-Za-z0-9_]; passwords are single-quoted string literals.

const SIMPLE = /^[a-zA-Z][a-zA-Z0-9_]*$/

/** Role identifier: bare when simple, else double-quoted (case-sensitive). */
export function rid(name: string): string {
  if (SIMPLE.test(name)) return name
  return `"${name.replace(/"/g, '""')}"`
}

/** String literal (single-quoted). */
export function cl(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// ---- Roles -----------------------------------------------------------------

export interface CreateRoleOptions {
  name: string
  password?: string | null
  login?: boolean
  superuser?: boolean
}

export function createRole(o: CreateRoleOptions): string {
  const opts: string[] = []
  if (o.password) opts.push(`PASSWORD = ${cl(o.password)}`)
  opts.push(`LOGIN = ${o.login ? 'true' : 'false'}`)
  opts.push(`SUPERUSER = ${o.superuser ? 'true' : 'false'}`)
  return `CREATE ROLE ${rid(o.name)} WITH ${opts.join(' AND ')}`
}

/** ALTER ROLE — emit only the changed options. */
export function alterRole(name: string, changed: { password?: string; login?: boolean; superuser?: boolean }): string | null {
  const opts: string[] = []
  if (changed.password) opts.push(`PASSWORD = ${cl(changed.password)}`)
  if (changed.login !== undefined) opts.push(`LOGIN = ${changed.login ? 'true' : 'false'}`)
  if (changed.superuser !== undefined) opts.push(`SUPERUSER = ${changed.superuser ? 'true' : 'false'}`)
  return opts.length ? `ALTER ROLE ${rid(name)} WITH ${opts.join(' AND ')}` : null
}

export function dropRole(name: string, ifExists = true): string {
  return `DROP ROLE ${ifExists ? 'IF EXISTS ' : ''}${rid(name)}`
}

export function grantRole(role: string, to: string): string {
  return `GRANT ${rid(role)} TO ${rid(to)}`
}

export function revokeRole(role: string, from: string): string {
  return `REVOKE ${rid(role)} FROM ${rid(from)}`
}

// ---- Permissions -----------------------------------------------------------

export type Permission = 'ALL PERMISSIONS' | 'SELECT' | 'MODIFY' | 'CREATE' | 'ALTER' | 'DROP' | 'AUTHORIZE' | 'DESCRIBE' | 'EXECUTE'

export type Resource =
  | { kind: 'all-keyspaces' }
  | { kind: 'keyspace'; keyspace: string }
  | { kind: 'table'; keyspace: string; table: string }
  | { kind: 'all-roles' }
  | { kind: 'role'; role: string }

function resourceSql(r: Resource): string {
  switch (r.kind) {
    case 'all-keyspaces':
      return 'ALL KEYSPACES'
    case 'keyspace':
      return `KEYSPACE ${rid(r.keyspace)}`
    case 'table':
      return `TABLE ${rid(r.keyspace)}.${rid(r.table)}`
    case 'all-roles':
      return 'ALL ROLES'
    case 'role':
      return `ROLE ${rid(r.role)}`
  }
}

export function grantPermission(perm: Permission, resource: Resource, role: string): string {
  return `GRANT ${perm} ON ${resourceSql(resource)} TO ${rid(role)}`
}

export function revokePermission(perm: Permission, resource: Resource, role: string): string {
  return `REVOKE ${perm} ON ${resourceSql(resource)} FROM ${rid(role)}`
}

// ---- §1.8.2 keyspace presets -----------------------------------------------
// MODIFY = INSERT + UPDATE + DELETE + TRUNCATE (Cassandra doesn't split writes).

export type PresetKind = 'read-only' | 'read-write' | 'full' | 'revoke-all'

export function keyspacePreset(kind: PresetKind, keyspace: string, role: string): string {
  const r: Resource = { kind: 'keyspace', keyspace }
  switch (kind) {
    case 'read-only':
      return grantPermission('SELECT', r, role)
    case 'read-write':
      return grantPermission('MODIFY', r, role)
    case 'full':
      return grantPermission('ALL PERMISSIONS', r, role)
    case 'revoke-all':
      return revokePermission('ALL PERMISSIONS', r, role)
  }
}
