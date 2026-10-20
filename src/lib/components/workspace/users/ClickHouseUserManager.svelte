<script lang="ts">
  import './um.css'
  import PendingBar from './PendingBar.svelte'
  import Icon from '$lib/components/Icon.svelte'
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
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
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
  import PrincipalHeader from './PrincipalHeader.svelte'
  import ManagerHeader from './ManagerHeader.svelte'
  import Avatar from './Avatar.svelte'
  import { CARD, CARD_TITLE, EXPLAINER } from './ui'
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
  let listFilter = $state('')
  const shownList = $derived(list.filter((r) => String(r.name).toLowerCase().includes(listFilter.trim().toLowerCase())))
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

<div class="um" style="flex:1;display:flex;flex-direction:column;min-height:0">
  <ManagerHeader system="clickhouse" connectionId={cid} title="Access control" count={list.length} countLabel={kind === 'users' ? (list.length === 1 ? 'user' : 'users') : list.length === 1 ? 'role' : 'roles'} {refreshing} onRefresh={refresh}>
    <div class="um-seg" role="group" aria-label="Show">
      {#each [['users', 'Users'], ['roles', 'Roles']] as [k, label] (k)}
        <span aria-pressed={kind === k} onclick={() => (kind = k as typeof kind)} onkeydown={(e) => e.key === 'Enter' && (kind = k as typeof kind)} role="button" tabindex="0">{label}</span>
      {/each}
    </div>
    <span class="eg-btn primary" onclick={() => cid && chUserWizard.show(cid, kind === 'users' ? 'user' : 'role')} onkeydown={(e) => e.key === 'Enter' && cid && chUserWizard.show(cid, kind === 'users' ? 'user' : 'role')} role="button" tabindex="0"><Icon name="plus" size={12} />New {kind === 'users' ? 'user' : 'role'}</span>
  </ManagerHeader>

  <!-- Model explainer — ClickHouse SQL RBAC vs read-only users.xml principals. -->
  <div class="um-callout"><Icon name="info" size={15} /><span>Users created with <b>SQL</b> are editable here; users defined in the server's <b>users.xml</b> are read-only. <b>Roles</b> bundle grants — give a role to a user and make it a default role to apply it.</span></div>

  {#if !canManage}
    <div class="um-callout warn"><Icon name="warning" size={15} /><span>This connection's user has no <b>ACCESS MANAGEMENT</b> right, so changes will be refused. Enable it with <span class="mono">CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1</span> or <span class="mono">access_management</span> in users.xml.</span></div>
  {/if}

  <div class="um-body" style="margin-top:var(--px-12);border-top:var(--px-1) solid var(--border)">
    <div class="um-list"><div class="um-list-search"><input class="um-input" style="width:100%" placeholder="Search {kind}" bind:value={listFilter} aria-label="Search {kind}" spellcheck="false" /></div>
    <div class="um-list-scroll" role="listbox" tabindex="-1" aria-label={kind}>
      {#if error}<div class="um-empty" style="color:var(--danger-solid)">{error}</div>
      {:else if loading && !list.length}<div class="um-empty">Loading…</div>
      {:else if !shownList.length}<div class="um-empty">{list.length ? 'Nothing matches your search.' : kind === 'users' ? 'No users yet.' : 'No roles yet.'}</div>
      {:else}
        {#each shownList as r (r.name)}
          {@const rn = String(r.name)}
          {@const sel = selected === rn}
          {@const ro = isReadOnly(r)}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <div class="um-row" onclick={() => (selected = rn)} onkeydown={(e) => e.key === 'Enter' && (selected = rn)} role="option" tabindex="0" aria-selected={sel}>
                <Avatar name={rn} group={kind === 'roles'} size={28} />
                <span class="um-row-text"><span class="um-row-name">{r.name}</span><span class="um-row-sub">{kind === 'roles' ? 'Role' : ro ? 'Defined in server config' : 'SQL user'}</span></span>
                {#if ro}<span class="um-badge muted" title="defined in {r.storage} — read-only">{r.storage}</span>
                {:else}<span class="um-row-act" onclick={(e) => { e.stopPropagation(); dropTarget = rn }} onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); dropTarget = rn } }} role="button" tabindex="0" title="Drop {kind === 'users' ? 'user' : 'role'}" aria-label="Drop {rn}"><Icon name="trash" size={13} /></span>{/if}
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content>
              <ContextMenu.Item onclick={() => (selected = rn)}>Select</ContextMenu.Item>
              {#if !ro}<ContextMenu.Item onclick={() => (dropTarget = rn)}>Drop {kind === 'users' ? 'user' : 'role'}…</ContextMenu.Item>{/if}
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      {/if}
    </div></div>

    <div class="um-detail">
      {#if selectedRow}
        <PrincipalHeader
          name={selected}
          group={kind === 'roles'}
          subtitle={kind === 'users' ? (isReadOnly(selectedRow) ? `User defined in ${selectedRow.storage} — read-only` : 'SQL user — editable here') : 'Role — bundles grants for users'}
          badges={isReadOnly(selectedRow) ? [{ label: `Read-only · ${selectedRow.storage}`, tone: 'muted' }] : []}
        >
          {#snippet actions()}
            {#if !isReadOnly(selectedRow)}
              <span class="eg-btn um-ghost-danger" onclick={() => (dropTarget = selected)} onkeydown={(e) => e.key === 'Enter' && (dropTarget = selected)} role="button" tabindex="0"><Icon name="trash" size={12} />Drop {kind === 'users' ? 'user' : 'role'}…</span>
            {/if}
          {/snippet}
        </PrincipalHeader>
        {#if isReadOnly(selectedRow)}
          <div class="um-callout" style="margin:0 var(--px-20) var(--px-4)"><Icon name="lock" size={15} /><span>“{selected}” is defined in <b>{selectedRow.storage}</b>, not with SQL, so it can't be changed here. Edit it in the server configuration.</span></div>
        {/if}
        <div class="um-tabs" role="tablist">
          {#each (kind === 'users' ? [['general', 'General'], ['grants', 'Grants'], ['access', 'Access'], ['roles', 'Roles']] : [['general', 'General'], ['grants', 'Grants'], ['access', 'Access']]) as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} class="um-tab">{label}</span>
          {/each}
        </div>
        <div class="um-detail-scroll">
          {#if detailTab === 'general'}
            <div class="um-card">
              <div class="um-card-title">Details</div>
              <table class="mono" style="border-collapse:collapse;font-size:var(--px-12)">
                <tbody>
                  {#each (kind === 'users' ? [['Name', selectedRow.name], ['Storage', selectedRow.storage], ['Auth type', selectedRow.auth_type], ['Default database', selectedRow.default_database], ['Default roles', selectedRow.default_roles]] : [['Name', selectedRow.name], ['Storage', selectedRow.storage]]) as [k, v] (k)}
                    <tr><td style="padding:var(--px-3) var(--px-14) var(--px-3) 0;color:var(--text2);white-space:nowrap">{k}</td><td style="padding:var(--px-3) 0;color:var(--text)">{v}</td></tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if kind === 'users' && !isReadOnly(selectedRow)}
              <div class="um-card">
                <div class="um-card-title">Change password</div>
                <div style="display:flex;gap:var(--px-6);align-items:flex-end">
                  <label class="um-field" title="Sets a new SHA-256 password for this user">Change password
                    <input type="password" bind:value={newPassword} class="um-input" style="width:var(--px-220)" autocomplete="new-password" placeholder="New password" />
                  </label>
                  <span class="eg-btn" onclick={queuePassword} onkeydown={(e) => e.key === 'Enter' && queuePassword()} role="button" tabindex="0" aria-disabled={!newPassword} style="cursor:{newPassword ? 'pointer' : 'not-allowed'};opacity:{newPassword ? 1 : 0.5}">Change password</span>
                </div>
              </div>
            {/if}
          {:else if detailTab === 'grants'}
            <div class="um-card">
              <div class="um-card-title">Grants</div>
              <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-10);flex-wrap:wrap">
                <span class="cfm-btn primary" onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0" title="Grant access to a database or table at a chosen level"><Icon name="plus" size={12} />Grant access…</span>
                <span style="font-size:var(--px-11);color:var(--muted)">Pick a database and an access level (Read-only / Read-Write / Full).</span>
              </div>
              <div onclick={() => (showMatrix = !showMatrix)} onkeydown={(e) => e.key === 'Enter' && (showMatrix = !showMatrix)} role="button" tabindex="0" title="Show the full per-database × privilege matrix" style="font-size:var(--px-11_5);color:var(--text2);cursor:pointer;margin-bottom:var(--px-8);user-select:none">{showMatrix ? '▾' : '▸'} Advanced — grant matrix</div>
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
            </div>
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
                      {#if d.inherited}<span class="um-badge muted">inherited</span>{/if}
                    </div>
                    <div style="padding:var(--px-6) var(--px-10);display:flex;gap:var(--px-4);flex-wrap:wrap">
                      {#each d.accesses as a (a)}<span class="um-chip role">{a}</span>{/each}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="um-field-hint">No grants — this {kind === 'users' ? 'user' : 'role'} cannot access any database yet.</div>
            {/if}
          {:else}
            <!-- Roles (users only) -->
            <div class="um-card">
              <div class="um-card-title">Granted roles <span style="font-weight:400;color:var(--muted);font-size:var(--px-10_5)">— set one as default to apply it on login</span></div>
              {#if grantedRoles.length}
                {#each grantedRoles as r (r)}
                  <div style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-12);padding:var(--px-2) 0">
                    <span class="mono">{r}</span>
                    <span onclick={() => queueRevokeRole(r)} onkeydown={(e) => e.key === 'Enter' && queueRevokeRole(r)} role="button" tabindex="0" title="Revoke this role from the user" class="um-link danger" style="font-size:var(--px-12)">Remove</span>
                    <span onclick={() => queueDefaultRole(r)} onkeydown={(e) => e.key === 'Enter' && queueDefaultRole(r)} role="button" tabindex="0" title="Make this the user's default role" style="font-size:var(--px-10_5);color:var(--text2);cursor:pointer">set default</span>
                  </div>
                {/each}
              {:else}
                <div class="um-field-hint">No roles granted.</div>
              {/if}
              <div style="display:flex;gap:var(--px-6);align-items:center;margin-top:var(--px-10)">
                <select bind:value={grantRoleName} class="um-select mono">
                  <option value="">— grant role —</option>
                  {#each roles.filter((r) => !grantedRoles.includes(String(r.name))) as r (r.name)}<option value={String(r.name)}>{r.name}</option>{/each}
                </select>
                <span class="eg-btn" onclick={queueGrantRole} onkeydown={(e) => e.key === 'Enter' && queueGrantRole()} role="button" tabindex="0" aria-disabled={!grantRoleName} style="cursor:{grantRoleName ? 'pointer' : 'not-allowed'};opacity:{grantRoleName ? 1 : 0.5}">Grant</span>
              </div>
            </div>
          {/if}
        </div>
      {:else if !loading}
        <div class="um-empty" style="margin:auto"><div style="display:inline-flex;color:var(--muted);margin-bottom:var(--px-8)"><Icon name="users" size={28} /></div><div style="font-size:var(--px-13);font-weight:600;color:var(--text)">Select a {kind === 'users' ? 'user' : 'role'}</div><div>Pick one on the left to see and change its access.</div></div>
      {/if}

      {#if pending.length}
        <PendingBar count={pending.length} sql={pending.join('\n')} language={editorLanguageId('clickhouse')} {executing} onExecute={execute} onDiscard={discard} />
      {/if}
    </div>
  </div>
</div>

{#if dropTarget}
  <DropConfirm name={dropTarget} kind={kind === 'users' ? 'user' : 'role'} busy={dropping} oncancel={() => (dropTarget = null)} onconfirm={doDrop} />
{/if}
