<script lang="ts">
  // Elasticsearch Security (Kibana Stack Management → Security): users, roles with
  // cluster / index privileges, API keys and role mappings — all through the
  // _security REST API, changes applied immediately.
  import '$lib/elastic/es.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import type { TabState } from '$lib/types'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from '$lib/components/elastic/EsIcon.svelte'
  import EsAppIcon from '$lib/components/elastic/EsAppIcon.svelte'
  import EsConfirmDialog from '$lib/components/elastic/EsConfirmDialog.svelte'
  import { es, seg } from '$lib/elastic/api'
  import { fmtTimestamp } from '$lib/elastic/format'
  import { toasts } from '$lib/stores/toast.svelte'
  import { untrack } from 'svelte'

  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  type Section = 'users' | 'roles' | 'apikeys' | 'mappings'
  let section = $state<Section>('users')

  $effect(() => {
    const f = (tab.state as { focus?: string }).focus
    untrack(() => {
      if (f?.startsWith('section:')) section = f.slice(8) as Section
    })
  })

  interface User {
    username: string
    roles: string[]
    full_name: string | null
    email: string | null
    enabled: boolean
    metadata?: { _reserved?: boolean }
  }
  interface Role {
    cluster: string[]
    indices: { names: string[]; privileges: string[]; allow_restricted_indices?: boolean }[]
    run_as: string[]
    applications?: unknown[]
    metadata?: { _reserved?: boolean }
  }
  interface ApiKey {
    id: string
    name: string
    creation: number
    expiration?: number | null
    invalidated: boolean
    username: string
    realm: string
  }

  let users = $state<User[]>([])
  let roles = $state<Record<string, Role>>({})
  let keys = $state<ApiKey[]>([])
  let mappings = $state<Record<string, unknown>>({})
  let builtin = $state<{ cluster: string[]; index: string[] }>({ cluster: [], index: [] })
  let me = $state<string | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let filter = $state('')

  async function load() {
    loading = true
    error = null
    try {
      const [u, r, k, m, b, a] = await Promise.allSettled([
        es<Record<string, User>>(connId, 'GET', '/_security/user'),
        es<Record<string, Role>>(connId, 'GET', '/_security/role'),
        es<{ api_keys: ApiKey[] }>(connId, 'GET', '/_security/api_key'),
        es<Record<string, unknown>>(connId, 'GET', '/_security/role_mapping'),
        es<{ cluster: string[]; index: string[] }>(connId, 'GET', '/_security/privilege/_builtin'),
        es<{ username: string }>(connId, 'GET', '/_security/_authenticate'),
      ])
      if (u.status === 'rejected') error = String((u.reason as Error).message ?? u.reason)
      users = u.status === 'fulfilled' ? Object.values(u.value).sort((x, y) => x.username.localeCompare(y.username)) : []
      roles = r.status === 'fulfilled' ? r.value : {}
      keys = k.status === 'fulfilled' ? (k.value.api_keys ?? []).sort((x, y) => y.creation - x.creation) : []
      mappings = m.status === 'fulfilled' ? m.value : {}
      if (b.status === 'fulfilled') builtin = b.value
      me = a.status === 'fulfilled' ? a.value.username : null
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void connId
    untrack(() => void load())
  })

  const securityOff = $derived(!!error && /security must be explicitly enabled|security is not enabled|not enabled/i.test(error))

  // ---- users -----------------------------------------------------------------
  let userForm = $state<{ isNew: boolean; username: string; password: string; confirm: string; full_name: string; email: string; roles: string[] } | null>(null)
  let pwForm = $state<{ username: string; password: string; confirm: string } | null>(null)
  let showPw = $state(false)
  let confirm = $state<{ title: string; body: string; action: string; typeToConfirm?: string; run: () => Promise<void> } | null>(null)
  let busy = $state(false)
  let formError = $state<string | null>(null)

  function genPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_'
    const a = new Uint32Array(20)
    crypto.getRandomValues(a)
    return [...a].map((n) => chars[n % chars.length]).join('')
  }

  const pwError = (p: string, c: string, required: boolean) =>
    !p && !required ? null : p.length < 6 ? 'At least 6 characters' : p !== c ? 'Passwords do not match' : null

  async function saveUser() {
    if (!userForm || busy) return
    const f = userForm
    if (f.isNew) {
      if (!/^[\w.@+-]{1,507}$/.test(f.username)) return void (formError = 'Usernames use letters, digits and _ . @ + -')
      const pe = pwError(f.password, f.confirm, true)
      if (pe) return void (formError = pe)
    }
    busy = true
    formError = null
    try {
      const body: Record<string, unknown> = { roles: f.roles, full_name: f.full_name || null, email: f.email || null }
      if (f.isNew) body.password = f.password
      await es(connId, 'PUT', `/_security/user/${seg(f.username)}`, body)
      toasts.success(`${f.isNew ? 'Created' : 'Updated'} user ${f.username}`, 'elasticsearch')
      userForm = null
      await load()
    } catch (e) {
      formError = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  async function savePassword() {
    if (!pwForm || busy) return
    const pe = pwError(pwForm.password, pwForm.confirm, true)
    if (pe) return void (formError = pe)
    busy = true
    formError = null
    try {
      await es(connId, 'POST', `/_security/user/${seg(pwForm.username)}/_password`, { password: pwForm.password })
      toasts.success(`Password changed for ${pwForm.username}`, 'elasticsearch')
      pwForm = null
    } catch (e) {
      formError = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  async function setEnabled(u: User, enabled: boolean) {
    try {
      await es(connId, 'PUT', `/_security/user/${seg(u.username)}/${enabled ? '_enable' : '_disable'}`)
      toasts.success(`${enabled ? 'Enabled' : 'Disabled'} ${u.username}`, 'elasticsearch')
      await load()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  function deleteUser(u: User) {
    confirm = {
      title: `Delete user ${u.username}?`,
      body: 'The user can no longer log in. API keys it created are not deleted.',
      action: 'Delete user',
      typeToConfirm: u.username,
      run: async () => {
        await es(connId, 'DELETE', `/_security/user/${seg(u.username)}`)
        toasts.success(`Deleted user ${u.username}`, 'elasticsearch')
        await load()
      },
    }
  }

  // ---- roles -------------------------------------------------------------------
  let roleForm = $state<{ isNew: boolean; name: string; cluster: string[]; indices: { names: string; privileges: string[] }[]; runAs: string; json: string; mode: 'form' | 'json' } | null>(null)

  function editRole(name: string | null) {
    const r = name ? roles[name] : null
    roleForm = {
      isNew: !name,
      name: name ?? '',
      cluster: [...(r?.cluster ?? [])],
      indices: (r?.indices ?? [{ names: [], privileges: ['read'] }]).map((i) => ({ names: i.names.join(', '), privileges: [...i.privileges] })),
      runAs: (r?.run_as ?? []).join(', '),
      json: JSON.stringify(r ? { cluster: r.cluster, indices: r.indices, run_as: r.run_as, applications: r.applications ?? [] } : { cluster: [], indices: [], run_as: [] }, null, 2),
      mode: 'form',
    }
    formError = null
  }

  function roleBody() {
    const f = roleForm!
    if (f.mode === 'json') return JSON.parse(f.json)
    return {
      cluster: f.cluster,
      indices: f.indices.filter((i) => i.names.trim()).map((i) => ({ names: i.names.split(',').map((s) => s.trim()).filter(Boolean), privileges: i.privileges })),
      run_as: f.runAs.split(',').map((s) => s.trim()).filter(Boolean),
    }
  }

  async function saveRole() {
    if (!roleForm || busy) return
    if (!/^[\w.@+-]{1,507}$/.test(roleForm.name)) return void (formError = 'Role names use letters, digits and _ . @ + -')
    let body
    try {
      body = roleBody()
    } catch (e) {
      return void (formError = `Invalid JSON — ${(e as Error).message}`)
    }
    busy = true
    formError = null
    try {
      await es(connId, 'PUT', `/_security/role/${seg(roleForm.name)}`, body)
      toasts.success(`Saved role ${roleForm.name}`, 'elasticsearch')
      roleForm = null
      await load()
    } catch (e) {
      formError = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  function deleteRole(name: string) {
    confirm = {
      title: `Delete role ${name}?`,
      body: `Users and role mappings that reference "${name}" lose its privileges.`,
      action: 'Delete role',
      run: async () => {
        await es(connId, 'DELETE', `/_security/role/${seg(name)}`)
        toasts.success(`Deleted role ${name}`, 'elasticsearch')
        await load()
      },
    }
  }

  function togglePriv(list: string[], p: string): string[] {
    return list.includes(p) ? list.filter((x) => x !== p) : [...list, p]
  }

  // ---- API keys --------------------------------------------------------------------
  let keyForm = $state<{ name: string; expiration: string; descriptors: string } | null>(null)
  let newKey = $state<{ name: string; id: string; encoded: string; api_key: string } | null>(null)

  async function createKey() {
    if (!keyForm?.name.trim() || busy) return
    let descriptors: unknown = undefined
    if (keyForm.descriptors.trim()) {
      try {
        descriptors = JSON.parse(keyForm.descriptors)
      } catch (e) {
        return void (formError = `Role descriptors are not valid JSON — ${(e as Error).message}`)
      }
    }
    busy = true
    formError = null
    try {
      const body: Record<string, unknown> = { name: keyForm.name.trim() }
      if (keyForm.expiration.trim()) body.expiration = keyForm.expiration.trim()
      if (descriptors) body.role_descriptors = descriptors
      newKey = await es(connId, 'POST', '/_security/api_key', body)
      keyForm = null
      await load()
    } catch (e) {
      formError = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  function invalidateKey(k: ApiKey) {
    confirm = {
      title: `Invalidate API key ${k.name}?`,
      body: 'Requests using this key are refused from now on. This cannot be undone.',
      action: 'Invalidate',
      run: async () => {
        await es(connId, 'DELETE', '/_security/api_key', { ids: [k.id] })
        toasts.success(`Invalidated ${k.name}`, 'elasticsearch')
        await load()
      },
    }
  }

  // ---- role mappings ----------------------------------------------------------------
  let mapForm = $state<{ isNew: boolean; name: string; json: string } | null>(null)
  async function saveMapping() {
    if (!mapForm || busy) return
    let body
    try {
      body = JSON.parse(mapForm.json)
    } catch (e) {
      return void (formError = `Invalid JSON — ${(e as Error).message}`)
    }
    busy = true
    formError = null
    try {
      await es(connId, 'PUT', `/_security/role_mapping/${seg(mapForm.name)}`, body)
      toasts.success(`Saved role mapping ${mapForm.name}`, 'elasticsearch')
      mapForm = null
      await load()
    } catch (e) {
      formError = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  async function copy(t: string) {
    await navigator.clipboard.writeText(t)
    toasts.success('Copied', 'elasticsearch')
  }

  const SECTIONS: { key: Section; label: string; icon: 'user' | 'shield' | 'key' | 'alias' }[] = [
    { key: 'users', label: 'Users', icon: 'user' },
    { key: 'roles', label: 'Roles', icon: 'shield' },
    { key: 'apikeys', label: 'API keys', icon: 'key' },
    { key: 'mappings', label: 'Role mappings', icon: 'alias' },
  ]
  const fl = $derived(filter.trim().toLowerCase())
</script>

<div class="es-page" data-testid="es-security">
  <div class="es-header">
    <span class="es-header-icon"><EsAppIcon name="usersRoles" size={24} /></span>
    <div style="min-width:0">
      <div class="es-title">Security</div>
      <div class="es-sub">Users, roles and privileges, API keys and role mappings{me ? ` · signed in as ${me}` : ''}.</div>
    </div>
    <div class="es-header-actions">
      <button class="eg-btn" onclick={load} aria-busy={loading}><EsIcon name="refresh" size={13} /> Refresh</button>
      {#if section === 'users'}<button class="eg-btn primary" onclick={() => { userForm = { isNew: true, username: '', password: '', confirm: '', full_name: '', email: '', roles: [] }; formError = null }}><EsIcon name="plus" size={13} /> Create user</button>{/if}
      {#if section === 'roles'}<button class="eg-btn primary" onclick={() => editRole(null)}><EsIcon name="plus" size={13} /> Create role</button>{/if}
      {#if section === 'apikeys'}<button class="eg-btn primary" onclick={() => { keyForm = { name: '', expiration: '30d', descriptors: '' }; formError = null }}><EsIcon name="plus" size={13} /> Create API key</button>{/if}
      {#if section === 'mappings'}<button class="eg-btn primary" onclick={() => { mapForm = { isNew: true, name: '', json: JSON.stringify({ enabled: true, roles: ['viewer'], rules: { field: { 'realm.name': 'ldap1' } }, metadata: {} }, null, 2) }; formError = null }}><EsIcon name="plus" size={13} /> Create role mapping</button>{/if}
    </div>
  </div>
  <div class="es-tabs" role="tablist">
    {#each SECTIONS as s (s.key)}
      <button class="es-tab" class:on={section === s.key} role="tab" aria-selected={section === s.key} onclick={() => (section = s.key)}>
        <EsIcon name={s.icon} size={14} /> {s.label}
        <span class="es-count">{s.key === 'users' ? users.length : s.key === 'roles' ? Object.keys(roles).length : s.key === 'apikeys' ? keys.filter((k) => !k.invalidated).length : Object.keys(mappings).length}</span>
      </button>
    {/each}
  </div>

  <div class="es-body">
    {#if securityOff}
      <div class="es-callout warn"><div><b>Security is disabled on this cluster.</b> Enable <span class="mono">xpack.security.enabled</span> to manage users, roles and API keys.</div></div>
    {:else if error}
      <div class="es-callout danger" role="alert">{error}</div>
    {/if}
    {#if !securityOff}
      <input class="es-input" style="width:var(--px-300);margin-bottom:var(--px-12)" bind:value={filter} placeholder="Search…" aria-label="Search security" />
      {#if section === 'users'}
        <div class="es-card">
          <table class="es-table" data-testid="es-users">
            <thead><tr><th>User</th><th>Full name</th><th>Email</th><th>Roles</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {#each users.filter((u) => !fl || u.username.toLowerCase().includes(fl) || (u.full_name ?? '').toLowerCase().includes(fl)) as u (u.username)}
                <tr>
                  <td><span style="font-weight:600">{u.username}</span>{#if u.metadata?._reserved}<span class="es-badge" style="margin-left:var(--px-6)">reserved</span>{/if}{#if u.username === me}<span class="es-badge accent" style="margin-left:var(--px-6)">you</span>{/if}</td>
                  <td>{u.full_name || '—'}</td>
                  <td>{u.email || '—'}</td>
                  <td>{#each u.roles as r (r)}<span class="es-badge" style="margin:0 var(--px-4) var(--px-3) 0">{r}</span>{/each}</td>
                  <td><span class="es-badge {u.enabled ? 'green' : 'red'}">{u.enabled ? 'Enabled' : 'Disabled'}</span></td>
                  <td style="text-align:right;white-space:nowrap">
                    <button class="eg-btn" onclick={() => { userForm = { isNew: false, username: u.username, password: '', confirm: '', full_name: u.full_name ?? '', email: u.email ?? '', roles: [...u.roles] }; formError = null }} disabled={!!u.metadata?._reserved} title={u.metadata?._reserved ? 'Reserved users cannot be edited' : 'Edit'}>Edit</button>
                    <button class="eg-btn" onclick={() => { pwForm = { username: u.username, password: '', confirm: '' }; formError = null }}>Password</button>
                    {#if u.username !== me}<button class="eg-btn" onclick={() => setEnabled(u, !u.enabled)}>{u.enabled ? 'Disable' : 'Enable'}</button>{/if}
                    {#if !u.metadata?._reserved && u.username !== me}<button class="eg-btn ds-danger-outline" onclick={() => deleteUser(u)} aria-label="Delete user {u.username}"><EsIcon name="trash" size={13} /></button>{/if}
                  </td>
                </tr>
              {:else}
                <tr><td colspan="6" style="color:var(--muted)">{loading ? 'Loading…' : 'No users'}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if section === 'roles'}
        <div class="es-card">
          <table class="es-table" data-testid="es-roles">
            <thead><tr><th>Role</th><th>Cluster privileges</th><th>Index privileges</th><th></th></tr></thead>
            <tbody>
              {#each Object.entries(roles).filter(([n]) => !fl || n.toLowerCase().includes(fl)).sort(([a], [b]) => a.localeCompare(b)) as [name, r] (name)}
                <tr>
                  <td><span style="font-weight:600">{name}</span>{#if r.metadata?._reserved}<span class="es-badge" style="margin-left:var(--px-6)">reserved</span>{/if}</td>
                  <td>{#each r.cluster as c (c)}<span class="es-badge" style="margin:0 var(--px-4) var(--px-3) 0">{c}</span>{:else}<span style="color:var(--muted)">—</span>{/each}</td>
                  <td style="font-size:var(--px-12)">{#each r.indices as i, k (k)}<div><span class="mono">{i.names.join(', ')}</span> → {i.privileges.join(', ')}</div>{:else}<span style="color:var(--muted)">—</span>{/each}</td>
                  <td style="text-align:right;white-space:nowrap">
                    <button class="eg-btn" onclick={() => editRole(name)} disabled={!!r.metadata?._reserved} title={r.metadata?._reserved ? 'Reserved roles cannot be edited' : 'Edit'}>Edit</button>
                    {#if !r.metadata?._reserved}<button class="eg-btn ds-danger-outline" onclick={() => deleteRole(name)} aria-label="Delete role {name}"><EsIcon name="trash" size={13} /></button>{/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else if section === 'apikeys'}
        {#if newKey}
          <div class="es-callout" style="margin-bottom:var(--px-14)" data-testid="es-new-key">
            <div style="min-width:0;flex:1 1 auto">
              <b>API key "{newKey.name}" created.</b> Copy it now — it is shown only once.
              <div class="mono selectable" style="margin-top:var(--px-6);word-break:break-all">{newKey.encoded}</div>
              <div class="es-toolbar" style="margin-top:var(--px-8)">
                <button class="eg-btn primary" onclick={() => copy(newKey!.encoded)}><EsIcon name="copy" size={13} /> Copy encoded key</button>
                <button class="eg-btn" onclick={() => copy(`${newKey!.id}:${newKey!.api_key}`)}>Copy id:key</button>
                <button class="eg-btn" onclick={() => (newKey = null)}>Done</button>
              </div>
            </div>
          </div>
        {/if}
        <div class="es-card">
          <table class="es-table" data-testid="es-api-keys">
            <thead><tr><th>Name</th><th>Owner</th><th>Created</th><th>Expires</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {#each keys.filter((k) => !fl || (k.name ?? '').toLowerCase().includes(fl)) as k (k.id)}
                {@const expired = !!k.expiration && k.expiration < Date.now()}
                <tr>
                  <td><span style="font-weight:600">{k.name}</span><div class="mono" style="font-size:var(--px-11);color:var(--muted)">{k.id}</div></td>
                  <td>{k.username}</td>
                  <td>{fmtTimestamp(k.creation)}</td>
                  <td>{k.expiration ? fmtTimestamp(k.expiration) : 'Never'}</td>
                  <td><span class="es-badge {k.invalidated || expired ? 'red' : 'green'}">{k.invalidated ? 'Invalidated' : expired ? 'Expired' : 'Active'}</span></td>
                  <td style="text-align:right">{#if !k.invalidated}<button class="eg-btn ds-danger-outline" onclick={() => invalidateKey(k)}>Invalidate</button>{/if}</td>
                </tr>
              {:else}
                <tr><td colspan="6" style="color:var(--muted)">No API keys</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="es-card">
          <table class="es-table" data-testid="es-role-mappings">
            <thead><tr><th>Mapping</th><th>Roles</th><th>Enabled</th><th></th></tr></thead>
            <tbody>
              {#each Object.entries(mappings) as [name, m] (name)}
                {@const mm = m as { roles?: string[]; enabled?: boolean }}
                <tr>
                  <td style="font-weight:600">{name}</td>
                  <td>{(mm.roles ?? []).join(', ') || '—'}</td>
                  <td><span class="es-badge {mm.enabled ? 'green' : ''}">{mm.enabled ? 'yes' : 'no'}</span></td>
                  <td style="text-align:right;white-space:nowrap">
                    <button class="eg-btn" onclick={() => { mapForm = { isNew: false, name, json: JSON.stringify(m, null, 2) }; formError = null }}>Edit</button>
                    <button class="eg-btn ds-danger-outline" aria-label="Delete mapping {name}" onclick={() => (confirm = { title: `Delete role mapping ${name}?`, body: 'Users matched by this mapping lose the roles it grants.', action: 'Delete', run: async () => { await es(connId, 'DELETE', `/_security/role_mapping/${seg(name)}`); await load() } })}><EsIcon name="trash" size={13} /></button>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="4" style="color:var(--muted)">No role mappings — map users from LDAP / SAML / OIDC realms to roles.</td></tr>
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
    <div class="es-modal" role="dialog" aria-modal="true" aria-label={f.isNew ? 'Create user' : `Edit user ${f.username}`} tabindex="-1" use:focusOnMount style="width:min(var(--px-560), 94vw)" onkeydown={(e) => e.key === 'Escape' && (userForm = null)}>
      <div class="es-modal-h"><span class="es-card-title" style="font-size:var(--px-16)">{f.isNew ? 'Create user' : `Edit user ${f.username}`}</span></div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-12)">
        {#if f.isNew}
          <div><label class="es-label" for="es-u-name">Username</label><input id="es-u-name" class="es-input mono" style="width:100%" bind:value={f.username} spellcheck="false" autocomplete="off" /></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-10)">
            <div><label class="es-label" for="es-u-pw">Password</label><input id="es-u-pw" class="es-input mono" style="width:100%" type={showPw ? 'text' : 'password'} bind:value={f.password} autocomplete="new-password" /></div>
            <div><label class="es-label" for="es-u-pw2">Confirm password</label><input id="es-u-pw2" class="es-input mono" style="width:100%" type={showPw ? 'text' : 'password'} bind:value={f.confirm} autocomplete="new-password" /></div>
          </div>
          <div class="es-toolbar">
            <label style="font-size:var(--px-12);display:inline-flex;gap:var(--px-5);align-items:center"><input type="checkbox" bind:checked={showPw} /> Show</label>
            <button class="eg-btn" onclick={() => { const p = genPassword(); f.password = p; f.confirm = p; showPw = true }}>Generate</button>
          </div>
        {/if}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-10)">
          <div><label class="es-label" for="es-u-full">Full name</label><input id="es-u-full" class="es-input" style="width:100%" bind:value={f.full_name} /></div>
          <div><label class="es-label" for="es-u-mail">Email</label><input id="es-u-mail" class="es-input" style="width:100%" type="email" bind:value={f.email} /></div>
        </div>
        <div>
          <span class="es-label">Roles</span>
          <div class="es-role-picks">
            {#each Object.keys(roles).sort() as r (r)}
              <label class="es-role-pick" class:on={f.roles.includes(r)}><input type="checkbox" checked={f.roles.includes(r)} onchange={() => (f.roles = togglePriv(f.roles, r))} /> {r}</label>
            {/each}
          </div>
        </div>
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (userForm = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={saveUser} disabled={busy}>{f.isNew ? 'Create user' : 'Save user'}</button>
      </div>
    </div>
  </div>
{/if}

{#if pwForm}
  {@const p = pwForm}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label="Change password" tabindex="-1" use:focusOnMount style="width:min(var(--px-460), 94vw)" onkeydown={(e) => e.key === 'Escape' && (pwForm = null)}>
      <div class="es-modal-h"><span class="es-card-title" style="font-size:var(--px-16)">Change password — {p.username}</span></div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-10)">
        <div><label class="es-label" for="es-p1">New password</label><input id="es-p1" class="es-input mono" style="width:100%" type={showPw ? 'text' : 'password'} bind:value={p.password} autocomplete="new-password" /></div>
        <div><label class="es-label" for="es-p2">Confirm password</label><input id="es-p2" class="es-input mono" style="width:100%" type={showPw ? 'text' : 'password'} bind:value={p.confirm} autocomplete="new-password" /></div>
        <div class="es-toolbar">
          <label style="font-size:var(--px-12);display:inline-flex;gap:var(--px-5);align-items:center"><input type="checkbox" bind:checked={showPw} /> Show</label>
          <button class="eg-btn" onclick={() => { const g = genPassword(); p.password = g; p.confirm = g; showPw = true }}>Generate</button>
        </div>
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (pwForm = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={savePassword} disabled={busy}>Change password</button>
      </div>
    </div>
  </div>
{/if}

{#if roleForm}
  {@const f = roleForm}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label={f.isNew ? 'Create role' : `Edit role ${f.name}`} tabindex="-1" use:focusOnMount style="width:min(var(--px-840), 95vw)" onkeydown={(e) => e.key === 'Escape' && (roleForm = null)}>
      <div class="es-modal-h">
        <span class="es-card-title" style="font-size:var(--px-16)">{f.isNew ? 'Create role' : `Edit role ${f.name}`}</span>
        <span class="es-seg" style="margin-left:auto">
          <button class:on={f.mode === 'form'} onclick={() => (f.mode = 'form')}>Privileges</button>
          <button class:on={f.mode === 'json'} onclick={() => { f.json = JSON.stringify(roleBody(), null, 2); f.mode = 'json' }}>JSON</button>
        </span>
      </div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-14)">
        <div><label class="es-label" for="es-r-name">Role name</label><input id="es-r-name" class="es-input mono" style="width:var(--px-300)" bind:value={f.name} disabled={!f.isNew} spellcheck="false" /></div>
        {#if f.mode === 'form'}
          <div>
            <span class="es-label">Cluster privileges</span>
            <div class="es-role-picks">
              {#each builtin.cluster as c (c)}<label class="es-role-pick" class:on={f.cluster.includes(c)}><input type="checkbox" checked={f.cluster.includes(c)} onchange={() => (f.cluster = togglePriv(f.cluster, c))} /> {c}</label>{/each}
            </div>
          </div>
          <div>
            <span class="es-label">Index privileges</span>
            {#each f.indices as ip, k (k)}
              <div class="es-card" style="padding:var(--px-10);margin-bottom:var(--px-8);box-shadow:none">
                <div class="es-toolbar" style="margin-bottom:var(--px-6)">
                  <input class="es-input mono" style="flex:1 1 auto" bind:value={ip.names} placeholder="Indices (comma separated, wildcards ok: logs-*)" aria-label="Indices {k + 1}" />
                  <button class="eg-btn" aria-label="Remove index privilege" onclick={() => (f.indices = f.indices.filter((_, j) => j !== k))}><EsIcon name="trash" size={13} /></button>
                </div>
                <div class="es-role-picks">
                  {#each builtin.index as p (p)}<label class="es-role-pick" class:on={ip.privileges.includes(p)}><input type="checkbox" checked={ip.privileges.includes(p)} onchange={() => (ip.privileges = togglePriv(ip.privileges, p))} /> {p}</label>{/each}
                </div>
              </div>
            {/each}
            <button class="eg-btn" onclick={() => (f.indices = [...f.indices, { names: '', privileges: ['read'] }])}><EsIcon name="plus" size={13} /> Add index privilege</button>
          </div>
          <div><label class="es-label" for="es-r-runas">Run as <span style="font-weight:400;color:var(--muted)">(users this role may impersonate)</span></label><input id="es-r-runas" class="es-input mono" style="width:100%" bind:value={f.runAs} /></div>
        {:else}
          <CodeView value={f.json} language={DS_JSON} height="auto" minHeight={240} maxHeight={520} onChange={(t) => (f.json = t)} ariaLabel="Role JSON" />
          <div class="es-help">Field- and document-level security (field_security, query) and application privileges go here.</div>
        {/if}
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (roleForm = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={saveRole} disabled={busy}>{f.isNew ? 'Create role' : 'Save role'}</button>
      </div>
    </div>
  </div>
{/if}

{#if keyForm}
  {@const k = keyForm}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label="Create API key" tabindex="-1" use:focusOnMount style="width:min(var(--px-560), 94vw)" onkeydown={(e) => e.key === 'Escape' && (keyForm = null)}>
      <div class="es-modal-h"><span class="es-card-title" style="font-size:var(--px-16)">Create API key</span></div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-12)">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:var(--px-10)">
          <div><label class="es-label" for="es-k-name">Name</label><input id="es-k-name" class="es-input" style="width:100%" bind:value={k.name} /></div>
          <div><label class="es-label" for="es-k-exp">Expires in</label><input id="es-k-exp" class="es-input mono" style="width:100%" bind:value={k.expiration} placeholder="30d (empty = never)" /></div>
        </div>
        <div>
          <span class="es-label">Restrict privileges <span style="font-weight:400;color:var(--muted)">(optional role descriptors — empty = the owner's privileges)</span></span>
          <CodeView value={k.descriptors} language={DS_JSON} height="auto" minHeight={120} maxHeight={300} onChange={(t) => (k.descriptors = t)} ariaLabel="Role descriptors" />
          <button class="eg-btn" style="margin-top:var(--px-6)" onclick={() => (k.descriptors = JSON.stringify({ read_only: { indices: [{ names: ['*'], privileges: ['read'] }] } }, null, 2))}>Read-only template</button>
        </div>
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (keyForm = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={createKey} disabled={busy || !k.name.trim()}>Create API key</button>
      </div>
    </div>
  </div>
{/if}

{#if mapForm}
  {@const mf = mapForm}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label="Role mapping" tabindex="-1" use:focusOnMount style="width:min(var(--px-640), 94vw)" onkeydown={(e) => e.key === 'Escape' && (mapForm = null)}>
      <div class="es-modal-h"><span class="es-card-title" style="font-size:var(--px-16)">{mf.isNew ? 'Create role mapping' : `Edit role mapping ${mf.name}`}</span></div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-12)">
        {#if mf.isNew}<div><label class="es-label" for="es-m-name">Name</label><input id="es-m-name" class="es-input mono" style="width:var(--px-300)" bind:value={mf.name} /></div>{/if}
        <CodeView value={mf.json} language={DS_JSON} height="auto" minHeight={200} maxHeight={480} onChange={(t) => (mf.json = t)} ariaLabel="Role mapping JSON" />
        {#if formError}<div class="es-callout danger" role="alert">{formError}</div>{/if}
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (mapForm = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={saveMapping} disabled={busy || !mf.name.trim()}>Save</button>
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
