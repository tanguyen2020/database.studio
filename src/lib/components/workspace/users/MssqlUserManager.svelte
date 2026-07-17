<script lang="ts">
  // SQL Server User Manager (U3). Two tiers: Server (Logins + fixed server roles)
  // and Database (Users + Roles + permission grid with GRANT/DENY/REVOKE — DENY
  // wins over GRANT). Database-scoped reads/writes run on an attach_database
  // sub-connection. Mutations go through exec_statement → simple_query raw batch
  // (is_raw_batch covers CREATE/ALTER/DROP + GRANT/DENY/REVOKE).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { mssqlUserWizard } from '$lib/stores/mssqluser.svelte'
  import { grantWizard, STANDARD_LEVELS } from '$lib/stores/grantwizard.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import {
    alterLoginPassword,
    createUser as createUserStmt,
    denyColumn,
    dropLogin,
    dropUser,
    grantColumn,
    MSSQL_GRID_COLUMNS,
    revokeColumn,
    schemaPreset,
    setDbRoleMember,
    setLoginEnabled,
    setServerRoleMember,
    FIXED_SERVER_ROLES,
    type PresetKind,
  } from '$lib/users/mssql'
  import PrivilegeGrid from './PrivilegeGrid.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const baseCid = $derived(tab.connectionId)

  type Row = Record<string, unknown>
  let scope = $state<'server' | 'database'>('server')

  // server-scope data
  let logins = $state<Row[]>([])
  let serverRoleMembers = $state<Row[]>([])
  let selectedLogin = $state<string>('')

  // database-scope data
  let databases = $state<string[]>([])
  let selectedDb = $state<string>('')
  let dbCid = $state<string>('') // sub-connection id for selectedDb
  let dbUsers = $state<Row[]>([])
  let dbRoleMembers = $state<Row[]>([])
  let dbPerms = $state<Row[]>([])
  let schemas = $state<string[]>([])
  let selectedUser = $state<string>('')

  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let pending = $state<string[]>([])
  let executing = $state(false)

  const boolY = (v: unknown) => v === true || v === 1 || v === '1' || v === 't'

  async function loadServer() {
    if (!baseCid) return
    const [lg, srm, dbs] = await Promise.all([
      ipc.usersView(baseCid, 'logins'),
      ipc.usersView(baseCid, 'server_role_members').catch(() => ({ rows: [] as Row[] })),
      ipc.listDatabases(baseCid).catch(() => []),
    ])
    logins = lg.rows
    serverRoleMembers = srm.rows
    databases = dbs.map((d) => d.name)
    if (!selectedLogin || !logins.some((l) => String(l.name) === selectedLogin)) selectedLogin = String(logins[0]?.name ?? '')
    if (!selectedDb && databases.length) selectedDb = databases.find((d) => (dbs.find((x) => x.name === d) as { current?: boolean })?.current) ?? databases[0]
  }

  async function loadDatabase() {
    if (!baseCid || !selectedDb) return
    dbCid = await ipc.attachDatabase(baseCid, selectedDb).catch(() => baseCid)
    const [u, rm, pm, sc] = await Promise.all([
      ipc.usersView(dbCid, 'db_users'),
      ipc.usersView(dbCid, 'db_role_members').catch(() => ({ rows: [] as Row[] })),
      ipc.usersView(dbCid, 'db_permissions').catch(() => ({ rows: [] as Row[] })),
      ipc.listSchemas(dbCid).catch(() => []),
    ])
    dbUsers = u.rows
    dbRoleMembers = rm.rows
    dbPerms = pm.rows
    schemas = sc.map((s) => s.name)
    if (!selectedUser || !dbUsers.some((x) => String(x.name) === selectedUser)) selectedUser = String(dbUsers[0]?.name ?? '')
  }

  async function load() {
    if (!baseCid) return
    loading = true
    error = null
    try {
      await loadServer()
      if (scope === 'database') await loadDatabase()
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
    void baseCid
    untrack(() => void load())
  })
  // reload database data when the DB picker or scope changes
  $effect(() => {
    void selectedDb
    void scope
    if (scope === 'database' && selectedDb) untrack(() => void loadDatabase())
  })

  // Grant-right-after-create: a new database User → switch to database scope on
  // its DB, select it, and open the Grant Access wizard.
  $effect(() => {
    const req = grantWizard.afterCreate
    if (req && req.connId === baseCid) untrack(() => void handleAfterCreate(req.principal, req.database))
  })
  async function handleAfterCreate(principal: string, database?: string) {
    grantWizard.afterCreate = null
    scope = 'database'
    if (database) selectedDb = database
    await loadServer()
    await loadDatabase()
    if (dbUsers.some((u) => String(u.name) === principal)) {
      selectedUser = principal
      openGrantWizard()
    }
  }

  // ---- User Mapping (login → databases) -------------------------------------
  let mappingLoaded = $state(false)
  let mappedDbs = $state<Set<string>>(new Set())
  let mappingBusy = $state(false)
  async function loadUserMapping() {
    if (!baseCid || !selectedLogin) return
    mappingBusy = true
    const found = new Set<string>()
    try {
      for (const db of databases) {
        const sub = await ipc.attachDatabase(baseCid, db).catch(() => baseCid!)
        const u = await ipc.usersView(sub, 'db_users').catch(() => ({ rows: [] as Row[] }))
        if (u.rows.some((r) => String(r.login_name) === selectedLogin)) found.add(db)
      }
      mappedDbs = found
      mappingLoaded = true
    } finally {
      mappingBusy = false
    }
  }
  async function queueMapUser(db: string, add: boolean) {
    if (!baseCid || !selectedLogin || mappingBusy) return
    mappingBusy = true
    try {
      const sub = await ipc.attachDatabase(baseCid, db).catch(() => baseCid!)
      const sql = add ? createUserStmt(selectedLogin, selectedLogin) : dropUser(selectedLogin)
      const res = await ipc.execStatement(sub, sql, 0)
      if (!res.ok) {
        toasts.error(res.error?.message ?? 'error')
        return
      }
      await loadUserMapping()
    } finally {
      mappingBusy = false
    }
  }

  // ---- Server: logins -------------------------------------------------------
  const selectedLoginRow = $derived(logins.find((l) => String(l.name) === selectedLogin))
  const serverRolesOf = $derived(serverRoleMembers.filter((m) => String(m.member) === selectedLogin).map((m) => String(m.role)))
  let newLoginPw = $state('')
  function queueLoginPassword() {
    if (!selectedLogin || !newLoginPw) return
    pending = [...pending, alterLoginPassword(selectedLogin, newLoginPw)]
    newLoginPw = ''
  }
  function queueLoginEnabled(enabled: boolean) {
    if (!selectedLogin) return
    pending = [...pending, setLoginEnabled(selectedLogin, enabled)]
  }
  function queueServerRole(role: string, add: boolean) {
    if (!selectedLogin) return
    pending = [...pending, setServerRoleMember(role, selectedLogin, add)]
  }
  let confirmDropLogin = $state(false)
  function queueDropLogin() {
    if (!selectedLogin) return
    pending = [...pending, dropLogin(selectedLogin)]
    confirmDropLogin = false
  }

  // ---- Database: permission grid (full columns, clickable, DENY, inherited) -
  type CellState = 'none' | 'direct' | 'partial' | 'inherited' | 'deny'
  const rolesOfUser = $derived(dbRoleMembers.filter((m) => String(m.member) === selectedUser).map((m) => String(m.role)))
  // fixed-role → implied privileges (for the ◐ inherited indicator).
  const FIXED_IMPLIES: Record<string, string[]> = {
    db_datareader: ['SELECT'],
    db_datawriter: ['INSERT', 'UPDATE', 'DELETE'],
    db_owner: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'ALTER', 'REFERENCES', 'VIEW DEFINITION', 'CONTROL'],
    db_ddladmin: ['ALTER', 'REFERENCES', 'VIEW DEFINITION'],
  }
  function directPerm(principal: string, schema: string, priv: string): 'none' | 'deny' | 'direct' | 'partial' {
    const secSchema = `SCHEMA::${schema}`
    const rows = dbPerms.filter((p) => String(p.principal) === principal && String(p.permission_name) === priv)
    if (rows.some((r) => String(r.securable) === secSchema && String(r.state_desc) === 'DENY')) return 'deny'
    if (rows.some((r) => String(r.securable) === secSchema && String(r.state_desc).startsWith('GRANT'))) return 'direct'
    if (rows.some((r) => String(r.securable).startsWith(`${schema}.`) && String(r.state_desc).startsWith('GRANT'))) return 'partial'
    return 'none'
  }
  function cellState(schema: string, priv: string): CellState {
    const d = directPerm(selectedUser, schema, priv)
    if (d === 'deny') return 'deny' // DENY overrides everything
    if (d === 'direct') return 'direct'
    // inherited via fixed or custom db roles
    for (const role of rolesOfUser) {
      if (FIXED_IMPLIES[role]?.includes(priv)) return 'inherited'
      if (directPerm(role, schema, priv) === 'direct') return 'inherited'
    }
    if (d === 'partial') return 'partial'
    return 'none'
  }
  function cellTip(schema: string, priv: string): string {
    const st = cellState(schema, priv)
    if (st === 'inherited') {
      const role = rolesOfUser.find((r) => FIXED_IMPLIES[r]?.includes(priv) || directPerm(r, schema, priv) === 'direct')
      return `via role ${role ?? ''}`
    }
    return `${priv} — click: grant/revoke · right-click: deny`
  }
  function onCell(schema: string, priv: string, st: CellState) {
    if (!selectedUser) return
    // deny → revoke (clears deny); direct → revoke; none/partial → grant
    pending = [...pending, st === 'none' || st === 'partial' ? grantColumn(schema, priv, selectedUser) : revokeColumn(schema, priv, selectedUser)]
  }
  function onDenyCell(schema: string, priv: string) {
    if (!selectedUser) return
    pending = [...pending, denyColumn(schema, priv, selectedUser)]
  }
  const gridScopes = $derived(schemas.map((s) => ({ value: s, label: s })))
  const gridPresets = [
    { kind: 'read-only', label: 'R' },
    { kind: 'read-write', label: 'RW' },
    { kind: 'read-write-execute', label: 'RW+X' },
    { kind: 'full', label: 'Full' },
    { kind: 'revoke-all', label: 'Revoke', danger: true },
  ]

  let showMatrix = $state(false)
  function openGrantWizard() {
    if (!selectedUser) return
    grantWizard.show({
      title: 'Grant access',
      role: selectedUser,
      scopeLabel: 'Schema',
      scopes: schemas,
      levels: STANDARD_LEVELS,
      build: (kind, schema) => [schemaPreset(kind as PresetKind, schema, selectedUser)],
      onApply: (stmts) => (pending = [...pending, ...stmts]),
    })
  }

  function applyPreset(schema: string, kind: PresetKind) {
    if (!selectedUser) return
    pending = [...pending, schemaPreset(kind, schema, selectedUser)]
  }
  function queueFixedRole(role: string, add: boolean) {
    if (!selectedUser) return
    pending = [...pending, setDbRoleMember(role, selectedUser, add)]
  }
  let confirmDropUser = $state(false)
  function queueDropUser() {
    if (!selectedUser) return
    pending = [...pending, dropUser(selectedUser)]
    confirmDropUser = false
  }

  // ---- Execute --------------------------------------------------------------
  async function execute() {
    // server-scope statements run on base; database-scope on the sub-connection
    const target = scope === 'database' && dbCid ? dbCid : baseCid
    if (!target || !pending.length || executing) return
    executing = true
    try {
      for (const sql of pending) {
        const res = await ipc.execStatement(target, sql, 0)
        if (!res.ok) {
          toasts.error(res.error?.message ?? 'error')
          break
        }
      }
      toasts.success('Applied', 'mssql')
      pending = []
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      executing = false
    }
  }
  const discard = () => (pending = [])

  function openCreate() {
    if (!baseCid) return
    if (scope === 'server') mssqlUserWizard.show(baseCid, 'login')
    else mssqlUserWizard.show(baseCid, 'user', selectedDb, logins.map((l) => String(l.name)))
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <div style="display:flex;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden">
      {#each [['server', 'Server'], ['database', 'Database']] as [k, label] (k)}
        <span onclick={() => (scope = k as typeof scope)} onkeydown={(e) => e.key === 'Enter' && (scope = k as typeof scope)} role="button" tabindex="0" style="padding:var(--px-4) var(--px-12);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{scope === k ? 'var(--primary)' : 'transparent'};color:{scope === k ? 'var(--hex-fff)' : 'var(--text2)'}">{label}</span>
      {/each}
    </div>
    {#if scope === 'database'}
      <select bind:value={selectedDb} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-6);color:var(--text);font-size:var(--px-12)">
        {#each databases as d (d)}<option value={d}>{d}</option>{/each}
      </select>
    {/if}
    <span onclick={openCreate} onkeydown={(e) => e.key === 'Enter' && openCreate()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">{scope === 'server' ? '+ New Login' : '+ New User'}</span>
    <span onclick={refresh} onkeydown={(e) => e.key === 'Enter' && refresh()} role="button" tabindex="0" aria-busy={refreshing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}">{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span>
  </div>

  <div style="flex:1;display:flex;min-height:0">
    {#if scope === 'server'}
      <!-- Logins list -->
      <div role="listbox" tabindex="-1" aria-label="Logins" style="flex:none;width:var(--px-240);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
        {#if error}<div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
        {:else if loading}<div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
        {:else}
          {#each logins as l (l.name)}
            <div onclick={() => (selectedLogin = String(l.name))} onkeydown={(e) => e.key === 'Enter' && (selectedLogin = String(l.name))} role="option" tabindex="0" aria-selected={selectedLogin === String(l.name)} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{selectedLogin === String(l.name) ? 'var(--grid-select)' : 'transparent'};color:{selectedLogin === String(l.name) ? 'var(--hex-fff)' : 'var(--text)'}">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis">{l.name}</span>
              {#if boolY(l.is_disabled)}<span style="font-size:var(--px-9);color:{selectedLogin === String(l.name) ? 'var(--hex-fff)' : 'var(--muted)'}">disabled</span>{/if}
            </div>
          {/each}
        {/if}
      </div>
      <!-- Login detail -->
      <div style="flex:1;display:flex;flex-direction:column;min-height:0">
        {#if selectedLoginRow}
          <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
            <table class="mono" style="border-collapse:collapse;font-size:var(--px-12);margin-bottom:var(--px-14)">
              <tbody>
                {#each [['Name', selectedLoginRow.name], ['Type', selectedLoginRow.type_desc], ['Disabled', boolY(selectedLoginRow.is_disabled) ? 'yes' : 'no'], ['Default DB', selectedLoginRow.default_database_name]] as [k, v] (k)}
                  <tr><td style="padding:var(--px-3) var(--px-14) var(--px-3) 0;color:var(--text2);white-space:nowrap">{k}</td><td style="padding:var(--px-3) 0;color:var(--text)">{v}</td></tr>
                {/each}
              </tbody>
            </table>
            <div style="display:flex;gap:var(--px-6);align-items:flex-end;margin-bottom:var(--px-10)">
              <label style="font-size:var(--px-12);color:var(--text2)">Change password
                <input type="password" bind:value={newLoginPw} class="mono" style="display:block;margin-top:var(--px-4);width:var(--px-220);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
              </label>
              <span onclick={queueLoginPassword} onkeydown={(e) => e.key === 'Enter' && queueLoginPassword()} role="button" tabindex="0" aria-disabled={!newLoginPw} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:{newLoginPw ? 'pointer' : 'not-allowed'};opacity:{newLoginPw ? 1 : 0.5}">Queue change</span>
              {#if boolY(selectedLoginRow.is_disabled)}
                <span onclick={() => queueLoginEnabled(true)} onkeydown={(e) => e.key === 'Enter' && queueLoginEnabled(true)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:pointer">Enable</span>
              {:else}
                <span onclick={() => queueLoginEnabled(false)} onkeydown={(e) => e.key === 'Enter' && queueLoginEnabled(false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:pointer">Disable</span>
              {/if}
            </div>
            <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-bottom:var(--px-6)">Server roles</div>
            <div style="display:flex;flex-wrap:wrap;gap:var(--px-8);margin-bottom:var(--px-12)">
              {#each FIXED_SERVER_ROLES as role (role)}
                <label style="font-size:var(--px-11_5);color:var(--text);display:flex;align-items:center;gap:var(--px-4)">
                  <input type="checkbox" checked={serverRolesOf.includes(role)} onchange={(e) => queueServerRole(role, (e.currentTarget as HTMLInputElement).checked)} /> {role}
                </label>
              {/each}
            </div>
            <!-- User Mapping (§5.3) — which databases this login has a user in -->
            <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-6)">
              <span style="font-size:var(--px-12);color:var(--text2);font-weight:600">User Mapping</span>
              <span onclick={loadUserMapping} onkeydown={(e) => e.key === 'Enter' && loadUserMapping()} role="button" tabindex="0" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-9);cursor:pointer">Load</span>
            </div>
            {#if mappingLoaded}
              <div style="display:flex;flex-direction:column;gap:var(--px-3);margin-bottom:var(--px-12)">
                {#each databases as db (db)}
                  <label style="font-size:var(--px-11_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)">
                    <input type="checkbox" checked={mappedDbs.has(db)} onchange={(e) => queueMapUser(db, (e.currentTarget as HTMLInputElement).checked)} /> {db}
                  </label>
                {/each}
              </div>
            {:else}
              <div style="font-size:var(--px-11);color:var(--muted);margin-bottom:var(--px-12)">Load to see which databases {selectedLogin} maps to (creates/drops a database user per checkbox).</div>
            {/if}
            {#if confirmDropLogin}
              <div style="display:flex;gap:var(--px-8);align-items:center;padding:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--error);border-radius:var(--px-6)">
                <span style="font-size:var(--px-12);color:var(--error)">Drop login “{selectedLogin}”?</span>
                <span onclick={queueDropLogin} onkeydown={(e) => e.key === 'Enter' && queueDropLogin()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue drop</span>
                <span onclick={() => (confirmDropLogin = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDropLogin = false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Cancel</span>
              </div>
            {:else}
              <span onclick={() => (confirmDropLogin = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDropLogin = true)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--error);border:var(--px-1) solid var(--error);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop login…</span>
            {/if}
          </div>
        {:else if !loading}
          <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Select a login.</div>
        {/if}
      </div>
    {:else}
      <!-- Database: users list -->
      <div role="listbox" tabindex="-1" aria-label="Users" style="flex:none;width:var(--px-240);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
        {#if error}<div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
        {:else if loading}<div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
        {:else}
          {#each dbUsers as u (u.name)}
            <div onclick={() => (selectedUser = String(u.name))} onkeydown={(e) => e.key === 'Enter' && (selectedUser = String(u.name))} role="option" tabindex="0" aria-selected={selectedUser === String(u.name)} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{selectedUser === String(u.name) ? 'var(--grid-select)' : 'transparent'};color:{selectedUser === String(u.name) ? 'var(--hex-fff)' : 'var(--text)'}">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis">{u.name}</span>
              {#if boolY(u.orphaned)}<span style="font-size:var(--px-9);color:{selectedUser === String(u.name) ? 'var(--hex-fff)' : 'var(--warn2)'}">orphaned</span>{/if}
            </div>
          {/each}
        {/if}
      </div>
      <!-- User detail: permission grid + roles -->
      <div style="flex:1;display:flex;flex-direction:column;min-height:0">
        {#if selectedUser}
          <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
            <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-bottom:var(--px-6)">Fixed database roles</div>
            <div style="display:flex;gap:var(--px-10);margin-bottom:var(--px-12)">
              {#each ['db_datareader', 'db_datawriter'] as role (role)}
                <label style="font-size:var(--px-11_5);color:var(--text);display:flex;align-items:center;gap:var(--px-4)">
                  <input type="checkbox" checked={rolesOfUser.includes(role)} onchange={(e) => queueFixedRole(role, (e.currentTarget as HTMLInputElement).checked)} /> {role}
                </label>
              {/each}
            </div>
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-10);flex-wrap:wrap">
              <span onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600">＋ Grant access…</span>
              <span style="font-size:var(--px-11);color:var(--muted)">Pick a schema and an access level (Read-only / Read-Write / Full).</span>
            </div>
            <div onclick={() => (showMatrix = !showMatrix)} onkeydown={(e) => e.key === 'Enter' && (showMatrix = !showMatrix)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--text2);cursor:pointer;margin-bottom:var(--px-8);user-select:none">{showMatrix ? '▾' : '▸'} Advanced — permission matrix (GRANT / DENY per privilege)</div>
            {#if showMatrix}
            <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-bottom:var(--px-6)">Schema permissions</div>
            <PrivilegeGrid
              columns={MSSQL_GRID_COLUMNS}
              scopes={gridScopes}
              {cellState}
              {cellTip}
              {onCell}
              onDeny={onDenyCell}
              presets={gridPresets}
              onPreset={(s, kind) => applyPreset(s, kind as PresetKind)}
              note="DENY overrides GRANT (incl. via roles)."
            />
            {/if}
            {#if confirmDropUser}
              <div style="display:flex;gap:var(--px-8);align-items:center;margin-top:var(--px-12);padding:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--error);border-radius:var(--px-6)">
                <span style="font-size:var(--px-12);color:var(--error)">Drop user “{selectedUser}”?</span>
                <span onclick={queueDropUser} onkeydown={(e) => e.key === 'Enter' && queueDropUser()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue drop</span>
                <span onclick={() => (confirmDropUser = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDropUser = false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Cancel</span>
              </div>
            {:else}
              <span onclick={() => (confirmDropUser = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDropUser = true)} role="button" tabindex="0" style="display:inline-block;margin-top:var(--px-12);font-size:var(--px-11_5);color:var(--error);border:var(--px-1) solid var(--error);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop user…</span>
            {/if}
          </div>
        {:else if !loading}
          <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Select a user.</div>
        {/if}
      </div>
    {/if}
  </div>

  {#if pending.length}
    <div style="flex:none;border-top:var(--px-1) solid var(--border);background:var(--panel);padding:var(--px-10) var(--px-14);max-height:var(--px-220);overflow:auto">
      <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-6)">
        <span style="font-size:var(--px-11_5);font-weight:700;color:var(--text2)">Pending changes ({pending.length}) · {scope === 'database' ? selectedDb : 'server'}</span>
        <span onclick={execute} onkeydown={(e) => e.key === 'Enter' && execute()} role="button" tabindex="0" aria-disabled={executing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer;font-weight:600;opacity:{executing ? 0.6 : 1}">{executing ? 'Executing…' : 'Execute'}</span>
        <span onclick={discard} onkeydown={(e) => e.key === 'Enter' && discard()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer">Discard</span>
      </div>
      <pre class="selectable mono" style="margin:0;font-size:var(--px-11);white-space:pre-wrap;color:var(--text2)">{#each pending as s (s)}{#each highlightSql(s + ';\n') as tk (tk)}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}{/each}</pre>
    </div>
  {/if}
</div>
