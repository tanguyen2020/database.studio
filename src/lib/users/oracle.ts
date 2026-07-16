// Oracle Users & Roles & Privileges — pure statement builders.
//
// Oracle folds unquoted identifiers to UPPERCASE; object privileges are granted
// per-object only (no GRANT ON SCHEMA). System/role grants use ADMIN OPTION;
// object grants use GRANT OPTION (the builders keep them separate). Passwords go
// in IDENTIFIED BY "…" (double-quoted) and must not contain a double quote.

const SIMPLE = /^[A-Za-z][A-Za-z0-9_$#]*$/

/** Identifier: bare-uppercased when simple (matches Oracle's stored name),
 *  else double-quoted (case-preserved). A `"` in a quoted name is rejected. */
export function oid(name: string): string {
  if (SIMPLE.test(name)) return name.toUpperCase()
  if (name.includes('"')) throw new Error('Oracle identifier cannot contain a double quote')
  return `"${name}"`
}

/** String literal (single-quoted). */
export function ol(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** Password for IDENTIFIED BY "…" — double-quoted, `"` rejected. */
function pw(password: string): string {
  if (password.includes('"')) throw new Error('Oracle password cannot contain a double quote')
  return `"${password}"`
}

// ---- Users -----------------------------------------------------------------

export interface CreateUserOptions {
  name: string
  password: string
  defaultTablespace?: string | null
  temporaryTablespace?: string | null
  quota?: { unlimited: boolean; mb?: number; tablespace: string } | null
  profile?: string | null
  /** Emit GRANT CREATE SESSION (bật sẵn — else the user cannot log in). */
  grantCreateSession?: boolean
}

/** Returns 1..2 statements: CREATE USER, then optional GRANT CREATE SESSION. */
export function createUser(o: CreateUserOptions): string[] {
  const parts = [`CREATE USER ${oid(o.name)} IDENTIFIED BY ${pw(o.password)}`]
  if (o.defaultTablespace) parts.push(`DEFAULT TABLESPACE ${oid(o.defaultTablespace)}`)
  if (o.temporaryTablespace) parts.push(`TEMPORARY TABLESPACE ${oid(o.temporaryTablespace)}`)
  if (o.quota) parts.push(`QUOTA ${o.quota.unlimited ? 'UNLIMITED' : `${Math.trunc(o.quota.mb ?? 0)}M`} ON ${oid(o.quota.tablespace)}`)
  if (o.profile) parts.push(`PROFILE ${oid(o.profile)}`)
  const out = [parts.join(' ')]
  if (o.grantCreateSession) out.push(`GRANT CREATE SESSION TO ${oid(o.name)}`)
  return out
}

export function alterPassword(name: string, password: string): string {
  return `ALTER USER ${oid(name)} IDENTIFIED BY ${pw(password)}`
}

export function lockAccount(name: string, locked: boolean): string {
  return `ALTER USER ${oid(name)} ACCOUNT ${locked ? 'LOCK' : 'UNLOCK'}`
}

export function expirePassword(name: string): string {
  return `ALTER USER ${oid(name)} PASSWORD EXPIRE`
}

export function setQuota(name: string, tablespace: string, unlimited: boolean, mb?: number): string {
  return `ALTER USER ${oid(name)} QUOTA ${unlimited ? 'UNLIMITED' : `${Math.trunc(mb ?? 0)}M`} ON ${oid(tablespace)}`
}

export function dropUser(name: string, cascade = false): string {
  return `DROP USER ${oid(name)}${cascade ? ' CASCADE' : ''}`
}

// ---- Roles -----------------------------------------------------------------

export function createRole(name: string, password?: string | null): string {
  return password ? `CREATE ROLE ${oid(name)} IDENTIFIED BY ${pw(password)}` : `CREATE ROLE ${oid(name)}`
}

export function dropRole(name: string): string {
  return `DROP ROLE ${oid(name)}`
}

// ---- System / role / object privileges -------------------------------------

export function grantSysPrivs(privs: string[], grantee: string, adminOption = false): string {
  return `GRANT ${privs.join(', ')} TO ${oid(grantee)}${adminOption ? ' WITH ADMIN OPTION' : ''}`
}

export function revokeSysPrivs(privs: string[], grantee: string): string {
  return `REVOKE ${privs.join(', ')} FROM ${oid(grantee)}`
}

export function grantRole(role: string, grantee: string, adminOption = false): string {
  return `GRANT ${oid(role)} TO ${oid(grantee)}${adminOption ? ' WITH ADMIN OPTION' : ''}`
}

export function revokeRole(role: string, grantee: string): string {
  return `REVOKE ${oid(role)} FROM ${oid(grantee)}`
}

export function defaultRoleAll(user: string): string {
  return `ALTER USER ${oid(user)} DEFAULT ROLE ALL`
}

export type ObjPriv = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALTER' | 'INDEX' | 'REFERENCES' | 'EXECUTE' | 'READ' | 'WRITE'

export function grantObjPrivs(
  privs: ObjPriv[],
  owner: string,
  object: string,
  grantee: string,
  opts: { cols?: string[]; grantOption?: boolean } = {},
): string {
  const cols = opts.cols && opts.cols.length ? ` (${opts.cols.map(oid).join(', ')})` : ''
  const p = privs.join(', ') + cols
  return `GRANT ${p} ON ${oid(owner)}.${oid(object)} TO ${oid(grantee)}${opts.grantOption ? ' WITH GRANT OPTION' : ''}`
}

export function revokeObjPrivs(privs: ObjPriv[] | 'ALL', owner: string, object: string, grantee: string): string {
  const p = privs === 'ALL' ? 'ALL' : privs.join(', ')
  return `REVOKE ${p} ON ${oid(owner)}.${oid(object)} FROM ${oid(grantee)}`
}

// ---- §1.8.4 presets — per-object batches (Oracle has no GRANT ON SCHEMA) ----
// `objects` = table/view names owned by `owner` (from introspection); `procs` =
// procedure/function/package names (for EXECUTE). Preview shows every statement.

export type PresetKind = 'read-only' | 'read-write' | 'read-write-execute' | 'revoke-all'

export function schemaPreset(
  kind: PresetKind,
  owner: string,
  grantee: string,
  objects: string[],
  procs: string[] = [],
): string[] {
  const out: string[] = []
  for (const obj of objects) {
    if (kind === 'read-only') out.push(grantObjPrivs(['SELECT'], owner, obj, grantee))
    else if (kind === 'read-write') out.push(grantObjPrivs(['SELECT', 'INSERT', 'UPDATE', 'DELETE'], owner, obj, grantee))
    else if (kind === 'read-write-execute') out.push(grantObjPrivs(['SELECT', 'INSERT', 'UPDATE', 'DELETE'], owner, obj, grantee))
    else out.push(revokeObjPrivs('ALL', owner, obj, grantee))
  }
  if (kind === 'read-write-execute') {
    for (const p of procs) out.push(grantObjPrivs(['EXECUTE'], owner, p, grantee))
  }
  if (kind === 'revoke-all') {
    for (const p of procs) out.push(revokeObjPrivs(['EXECUTE'], owner, p, grantee))
  }
  return out
}
