<script lang="ts">
  // MongoDB User Manager (U5). Command-based (no SQL): usersInfo / createUser /
  // grantRolesToUser / revokeRolesFromUser / updateUser / dropUser. A user
  // belongs to an authentication database; roles are built-in role @ database.
  // Grant/revoke apply immediately (there is no SQL to preview); drop confirms.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { mongoUserWizard } from '$lib/stores/mongouser.svelte'
  import { DB_BUILTIN_ROLES, hasRole, parseRolesCsv, type RoleRef } from '$lib/users/mongodb'
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
  let detailTab = $state<'roles' | 'password'>('roles')

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

  // ---- drop (confirm) -------------------------------------------------------
  let confirmDrop = $state(false)
  async function dropUser() {
    if (!cid || !selectedUser || busy) return
    busy = true
    try {
      await ipc.mongoDropUser(cid, selDb, selName)
      toasts.success(`User ${selName} dropped`, 'mongodb')
      confirmDrop = false
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      busy = false
    }
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-12);font-weight:700">Users</span>
    <span style="font-size:var(--px-11);color:var(--muted)">{usersRows.length} users</span>
    <span onclick={() => cid && mongoUserWizard.show(cid, gridDb || 'admin')} onkeydown={(e) => e.key === 'Enter' && cid && mongoUserWizard.show(cid, gridDb || 'admin')} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">+ Add User</span>
    <span onclick={refresh} onkeydown={(e) => e.key === 'Enter' && refresh()} role="button" tabindex="0" aria-busy={refreshing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}">{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span>
  </div>

  <div style="flex:1;display:flex;min-height:0">
    <div role="listbox" tabindex="-1" aria-label="Users" style="flex:none;width:var(--px-240);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
      {#if error}<div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else if loading}<div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
      {:else}
        {#each usersRows as u (keyOf(u))}
          <div onclick={() => (selectedKey = keyOf(u))} onkeydown={(e) => e.key === 'Enter' && (selectedKey = keyOf(u))} role="option" tabindex="0" aria-selected={selectedKey === keyOf(u)} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{selectedKey === keyOf(u) ? 'var(--grid-select)' : 'transparent'};color:{selectedKey === keyOf(u) ? 'var(--hex-fff)' : 'var(--text)'}">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis"><span style="font-weight:600">{u.user}</span><span style="opacity:0.65">@{u.db}</span></span>
          </div>
        {/each}
      {/if}
    </div>

    <div style="flex:1;display:flex;flex-direction:column;min-height:0">
      {#if selectedUser}
        <div style="flex:none;display:flex;gap:var(--px-2);padding:var(--px-8) var(--px-12) 0;border-bottom:var(--px-1) solid var(--border)">
          {#each [['roles', 'Roles per Database'], ['password', 'Password']] as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} style="padding:var(--px-6) var(--px-12);font-size:var(--px-12);cursor:pointer;font-weight:600;border-bottom:var(--px-2) solid {detailTab === k ? 'var(--primary)' : 'transparent'};color:{detailTab === k ? 'var(--text)' : 'var(--muted)'}">{label}</span>
          {/each}
        </div>
        <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
          {#if detailTab === 'roles'}
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
                <label style="font-size:var(--px-12);color:var(--text);display:flex;align-items:center;gap:var(--px-4)">
                  <input type="checkbox" disabled={busy} checked={hasRole(selRoles, role, gridDb)} onchange={(e) => toggleRole(role, gridDb, (e.currentTarget as HTMLInputElement).checked)} /> {role}
                </label>
              {/each}
            </div>
            <div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">Toggling a role runs grantRolesToUser / revokeRolesFromUser immediately.</div>
            <div style="margin-top:var(--px-16)">
              {#if confirmDrop}
                <div style="display:flex;gap:var(--px-8);align-items:center;padding:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--error);border-radius:var(--px-6)">
                  <span style="font-size:var(--px-12);color:var(--error)">Drop user “{selName}@{selDb}”?</span>
                  <span onclick={dropUser} onkeydown={(e) => e.key === 'Enter' && dropUser()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop</span>
                  <span onclick={() => (confirmDrop = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Cancel</span>
                </div>
              {:else}
                <span onclick={() => (confirmDrop = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = true)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--error);border:var(--px-1) solid var(--error);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop user…</span>
              {/if}
            </div>
          {:else}
            <div style="display:flex;gap:var(--px-6);align-items:flex-end">
              <label style="font-size:var(--px-12);color:var(--text2)">New password
                <input type="password" bind:value={newPassword} class="mono" style="display:block;margin-top:var(--px-4);width:var(--px-220);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
              </label>
              <span onclick={changePassword} onkeydown={(e) => e.key === 'Enter' && changePassword()} role="button" tabindex="0" aria-disabled={!newPassword || busy} style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:{newPassword && !busy ? 'pointer' : 'not-allowed'};opacity:{newPassword && !busy ? 1 : 0.5};font-weight:600">Change</span>
            </div>
          {/if}
        </div>
      {:else if !loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Select a user.</div>
      {/if}
    </div>
  </div>
</div>
