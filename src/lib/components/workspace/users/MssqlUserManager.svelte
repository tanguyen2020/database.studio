<script lang="ts">
  import './um.css'
  import PendingBar from './PendingBar.svelte'
  import Icon from '$lib/components/Icon.svelte'
  // SQL Server User Manager (U3). Two tiers: Server (Logins + fixed server roles)
  // and Database (Users + Roles + permission grid with GRANT/DENY/REVOKE — DENY
  // wins over GRANT). Database-scoped reads/writes run on an attach_database
  // sub-connection. Mutations go through exec_statement → simple_query raw batch
  // (is_raw_batch covers CREATE/ALTER/DROP + GRANT/DENY/REVOKE).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import DropConfirm from './DropConfirm.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { mssqlUserWizard } from '$lib/stores/mssqluser.svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
  import {
    accessStatement,
    alterLoginPassword,
    createUser as createUserStmt,
    denyColumn,
    dropLogin,
    dropUser,
    grantColumn,
    MSSQL_GRID_COLUMNS,
    parseSecurable,
    revokeColumn,
    schemaPreset,
    setDbRoleMember,
    setLoginEnabled,
    setServerRoleMember,
    FIXED_SERVER_ROLES,
    type PresetKind,
  } from '$lib/users/mssql'
  import PrivilegeGrid from './PrivilegeGrid.svelte'
  import PrincipalHeader from './PrincipalHeader.svelte'
  import ManagerHeader from './ManagerHeader.svelte'
  import Avatar from './Avatar.svelte'
  import Chevron from '$lib/components/Chevron.svelte'
  import { CARD, CARD_TITLE, CHIP_ROLE, CHIP_GRANT, CHIP_DENY, BTN } from './ui'
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
  let currentDbName = $state('') // the connection's own (default) database
  let selectedDb = $state<string>('')
  let dbCid = $state<string>('') // sub-connection id for selectedDb
  let dbUsers = $state<Row[]>([])
  let dbRoleMembers = $state<Row[]>([])
  let dbPerms = $state<Row[]>([])
  let schemas = $state<string[]>([])
  let selectedUser = $state<string>('')

  // Database-users level shows a list grouped by database (transparent — you see
  // which database + default schema each user belongs to) instead of a dropdown.
  type DbUserRow = { name: string; schema: string; orphaned: boolean; login: string }
  let allDbUsers = $state<{ db: string; users: DbUserRow[] }[]>([])
  let dbUsersLoaded = $state(false)
  let dbUsersBusy = $state(false)
  let pendingUser = $state<string>('') // a click may pick a user in another DB

  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let pending = $state<string[]>([])
  let executing = $state(false)

  const boolY = (v: unknown) => v === true || v === 1 || v === '1' || v === 't'
  // login type in words (sys.server_principals.type_desc)
  const loginKind = (l: Row) => {
    const t = String(l.type_desc ?? '')
    return t === 'SQL_LOGIN' ? 'SQL Server login' : t === 'WINDOWS_LOGIN' ? 'Windows login' : t === 'WINDOWS_GROUP' ? 'Windows group' : t.startsWith('EXTERNAL') ? 'Microsoft Entra ID' : t ? t.toLowerCase().replace(/_/g, ' ') : 'Login'
  }
  let listFilter = $state('')
  const shownLogins = $derived(logins.filter((l) => String(l.name).toLowerCase().includes(listFilter.trim().toLowerCase())))

  // Plain-language help for the fixed roles (shown as tooltips).
  const SERVER_ROLE_HELP: Record<string, string> = {
    sysadmin: 'Full control of the entire server.',
    serveradmin: 'Configure server-wide settings and shut down the server.',
    securityadmin: 'Manage logins and GRANT/DENY server permissions.',
    processadmin: 'End running processes on the instance.',
    setupadmin: 'Add and remove linked servers.',
    bulkadmin: 'Run BULK INSERT operations.',
    diskadmin: 'Manage server disk files.',
    dbcreator: 'Create, alter, drop and restore any database.',
  }
  const DB_ROLE_HELP: Record<string, string> = {
    db_datareader: 'Read data from all user tables and views.',
    db_datawriter: 'Insert, update and delete data in all user tables.',
  }
  const QUICK_DB_ROLES = ['db_datareader', 'db_datawriter']

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
    currentDbName = databases.find((d) => (dbs.find((x) => x.name === d) as { current?: boolean })?.current) ?? ''
    if (!selectedDb && databases.length) selectedDb = currentDbName || databases[0]
  }

  // Load every database's users once, so the list can be grouped by database.
  async function loadAllDbUsers() {
    if (!baseCid || dbUsersBusy) return
    dbUsersBusy = true
    const out: { db: string; users: DbUserRow[] }[] = []
    try {
      for (const db of databases) {
        const sub = await ipc.attachDatabase(baseCid, db).catch(() => baseCid!)
        const u = await ipc.usersView(sub, 'db_users').catch(() => ({ rows: [] as Row[] }))
        const users = u.rows.map((r) => ({
          name: String(r.name),
          schema: String(r.default_schema || 'dbo'),
          orphaned: boolY(r.orphaned),
          login: String(r.login_name ?? ''),
        }))
        out.push({ db, users })
      }
      allDbUsers = out
      dbUsersLoaded = true
    } finally {
      dbUsersBusy = false
    }
  }

  // Select a user, possibly in a different database than the one loaded.
  function selectDbUser(db: string, name: string) {
    pendingUser = name
    if (db !== selectedDb) selectedDb = db // triggers loadDatabase via $effect
    else selectedUser = name
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
    // honor a pending selection (user clicked a row in another database)
    if (pendingUser && dbUsers.some((x) => String(x.name) === pendingUser)) {
      selectedUser = pendingUser
      pendingUser = ''
    } else if (!selectedUser || !dbUsers.some((x) => String(x.name) === selectedUser)) {
      selectedUser = String(dbUsers[0]?.name ?? '')
    }
  }

  async function load() {
    if (!baseCid) return
    loading = true
    error = null
    try {
      await loadServer()
      if (scope === 'database') {
        await loadAllDbUsers()
        await loadDatabase()
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
    void baseCid
    untrack(() => void load())
  })
  // reload database data when the selected database or scope changes
  $effect(() => {
    void selectedDb
    void scope
    if (scope === 'database' && selectedDb) {
      untrack(() => {
        if (!dbUsersLoaded) void loadAllDbUsers()
        void loadDatabase()
      })
    }
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

  // ---- Database access (login-centric, native two-tier model) ---------------
  // For the selected login, walk every database once and build a single per-DB
  // view: whether the login is mapped to a user there, and (if so) its db-role
  // memberships + explicit permissions (GRANT/DENY — DENY wins over GRANT).
  type DbAccessRow = {
    db: string
    mapped: boolean
    user: string
    roles: string[]
    grants: { perm: string; securable: string }[]
    denies: { perm: string; securable: string }[]
  }
  let dbAccess = $state<DbAccessRow[]>([])
  let dbAccessLoaded = $state(false)
  let dbAccessBusy = $state(false)
  async function loadDbAccess() {
    if (!baseCid || !selectedLogin || dbAccessBusy) return
    dbAccessBusy = true
    const out: DbAccessRow[] = []
    try {
      for (const db of databases) {
        const sub = await ipc.attachDatabase(baseCid, db).catch(() => baseCid!)
        const u = await ipc.usersView(sub, 'db_users').catch(() => ({ rows: [] as Row[] }))
        const urow = u.rows.find((r) => String(r.login_name) === selectedLogin)
        if (!urow) {
          out.push({ db, mapped: false, user: '', roles: [], grants: [], denies: [] })
          continue
        }
        const userName = String(urow.name)
        const [rm, pm] = await Promise.all([
          ipc.usersView(sub, 'db_role_members').catch(() => ({ rows: [] as Row[] })),
          ipc.usersView(sub, 'db_permissions').catch(() => ({ rows: [] as Row[] })),
        ])
        const roles = rm.rows.filter((r) => String(r.member) === userName).map((r) => String(r.role))
        const perms = pm.rows.filter((r) => String(r.principal) === userName)
        const grants = perms
          .filter((p) => String(p.state_desc) === 'GRANT')
          .map((p) => ({ perm: String(p.permission_name), securable: String(p.securable) }))
        const denies = perms
          .filter((p) => String(p.state_desc) === 'DENY')
          .map((p) => ({ perm: String(p.permission_name), securable: String(p.securable) }))
        out.push({ db, mapped: true, user: userName, roles, grants, denies })
      }
      dbAccess = out
      dbAccessLoaded = true
    } finally {
      dbAccessBusy = false
    }
  }
  // reset the database-access view when the selected login changes
  $effect(() => {
    void selectedLogin
    untrack(() => {
      dbAccessLoaded = false
      dbAccess = []
    })
  })
  // create/drop the database user for this login on one database, then reload.
  async function toggleMapUser(db: string, add: boolean) {
    if (!baseCid || !selectedLogin || dbAccessBusy) return
    dbAccessBusy = true
    try {
      const sub = await ipc.attachDatabase(baseCid, db).catch(() => baseCid!)
      const sql = add ? createUserStmt(selectedLogin, selectedLogin) : dropUser(selectedLogin)
      const res = await ipc.execStatement(sub, sql, 0)
      if (!res.ok) {
        toasts.error(res.error?.message ?? 'error')
        return
      }
    } finally {
      dbAccessBusy = false
    }
    await loadDbAccess()
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

  // Quick drop from either list (context menu / row button): a server login runs
  // on the base connection; a database user on that database's sub-connection.
  let dropTarget = $state<{ name: string; kind: 'login' | 'user' } | null>(null)
  let dropping = $state(false)
  async function doDrop() {
    if (!dropTarget || dropping) return
    const isLogin = dropTarget.kind === 'login'
    const target = isLogin ? baseCid : dbCid || baseCid
    if (!target) return
    dropping = true
    try {
      const res = await ipc.execStatement(target, isLogin ? dropLogin(dropTarget.name) : dropUser(dropTarget.name), 0)
      if (!res.ok) {
        toasts.error(res.error?.message ?? 'error')
        return
      }
      toasts.success(`Dropped ${dropTarget.name}`, 'mssql')
      dropTarget = null
      if (isLogin) await loadServer()
      else await loadDatabase()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      dropping = false
    }
  }

  // ---- Database: permission grid (full columns, clickable, DENY, inherited) -
  type CellState = 'none' | 'direct' | 'partial' | 'inherited' | 'deny'
  const rolesOfUser = $derived(dbRoleMembers.filter((m) => String(m.member) === selectedUser).map((m) => String(m.role)))
  const selectedUserRow = $derived(dbUsers.find((u) => String(u.name) === selectedUser))
  // db roles the user has beyond the two quick toggles (shown as read-only chips).
  const otherRolesOfUser = $derived(rolesOfUser.filter((r) => !QUICK_DB_ROLES.includes(r)))
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
  let showGuide = $state(false)
  function openGrantWizard() {
    if (!selectedUser) return
    const target = dbCid || baseCid
    const user = selectedUser
    // Grouped by SCHEMA: each schema is a section listing its objects (+ a
    // "*" = whole schema entry). All run on the same database connection.
    grantWizard.show({
      title: 'Grant access',
      role: user,
      scopeLabel: 'Object',
      scopes: [],
      scope2Label: 'Schema',
      scopes2: schemas,
      scope2Default: schemas,
      loadScopesFor: async (schema) => {
        const tbls = target ? await ipc.listTables(target, schema).catch(() => []) : []
        return ['*', ...tbls.map((t) => t.name)] // "*" = whole schema
      },
      // no "Revoke all" level — the Action selector handles Revoke.
      levels: [
        { kind: 'read-only', label: 'Read-only', desc: 'View data (SELECT)' },
        { kind: 'read-write', label: 'Read-Write', desc: 'View + insert / update / delete' },
        { kind: 'read-write-execute', label: 'Read-Write + Execute', desc: 'Read-Write + EXECUTE procedures' },
        { kind: 'full', label: 'Full', desc: 'CONTROL (full control of the securable)' },
      ],
      actions: [
        { kind: 'grant', label: 'Grant' },
        { kind: 'deny', label: 'Deny', danger: true },
        { kind: 'revoke', label: 'Revoke', danger: true },
      ],
      build: (kind, inner, extra) => {
        const schema = extra?.scope2 ?? 'dbo'
        const scope = inner === '*' ? `${schema}.*` : `${schema}.${inner}`
        return [accessStatement(extra?.action ?? 'grant', kind, parseSecurable(scope), user)]
      },
      // MSSQL grants run on the one selected database → flatten all groups.
      onApplyGrouped: (groups) => (pending = [...pending, ...groups.flatMap((g) => g.statements)]),
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

<div class="um" style="flex:1;display:flex;flex-direction:column;min-height:0">
  <ManagerHeader system="mssql" connectionId={baseCid} title="Security" count={scope === 'server' ? logins.length : undefined} countLabel={logins.length === 1 ? 'login' : 'logins'} {refreshing} onRefresh={refresh}>
    <!-- SQL Server's two security levels, mirroring SSMS's tree: Server →
         Security → Logins, and Database → Security → Users. -->
    <div class="um-seg" role="group" aria-label="Security level">
      {#each [['server', '🖥', 'Server logins', 'Instance-level accounts that sign in (SSMS: Server → Security → Logins)'], ['database', '🗄', 'Database users', 'Principals inside one database (SSMS: Database → Security → Users)']] as [k, icon, label, tip] (k)}
        <span aria-pressed={scope === k} onclick={() => (scope = k as typeof scope)} onkeydown={(e) => e.key === 'Enter' && (scope = k as typeof scope)} role="button" tabindex="0" title={tip}><Icon name={icon === '🖥' ? 'shield' : 'database'} size={13} />{label}</span>
      {/each}
    </div>
    <span class="eg-btn primary" onclick={openCreate} onkeydown={(e) => e.key === 'Enter' && openCreate()} role="button" tabindex="0"><Icon name="plus" size={12} />{scope === 'server' ? 'New login' : 'New user'}</span>
  </ManagerHeader>

  <!-- Two-level model explainer — the #1 source of SQL Server confusion. -->
  <div class="um-callout">
    <Icon name="info" size={15} />
    <span>
    {#if scope === 'server'}
      SQL Server has two security levels. <b>Logins</b> are instance-level accounts that sign in to the whole server (SSMS: <i>Server → Security → Logins</i>). A login can only reach a database once it is mapped to a <b>user</b> there — do that below under “Database access”, or on the <b>Database users</b> tab.
    {:else}
      <b>Users</b> live inside <span class="mono" style="color:var(--text)">{selectedDb}</span> and control access within that one database (SSMS: <i>Database → Security → Users</i>). A user is normally backed by a <b>server login</b> — manage those on the <b>Server logins</b> tab.
    {/if}
    <span class="um-link" onclick={() => (showGuide = !showGuide)} onkeydown={(e) => e.key === 'Enter' && (showGuide = !showGuide)} role="button" tabindex="0" style="display:inline-flex;align-items:center;gap:var(--px-4);margin-top:var(--px-4)" aria-expanded={showGuide}><Chevron open={showGuide} />How do I give a user access?</span>
    </span>
  </div>

  {#if showGuide}
    <!-- End-to-end grant workflow, native to SQL Server's two-level model. -->
    <div class="um-card" style="flex:none;margin:var(--px-10) var(--px-16) 0;font-size:var(--px-12);color:var(--text2);line-height:1.55">
      <div style="font-weight:700;color:var(--text);margin-bottom:var(--px-6)">Give a user access — the SQL Server way</div>
      <ol style="margin:0;padding-left:var(--px-18);display:flex;flex-direction:column;gap:var(--px-4)">
        <li><span onclick={() => (scope = 'server')} onkeydown={(e) => e.key === 'Enter' && (scope = 'server')} role="button" tabindex="0" style="color:var(--primary);cursor:pointer;font-weight:600">Server logins</span> → <b style="color:var(--text)">New login</b> to create the account (or pick an existing login).</li>
        <li>On that login, open <b style="color:var(--text)">Database access</b> → <b style="color:var(--text)">Load access</b>, then <b style="color:var(--text)">tick the database(s)</b> the login should reach. This creates a <i>user</i> for it in each ticked database.</li>
        <li><span onclick={() => (scope = 'database')} onkeydown={(e) => e.key === 'Enter' && (scope = 'database')} role="button" tabindex="0" style="color:var(--primary);cursor:pointer;font-weight:600">Database users</span> — the list is grouped by database; pick the user under its database (each row shows its default schema).</li>
        <li>Give permissions: tick <span class="mono" style="color:var(--text)">db_datareader</span> / <span class="mono" style="color:var(--text)">db_datawriter</span> for whole-database read/write, or use <b style="color:var(--text)">Grant access…</b> for a specific schema/object (Read-only / Read-Write / Full, or Deny).</li>
        <li>Click <b style="color:var(--text)">Execute</b> in the <b style="color:var(--text)">Pending changes</b> bar to apply. Deletes/drops run immediately after a confirm; everything else queues here first.</li>
      </ol>
      <div style="margin-top:var(--px-6);color:var(--muted)">Tip: a <b>DENY</b> always beats a GRANT (even one inherited from a role) — use it to carve out an exception.</div>
    </div>
  {/if}

  <div class="um-body" style="margin-top:var(--px-12);border-top:var(--px-1) solid var(--border)">
    {#if scope === 'server'}
      <!-- Logins list -->
      <div class="um-list"><div class="um-list-search"><input class="um-input" style="width:100%" placeholder="Search logins" bind:value={listFilter} aria-label="Search logins" spellcheck="false" /></div>
      <div class="um-list-scroll" role="listbox" tabindex="-1" aria-label="Logins">
        {#if error}<div class="um-empty" style="color:var(--danger-solid)">{error}</div>
        {:else if loading && !logins.length}<div class="um-empty">Loading logins…</div>
        {:else if !shownLogins.length}<div class="um-empty">{logins.length ? 'No login matches your search.' : 'No logins yet.'}</div>
        {:else}
          {#each shownLogins as l (l.name)}
            {@const ln = String(l.name)}
            {@const sel = selectedLogin === ln}
            <ContextMenu.Root>
              <ContextMenu.Trigger>
                <div class="um-row" onclick={() => (selectedLogin = ln)} onkeydown={(e) => e.key === 'Enter' && (selectedLogin = ln)} role="option" tabindex="0" aria-selected={sel}>
                  <Avatar name={ln} size={28} />
                  <span class="um-row-text"><span class="um-row-name">{l.name}</span><span class="um-row-sub">{loginKind(l)}</span></span>
                  {#if boolY(l.is_disabled)}<span class="um-badge muted">Disabled</span>{/if}
                  <span class="um-row-act" onclick={(e) => { e.stopPropagation(); dropTarget = { name: ln, kind: 'login' } }} onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); dropTarget = { name: ln, kind: 'login' } } }} role="button" tabindex="0" title="Drop login" aria-label="Drop login {ln}"><Icon name="trash" size={13} /></span>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Content>
                <ContextMenu.Item onclick={() => (selectedLogin = ln)}>Select</ContextMenu.Item>
                <ContextMenu.Item onclick={() => (dropTarget = { name: ln, kind: 'login' })}>Drop login…</ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Root>
          {/each}
        {/if}
      </div></div>
      <!-- Login detail -->
      <div class="um-detail">
        {#if selectedLoginRow}
            <PrincipalHeader
              name={String(selectedLoginRow.name)}
              subtitle={`${loginKind(selectedLoginRow)} · server level${selectedLoginRow.default_database_name ? ` · default database ${selectedLoginRow.default_database_name}` : ''}`}
              badges={boolY(selectedLoginRow.is_disabled) ? [{ label: 'Disabled', tone: 'danger' }] : [{ label: 'Enabled', tone: 'ok' }]}
            >
              {#snippet actions()}
                <span class="eg-btn um-ghost-danger" onclick={() => (dropTarget = { name: String(selectedLoginRow.name), kind: 'login' })} onkeydown={(e) => e.key === 'Enter' && (dropTarget = { name: String(selectedLoginRow.name), kind: 'login' })} role="button" tabindex="0"><Icon name="trash" size={12} />Drop login…</span>
              {/snippet}
            </PrincipalHeader>
          <div class="um-detail-scroll">

            <!-- Sign-in card -->
            <div class="um-card">
              <div class="um-card-title">Sign-in</div>
              <div style="display:flex;gap:var(--px-6);align-items:flex-end;flex-wrap:wrap">
                <label class="um-field">Change password
                  <input type="password" bind:value={newLoginPw} class="um-input" style="width:var(--px-220)" autocomplete="new-password" placeholder="New password" />
                </label>
                <span onclick={queueLoginPassword} onkeydown={(e) => e.key === 'Enter' && queueLoginPassword()} role="button" tabindex="0" aria-disabled={!newLoginPw} class="eg-btn" style="cursor:{newLoginPw ? 'pointer' : 'not-allowed'};opacity:{newLoginPw ? 1 : 0.5}">Change password</span>
                {#if boolY(selectedLoginRow.is_disabled)}
                  <span onclick={() => queueLoginEnabled(true)} onkeydown={(e) => e.key === 'Enter' && queueLoginEnabled(true)} role="button" tabindex="0" class="eg-btn">Enable login</span>
                {:else}
                  <span onclick={() => queueLoginEnabled(false)} onkeydown={(e) => e.key === 'Enter' && queueLoginEnabled(false)} role="button" tabindex="0" class="eg-btn">Disable login</span>
                {/if}
              </div>
            </div>

            <!-- Server roles card -->
            <div class="um-card">
              <div class="um-card-title">Server roles <span style="font-weight:400;color:var(--muted);font-size:var(--px-10_5)">— instance-wide privileges (hover for details)</span></div>
              <div style="display:flex;flex-wrap:wrap;gap:var(--px-6) var(--px-16)">
                {#each FIXED_SERVER_ROLES as role (role)}
                  <label title={SERVER_ROLE_HELP[role] ?? ''} style="font-size:var(--px-11_5);color:var(--text);display:flex;align-items:center;gap:var(--px-5);cursor:help">
                    <input class="um-check" type="checkbox" checked={serverRolesOf.includes(role)} onchange={(e) => queueServerRole(role, (e.currentTarget as HTMLInputElement).checked)} /> {role}
                  </label>
                {/each}
              </div>
            </div>

            <!-- Database access card — mapping + roles/perms per database, one view -->
            <div class="um-card">
              <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-8)">
                <span style="font-size:var(--px-12_5);font-weight:700;color:var(--text)">Database access</span>
                <span onclick={loadDbAccess} onkeydown={(e) => e.key === 'Enter' && loadDbAccess()} role="button" tabindex="0" aria-busy={dbAccessBusy} class="eg-btn" style="margin-left:auto;opacity:{dbAccessBusy ? 0.6 : 1}">{#if dbAccessLoaded && !dbAccessBusy}<Icon name="refresh" size={12} /> {/if}{dbAccessBusy ? 'Loading…' : dbAccessLoaded ? 'Reload' : 'Load access'}</span>
              </div>
              {#if dbAccessLoaded}
                <div style="display:flex;flex-direction:column;gap:var(--px-6)">
                  {#each dbAccess as a (a.db)}
                    <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-6);overflow:hidden;opacity:{a.mapped ? 1 : 0.65}">
                      <div style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-5) var(--px-9);background:var(--surface)">
                        <label style="display:flex;align-items:center;gap:var(--px-6);cursor:pointer;font-size:var(--px-12);color:var(--text)" title="Tick to create a database user for this login here; untick to drop it.">
                          <input class="um-check" type="checkbox" checked={a.mapped} disabled={dbAccessBusy} onchange={(e) => toggleMapUser(a.db, (e.currentTarget as HTMLInputElement).checked)} />
                          <span class="mono" style="font-weight:700">{a.db}</span>
                        </label>
                        {#if a.mapped}<span style="font-size:var(--px-10);color:var(--muted)">user {a.user}</span>{:else}<span style="font-size:var(--px-10);color:var(--muted)">no access — tick to add a user</span>{/if}
                      </div>
                      {#if a.mapped}
                        <div style="padding:var(--px-5) var(--px-9);display:flex;flex-direction:column;gap:var(--px-3)">
                          <div style="display:flex;gap:var(--px-4);flex-wrap:wrap;align-items:center">
                            <span style="font-size:var(--px-10);color:var(--muted);min-width:var(--px-52)">roles</span>
                            {#if a.roles.length}{#each a.roles as r (r)}<span class="um-chip role">{r}</span>{/each}{:else}<span style="font-size:var(--px-10);color:var(--muted)">—</span>{/if}
                          </div>
                          <div style="display:flex;gap:var(--px-4);flex-wrap:wrap;align-items:center">
                            <span style="font-size:var(--px-10);color:var(--muted);min-width:var(--px-52)">granted</span>
                            {#if a.grants.length}{#each a.grants as g (`${g.perm}:${g.securable}`)}<span class="um-chip grant">{g.perm} on {g.securable}</span>{/each}{:else}<span style="font-size:var(--px-10);color:var(--muted)">—</span>{/if}
                          </div>
                          {#if a.denies.length}
                            <div style="display:flex;gap:var(--px-4);flex-wrap:wrap;align-items:center">
                              <span style="font-size:var(--px-10);color:var(--error);min-width:var(--px-52)">denied</span>
                              {#each a.denies as g (`${g.perm}:${g.securable}`)}<span class="um-chip deny">{g.perm} on {g.securable}</span>{/each}
                            </div>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
                <div style="font-size:var(--px-10);color:var(--muted);margin-top:var(--px-6)">Tick a database to give this login a user there; untick to remove it. For schema/object-level <b>GRANT/DENY</b>, DENY exceptions, or <b>orphaned users</b> (users with no login), use the <span onclick={() => (scope = 'database')} onkeydown={(e) => e.key === 'Enter' && (scope = 'database')} role="button" tabindex="0" style="color:var(--primary);cursor:pointer;font-weight:600">Database users tab →</span></div>
              {:else}
                <div class="um-field-hint">Click <b>Load access</b> to see which databases this login can reach and what it can do in each.</div>
              {/if}
            </div>

          </div>
        {:else if !loading}
          <div class="um-empty" style="margin:auto"><div style="display:inline-flex;color:var(--muted);margin-bottom:var(--px-8)"><Icon name="users" size={28} /></div><div style="font-size:var(--px-13);font-weight:600;color:var(--text)">Select a login</div><div>Pick one on the left to see and change its access.</div></div>
        {/if}
      </div>
    {:else}
      <!-- Database: users grouped by database (transparent — shows which
           database + default schema each user belongs to, no dropdown). -->
      <div class="um-list" style="width:var(--px-300)"><div class="um-list-search"><input class="um-input" style="width:100%" placeholder="Search users" bind:value={listFilter} aria-label="Search users" spellcheck="false" /></div>
      <div class="um-list-scroll" role="listbox" tabindex="-1" aria-label="Database users">
        {#if error}<div class="um-empty" style="color:var(--danger-solid)">{error}</div>
        {:else if loading || (dbUsersBusy && !dbUsersLoaded)}<div class="um-empty">Loading users…</div>
        {:else}
          {#each allDbUsers as grp (grp.db)}
            <div class="um-list-group" style="display:flex;align-items:center;gap:var(--px-6);text-transform:none;letter-spacing:0;font-size:var(--px-11_5);color:var(--text2)">
              <Icon name="database" size={12} />
              <span class="mono" style="font-weight:600;color:var(--text)">{grp.db}</span>
              {#if grp.db === currentDbName}<span class="um-badge info">current</span>{/if}
              <span style="margin-left:auto;font-weight:500;color:var(--muted)">{grp.users.length}</span>
            </div>
            {#if grp.users.length}
              {#each grp.users.filter((u) => u.name.toLowerCase().includes(listFilter.trim().toLowerCase())) as u (u.name)}
                {@const sel = selectedUser === u.name && selectedDb === grp.db}
                <ContextMenu.Root>
                  <ContextMenu.Trigger>
                    <div class="um-row" onclick={() => selectDbUser(grp.db, u.name)} onkeydown={(e) => e.key === 'Enter' && selectDbUser(grp.db, u.name)} role="option" tabindex="0" aria-selected={sel}>
                      <Avatar name={u.name} size={26} />
                      <span class="um-row-text"><span class="um-row-name">{u.name}</span><span class="um-row-sub" title="Default schema">default schema <span class="mono">{u.schema}</span></span></span>
                      {#if u.orphaned}<span class="um-badge warn" title="No matching server login">Orphaned</span>{/if}
                      <span class="um-row-act" onclick={(e) => { e.stopPropagation(); selectDbUser(grp.db, u.name); dropTarget = { name: u.name, kind: 'user' } }} onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); selectDbUser(grp.db, u.name); dropTarget = { name: u.name, kind: 'user' } } }} role="button" tabindex="0" title="Drop user" aria-label="Drop user {u.name}"><Icon name="trash" size={13} /></span>
                    </div>
                  </ContextMenu.Trigger>
                  <ContextMenu.Content>
                    <ContextMenu.Item onclick={() => selectDbUser(grp.db, u.name)}>Select</ContextMenu.Item>
                    <ContextMenu.Item onclick={() => { selectDbUser(grp.db, u.name); dropTarget = { name: u.name, kind: 'user' } }}>Drop user…</ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Root>
              {/each}
            {:else}
              <div class="um-field-hint" style="padding:var(--px-2) var(--px-8) var(--px-6)">No users in this database.</div>
            {/if}
          {/each}
        {/if}
      </div></div>
      <!-- User detail: permission grid + roles -->
      <div class="um-detail">
        {#if selectedUser}
            <PrincipalHeader
              name={selectedUser}
              subtitle={`Database user in ${selectedDb} · default schema ${selectedUserRow?.default_schema || 'dbo'}`}
              badges={selectedUserRow && boolY(selectedUserRow.orphaned) ? [{ label: 'Orphaned — no server login', tone: 'warn' }] : []}
            >
              {#snippet actions()}
                <span class="eg-btn um-ghost-danger" onclick={() => (dropTarget = { name: selectedUser, kind: 'user' })} onkeydown={(e) => e.key === 'Enter' && (dropTarget = { name: selectedUser, kind: 'user' })} role="button" tabindex="0"><Icon name="trash" size={12} />Drop user…</span>
              {/snippet}
            </PrincipalHeader>
          <div class="um-detail-scroll">

            <!-- Database roles card -->
            <div class="um-card">
              <div class="um-card-title">Database roles</div>
              <div style="display:flex;gap:var(--px-16);flex-wrap:wrap">
                {#each QUICK_DB_ROLES as role (role)}
                  <label class="um-checkline" title={DB_ROLE_HELP[role] ?? ''}>
                    <input class="um-check" type="checkbox" checked={rolesOfUser.includes(role)} onchange={(e) => queueFixedRole(role, (e.currentTarget as HTMLInputElement).checked)} /> {role}
                  </label>
                {/each}
              </div>
              {#if otherRolesOfUser.length}
                <div style="display:flex;gap:var(--px-4);flex-wrap:wrap;align-items:center;margin-top:var(--px-8)">
                  <span style="font-size:var(--px-10);color:var(--muted);min-width:var(--px-72)">other roles</span>
                  {#each otherRolesOfUser as r (r)}<span class="um-chip role">{r}</span>{/each}
                </div>
              {/if}
            </div>

            <!-- Permissions card -->
            <div class="um-card">
              <div class="um-card-title">Permissions</div>
              <div style="display:flex;align-items:center;gap:var(--px-10);flex-wrap:wrap">
                <span class="cfm-btn primary" onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0"><Icon name="plus" size={12} />Grant access…</span>
                <span style="font-size:var(--px-11);color:var(--muted)">Guided: pick a schema/object and an access level (Read-only / Read-Write / Full), or Deny.</span>
              </div>
              <div onclick={() => (showMatrix = !showMatrix)} onkeydown={(e) => e.key === 'Enter' && (showMatrix = !showMatrix)} role="button" tabindex="0" style="font-size:var(--px-11_5);color:var(--text2);cursor:pointer;margin-top:var(--px-10);user-select:none">{showMatrix ? '▾' : '▸'} Advanced — permission matrix (GRANT / DENY per privilege)</div>
              {#if showMatrix}
                <div style="margin-top:var(--px-8)">
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
                </div>
              {/if}
            </div>
          </div>
        {:else if !loading}
          <div class="um-empty" style="margin:auto"><div style="display:inline-flex;color:var(--muted);margin-bottom:var(--px-8)"><Icon name="users" size={28} /></div><div style="font-size:var(--px-13);font-weight:600;color:var(--text)">Select a user</div><div>Pick one on the left to see and change its access.</div></div>
        {/if}
      </div>
    {/if}
  </div>

  {#if pending.length}
    <PendingBar count={pending.length} sql={pending.join('\n')} language={editorLanguageId('mssql')} {executing} scope={scope === 'database' ? selectedDb : 'server'} onExecute={execute} onDiscard={discard} />
  {/if}
</div>

{#if dropTarget}
  <DropConfirm name={dropTarget.name} kind={dropTarget.kind} busy={dropping} oncancel={() => (dropTarget = null)} onconfirm={doDrop} />
{/if}
