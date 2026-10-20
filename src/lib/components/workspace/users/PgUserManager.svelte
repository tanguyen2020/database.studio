<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  // PostgreSQL User Manager (U1). One principal type = role; "user" = role with
  // LOGIN, "group" = role without. Tabs: General (attributes + password + drop),
  // Membership (grant/revoke), Privileges (per-schema grid §1.8.3 with presets).
  // Every mutation builds SQL → preview → Execute (run sequentially, then reload
  // from introspection — never trust optimistic state).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import { toasts } from '$lib/stores/toast.svelte'
  import { pgRoleWizard } from '$lib/stores/pgrole.svelte'
  import { grantWizard, STANDARD_LEVELS } from '$lib/stores/grantwizard.svelte'
  import {
    alterPassword,
    alterRoleOptions,
    dropRole,
    grantColumn,
    grantMembership,
    PG_GRID_COLUMNS,
    revokeColumn,
    revokeMembership,
    schemaPreset,
    type PresetKind,
    type RoleOptions,
  } from '$lib/users/postgres'
  import PrivilegeGrid from './PrivilegeGrid.svelte'
  import PrincipalHeader from './PrincipalHeader.svelte'
  import ManagerHeader from './ManagerHeader.svelte'
  import PendingBar from './PendingBar.svelte'
  import DropConfirm from './DropConfirm.svelte'
  import Avatar from './Avatar.svelte'
  import Chevron from '$lib/components/Chevron.svelte'
  import './um.css'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  type Row = Record<string, unknown>
  let roles = $state<Row[]>([])
  let members = $state<Row[]>([])
  let tableGrants = $state<Row[]>([])
  let schemaGrants = $state<Row[]>([])
  let schemaOwners = $state<Row[]>([])
  let schemas = $state<string[]>([])
  let tablesBySchema = $state<Record<string, number>>({})
  let canManage = $state(true)
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let selected = $state<string>('')
  let detailTab = $state<'general' | 'membership' | 'privileges' | 'access' | 'default'>('general')
  let defaultAcl = $state<Row[]>([])

  // Pending mutation statements (built by the active tab), shown as a preview.
  // `db` targets another database on the same server (undefined = current DB);
  // execute() resolves a sub-connection per entry.
  type PendingStmt = { sql: string; db?: string }
  let pending = $state<PendingStmt[]>([])
  let executing = $state(false)
  // databases on the server (for multi-database grants); currentDb = connected one.
  let databases = $state<string[]>([])
  let currentDb = $state('')

  // Access overview — what the selected role can access, per database → schema.
  // Read from each database's own grant catalog via a sub-connection.
  type TablePriv = { priv: string; n: number }
  type SchemaAccess = { schema: string; schemaPrivs: string[]; tablePrivs: TablePriv[]; seqPrivs: string[]; inherited: boolean }
  type DbAccess = { db: string; current: boolean; error: string | null; schemas: SchemaAccess[]; loading?: boolean }
  let access = $state<DbAccess[]>([])
  let accessLoading = $state(false)

  const cid = $derived(tab.connectionId)

  async function load() {
    if (!cid) return
    loading = true
    error = null
    try {
      const [r, m, tg, sg, so, sc, cm] = await Promise.all([
        ipc.usersView(cid, 'roles'),
        ipc.usersView(cid, 'members').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, 'table_grants').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, 'schema_grants').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, 'schema_owners').catch(() => ({ rows: [] as Row[] })),
        ipc.listSchemas(cid).catch(() => []),
        ipc.usersView(cid, 'can_manage').catch(() => ({ rows: [{ can_manage: true }] as Row[] })),
      ])
      roles = r.rows
      members = m.rows
      tableGrants = tg.rows
      schemaGrants = sg.rows
      schemaOwners = so.rows
      ipc.usersView(cid, 'default_acl').then((d) => (defaultAcl = d.rows)).catch(() => (defaultAcl = []))
      ipc
        .listDatabases(cid)
        .then((dbs) => {
          databases = dbs.map((d) => d.name)
          currentDb = dbs.find((d) => d.current)?.name ?? databases[0] ?? ''
        })
        .catch(() => {
          databases = []
          currentDb = ''
        })
      schemas = sc.map((s) => s.name)
      canManage = cm.rows[0]?.can_manage !== false
      // table counts per schema for ✓ (100%) vs ■ (partial) cell state
      const counts: Record<string, number> = {}
      await Promise.all(
        schemas.map(async (s) => {
          const t = await ipc.listTables(cid, s).catch(() => [])
          counts[s] = t.filter((x) => x.kind === 'table' || x.kind === 'view').length
        }),
      )
      tablesBySchema = counts
      if (!selected || !roles.some((x) => String(x.name) === selected)) {
        const focus = (tab.state as { focus?: string }).focus
        selected = focus && roles.some((x) => String(x.name) === focus) ? focus : String(roles[0]?.name ?? '')
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

  // Grant-right-after-create: a create dialog cued the new principal → reload,
  // select it, switch to Privileges, and open the Grant Access wizard.
  $effect(() => {
    const req = grantWizard.afterCreate
    if (req && req.connId === cid) untrack(() => void handleAfterCreate(req.principal))
  })
  async function handleAfterCreate(principal: string) {
    grantWizard.afterCreate = null
    await load()
    if (roles.some((r) => String(r.name) === principal)) {
      selected = principal
      detailTab = 'privileges'
      openGrantWizard()
    }
  }

  const selectedRole = $derived(roles.find((r) => String(r.name) === selected))
  const isGroup = (r: Row) => r.rolcanlogin === false
  const boolY = (v: unknown) => v === true || v === 1 || v === '1' || v === 't'

  // ---- Privileges grid (§1.8.3 — full columns, clickable, inherited) --------
  type CellState = 'none' | 'direct' | 'partial' | 'inherited' | 'deny'
  const gcol = (key: string) => PG_GRID_COLUMNS.find((c) => c.key === key)!

  // roles the user inherits from (recursive over pg_auth_members).
  function rolesOf(user: string, seen = new Set<string>()): string[] {
    for (const m of members) {
      if (String(m.member) === user) {
        const r = String(m.role)
        if (!seen.has(r)) {
          seen.add(r)
          rolesOf(r, seen)
        }
      }
    }
    return [...seen]
  }

  // direct grant count for a (grantee, schema, column).
  function directOf(grantee: string, schema: string, key: string): { n: number; total: number } {
    const col = gcol(key)
    if (col.target === 'schema') {
      const has = schemaGrants.some(
        (g) => String(g.schema) === schema && String(g.grantee) === grantee && String(g.privilege_type) === col.priv,
      )
      return { n: has ? 1 : 0, total: 1 }
    }
    const seq = col.target === 'sequences'
    const n = tableGrants.filter(
      (g) =>
        String(g.schema) === schema &&
        String(g.grantee) === grantee &&
        String(g.privilege_type) === col.priv &&
        (seq ? String(g.kind) === 'S' : String(g.kind) !== 'S'),
    ).length
    return { n, total: seq ? (n > 0 ? n : 0) : (tablesBySchema[schema] ?? 0) }
  }

  function cellState(schema: string, key: string): CellState {
    const col = gcol(key)
    // EXECUTE defaults to PUBLIC in PostgreSQL → shown as inherited (read-only).
    if (col.target === 'functions') return 'inherited'
    const d = directOf(selected, schema, key)
    if (d.n > 0) {
      if (col.target === 'schema') return 'direct'
      return d.total > 0 && d.n >= d.total ? 'direct' : 'partial'
    }
    // inherited via a role the user is a member of
    if (rolesOf(selected).some((r) => directOf(r, schema, key).n > 0)) return 'inherited'
    return 'none'
  }
  function cellTip(schema: string, key: string): string {
    const col = gcol(key)
    if (col.target === 'functions') return 'EXECUTE via PUBLIC (PostgreSQL default)'
    const st = cellState(schema, key)
    if (st === 'inherited') {
      const r = rolesOf(selected).find((x) => directOf(x, schema, key).n > 0)
      return `via role ${r ?? ''}`
    }
    if (col.target !== 'schema') {
      const d = directOf(selected, schema, key)
      return `${col.tip} — ${d.n}/${d.total || '?'}`
    }
    return col.tip
  }
  function onCell(schema: string, key: string, st: CellState) {
    if (!selected) return
    pending = [...pending, { sql: st === 'none' || st === 'partial' ? grantColumn(schema, key, selected) : revokeColumn(schema, key, selected) }]
  }
  const gridScopes = $derived(schemas.map((s) => ({ value: s, label: s })))
  const gridPresets = [
    { kind: 'read-only', label: 'R' },
    { kind: 'read-write', label: 'RW' },
    { kind: 'read-write-execute', label: 'RW+X' },
    { kind: 'full', label: 'Full' },
    { kind: 'revoke-all', label: 'Revoke', danger: true },
  ]

  let futureTables = $state(true)
  let showMatrix = $state(false)
  // schema owner per (database, schema) — for ALTER DEFAULT PRIVILEGES on the
  // right owner in each database (future-tables). Filled by loadScopesFor.
  let ownersByDbSchema = $state<Record<string, string>>({})
  const OKEY = (db: string, schema: string) => `${db}\u0000${schema}`

  // Guided grant wizard — grouped by database: each selected database shows its
  // OWN schemas; grants build per (database, schema) and run on that database.
  function openGrantWizard() {
    if (!selected || !cid) return
    const c = cid
    const role = selected
    grantWizard.show({
      title: 'Grant access',
      role,
      scopeLabel: 'Schema',
      scopes: [],
      levels: STANDARD_LEVELS,
      scope2Label: 'Database',
      scopes2: databases,
      scope2Default: currentDb ? [currentDb] : [],
      // load THIS database's own schemas (+ their owners) via a sub-connection.
      loadScopesFor: async (db) => {
        const sub = db === currentDb ? c : await ipc.attachDatabase(c, db).catch(() => c)
        const [scs, so] = await Promise.all([
          ipc.listSchemas(sub).catch(() => []),
          ipc.usersView(sub, 'schema_owners').catch(() => ({ rows: [] as Row[] })),
        ])
        const owners: Record<string, string> = {}
        for (const r of so.rows) owners[OKEY(db, String(r.schema))] = String(r.owner)
        ownersByDbSchema = { ...ownersByDbSchema, ...owners }
        return scs.map((s) => s.name).sort()
      },
      build: (kind, schema, extra) => {
        const db = extra?.scope2 ?? currentDb
        const owner = ownersByDbSchema[OKEY(db, schema)]
        return schemaPreset(kind as PresetKind, schema, role, {
          futureTables,
          owner,
          owners: kind === 'revoke-all' ? [...new Set([owner, 'postgres'].filter(Boolean) as string[])] : undefined,
        })
      },
      // run each database's statements on a connection to that database.
      onApplyGrouped: (groups) =>
        (pending = [
          ...pending,
          ...groups.flatMap((g) => g.statements.map((sql) => ({ sql, db: g.scope2 === currentDb ? undefined : g.scope2 }))),
        ]),
    })
  }

  function ownerOf(schema: string): string | undefined {
    return schemaOwners.find((o) => String(o.schema) === schema)?.owner as string | undefined
  }

  function applyPreset(schema: string, kind: PresetKind) {
    if (!selected) return
    const owners = kind === 'revoke-all'
      ? [...new Set([ownerOf(schema), 'postgres'].filter(Boolean) as string[])]
      : undefined
    const stmts = schemaPreset(kind, schema, selected, { futureTables, owner: ownerOf(schema), owners })
    pending = [...pending, ...stmts.map((sql) => ({ sql }))]
  }

  // ---- General mutations ----------------------------------------------------
  let newPassword = $state('')
  function queuePassword() {
    if (!selected || !newPassword) return
    pending = [...pending, { sql: alterPassword(selected, newPassword) }]
    newPassword = ''
  }

  // Editable role attributes: toggling one queues an ALTER ROLE. Optimistically
  // reflect the new value on the selected row so the checkbox flips immediately.
  const ATTRS: { field: keyof RoleOptions; col: string; label: string; desc: string }[] = [
    { field: 'login', col: 'rolcanlogin', label: 'Can login', desc: 'Can sign in. Without it the role is a group that only bundles privileges.' },
    { field: 'superuser', col: 'rolsuper', label: 'Superuser', desc: 'Bypasses every permission check. Grant sparingly.' },
    { field: 'createrole', col: 'rolcreaterole', label: 'Create roles', desc: 'Can create, alter and drop other roles.' },
    { field: 'createdb', col: 'rolcreatedb', label: 'Create databases', desc: 'Can create new databases.' },
    { field: 'inherit', col: 'rolinherit', label: 'Inherit', desc: 'Automatically uses the privileges of the roles it is a member of.' },
    { field: 'replication', col: 'rolreplication', label: 'Replication', desc: 'Can start streaming replication and take base backups.' },
    { field: 'bypassrls', col: 'rolbypassrls', label: 'Bypass RLS', desc: 'Ignores row-level security policies.' },
  ]
  // role list search (client-side, by name)
  let listFilter = $state('')
  const shownRoles = $derived(roles.filter((r) => String(r.name).toLowerCase().includes(listFilter.trim().toLowerCase())))
  const loginRoles = $derived(shownRoles.filter((r) => !isGroup(r)))
  const groupRoles = $derived(shownRoles.filter((r) => isGroup(r)))
  function queueAttr(field: keyof RoleOptions, col: string, next: boolean) {
    if (!selected) return
    const sql = alterRoleOptions(selected, { [field]: next } as RoleOptions)
    if (!sql) return
    pending = [...pending, { sql }]
    // optimistic: reflect on the row so the toggle stays in sync until reload
    const r = roles.find((x) => String(x.name) === selected)
    if (r) r[col] = next
  }
  let newConnLimit = $state<number | null>(null)
  function queueConnLimit() {
    if (!selected || newConnLimit == null) return
    const sql = alterRoleOptions(selected, { connectionLimit: newConnLimit })
    if (sql) pending = [...pending, { sql }]
    newConnLimit = null
  }

  // ---- Membership -----------------------------------------------------------
  let grantRoleName = $state('')
  let grantAdmin = $state(false)
  const memberOf = $derived(members.filter((m) => String(m.member) === selected))
  const hasMembers = $derived(members.filter((m) => String(m.role) === selected))
  function queueGrantMembership() {
    if (!selected || !grantRoleName) return
    pending = [...pending, { sql: grantMembership(grantRoleName, selected, grantAdmin) }]
    grantRoleName = ''
    grantAdmin = false
  }
  function queueRevokeMembership(role: string) {
    if (!selected) return
    pending = [...pending, { sql: revokeMembership(role, selected) }]
  }

  // Drop from the role list / General tab (context menu / button) — confirm
  // then run DROP ROLE immediately and reload.
  let dropConfirm = $state<string | null>(null)
  let dropping = $state(false)
  async function doDropRole() {
    const name = dropConfirm
    if (!cid || !name || dropping) return
    dropping = true
    try {
      const res = await ipc.execStatement(cid, dropRole(name), 0)
      if (!res.ok) {
        toasts.error(res.error?.message ?? 'error')
        return
      }
      toasts.success(`Dropped ${name}`, 'postgres')
      if (selected === name) selected = ''
      dropConfirm = null
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      dropping = false
    }
  }

  // ---- Execute pending ------------------------------------------------------
  async function execute() {
    if (!cid || !pending.length || executing) return
    executing = true
    try {
      // cache one sub-connection per target database (attachDatabase returns the
      // base connId for the current DB, so no extra work in the common case).
      const connFor = new Map<string, string>()
      let done = 0
      for (const { sql, db } of pending) {
        let target = cid
        if (db) {
          if (!connFor.has(db)) connFor.set(db, await ipc.attachDatabase(cid, db).catch(() => cid))
          target = connFor.get(db) ?? cid
        }
        const res = await ipc.execStatement(target, sql, 0)
        if (!res.ok) {
          toasts.error(`${db ? `[${db}] ` : ''}${res.error?.message ?? 'error'}`)
          break
        }
        done++
      }
      // keep what failed (and everything after it) queued so it can be fixed and re-run
      if (done === pending.length) toasts.success(`Applied ${done} change${done === 1 ? '' : 's'}`, 'postgres')
      else if (done) toasts.show(`Applied ${done} of ${pending.length} changes — the rest stay pending`)
      pending = pending.slice(done)
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      executing = false
    }
  }
  function discard() {
    pending = []
  }

  // ---- Access overview (per database → schema → privileges) ------------------
  // Auto-loads when the Access tab is shown for a role. Reads each database's
  // own grant catalog (schema_grants + table_grants) via a sub-connection and
  // includes grants inherited through the role's memberships.
  $effect(() => {
    if (detailTab !== 'access') return
    void selected
    void currentDb
    untrack(() => void loadAccess())
  })

  // Read one database's grants for the selected principal (+ inherited roles).
  async function loadAccessOne(db: string, principals: Set<string>): Promise<DbAccess> {
    const current = db === currentDb
    try {
      const sub = await ipc.attachDatabase(cid!, db)
      const [sg, tg] = await Promise.all([
        ipc.usersView(sub, 'schema_grants').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(sub, 'table_grants').catch(() => ({ rows: [] as Row[] })),
      ])
      const bySchema = new Map<string, SchemaAccess>()
      const ensure = (s: string) => {
        let e = bySchema.get(s)
        if (!e) { e = { schema: s, schemaPrivs: [], tablePrivs: [], seqPrivs: [], inherited: false }; bySchema.set(s, e) }
        return e
      }
      for (const g of sg.rows) {
        if (!principals.has(String(g.grantee))) continue
        const e = ensure(String(g.schema))
        const p = String(g.privilege_type)
        if (!e.schemaPrivs.includes(p)) e.schemaPrivs.push(p)
        if (String(g.grantee) !== selected) e.inherited = true
      }
      const tblCount = new Map<string, Map<string, number>>()
      const seqSet = new Map<string, Set<string>>()
      for (const g of tg.rows) {
        if (!principals.has(String(g.grantee))) continue
        const s = String(g.schema)
        const p = String(g.privilege_type)
        const e = ensure(s)
        if (String(g.grantee) !== selected) e.inherited = true
        if (String(g.kind) === 'S') {
          if (!seqSet.has(s)) seqSet.set(s, new Set())
          seqSet.get(s)!.add(p)
        } else {
          if (!tblCount.has(s)) tblCount.set(s, new Map())
          const m = tblCount.get(s)!
          m.set(p, (m.get(p) ?? 0) + 1)
        }
      }
      for (const [s, m] of tblCount) ensure(s).tablePrivs = [...m].map(([priv, n]) => ({ priv, n }))
      for (const [s, set] of seqSet) ensure(s).seqPrivs = [...set]
      return { db, current, error: null, schemas: [...bySchema.values()].sort((a, b) => a.schema.localeCompare(b.schema)) }
    } catch (e) {
      return { db, current, error: String(e), schemas: [] }
    }
  }

  // Load across databases with bounded concurrency + progressive rendering, so
  // a server with many databases fills in fast instead of one-at-a-time.
  async function loadAccess() {
    if (!cid || !selected || !databases.length) {
      access = []
      return
    }
    accessLoading = true
    const principals = new Set<string>([selected, ...rolesOf(selected)])
    // current database first, then the rest alphabetically
    const order = [...databases].sort((a, b) => (a === currentDb ? -1 : b === currentDb ? 1 : a.localeCompare(b)))
    // seed placeholders (each shows "loading" until its result arrives)
    access = order.map((db) => ({ db, current: db === currentDb, error: null, schemas: [], loading: true }))
    let next = 0
    const CONCURRENCY = 6
    const worker = async () => {
      while (next < order.length) {
        const idx = next++
        const res = await loadAccessOne(order[idx], principals)
        access = access.map((a, j) => (j === idx ? res : a)) // progressive update
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, order.length) }, worker))
    } finally {
      accessLoading = false
    }
  }
