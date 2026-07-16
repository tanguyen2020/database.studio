<script lang="ts">
  // MySQL / MariaDB User Manager (U2). Account = user@host. One component adapts
  // by tab.systemType: MariaDB has a real is_role flag + roles_mapping + `SET
  // DEFAULT ROLE … FOR`; MySQL has neither. Tabs: General (plugin/password/lock/
  // rename/drop) · Privileges (per-database grid §1.8.2 with presets) · Roles ·
  // Grants (raw SHOW GRANTS). Mutations run via exec_statement (TEXT protocol —
  // never exec_params, which would hit MySQL error 1295 on CREATE USER/GRANT).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { myUserWizard } from '$lib/stores/myuser.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import {
    acct,
    alterPassword,
    dbPreset,
    dropUser,
    grantRole,
    lockAccount,
    revokeRole,
    setDefaultRole,
    type PresetKind,
  } from '$lib/users/mysql'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const system = $derived(tab.systemType === 'mariadb' ? 'mariadb' : 'mysql')
  const cid = $derived(tab.connectionId)

  type Row = Record<string, unknown>
  let accounts = $state<Row[]>([])
  let schemaPrivs = $state<Row[]>([])
  let tablePrivs = $state<Row[]>([])
  let globalPrivs = $state<Row[]>([])
  let roleRows = $state<Row[]>([])
  let databases = $state<string[]>([])
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let selectedKey = $state<string>('')
  let detailTab = $state<'general' | 'privileges' | 'roles'>('general')
  let pending = $state<string[]>([])
  let executing = $state(false)

  const keyOf = (r: Row) => `${r.user}@${r.host}`
  const boolY = (v: unknown) => v === true || v === 1 || v === '1' || v === 'Y' || v === 't'
  const isRole = (r: Row) => system === 'mariadb' && boolY(r.is_role)

  async function load() {
    if (!cid) return
    loading = true
    error = null
    try {
      const roleView = system === 'mariadb' ? 'roles_mapping' : 'role_edges'
      const [u, sp, tp, gp, rr, sc] = await Promise.all([
        ipc.usersView(cid, 'users'),
        ipc.usersView(cid, 'schema_privs').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, 'table_privs').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, 'global_privs').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, roleView).catch(() => ({ rows: [] as Row[] })),
        ipc.listSchemas(cid).catch(() => []),
      ])
      accounts = u.rows
      schemaPrivs = sp.rows
      tablePrivs = tp.rows
      globalPrivs = gp.rows
      roleRows = rr.rows
      databases = sc.map((s) => s.name)
      if (!selectedKey || !accounts.some((a) => keyOf(a) === selectedKey)) {
        const focus = (tab.state as { focus?: string }).focus
        selectedKey = focus && accounts.some((a) => keyOf(a) === focus) ? focus : accounts[0] ? keyOf(accounts[0]) : ''
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

  const selectedAcct = $derived(accounts.find((a) => keyOf(a) === selectedKey))
  const selUser = $derived(selectedAcct ? String(selectedAcct.user) : '')
  const selHost = $derived(selectedAcct ? String(selectedAcct.host) : '')
  const selLit = $derived(selectedAcct ? acct(selUser, selHost) : '')

  // ---- Privilege grid §1.8.2 ------------------------------------------------
  const GRID_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE'] as const
  type CellState = 'none' | 'full' | 'partial'

  function cellState(db: string | null, priv: string): CellState {
    if (db == null) {
      // Global (*.*)
      const has = globalPrivs.some((g) => String(g.grantee) === selLit && String(g.privilege_type) === priv)
      return has ? 'full' : 'none'
    }
    const full = schemaPrivs.some(
      (g) => String(g.grantee) === selLit && String(g.table_schema) === db && String(g.privilege_type) === priv,
    )
    if (full) return 'full'
    const partial = tablePrivs.some(
      (g) => String(g.grantee) === selLit && String(g.table_schema) === db && String(g.privilege_type) === priv,
    )
    return partial ? 'partial' : 'none'
  }
  const cellGlyph = (s: CellState) => (s === 'full' ? '✓' : s === 'partial' ? '■' : '☐')

  function applyPreset(db: string | null, kind: PresetKind) {
    if (!selectedAcct) return
    pending = [...pending, dbPreset(kind, db, selUser, selHost)]
  }

  // ---- General --------------------------------------------------------------
  let newPassword = $state('')
  function queuePassword() {
    if (!selectedAcct || !newPassword) return
    pending = [...pending, alterPassword(selUser, selHost, newPassword)]
    newPassword = ''
  }
  function queueLock(locked: boolean) {
    if (!selectedAcct) return
    pending = [...pending, lockAccount(selUser, selHost, locked)]
  }
  let confirmDrop = $state(false)
  function queueDrop() {
    if (!selectedAcct) return
    pending = [...pending, dropUser(selUser, selHost)]
    confirmDrop = false
  }

  // ---- Roles ----------------------------------------------------------------
  let grantRoleName = $state('')
  let grantAdmin = $state(false)
  const grantedRoles = $derived(
    system === 'mariadb'
      ? roleRows.filter((r) => String(r.member_user) === selUser).map((r) => String(r.role))
      : roleRows.filter((r) => String(r.member_user) === selUser && String(r.member_host) === selHost).map((r) => String(r.role_user)),
  )
  // role candidates: MariaDB roles = accounts with is_role; MySQL = any account
  const roleCandidates = $derived(
    system === 'mariadb' ? accounts.filter((a) => isRole(a)).map((a) => String(a.user)) : accounts.map((a) => String(a.user)),
  )
  function queueGrantRole() {
    if (!selectedAcct || !grantRoleName) return
    pending = [...pending, grantRole(grantRoleName, selUser, selHost, grantAdmin)]
    grantRoleName = ''
    grantAdmin = false
  }
  function queueRevokeRole(role: string) {
    if (!selectedAcct) return
    pending = [...pending, revokeRole(role, selUser, selHost)]
  }
  function queueDefaultRole(role: string) {
    if (!selectedAcct || !role) return
    pending = [...pending, setDefaultRole(system, role, selUser, selHost)]
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
      toasts.success('Applied', system)
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
    <span style="font-size:var(--px-12);font-weight:700">Users and Privileges</span>
    <span style="font-size:var(--px-11);color:var(--muted)">{accounts.length} accounts</span>
    <span onclick={() => cid && myUserWizard.show(cid, system)} onkeydown={(e) => e.key === 'Enter' && cid && myUserWizard.show(cid, system)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">+ Add Account</span>
    <span onclick={refresh} onkeydown={(e) => e.key === 'Enter' && refresh()} role="button" tabindex="0" aria-busy={refreshing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}">{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span>
  </div>

  <div style="flex:1;display:flex;min-height:0">
    <!-- Account list -->
    <div role="listbox" tabindex="-1" aria-label="Accounts" style="flex:none;width:var(--px-240);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
      {#if error}
        <div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else if loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
      {:else}
        {#each accounts as a (keyOf(a))}
          <div onclick={() => (selectedKey = keyOf(a))} onkeydown={(e) => e.key === 'Enter' && (selectedKey = keyOf(a))} role="option" tabindex="0" aria-selected={selectedKey === keyOf(a)} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{selectedKey === keyOf(a) ? 'var(--grid-select)' : 'transparent'};color:{selectedKey === keyOf(a) ? 'var(--hex-fff)' : 'var(--text)'}">
            <span>{isRole(a) ? '👥' : '👤'}</span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis"><span style="font-weight:600">{a.user}</span><span style="opacity:0.65">@{a.host}</span></span>
            {#if boolY(a.account_locked)}<span style="font-size:var(--px-9);color:{selectedKey === keyOf(a) ? 'var(--hex-fff)' : 'var(--warn2)'}">LOCK</span>{/if}
          </div>
        {/each}
      {/if}
    </div>

    <!-- Detail -->
    <div style="flex:1;display:flex;flex-direction:column;min-height:0">
      {#if selectedAcct}
        <div style="flex:none;display:flex;gap:var(--px-2);padding:var(--px-8) var(--px-12) 0;border-bottom:var(--px-1) solid var(--border)">
          {#each [['general', 'General'], ['privileges', 'Schema Privileges'], ['roles', 'Roles']] as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} style="padding:var(--px-6) var(--px-12);font-size:var(--px-12);cursor:pointer;font-weight:600;border-bottom:var(--px-2) solid {detailTab === k ? 'var(--primary)' : 'transparent'};color:{detailTab === k ? 'var(--text)' : 'var(--muted)'}">{label}</span>
          {/each}
        </div>
        <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
          {#if detailTab === 'general'}
            <table class="mono" style="border-collapse:collapse;font-size:var(--px-12);margin-bottom:var(--px-14)">
              <tbody>
                {#each [['User', selUser], ['Host', selHost], ['Plugin', selectedAcct.plugin], ['Locked', boolY(selectedAcct.account_locked) ? 'yes' : 'no'], ['Password expired', boolY(selectedAcct.password_expired) ? 'yes' : 'no']] as [label, val] (label)}
                  <tr><td style="padding:var(--px-3) var(--px-14) var(--px-3) 0;color:var(--text2);white-space:nowrap">{label}</td><td style="padding:var(--px-3) 0;color:var(--text)">{val}</td></tr>
                {/each}
              </tbody>
            </table>
            <div style="display:flex;gap:var(--px-6);align-items:flex-end;margin-bottom:var(--px-10)">
              <label style="font-size:var(--px-12);color:var(--text2)">Change password
                <input type="password" bind:value={newPassword} class="mono" style="display:block;margin-top:var(--px-4);width:var(--px-220);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
              </label>
              <span onclick={queuePassword} onkeydown={(e) => e.key === 'Enter' && queuePassword()} role="button" tabindex="0" aria-disabled={!newPassword} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:{newPassword ? 'pointer' : 'not-allowed'};opacity:{newPassword ? 1 : 0.5}">Queue change</span>
            </div>
            <div style="display:flex;gap:var(--px-8);margin-bottom:var(--px-12)">
              {#if boolY(selectedAcct.account_locked)}
                <span onclick={() => queueLock(false)} onkeydown={(e) => e.key === 'Enter' && queueLock(false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue unlock</span>
              {:else}
                <span onclick={() => queueLock(true)} onkeydown={(e) => e.key === 'Enter' && queueLock(true)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue lock</span>
              {/if}
            </div>
            {#if confirmDrop}
              <div style="display:flex;gap:var(--px-8);align-items:center;padding:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--error);border-radius:var(--px-6)">
                <span style="font-size:var(--px-12);color:var(--error)">Drop account “{selLit}”?</span>
                <span onclick={queueDrop} onkeydown={(e) => e.key === 'Enter' && queueDrop()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue drop</span>
                <span onclick={() => (confirmDrop = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Cancel</span>
              </div>
            {:else}
              <span onclick={() => (confirmDrop = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = true)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--error);border:var(--px-1) solid var(--error);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop account…</span>
            {/if}
          {:else if detailTab === 'privileges'}
            <div style="overflow:auto">
              <table class="mono" style="border-collapse:collapse;font-size:var(--px-12);width:100%">
                <thead>
                  <tr>
                    <th style="text-align:left;padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">Scope</th>
                    {#each GRID_PRIVS as p (p)}<th style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">{p}</th>{/each}
                    <th style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">Presets</th>
                  </tr>
                </thead>
                <tbody>
                  {#each [null, ...databases] as db (db ?? '*')}
                    <tr>
                      <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--text)">{db ?? '*.* (Global)'}</td>
                      {#each GRID_PRIVS as p (p)}
                        <td style="text-align:center;padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:{cellState(db, p) === 'full' ? 'var(--sacc-green)' : cellState(db, p) === 'partial' ? 'var(--warn2)' : 'var(--muted)'}">{cellGlyph(cellState(db, p))}</td>
                      {/each}
                      <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);white-space:nowrap">
                        {#each [['read-only', 'R'], ['read-write', 'RW'], ['read-write-execute', 'RW+X'], ['full', 'Full'], ['revoke-all', 'Revoke']] as [kind, label] (kind)}
                          <span onclick={() => applyPreset(db, kind as PresetKind)} onkeydown={(e) => e.key === 'Enter' && applyPreset(db, kind as PresetKind)} role="button" tabindex="0" title={String(kind)} style="font-size:var(--px-10_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-7);margin-right:var(--px-4);cursor:pointer;color:{kind === 'revoke-all' ? 'var(--error)' : 'var(--text2)'}">{label}</span>
                        {/each}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">✓ = whole scope · ■ = some tables · ☐ = none.</div>
          {:else}
            <!-- Roles -->
            <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-bottom:var(--px-6)">Granted roles</div>
            {#if grantedRoles.length}
              {#each grantedRoles as r (r)}
                <div style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-12);padding:var(--px-2) 0">
                  <span class="mono">{r}</span>
                  <span onclick={() => queueRevokeRole(r)} onkeydown={(e) => e.key === 'Enter' && queueRevokeRole(r)} role="button" tabindex="0" style="font-size:var(--px-10_5);color:var(--error);cursor:pointer">revoke</span>
                </div>
              {/each}
            {:else}
              <div style="font-size:var(--px-11_5);color:var(--muted)">No roles granted.</div>
            {/if}
            <div style="display:flex;gap:var(--px-6);align-items:center;margin-top:var(--px-10);flex-wrap:wrap">
              <select bind:value={grantRoleName} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text);font-size:var(--px-12)">
                <option value="">— grant role —</option>
                {#each [...new Set(roleCandidates)].filter((r) => r !== selUser) as r (r)}<option value={r}>{r}</option>{/each}
              </select>
              <label style="font-size:var(--px-11_5);color:var(--text2);display:flex;align-items:center;gap:var(--px-4)"><input type="checkbox" bind:checked={grantAdmin} /> admin</label>
              <span onclick={queueGrantRole} onkeydown={(e) => e.key === 'Enter' && queueGrantRole()} role="button" tabindex="0" aria-disabled={!grantRoleName} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:{grantRoleName ? 'pointer' : 'not-allowed'};opacity:{grantRoleName ? 1 : 0.5}">Queue grant</span>
            </div>
            {#if grantedRoles.length}
              <div style="display:flex;gap:var(--px-6);align-items:center;margin-top:var(--px-8)">
                <span style="font-size:var(--px-11_5);color:var(--text2)">Default role:</span>
                {#each grantedRoles as r (r)}<span onclick={() => queueDefaultRole(r)} onkeydown={(e) => e.key === 'Enter' && queueDefaultRole(r)} role="button" tabindex="0" style="font-size:var(--px-10_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-8);cursor:pointer">{r}</span>{/each}
              </div>
            {/if}
          {/if}
        </div>
      {:else if !loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Select an account.</div>
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
