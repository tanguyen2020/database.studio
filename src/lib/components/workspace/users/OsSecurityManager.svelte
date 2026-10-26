<script lang="ts">
  // OpenSearch Security (the security plugin — SPEC-OPENSEARCH.md O16): internal users,
  // roles with cluster / index / tenant permissions (document- and field-level security,
  // field masking), role mappings, action groups and tenants. Every change goes straight
  // to `_plugins/_security/api/*`; built-in (reserved / static) objects are shown read-only.
  import '$lib/elastic/es.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import type { TabState } from '$lib/types'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from '$lib/components/elastic/EsIcon.svelte'
  import EsConfirmDialog from '$lib/components/elastic/EsConfirmDialog.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { es, seg, EsError } from '$lib/elastic/api'
  import {
    TENANT_ACCESS,
    actionGroupsOf,
    attributesOf,
    attributesText,
    dlsError,
    effectiveRoles,
    isLocked,
    listOf,
    mappingWithUser,
    newUserBody,
    roleBody,
    roleMappingChanges,
    rolesMappedByName,
    strongPassword,
    userPatch,
    type OsActionGroup,
    type OsIndexPermission,
    type OsMapping,
    type OsRole,
    type OsTenant,
    type OsUser,
  } from '$lib/elastic/os-security'
  import { toasts } from '$lib/stores/toast.svelte'
  import { untrack } from 'svelte'

  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  type Section = 'users' | 'roles' | 'mappings' | 'actiongroups' | 'tenants'
  let section = $state<Section>('users')

  $effect(() => {
    const f = (tab.state as { focus?: string }).focus
    untrack(() => {
      const s = f?.startsWith('section:') ? f.slice(8) : ''
      if (['users', 'roles', 'mappings', 'actiongroups', 'tenants'].includes(s)) section = s as Section
    })
  })

  const API = '/_plugins/_security/api'
  let users = $state<Record<string, OsUser>>({})
  let roles = $state<Record<string, OsRole>>({})
  let mappings = $state<Record<string, OsMapping>>({})
  let groups = $state<Record<string, OsActionGroup>>({})
  let tenants = $state<Record<string, OsTenant>>({})
  let me = $state<string | null>(null)
  let error = $state<string | null>(null)
  let securityOff = $state(false)
  let loading = $state(false)
  let filter = $state('')

  async function load() {
    loading = true
    error = null
    try {
      const [u, r, m, g, t, a] = await Promise.allSettled([
        es<Record<string, OsUser>>(connId, 'GET', `${API}/internalusers`),
        es<Record<string, OsRole>>(connId, 'GET', `${API}/roles`),
        es<Record<string, OsMapping>>(connId, 'GET', `${API}/rolesmapping`),
        es<Record<string, OsActionGroup>>(connId, 'GET', `${API}/actiongroups`),
        es<Record<string, OsTenant>>(connId, 'GET', `${API}/tenants`),
        es<{ user_name: string }>(connId, 'GET', '/_plugins/_security/authinfo'),
      ])
      // no security plugin (or disabled): every route answers 400 "no handler found"
      securityOff = u.status === 'rejected' && u.reason instanceof EsError && u.reason.status === 400 && /no handler/i.test(String(u.reason.message))
      if (u.status === 'rejected' && !securityOff) error = String((u.reason as Error).message ?? u.reason)
      users = u.status === 'fulfilled' ? u.value : {}
      roles = r.status === 'fulfilled' ? r.value : {}
      mappings = m.status === 'fulfilled' ? m.value : {}
      groups = g.status === 'fulfilled' ? g.value : {}
      tenants = t.status === 'fulfilled' ? t.value : {}
      me = a.status === 'fulfilled' ? a.value.user_name : null
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void connId
    untrack(() => void load())
  })

  const fl = $derived(filter.trim().toLowerCase())
  const match = (...s: (string | undefined)[]) => !fl || s.some((x) => (x ?? '').toLowerCase().includes(fl))
  const visible = <T,>(o: Record<string, T>) => Object.entries(o).filter(([, v]) => !(v as { hidden?: boolean }).hidden)
  const clusterGroups = $derived(actionGroupsOf(groups, 'cluster'))
  const indexGroups = $derived(actionGroupsOf(groups, 'index'))

  let confirm = $state<{ title: string; body: string; action: string; typeToConfirm?: string; run: () => Promise<void> } | null>(null)
  let busy = $state(false)
  let formError = $state<string | null>(null)
  let showPw = $state(false)

  async function guarded(run: () => Promise<void>) {
    if (busy) return
    busy = true
    formError = null
    try {
      await run()
    } catch (e) {
      formError = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  // ---- internal users -------------------------------------------------------------
  let userForm = $state<{
    isNew: boolean
    name: string
    password: string
    confirm: string
    backendRoles: string
    attributes: string
    description: string
    roles: string[]
    before: string[]
  } | null>(null)

  function openUser(name: string | null) {
    const u = name ? users[name] : undefined
    const mapped = name ? rolesMappedByName(name, mappings) : []
    userForm = {
      isNew: !name,
      name: name ?? '',
      password: '',
      confirm: '',
      backendRoles: (u?.backend_roles ?? []).join(', '),
      attributes: attributesText(u?.attributes),
      description: u?.description ?? '',
      roles: [...mapped],
      before: mapped,
    }
    formError = null
    showPw = false
  }

  function passwordProblem(p: string, c: string, required: boolean): string | null {
    if (!p && !required) return null
    if (p.length < 8) return 'At least 8 characters'
    if (p !== c) return 'Passwords do not match'
    return null
  }

  function saveUser() {
    const f = userForm
    if (!f) return
    void guarded(async () => {
      const name = f.name.trim()
      if (f.isNew) {
        if (!/^[\w.@+-]{1,128}$/.test(name)) throw new Error('User names use letters, digits and _ . @ + -')
        if (users[name]) throw new Error(`A user named ${name} already exists`)
      }
      const pe = passwordProblem(f.password, f.confirm, f.isNew)
      if (pe) throw new Error(pe)
      const backendRoles = listOf(f.backendRoles)
      const attrs = attributesOf(f.attributes)
      if (f.isNew) await es(connId, 'PUT', `${API}/internalusers/${seg(name)}`, newUserBody(f.password, backendRoles, attrs, f.description))
      else await es(connId, 'PATCH', `${API}/internalusers/${seg(name)}`, userPatch(backendRoles, attrs, f.description, f.password || undefined))
      // roles reach the user through role mappings — add / remove the user by name
      const { add, remove } = roleMappingChanges(f.before, f.roles)
      for (const role of [...add, ...remove]) {
        await es(connId, 'PUT', `${API}/rolesmapping/${seg(role)}`, mappingWithUser(mappings[role], name, add.includes(role)))
      }
      toasts.success(f.isNew ? `User ${name} created` : `User ${name} saved`, 'elasticsearch')
      userForm = null
      await load()
    })
  }

  function deleteUser(name: string) {
    confirm = {
      title: `Delete user ${name}?`,
      body: 'The user can no longer sign in. Role mappings that name the user are kept (they just match nobody).',
      action: 'Delete user',
      run: async () => {
        await es(connId, 'DELETE', `${API}/internalusers/${seg(name)}`)
        toasts.success(`Deleted ${name}`, 'elasticsearch')
        await load()
      },
    }
  }

  // ---- roles ------------------------------------------------------------------------
  interface IndexPermForm {
    patterns: string
    actions: string[]
    extra: string
    dls: string
    fls: string
    masked: string
  }
  let roleForm = $state<{
    isNew: boolean
    readOnly: boolean
    name: string
    description: string
    cluster: string[]
    clusterExtra: string
    indices: IndexPermForm[]
    tenants: { patterns: string; access: string }[]
    mode: 'form' | 'json'
    json: string
  } | null>(null)

  function openRole(name: string | null) {
    const r = name ? roles[name] : undefined
    const known = new Set(clusterGroups)
    roleForm = {
      isNew: !name,
      readOnly: isLocked(r),
      name: name ?? '',
      description: r?.description ?? '',
      cluster: (r?.cluster_permissions ?? []).filter((c) => known.has(c)),
      clusterExtra: (r?.cluster_permissions ?? []).filter((c) => !known.has(c)).join(', '),
      indices: (r?.index_permissions ?? []).map((p): IndexPermForm => {
        const groupSet = new Set(indexGroups)
        return {
          patterns: p.index_patterns.join(', '),
          actions: p.allowed_actions.filter((a) => groupSet.has(a)),
          extra: p.allowed_actions.filter((a) => !groupSet.has(a)).join(', '),
          dls: p.dls ?? '',
          fls: (p.fls ?? []).join(', '),
          masked: (p.masked_fields ?? []).join(', '),
        }
      }),
      tenants: (r?.tenant_permissions ?? []).map((t) => ({ patterns: t.tenant_patterns.join(', '), access: t.allowed_actions.includes('kibana_all_write') ? 'kibana_all_write' : 'kibana_all_read' })),
      mode: 'form',
      json: '',
    }
    if (!name) roleForm.indices = [{ patterns: '', actions: ['read'], extra: '', dls: '', fls: '', masked: '' }]
    formError = null
  }

  function roleFromForm() {
    const f = roleForm!
    return roleBody({
      description: f.description,
      cluster_permissions: [...f.cluster, ...listOf(f.clusterExtra)],
      index_permissions: f.indices.map(
        (p): OsIndexPermission => ({
          index_patterns: listOf(p.patterns),
          allowed_actions: [...p.actions, ...listOf(p.extra)],
          dls: p.dls,
          fls: listOf(p.fls),
          masked_fields: listOf(p.masked),
        }),
      ),
      tenant_permissions: f.tenants.map((t) => ({ tenant_patterns: listOf(t.patterns), allowed_actions: [t.access] })),
    })
  }

  function saveRole() {
    const f = roleForm
    if (!f || f.readOnly) return
    void guarded(async () => {
      const name = f.name.trim()
      if (f.isNew) {
        if (!/^[\w.@+-]{1,128}$/.test(name)) throw new Error('Role names use letters, digits and _ . @ + -')
        if (roles[name]) throw new Error(`A role named ${name} already exists`)
      }
      let body: unknown
      if (f.mode === 'json') {
        try {
          body = JSON.parse(f.json)
        } catch (e) {
          throw new Error(`Invalid JSON — ${(e as Error).message}`)
        }
      } else {
        for (const p of f.indices) {
          const d = dlsError(p.dls)
          if (d) throw new Error(d)
          if (listOf(p.patterns).length && !p.actions.length && !listOf(p.extra).length) throw new Error(`Pick at least one action for ${p.patterns}`)
        }
        body = roleFromForm()
      }
      await es(connId, 'PUT', `${API}/roles/${seg(name)}`, body)
      toasts.success(f.isNew ? `Role ${name} created` : `Role ${name} saved`, 'elasticsearch')
      roleForm = null
      await load()
    })
  }

  function deleteRole(name: string) {
    confirm = {
      title: `Delete role ${name}?`,
      body: mappings[name] ? 'Users and backend roles mapped to it lose its permissions. Its role mapping is deleted too.' : 'Nobody is mapped to this role.',
      action: 'Delete role',
      run: async () => {
        await es(connId, 'DELETE', `${API}/roles/${seg(name)}`)
        if (mappings[name] && !isLocked(mappings[name])) await es(connId, 'DELETE', `${API}/rolesmapping/${seg(name)}`).catch(() => {})
        toasts.success(`Deleted ${name}`, 'elasticsearch')
        await load()
      },
    }
  }

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  // ---- role mappings ------------------------------------------------------------------
  let mapForm = $state<{ isNew: boolean; role: string; users: string; backendRoles: string; hosts: string; description: string } | null>(null)

  function openMapping(role: string | null) {
    const m = role ? mappings[role] : undefined
    mapForm = {
      isNew: !role,
      role: role ?? Object.keys(roles).find((r) => !mappings[r]) ?? '',
      users: (m?.users ?? []).join(', '),
      backendRoles: (m?.backend_roles ?? []).join(', '),
      hosts: (m?.hosts ?? []).join(', '),
      description: m?.description ?? '',
    }
    formError = null
  }

  function saveMapping() {
    const f = mapForm
    if (!f) return
    void guarded(async () => {
      if (!f.role) throw new Error('Pick the role to map')
      const body: OsMapping = { users: listOf(f.users), backend_roles: listOf(f.backendRoles), hosts: listOf(f.hosts) }
      if (f.description.trim()) body.description = f.description.trim()
      if (!body.users.length && !body.backend_roles.length && !body.hosts.length) throw new Error('Add at least one user, backend role or host')
      await es(connId, 'PUT', `${API}/rolesmapping/${seg(f.role)}`, body)
      toasts.success(`Mapping for ${f.role} saved`, 'elasticsearch')
      mapForm = null
      await load()
    })
  }

  // ---- action groups / tenants -----------------------------------------------------------
  let groupForm = $state<{ isNew: boolean; name: string; type: 'cluster' | 'index'; actions: string; description: string } | null>(null)
  let tenantForm = $state<{ isNew: boolean; name: string; description: string } | null>(null)

  function saveGroup() {
    const f = groupForm
    if (!f) return
    void guarded(async () => {
      const name = f.name.trim()
      if (f.isNew && !/^[\w.@+-]{1,128}$/.test(name)) throw new Error('Names use letters, digits and _ . @ + -')
      if (f.isNew && groups[name]) throw new Error(`An action group named ${name} already exists`)
      const actions = listOf(f.actions)
      if (!actions.length) throw new Error('Add at least one action or action group')
      await es(connId, 'PUT', `${API}/actiongroups/${seg(name)}`, { allowed_actions: actions, type: f.type, ...(f.description.trim() ? { description: f.description.trim() } : {}) })
      toasts.success(`Action group ${name} saved`, 'elasticsearch')
      groupForm = null
      await load()
    })
  }

  function saveTenant() {
    const f = tenantForm
    if (!f) return
    void guarded(async () => {
      const name = f.name.trim()
      if (f.isNew && !/^[\w.@+-]{1,128}$/.test(name)) throw new Error('Names use letters, digits and _ . @ + -')
      if (f.isNew && tenants[name]) throw new Error(`A tenant named ${name} already exists`)
      await es(connId, 'PUT', `${API}/tenants/${seg(name)}`, { description: f.description.trim() })
      toasts.success(`Tenant ${name} saved`, 'elasticsearch')
      tenantForm = null
      await load()
    })
  }

  function deleteSimple(kind: 'actiongroups' | 'tenants' | 'rolesmapping', name: string, what: string, body: string) {
    confirm = {
      title: `Delete ${what} ${name}?`,
      body,
      action: 'Delete',
      run: async () => {
        await es(connId, 'DELETE', `${API}/${kind}/${seg(name)}`)
        toasts.success(`Deleted ${name}`, 'elasticsearch')
        await load()
      },
    }
  }

  const SECTIONS: { key: Section; label: string; icon: 'user' | 'shield' | 'alias' | 'key' | 'users' }[] = [
    { key: 'users', label: 'Internal users', icon: 'user' },
    { key: 'roles', label: 'Roles', icon: 'shield' },
    { key: 'mappings', label: 'Role mappings', icon: 'alias' },
    { key: 'actiongroups', label: 'Action groups', icon: 'key' },
    { key: 'tenants', label: 'Tenants', icon: 'users' },
  ]
  const count = (s: Section) =>
    s === 'users' ? visible(users).length : s === 'roles' ? visible(roles).length : s === 'mappings' ? visible(mappings).length : s === 'actiongroups' ? visible(groups).length : visible(tenants).length
  const lockedBadge = (o: { reserved?: boolean; static?: boolean }) => (o.static ? 'built-in' : o.reserved ? 'reserved' : '')
</script>

<div class="es-page" data-testid="os-security">
  <div class="es-header">
    <span class="es-header-icon"><SystemIcon system="opensearch" size={24} /></span>
    <div style="min-width:0">
      <div class="es-title">Security</div>
      <div class="es-sub">Users, roles and who gets them, permission groups and tenants{me ? ` · signed in as ${me}` : ''}.</div>
    </div>
    <div class="es-header-actions">
      <button class="eg-btn" onclick={load} aria-busy={loading}><EsIcon name="refresh" size={13} /> Refresh</button>
      {#if !securityOff}
        {#if section === 'users'}<button class="eg-btn primary" onclick={() => openUser(null)}><EsIcon name="plus" size={13} /> Create user</button>{/if}
        {#if section === 'roles'}<button class="eg-btn primary" onclick={() => openRole(null)}><EsIcon name="plus" size={13} /> Create role</button>{/if}
        {#if section === 'mappings'}<button class="eg-btn primary" onclick={() => openMapping(null)}><EsIcon name="plus" size={13} /> Map a role</button>{/if}
        {#if section === 'actiongroups'}<button class="eg-btn primary" onclick={() => { groupForm = { isNew: true, name: '', type: 'index', actions: '', description: '' }; formError = null }}><EsIcon name="plus" size={13} /> Create action group</button>{/if}
        {#if section === 'tenants'}<button class="eg-btn primary" onclick={() => { tenantForm = { isNew: true, name: '', description: '' }; formError = null }}><EsIcon name="plus" size={13} /> Create tenant</button>{/if}
      {/if}
    </div>
  </div>
  <div class="es-tabs" role="tablist">
    {#each SECTIONS as s (s.key)}
      <button class="es-tab" class:on={section === s.key} role="tab" aria-selected={section === s.key} onclick={() => (section = s.key)}>
        <EsIcon name={s.icon} size={14} /> {s.label}
        <span class="es-count">{count(s.key)}</span>
      </button>
    {/each}
  </div>

  <div class="es-body">
    {#if securityOff}
      <div class="es-callout warn" data-testid="os-security-off">
        <div><b>The security plugin is not enabled on this cluster.</b> Anyone who can reach port 9200 has full access. Enable the OpenSearch security plugin to manage users, roles and tenants.</div>
      </div>
    {:else}
      {#if error}<div class="es-callout danger" role="alert" style="margin-bottom:var(--px-12)">{error}</div>{/if}
      <input class="es-input" style="width:var(--px-300);margin-bottom:var(--px-12)" bind:value={filter} placeholder="Search…" aria-label="Search security" />

      {#if section === 'users'}
        <div class="es-card">
          <table class="es-table" data-testid="os-users">
            <thead><tr><th>User</th><th>Backend roles</th><th>Roles it gets</th><th>Attributes</th><th></th></tr></thead>
            <tbody>
              {#each visible(users).filter(([n, u]) => match(n, u.description)).sort(([a], [b]) => a.localeCompare(b)) as [name, u] (name)}
                {@const eff = effectiveRoles(name, u, mappings)}
                <tr>
                  <td>
                    <span style="font-weight:600">{name}</span>
                    {#if lockedBadge(u)}<span class="es-badge" style="margin-left:var(--px-6)">{lockedBadge(u)}</span>{/if}
                    {#if name === me}<span class="es-badge accent" style="margin-left:var(--px-6)">you</span>{/if}
                    {#if u.description}<div style="font-size:var(--px-11_5);color:var(--text2)">{u.description}</div>{/if}
                  </td>
                  <td>{#each u.backend_roles as b (b)}<span class="es-badge" style="margin:0 var(--px-4) var(--px-3) 0">{b}</span>{:else}<span style="color:var(--muted)">—</span>{/each}</td>
                  <td>{#each eff as e (e.role)}<span class="es-badge accent" style="margin:0 var(--px-4) var(--px-3) 0" title={e.via}>{e.role}</span>{:else}<span style="color:var(--muted)">none — the user can sign in but do nothing</span>{/each}</td>
                  <td class="mono" style="font-size:var(--px-11_5)">{Object.entries(u.attributes ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}</td>
                  <td style="text-align:right;white-space:nowrap">
                    <button class="eg-btn" onclick={() => openUser(name)} disabled={isLocked(u)} title={isLocked(u) ? 'Reserved users are managed in the security configuration files' : 'Edit'}>Edit</button>
                    {#if !isLocked(u) && name !== me}<button class="eg-btn ds-danger-outline" onclick={() => deleteUser(name)} aria-label="Delete user {name}"><EsIcon name="trash" size={13} /></button>{/if}
                  </td>
                </tr>
              {:else}
                <tr><td colspan="5" style="color:var(--muted)">{loading ? 'Loading…' : 'No internal users'}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if section === 'roles'}
        <div class="es-card">
          <table class="es-table" data-testid="os-roles">
            <thead><tr><th>Role</th><th>Cluster</th><th>Indices</th><th>Tenants</th><th></th></tr></thead>
            <tbody>
              {#each visible(roles).filter(([n, r]) => match(n, r.description)).sort(([a], [b]) => a.localeCompare(b)) as [name, r] (name)}
                <tr>
                  <td>
                    <span style="font-weight:600">{name}</span>
                    {#if lockedBadge(r)}<span class="es-badge" style="margin-left:var(--px-6)">{lockedBadge(r)}</span>{/if}
                    {#if r.description}<div style="font-size:var(--px-11_5);color:var(--text2);max-width:var(--px-300)">{r.description}</div>{/if}
                  </td>
                  <td>{#each r.cluster_permissions as c (c)}<span class="es-badge" style="margin:0 var(--px-4) var(--px-3) 0">{c}</span>{:else}<span style="color:var(--muted)">—</span>{/each}</td>
                  <td style="font-size:var(--px-12)">
                    {#each r.index_permissions as p, k (k)}
                      <div><span class="mono">{p.index_patterns.join(', ')}</span> → {p.allowed_actions.join(', ')}{#if p.dls}<span class="es-badge yellow" style="margin-left:var(--px-4)" title={p.dls}>DLS</span>{/if}{#if p.fls?.length}<span class="es-badge yellow" style="margin-left:var(--px-4)" title={p.fls.join(', ')}>FLS</span>{/if}{#if p.masked_fields?.length}<span class="es-badge yellow" style="margin-left:var(--px-4)" title={p.masked_fields.join(', ')}>masked</span>{/if}</div>
                    {:else}<span style="color:var(--muted)">—</span>{/each}
                  </td>
                  <td style="font-size:var(--px-12)">{#each r.tenant_permissions as t, k (k)}<div><span class="mono">{t.tenant_patterns.join(', ')}</span> · {t.allowed_actions.map((a) => TENANT_ACCESS[a] ?? a).join(', ')}</div>{:else}<span style="color:var(--muted)">—</span>{/each}</td>
                  <td style="text-align:right;white-space:nowrap">
                    <button class="eg-btn" onclick={() => openRole(name)}>{isLocked(r) ? 'View' : 'Edit'}</button>
                    {#if !isLocked(r)}<button class="eg-btn ds-danger-outline" onclick={() => deleteRole(name)} aria-label="Delete role {name}"><EsIcon name="trash" size={13} /></button>{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if section === 'mappings'}
        <div class="es-help" style="margin:0 0 var(--px-10)">A role mapping says who gets a role: users by name, users with a backend role (from LDAP, SAML, OIDC or the internal user), or clients from a host.</div>
        <div class="es-card">
          <table class="es-table" data-testid="os-role-mappings">
            <thead><tr><th>Role</th><th>Users</th><th>Backend roles</th><th>Hosts</th><th></th></tr></thead>
            <tbody>
              {#each visible(mappings).filter(([n, m]) => match(n, m.users.join(' '), m.backend_roles.join(' '))).sort(([a], [b]) => a.localeCompare(b)) as [role, m] (role)}
                <tr>
                  <td><span style="font-weight:600">{role}</span>{#if lockedBadge(m)}<span class="es-badge" style="margin-left:var(--px-6)">{lockedBadge(m)}</span>{/if}</td>
                  <td>{m.users.join(', ') || '—'}</td>
                  <td>{m.backend_roles.join(', ') || '—'}</td>
                  <td>{m.hosts.join(', ') || '—'}</td>
                  <td style="text-align:right;white-space:nowrap">
                    <button class="eg-btn" onclick={() => openMapping(role)} disabled={isLocked(m)}>Edit</button>
                    {#if !isLocked(m)}<button class="eg-btn ds-danger-outline" aria-label="Delete mapping {role}" onclick={() => deleteSimple('rolesmapping', role, 'role mapping for', 'Users and backend roles listed here lose this role. The role itself is kept.')}><EsIcon name="trash" size={13} /></button>{/if}
                  </td>
                </tr>
              {:else}
                <tr><td colspan="5" style="color:var(--muted)">No role mappings</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if section === 'actiongroups'}
        <div class="es-help" style="margin:0 0 var(--px-10)">Named bundles of permissions you can use in roles instead of listing every action.</div>
        <div class="es-card">
          <table class="es-table" data-testid="os-action-groups">
            <thead><tr><th>Action group</th><th>Type</th><th>Allows</th><th></th></tr></thead>
            <tbody>
              {#each visible(groups).filter(([n, g]) => match(n, g.description)).sort(([a], [b]) => a.localeCompare(b)) as [name, g] (name)}
                <tr>
                  <td><span style="font-weight:600">{name}</span>{#if lockedBadge(g)}<span class="es-badge" style="margin-left:var(--px-6)">{lockedBadge(g)}</span>{/if}{#if g.description}<div style="font-size:var(--px-11_5);color:var(--text2)">{g.description}</div>{/if}</td>
                  <td><span class="es-badge">{g.type ?? '—'}</span></td>
                  <td class="mono" style="font-size:var(--px-11_5);max-width:var(--px-420)">{g.allowed_actions.join(', ')}</td>
                  <td style="text-align:right;white-space:nowrap">
                    {#if !isLocked(g)}
                      <button class="eg-btn" onclick={() => { groupForm = { isNew: false, name, type: g.type === 'cluster' ? 'cluster' : 'index', actions: g.allowed_actions.join(', '), description: g.description ?? '' }; formError = null }}>Edit</button>
                      <button class="eg-btn ds-danger-outline" aria-label="Delete action group {name}" onclick={() => deleteSimple('actiongroups', name, 'action group', 'Roles that use it lose the permissions it grants.')}><EsIcon name="trash" size={13} /></button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="es-help" style="margin:0 0 var(--px-10)">Tenants keep OpenSearch Dashboards saved objects (dashboards, visualizations, index patterns) apart. Grant access to a tenant in a role.</div>
        <div class="es-card">
          <table class="es-table" data-testid="os-tenants">
            <thead><tr><th>Tenant</th><th>Description</th><th></th></tr></thead>
            <tbody>
              {#each visible(tenants).filter(([n, t]) => match(n, t.description)).sort(([a], [b]) => a.localeCompare(b)) as [name, t] (name)}
                <tr>
                  <td><span style="font-weight:600">{name}</span>{#if lockedBadge(t)}<span class="es-badge" style="margin-left:var(--px-6)">{lockedBadge(t)}</span>{/if}</td>
                  <td>{t.description || '—'}</td>
                  <td style="text-align:right;white-space:nowrap">
                    {#if !isLocked(t)}
                      <button class="eg-btn" onclick={() => { tenantForm = { isNew: false, name, description: t.description ?? '' }; formError = null }}>Edit</button>
                      <button class="eg-btn ds-danger-outline" aria-label="Delete tenant {name}" onclick={() => deleteSimple('tenants', name, 'tenant', 'Saved objects in this tenant are no longer reachable from OpenSearch Dashboards.')}><EsIcon name="trash" size={13} /></button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </div>
</div>

{#if userForm}
  {@const f = userForm}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label={f.isNew ? 'Create user' : `Edit user ${f.name}`} tabindex="-1" use:focusOnMount style="width:min(var(--px-600), 94vw)" onkeydown={(e) => e.key === 'Escape' && (userForm = null)}>
      <div class="es-modal-h"><span class="es-card-title" style="font-size:var(--px-16)">{f.isNew ? 'Create internal user' : `Edit user ${f.name}`}</span></div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-12)">
        {#if f.isNew}
          <div><label class="es-label" for="os-u-name">User name</label><input id="os-u-name" class="es-input mono" style="width:100%" bind:value={f.name} spellcheck="false" autocomplete="off" /></div>
        {/if}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-10)">
          <div><label class="es-label" for="os-u-pw">{f.isNew ? 'Password' : 'New password'}{#if !f.isNew}<span style="font-weight:400;color:var(--muted)"> (leave empty to keep)</span>{/if}</label><input id="os-u-pw" class="es-input mono" style="width:100%" type={showPw ? 'text' : 'password'} bind:value={f.password} autocomplete="new-password" /></div>
          <div><label class="es-label" for="os-u-pw2">Confirm password</label><input id="os-u-pw2" class="es-input mono" style="width:100%" type={showPw ? 'text' : 'password'} bind:value={f.confirm} autocomplete="new-password" /></div>
        </div>
        <div class="es-toolbar">
          <label style="font-size:var(--px-12);display:inline-flex;gap:var(--px-5);align-items:center"><input type="checkbox" bind:checked={showPw} /> Show</label>
          <button class="eg-btn" onclick={() => { const p = strongPassword(); f.password = p; f.confirm = p; showPw = true }}>Generate a strong password</button>
          <span class="es-help" style="margin:0">The cluster's password policy may also reject passwords close to the user name.</span>
        </div>
        <div>
          <span class="es-label">Roles</span>
          <div class="es-help" style="margin:0 0 var(--px-6)">Ticking a role adds this user to that role's mapping.</div>
          <div class="es-role-picks">
            {#each Object.keys(roles).filter((r) => !roles[r].hidden).sort() as r (r)}
              <label class="es-role-pick" class:on={f.roles.includes(r)}><input type="checkbox" checked={f.roles.includes(r)} onchange={() => (f.roles = toggle(f.roles, r))} /> {r}</label>
            {/each}
          </div>
        </div>
        <div><label class="es-label" for="os-u-br">Backend roles <span style="font-weight:400;color:var(--muted)">(comma separated — matched by role mappings)</span></label><input id="os-u-br" class="es-input mono" style="width:100%" bind:value={f.backendRoles} placeholder="dev, analysts" /></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-10)">
          <div><label class="es-label" for="os-u-attr">Attributes <span style="font-weight:400;color:var(--muted)">(key=value per line)</span></label><textarea id="os-u-attr" class="es-input mono" style="width:100%;min-height:var(--px-72)" bind:value={f.attributes} placeholder="team=payments"></textarea></div>
          <div><label class="es-label" for="os-u-desc">Description</label><textarea id="os-u-desc" class="es-input" style="width:100%;min-height:var(--px-72)" bind:value={f.description}></textarea></div>
        </div>
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (userForm = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={saveUser} disabled={busy} aria-busy={busy}>{f.isNew ? 'Create user' : 'Save user'}</button>
      </div>
    </div>
  </div>
{/if}

{#if roleForm}
  {@const f = roleForm}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label={f.isNew ? 'Create role' : `${f.readOnly ? 'View' : 'Edit'} role ${f.name}`} tabindex="-1" use:focusOnMount style="width:min(var(--px-880), 95vw)" onkeydown={(e) => e.key === 'Escape' && (roleForm = null)}>
      <div class="es-modal-h">
        <span class="es-card-title" style="font-size:var(--px-16)">{f.isNew ? 'Create role' : `${f.readOnly ? 'Role' : 'Edit role'} ${f.name}`}</span>
        {#if f.readOnly}<span class="es-badge" style="margin-left:var(--px-8)">built-in — read only</span>{/if}
        <span class="es-seg" style="margin-left:auto">
          <button class:on={f.mode === 'form'} onclick={() => (f.mode = 'form')}>Permissions</button>
          <button class:on={f.mode === 'json'} onclick={() => { f.json = JSON.stringify(roleFromForm(), null, 2); f.mode = 'json' }}>JSON</button>
        </span>
      </div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-14)">
        <div style="display:grid;grid-template-columns:var(--px-260) 1fr;gap:var(--px-10)">
          <div><label class="es-label" for="os-r-name">Role name</label><input id="os-r-name" class="es-input mono" style="width:100%" bind:value={f.name} disabled={!f.isNew} spellcheck="false" /></div>
          <div><label class="es-label" for="os-r-desc">Description</label><input id="os-r-desc" class="es-input" style="width:100%" bind:value={f.description} disabled={f.readOnly} /></div>
        </div>
        {#if f.mode === 'form'}
          <fieldset disabled={f.readOnly} style="border:none;padding:0;margin:0;display:flex;flex-direction:column;gap:var(--px-14)">
            <div>
              <span class="es-label">Cluster permissions</span>
              <div class="es-role-picks">
                {#each clusterGroups as c (c)}<label class="es-role-pick" class:on={f.cluster.includes(c)}><input type="checkbox" checked={f.cluster.includes(c)} onchange={() => (f.cluster = toggle(f.cluster, c))} /> {c}</label>{/each}
              </div>
              <input class="es-input mono" style="width:100%;margin-top:var(--px-6)" bind:value={f.clusterExtra} placeholder="More cluster actions (comma separated, e.g. cluster:monitor/health)" aria-label="More cluster actions" />
            </div>
            <div>
              <span class="es-label">Index permissions</span>
              {#each f.indices as ip, k (k)}
                <div class="es-card" style="padding:var(--px-10);margin-bottom:var(--px-8);box-shadow:none;display:flex;flex-direction:column;gap:var(--px-8)">
                  <div class="es-toolbar">
                    <input class="es-input mono" style="flex:1 1 auto" bind:value={ip.patterns} placeholder="Index patterns (comma separated, wildcards ok: logs-*)" aria-label="Index patterns {k + 1}" />
                    <button class="eg-btn" aria-label="Remove index permission" onclick={() => (f.indices = f.indices.filter((_, j) => j !== k))}><EsIcon name="trash" size={13} /></button>
                  </div>
                  <div class="es-role-picks">
                    {#each indexGroups as p (p)}<label class="es-role-pick" class:on={ip.actions.includes(p)}><input type="checkbox" checked={ip.actions.includes(p)} onchange={() => (ip.actions = toggle(ip.actions, p))} /> {p}</label>{/each}
                  </div>
                  <input class="es-input mono" bind:value={ip.extra} placeholder="More index actions (comma separated, e.g. indices:data/read/search*)" aria-label="More index actions {k + 1}" />
                  <details>
                    <summary style="cursor:pointer;font-size:var(--px-12);color:var(--text2)">Document &amp; field level security{ip.dls || ip.fls || ip.masked ? ' — set' : ''}</summary>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-8);margin-top:var(--px-8)">
                      <div style="grid-column:1/3"><label class="es-label" for="os-r-dls-{k}">Only documents matching <span style="font-weight:400;color:var(--muted)">(query JSON)</span></label><textarea id="os-r-dls-{k}" class="es-input mono" style="width:100%;min-height:var(--px-60)" bind:value={ip.dls} placeholder={'{"term": {"team": "payments"}}'}></textarea>{#if dlsError(ip.dls)}<div class="es-error-text">{dlsError(ip.dls)}</div>{/if}</div>
                      <div><label class="es-label" for="os-r-fls-{k}">Only these fields <span style="font-weight:400;color:var(--muted)">(~field hides one)</span></label><input id="os-r-fls-{k}" class="es-input mono" style="width:100%" bind:value={ip.fls} placeholder="title, ~salary" /></div>
                      <div><label class="es-label" for="os-r-mask-{k}">Masked fields <span style="font-weight:400;color:var(--muted)">(hashed values)</span></label><input id="os-r-mask-{k}" class="es-input mono" style="width:100%" bind:value={ip.masked} placeholder="email, phone" /></div>
                    </div>
                  </details>
                </div>
              {/each}
              <button class="eg-btn" onclick={() => (f.indices = [...f.indices, { patterns: '', actions: ['read'], extra: '', dls: '', fls: '', masked: '' }])}><EsIcon name="plus" size={13} /> Add index permission</button>
            </div>
            <div>
              <span class="es-label">Tenant permissions <span style="font-weight:400;color:var(--muted)">(OpenSearch Dashboards saved objects)</span></span>
              {#each f.tenants as tp, k (k)}
                <div class="es-toolbar" style="margin-bottom:var(--px-6)">
                  <input class="es-input mono" style="flex:1 1 auto" bind:value={tp.patterns} placeholder="Tenants (comma separated, e.g. global_tenant)" aria-label="Tenant patterns {k + 1}" list="os-tenant-names" />
                  <select class="es-input" bind:value={tp.access} aria-label="Tenant access {k + 1}">
                    <option value="kibana_all_read">Read only</option>
                    <option value="kibana_all_write">Read and write</option>
                  </select>
                  <button class="eg-btn" aria-label="Remove tenant permission" onclick={() => (f.tenants = f.tenants.filter((_, j) => j !== k))}><EsIcon name="trash" size={13} /></button>
                </div>
              {/each}
              <datalist id="os-tenant-names">{#each Object.keys(tenants) as t (t)}<option value={t}></option>{/each}</datalist>
              <button class="eg-btn" onclick={() => (f.tenants = [...f.tenants, { patterns: '', access: 'kibana_all_read' }])}><EsIcon name="plus" size={13} /> Add tenant permission</button>
            </div>
          </fieldset>
        {:else}
          <CodeView value={f.json} language={DS_JSON} readOnly={f.readOnly} height="auto" minHeight={240} maxHeight={520} onChange={(t) => (f.json = t)} ariaLabel="Role JSON" />
        {/if}
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (roleForm = null)}>{f.readOnly ? 'Close' : 'Cancel'}</button>
        {#if !f.readOnly}<button class="eg-btn primary" onclick={saveRole} disabled={busy} aria-busy={busy}>{f.isNew ? 'Create role' : 'Save role'}</button>{/if}
      </div>
    </div>
  </div>
{/if}

{#if mapForm}
  {@const f = mapForm}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label="Role mapping" tabindex="-1" use:focusOnMount style="width:min(var(--px-560), 94vw)" onkeydown={(e) => e.key === 'Escape' && (mapForm = null)}>
      <div class="es-modal-h"><span class="es-card-title" style="font-size:var(--px-16)">{f.isNew ? 'Map a role' : `Who gets ${f.role}`}</span></div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-12)">
        {#if f.isNew}
          <div>
            <label class="es-label" for="os-m-role">Role</label>
            <select id="os-m-role" class="es-input mono" style="width:100%" bind:value={f.role}>
              {#each Object.keys(roles).filter((r) => !roles[r].hidden).sort() as r (r)}<option value={r}>{r}{mappings[r] ? ' (already mapped — edits it)' : ''}</option>{/each}
            </select>
          </div>
        {/if}
        <div><label class="es-label" for="os-m-users">Users</label><input id="os-m-users" class="es-input mono" style="width:100%" bind:value={f.users} placeholder="alice, bob" list="os-user-names" /></div>
        <datalist id="os-user-names">{#each Object.keys(users) as u (u)}<option value={u}></option>{/each}</datalist>
        <div><label class="es-label" for="os-m-br">Backend roles</label><input id="os-m-br" class="es-input mono" style="width:100%" bind:value={f.backendRoles} placeholder="ldap_group_admins" /></div>
        <div><label class="es-label" for="os-m-hosts">Hosts</label><input id="os-m-hosts" class="es-input mono" style="width:100%" bind:value={f.hosts} placeholder="*.corp.example.com" /></div>
        <div><label class="es-label" for="os-m-desc">Description</label><input id="os-m-desc" class="es-input" style="width:100%" bind:value={f.description} /></div>
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (mapForm = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={saveMapping} disabled={busy} aria-busy={busy}>Save mapping</button>
      </div>
    </div>
  </div>
{/if}

{#if groupForm}
  {@const f = groupForm}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label="Action group" tabindex="-1" use:focusOnMount style="width:min(var(--px-560), 94vw)" onkeydown={(e) => e.key === 'Escape' && (groupForm = null)}>
      <div class="es-modal-h"><span class="es-card-title" style="font-size:var(--px-16)">{f.isNew ? 'Create action group' : `Edit action group ${f.name}`}</span></div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-12)">
        <div style="display:grid;grid-template-columns:1fr var(--px-160);gap:var(--px-10)">
          <div><label class="es-label" for="os-g-name">Name</label><input id="os-g-name" class="es-input mono" style="width:100%" bind:value={f.name} disabled={!f.isNew} /></div>
          <div>
            <label class="es-label" for="os-g-type">Applies to</label>
            <select id="os-g-type" class="es-input" style="width:100%" bind:value={f.type}><option value="index">Indices</option><option value="cluster">Cluster</option></select>
          </div>
        </div>
        <div><label class="es-label" for="os-g-actions">Actions and action groups <span style="font-weight:400;color:var(--muted)">(comma separated)</span></label><textarea id="os-g-actions" class="es-input mono" style="width:100%;min-height:var(--px-72)" bind:value={f.actions} placeholder={f.type === 'index' ? 'indices:data/read/*, search' : 'cluster:monitor/*'}></textarea></div>
        <div><label class="es-label" for="os-g-desc">Description</label><input id="os-g-desc" class="es-input" style="width:100%" bind:value={f.description} /></div>
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (groupForm = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={saveGroup} disabled={busy || !f.name.trim()} aria-busy={busy}>Save action group</button>
      </div>
    </div>
  </div>
{/if}

{#if tenantForm}
  {@const f = tenantForm}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label="Tenant" tabindex="-1" use:focusOnMount style="width:min(var(--px-460), 94vw)" onkeydown={(e) => e.key === 'Escape' && (tenantForm = null)}>
      <div class="es-modal-h"><span class="es-card-title" style="font-size:var(--px-16)">{f.isNew ? 'Create tenant' : `Edit tenant ${f.name}`}</span></div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-12)">
        <div><label class="es-label" for="os-t-name">Name</label><input id="os-t-name" class="es-input mono" style="width:100%" bind:value={f.name} disabled={!f.isNew} /></div>
        <div><label class="es-label" for="os-t-desc">Description</label><input id="os-t-desc" class="es-input" style="width:100%" bind:value={f.description} /></div>
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (tenantForm = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={saveTenant} disabled={busy || !f.name.trim()} aria-busy={busy}>Save tenant</button>
      </div>
    </div>
  </div>
{/if}

{#if confirm}
  <EsConfirmDialog title={confirm.title} body={confirm.body} action={confirm.action} typeToConfirm={confirm.typeToConfirm} run={confirm.run} onClose={() => (confirm = null)} />
{/if}

<style>
  .es-role-picks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-6);
  }
  .es-role-pick {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
    font-size: var(--px-12);
    padding: var(--px-3) var(--px-9);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-14);
    cursor: pointer;
    background: var(--raised);
    user-select: none;
  }
  .es-role-pick.on {
    border-color: var(--es-accent);
    background: var(--es-accent-soft);
    color: var(--es-accent);
    font-weight: 600;
  }
  .es-role-pick input {
    accent-color: var(--es-accent);
  }
</style>
