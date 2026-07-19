<script lang="ts">
  // Oracle User Manager (U6). Users + Roles; per-object privileges (Oracle has
  // no GRANT ON SCHEMA — presets batch over the owner's objects). Tabs: General
  // (password/lock/expire/quota/drop CASCADE) · System Privileges (checklist) ·
  // Roles (grant/revoke + default role) · Object Privileges (per-schema presets).
  // Mutations queue → Execute (Oracle DDL autocommits; runs sequentially).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { oraUserWizard } from '$lib/stores/orauser.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import {
    alterPassword,
    createRole,
    defaultRoleAll,
    dropUser,
    expirePassword,
    grantRole,
    grantSysPrivs,
    lockAccount,
    revokeRole,
    revokeSysPrivs,
    schemaPreset,
    type PresetKind,
  } from '$lib/users/oracle'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const cid = $derived(tab.connectionId)

  type Row = Record<string, unknown>
  let users = $state<Row[]>([])
  let roles = $state<Row[]>([])
  let rolePrivs = $state<Row[]>([])
  let sysPrivs = $state<Row[]>([])
  let tabPrivs = $state<Row[]>([])
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let selected = $state<string>('')
  let detailTab = $state<'general' | 'sys' | 'roles' | 'objects' | 'access' | 'quotas'>('general')
  let quotas = $state<Row[]>([])
  let pending = $state<string[]>([])
  let executing = $state(false)

  const SYS_PRIVS = [
    'CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE PROCEDURE', 'CREATE SEQUENCE',
    'CREATE TRIGGER', 'CREATE SYNONYM', 'UNLIMITED TABLESPACE', 'SELECT ANY TABLE', 'CREATE ANY TABLE',
  ]

  async function load() {
    if (!cid) return
    loading = true
    error = null
    try {
      const [u, r] = await Promise.all([ipc.usersView(cid, 'users'), ipc.usersView(cid, 'roles').catch(() => ({ rows: [] as Row[] }))])
      users = u.rows
      roles = r.rows
      if (!selected || !users.some((x) => String(x.name) === selected)) {
        const focus = (tab.state as { focus?: string }).focus
        selected = focus && users.some((x) => String(x.name) === focus) ? focus : String(users[0]?.name ?? '')
      }
      await loadPrivs()
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  async function loadPrivs() {
    if (!cid || !selected) return
    const [rp, sp, qt, tp] = await Promise.all([
      ipc.usersView(cid, 'role_privs', selected).catch(() => ({ rows: [] as Row[] })),
      ipc.usersView(cid, 'sys_privs', selected).catch(() => ({ rows: [] as Row[] })),
      ipc.usersView(cid, 'quotas').catch(() => ({ rows: [] as Row[] })),
      ipc.usersView(cid, 'tab_privs', selected).catch(() => ({ rows: [] as Row[] })),
    ])
    rolePrivs = rp.rows
    sysPrivs = sp.rows
    quotas = qt.rows
    tabPrivs = tp.rows
  }

  // Access overview: object privileges grouped by owner (schema) → object.
  // (Oracle: a schema is a user's namespace; object privs are OWNER.OBJECT.)
  const objectAccess = $derived.by<{ owner: string; objects: { object: string; privs: string[] }[] }[]>(() => {
    const byOwner = new Map<string, Map<string, Set<string>>>()
    for (const g of tabPrivs) {
      const owner = String(g.owner ?? '')
      const object = String(g.object ?? '')
      const priv = String(g.privilege ?? '')
      if (!owner || !object || !priv) continue
      if (!byOwner.has(owner)) byOwner.set(owner, new Map())
      const objs = byOwner.get(owner)!
      if (!objs.has(object)) objs.set(object, new Set())
      objs.get(object)!.add(priv)
    }
    return [...byOwner]
      .map(([owner, objs]) => ({
        owner,
        objects: [...objs].map(([object, s]) => ({ object, privs: [...s].sort() })).sort((a, b) => a.object.localeCompare(b.object)),
      }))
      .sort((a, b) => a.owner.localeCompare(b.owner))
  })

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
  $effect(() => {
    void selected
    untrack(() => void loadPrivs())
  })

  const selectedUser = $derived(users.find((u) => String(u.name) === selected))
  const grantedRoles = $derived(rolePrivs.map((r) => String(r.role)))
  const grantedSys = $derived(new Set(sysPrivs.map((s) => String(s.privilege))))

  // ---- General --------------------------------------------------------------
  let newPassword = $state('')
  function queuePassword() {
    if (!selected || !newPassword) return
    pending = [...pending, alterPassword(selected, newPassword)]
    newPassword = ''
  }
  function queueLock(locked: boolean) {
    if (selected) pending = [...pending, lockAccount(selected, locked)]
  }
  function queueExpire() {
    if (selected) pending = [...pending, expirePassword(selected)]
  }
  let dropCascade = $state(true)
  let confirmDrop = $state(false)
  function queueDrop() {
    if (selected) pending = [...pending, dropUser(selected, dropCascade)]
    confirmDrop = false
  }

  // ---- System privileges ----------------------------------------------------
  function toggleSys(priv: string, on: boolean) {
    if (!selected) return
    pending = [...pending, on ? grantSysPrivs([priv], selected) : revokeSysPrivs([priv], selected)]
  }

  // ---- Roles ----------------------------------------------------------------
  let grantRoleName = $state('')
  function queueGrantRole() {
    if (!selected || !grantRoleName) return
    pending = [...pending, grantRole(grantRoleName, selected)]
    grantRoleName = ''
  }
  function queueRevokeRole(role: string) {
    if (selected) pending = [...pending, revokeRole(role, selected)]
  }
  function queueDefaultRoleAll() {
    if (selected) pending = [...pending, defaultRoleAll(selected)]
  }

  // ---- Object privileges grid (per owner) -----------------------------------
  const owners = $derived(users.map((u) => String(u.name)))
  let gridOwner = $state('')
  let objCount = $state<number | null>(null)
  async function applyObjPreset(kind: PresetKind) {
    if (!cid || !selected || !gridOwner) return
    const tables = await ipc.listTables(cid, gridOwner).catch(() => [])
    const objs = tables.filter((t) => t.kind === 'table' || t.kind === 'view').map((t) => t.name)
    objCount = objs.length
    const stmts = schemaPreset(kind, gridOwner, selected, objs)
    if (stmts.length) pending = [...pending, ...stmts]
  }

  // ---- Execute --------------------------------------------------------------
  async function execute() {
    if (!cid || !pending.length || executing) return
    executing = true
    try {
      for (const sql of pending) {
        const res = await ipc.execStatement(cid, sql, 0)
        if (!res.ok) {
          toasts.error(res.error?.message ?? 'error')
          break
        }
      }
      toasts.success('Applied', 'oracle')
      pending = []
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      executing = false
    }
  }
  const discard = () => (pending = [])
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-12);font-weight:700">Users</span>
    <span style="font-size:var(--px-11);color:var(--muted)">{users.length} users</span>
    <span onclick={() => cid && oraUserWizard.show(cid)} onkeydown={(e) => e.key === 'Enter' && cid && oraUserWizard.show(cid)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">+ Create User</span>
    <span onclick={refresh} onkeydown={(e) => e.key === 'Enter' && refresh()} role="button" tabindex="0" aria-busy={refreshing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}">{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span>
  </div>

  <div style="flex:1;display:flex;min-height:0">
    <div role="listbox" tabindex="-1" aria-label="Users" style="flex:none;width:var(--px-240);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
      {#if error}<div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else if loading}<div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
      {:else}
        {#each users as u (u.name)}
          <div onclick={() => (selected = String(u.name))} onkeydown={(e) => e.key === 'Enter' && (selected = String(u.name))} role="option" tabindex="0" aria-selected={selected === String(u.name)} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{selected === String(u.name) ? 'var(--grid-select)' : 'transparent'};color:{selected === String(u.name) ? 'var(--hex-fff)' : 'var(--text)'}">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis">{u.name}</span>
            {#if String(u.status) !== 'OPEN'}<span style="font-size:var(--px-9);color:{selected === String(u.name) ? 'var(--hex-fff)' : 'var(--warn2)'}">{u.status}</span>{/if}
          </div>
        {/each}
      {/if}
    </div>

    <div style="flex:1;display:flex;flex-direction:column;min-height:0">
      {#if selectedUser}
        <div style="flex:none;display:flex;gap:var(--px-2);padding:var(--px-8) var(--px-12) 0;border-bottom:var(--px-1) solid var(--border)">
          {#each [['general', 'General'], ['sys', 'System Privileges'], ['roles', 'Granted Roles'], ['objects', 'Object Privileges'], ['access', 'Access'], ['quotas', 'Quotas']] as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} style="padding:var(--px-6) var(--px-12);font-size:var(--px-12);cursor:pointer;font-weight:600;border-bottom:var(--px-2) solid {detailTab === k ? 'var(--primary)' : 'transparent'};color:{detailTab === k ? 'var(--text)' : 'var(--muted)'}">{label}</span>
          {/each}
        </div>
        <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
          {#if detailTab === 'general'}
            <table class="mono" style="border-collapse:collapse;font-size:var(--px-12);margin-bottom:var(--px-14)">
              <tbody>
                {#each [['Name', selectedUser.name], ['Status', selectedUser.status], ['Tablespace', selectedUser.tablespace], ['Profile', selectedUser.profile], ['Created', selectedUser.created], ['Expires', selectedUser.expires]] as [k, v] (k)}
                  <tr><td style="padding:var(--px-3) var(--px-14) var(--px-3) 0;color:var(--text2);white-space:nowrap">{k}</td><td style="padding:var(--px-3) 0;color:var(--text)">{v}</td></tr>
                {/each}
              </tbody>
            </table>
            <div style="display:flex;gap:var(--px-6);align-items:flex-end;margin-bottom:var(--px-10)">
              <label style="font-size:var(--px-12);color:var(--text2)">Change password
                <input type="password" bind:value={newPassword} class="mono" style="display:block;margin-top:var(--px-4);width:var(--px-220);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
              </label>
              <span onclick={queuePassword} onkeydown={(e) => e.key === 'Enter' && queuePassword()} role="button" tabindex="0" aria-disabled={!newPassword} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:{newPassword ? 'pointer' : 'not-allowed'};opacity:{newPassword ? 1 : 0.5}">Queue change</span>
            </div>
            <div style="display:flex;gap:var(--px-8);margin-bottom:var(--px-12);flex-wrap:wrap">
              <span onclick={() => queueLock(true)} onkeydown={(e) => e.key === 'Enter' && queueLock(true)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue lock</span>
              <span onclick={() => queueLock(false)} onkeydown={(e) => e.key === 'Enter' && queueLock(false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue unlock</span>
              <span onclick={queueExpire} onkeydown={(e) => e.key === 'Enter' && queueExpire()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue expire password</span>
            </div>
            {#if confirmDrop}
              <div style="display:flex;gap:var(--px-8);align-items:center;padding:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--error);border-radius:var(--px-6);flex-wrap:wrap">
                <span style="font-size:var(--px-12);color:var(--error)">Drop user “{selected}”?</span>
                <label style="font-size:var(--px-11_5);color:var(--error);display:flex;align-items:center;gap:var(--px-4)"><input type="checkbox" bind:checked={dropCascade} /> CASCADE (drops all schema objects)</label>
                <span onclick={queueDrop} onkeydown={(e) => e.key === 'Enter' && queueDrop()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue drop</span>
                <span onclick={() => (confirmDrop = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Cancel</span>
              </div>
            {:else}
              <span onclick={() => (confirmDrop = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = true)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--error);border:var(--px-1) solid var(--error);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop user…</span>
            {/if}
          {:else if detailTab === 'sys'}
            <div style="display:flex;flex-wrap:wrap;gap:var(--px-10)">
              {#each SYS_PRIVS as p (p)}
                <label style="font-size:var(--px-11_5);color:var(--text);display:flex;align-items:center;gap:var(--px-4)">
                  <input type="checkbox" checked={grantedSys.has(p)} onchange={(e) => toggleSys(p, (e.currentTarget as HTMLInputElement).checked)} /> {p}
                </label>
              {/each}
            </div>
          {:else if detailTab === 'roles'}
            <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-bottom:var(--px-6)">Granted roles</div>
            {#if grantedRoles.length}
              {#each rolePrivs as r (r.role)}
                <div style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-12);padding:var(--px-2) 0">
                  <span class="mono">{r.role}</span>
                  {#if String(r.admin_option) === 'YES'}<span style="font-size:var(--px-9);color:var(--muted)">ADMIN</span>{/if}
                  {#if String(r.default_role) === 'YES'}<span style="font-size:var(--px-9);color:var(--muted)">DEFAULT</span>{/if}
                  <span onclick={() => queueRevokeRole(String(r.role))} onkeydown={(e) => e.key === 'Enter' && queueRevokeRole(String(r.role))} role="button" tabindex="0" style="font-size:var(--px-10_5);color:var(--error);cursor:pointer">revoke</span>
                </div>
              {/each}
            {:else}
              <div style="font-size:var(--px-11_5);color:var(--muted)">No roles granted.</div>
            {/if}
            <div style="display:flex;gap:var(--px-6);align-items:center;margin-top:var(--px-10);flex-wrap:wrap">
              <select bind:value={grantRoleName} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text);font-size:var(--px-12)">
                <option value="">— grant role —</option>
                {#each roles.filter((r) => !grantedRoles.includes(String(r.name))) as r (r.name)}<option value={String(r.name)}>{r.name}</option>{/each}
              </select>
              <span onclick={queueGrantRole} onkeydown={(e) => e.key === 'Enter' && queueGrantRole()} role="button" tabindex="0" aria-disabled={!grantRoleName} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:{grantRoleName ? 'pointer' : 'not-allowed'};opacity:{grantRoleName ? 1 : 0.5}">Queue grant</span>
              <span onclick={queueDefaultRoleAll} onkeydown={(e) => e.key === 'Enter' && queueDefaultRoleAll()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Default role ALL</span>
            </div>
          {:else if detailTab === 'quotas'}
            <div style="font-size:var(--px-11);color:var(--muted);margin-bottom:var(--px-8)">Tablespace quotas for {selected} (set new quotas in the Create/General flow).</div>
            {#each [quotas.filter((q) => String(q.name) === selected)] as list (0)}
              {#if list.length}
                <table class="mono" style="border-collapse:collapse;font-size:var(--px-12)">
                  <thead><tr><th style="text-align:left;padding:var(--px-4) var(--px-14) var(--px-4) 0;color:var(--text2);border-bottom:var(--px-1) solid var(--border2)">Tablespace</th><th style="text-align:left;padding:var(--px-4) 0;color:var(--text2);border-bottom:var(--px-1) solid var(--border2)">Quota</th></tr></thead>
                  <tbody>
                    {#each list as q (q.tablespace)}
                      <tr><td style="padding:var(--px-3) var(--px-14) var(--px-3) 0;color:var(--text)">{q.tablespace}</td><td style="padding:var(--px-3) 0;color:var(--text)">{q.quota}</td></tr>
                    {/each}
                  </tbody>
                </table>
              {:else}
                <div style="font-size:var(--px-11_5);color:var(--muted)">No tablespace quotas.</div>
              {/if}
            {/each}
          {:else if detailTab === 'objects'}
            <!-- Object privileges — per owner, batched (Oracle has no GRANT ON SCHEMA) -->
            <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-8);flex-wrap:wrap">
              <span style="font-size:var(--px-12);color:var(--text2)">Grant on all objects owned by</span>
              <select bind:value={gridOwner} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-6);color:var(--text);font-size:var(--px-12)">
                <option value="">— schema —</option>
                {#each owners as o (o)}<option value={o}>{o}</option>{/each}
              </select>
            </div>
            <div style="display:flex;gap:var(--px-6);flex-wrap:wrap">
              {#each [['read-only', 'Read-only'], ['read-write', 'Read-write'], ['read-write-execute', 'Read-write + Execute'], ['revoke-all', 'Revoke all']] as [kind, label] (kind)}
                <span onclick={() => applyObjPreset(kind as PresetKind)} onkeydown={(e) => e.key === 'Enter' && applyObjPreset(kind as PresetKind)} role="button" tabindex="0" aria-disabled={!gridOwner} style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:{gridOwner ? 'pointer' : 'not-allowed'};opacity:{gridOwner ? 1 : 0.5};color:{kind === 'revoke-all' ? 'var(--error)' : 'var(--text2)'}">{label}</span>
              {/each}
            </div>
            {#if objCount != null}<div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">Last preset built statements for {objCount} object(s). Oracle grants per-object — objects created later are not covered.</div>{/if}
          {:else}
            <!-- Access overview: system privs + roles + object privs by owner -->
            <div style="font-size:var(--px-12);color:var(--text2);margin-bottom:var(--px-10)">What <span class="mono" style="color:var(--text);font-weight:600">{selected}</span> can access — system privileges, roles, and object privileges by schema.</div>
            <!-- system privileges -->
            <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden;margin-bottom:var(--px-8)">
              <div style="padding:var(--px-5) var(--px-10);background:var(--panel);border-bottom:var(--px-1) solid var(--border);font-size:var(--px-12_5);font-weight:700;color:var(--text)">System privileges</div>
              <div style="padding:var(--px-6) var(--px-10);display:flex;gap:var(--px-4);flex-wrap:wrap">
                {#if grantedSys.size}{#each [...grantedSys] as p (p)}<span style="font-size:var(--px-10);color:var(--syntax-keyword);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-5)">{p}</span>{/each}{:else}<span style="font-size:var(--px-11);color:var(--muted)">— none</span>{/if}
              </div>
            </div>
            <!-- roles -->
            <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden;margin-bottom:var(--px-8)">
              <div style="padding:var(--px-5) var(--px-10);background:var(--panel);border-bottom:var(--px-1) solid var(--border);font-size:var(--px-12_5);font-weight:700;color:var(--text)">Roles</div>
              <div style="padding:var(--px-6) var(--px-10);display:flex;gap:var(--px-4);flex-wrap:wrap">
                {#if grantedRoles.length}{#each grantedRoles as r (r)}<span style="font-size:var(--px-10);color:var(--syntax-type);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-5)">{r}</span>{/each}{:else}<span style="font-size:var(--px-11);color:var(--muted)">— none</span>{/if}
              </div>
            </div>
            <!-- object privileges grouped by owner schema -->
            <div style="font-size:var(--px-11_5);color:var(--text2);font-weight:600;margin-bottom:var(--px-6)">Object privileges (by schema)</div>
            {#if objectAccess.length}
              <div style="display:flex;flex-direction:column;gap:var(--px-8)">
                {#each objectAccess as o (o.owner)}
                  <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden">
                    <div style="padding:var(--px-5) var(--px-10);background:var(--panel);border-bottom:var(--px-1) solid var(--border);font-size:var(--px-12_5);font-weight:700;color:var(--text)"><span class="mono">{o.owner}</span> <span style="font-size:var(--px-10);color:var(--muted)">schema</span></div>
                    <div style="padding:var(--px-6) var(--px-10);display:flex;flex-direction:column;gap:var(--px-3)">
                      {#each o.objects as ob (ob.object)}
                        <div style="display:flex;align-items:baseline;gap:var(--px-8);flex-wrap:wrap">
                          <span class="mono" style="font-size:var(--px-11);color:var(--text);min-width:var(--px-110)">{ob.object}</span>
                          <div style="display:flex;gap:var(--px-4);flex-wrap:wrap">
                            {#each ob.privs as p (p)}<span style="font-size:var(--px-10);color:var(--syntax-number);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-5)">{p}</span>{/each}
                          </div>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div style="font-size:var(--px-11_5);color:var(--muted)">No object privileges granted.</div>
            {/if}
            <div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">Oracle has no database concept like Postgres — a schema is a user's object namespace; object privileges are on OWNER.OBJECT. Role-inherited object privileges may not all appear (this lists directly-granted object privileges).</div>
          {/if}
        </div>
      {:else if !loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Select a user.</div>
      {/if}

      {#if pending.length}
        <div style="flex:none;border-top:var(--px-1) solid var(--border);background:var(--panel);padding:var(--px-10) var(--px-14);max-height:var(--px-220);overflow:auto">
          <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-6)">
            <span style="font-size:var(--px-11_5);font-weight:700;color:var(--text2)">Pending changes ({pending.length})</span>
            <span onclick={execute} onkeydown={(e) => e.key === 'Enter' && execute()} role="button" tabindex="0" aria-disabled={executing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer;font-weight:600;opacity:{executing ? 0.6 : 1}">{executing ? 'Executing…' : 'Execute'}</span>
            <span onclick={discard} onkeydown={(e) => e.key === 'Enter' && discard()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer">Discard</span>
          </div>
          <pre class="selectable mono" style="margin:0;font-size:var(--px-11);white-space:pre-wrap;color:var(--text2)">{#each pending as s (s)}{#each highlightSql(s + ';\n') as tk (tk)}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}{/each}</pre>
        </div>
      {/if}
    </div>
  </div>
</div>
