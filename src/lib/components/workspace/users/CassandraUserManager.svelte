<script lang="ts">
  import './um.css'
  import PendingBar from './PendingBar.svelte'
  import Chevron from '$lib/components/Chevron.svelte'
  import Icon from '$lib/components/Icon.svelte'
  // Cassandra User Manager (U7). One principal type = role (LOGIN = a user).
  // Everything runs via cql_exec: LIST ROLES / LIST ALL PERMISSIONS OF /
  // CREATE|ALTER|DROP ROLE / GRANT|REVOKE. Requires PasswordAuthenticator +
  // CassandraAuthorizer (banner otherwise). Tabs: General, Member of, Permissions.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import DropConfirm from './DropConfirm.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { cassUserWizard } from '$lib/stores/cassuser.svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
  import {
    alterRole,
    CASS_GRID_COLUMNS,
    dropRole,
    grantColumn,
    grantRole,
    keyspacePreset,
    resourceAccessStatement,
    revokeColumn,
    revokeRole,
    type PresetKind,
  } from '$lib/users/cassandra'
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
  let roles = $state<Row[]>([])
  let listFilter = $state('')
  const shownRoles = $derived(roles.filter((r) => String(r.role).toLowerCase().includes(listFilter.trim().toLowerCase())))
  let perms = $state<Row[]>([])
  let keyspaces = $state<string[]>([])
  let gateOk = $state(true)
  let loading = $state(false)
  let refreshing = $state(false)
  let error = $state<string | null>(null)
  let selected = $state<string>('')
  let detailTab = $state<'general' | 'members' | 'perms' | 'access'>('general')
  let pending = $state<string[]>([])
  let executing = $state(false)

  const boolY = (v: unknown) => v === true || v === 'true' || v === 1

  async function load() {
    if (!cid) return
    loading = true
    error = null
    try {
      const res = await ipc.cqlExec(cid, 'LIST ROLES')
      if (!res.ok) {
        gateOk = false
        roles = []
        return
      }
      gateOk = true
      roles = res.result?.rows ?? []
      const sc = await ipc.listSchemas(cid).catch(() => [])
      keyspaces = sc.map((s) => s.name)
      if (!selected || !roles.some((r) => String(r.role) === selected)) {
        const focus = (tab.state as { focus?: string }).focus
        selected = focus && roles.some((r) => String(r.role) === focus) ? focus : String(roles[0]?.role ?? '')
      }
      await loadPerms()
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  async function loadPerms() {
    if (!cid || !selected) return
    const res = await ipc.cqlExec(cid, `LIST ALL PERMISSIONS OF ${cqlName(selected)}`).catch(() => null)
    perms = res?.ok ? (res.result?.rows ?? []) : []
  }

  function cqlName(name: string): string {
    return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
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

  // Grant-right-after-create: reload, select the new role, open the wizard.
  $effect(() => {
    const req = grantWizard.afterCreate
    if (req && req.connId === cid) untrack(() => void handleAfterCreate(req.principal))
  })
  async function handleAfterCreate(principal: string) {
    grantWizard.afterCreate = null
    await load()
    if (roles.some((r) => String(r.role) === principal)) {
      selected = principal
      detailTab = 'perms'
      openGrantWizard()
    }
  }

  $effect(() => {
    void selected
    untrack(() => void loadPerms())
  })

  const selectedRole = $derived(roles.find((r) => String(r.role) === selected))

  // ---- Permissions grid (per keyspace — full columns, clickable) ------------
  // LIST ALL PERMISSIONS OF returns EFFECTIVE permissions (direct + inherited);
  // Cassandra has no reliable way to split them here, so a present permission is
  // shown as ✓ (direct) — clicking still emits a keyspace-scoped GRANT/REVOKE.
  type CellState = 'none' | 'direct' | 'partial' | 'inherited' | 'deny'
  function hasPerm(keyspace: string, perm: string): boolean {
    return perms.some((p) => {
      const res = String(p.resource ?? '')
      const pm = String(p.permission ?? '')
      const scopeMatch = res.includes(`keyspace ${keyspace}`) || res.includes('all keyspaces')
      return scopeMatch && pm === perm
    })
  }
  function cellState(keyspace: string, perm: string): CellState {
    return hasPerm(keyspace, perm) ? 'direct' : 'none'
  }
  function onCell(keyspace: string, perm: string, st: CellState) {
    if (!selected) return
    pending = [...pending, st === 'none' ? grantColumn(keyspace, perm, selected) : revokeColumn(keyspace, perm, selected)]
  }
  // ---- Access overview (native: role-based, resource permissions) -----------
  // LIST ALL PERMISSIONS OF already returns EFFECTIVE permissions (direct +
  // inherited through granted roles), grouped here by resource (keyspace/table).
  type CassResourceAccess = { resource: string; perms: string[] }
  const cassAccess = $derived.by<CassResourceAccess[]>(() => {
    const map = new Map<string, Set<string>>()
    for (const p of perms) {
      const res = String(p.resource ?? '').replace(/[<>]/g, '').trim()
      const perm = String(p.permission ?? '')
      if (!res || !perm) continue
      if (!map.has(res)) map.set(res, new Set())
      map.get(res)!.add(perm)
    }
    return [...map]
      .map(([resource, s]) => ({ resource, perms: [...s].sort() }))
      .sort((a, b) => a.resource.localeCompare(b.resource))
  })

  const gridScopes = $derived(keyspaces.map((k) => ({ value: k, label: k })))
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
    const role = selected
    grantWizard.show({
      title: 'Grant access',
      role,
      // resource type is chosen by the scope you pick: a keyspace (whole) or a
      // table (ks.table); loaded per selected keyspace. "*" = all keyspaces.
      scopeLabel: 'Resource',
      scopes: [],
      scope2Label: 'Keyspace',
      scopes2: ['*', ...keyspaces],
      scope2Default: [],
      loadScopes: async (kss) => {
        const out: string[] = []
        for (const ks of kss) {
          if (ks === '*') {
            out.push('*') // ALL KEYSPACES
            continue
          }
          out.push(ks) // the whole keyspace
          const tree = await ipc.cassandraTree(c, ks).catch(() => null)
          for (const t of tree?.tables ?? []) out.push(`${ks}.${t.name}`)
        }
        return out
      },
      levels: [
        { kind: 'read-only', label: 'Read-only', desc: 'SELECT' },
        { kind: 'read-write', label: 'Read-Write', desc: 'MODIFY (INSERT/UPDATE/DELETE/TRUNCATE)' },
        { kind: 'full', label: 'Full', desc: 'ALL PERMISSIONS' },
      ],
      actions: [
        { kind: 'grant', label: 'Grant' },
        { kind: 'revoke', label: 'Revoke', danger: true },
      ],
      build: (kind, scope, extra) => [resourceAccessStatement(extra?.action === 'revoke' ? 'revoke' : 'grant', kind, scope, role)],
      onApply: (stmts) => (pending = [...pending, ...stmts]),
    })
  }

  function applyPreset(keyspace: string, kind: PresetKind) {
    if (!selected) return
    pending = [...pending, keyspacePreset(kind, keyspace, selected)]
  }

  // ---- General --------------------------------------------------------------
  let newPassword = $state('')
  function queuePassword() {
    if (!selected || !newPassword) return
    const s = alterRole(selected, { password: newPassword })
    if (s) pending = [...pending, s]
    newPassword = ''
  }
  function queueLogin(login: boolean) {
    if (!selected) return
    const s = alterRole(selected, { login })
    if (s) pending = [...pending, s]
  }
  function queueSuper(superuser: boolean) {
    if (!selected) return
    const s = alterRole(selected, { superuser })
    if (s) pending = [...pending, s]
  }

  // Quick drop from the list (context menu / row button) — runs via cql_exec.
  let dropTarget = $state<string | null>(null)
  let dropping = $state(false)
  async function doDrop() {
    if (!cid || !dropTarget || dropping) return
    dropping = true
    try {
      const r = await ipc.cqlExec(cid, dropRole(dropTarget))
      if (!r.ok) {
        toasts.error(r.error?.message ?? 'error')
        return
      }
      toasts.success(`Dropped ${dropTarget}`, 'cassandra')
      dropTarget = null
      await load()
    } catch (e) {
      toasts.error(String(e))
    } finally {
      dropping = false
    }
  }

  // ---- Member of ------------------------------------------------------------
  let grantRoleName = $state('')
  function queueGrantRole() {
    if (!selected || !grantRoleName) return
    pending = [...pending, grantRole(grantRoleName, selected)]
    grantRoleName = ''
  }

  // ---- Execute --------------------------------------------------------------
  async function execute() {
    if (!cid || !pending.length || executing) return
    executing = true
    try {
      for (const cql of pending) {
        const res = await ipc.cqlExec(cid, cql)
        if (!res.ok) {
          toasts.error(res.error?.message ?? 'error')
          break
        }
      }
      toasts.success('Applied', 'cassandra')
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
  <ManagerHeader system="cassandra" connectionId={cid} title="Roles" count={roles.length} countLabel={roles.length === 1 ? 'role' : 'roles'} {refreshing} onRefresh={refresh}>
    <span class="eg-btn primary" onclick={() => cid && cassUserWizard.show(cid)} onkeydown={(e) => e.key === 'Enter' && cid && cassUserWizard.show(cid)} role="button" tabindex="0"><Icon name="plus" size={12} />New role</span>
  </ManagerHeader>

  <!-- Model explainer — Cassandra: a role may log in / be superuser; roles nest. -->
  <div class="um-callout"><Icon name="info" size={15} /><span>In Cassandra a <b>role</b> can be allowed to <b>log in</b> and can be a <b>superuser</b>. Grant a role to another role to pass on its permissions; permissions are set per <b>keyspace</b> or <b>table</b>.</span></div>

  {#if !gateOk}
    <div class="um-callout warn"><Icon name="warning" size={15} /><span>Role management is off on this server. Enable <b>PasswordAuthenticator</b> and <b>CassandraAuthorizer</b> in cassandra.yaml (the default AllowAll disables it).</span></div>
  {/if}

  <div class="um-body" style="margin-top:var(--px-12);border-top:var(--px-1) solid var(--border)">
    <div class="um-list"><div class="um-list-search"><input class="um-input" style="width:100%" placeholder="Search roles" bind:value={listFilter} aria-label="Search roles" spellcheck="false" /></div>
    <div class="um-list-scroll" role="listbox" tabindex="-1" aria-label="Roles">
      {#if error}<div class="um-empty" style="color:var(--danger-solid)">{error}</div>
      {:else if loading && !roles.length}<div class="um-empty">Loading roles…</div>
      {:else if !shownRoles.length}<div class="um-empty">{roles.length ? 'No role matches your search.' : 'No roles yet.'}</div>
      {:else}
        {#each shownRoles as r (r.role)}
          {@const rn = String(r.role)}
          {@const sel = selected === rn}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <div class="um-row" onclick={() => (selected = rn)} onkeydown={(e) => e.key === 'Enter' && (selected = rn)} role="option" tabindex="0" aria-selected={sel}>
                <Avatar name={rn} group={!boolY(r.login)} size={28} />
                <span class="um-row-text"><span class="um-row-name">{r.role}</span><span class="um-row-sub">{boolY(r.login) ? 'Can log in' : 'Group role (no login)'}</span></span>
                {#if boolY(r.super)}<span class="um-badge warn">Superuser</span>{/if}
                <span class="um-row-act" onclick={(e) => { e.stopPropagation(); dropTarget = rn }} onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); dropTarget = rn } }} role="button" tabindex="0" title="Drop role" aria-label="Drop role {rn}"><Icon name="trash" size={13} /></span>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content>
              <ContextMenu.Item onclick={() => (selected = rn)}>Select</ContextMenu.Item>
              <ContextMenu.Item onclick={() => (dropTarget = rn)}>Drop role…</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      {/if}
    </div></div>

    <div class="um-detail">
      {#if selectedRole}
        <PrincipalHeader
          name={selected}
          group={!boolY(selectedRole.login)}
          subtitle={boolY(selectedRole.login) ? 'Role that can log in' : 'Group role — cannot log in'}
          badges={boolY(selectedRole.super) ? [{ label: 'Superuser', tone: 'warn' }] : []}
        >
          {#snippet actions()}
            <span class="eg-btn um-ghost-danger" onclick={() => (dropTarget = selected)} onkeydown={(e) => e.key === 'Enter' && (dropTarget = selected)} role="button" tabindex="0"><Icon name="trash" size={12} />Drop role…</span>
          {/snippet}
        </PrincipalHeader>
        <div class="um-tabs" role="tablist">
          {#each [['general', 'General'], ['members', 'Member of'], ['perms', 'Permissions'], ['access', 'Access']] as [k, label] (k)}
            <span onclick={() => (detailTab = k as typeof detailTab)} onkeydown={(e) => e.key === 'Enter' && (detailTab = k as typeof detailTab)} role="tab" tabindex="0" aria-selected={detailTab === k} class="um-tab">{label}</span>
          {/each}
        </div>
        <div class="um-detail-scroll">
          {#if detailTab === 'general'}
            <div class="um-card">
              <div class="um-card-title">Attributes</div>
              <dl class="um-kv" style="margin-bottom:var(--px-14)">
                {#each [['Role', selectedRole.role, true], ['Can log in', boolY(selectedRole.login) ? 'Yes' : 'No', false], ['Superuser', boolY(selectedRole.super) ? 'Yes' : 'No', false]] as [k, v, mono] (k)}
                  <dt>{k}</dt><dd class:mono>{v}</dd>
                {/each}
              </dl>
              <div style="display:flex;gap:var(--px-8);flex-wrap:wrap">
                <span class="eg-btn" onclick={() => queueLogin(!boolY(selectedRole.login))} onkeydown={(e) => e.key === 'Enter' && queueLogin(!boolY(selectedRole.login))} role="button" tabindex="0" title="LOGIN lets this role authenticate and connect (i.e. act as a user).">{boolY(selectedRole.login) ? 'Disable login' : 'Allow login'}</span>
                <span class="eg-btn" onclick={() => queueSuper(!boolY(selectedRole.super))} onkeydown={(e) => e.key === 'Enter' && queueSuper(!boolY(selectedRole.super))} role="button" tabindex="0" title="SUPERUSER bypasses all permission checks — grant sparingly.">{boolY(selectedRole.super) ? 'Remove superuser' : 'Make superuser'}</span>
              </div>
            </div>
            <div class="um-card">
              <div class="um-card-title">Password</div>
              <div style="display:flex;gap:var(--px-6);align-items:flex-end">
                <label class="um-field">Change password
                  <input type="password" bind:value={newPassword} class="um-input" style="width:var(--px-220)" autocomplete="new-password" placeholder="New password" />
                </label>
                <span class="eg-btn" onclick={queuePassword} onkeydown={(e) => e.key === 'Enter' && queuePassword()} role="button" tabindex="0" aria-disabled={!newPassword} style="cursor:{newPassword ? 'pointer' : 'not-allowed'};opacity:{newPassword ? 1 : 0.5}">Change password</span>
              </div>
            </div>
            <div class="um-card">
              <div class="um-card-title">Delete role</div>
              <span class="eg-btn um-ghost-danger" onclick={() => (dropTarget = selected)} onkeydown={(e) => e.key === 'Enter' && (dropTarget = selected)} role="button" tabindex="0" title="DROP ROLE — removes the role permanently.">Drop role…</span>
            </div>
          {:else if detailTab === 'members'}
            <div class="um-card">
              <div class="um-card-title">Role membership</div>
              <div style="display:flex;gap:var(--px-6);align-items:center;flex-wrap:wrap">
                <select bind:value={grantRoleName} class="um-select mono">
                  <option value="">— grant role to {selected} —</option>
                  {#each roles.filter((r) => String(r.role) !== selected) as r (r.role)}<option value={String(r.role)}>{r.role}</option>{/each}
                </select>
                <span class="eg-btn" onclick={queueGrantRole} onkeydown={(e) => e.key === 'Enter' && queueGrantRole()} role="button" tabindex="0" aria-disabled={!grantRoleName} style="cursor:{grantRoleName ? 'pointer' : 'not-allowed'};opacity:{grantRoleName ? 1 : 0.5}">Grant</span>
              </div>
              <div class="um-field-hint" style="margin-top:var(--px-10)">GRANT &lt;role&gt; TO {selected} — role membership (a role can inherit another role's permissions).</div>
            </div>
          {:else if detailTab === 'perms'}
            <!-- Permissions -->
            <div style="display:flex;align-items:center;gap:var(--px-10);margin-bottom:var(--px-10);flex-wrap:wrap">
              <span class="cfm-btn primary" onclick={openGrantWizard} onkeydown={(e) => e.key === 'Enter' && openGrantWizard()} role="button" tabindex="0"><Icon name="plus" size={12} />Grant access…</span>
              <span style="font-size:var(--px-11);color:var(--muted)">Pick a keyspace and an access level (Read-only / Read-Write / Full).</span>
            </div>
            <div class="um-disclosure" onclick={() => (showMatrix = !showMatrix)} onkeydown={(e) => e.key === 'Enter' && (showMatrix = !showMatrix)} role="button" tabindex="0" aria-expanded={showMatrix}><Chevron open={showMatrix} />Advanced — permission matrix</div>
            {#if showMatrix}
            <PrivilegeGrid
              columns={CASS_GRID_COLUMNS}
              scopes={gridScopes}
              {cellState}
              {onCell}
              presets={gridPresets}
              onPreset={(ks, kind) => applyPreset(ks, kind as PresetKind)}
              note="MODIFY = INSERT + UPDATE + DELETE + TRUNCATE. Shows effective permissions (incl. via ALL KEYSPACES / roles)."
            />
            {/if}
          {:else}
            <!-- Access overview: effective permissions grouped by resource -->
            <div style="font-size:var(--px-12);color:var(--text2);margin-bottom:var(--px-10)">What <span class="mono" style="color:var(--text);font-weight:600">{selected}</span> can access — effective permissions per resource (direct + inherited via roles).</div>
            {#if cassAccess.length}
              <div style="display:flex;flex-direction:column;gap:var(--px-8)">
                {#each cassAccess as r (r.resource)}
                  <div style="border:var(--px-1) solid var(--border);border-radius:var(--px-7);overflow:hidden">
                    <div style="padding:var(--px-5) var(--px-10);background:var(--panel);border-bottom:var(--px-1) solid var(--border);font-size:var(--px-12_5);font-weight:700;color:var(--text)">
                      <span class="mono">{r.resource}</span>
                    </div>
                    <div style="padding:var(--px-6) var(--px-10);display:flex;gap:var(--px-4);flex-wrap:wrap">
                      {#each r.perms as p (p)}<span class="um-chip role">{p}</span>{/each}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="um-field-hint">No permissions — this role cannot access any keyspace/table yet.</div>
            {/if}
            <div class="um-field-hint" style="margin-top:var(--px-10)">Resources are keyspaces / tables / all keyspaces. Permissions here are effective (LIST ALL PERMISSIONS OF), so role-inherited access is included.</div>
          {/if}
        </div>
      {:else if !loading}
        <div class="um-empty" style="margin:auto"><div style="display:inline-flex;color:var(--muted);margin-bottom:var(--px-8)"><Icon name="users" size={28} /></div><div style="font-size:var(--px-13);font-weight:600;color:var(--text)">Select a role</div><div>Pick one on the left to see and change its access.</div></div>
      {/if}

      {#if pending.length}
        <PendingBar count={pending.length} sql={pending.join('\n')} language={editorLanguageId('cassandra')} {executing} onExecute={execute} onDiscard={discard} />
      {/if}
    </div>
  </div>
</div>

{#if dropTarget}
  <DropConfirm name={dropTarget} kind="role" busy={dropping} oncancel={() => (dropTarget = null)} onconfirm={doDrop} />
{/if}
