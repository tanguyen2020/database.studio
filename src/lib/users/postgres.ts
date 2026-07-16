// PostgreSQL Users/Roles & Privileges — pure statement builders.
//
// Postgres has ONE principal type: a role. A "user" is a role with LOGIN; a
// "group" is a role without LOGIN. Privileges are ACLs on objects; membership
// is role-in-role. All builders return runnable SQL strings; identifiers and
// string literals are quoted here (privilege keywords are enum whitelists and
// never come from free text).

import { quoteIdent } from '$lib/sql/dialect'

const qi = (name: string) => quoteIdent('postgres', name)
const ql = (s: string) => `'${s.replace(/'/g, "''")}'`

// ---- Role attributes (CREATE / ALTER) --------------------------------------

export interface RoleOptions {
  login?: boolean
  superuser?: boolean
  createdb?: boolean
  createrole?: boolean
  replication?: boolean
  bypassrls?: boolean
  inherit?: boolean
  connectionLimit?: number | null
  password?: string | null
  validUntil?: string | null
  /** IN ROLE <r1>, <r2> — roles this new role becomes a member of. */
  inRole?: string[]
}

/** Emit the WITH-clause option tokens for CREATE ROLE. Only options that are
 *  explicitly set are emitted (undefined = use server default). */
function createOptionTokens(o: RoleOptions): string[] {
  const t: string[] = []
  if (o.login !== undefined) t.push(o.login ? 'LOGIN' : 'NOLOGIN')
  if (o.superuser) t.push('SUPERUSER')
  if (o.createdb) t.push('CREATEDB')
  if (o.createrole) t.push('CREATEROLE')
  if (o.replication) t.push('REPLICATION')
  if (o.bypassrls) t.push('BYPASSRLS')
  if (o.inherit === false) t.push('NOINHERIT')
  if (o.connectionLimit !== undefined && o.connectionLimit !== null)
    t.push(`CONNECTION LIMIT ${Math.trunc(o.connectionLimit)}`)
  if (o.password != null && o.password !== '') t.push(`PASSWORD ${ql(o.password)}`)
  if (o.validUntil) t.push(`VALID UNTIL ${ql(o.validUntil)}`)
  if (o.inRole && o.inRole.length) t.push(`IN ROLE ${o.inRole.map(qi).join(', ')}`)
  return t
}

export function createRole(name: string, o: RoleOptions): string {
  const tokens = createOptionTokens(o)
  return tokens.length ? `CREATE ROLE ${qi(name)} ${tokens.join(' ')}` : `CREATE ROLE ${qi(name)}`
}

/** ALTER ROLE for the attribute flags/limits the user changed. `changed` holds
 *  only the fields that differ from the loaded state (caller diffs). */
export function alterRoleOptions(name: string, changed: RoleOptions): string | null {
  const t: string[] = []
  if (changed.login !== undefined) t.push(changed.login ? 'LOGIN' : 'NOLOGIN')
  if (changed.superuser !== undefined) t.push(changed.superuser ? 'SUPERUSER' : 'NOSUPERUSER')
  if (changed.createdb !== undefined) t.push(changed.createdb ? 'CREATEDB' : 'NOCREATEDB')
  if (changed.createrole !== undefined) t.push(changed.createrole ? 'CREATEROLE' : 'NOCREATEROLE')
  if (changed.replication !== undefined) t.push(changed.replication ? 'REPLICATION' : 'NOREPLICATION')
  if (changed.bypassrls !== undefined) t.push(changed.bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS')
  if (changed.inherit !== undefined) t.push(changed.inherit ? 'INHERIT' : 'NOINHERIT')
  if (changed.connectionLimit !== undefined && changed.connectionLimit !== null)
    t.push(`CONNECTION LIMIT ${Math.trunc(changed.connectionLimit)}`)
  return t.length ? `ALTER ROLE ${qi(name)} ${t.join(' ')}` : null
}

export function alterPassword(name: string, password: string): string {
  return `ALTER ROLE ${qi(name)} PASSWORD ${ql(password)}`
}

export function alterValidUntil(name: string, ts: string | null): string {
  return `ALTER ROLE ${qi(name)} VALID UNTIL ${ql(ts ?? 'infinity')}`
}

export function renameRole(from: string, to: string): string {
  return `ALTER ROLE ${qi(from)} RENAME TO ${qi(to)}`
}

export function dropRole(name: string): string {
  return `DROP ROLE ${qi(name)}`
}

/** Reassign + drop owned objects then drop the role (current database only). */
export function dropRoleOwned(name: string, newOwner: string): string[] {
  return [
    `REASSIGN OWNED BY ${qi(name)} TO ${qi(newOwner)}`,
    `DROP OWNED BY ${qi(name)}`,
    `DROP ROLE ${qi(name)}`,
  ]
}

// ---- Membership ------------------------------------------------------------

export function grantMembership(role: string, member: string, admin = false): string {
  return `GRANT ${qi(role)} TO ${qi(member)}${admin ? ' WITH ADMIN OPTION' : ''}`
}

export function revokeMembership(role: string, member: string): string {
  return `REVOKE ${qi(role)} FROM ${qi(member)}`
}

// ---- Object privileges (fine-grained) --------------------------------------

export type TablePriv = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER'

export function grantOnTable(
  schema: string,
  table: string,
  privs: TablePriv[] | 'ALL',
  grantee: string,
  grantOption = false,
): string {
  const p = privs === 'ALL' ? 'ALL PRIVILEGES' : privs.join(', ')
  return `GRANT ${p} ON TABLE ${qi(schema)}.${qi(table)} TO ${qi(grantee)}${grantOption ? ' WITH GRANT OPTION' : ''}`
}

// ---- §1.8.3 Privilege presets per (database D — via connection, schema S) ---
// These return an ordered list of statements. The caller runs them on the
// connection already attached to database D. `owner` = schema owner for the
// default-privileges (future-tables) statements.

export interface SchemaPresetOptions {
  /** Also apply to future objects via ALTER DEFAULT PRIVILEGES. */
  futureTables?: boolean
  /** Schema owner — required when futureTables is set. */
  owner?: string | null
}

export function presetReadOnly(schema: string, user: string, o: SchemaPresetOptions = {}): string[] {
  const s = qi(schema)
  const u = qi(user)
  const out = [
    `GRANT USAGE ON SCHEMA ${s} TO ${u}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${u}`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${u}`,
  ]
  if (o.futureTables && o.owner) {
    const ow = qi(o.owner)
    out.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ow} IN SCHEMA ${s} GRANT SELECT ON TABLES TO ${u}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ow} IN SCHEMA ${s} GRANT USAGE, SELECT ON SEQUENCES TO ${u}`,
    )
  }
  return out
}

