<script lang="ts">
  // ClickHouse User Manager (U4). SQL-driven RBAC: Users + Roles + per-database
  // grant grid. Users/roles in users.xml storage are read-only (badge); only
  // local_directory principals are editable by SQL. Requires ACCESS MANAGEMENT
  // on the connection (banner otherwise). Mutations run via exec_statement (HTTP).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import DropConfirm from './DropConfirm.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { chUserWizard } from '$lib/stores/chuser.svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import {
    accessStatement,
    alterUserPassword,
    CH_GRID_COLUMNS,
    dbPreset,
    dropUser,
    dropRole,
    grantColumn,
    grantRole,
    revokeColumn,
    revokeRole,
    setDefaultRole,
    type PresetKind,
  } from '$lib/users/clickhouse'
  import PrivilegeGrid from './PrivilegeGrid.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const cid = $derived(tab.connectionId)

  type Row = Record<string, unknown>
  let users = $state<Row[]>([])
  let roles = $state<Row[]>([])
  let grants = $state<Row[]>([])
  let roleGrants = $state<Row[]>([])
  let databases = $state<string[]>([])
  let canManage = $state(true)
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let kind = $state<'users' | 'roles'>('users')
  let selected = $state<string>('')
  let detailTab = $state<'general' | 'grants' | 'access' | 'roles'>('general')
  let pending = $state<string[]>([])
  let executing = $state(false)

  async function load() {
    if (!cid) return
    loading = true
    error = null
    try {
      const [u, r, g, rg, dbs, cm] = await Promise.all([
        ipc.usersView(cid, 'users'),
        ipc.usersView(cid, 'roles').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, 'grants').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, 'role_grants').catch(() => ({ rows: [] as Row[] })),
        ipc.listSchemas(cid).catch(() => []),
        ipc.usersView(cid, 'can_manage').catch(() => ({ rows: [{ can_manage: true }] as Row[] })),
      ])
      users = u.rows
      roles = r.rows
      grants = g.rows
      roleGrants = rg.rows
      databases = dbs.map((s) => s.name)
      canManage = cm.rows[0]?.can_manage !== false && cm.rows[0]?.can_manage !== 0
      const list = kind === 'users' ? users : roles
      if (!selected || !list.some((x) => String(x.name) === selected)) selected = String(list[0]?.name ?? '')
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
  $effect(() => {
    void kind
    const list = kind === 'users' ? users : roles
    if (!list.some((x) => String(x.name) === selected)) untrack(() => (selected = String(list[0]?.name ?? '')))
  })

  // Grant-right-after-create: reload, select the new user/role, open the wizard.
  $effect(() => {
    const req = grantWizard.afterCreate
    if (req && req.connId === cid) untrack(() => void handleAfterCreate(req.principal))
  })
  async function handleAfterCreate(principal: string) {
    grantWizard.afterCreate = null
    await load()
    if (users.some((x) => String(x.name) === principal)) kind = 'users'
    else if (roles.some((x) => String(x.name) === principal)) kind = 'roles'
    else return
    selected = principal
    detailTab = 'grants'
    openGrantWizard()
  }

  const list = $derived(kind === 'users' ? users : roles)
  const selectedRow = $derived(list.find((x) => String(x.name) === selected))
  const isReadOnly = (r: Row | undefined) => !!r && String(r.storage) !== 'local_directory'

  // ---- Grant grid (§1.8.2 — full columns, clickable, inherited) -------------
  type CellState = 'none' | 'direct' | 'partial' | 'inherited' | 'deny'
  function directGrant(who: 'user' | 'role', name: string, db: string, access: string): boolean {
    return grants.some(
      (g) =>
        String(g[who]) === name &&
        String(g.database) === db &&
        String(g.table) === '' &&
        (String(g.access_type) === access || String(g.access_type) === 'ALL'),
    )
  }
  function rolesOf(): string[] {
    return roleGrants.filter((r) => String(r.user) === selected).map((r) => String(r.granted_role_name))
  }
  function cellState(db: string, access: string): CellState {
    if (directGrant('user', selected, db, access)) return 'direct'
    if (rolesOf().some((r) => directGrant('role', r, db, access))) return 'inherited'
    return 'none'
  }
  function cellTip(db: string, access: string): string {
    if (cellState(db, access) === 'inherited') {
      const r = rolesOf().find((x) => directGrant('role', x, db, access))
      return `via role ${r ?? ''}`
    }
    return access
  }

  // ---- Access overview (native: SQL RBAC, system.grants) ---------------------
  // ClickHouse keeps all grants in system.grants (one place). Group by database
  // → access types, folding in privileges inherited through granted roles.
  type ChDbAccess = { db: string; accesses: string[]; inherited: boolean; tableScoped: boolean }
  const chAccess = $derived.by<ChDbAccess[]>(() => {
    const inheritedRoles = kind === 'users' ? rolesOf() : []
    const map = new Map<string, ChDbAccess>()
    const ensure = (db: string) => {
      let e = map.get(db)
      if (!e) { e = { db, accesses: [], inherited: false, tableScoped: false }; map.set(db, e) }
      return e
    }
    for (const g of grants) {
      const directUser = kind === 'users' && String(g.user) === selected
      const directRole = kind === 'roles' && String(g.role) === selected
      const viaRole = kind === 'users' && String(g.role) !== '' && inheritedRoles.includes(String(g.role))
      if (!directUser && !directRole && !viaRole) continue
      const db = String(g.database) || '*'
      const e = ensure(db)
      const at = String(g.access_type)
      if (!e.accesses.includes(at)) e.accesses.push(at)
      if (String(g.table) !== '') e.tableScoped = true
      if (viaRole && !directUser && !directRole) e.inherited = true
    }
    return [...map.values()].sort((a, b) => (a.db === '*' ? -1 : b.db === '*' ? 1 : a.db.localeCompare(b.db)))
  })
  function onCell(db: string, access: string, st: CellState) {
    if (!selected) return
    pending = [...pending, st === 'none' || st === 'partial' ? grantColumn(db, access, selected) : revokeColumn(db, access, selected)]
  }
  const gridScopes = $derived(databases.map((d) => ({ value: d, label: d })))
  const gridPresets = [
    { kind: 'read-only', label: 'R' },
    { kind: 'read-write', label: 'RW' },
    { kind: 'full', label: 'Full' },
    { kind: 'revoke-all', label: 'Revoke', danger: true },
  ]

  let showMatrix = $state(false)
  function openGrantWizard() {
    if (!selected || !cid) return
    const c = cid
    const who = selected
    grantWizard.show({
      title: 'Grant access',
      role: who,
      // Database → Table: pick a database (or *), then the whole database (db.*)
      // or a specific table (db.table). ClickHouse has no DENY (Grant/Revoke).
      scopeLabel: 'Database / table',
      scopes: [],
      scope2Label: 'Database',
      scopes2: ['*', ...databases],
      scope2Default: [],
      loadScopes: async (dbs) => {
        const out: string[] = []
        for (const db of dbs) {
          if (db === '*') {
            out.push('*') // ON *.* (all databases)
            continue
          }
          out.push(`${db}.*`) // whole database
          const tbls = await ipc.listTables(c, db).catch(() => [])
          for (const t of tbls) out.push(`${db}.${t.name}`)
        }
        return out
      },
      levels: [
        { kind: 'read-only', label: 'Read-only', desc: 'SELECT' },
        { kind: 'read-write', label: 'Read-Write', desc: 'SELECT + INSERT + ALTER UPDATE/DELETE (mutations)' },
        { kind: 'full', label: 'Full', desc: 'ALL' },
      ],
      actions: [
        { kind: 'grant', label: 'Grant' },
        { kind: 'revoke', label: 'Revoke', danger: true },
      ],
      build: (kind, scope, extra) => [accessStatement(extra?.action === 'revoke' ? 'revoke' : 'grant', kind, scope, who)],
      onApply: (stmts) => (pending = [...pending, ...stmts]),
    })
  }

  function applyPreset(db: string, k: PresetKind) {
    if (!selected) return
    pending = [...pending, dbPreset(k, db, selected)]
  }

  // ---- General --------------------------------------------------------------
  let newPassword = $state('')
  function queuePassword() {
    if (!selected || !newPassword) return
    pending = [...pending, alterUserPassword(selected, 'sha256_password', newPassword)]
    newPassword = ''
  }
  let confirmDrop = $state(false)
  function queueDrop() {
    if (!selected) return
    pending = [...pending, kind === 'users' ? dropUser(selected) : dropRole(selected)]
    confirmDrop = false
  }

  // Quick drop from the list (context menu / row button).
  let dropTarget = $state<string | null>(null)
  let dropping = $state(false)
  async function doDrop() {
    if (!cid || !dropTarget || dropping) return
    dropping = true
    try {
      const res = await ipc.execStatement(cid, kind === 'users' ? dropUser(dropTarget) : dropRole(dropTarget), 0)
      if (!res.ok) {
        toasts.error(res.error?.message ?? 'error')
        return
      }
      toasts.success(`Dropped ${dropTarget}`, 'clickhouse')
      dropTarget = null
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      dropping = false
    }
  }

  // ---- Roles (for users) ----------------------------------------------------
  let grantRoleName = $state('')
  const grantedRoles = $derived(
    roleGrants.filter((rg) => String(rg.user) === selected).map((rg) => String(rg.granted_role_name)),
  )
  function queueGrantRole() {
    if (!selected || !grantRoleName) return
    pending = [...pending, grantRole(grantRoleName, selected)]
    grantRoleName = ''
  }
  function queueRevokeRole(role: string) {
    if (!selected) return
    pending = [...pending, revokeRole(role, selected)]
  }
  function queueDefaultRole(role: string) {
    if (!selected) return
    pending = [...pending, setDefaultRole(role, selected)]
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
      toasts.success('Applied', 'clickhouse')
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
    <div style="display:flex;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden">
      {#each [['users', 'Users'], ['roles', 'Roles']] as [k, label] (k)}
        <span onclick={() => (kind = k as typeof kind)} onkeydown={(e) => e.key === 'Enter' && (kind = k as typeof kind)} role="button" tabindex="0" style="padding:var(--px-4) var(--px-12);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{kind === k ? 'var(--primary)' : 'transparent'};color:{kind === k ? 'var(--hex-fff)' : 'var(--text2)'}">{label}</span>
      {/each}
    </div>
    <span onclick={() => cid && chUserWizard.show(cid, kind === 'users' ? 'user' : 'role')} onkeydown={(e) => e.key === 'Enter' && cid && chUserWizard.show(cid, kind === 'users' ? 'user' : 'role')} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">+ New {kind === 'users' ? 'User' : 'Role'}</span>
    <span onclick={refresh} onkeydown={(e) => e.key === 'Enter' && refresh()} role="button" tabindex="0" aria-busy={refreshing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}">{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span>
  </div>

  {#if !canManage}
    <div style="flex:none;padding:var(--px-8) var(--px-14);background:var(--panel);border-bottom:var(--px-1) solid var(--border);color:var(--warn2);font-size:var(--px-11_5)">This connection lacks ACCESS MANAGEMENT — enable it (CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 or access_management in users.xml).</div>
  {/if}

  <div style="flex:1;display:flex;min-height:0">
    <div role="listbox" tabindex="-1" aria-label={kind} style="flex:none;width:var(--px-240);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
      {#if error}<div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else if loading}<div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
      {:else}
        {#each list as r (r.name)}
          {@const rn = String(r.name)}
          {@const sel = selected === rn}
          {@const ro = isReadOnly(r)}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <div onclick={() => (selected = rn)} onkeydown={(e) => e.key === 'Enter' && (selected = rn)} role="option" tabindex="0" aria-selected={sel} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{sel ? 'var(--grid-select)' : 'transparent'};color:{sel ? 'var(--hex-fff)' : 'var(--text)'}">
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis">{r.name}</span>
                {#if ro}<span title="defined in {r.storage}" style="font-size:var(--px-9);color:{sel ? 'var(--hex-fff)' : 'var(--muted)'}">{r.storage}</span>
                {:else}<span onclick={(e) => { e.stopPropagation(); dropTarget = rn }} onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); dropTarget = rn } }} role="button" tabindex="0" title="Drop {kind === 'users' ? 'user' : 'role'}" style="opacity:0.75;color:{sel ? 'var(--hex-fff)' : 'var(--error)'};font-size:var(--px-13);line-height:1;cursor:pointer">🗑</span>{/if}
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content>
              <ContextMenu.Item onclick={() => (selected = rn)}>Select</ContextMenu.Item>
              {#if !ro}<ContextMenu.Item onclick={() => (dropTarget = rn)}>Drop {kind === 'users' ? 'user' : 'role'}…</ContextMenu.Item>{/if}
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      {/if}
    </div>

    <div style="flex:1;display:flex;flex-direction:column;min-height:0">
      {#if selectedRow}
        {#if isReadOnly(selectedRow)}
          <div style="flex:none;padding:var(--px-8) var(--px-14);background:var(--panel);border-bottom:var(--px-1) solid var(--border);color:var(--muted);font-size:var(--px-11_5)">Read-only — “{selected}” is defined in {selectedRow.storage}, not SQL. Edit it in users.xml.</div>
        {/if}
        <div style="flex:none;display:flex;gap:var(--px-2);padding:var(--px-8) var(--px-12) 0;border-bottom:var(--px-1) solid var(--border)">
          {#each (kind === 'users' ? [['general', 'General'], ['grants', 'Grants'], ['access', 'Access'], ['roles', 'Roles']] : [['general', 'General'], ['grants', 'Grants'], ['access', 'Access']]) as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} style="padding:var(--px-6) var(--px-12);font-size:var(--px-12);cursor:pointer;font-weight:600;border-bottom:var(--px-2) solid {detailTab === k ? 'var(--primary)' : 'transparent'};color:{detailTab === k ? 'var(--text)' : 'var(--muted)'}">{label}</span>
          {/each}
        </div>
        <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
          {#if detailTab === 'general'}
            <table class="mono" style="border-collapse:collapse;font-size:var(--px-12);margin-bottom:var(--px-14)">
              <tbody>
                {#each (kind === 'users' ? [['Name', selectedRow.name], ['Storage', selectedRow.storage], ['Auth type', selectedRow.auth_type], ['Default database', selectedRow.default_database], ['Default roles', selectedRow.default_roles]] : [['Name', selectedRow.name], ['Storage', selectedRow.storage]]) as [k, v] (k)}
                  <tr><td style="padding:var(--px-3) var(--px-14) var(--px-3) 0;color:var(--text2);white-space:nowrap">{k}</td><td style="padding:var(--px-3) 0;color:var(--text)">{v}</td></tr>
                {/each}
              </tbody>
            </table>
            {#if kind === 'users' && !isReadOnly(selectedRow)}
              <div style="display:flex;gap:var(--px-6);align-items:flex-end;margin-bottom:var(--px-10)">
                <label style="font-size:var(--px-12);color:var(--text2)">Change password
                  <input type="password" bind:value={newPassword} class="mono" style="display:block;margin-top:var(--px-4);width:var(--px-220);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
                </label>
                <span onclick={queuePassword} onkeydown={(e) => e.key === 'Enter' && queuePassword()} role="button" tabindex="0" aria-disabled={!newPassword} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:{newPassword ? 'pointer' : 'not-allowed'};opacity:{newPassword ? 1 : 0.5}">Queue change</span>
              </div>
            {/if}
            {#if !isReadOnly(selectedRow)}
              {#if confirmDrop}
                <div style="display:flex;gap:var(--px-8);align-items:center;padding:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--error);border-radius:var(--px-6)">
                  <span style="font-size:var(--px-12);color:var(--error)">Drop {kind === 'users' ? 'user' : 'role'} “{selected}”?</span>
                  <span onclick={queueDrop} onkeydown={(e) => e.key === 'Enter' && queueDrop()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Queue drop</span>
                  <span onclick={() => (confirmDrop = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = false)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Cancel</span>
                </div>
              {:else}
                <span onclick={() => (confirmDrop = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDrop = true)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--error);border:var(--px-1) solid var(--error);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop {kind === 'users' ? 'user' : 'role'}…</span>
              {/if}
            {/if}
          {:else if detailTab === 'grants'}
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-10);flex-wrap:wrap">
              <span onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600">＋ Grant access…</span>
              <span style="font-size:var(--px-11);color:var(--muted)">Pick a database and an access level (Read-only / Read-Write / Full).</span>
            </div>
            <div onclick={() => (showMatrix = !showMatrix)} onkeydown={(e) => e.key === 'Enter' && (showMatrix = !showMatrix)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--text2);cursor:pointer;margin-bottom:var(--px-8);user-select:none">{showMatrix ? '▾' : '▸'} Advanced — grant matrix</div>
            {#if showMatrix}
            <PrivilegeGrid
              columns={CH_GRID_COLUMNS}
              scopes={gridScopes}
              {cellState}
              {cellTip}
              {onCell}
              presets={gridPresets}
              onPreset={(db, kind) => applyPreset(db, kind as PresetKind)}
              note="UPDATE/DELETE map to the ALTER UPDATE / ALTER DELETE privileges (mutations)."
            />
            {/if}
          {:else if detailTab === 'access'}
            <!-- Access overview: what this principal can access, per database -->
            <div style="font-size:var(--px-12);color:var(--text2);margin-bottom:var(--px-10)">What <span class="mono" style="color:var(--text);font-weight:600">{selected}</span> can access, per database{kind === 'users' ? ' (granted roles folded in)' : ''}.</div>
            {#if chAccess.length}
              <div style="display:flex;flex-direction:column;gap:var(--px-8)">
                {#each chAccess as d (d.db)}
                  <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden">
                    <div style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-10);background:var(--panel);border-bottom:var(--px-1) solid var(--border)">
                      <span class="mono" style="font-size:var(--px-12_5);font-weight:700;color:var(--text)">{d.db === '*' ? '*.* (all databases)' : d.db}</span>
                      {#if d.tableScoped}<span style="font-size:var(--px-10);color:var(--muted)">table-scoped grants</span>{/if}
                      {#if d.inherited}<span style="font-size:var(--px-10);color:var(--muted)">◐ inherited</span>{/if}
                    </div>
                    <div style="padding:var(--px-6) var(--px-10);display:flex;gap:var(--px-4);flex-wrap:wrap">
                      {#each d.accesses as a (a)}<span style="font-size:var(--px-10);color:var(--syntax-keyword);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-5)">{a}</span>{/each}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div style="font-size:var(--px-11_5);color:var(--muted)">No grants — this {kind === 'users' ? 'user' : 'role'} cannot access any database yet.</div>
            {/if}
          {:else}
            <!-- Roles (users only) -->
            <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-bottom:var(--px-6)">Granted roles</div>
            {#if grantedRoles.length}
              {#each grantedRoles as r (r)}
                <div style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-12);padding:var(--px-2) 0">
                  <span class="mono">{r}</span>
                  <span onclick={() => queueRevokeRole(r)} onkeydown={(e) => e.key === 'Enter' && queueRevokeRole(r)} role="button" tabindex="0" style="font-size:var(--px-10_5);color:var(--error);cursor:pointer">revoke</span>
                  <span onclick={() => queueDefaultRole(r)} onkeydown={(e) => e.key === 'Enter' && queueDefaultRole(r)} role="button" tabindex="0" style="font-size:var(--px-10_5);color:var(--text2);cursor:pointer">set default</span>
                </div>
              {/each}
            {:else}
              <div style="font-size:var(--px-11_5);color:var(--muted)">No roles granted.</div>
            {/if}
            <div style="display:flex;gap:var(--px-6);align-items:center;margin-top:var(--px-10)">
              <select bind:value={grantRoleName} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text);font-size:var(--px-12)">
                <option value="">— grant role —</option>
                {#each roles.filter((r) => !grantedRoles.includes(String(r.name))) as r (r.name)}<option value={String(r.name)}>{r.name}</option>{/each}
              </select>
              <span onclick={queueGrantRole} onkeydown={(e) => e.key === 'Enter' && queueGrantRole()} role="button" tabindex="0" aria-disabled={!grantRoleName} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:{grantRoleName ? 'pointer' : 'not-allowed'};opacity:{grantRoleName ? 1 : 0.5}">Queue grant</span>
            </div>
          {/if}
        </div>
      {:else if !loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Select a {kind === 'users' ? 'user' : 'role'}.</div>
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

{#if dropTarget}
  <DropConfirm name={dropTarget} kind={kind === 'users' ? 'user' : 'role'} busy={dropping} oncancel={() => (dropTarget = null)} onconfirm={doDrop} />
{/if}
