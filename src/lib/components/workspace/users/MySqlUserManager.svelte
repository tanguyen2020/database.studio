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
  import { grantWizard, STANDARD_LEVELS } from '$lib/stores/grantwizard.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import {
    acct,
    alterPassword,
    dbPreset,
    dropUser,
    grantColumn,
    grantRole,
    lockAccount,
    MYSQL_GRID_COLUMNS,
    revokeColumn,
    revokeRole,
    setDefaultRole,
    type PresetKind,
  } from '$lib/users/mysql'
  import PrivilegeGrid from './PrivilegeGrid.svelte'
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
  let detailTab = $state<'general' | 'admin' | 'privileges' | 'roles' | 'showgrants'>('general')
  let showGrants = $state<string>('')
  // Global (administrative) privileges checklist — granted ON *.*.
  const GLOBAL_PRIVS = [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'INDEX', 'ALTER', 'CREATE VIEW', 'SHOW VIEW',
    'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'EVENT', 'TRIGGER', 'REFERENCES', 'LOCK TABLES',
    'CREATE TEMPORARY TABLES', 'CREATE USER', 'RELOAD', 'PROCESS', 'SHOW DATABASES', 'REPLICATION CLIENT',
    'REPLICATION SLAVE', 'SUPER', 'FILE', 'SHUTDOWN', 'GRANT OPTION',
  ]
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

  // ---- Privilege grid §1.8.2 (full columns, clickable, inherited) -----------
  type CellState = 'none' | 'direct' | 'partial' | 'inherited' | 'deny'

  // role accounts the user is a member of (mysql: role_edges; mariadb: roles_mapping).
  function rolesOf(): string[] {
    if (system === 'mariadb') return roleRows.filter((r) => String(r.member_user) === selUser).map((r) => acct(String(r.role), '%'))
    return roleRows
      .filter((r) => String(r.member_user) === selUser && String(r.member_host) === selHost)
      .map((r) => acct(String(r.role_user), String(r.role_host)))
  }
  function directOf(grantee: string, db: string | null, priv: string): 'none' | 'direct' | 'partial' {
    if (db == null) return globalPrivs.some((g) => String(g.grantee) === grantee && String(g.privilege_type) === priv) ? 'direct' : 'none'
    if (schemaPrivs.some((g) => String(g.grantee) === grantee && String(g.table_schema) === db && String(g.privilege_type) === priv)) return 'direct'
    if (tablePrivs.some((g) => String(g.grantee) === grantee && String(g.table_schema) === db && String(g.privilege_type) === priv)) return 'partial'
    return 'none'
  }
  function cellState(db: string | null, priv: string): CellState {
    const d = directOf(selLit, db, priv)
    if (d !== 'none') return d
    if (rolesOf().some((r) => directOf(r, db, priv) !== 'none')) return 'inherited'
    return 'none'
  }
  function cellTip(db: string | null, priv: string): string {
    if (cellState(db, priv) === 'inherited') {
      const r = rolesOf().find((x) => directOf(x, db, priv) !== 'none')
      return `via role ${r ?? ''}`
    }
    return priv
  }
  function onCell(db: string | null, priv: string, st: CellState) {
    if (!selectedAcct) return
    pending = [...pending, st === 'none' || st === 'partial' ? grantColumn(db, priv, selUser, selHost) : revokeColumn(db, priv, selUser, selHost)]
  }
  const gridScopes = $derived([{ value: '*', label: '*.* (Global)' }, ...databases.map((d) => ({ value: d, label: d }))])
  const scopeDb = (v: string) => (v === '*' ? null : v)
  const gridPresets = [
    { kind: 'read-only', label: 'R' },
    { kind: 'read-write', label: 'RW' },
    { kind: 'read-write-execute', label: 'RW+X' },
    { kind: 'full', label: 'Full' },
    { kind: 'revoke-all', label: 'Revoke', danger: true },
  ]

  function applyPreset(db: string | null, kind: PresetKind) {
    if (!selectedAcct) return
    pending = [...pending, dbPreset(kind, db, selUser, selHost)]
  }

  let showMatrix = $state(false)
  function openGrantWizard() {
    if (!selectedAcct) return
    grantWizard.show({
      title: 'Grant access',
      role: `${selUser}@${selHost}`,
      scopeLabel: 'Database',
      scopes: ['* (all databases)', ...databases],
      levels: STANDARD_LEVELS,
      build: (kind, db) => [dbPreset(kind as PresetKind, db.startsWith('* ') ? null : db, selUser, selHost)],
      onApply: (stmts) => (pending = [...pending, ...stmts]),
    })
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

  async function loadShowGrants() {
    if (!cid || !selectedAcct) return
    const r = await ipc.usersView(cid, 'grants_for', selLit).catch(() => ({ rows: [] as Row[] }))
    showGrants = r.rows.map((x) => String(Object.values(x)[0] ?? '')).join(';\n') + (r.rows.length ? ';' : '')
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
          {#each [['general', 'General'], ['admin', 'Administrative'], ['privileges', 'Schema Privileges'], ['roles', 'Roles'], ['showgrants', 'SHOW GRANTS']] as [k, label] (k)}
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
          {:else if detailTab === 'admin'}
            <div style="font-size:var(--px-11);color:var(--muted);margin-bottom:var(--px-8)">Global (administrative) privileges — granted ON *.* (whole server). Click to grant/revoke.</div>
            <div style="display:flex;flex-wrap:wrap;gap:var(--px-8) var(--px-14)">
              {#each GLOBAL_PRIVS as p (p)}
                <label style="font-size:var(--px-11_5);color:var(--text);display:flex;align-items:center;gap:var(--px-4)">
                  <input type="checkbox" checked={directOf(selLit, null, p) !== 'none'} onchange={(e) => onCell(null, p, (e.currentTarget as HTMLInputElement).checked ? 'none' : 'direct')} /> {p}
                </label>
              {/each}
            </div>
          {:else if detailTab === 'showgrants'}
            <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-8)">
              <span style="font-size:var(--px-11);color:var(--muted)">Raw output of SHOW GRANTS FOR {selLit} (source of truth).</span>
              <span onclick={loadShowGrants} onkeydown={(e) => e.key === 'Enter' && loadShowGrants()} role="button" tabindex="0" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-9);cursor:pointer">Load</span>
            </div>
            <pre class="selectable mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11_5);white-space:pre-wrap;color:var(--text2)">{showGrants || '-- click Load'}</pre>
          {:else if detailTab === 'privileges'}
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-10);flex-wrap:wrap">
              <span onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600">＋ Grant access…</span>
              <span style="font-size:var(--px-11);color:var(--muted)">Pick a database and an access level (Read-only / Read-Write / Full).</span>
            </div>
            <div onclick={() => (showMatrix = !showMatrix)} onkeydown={(e) => e.key === 'Enter' && (showMatrix = !showMatrix)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--text2);cursor:pointer;margin-bottom:var(--px-8);user-select:none">{showMatrix ? '▾' : '▸'} Advanced — permission matrix</div>
            {#if showMatrix}
            <PrivilegeGrid
              columns={MYSQL_GRID_COLUMNS}
              scopes={gridScopes}
              cellState={(v, p) => cellState(scopeDb(v), p)}
              cellTip={(v, p) => cellTip(scopeDb(v), p)}
              onCell={(v, p, st) => onCell(scopeDb(v), p, st)}
              presets={gridPresets}
              onPreset={(v, kind) => applyPreset(scopeDb(v), kind as PresetKind)}
            />
            {/if}
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