export function presetReadWrite(schema: string, user: string, o: SchemaPresetOptions = {}): string[] {
  const s = qi(schema)
  const u = qi(user)
  const out = [
    ...presetReadOnly(schema, user), // USAGE + SELECT (no future here — added below with write privs)
    `GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${u}`,
    `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${u}`,
  ]
  if (o.futureTables && o.owner) {
    const ow = qi(o.owner)
    out.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ow} IN SCHEMA ${s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${u}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ow} IN SCHEMA ${s} GRANT USAGE, SELECT ON SEQUENCES TO ${u}`,
    )
  }
  return out
}

export function presetReadWriteExecute(schema: string, user: string, o: SchemaPresetOptions = {}): string[] {
  const s = qi(schema)
  const u = qi(user)
  const out = [...presetReadWrite(schema, user), `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${u}`]
  if (o.futureTables && o.owner) {
    const ow = qi(o.owner)
    out.push(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ow} IN SCHEMA ${s} GRANT EXECUTE ON FUNCTIONS TO ${u}`)
  }
  return out
}

export function presetFull(schema: string, user: string): string[] {
  const s = qi(schema)
  const u = qi(user)
  return [
    `GRANT USAGE, CREATE ON SCHEMA ${s} TO ${u}`,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${s} TO ${u}`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${s} TO ${u}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${u}`,
  ]
}

/** Revoke everything on a schema, including default privileges granted earlier
 *  (else objects created later silently regain access). `owners` = the set of
 *  owners found in default_acl with grantee = user in this schema. */
export function presetRevokeAll(schema: string, user: string, owners: string[] = []): string[] {
  const s = qi(schema)
  const u = qi(user)
  const out = [
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${s} FROM ${u}`,
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${s} FROM ${u}`,
    `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} FROM ${u}`,
    `REVOKE USAGE, CREATE ON SCHEMA ${s} FROM ${u}`,
  ]
  for (const owner of owners) {
    const ow = qi(owner)
    out.push(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ow} IN SCHEMA ${s} REVOKE ALL ON TABLES FROM ${u}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ow} IN SCHEMA ${s} REVOKE ALL ON SEQUENCES FROM ${u}`,
    )
  }
  return out
}

/** GRANT CONNECT on a database — needed before schema access is usable. */
export function grantConnect(database: string, user: string): string {
  return `GRANT CONNECT ON DATABASE ${qi(database)} TO ${qi(user)}`
}

export type PresetKind = 'read-only' | 'read-write' | 'read-write-execute' | 'full' | 'revoke-all'

/** Dispatch a preset by kind → ordered statements (schema scope). */
export function schemaPreset(
  kind: PresetKind,
  schema: string,
  user: string,
  o: SchemaPresetOptions & { owners?: string[] } = {},
): string[] {
  switch (kind) {
    case 'read-only':
      return presetReadOnly(schema, user, o)
    case 'read-write':
      return presetReadWrite(schema, user, o)
    case 'read-write-execute':
      return presetReadWriteExecute(schema, user, o)
    case 'full':
      return presetFull(schema, user)
    case 'revoke-all':
      return presetRevokeAll(schema, user, o.owners)
  }
}
