// OpenSearch security plugin model (SPEC-OPENSEARCH.md O16) — the shapes of
// `_plugins/_security/api/{internalusers,roles,rolesmapping,actiongroups,tenants}`
// as measured on OpenSearch 3.9, and the pure request builders the Security screen
// uses. Roles reach a user through role MAPPINGS (by user name, by backend role or by
// host) — what an admin wants to see is the roles a user effectively gets.

export interface OsUser {
  backend_roles: string[]
  attributes: Record<string, string>
  description?: string
  opendistro_security_roles?: string[]
  reserved?: boolean
  hidden?: boolean
  static?: boolean
}

export interface OsIndexPermission {
  index_patterns: string[]
  allowed_actions: string[]
  /** document-level security: a query (JSON string) */
  dls?: string
  /** field-level security: field names, `~field` excludes */
  fls?: string[]
  masked_fields?: string[]
}

export interface OsTenantPermission {
  tenant_patterns: string[]
  allowed_actions: string[]
}

export interface OsRole {
  cluster_permissions: string[]
  index_permissions: OsIndexPermission[]
  tenant_permissions: OsTenantPermission[]
  description?: string
  reserved?: boolean
  hidden?: boolean
  static?: boolean
}

export interface OsMapping {
  users: string[]
  backend_roles: string[]
  hosts: string[]
  and_backend_roles?: string[]
  description?: string
  reserved?: boolean
  hidden?: boolean
}

export interface OsActionGroup {
  allowed_actions: string[]
  type?: 'cluster' | 'index' | 'kibana' | string
  description?: string
  reserved?: boolean
  hidden?: boolean
  static?: boolean
}

export interface OsTenant {
  description?: string
  reserved?: boolean
  hidden?: boolean
  static?: boolean
}

/** Server-managed objects (reserved / static / hidden) are read-only. */
export const isLocked = (o: { reserved?: boolean; static?: boolean; hidden?: boolean } | undefined) => !!(o?.reserved || o?.static || o?.hidden)

/** The roles a user gets: mapped by name, by one of its backend roles, plus roles set on the user itself. */
export function effectiveRoles(user: string, u: OsUser | undefined, mappings: Record<string, OsMapping>): { role: string; via: string }[] {
  const out = new Map<string, string>()
  for (const r of u?.opendistro_security_roles ?? []) out.set(r, 'assigned on the user')
  for (const [role, m] of Object.entries(mappings)) {
    if ((m.users ?? []).includes(user) || (m.users ?? []).includes('*')) out.set(role, out.get(role) ?? 'mapped to the user')
    else {
      const br = (u?.backend_roles ?? []).find((b) => (m.backend_roles ?? []).includes(b))
      if (br && !out.has(role)) out.set(role, `via backend role ${br}`)
    }
  }
  return [...out].map(([role, via]) => ({ role, via })).sort((a, b) => a.role.localeCompare(b.role))
}

/** Roles that list the user BY NAME in their mapping — the ones this screen can add / remove. */
export function rolesMappedByName(user: string, mappings: Record<string, OsMapping>): string[] {
  return Object.entries(mappings)
    .filter(([, m]) => (m.users ?? []).includes(user))
    .map(([r]) => r)
    .sort()
}

/** Mapping body to PUT after adding / removing a user (the rest of the mapping is kept). */
export function mappingWithUser(m: OsMapping | undefined, user: string, present: boolean): OsMapping {
  const base: OsMapping = { users: [...(m?.users ?? [])], backend_roles: [...(m?.backend_roles ?? [])], hosts: [...(m?.hosts ?? [])] }
  if (m?.and_backend_roles?.length) base.and_backend_roles = [...m.and_backend_roles]
  if (m?.description) base.description = m.description
  base.users = present ? [...new Set([...base.users, user])] : base.users.filter((u) => u !== user)
  return base
}

/** Which role mappings change when the user's by-name roles go from `before` to `after`. */
export function roleMappingChanges(before: string[], after: string[]): { add: string[]; remove: string[] } {
  return { add: after.filter((r) => !before.includes(r)).sort(), remove: before.filter((r) => !after.includes(r)).sort() }
}

/** Comma / newline separated list → trimmed unique items. */
export function listOf(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean))]
}

/** `key=value` lines → attributes object. */
export function attributesOf(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

export const attributesText = (a: Record<string, string> | undefined) =>
  Object.entries(a ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')

/** Body to create an internal user. */
export function newUserBody(password: string, backendRoles: string[], attributes: Record<string, string>, description: string) {
  const b: Record<string, unknown> = { password, backend_roles: backendRoles, attributes }
  if (description.trim()) b.description = description.trim()
  return b
}

/** JSON-patch to update an existing user (PUT would need the password again). */
export function userPatch(backendRoles: string[], attributes: Record<string, string>, description: string, password?: string) {
  const ops: { op: 'add' | 'replace'; path: string; value: unknown }[] = [
    { op: 'add', path: '/backend_roles', value: backendRoles },
    { op: 'add', path: '/attributes', value: attributes },
    { op: 'add', path: '/description', value: description.trim() },
  ]
  if (password) ops.push({ op: 'add', path: '/password', value: password })
  return ops
}

/** Role body, dropping empty DLS / FLS / masking so the role reads cleanly. */
export function roleBody(r: Pick<OsRole, 'cluster_permissions' | 'index_permissions' | 'tenant_permissions'> & { description?: string }) {
  return {
    ...(r.description?.trim() ? { description: r.description.trim() } : {}),
    cluster_permissions: r.cluster_permissions,
    index_permissions: r.index_permissions
      .filter((p) => p.index_patterns.length)
      .map((p) => ({
        index_patterns: p.index_patterns,
        allowed_actions: p.allowed_actions,
        ...(p.dls?.trim() ? { dls: p.dls.trim() } : {}),
        ...(p.fls?.length ? { fls: p.fls } : {}),
        ...(p.masked_fields?.length ? { masked_fields: p.masked_fields } : {}),
      })),
    tenant_permissions: r.tenant_permissions.filter((t) => t.tenant_patterns.length),
  }
}

/** A DLS query must be a JSON object (the security plugin stores it as a string). */
export function dlsError(dls: string | undefined): string | null {
  if (!dls?.trim()) return null
  try {
    const v = JSON.parse(dls)
    return v && typeof v === 'object' && !Array.isArray(v) ? null : 'Document-level security must be a query object, e.g. {"term":{"team":"a"}}'
  } catch (e) {
    return `Document-level security is not valid JSON — ${(e as Error).message}`
  }
}

/** Tenant access in words: read-only or read-write (Dashboards saved objects). */
export const TENANT_ACCESS: Record<string, string> = { kibana_all_read: 'Read only', kibana_all_write: 'Read and write' }

/** Action groups of a type, sorted (for the permission pickers). */
export function actionGroupsOf(groups: Record<string, OsActionGroup>, type: 'cluster' | 'index'): string[] {
  return Object.entries(groups)
    .filter(([, g]) => g.type === type)
    .map(([n]) => n)
    .sort()
}

/** A password the security plugin's default policy accepts (8+ chars, upper, lower, digit, symbol). */
export function strongPassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#%^*-_']
  const all = sets.join('')
  const a = new Uint32Array(18)
  crypto.getRandomValues(a)
  const chars = [...a].map((n, i) => (i < sets.length ? sets[i][n % sets[i].length] : all[n % all.length]))
  // shuffle so the class order is not predictable
  for (let i = chars.length - 1; i > 0; i--) {
    const j = a[i] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
