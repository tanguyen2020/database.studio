<script lang="ts">
  // MongoDB User Manager (U5). Command-based (no SQL): usersInfo / createUser /
  // grantRolesToUser / revokeRolesFromUser / updateUser / dropUser. A user
  // belongs to an authentication database; roles are built-in role @ database.
  // Grant/revoke apply immediately (there is no SQL to preview); drop confirms.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import DropConfirm from './DropConfirm.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { mongoUserWizard } from '$lib/stores/mongouser.svelte'
  import { DB_BUILTIN_ROLES, hasRole, parseRolesCsv, type RoleRef } from '$lib/users/mongodb'
  import PrincipalHeader from './PrincipalHeader.svelte'
  import { CARD, CARD_TITLE, EXPLAINER } from './ui'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const cid = $derived(tab.connectionId)

  type Row = Record<string, unknown>
  let usersRows = $state<Row[]>([])
  let databases = $state<string[]>([])
  let loading = $state(false)
  let refreshing = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let selectedKey = $state<string>('')
  let gridDb = $state<string>('')
  let detailTab = $state<'roles' | 'access' | 'password'>('roles')

  // Plain-language capability of each built-in role (native Mongo RBAC model).
  const ROLE_DESC: Record<string, string> = {
    read: 'read all non-system collections',
    readWrite: 'read + write all non-system collections',
    dbAdmin: 'schema / index / stats admin (no data read by itself)',
    dbOwner: 'full control of the database (readWrite + dbAdmin + userAdmin)',
    userAdmin: 'create / modify users & roles on the database',
    readAnyDatabase: 'read every database (cluster-wide)',
    readWriteAnyDatabase: 'read + write every database (cluster-wide)',
    dbAdminAnyDatabase: 'dbAdmin on every database (cluster-wide)',
    userAdminAnyDatabase: 'manage users on every database (cluster-wide)',
    clusterAdmin: 'full cluster administration',
    root: 'superuser — full access to everything',
  }

  const keyOf = (u: Row) => `${u.user}@${u.db}`

  async function load() {
    if (!cid) return
    loading = true
    error = null
    try {
      const [u, dbs] = await Promise.all([ipc.mongoUsers(cid), ipc.listDatabases(cid).catch(() => [])])
      usersRows = u.rows
      databases = dbs.map((d) => d.name)
      if (!gridDb) gridDb = tab.systemType === 'mongodb' ? (databases[0] ?? 'admin') : 'admin'
      if (!selectedKey || !usersRows.some((x) => keyOf(x) === selectedKey)) {
        const focus = (tab.state as { focus?: string }).focus
        selectedKey = focus && usersRows.some((x) => keyOf(x) === focus) ? focus : usersRows[0] ? keyOf(usersRows[0]) : ''
      }
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  async function refresh() {
    if (refreshing) return
    refreshing = true
    try {
      await load()
    } finally {
      refreshing = false
    }
  }

  $effect(() => {
    void cid
    untrack(() => void load())
  })

  const selectedUser = $derived(usersRows.find((u) => keyOf(u) === selectedKey))
  const selName = $derived(selectedUser ? String(selectedUser.user) : '')
  const selDb = $derived(selectedUser ? String(selectedUser.db) : '')
  const selRoles = $derived.by<RoleRef[]>(() => (selectedUser ? parseRolesCsv(String(selectedUser.roles ?? '')) : []))

  // Access overview: group the user's roles by the database they apply to.
  const mongoAccess = $derived.by<{ db: string; roles: { role: string; desc: string }[] }[]>(() => {
    const map = new Map<string, { role: string; desc: string }[]>()
    for (const r of selRoles) {
      if (!map.has(r.db)) map.set(r.db, [])
      map.get(r.db)!.push({ role: r.role, desc: ROLE_DESC[r.role] ?? 'custom role' })
    }
    return [...map].map(([db, roles]) => ({ db, roles })).sort((a, b) => a.db.localeCompare(b.db))
  })

  // ---- Quick grant (friendly access levels → built-in roles, many databases) --
  // MongoDB grants ROLES (not privileges); map a familiar access level to the
  // matching built-in role and apply it across the selected databases at once.
  const QG_LEVELS = [
    { kind: 'read', label: 'Read-only', desc: 'read' },
    { kind: 'readWrite', label: 'Read-Write', desc: 'readWrite' },
    { kind: 'dbOwner', label: 'Admin', desc: 'dbOwner (full control of the database)' },
  ]
  let qgLevel = $state('read')
  let qgDbs = $state<Set<string>>(new Set())
  function toggleQgDb(db: string) {
    const next = new Set(qgDbs)
    next.has(db) ? next.delete(db) : next.add(db)
    qgDbs = next
  }
  async function quickGrant() {
    if (!cid || !selectedUser || busy || !qgDbs.size) return
    busy = true
    try {
      for (const db of qgDbs) await ipc.mongoGrantRoles(cid, selDb, selName, [{ role: qgLevel, db }])
      toasts.success(`Granted ${qgLevel} on ${qgDbs.size} database(s)`, 'mongodb')
      qgDbs = new Set()
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      busy = false
    }
  }

  async function toggleRole(role: string, db: string, on: boolean) {
    if (!cid || !selectedUser || busy) return
    busy = true
    try {
      const ref = [{ role, db }]
      if (on) await ipc.mongoGrantRoles(cid, selDb, selName, ref)
      else await ipc.mongoRevokeRoles(cid, selDb, selName, ref)
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      busy = false
    }
  }

  // ---- password -------------------------------------------------------------
  let newPassword = $state('')
  async function changePassword() {
    if (!cid || !selectedUser || !newPassword || busy) return
    busy = true
    try {
      await ipc.mongoChangePassword(cid, selDb, selName, newPassword)
      toasts.success('Password changed', 'mongodb')
      newPassword = ''
    } catch (e) {
      toasts.error(String(e))
    } finally {
      busy = false
    }
  }


  // Quick drop from the list (context menu / row button).
  let dropTarget = $state<{ user: string; db: string } | null>(null)
  let dropping = $state(false)
  async function doDrop() {
    if (!cid || !dropTarget || dropping) return
    dropping = true
    try {
      await ipc.mongoDropUser(cid, dropTarget.db, dropTarget.user)
      toasts.success(`User ${dropTarget.user} dropped`, 'mongodb')
      dropTarget = null
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      dropping = false
    }
  }
</script>

<div class="mono" style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-12);font-weight:700">Users</span>
    <span style="font-size:var(--px-11);color:var(--muted)">{usersRows.length} users</span>
    <span onclick={() => cid && mongoUserWizard.show(cid, gridDb || 'admin')} onkeydown={(e) => e.key === 'Enter' && cid && mongoUserWizard.show(cid, gridDb || 'admin')} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">+ Add User</span>
    <span onclick={refresh} onkeydown={(e) => e.key === 'Enter' && refresh()} role="button" tabindex="0" aria-busy={refreshing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}">{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span>
  </div>

  <!-- Engine model explainer — MongoDB's auth-database + roles-per-database RBAC. -->
  <div style={EXPLAINER}>A MongoDB user belongs to an <b style="color:var(--text2)">authentication database</b> and is granted <b style="color:var(--text2)">roles per database</b> — built-in ones like <span class="mono" style="color:var(--text)">read</span>, <span class="mono" style="color:var(--text)">readWrite</span>, <span class="mono" style="color:var(--text)">dbOwner</span>, or custom roles. Roles on the <span class="mono" style="color:var(--text)">admin</span> database (e.g. root) apply cluster-wide.</div>

  <div style="flex:1;display:flex;min-height:0">
    <div role="listbox" tabindex="-1" aria-label="Users" style="flex:none;width:var(--px-240);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
      {#if error}<div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else if loading}<div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
      {:else}
        {#each usersRows as u (keyOf(u))}
          {@const k = keyOf(u)}
          {@const sel = selectedKey === k}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <div onclick={() => (selectedKey = k)} onkeydown={(e) => e.key === 'Enter' && (selectedKey = k)} role="option" tabindex="0" aria-selected={sel} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{sel ? 'var(--grid-select)' : 'transparent'};color:{sel ? 'var(--hex-fff)' : 'var(--text)'}">
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis"><span style="font-weight:600">{u.user}</span><span style="opacity:0.65">@{u.db}</span></span>
                <span onclick={(e) => { e.stopPropagation(); dropTarget = { user: String(u.user), db: String(u.db) } }} onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); dropTarget = { user: String(u.user), db: String(u.db) } } }} role="button" tabindex="0" title="Drop user" style="opacity:0.75;color:{sel ? 'var(--hex-fff)' : 'var(--error)'};font-size:var(--px-13);line-height:1;cursor:pointer">🗑</span>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content>
              <ContextMenu.Item onclick={() => (selectedKey = k)}>Select</ContextMenu.Item>
              <ContextMenu.Item onclick={() => (dropTarget = { user: String(u.user), db: String(u.db) })}>Drop user…</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      {/if}
    </div>

    <div style="flex:1;display:flex;flex-direction:column;min-height:0">
      {#if selectedUser}
        <div style="flex:none;display:flex;gap:var(--px-2);padding:var(--px-8) var(--px-12) 0;border-bottom:var(--px-1) solid var(--border)">
          {#each [['roles', 'Roles per Database'], ['access', 'Access'], ['password', 'Password']] as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} style="padding:var(--px-6) var(--px-12);font-size:var(--px-12);cursor:pointer;font-weight:600;border-bottom:var(--px-2) solid {detailTab === k ? 'var(--primary)' : 'transparent'};color:{detailTab === k ? 'var(--text)' : 'var(--muted)'}">{label}</span>
          {/each}
        </div>
        <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
          <PrincipalHeader name={`${selName}@${selDb}`} subtitle="Database user" />
          {#if detailTab === 'roles'}
            <!-- Quick grant: friendly access level → built-in role, many databases -->
            <div style={CARD}>
              <div style={CARD_TITLE}>＋ Grant access</div>
              <div style="display:flex;flex-direction:column;gap:var(--px-6)">
                <div style="display:flex;gap:var(--px-6);flex-wrap:wrap;align-items:center">
                  <span style="font-size:var(--px-11);color:var(--muted);width:var(--px-70)">Access level</span>
                  <div style="display:inline-flex;border:var(--px-1) solid var(--border2);border-radius:var(--px-7);overflow:hidden">
                    {#each QG_LEVELS as lv (lv.kind)}
                      <span onclick={() => (qgLevel = lv.kind)} onkeydown={(e) => e.key === 'Enter' && (qgLevel = lv.kind)} role="button" tabindex="0" title={lv.desc} style="font-size:var(--px-12);padding:var(--px-4) var(--px-12);cursor:pointer;font-weight:600;background:{qgLevel === lv.kind ? 'var(--primary)' : 'transparent'};color:{qgLevel === lv.kind ? 'var(--hex-fff)' : 'var(--text2)'}">{lv.label}</span>
                    {/each}
                  </div>
                  <span style="font-size:var(--px-10_5);color:var(--muted)">→ role <span class="mono">{qgLevel}</span></span>
                </div>
                <div style="display:flex;gap:var(--px-6);flex-wrap:wrap;align-items:flex-start">
                  <span style="font-size:var(--px-11);color:var(--muted);width:var(--px-70);margin-top:var(--px-3)">Databases</span>
                  <div style="display:flex;gap:var(--px-4) var(--px-12);flex-wrap:wrap;flex:1">
                    {#each databases as d (d)}
                      <label style="font-size:var(--px-12);color:var(--text);display:flex;align-items:center;gap:var(--px-4);cursor:pointer"><input type="checkbox" checked={qgDbs.has(d)} onchange={() => toggleQgDb(d)} /> {d}</label>
                    {/each}
                  </div>
                </div>
                <div style="display:flex;justify-content:flex-end">
                  <span onclick={quickGrant} onkeydown={(e) => e.key === 'Enter' && quickGrant()} role="button" tabindex="0" aria-disabled={!qgDbs.size || busy} style="font-size:var(--px-12);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-5) var(--px-14);cursor:{qgDbs.size && !busy ? 'pointer' : 'not-allowed'};opacity:{qgDbs.size && !busy ? 1 : 0.5};font-weight:600">Grant {qgLevel} on {qgDbs.size} db</span>
                </div>
              </div>
            </div>
            <div style={CARD}>
            <div style={CARD_TITLE}>Built-in roles</div>
            <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-bottom:var(--px-6)">Current roles</div>
            {#if selRoles.length}
              <div style="display:flex;flex-wrap:wrap;gap:var(--px-6);margin-bottom:var(--px-12)">
                {#each selRoles as r (r.role + '@' + r.db)}<span class="mono" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-10);padding:var(--px-2) var(--px-8)">{r.role}@{r.db}</span>{/each}
              </div>
            {:else}
              <div style="font-size:var(--px-11_5);color:var(--muted);margin-bottom:var(--px-12)">No roles.</div>
            {/if}
            <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-8)">
              <span style="font-size:var(--px-12);color:var(--text2);font-weight:600">Grant on database</span>
              <select bind:value={gridDb} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-6);color:var(--text);font-size:var(--px-12)">
                {#each databases as d (d)}<option value={d}>{d}</option>{/each}
              </select>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:var(--px-12)">
              {#each DB_BUILTIN_ROLES as role (role)}
                <label title={ROLE_DESC[role] ?? 'custom role'} style="font-size:var(--px-12);color:var(--text);display:flex;align-items:center;gap:var(--px-4);cursor:help">
                  <input type="checkbox" disabled={busy} checked={hasRole(selRoles, role, gridDb)} onchange={(e) => toggleRole(role, gridDb, (e.currentTarget as HTMLInputElement).checked)} /> {role}
                </label>
              {/each}
            </div>
            <div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">Toggling a role runs grantRolesToUser / revokeRolesFromUser immediately.</div>
            </div>
            <div style="margin-top:var(--px-16)">
              <span onclick={() => (dropTarget = { user: selName, db: selDb })} onkeydown={(e) => e.key === 'Enter' && (dropTarget = { user: selName, db: selDb })} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--error);border:var(--px-1) solid var(--error);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop user…</span>
            </div>
          {:else if detailTab === 'access'}
            <!-- Access overview: what this user can access, per database (via roles) -->
            <div style={CARD}>
            <div style={CARD_TITLE}>Access by database</div>
            <div style="font-size:var(--px-12);color:var(--text2);margin-bottom:var(--px-10)">What <span class="mono" style="color:var(--text);font-weight:600">{selName}@{selDb}</span> can access, per database (through its roles).</div>
            {#if mongoAccess.length}
              <div style="display:flex;flex-direction:column;gap:var(--px-8)">
                {#each mongoAccess as d (d.db)}
                  <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden">
                    <div style="padding:var(--px-5) var(--px-10);background:var(--panel);border-bottom:var(--px-1) solid var(--border);font-size:var(--px-12_5);font-weight:700;color:var(--text)">
                      <span class="mono">{d.db === 'admin' ? 'admin (cluster / any-database roles live here)' : d.db}</span>
                    </div>
                    <div style="padding:var(--px-6) var(--px-10);display:flex;flex-direction:column;gap:var(--px-3)">
                      {#each d.roles as r (r.role)}
                        <div style="display:flex;align-items:baseline;gap:var(--px-8)">
                          <span style="font-size:var(--px-11);color:var(--syntax-type);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-6);min-width:var(--px-110)">{r.role}</span>
                          <span style="font-size:var(--px-11);color:var(--text2)">{r.desc}</span>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div style="font-size:var(--px-11_5);color:var(--muted)">No roles — this user cannot access any database yet.</div>
            {/if}
            <div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">MongoDB access is role-based per database; *AnyDatabase / root / clusterAdmin roles on the admin database apply cluster-wide.</div>
            </div>
          {:else}
            <div style={CARD}>
            <div style={CARD_TITLE}>Password</div>
            <div style="display:flex;gap:var(--px-6);align-items:flex-end">
              <label style="font-size:var(--px-12);color:var(--text2)">New password
                <input type="password" bind:value={newPassword} class="mono" style="display:block;margin-top:var(--px-4);width:var(--px-220);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
              </label>
              <span onclick={changePassword} onkeydown={(e) => e.key === 'Enter' && changePassword()} role="button" tabindex="0" aria-disabled={!newPassword || busy} style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:{newPassword && !busy ? 'pointer' : 'not-allowed'};opacity:{newPassword && !busy ? 1 : 0.5};font-weight:600">Change</span>
            </div>
            </div>
          {/if}
        </div>
      {:else if !loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Select a user.</div>
      {/if}
    </div>
  </div>
</div>

{#if dropTarget}
  <DropConfirm name={`${dropTarget.user}@${dropTarget.db}`} kind="user" busy={dropping} oncancel={() => (dropTarget = null)} onconfirm={doDrop} />
{/if}