</script>

<div class="um" style="flex:1;display:flex;flex-direction:column;min-height:0">
  <ManagerHeader system="postgres" connectionId={cid} title="Login/Group Roles" count={roles.length} countLabel={roles.length === 1 ? 'role' : 'roles'} {refreshing} onRefresh={refresh}>
    <span class="eg-btn primary" onclick={() => cid && pgRoleWizard.show(cid)} onkeydown={(e) => e.key === 'Enter' && cid && pgRoleWizard.show(cid)} role="button" tabindex="0" title="Create a login or group role"><Icon name="plus" size={12} />New role</span>
  </ManagerHeader>

  <!-- Model explainer — PostgreSQL merges "user" and "group" into one concept. -->
  <div class="um-callout">
    <Icon name="info" size={15} />
    <span>In PostgreSQL a <b>role</b> is both a user and a group. A <b>login role</b> can sign in; a <b>group role</b> has no login and bundles privileges. Make a role a <b>member</b> of a group to give it that group's access.</span>
  </div>
  {#if !canManage}
    <div class="um-callout warn">
      <Icon name="warning" size={15} />
      <span>You are connected without <b>CREATEROLE</b> or <b>SUPERUSER</b> — you can look around, but changes will probably be refused by the server.</span>
    </div>
  {/if}

  <div class="um-body" style="margin-top:var(--px-12);border-top:var(--px-1) solid var(--border)">
    <!-- Role list -->
    <div class="um-list">
      <div class="um-list-search">
        <input class="um-input" style="width:100%" placeholder="Search roles" bind:value={listFilter} aria-label="Search roles" spellcheck="false" />
      </div>
      <div class="um-list-scroll" role="listbox" tabindex="-1" aria-label="Login/Group Roles">
        {#if error}
          <div class="um-empty" style="color:var(--danger-solid)">{error}</div>
        {:else if loading && !roles.length}
          <div class="um-empty">Loading roles…</div>
        {:else if !shownRoles.length}
          <div class="um-empty">{roles.length ? 'No role matches your search.' : 'No roles yet.'}</div>
        {:else}
          {#each [{ label: 'Login roles', list: loginRoles }, { label: 'Group roles', list: groupRoles }] as grp (grp.label)}
            {#if grp.list.length}
              <div class="um-list-group">{grp.label} · {grp.list.length}</div>
              {#each grp.list as r (r.name)}
                {@const rn = String(r.name)}
                {@const sel = selected === rn}
                <ContextMenu.Root>
                  <ContextMenu.Trigger>
                    <div class="um-row" onclick={() => (selected = rn)} onkeydown={(e) => e.key === 'Enter' && (selected = rn)} role="option" tabindex="0" aria-selected={sel}>
                      <Avatar name={rn} group={isGroup(r)} size={28} />
                      <span class="um-row-text">
                        <span class="um-row-name">{r.name}</span>
                        <span class="um-row-sub">{isGroup(r) ? 'Group role' : 'Login role'}{boolY(r.rolcreaterole) && !boolY(r.rolsuper) ? ' · can create roles' : ''}</span>
                      </span>
                      {#if boolY(r.rolsuper)}<span class="um-badge warn">Superuser</span>{/if}
                      <span
                        class="um-row-act"
                        onclick={(e) => { e.stopPropagation(); dropConfirm = rn }}
                        onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); dropConfirm = rn } }}
                        role="button"
                        tabindex="0"
                        title="Drop role"
                        aria-label="Drop role {rn}"
                      ><Icon name="trash" size={13} /></span>
                    </div>
                  </ContextMenu.Trigger>
                  <ContextMenu.Content>
                    <ContextMenu.Item onclick={() => (selected = rn)}>Select</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => (dropConfirm = rn)}>Drop role…</ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Root>
              {/each}
            {/if}
          {/each}
        {/if}
      </div>
    </div>

    <!-- Detail -->
    <div class="um-detail">
      {#if selectedRole}
        <PrincipalHeader
          name={selected}
          group={isGroup(selectedRole)}
          subtitle={isGroup(selectedRole) ? 'Group role — bundles privileges, cannot sign in' : 'Login role — can sign in'}
          badges={[
            ...(boolY(selectedRole.rolsuper) ? [{ label: 'Superuser', tone: 'warn' as const }] : []),
            ...(boolY(selectedRole.rolcreaterole) ? [{ label: 'Create roles', tone: 'muted' as const }] : []),
            ...(boolY(selectedRole.rolcreatedb) ? [{ label: 'Create DB', tone: 'muted' as const }] : []),
          ]}
        >
          {#snippet actions()}
            <span class="eg-btn" onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0"><Icon name="key" size={12} />Grant access…</span>
            <span class="eg-btn um-ghost-danger" onclick={() => (dropConfirm = selected)} onkeydown={(e) => e.key === 'Enter' && (dropConfirm = selected)} role="button" tabindex="0"><Icon name="trash" size={12} />Drop role…</span>
          {/snippet}
        </PrincipalHeader>
        <div class="um-tabs" role="tablist">
          {#each [['general', 'General'], ['membership', 'Membership'], ['privileges', 'Privileges'], ['access', 'Access'], ['default', 'Default privileges']] as [k, label] (k)}
            <span class="um-tab" onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k}>{label}</span>
          {/each}
        </div>
        <div class="um-detail-scroll">
          {#if detailTab === 'general'}
            <!-- Attributes: toggling queues ALTER ROLE (pgAdmin-style) -->
            <div class="um-card">
              <div class="um-card-title">Attributes</div>
              <div class="um-card-desc">What this role is allowed to do on the server. Each change is queued as an ALTER ROLE and applied when you click Execute.</div>
              <div class="um-toggles">
                {#each ATTRS as a (a.field)}
                  <label class="um-toggle">
                    <span class="um-toggle-text"><span>{a.label}</span><span>{a.desc}</span></span>
                    <input type="checkbox" class="um-switch" disabled={!canManage} checked={boolY(selectedRole[a.col])} onchange={(e) => queueAttr(a.field, a.col, (e.currentTarget as HTMLInputElement).checked)} />
                  </label>
                {/each}
              </div>
            </div>
            <div class="um-card">
              <div class="um-card-title">Password &amp; limits</div>
              <div class="um-card-desc">Account expires: <b style="color:var(--text);font-weight:500">{selectedRole.valid_until || 'never'}</b></div>
              <div style="display:flex;flex-direction:column;gap:var(--px-14)">
                <div class="um-inline">
                  <label class="um-field" style="width:var(--px-300)">New password
                    <input type="password" bind:value={newPassword} class="um-input" placeholder="Leave empty to keep the current one" autocomplete="new-password" />
                  </label>
                  <span class="eg-btn" onclick={queuePassword} onkeydown={(e) => e.key === 'Enter' && queuePassword()} role="button" tabindex="0" aria-disabled={!newPassword}>Change password</span>
                </div>
                <div class="um-inline">
                  <label class="um-field" style="width:var(--px-160)">Connection limit
                    <input type="number" bind:value={newConnLimit} placeholder={String(selectedRole.rolconnlimit ?? -1)} class="um-input" />
                  </label>
                  <span class="eg-btn" onclick={queueConnLimit} onkeydown={(e) => e.key === 'Enter' && queueConnLimit()} role="button" tabindex="0" aria-disabled={newConnLimit == null}>Set limit</span>
                  <span class="um-field-hint" style="align-self:center">−1 means unlimited.</span>
                </div>
              </div>
            </div>
          {:else if detailTab === 'membership'}
            <div class="um-card">
              <div class="um-card-title">Member of</div>
              <div class="um-card-desc">Groups whose privileges <span class="mono" style="color:var(--text)">{selected}</span> receives{boolY(selectedRole.rolinherit) ? '' : ' (Inherit is off — it must SET ROLE to use them)'}.</div>
              {#if memberOf.length}
                <div class="um-items" style="margin-bottom:var(--px-12)">
                  {#each memberOf as m (m.role)}
                    <div class="um-item">
                      <Avatar name={String(m.role)} group size={22} />
                      <span class="mono" style="flex:1">{m.role}</span>
                      {#if boolY(m.admin_option)}<span class="um-badge info" title="Can grant this membership to others">Admin option</span>{/if}
                      <span class="um-link danger" onclick={() => queueRevokeMembership(String(m.role))} onkeydown={(e) => e.key === 'Enter' && queueRevokeMembership(String(m.role))} role="button" tabindex="0" style="font-size:var(--px-12)">Remove</span>
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="um-field-hint" style="margin-bottom:var(--px-12)">Not a member of any group yet.</div>
              {/if}
              <div class="um-inline">
                <label class="um-field" style="width:var(--px-252)">Add to group
                  <select bind:value={grantRoleName} class="um-select">
                    <option value="">Choose a role…</option>
                    {#each roles.filter((r) => String(r.name) !== selected) as r (r.name)}<option value={String(r.name)}>{r.name}</option>{/each}
                  </select>
                </label>
                <label class="um-checkline" style="align-self:center" title="Lets this role grant the membership to others"><input type="checkbox" class="um-check" bind:checked={grantAdmin} /> With admin option</label>
                <span class="eg-btn primary" onclick={queueGrantMembership} onkeydown={(e) => e.key === 'Enter' && queueGrantMembership()} role="button" tabindex="0" aria-disabled={!grantRoleName}>Add</span>
              </div>
            </div>
            {#if hasMembers.length}
              <div class="um-card">
                <div class="um-card-title">Members</div>
                <div class="um-card-desc">Roles that receive <span class="mono" style="color:var(--text)">{selected}</span>'s privileges.</div>
                <div class="um-items">
                  {#each hasMembers as m (m.member)}
                    <div class="um-item"><Avatar name={String(m.member)} size={22} /><span class="mono">{m.member}</span></div>
                  {/each}
                </div>
              </div>
            {/if}
          {:else if detailTab === 'privileges'}
            <!-- Guided grant (primary path) -->
            <div class="um-card" style="display:flex;align-items:center;gap:var(--px-14);flex-wrap:wrap">
              <span class="um-dlg-icon"><Icon name="key" size={18} /></span>
              <div style="flex:1;min-width:var(--px-200)">
                <div class="um-card-title">Grant access</div>
                <div style="font-size:var(--px-12);color:var(--muted);line-height:1.45">Pick one or more databases and schemas, then an access level (read-only, read-write…). To see what <span class="mono" style="color:var(--text2)">{selected}</span> already has everywhere, open
                  <span class="um-link" onclick={() => (detailTab = 'access')} onkeydown={(e) => e.key === 'Enter' && (detailTab = 'access')} role="button" tabindex="0">the Access tab →</span></div>
              </div>
              <span class="eg-btn primary" onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0" style="font-size:var(--px-12_5);padding:var(--px-6) var(--px-14)"><Icon name="plus" size={12} />Grant access…</span>
            </div>
            <!-- Advanced: full permission matrix (collapsed) -->
            <div class="um-disclosure" onclick={() => (showMatrix = !showMatrix)} onkeydown={(e) => e.key === 'Enter' && (showMatrix = !showMatrix)} role="button" tabindex="0" aria-expanded={showMatrix}><Chevron open={showMatrix} />Advanced — permission matrix <span style="font-weight:400;color:var(--muted)">(this database only)</span></div>
            {#if showMatrix}
              <label class="um-checkline" style="margin-bottom:var(--px-10)"><input type="checkbox" class="um-check" bind:checked={futureTables} /> Also apply to tables created later (ALTER DEFAULT PRIVILEGES)</label>
              <PrivilegeGrid
                columns={PG_GRID_COLUMNS.map((c) => ({ key: c.key, label: c.label, tip: c.tip }))}
                scopes={gridScopes}
                {cellState}
                {cellTip}
                {onCell}
                presets={gridPresets}
                onPreset={(s, kind) => applyPreset(s, kind as PresetKind)}
                note="EXECUTE on functions defaults to PUBLIC in PostgreSQL."
              />
            {/if}
          {:else if detailTab === 'access'}
            <!-- Access overview: what this role can access per database → schema -->
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-12);flex-wrap:wrap">
              <span style="font-size:var(--px-12_5);color:var(--text2)">What <span class="mono" style="color:var(--text);font-weight:600">{selected}</span> can access, per database → schema.</span>
              <span class="eg-btn" style="margin-left:auto" onclick={loadAccess} onkeydown={(e) => e.key === 'Enter' && loadAccess()} role="button" tabindex="0" aria-busy={accessLoading}><span class="refresh-glyph" class:um-spin={accessLoading}><Icon name="refresh" size={12} /></span>{accessLoading ? 'Loading…' : 'Refresh'}</span>
            </div>
            {#if boolY(selectedRole.rolsuper)}
              <div class="um-callout warn" style="margin:0 0 var(--px-12)"><Icon name="shield" size={15} /><span><b>Superuser</b> — full access to every database and schema. The grants below are in addition.</span></div>
            {/if}
            {#if accessLoading && !access.length}
              <div class="um-empty">Reading each database…</div>
            {:else if !access.length}
              <div class="um-empty">No databases found.</div>
            {:else}
              <div style="display:flex;flex-direction:column;gap:var(--px-10)">
                {#each access as d (d.db)}
                  <div class="um-card" style="padding:0;margin:0;overflow:hidden">
                    <div style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-14);background:var(--panel);border-bottom:var(--px-1) solid var(--border)">
                      <span style="color:{d.current ? 'var(--primary)' : 'var(--muted)'};display:inline-flex"><Icon name="database" size={14} /></span>
                      <span class="mono" style="font-size:var(--px-12_5);font-weight:600;color:var(--text)">{d.db}</span>
                      {#if d.current}<span class="um-badge info">current</span>{/if}
                      <span style="margin-left:auto;font-size:var(--px-11_5);color:var(--muted)">{d.loading ? 'Reading…' : d.schemas.length ? `${d.schemas.length} schema(s)` : ''}</span>
                    </div>
                    <div style="padding:var(--px-8) var(--px-14)">
                      {#if d.loading}
                        <div class="um-field-hint">Reading…</div>
                      {:else if d.error}
                        <div class="um-field-err">Could not read: {d.error}</div>
                      {:else if !d.schemas.length}
                        <div class="um-field-hint">No explicit privileges in this database.</div>
                      {:else}
                        {#each d.schemas as s (s.schema)}
                          <div style="display:flex;align-items:flex-start;gap:var(--px-10);padding:var(--px-5) 0;flex-wrap:wrap">
                            <span class="mono" style="font-size:var(--px-12);color:var(--text);min-width:var(--px-120);padding-top:var(--px-2)">{s.schema}</span>
                            <div style="display:flex;gap:var(--px-5);flex-wrap:wrap;flex:1">
                              {#each s.schemaPrivs as p (p)}<span class="um-chip role">{p}</span>{/each}
                              {#each s.tablePrivs as tp (tp.priv)}<span class="um-chip grant">{tp.priv} ×{tp.n}</span>{/each}
                              {#each s.seqPrivs as sp (sp)}<span class="um-chip seq">SEQ {sp}</span>{/each}
                              {#if s.inherited}<span title="granted via a role this role is a member of" class="um-badge muted">inherited</span>{/if}
                            </div>
                          </div>
                        {/each}
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
              <div class="um-field-hint" style="margin-top:var(--px-10)">Table privileges show a per-schema count (SELECT ×5 = on 5 tables). PostgreSQL grants CONNECT to PUBLIC by default, so a role can usually open every database; what it can actually read or change is the schema / table privileges above.</div>
            {/if}
          {:else}
            <!-- Default privileges (read-only, §2.3) — ALTER DEFAULT PRIVILEGES already granted -->
            <div class="um-card-desc">Privileges granted automatically on objects created later, by owner. Read-only here — set them with the "tables created later" option in Privileges.</div>
            {#each [defaultAcl.filter((d) => String(d.grantee) === selected)] as list (0)}
              {#if list.length}
                <div class="um-card" style="padding:0;overflow:hidden">
                  <table class="um-table">
                    <thead><tr>{#each ['Owner', 'Schema', 'Object type', 'Privilege', 'Grantable'] as h (h)}<th>{h}</th>{/each}</tr></thead>
                    <tbody>
                      {#each list as d (`${d.owner}:${d.schema}:${d.objtype}:${d.privilege_type}`)}
                        <tr>
                          <td class="mono">{d.owner}</td>
                          <td class="mono">{d.schema || '—'}</td>
                          <td style="color:var(--text2)">{d.objtype}</td>
                          <td><span class="um-chip grant">{d.privilege_type}</span></td>
                          <td style="color:var(--muted)">{d.is_grantable ? 'Yes' : ''}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else}
                <div class="um-empty">No default privileges for this role.</div>
              {/if}
            {/each}
          {/if}
        </div>
      {:else if !loading}
        <div class="um-empty" style="margin:auto">
          <div style="display:inline-flex;color:var(--muted);margin-bottom:var(--px-8)"><Icon name="users" size={28} /></div>
          <div style="font-size:var(--px-13);font-weight:600;color:var(--text)">Select a role</div>
          <div>Pick a role on the left to edit its attributes, memberships and privileges.</div>
        </div>
      {/if}

      <!-- Pending changes -->
      {#if pending.length}
        <PendingBar count={pending.length} sql={pending.map((s) => (s.db ? `-- database: ${s.db}\n` : '') + s.sql + ';').join('\n')} {executing} onExecute={execute} onDiscard={discard} />
      {/if}
    </div>
  </div>
</div>

{#if dropConfirm}
  <DropConfirm name={dropConfirm} kind="role" busy={dropping} note="If it owns objects or holds grants, PostgreSQL refuses — reassign or drop those first." oncancel={() => (dropConfirm = null)} onconfirm={doDropRole} />
{/if}
