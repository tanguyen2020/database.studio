<script lang="ts">
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
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
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
  import { CARD, CARD_TITLE, EXPLAINER } from './ui'
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
  const OKEY = (db: string, schema: string) => `${db} ${schema}`

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
  const ATTRS: { field: keyof RoleOptions; col: string; label: string }[] = [
    { field: 'login', col: 'rolcanlogin', label: 'Can login' },
    { field: 'superuser', col: 'rolsuper', label: 'Superuser' },
    { field: 'createrole', col: 'rolcreaterole', label: 'Create roles' },
    { field: 'createdb', col: 'rolcreatedb', label: 'Create databases' },
    { field: 'inherit', col: 'rolinherit', label: 'Inherit' },
    { field: 'replication', col: 'rolreplication', label: 'Replication' },
    { field: 'bypassrls', col: 'rolbypassrls', label: 'Bypass RLS' },
  ]
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
      }
      toasts.success('Applied', 'postgres')
      pending = []
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

<div class="mono" style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-12);font-weight:700">Login/Group Roles</span>
    <span style="font-size:var(--px-11);color:var(--muted)">{roles.length} roles</span>
    <span onclick={() => cid && pgRoleWizard.show(cid)} onkeydown={(e) => e.key === 'Enter' && cid && pgRoleWizard.show(cid)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">+ New Role</span>
    <span onclick={refresh} onkeydown={(e) => e.key === 'Enter' && refresh()} role="button" tabindex="0" aria-busy={refreshing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}">{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span>
  </div>

  <!-- Model explainer — PostgreSQL merges "user" and "group" into one concept. -->
  <div style={EXPLAINER}>
    In PostgreSQL a <b style="color:var(--text2)">role</b> is both a user and a group. A role with <b style="color:var(--text2)">LOGIN</b> (👤) can sign in; a role without it (👥) is a group used to bundle privileges. Grant a role <b style="color:var(--text2)">membership</b> in a group to let it inherit that group's access.
  </div>
  {#if !canManage}
    <div style="flex:none;padding:var(--px-8) var(--px-14);background:var(--panel);border-bottom:var(--px-1) solid var(--border);color:var(--warn2);font-size:var(--px-11_5)">Current role lacks CREATEROLE/SUPERUSER — management statements may fail.</div>
  {/if}

  <div style="flex:1;display:flex;min-height:0">
    <!-- Role list -->
    <div role="listbox" tabindex="-1" aria-label="Login/Group Roles" style="flex:none;width:var(--px-240);border-right:var(--px-1) solid var(--border);overflow:auto;min-height:0">
      {#if error}
        <div style="padding:var(--px-14);color:var(--error);font-size:var(--px-12)">{error}</div>
      {:else if loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Loading…</div>
      {:else}
        {#each roles as r (r.name)}
          {@const rn = String(r.name)}
          {@const sel = selected === rn}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <div onclick={() => (selected = rn)} onkeydown={(e) => e.key === 'Enter' && (selected = rn)} role="option" tabindex="0" aria-selected={sel} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-6) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{sel ? 'var(--grid-select)' : 'transparent'};color:{sel ? 'var(--hex-fff)' : 'var(--text)'}">
                <span title={isGroup(r) ? 'Group role' : 'Login role'}>{isGroup(r) ? '👥' : '👤'}</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis">{r.name}</span>
                {#if boolY(r.rolsuper)}<span style="font-size:var(--px-9);font-weight:700;color:{sel ? 'var(--hex-fff)' : 'var(--warn2)'}">SUPER</span>{/if}
                <span
                  onclick={(e) => { e.stopPropagation(); dropConfirm = rn }}
                  onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); dropConfirm = rn } }}
                  role="button"
                  tabindex="0"
                  title="Drop role"
                  style="opacity:0.75;color:{sel ? 'var(--hex-fff)' : 'var(--error)'};font-size:var(--px-13);line-height:1;cursor:pointer"
                >🗑</span>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content>
              <ContextMenu.Item onclick={() => (selected = rn)}>Select</ContextMenu.Item>
              <ContextMenu.Item onclick={() => (dropConfirm = rn)}>Drop role…</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      {/if}
    </div>

    <!-- Detail -->
    <div style="flex:1;display:flex;flex-direction:column;min-height:0">
      {#if selectedRole}
        <div style="flex:none;padding:var(--px-12) var(--px-14) 0">
          <PrincipalHeader
            name={selected}
            icon={isGroup(selectedRole) ? '👥' : '👤'}
            subtitle={isGroup(selectedRole) ? 'Group role — bundles privileges (no login)' : 'Login role — can sign in'}
            badge={boolY(selectedRole.rolsuper) ? 'SUPERUSER' : ''}
            badgeDanger
          />
        </div>
        <div style="flex:none;display:flex;gap:var(--px-2);padding:var(--px-8) var(--px-12) 0;border-bottom:var(--px-1) solid var(--border)">
          {#each [['general', 'General'], ['membership', 'Membership'], ['privileges', 'Privileges'], ['access', 'Access'], ['default', 'Default privileges']] as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} style="padding:var(--px-6) var(--px-12);font-size:var(--px-12);cursor:pointer;font-weight:600;border-bottom:var(--px-2) solid {detailTab === k ? 'var(--primary)' : 'transparent'};color:{detailTab === k ? 'var(--text)' : 'var(--muted)'}">{label}</span>
          {/each}
        </div>
        <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
          {#if detailTab === 'general'}
            <!-- Attributes card: toggling queues ALTER ROLE (pgAdmin-style) -->
            <div style={CARD}>
              <div style={CARD_TITLE}>Attributes <span style="font-weight:400;color:var(--muted);font-size:var(--px-10_5)">— toggle to queue ALTER ROLE</span></div>
              <div style="display:flex;flex-direction:column;gap:var(--px-4)">
                {#each ATTRS as a (a.field)}
                  <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-7);cursor:pointer">
                    <input type="checkbox" disabled={!canManage} checked={boolY(selectedRole[a.col])} onchange={(e) => queueAttr(a.field, a.col, (e.currentTarget as HTMLInputElement).checked)} /> {a.label}
                  </label>
                {/each}
              </div>
            </div>
            <!-- Limits & password card -->
            <div style={CARD}>
              <div style={CARD_TITLE}>Limits &amp; password</div>
              <div style="display:flex;gap:var(--px-8);align-items:flex-end;margin-bottom:var(--px-10);flex-wrap:wrap">
                <label style="font-size:var(--px-11_5);color:var(--text2)">Connection limit
                  <input type="number" bind:value={newConnLimit} placeholder={String(selectedRole.rolconnlimit ?? -1)} class="mono" style="display:block;margin-top:var(--px-4);width:var(--px-110);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
                </label>
                <span onclick={queueConnLimit} onkeydown={(e) => e.key === 'Enter' && queueConnLimit()} role="button" tabindex="0" aria-disabled={newConnLimit == null} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:{newConnLimit == null ? 'not-allowed' : 'pointer'};opacity:{newConnLimit == null ? 0.5 : 1}">Queue limit</span>
                <span style="font-size:var(--px-11);color:var(--muted)">Valid until: {selectedRole.valid_until || '—'}</span>
              </div>
              <div style="display:flex;gap:var(--px-6);align-items:flex-end;flex-wrap:wrap">
                <label style="font-size:var(--px-11_5);color:var(--text2)">Change password
                  <input type="password" bind:value={newPassword} class="mono" style="display:block;margin-top:var(--px-4);width:var(--px-220);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
                </label>
                <span onclick={queuePassword} onkeydown={(e) => e.key === 'Enter' && queuePassword()} role="button" tabindex="0" aria-disabled={!newPassword} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:{newPassword ? 'pointer' : 'not-allowed'};opacity:{newPassword ? 1 : 0.5}">Queue change</span>
              </div>
            </div>
            <span onclick={() => (dropConfirm = selected)} onkeydown={(e) => e.key === 'Enter' && (dropConfirm = selected)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--error);border:var(--px-1) solid var(--error);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Drop role…</span>
          {:else if detailTab === 'membership'}
            <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin-bottom:var(--px-6)">Member of</div>
            {#if memberOf.length}
              {#each memberOf as m (m.role)}
                <div style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-12);padding:var(--px-2) 0">
                  <span class="mono">{m.role}</span>
                  {#if boolY(m.admin_option)}<span style="font-size:var(--px-9);color:var(--muted)">ADMIN</span>{/if}
                  <span onclick={() => queueRevokeMembership(String(m.role))} onkeydown={(e) => e.key === 'Enter' && queueRevokeMembership(String(m.role))} role="button" tabindex="0" style="font-size:var(--px-10_5);color:var(--error);cursor:pointer">revoke</span>
                </div>
              {/each}
            {:else}
              <div style="font-size:var(--px-11_5);color:var(--muted)">Not a member of any role.</div>
            {/if}
            <div style="display:flex;gap:var(--px-6);align-items:center;margin-top:var(--px-10)">
              <select bind:value={grantRoleName} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text);font-size:var(--px-12)">
                <option value="">— grant membership in —</option>
                {#each roles.filter((r) => String(r.name) !== selected) as r (r.name)}<option value={String(r.name)}>{r.name}</option>{/each}
              </select>
              <label style="font-size:var(--px-11_5);color:var(--text2);display:flex;align-items:center;gap:var(--px-4)"><input type="checkbox" bind:checked={grantAdmin} /> admin</label>
              <span onclick={queueGrantMembership} onkeydown={(e) => e.key === 'Enter' && queueGrantMembership()} role="button" tabindex="0" aria-disabled={!grantRoleName} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:{grantRoleName ? 'pointer' : 'not-allowed'};opacity:{grantRoleName ? 1 : 0.5}">Queue grant</span>
            </div>
            {#if hasMembers.length}
              <div style="font-size:var(--px-12);color:var(--text2);font-weight:600;margin:var(--px-12) 0 var(--px-6)">Members</div>
              {#each hasMembers as m (m.member)}<div class="mono" style="font-size:var(--px-12);padding:var(--px-2) 0">{m.member}</div>{/each}
            {/if}
          {:else if detailTab === 'privileges'}
            <!-- Guided grant (primary path) -->
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-8);flex-wrap:wrap">
              <span onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600">＋ Grant access…</span>
              <span style="font-size:var(--px-11);color:var(--muted)">Pick database(s) → schema(s) → access level.</span>
            </div>
            <!-- #3: where the role already has grants, across databases → Access tab -->
            <div style="font-size:var(--px-11);color:var(--muted);margin-bottom:var(--px-10)">To see which databases / schemas <span class="mono" style="color:var(--text2)">{selected}</span> is already granted on, open
              <span onclick={() => (detailTab = 'access')} onkeydown={(e) => e.key === 'Enter' && (detailTab = 'access')} role="button" tabindex="0" style="color:var(--primary);cursor:pointer;font-weight:600">the Access tab →</span>
              The matrix below covers the current database only.
            </div>
            <!-- Advanced: full permission matrix (collapsed) -->
            <div onclick={() => (showMatrix = !showMatrix)} onkeydown={(e) => e.key === 'Enter' && (showMatrix = !showMatrix)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--text2);cursor:pointer;margin-bottom:var(--px-8);user-select:none">{showMatrix ? '▾' : '▸'} Advanced — permission matrix</div>
            {#if showMatrix}
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-8);flex-wrap:wrap">
              <label style="font-size:var(--px-11_5);color:var(--text2);display:flex;align-items:center;gap:var(--px-4)"><input type="checkbox" bind:checked={futureTables} /> Also apply to future tables (ALTER DEFAULT PRIVILEGES)</label>
            </div>
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
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-10);flex-wrap:wrap">
              <span style="font-size:var(--px-12);color:var(--text2)">What <span class="mono" style="color:var(--text);font-weight:600">{selected}</span> can access, per database → schema.</span>
              <span onclick={loadAccess} onkeydown={(e) => e.key === 'Enter' && loadAccess()} role="button" tabindex="0" aria-busy={accessLoading} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{accessLoading ? 0.6 : 1}">{accessLoading ? '⟳ Loading…' : '⟳ Refresh'}</span>
            </div>
            {#if boolY(selectedRole.rolsuper)}
              <div style="font-size:var(--px-11_5);color:var(--warn2);margin-bottom:var(--px-8)">★ Superuser — full access to every database and schema (grants below are in addition).</div>
            {/if}
            {#if accessLoading && !access.length}
              <div style="font-size:var(--px-11_5);color:var(--muted)">Reading each database…</div>
            {:else if !access.length}
              <div style="font-size:var(--px-11_5);color:var(--muted)">No databases found.</div>
            {:else}
              <div style="display:flex;flex-direction:column;gap:var(--px-10)">
                {#each access as d (d.db)}
                  <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden">
                    <div style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-6) var(--px-10);background:var(--panel);border-bottom:var(--px-1) solid var(--border)">
                      <span style="color:{d.current ? 'var(--primary)' : 'var(--muted)'};font-size:var(--px-11)">{d.current ? '●' : '○'}</span>
                      <span class="mono" style="font-size:var(--px-12_5);font-weight:700;color:var(--text)">{d.db}</span>
                      {#if d.current}<span style="font-size:var(--px-10);color:var(--muted)">current</span>{/if}
                      <span style="margin-left:auto;font-size:var(--px-10_5);color:var(--muted)">{d.loading ? '…' : d.schemas.length ? `${d.schemas.length} schema(s)` : ''}</span>
                    </div>
                    <div style="padding:var(--px-6) var(--px-10)">
                      {#if d.loading}
                        <div style="font-size:var(--px-11);color:var(--muted)">Reading…</div>
                      {:else if d.error}
                        <div style="font-size:var(--px-11);color:var(--error)">Could not read: {d.error}</div>
                      {:else if !d.schemas.length}
                        <div style="font-size:var(--px-11);color:var(--muted)">— no explicit privileges in this database</div>
                      {:else}
                        {#each d.schemas as s (s.schema)}
                          <div style="display:flex;align-items:flex-start;gap:var(--px-8);padding:var(--px-3) 0;flex-wrap:wrap">
                            <span class="mono" style="font-size:var(--px-12);color:var(--text);min-width:var(--px-110)">{s.schema}</span>
                            <div style="display:flex;gap:var(--px-4);flex-wrap:wrap;flex:1">
                              {#each s.schemaPrivs as p (p)}<span style="font-size:var(--px-10);color:var(--syntax-keyword);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-5)">{p}</span>{/each}
                              {#each s.tablePrivs as tp (tp.priv)}<span style="font-size:var(--px-10);color:var(--syntax-number);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-5)">{tp.priv} ×{tp.n}</span>{/each}
                              {#each s.seqPrivs as sp (sp)}<span style="font-size:var(--px-10);color:var(--syntax-type);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-4);padding:0 var(--px-5)">SEQ {sp}</span>{/each}
                              {#if s.inherited}<span title="granted via a role this role is a member of" style="font-size:var(--px-10);color:var(--muted)">◐ inherited</span>{/if}
                            </div>
                          </div>
                        {/each}
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
              <div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">Table privileges show a per-schema count (e.g. SELECT ×5 = on 5 tables). PostgreSQL grants CONNECT to PUBLIC by default, so a role can usually open every database; what it can actually read/write is the schema/table privileges above.</div>
            {/if}
          {:else}
            <!-- Default privileges (read-only, §2.3) — ALTER DEFAULT PRIVILEGES already granted -->
            <div style="font-size:var(--px-11);color:var(--muted);margin-bottom:var(--px-8)">Privileges automatically granted on objects created LATER, by owner. (Read-only — set via the future-tables checkbox in Privileges.)</div>
            {#each [defaultAcl.filter((d) => String(d.grantee) === selected)] as list (0)}
              {#if list.length}
                <table class="mono" style="border-collapse:collapse;font-size:var(--px-12)">
                  <thead><tr>{#each ['Owner', 'Schema', 'Object type', 'Privilege', 'Grantable'] as h (h)}<th style="text-align:left;padding:var(--px-4) var(--px-12) var(--px-4) 0;color:var(--text2);border-bottom:var(--px-1) solid var(--border2)">{h}</th>{/each}</tr></thead>
                  <tbody>
                    {#each list as d (`${d.owner}:${d.schema}:${d.objtype}:${d.privilege_type}`)}
                      <tr>
                        <td style="padding:var(--px-3) var(--px-12) var(--px-3) 0;color:var(--text)">{d.owner}</td>
                        <td style="padding:var(--px-3) var(--px-12) var(--px-3) 0;color:var(--text)">{d.schema || '—'}</td>
                        <td style="padding:var(--px-3) var(--px-12) var(--px-3) 0;color:var(--text2)">{d.objtype}</td>
                        <td style="padding:var(--px-3) var(--px-12) var(--px-3) 0;color:var(--text)">{d.privilege_type}</td>
                        <td style="padding:var(--px-3) 0;color:var(--muted)">{d.is_grantable ? 'yes' : ''}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {:else}
                <div style="font-size:var(--px-11_5);color:var(--muted)">No default privileges for this role.</div>
              {/if}
            {/each}
          {/if}
        </div>
      {:else if !loading}
        <div style="padding:var(--px-14);color:var(--muted);font-size:var(--px-12)">Select a role.</div>
      {/if}

      <!-- Pending changes -->
      {#if pending.length}
        <div style="flex:none;border-top:var(--px-1) solid var(--border);background:var(--panel);padding:var(--px-10) var(--px-14);max-height:var(--px-220);overflow:auto">
          <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-6)">
            <span style="font-size:var(--px-11_5);font-weight:700;color:var(--text2)">Pending changes ({pending.length})</span>
            <span onclick={execute} onkeydown={(e) => e.key === 'Enter' && execute()} role="button" tabindex="0" aria-disabled={executing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer;font-weight:600;opacity:{executing ? 0.6 : 1}">{executing ? 'Executing…' : 'Execute'}</span>
            <span onclick={discard} onkeydown={(e) => e.key === 'Enter' && discard()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer">Discard</span>
          </div>
          <pre class="selectable mono" style="margin:0;font-size:var(--px-11);white-space:pre-wrap;color:var(--text2)">{#each pending as s (s)}{#each highlightSql((s.db ? `-- database: ${s.db}\n` : '') + s.sql + ';\n') as tk (tk)}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}{/each}</pre>
        </div>
      {/if}
    </div>
  </div>
</div>

{#if dropConfirm}
  <div onkeydown={(e) => { if (e.key === 'Escape') dropConfirm = null; if (e.key === 'Enter') void doDropRole() }} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:58">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-420);max-width:92vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-12);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);padding:var(--px-18)">
      <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">Drop role</div>
      <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">Drop role <span class="mono" style="color:var(--text);font-weight:600">{dropConfirm}</span>? This cannot be undone. (If it owns objects or holds grants, PostgreSQL will error — reassign / drop those first.)</div>
      <div style="display:flex;gap:var(--px-9);justify-content:flex-end">
        <span onclick={() => (dropConfirm = null)} onkeydown={(e) => e.key === 'Enter' && (dropConfirm = null)} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={doDropRole} onkeydown={(e) => e.key === 'Enter' && doDropRole()} role="button" tabindex="0" aria-disabled={dropping} style="font-size:var(--px-12_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{dropping ? 'not-allowed' : 'pointer'};opacity:{dropping ? 0.6 : 1};font-weight:600">{dropping ? 'Dropping…' : 'Drop role'}</span>
      </div>
    </div>
  </div>
{/if}
