<script lang="ts">
  // ClickHouse User Manager (U4). SQL-driven RBAC: Users + Roles + per-database
  // grant grid. Users/roles in users.xml storage are read-only (badge); only
  // local_directory principals are editable by SQL. Requires ACCESS MANAGEMENT
  // on the connection (banner otherwise). Mutations run via exec_statement (HTTP).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { chUserWizard } from '$lib/stores/chuser.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import {
    alterUserPassword,
    dbPreset,
    dropUser,
    dropRole,
    grantRole,
    revokeRole,
    setDefaultRole,
    type PresetKind,
  } from '$lib/users/clickhouse'
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
  let detailTab = $state<'general' | 'grants' | 'roles'>('general')
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

  const list = $derived(kind === 'users' ? users : roles)
  const selectedRow = $derived(list.find((x) => String(x.name) === selected))
  const isReadOnly = (r: Row | undefined) => !!r && String(r.storage) !== 'local_directory'

  // ---- Grant grid (§1.8.2) --------------------------------------------------
  // UPDATE/DELETE are ALTER mutations in ClickHouse → the access_type is
  // `ALTER UPDATE` / `ALTER DELETE` (the column header stays UPDATE/DELETE).
  const GRID = [
    { col: 'SELECT', access: 'SELECT' },
    { col: 'INSERT', access: 'INSERT' },
    { col: 'UPDATE', access: 'ALTER UPDATE' },
    { col: 'DELETE', access: 'ALTER DELETE' },
  ] as const
  type CellState = 'none' | 'grant'

  function cellState(db: string, access: string): CellState {
    const has = grants.some(
      (g) =>
        String(g.user) === selected &&
        String(g.database) === db &&
        String(g.table) === '' &&
        (String(g.access_type) === access || String(g.access_type) === 'ALL'),
    )
    return has ? 'grant' : 'none'
  }
  const cellGlyph = (s: CellState) => (s === 'grant' ? '✓' : '☐')

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
          <div onclick={() => (selected = String(r.name))} onkeydown={(e) => e.key === 'Enter' && (selected = String(r.name))} role="option" tabindex="0" aria-selected={selected === String(r.name)} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-5) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{selected === String(r.name) ? 'var(--grid-select)' : 'transparent'};color:{selected === String(r.name) ? 'var(--hex-fff)' : 'var(--text)'}">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis">{r.name}</span>
            {#if isReadOnly(r)}<span title="defined in {r.storage}" style="font-size:var(--px-9);color:{selected === String(r.name) ? 'var(--hex-fff)' : 'var(--muted)'}">{r.storage}</span>{/if}
          </div>
        {/each}
      {/if}
    </div>

    <div style="flex:1;display:flex;flex-direction:column;min-height:0">
      {#if selectedRow}
        {#if isReadOnly(selectedRow)}
          <div style="flex:none;padding:var(--px-8) var(--px-14);background:var(--panel);border-bottom:var(--px-1) solid var(--border);color:var(--muted);font-size:var(--px-11_5)">Read-only — “{selected}” is defined in {selectedRow.storage}, not SQL. Edit it in users.xml.</div>
        {/if}
        <div style="flex:none;display:flex;gap:var(--px-2);padding:var(--px-8) var(--px-12) 0;border-bottom:var(--px-1) solid var(--border)">
          {#each (kind === 'users' ? [['general', 'General'], ['grants', 'Grants'], ['roles', 'Roles']] : [['general', 'General'], ['grants', 'Grants']]) as [k, label] (k)}
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
            <div style="overflow:auto">
              <table class="mono" style="border-collapse:collapse;font-size:var(--px-12);width:100%">
                <thead><tr>
                  <th style="text-align:left;padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">Database</th>
                  {#each GRID as g (g.col)}<th title={g.access} style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">{g.col}</th>{/each}
                  <th style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">Presets</th>
                </tr></thead>
                <tbody>
                  {#each databases as db (db)}
                    <tr>
                      <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--text)">{db}</td>
                      {#each GRID as g (g.col)}
                        <td style="text-align:center;padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:{cellState(db, g.access) === 'grant' ? 'var(--sacc-green)' : 'var(--muted)'}">{cellGlyph(cellState(db, g.access))}</td>
                      {/each}
                      <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);white-space:nowrap">
                        {#each [['read-only', 'R'], ['read-write', 'RW'], ['full', 'Full'], ['revoke-all', 'Revoke']] as [k, label] (k)}
                          <span onclick={() => applyPreset(db, k as PresetKind)} onkeydown={(e) => e.key === 'Enter' && applyPreset(db, k as PresetKind)} role="button" tabindex="0" title={String(k)} style="font-size:var(--px-10_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-7);margin-right:var(--px-4);cursor:pointer;color:{k === 'revoke-all' ? 'var(--error)' : 'var(--text2)'}">{label}</span>
                        {/each}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">UPDATE/DELETE map to the ALTER UPDATE / ALTER DELETE privileges (mutations). ✓ = granted.</div>
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
