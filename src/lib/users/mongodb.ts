// MongoDB Users & Roles — pure helpers. MongoDB is command-based (no SQL), so
// there are no statement builders; these helpers shape role references and the
// per-database built-in role model used by the manager grid (§1.8.2).

export interface RoleRef {
  role: string
  db: string
}

/** Database-scoped built-in roles (the grid columns). */
export const DB_BUILTIN_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin'] as const

/** Cluster-wide built-in roles (assignable via the admin database). */
export const ADMIN_BUILTIN_ROLES = [
  'readAnyDatabase', 'readWriteAnyDatabase', 'userAdminAnyDatabase', 'dbAdminAnyDatabase',
  'clusterAdmin', 'clusterManager', 'clusterMonitor', 'hostManager', 'backup', 'restore', 'root',
] as const

/** Parse "role@db" → {role, db}. */
export function parseRoleRef(s: string): RoleRef | null {
  const at = s.lastIndexOf('@')
  if (at <= 0) return null
  return { role: s.slice(0, at), db: s.slice(at + 1) }
}

/** Render {role, db} → "role@db". */
export function roleLabel(r: RoleRef): string {
  return `${r.role}@${r.db}`
}

/** The roles string from usersInfo ("read@appdb, readWrite@other") → RoleRef[]. */
export function parseRolesCsv(csv: string): RoleRef[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseRoleRef)
    .filter((r): r is RoleRef => r != null)
}

/** Whether a user has role `role` on database `db`. */
export function hasRole(roles: RoleRef[], role: string, db: string): boolean {
  return roles.some((r) => r.role === role && r.db === db)
}

/** §1.8.2 preset → the built-in role to grant on a database. */
export type PresetKind = 'read-only' | 'read-write' | 'admin' | 'owner'
export function presetRole(kind: PresetKind): string {
  switch (kind) {
    case 'read-only':
      return 'read'
    case 'read-write':
      return 'readWrite'
    case 'admin':
      return 'dbAdmin'
    case 'owner':
      return 'dbOwner'
  }
}
