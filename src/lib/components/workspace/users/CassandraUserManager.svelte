<script lang="ts">
  // Cassandra User Manager (U7). One principal type = role (LOGIN = a user).
  // Everything runs via cql_exec: LIST ROLES / LIST ALL PERMISSIONS OF /
  // CREATE|ALTER|DROP ROLE / GRANT|REVOKE. Requires PasswordAuthenticator +
  // CassandraAuthorizer (banner otherwise). Tabs: General, Member of, Permissions.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { cassUserWizard } from '$lib/stores/cassuser.svelte'
  import { grantWizard, STANDARD_LEVELS } from '$lib/stores/grantwizard.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import {
    alterRole,
    CASS_GRID_COLUMNS,
    dropRole,
    grantColumn,
    grantRole,
    keyspacePreset,
    revokeColumn,
    revokeRole,
    type PresetKind,
  } from '$lib/users/cassandra'
  import PrivilegeGrid from './PrivilegeGrid.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const cid = $derived(tab.connectionId)

  type Row = Record<string, unknown>
  let roles = $state<Row[]>([])
  let perms = $state<Row[]>([])
  let keyspaces = $state<string[]>([])
  let gateOk = $state(true)
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let selected = $state<string>('')
  let detailTab = $state<'general' | 'members' | 'perms'>('general')
  let pending = $state<string[]>([])
  let executing = $state(false)

  const boolY = (v: unknown) => v === true || v === 'true' || v === 1

  async function load() {
    if (!cid) return
    loading = true
    error = null
    try {
      const res = await ipc.cqlExec(cid, 'LIST ROLES')
      if (!res.ok) {
        gateOk = false
        roles = []
        return
      }
      gateOk = true
      roles = res.result?.rows ?? []
      const sc = await ipc.listSchemas(cid).catch(() => [])
      keyspaces = sc.map((s) => s.name)
      if (!selected || !roles.some((r) => String(r.role) === selected)) {
        const focus = (tab.state as { focus?: string }).focus
        selected = focus && roles.some((r) => String(r.role) === focus) ? focus : String(roles[0]?.role ?? '')
      }
      await loadPerms()
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  async function loadPerms() {
    if (!cid || !selected) return
    const res = await ipc.cqlExec(cid, `LIST ALL PERMISSIONS OF ${cqlName(selected)}`).catch(() => null)
    perms = res?.ok ? (res.result?.rows ?? []) : []
  }

  function cqlName(name: string): string {
    return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
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
  $effect(() => {
    void selected
    untrack(() => void loadPerms())
  })

  const selectedRole = $derived(roles.find((r) => String(r.role) === selected))

  // ---- Permissions grid (per keyspace — full columns, clickable) ------------
  // LIST ALL PERMISSIONS OF returns EFFECTIVE permissions (direct + inherited);
  // Cassandra has no reliable way to split them here, so a present permission is
  // shown as ✓ (direct) — clicking still emits a keyspace-scoped GRANT/REVOKE.
  type CellState = 'none' | 'direct' | 'partial' | 'inherited' | 'deny'
  function hasPerm(keyspace: string, perm: string): boolean {
    return perms.some((p) => {
      const res = String(p.resource ?? '')
      const pm = String(p.permission ?? '')
      const scopeMatch = res.includes(`keyspace ${keyspace}`) || res.includes('all keyspaces')
      return scopeMatch && pm === perm
    })
  }
  function cellState(keyspace: string, perm: string): CellState {
    return hasPerm(keyspace, perm) ? 'direct' : 'none'
  }
  function onCell(keyspace: string, perm: string, st: CellState) {
    if (!selected) return
    pending = [...pending, st === 'none' ? grantColumn(keyspace, perm, selected) : revokeColumn(keyspace, perm, selected)]
  }
  const gridScopes = $derived(keyspaces.map((k) => ({ value: k, label: k })))
  const gridPresets = [
    { kind: 'read-only', label: 'R' },
    { kind: 'read-write', label: 'RW' },
    { kind: 'full', label: 'Full' },
    { kind: 'revoke-all', label: 'Revoke', danger: true },
  ]

  let showMatrix = $state(false)
  function openGrantWizard() {
    if (!selected) return
    grantWizard.show({
      title: 'Grant access',
      role: selected,
      scopeLabel: 'Keyspace',
      scopes: keyspaces,
      levels: STANDARD_LEVELS,
      build: (kind, ks) => [keyspacePreset(kind as PresetKind, ks, selected)],
      onApply: (stmts) => (pending = [...pending, ...stmts]),
    })
  }

  function applyPreset(keyspace: string, kind: PresetKind) {
    if (!selected) return
    pending = [...pending, keyspacePreset(kind, keyspace, selected)]
  }

  // ---- General --------------------------------------------------------------
  let newPassword = $state('')
  function queuePassword() {
    if (!selected || !newPassword) return
    const s = alterRole(selected, { password: newPassword })
    if (s) pending = [...pending, s]
    newPassword = ''
  }
  function queueLogin(login: boolean) {
    if (!selected) return
    const s = alterRole(selected, { login })
    if (s) pending = [...pending, s]
  }
  function queueSuper(superuser: boolean) {
    if (!selected) return
    const s = alterRole(selected, { superuser })
    if (s) pending = [...pending, s]
  }
  let confirmDrop = $state(false)
  function queueDrop() {
    if (selected) pending = [...pending, dropRole(selected)]
    confirmDrop = false
  }

  // ---- Member of ------------------------------------------------------------
  let grantRoleName = $state('')
  function queueGrantRole() {
    if (!selected || !grantRoleName) return
    pending = [...pending, grantRole(grantRoleName, selected)]
    grantRoleName = ''
  }

  // ---- Execute --------------------------------------------------------------
  async function execute() {
    if (!cid || !pending.length || executing) return
    executing = true
    try {
      for (const cql of pending) {
        const res = await ipc.cqlExec(cid, cql)
        if (!res.ok) {
          toasts.error(res.error?.message ?? 'error')
          break
        }
      }
      toasts.success('Applied', 'cassandra')
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
    <span style="font-size:var(--px-12);font-weight:700">Roles</span>
    <span style="font-size:var(--px-11);color:var(--muted)">{roles.length} roles</span>
    <span onclick={() => cid && cassUserWizard.show(cid)} onkeydown={(e) => e.key === 'Enter' && cid && cassUserWizard.show(cid)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">+ Create Role</span>
    <span onclick={refresh} onkeydown={(e) => e.key === 'Enter' && refresh()} role="button" tabindex="0" aria-busy={refreshing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}">{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span>
  </div>

  {#if !gateOk}
    <div style="flex:none;padding:var(--px-8) var(--px-14);background:var(--panel);border-bottom:var(--px-1) solid var(--border);color:var(--warn2);font-size:var(--px-11_5)">Role management needs PasswordAuthenticator + CassandraAuthorizer in cassandra.yaml (default AllowAll disables it).</div>
  {/if}

  <div style="flex:1;display:flex;min-height:0">
    <div role="listbox" tabindex="-1" aria-label="Roles" style="flex:none;width:var(--px-240);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
      {#if error}<div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else if loading}<div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
      {:else}
        {#each roles as r (r.role)}
          <div onclick={() => (selected = String(r.role))} onkeydown={(e) => e.key === 'Enter' && (selected = String(r.role))} role="option" tabindex="0" aria-selected={selected === String(r.role)} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{selected === String(r.role) ? 'var(--grid-select)' : 'transparent'};color:{selected === String(r.role) ? 'var(--hex-fff)' : 'var(--text)'}">
            <span>{boolY(r.login) ? '👤' : '👥'}</span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis">{r.role}</span>
            {#if boolY(r.super)}<span style="font-size:var(--px-9);color:{selected === String(r.role) ? 'var(--hex-fff)' : 'var(--warn2)'}">SUPER</span>{/if}
          </div>
        {/each}
      {/if}
    </div>

    <div style="flex:1;display:flex;flex-direction:column;min-height:0">
      {#if selectedRole}
        <div style="flex:none;display:flex;gap:var(--px-2);padding:var(--px-8) var(--px-12) 0;border-bottom:var(--px-1) solid var(--border)">
          {#each [['general', 'General'], ['members', 'Member of'], ['perms', 'Permissions']] as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} style="padding:var(--px-6) var(--px-12);font-size:var(--px-12);cursor:pointer;font-weight:600;border-bottom:var(--px-2) solid {detailTab === k ? 'var(--primary)' : 'transparent'};color:{detailTab === k ? 'var(--text)' : 'var(--muted)'}">{label}</span>
          {/each}
        </div>
        <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
          {#if detailTab === 'general'}
            <table class="mono" style="border-collapse:collapse;font-size:var(--px-12);margin-bottom:var(--px-14)">
              <tbody>
                {#each [['Role', selectedRole.role], ['Login', boolY(selectedRole.login) ? 'yes' : 'no'], ['Superuser', boolY(selectedRole.super) ? 'yes' : 'no']] as [k, v] (k)}
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
              <span onclick={() => queueLogin(!boolY(selectedRole.login))} onkeydown={(e) => e.key === 'Enter' && queueLogin(!boolY(selectedRole.login))} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">{boolY(selectedRole.login) ? 'Queue NOLOGIN' : 'Queue LOGIN'}</span>
              <span onclick={() => queueSuper(!boolY(selectedRole.super))} onkeydown={(e) => e.key === 'Enter' && queueSuper(!boolY(selectedRole.super))} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">{boolY(selectedRole.super) ? 'Queue NOSUPERUSER' : 'Queue SUPERUSER'}</span>
            </div>
            {#if confirmDrop}
              <div style="display:flex;gap:var(--px-8);align-items:center;padding:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--error);border-radius:var(--px-6)">
                <span style="font-size:var(--px-12);color:var(--error)">Drop role “{selected}”?</span>
                <span onclick={queueDrop} onkeydown={(e) => e.key === 'Enter' && queueDrop()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue drop</span>
                <span onclick={() => (confirmDrop = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Cancel</span>
              </div>
            {:else}
              <span onclick={() => (confirmDrop = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = true)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--error);border:var(--px-1) solid var(--error);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop role…</span>
            {/if}
          {:else if detailTab === 'members'}
            <div style="display:flex;gap:var(--px-6);align-items:center;flex-wrap:wrap">
              <select bind:value={grantRoleName} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text);font-size:var(--px-12)">
                <option value="">— grant role to {selected} —</option>
                {#each roles.filter((r) => String(r.role) !== selected) as r (r.role)}<option value={String(r.role)}>{r.role}</option>{/each}
              </select>
              <span onclick={queueGrantRole} onkeydown={(e) => e.key === 'Enter' && queueGrantRole()} role="button" tabindex="0" aria-disabled={!grantRoleName} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:{grantRoleName ? 'pointer' : 'not-allowed'};opacity:{grantRoleName ? 1 : 0.5}">Queue grant</span>
            </div>
            <div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">GRANT &lt;role&gt; TO {selected} — role membership (a role can inherit another role's permissions).</div>
          {:else}
            <!-- Permissions -->
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-10);flex-wrap:wrap">
              <span onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600">＋ Grant access…</span>
              <span style="font-size:var(--px-11);color:var(--muted)">Pick a keyspace and an access level (Read-only / Read-Write / Full).</span>
            </div>
            <div onclick={() => (showMatrix = !showMatrix)} onkeydown={(e) => e.key === 'Enter' && (showMatrix = !showMatrix)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--text2);cursor:pointer;margin-bottom:var(--px-8);user-select:none">{showMatrix ? '▾' : '▸'} Advanced — permission matrix</div>
            {#if showMatrix}
            <PrivilegeGrid
              columns={CASS_GRID_COLUMNS}
              scopes={gridScopes}
              {cellState}
              {onCell}
              presets={gridPresets}
              onPreset={(ks, kind) => applyPreset(ks, kind as PresetKind)}
              note="MODIFY = INSERT + UPDATE + DELETE + TRUNCATE. Shows effective permissions (incl. via ALL KEYSPACES / roles)."
            />
            {/if}
          {/if}
        </div>
      {:else if !loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Select a role.</div>
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
