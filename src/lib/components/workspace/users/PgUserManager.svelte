<script lang="ts">
  // PostgreSQL User Manager (U1). One principal type = role; "user" = role with
  // LOGIN, "group" = role without. Tabs: General (attributes + password + drop),
  // Membership (grant/revoke), Privileges (per-schema grid §1.8.3 with presets).
  // Every mutation builds SQL → preview → Execute (run sequentially, then reload
  // from introspection — never trust optimistic state).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { pgRoleWizard } from '$lib/stores/pgrole.svelte'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import {
    alterPassword,
    dropRole,
    grantMembership,
    revokeMembership,
    schemaPreset,
    type PresetKind,
  } from '$lib/users/postgres'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  type Row = Record<string, unknown>
  let roles = $state<Row[]>([])
  let members = $state<Row[]>([])
  let tableGrants = $state<Row[]>([])
  let schemaOwners = $state<Row[]>([])
  let schemas = $state<string[]>([])
  let tablesBySchema = $state<Record<string, number>>({})
  let canManage = $state(true)
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let selected = $state<string>('')
  let detailTab = $state<'general' | 'membership' | 'privileges'>('general')

  // Pending mutation statements (built by the active tab), shown as a preview.
  let pending = $state<string[]>([])
  let executing = $state(false)

  const cid = $derived(tab.connectionId)

  async function load() {
    if (!cid) return
    loading = true
    error = null
    try {
      const [r, m, tg, so, sc, cm] = await Promise.all([
        ipc.usersView(cid, 'roles'),
        ipc.usersView(cid, 'members').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, 'table_grants').catch(() => ({ rows: [] as Row[] })),
        ipc.usersView(cid, 'schema_owners').catch(() => ({ rows: [] as Row[] })),
        ipc.listSchemas(cid).catch(() => []),
        ipc.usersView(cid, 'can_manage').catch(() => ({ rows: [{ can_manage: true }] as Row[] })),
      ])
      roles = r.rows
      members = m.rows
      tableGrants = tg.rows
      schemaOwners = so.rows
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

  const selectedRole = $derived(roles.find((r) => String(r.name) === selected))
  const isGroup = (r: Row) => r.rolcanlogin === false
  const boolY = (v: unknown) => v === true || v === 1 || v === '1' || v === 't'

  // ---- Privileges grid ------------------------------------------------------
  const GRID_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const
  type CellState = 'none' | 'full' | 'partial'

  function cellState(schema: string, priv: string): CellState {
    const total = tablesBySchema[schema] ?? 0
    const n = tableGrants.filter(
      (g) => String(g.schema) === schema && String(g.grantee) === selected && String(g.privilege_type) === priv,
    ).length
    if (n === 0) return 'none'
    if (total > 0 && n >= total) return 'full'
    return 'partial'
  }
  const cellGlyph = (s: CellState) => (s === 'full' ? '✓' : s === 'partial' ? '■' : '☐')
  function cellCount(schema: string, priv: string): string {
    const total = tablesBySchema[schema] ?? 0
    const n = tableGrants.filter(
      (g) => String(g.schema) === schema && String(g.grantee) === selected && String(g.privilege_type) === priv,
    ).length
    return total ? `${n}/${total}` : `${n}`
  }

  let futureTables = $state(true)

  function ownerOf(schema: string): string | undefined {
    return schemaOwners.find((o) => String(o.schema) === schema)?.owner as string | undefined
  }

  function applyPreset(schema: string, kind: PresetKind) {
    if (!selected) return
    const owners = kind === 'revoke-all'
      ? [...new Set([ownerOf(schema), 'postgres'].filter(Boolean) as string[])]
      : undefined
    const stmts = schemaPreset(kind, schema, selected, { futureTables, owner: ownerOf(schema), owners })
    pending = [...pending, ...stmts]
  }

  // ---- General mutations ----------------------------------------------------
  let newPassword = $state('')
  function queuePassword() {
    if (!selected || !newPassword) return
    pending = [...pending, alterPassword(selected, newPassword)]
    newPassword = ''
  }

  // ---- Membership -----------------------------------------------------------
  let grantRoleName = $state('')
  let grantAdmin = $state(false)
  const memberOf = $derived(members.filter((m) => String(m.member) === selected))
  const hasMembers = $derived(members.filter((m) => String(m.role) === selected))
  function queueGrantMembership() {
    if (!selected || !grantRoleName) return
    pending = [...pending, grantMembership(grantRoleName, selected, grantAdmin)]
    grantRoleName = ''
    grantAdmin = false
  }
  function queueRevokeMembership(role: string) {
    if (!selected) return
    pending = [...pending, revokeMembership(role, selected)]
  }

  // ---- Drop (confirm) -------------------------------------------------------
  let confirmDrop = $state(false)
  function queueDrop() {
    if (!selected) return
    pending = [...pending, dropRole(selected)]
    confirmDrop = false
  }

  // ---- Execute pending ------------------------------------------------------
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
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-12);font-weight:700">Login/Group Roles</span>
    <span style="font-size:var(--px-11);color:var(--muted)">{roles.length} roles</span>
    <span onclick={() => cid && pgRoleWizard.show(cid)} onkeydown={(e) => e.key === 'Enter' && cid && pgRoleWizard.show(cid)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">+ New Role</span>
    <span onclick={refresh} onkeydown={(e) => e.key === 'Enter' && refresh()} role="button" tabindex="0" aria-busy={refreshing} style="margin-left:auto;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;opacity:{refreshing ? 0.6 : 1}">{refreshing ? '⟳ Refreshing…' : '⟳ Refresh'}</span>
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
          <div onclick={() => (selected = String(r.name))} onkeydown={(e) => e.key === 'Enter' && (selected = String(r.name))} role="option" tabindex="0" aria-selected={selected === String(r.name)} style="display:flex;align-items:center;gap:var(--px-6);padding:var(--px-6) var(--px-12);font-size:var(--px-12_5);cursor:pointer;border-bottom:var(--px-1) solid var(--border);background:{selected === String(r.name) ? 'var(--grid-select)' : 'transparent'};color:{selected === String(r.name) ? 'var(--hex-fff)' : 'var(--text)'}">
            <span title={isGroup(r) ? 'Group role' : 'Login role'}>{isGroup(r) ? '👥' : '👤'}</span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis">{r.name}</span>
            {#if boolY(r.rolsuper)}<span style="font-size:var(--px-9);font-weight:700;color:{selected === String(r.name) ? 'var(--hex-fff)' : 'var(--warn2)'}">SUPER</span>{/if}
          </div>
        {/each}
      {/if}
    </div>

    <!-- Detail -->
    <div style="flex:1;display:flex;flex-direction:column;min-height:0">
      {#if selectedRole}
        <div style="flex:none;display:flex;gap:var(--px-2);padding:var(--px-8) var(--px-12) 0;border-bottom:var(--px-1) solid var(--border)">
          {#each [['general', 'General'], ['membership', 'Membership'], ['privileges', 'Privileges']] as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} style="padding:var(--px-6) var(--px-12);font-size:var(--px-12);cursor:pointer;font-weight:600;border-bottom:var(--px-2) solid {detailTab === k ? 'var(--primary)' : 'transparent'};color:{detailTab === k ? 'var(--text)' : 'var(--muted)'}">{label}</span>
          {/each}
        </div>
        <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14)">
          {#if detailTab === 'general'}
            <table class="mono" style="border-collapse:collapse;font-size:var(--px-12);margin-bottom:var(--px-14)">
              <tbody>
                {#each [['Can login', boolY(selectedRole.rolcanlogin)], ['Superuser', boolY(selectedRole.rolsuper)], ['Create roles', boolY(selectedRole.rolcreaterole)], ['Create databases', boolY(selectedRole.rolcreatedb)], ['Inherit', boolY(selectedRole.rolinherit)], ['Replication', boolY(selectedRole.rolreplication)], ['Bypass RLS', boolY(selectedRole.rolbypassrls)], ['Connection limit', selectedRole.rolconnlimit], ['Valid until', selectedRole.valid_until || '—']] as [label, val] (label)}
                  <tr>
                    <td style="padding:var(--px-3) var(--px-14) var(--px-3) 0;color:var(--text2);white-space:nowrap">{label}</td>
                    <td style="padding:var(--px-3) 0;color:var(--text)">{typeof val === 'boolean' ? (val ? '✓' : '—') : val}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <div style="display:flex;gap:var(--px-6);align-items:flex-end;margin-bottom:var(--px-12)">
              <label style="font-size:var(--px-12);color:var(--text2)">Change password
                <input type="password" bind:value={newPassword} class="mono" style="display:block;margin-top:var(--px-4);width:var(--px-220);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
              </label>
              <span onclick={queuePassword} onkeydown={(e) => e.key === 'Enter' && queuePassword()} role="button" tabindex="0" aria-disabled={!newPassword} style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);cursor:{newPassword ? 'pointer' : 'not-allowed'};opacity:{newPassword ? 1 : 0.5}">Queue change</span>
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
          {:else}
            <!-- Privileges grid §1.8.3 -->
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-8);flex-wrap:wrap">
              <label style="font-size:var(--px-11_5);color:var(--text2);display:flex;align-items:center;gap:var(--px-4)"><input type="checkbox" bind:checked={futureTables} /> Also apply to future tables (ALTER DEFAULT PRIVILEGES)</label>
            </div>
            <div style="overflow:auto">
              <table class="mono" style="border-collapse:collapse;font-size:var(--px-12);width:100%">
                <thead>
                  <tr>
                    <th style="text-align:left;padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">Schema</th>
                    {#each GRID_PRIVS as p (p)}<th style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">{p}</th>{/each}
                    <th style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2)">Presets</th>
                  </tr>
                </thead>
                <tbody>
                  {#each schemas as s (s)}
                    <tr>
                      <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--text)">{s}</td>
                      {#each GRID_PRIVS as p (p)}
                        <td title={cellCount(s, p)} style="text-align:center;padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:{cellState(s, p) === 'full' ? 'var(--sacc-green)' : cellState(s, p) === 'partial' ? 'var(--warn2)' : 'var(--muted)'}">{cellGlyph(cellState(s, p))}</td>
                      {/each}
                      <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);white-space:nowrap">
                        {#each [['read-only', 'R'], ['read-write', 'RW'], ['read-write-execute', 'RW+X'], ['full', 'Full'], ['revoke-all', 'Revoke']] as [kind, label] (kind)}
                          <span onclick={() => applyPreset(s, kind as PresetKind)} onkeydown={(e) => e.key === 'Enter' && applyPreset(s, kind as PresetKind)} role="button" tabindex="0" title={String(kind)} style="font-size:var(--px-10_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-7);margin-right:var(--px-4);cursor:pointer;color:{kind === 'revoke-all' ? 'var(--error)' : 'var(--text2)'}">{label}</span>
                        {/each}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <div style="font-size:var(--px-10_5);color:var(--muted);margin-top:var(--px-8)">✓ = all objects · ■ = partial · ☐ = none. EXECUTE on functions defaults to PUBLIC in PostgreSQL.</div>
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
          <pre class="selectable mono" style="margin:0;font-size:var(--px-11);white-space:pre-wrap;color:var(--text2)">{#each pending as s (s)}{#each highlightSql(s + ';\n') as tk (tk)}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}{/each}</pre>
        </div>
      {/if}
    </div>
  </div>
</div>
