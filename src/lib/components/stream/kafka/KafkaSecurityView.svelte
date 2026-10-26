<script lang="ts">
  // Security of a Kafka / Redpanda cluster (SPEC-REDPANDA.md R8–R10).
  //  - Users and Roles come from the Redpanda Admin API (SCRAM users, RBAC roles);
  //  - ACLs use the Kafka protocol, so they also work on Apache Kafka.
  // Every change runs at once and the lists are read again (the API has no transaction).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import Icon from '$lib/components/Icon.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import AclGrantDialog from './AclGrantDialog.svelte'
  import {
    SCRAM_ALGORITHMS,
    aclKey,
    aclSentence,
    operationText,
    parseRoleMembers,
    parseRoles,
    parseUsers,
    passwordProblem,
    resourceText,
    roleNameProblem,
    rp,
    splitPrincipal,
    userNameProblem,
    type ScramAlgorithm,
  } from '$lib/redpanda/admin'
  import { rpCall, rpMessage } from '$lib/redpanda/client'
  import { plural } from '$lib/stream/humanize'
  import '$lib/components/workspace/users/um.css'

  let {
    connId,
    redpanda,
    topics = [],
    groups = [],
  }: { connId: string; redpanda: boolean; topics?: string[]; groups?: string[] } = $props()

  type Tab = 'users' | 'roles' | 'acls'
  let tab = $state<Tab>(untrack(() => redpanda) ? 'users' : 'acls')

  let users = $state<string[]>([])
  let usersError = $state<string | null>(null)
  let roles = $state<string[]>([])
  let rolesError = $state<string | null>(null)
  let members = $state<Record<string, string[]>>({})
  let acls = $state<ipc.KafkaAcl[]>([])
  let aclsError = $state<string | null>(null)
  let loading = $state(false)

  async function load() {
    loading = true
    const jobs: Promise<unknown>[] = [
      ipc
        .kafkaAcls(connId)
        .then((a) => {
          acls = a
          aclsError = null
        })
        .catch((e) => (aclsError = String(e))),
    ]
    if (redpanda) {
      jobs.push(
        rpCall(connId, rp.users())
          .then((j) => {
            users = parseUsers(j)
            usersError = null
          })
          .catch((e) => (usersError = rpMessage(e))),
        rpCall(connId, rp.roles())
          .then(async (j) => {
            roles = parseRoles(j)
            rolesError = null
            const m = await Promise.allSettled(roles.map((r) => rpCall(connId, rp.role(r))))
            const next: Record<string, string[]> = {}
            roles.forEach((r, i) => {
              const x = m[i]
              next[r] = x.status === 'fulfilled' ? parseRoleMembers(x.value).map((y) => y.name) : []
            })
            members = next
          })
          .catch((e) => (rolesError = rpMessage(e))),
      )
    }
    await Promise.allSettled(jobs)
    loading = false
  }
  $effect(() => {
    void connId
    untrack(() => void load())
  })

  const aclCount = (principal: string) => acls.filter((a) => a.principal === principal).length
  const rolesOf = (u: string) => roles.filter((r) => (members[r] ?? []).includes(u))

  // ---- dialogs ----
  let grantFor = $state<string | null>(null) // principal, '' = choose
  let userDlg = $state<{ mode: 'create' | 'password'; name: string } | null>(null)
  let uName = $state('')
  let uPass = $state('')
  let uShow = $state(false)
  let uAlg = $state<ScramAlgorithm>('SCRAM-SHA-256')
  let uRoles = $state<string[]>([])
  let uBusy = $state(false)
  let uError = $state<string | null>(null)
  const uNameErr = $derived(userDlg?.mode === 'create' ? userNameProblem(uName, users) : null)
  const uPassErr = $derived(passwordProblem(uPass))

  function openUser(mode: 'create' | 'password', name = '') {
    userDlg = { mode, name }
    uName = name
    uPass = ''
    uShow = false
    uAlg = 'SCRAM-SHA-256'
    uRoles = []
    uError = null
  }
  function generate() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_'
    const a = new Uint32Array(20)
    crypto.getRandomValues(a)
    uPass = [...a].map((n) => chars[n % chars.length]).join('')
    uShow = true
  }
  async function saveUser() {
    if (!userDlg || uBusy || uNameErr || uPassErr) return
    uBusy = true
    uError = null
    try {
      if (userDlg.mode === 'create') {
        const name = uName.trim()
        await rpCall(connId, rp.createUser(name, uPass, uAlg))
        for (const r of uRoles) await rpCall(connId, rp.roleMembers(r, [name], []))
        toasts.success(`Created user ${name}`)
        userDlg = null
        await load()
        grantFor = `User:${name}`
      } else {
        await rpCall(connId, rp.setPassword(userDlg.name, uPass, uAlg))
        toasts.success(`Changed the password of ${userDlg.name}`)
        userDlg = null
      }
    } catch (e) {
      uError = rpMessage(e)
    } finally {
      uBusy = false
    }
  }

  // ---- confirm (delete user / role / ACLs) ----
  let confirm = $state<{ title: string; body: string; action: string; run: () => Promise<void>; check?: string } | null>(null)
  let checkValue = $state(true)
  let cBusy = $state(false)
  let cError = $state<string | null>(null)
  function ask(c: NonNullable<typeof confirm>) {
    confirm = c
    checkValue = true
    cError = null
  }
  async function runConfirm() {
    if (!confirm || cBusy) return
    cBusy = true
    cError = null
    try {
      await confirm.run()
      confirm = null
      await load()
    } catch (e) {
      cError = rpMessage(e)
    } finally {
      cBusy = false
    }
  }

  function deleteUser(u: string) {
    const n = aclCount(`User:${u}`)
    ask({
      title: `Delete user ${u}?`,
      body: `${u} can no longer sign in. ${n ? `Their ${plural(n, 'ACL')} stay until you delete them.` : ''}`,
      action: 'Delete user',
      check: n ? `Also delete ${plural(n, 'ACL')} granted to ${u}` : undefined,
      run: async () => {
        await rpCall(connId, rp.deleteUser(u))
        if (n && checkValue) await ipc.kafkaDeleteAcls(connId, [{ principal: `User:${u}` }])
        toasts.success(`Deleted user ${u}`)
      },
    })
  }

  // ---- roles ----
  let roleDlg = $state(false)
  let rName = $state('')
  let rBusy = $state(false)
  let rError = $state<string | null>(null)
  const rNameErr = $derived(roleNameProblem(rName, roles))
  async function createRole() {
    if (rNameErr || rBusy) return
    rBusy = true
    rError = null
    try {
      const name = rName.trim()
      await rpCall(connId, rp.createRole(name))
      toasts.success(`Created role ${name}`)
      roleDlg = false
      focusRole = name
      await load()
    } catch (e) {
      rError = rpMessage(e)
    } finally {
      rBusy = false
    }
  }
  let focusRole = $state<string | null>(null)
  let addMember = $state('')
  async function changeMembers(role: string, add: string[], remove: string[]) {
    try {
      await rpCall(connId, rp.roleMembers(role, add, remove))
      addMember = ''
      await load()
    } catch (e) {
      toasts.error(rpMessage(e))
    }
  }
  function deleteRole(r: string) {
    const n = aclCount(`RedpandaRole:${r}`)
    ask({
      title: `Delete role ${r}?`,
      body: `Its ${plural((members[r] ?? []).length, 'member')} lose what the role grants.`,
      action: 'Delete role',
      check: n ? `Also delete the ${plural(n, 'ACL')} granted to the role` : undefined,
      run: async () => {
        await rpCall(connId, rp.deleteRole(r, n > 0 && checkValue))
        toasts.success(`Deleted role ${r}`)
        if (focusRole === r) focusRole = null
      },
    })
  }

  // ---- ACLs ----
  let aclFilter = $state('')
  let aclWho = $state('')
  let picked = $state<Set<string>>(new Set())
  const principals = $derived([...new Set(acls.map((a) => a.principal))].sort())
  const shownAcls = $derived(
    acls
      .filter((a) => !aclWho || a.principal === aclWho)
      .filter((a) => {
        const q = aclFilter.trim().toLowerCase()
        return !q || [a.principal, a.resource_name, a.operation, a.resource_type, aclSentence(a)].some((x) => x.toLowerCase().includes(q))
      })
      .sort((a, b) => a.principal.localeCompare(b.principal) || a.resource_type.localeCompare(b.resource_type) || a.resource_name.localeCompare(b.resource_name)),
  )
  function togglePick(a: ipc.KafkaAcl) {
    const k = aclKey(a)
    const n = new Set(picked)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    picked = n
  }
  function deleteAcls(list: ipc.KafkaAcl[]) {
    ask({
      title: list.length === 1 ? 'Delete this ACL?' : `Delete ${list.length} ACLs?`,
      body: list.length === 1 ? aclSentence(list[0]) : 'The selected permissions are removed at once.',
      action: list.length === 1 ? 'Delete ACL' : `Delete ${list.length} ACLs`,
      run: async () => {
        // an exact filter per binding — removes only those
        await ipc.kafkaDeleteAcls(connId, list.map((a) => ({ ...a })))
        picked = new Set()
        toasts.success(list.length === 1 ? 'Deleted the ACL' : `Deleted ${list.length} ACLs`)
      },
    })
  }
  const who = (p: string) => {
    const s = splitPrincipal(p)
    return { ...s, label: s.name === '*' ? 'Everyone' : s.name }
  }
</script>

<div class="ks">
  <div class="ks-bar">
    <div class="um-tabs" role="tablist" aria-label="Security">
      {#if redpanda}
        <button type="button" role="tab" class="um-tab" aria-selected={tab === 'users'} onclick={() => (tab = 'users')}>Users <span class="ks-count">{users.length}</span></button>
        <button type="button" role="tab" class="um-tab" aria-selected={tab === 'roles'} onclick={() => (tab = 'roles')}>Roles <span class="ks-count">{roles.length}</span></button>
      {/if}
      <button type="button" role="tab" class="um-tab" aria-selected={tab === 'acls'} onclick={() => (tab = 'acls')}>ACLs <span class="ks-count">{acls.length}</span></button>
    </div>
    <span class="ks-grow"></span>
    {#if tab === 'users'}
      <button type="button" class="cfm-btn primary" onclick={() => openUser('create')}><Icon name="plus" size={13} /> Create user</button>
    {:else if tab === 'roles'}
      <button type="button" class="cfm-btn primary" onclick={() => { rName = ''; rError = null; roleDlg = true }}><Icon name="plus" size={13} /> Create role</button>
    {:else}
      <button type="button" class="cfm-btn primary" onclick={() => (grantFor = '')}><Icon name="plus" size={13} /> Grant access</button>
    {/if}
  </div>

  {#if tab === 'users'}
    {#if usersError}
      <div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span><b>Could not read the users.</b> {usersError}</span></div>
    {:else if users.length === 0}
      <div class="ds-empty">{loading ? 'Reading users…' : ''}{#if !loading}<b>No SASL users yet</b>Clients sign in with a SCRAM user name and password.{/if}</div>
    {:else}
      <table class="ds-table ks-table" aria-label="Users">
        <thead><tr><th>User</th><th>Roles</th><th class="r">ACLs</th><th class="r"></th></tr></thead>
        <tbody>
          {#each users as u (u)}
            {@const rs = rolesOf(u)}
            <tr>
              <td><span class="ks-who"><Icon name="user" size={13} /><span class="ds-name">{u}</span></span></td>
              <td>{#if rs.length}{#each rs as r (r)}<span class="ds-chip">{r}</span> {/each}{:else}<span class="ks-dim">—</span>{/if}</td>
              <td class="r ds-num">{aclCount(`User:${u}`)}</td>
              <td class="r ks-actions">
                <button type="button" class="eg-btn" onclick={() => (grantFor = `User:${u}`)}>Grant access…</button>
                <button type="button" class="eg-btn" onclick={() => openUser('password', u)}>Change password…</button>
                <button type="button" class="eg-btn um-ghost-danger" aria-label="Delete user {u}" title="Delete user" onclick={() => deleteUser(u)}><Icon name="trash" size={13} /></button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {:else if tab === 'roles'}
    {#if rolesError}
      <div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span><b>Could not read the roles.</b> {rolesError}</span></div>
    {:else if roles.length === 0}
      <div class="ds-empty">{#if loading}Reading roles…{:else}<b>No roles yet</b>A role groups permissions: grant ACLs to the role once, then add users to it.{/if}</div>
    {:else}
      <div class="ks-roles">
        <ul class="ks-role-list" aria-label="Roles">
          {#each roles as r (r)}
            <li>
              <button type="button" class="ks-role" class:on={focusRole === r} onclick={() => (focusRole = r)}>
                <Icon name="users" size={13} /><span class="ds-name">{r}</span>
                <span class="ks-dim">{plural((members[r] ?? []).length, 'member')} · {plural(aclCount(`RedpandaRole:${r}`), 'ACL')}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if focusRole && roles.includes(focusRole)}
          {@const r = focusRole}
          {@const ms = members[r] ?? []}
          <section class="ks-role-detail" aria-label="Role {r}">
            <div class="ks-role-head">
              <b class="mono">{r}</b>
              <span class="ks-grow"></span>
              <button type="button" class="eg-btn" onclick={() => (grantFor = `RedpandaRole:${r}`)}>Grant access…</button>
              <button type="button" class="eg-btn um-ghost-danger" onclick={() => deleteRole(r)}>Delete role…</button>
            </div>
            <div class="ds-section-title">Members</div>
            {#if ms.length === 0}<div class="ks-dim">No members yet.</div>{/if}
            <div class="ks-members">
              {#each ms as m (m)}
                <span class="ks-member"><Icon name="user" size={12} />{m}<button type="button" aria-label="Remove {m} from {r}" title="Remove from role" onclick={() => changeMembers(r, [], [m])}><Icon name="close" size={11} /></button></span>
              {/each}
            </div>
            <div class="um-inline">
              <select class="um-select" bind:value={addMember} aria-label="Add a member">
                <option value="">Add a user…</option>
                {#each users.filter((u) => !ms.includes(u)) as u (u)}<option value={u}>{u}</option>{/each}
              </select>
              <button type="button" class="cfm-btn" disabled={!addMember} onclick={() => changeMembers(r, [addMember], [])}>Add</button>
            </div>
            <div class="ds-section-title">What the role may do</div>
            {#if aclCount(`RedpandaRole:${r}`) === 0}
              <div class="ks-dim">Nothing yet — use Grant access.</div>
            {:else}
              <ul class="ks-sentences">
                {#each acls.filter((a) => a.principal === `RedpandaRole:${r}`) as a (aclKey(a))}<li class:deny={a.permission === 'DENY'}>{aclSentence(a)}</li>{/each}
              </ul>
            {/if}
          </section>
        {:else}
          <div class="ds-empty ks-role-detail">Select a role to see its members and permissions.</div>
        {/if}
      </div>
    {/if}
  {:else}
    {#if !redpanda}
      <div class="ks-note"><Icon name="info" size={14} /><span>ACLs decide what each authenticated user may do. Users themselves are managed by your Kafka setup (SCRAM credentials, mTLS, OAuth…), not here.</span></div>
    {/if}
    {#if aclsError}
      <div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span><b>Could not read the ACLs.</b> {aclsError}</span></div>
    {:else}
      <div class="ks-tools">
        <input class="um-input" type="search" bind:value={aclFilter} placeholder="Filter by user, topic or permission" aria-label="Filter ACLs" />
        <select class="um-select" bind:value={aclWho} aria-label="Filter by principal">
          <option value="">Everyone</option>
          {#each principals as p (p)}<option value={p}>{who(p).kind === 'RedpandaRole' ? `Role ${who(p).name}` : who(p).label}</option>{/each}
        </select>
        <span class="ks-grow"></span>
        {#if picked.size}
          <button type="button" class="cfm-btn ds-danger-outline" onclick={() => deleteAcls(acls.filter((a) => picked.has(aclKey(a))))}>Delete {picked.size} selected</button>
        {/if}
      </div>
      {#if shownAcls.length === 0}
        <div class="ds-empty">{#if loading}Reading ACLs…{:else if acls.length}No ACL matches the filter.{:else if redpanda}<b>No ACLs</b>When authorization is on, nobody but superusers can do anything until you grant access.{:else}<b>No ACLs</b>If the brokers have no authorizer configured, every client may do everything and ACLs cannot be created — Grant access will say so.{/if}</div>
      {:else}
        <table class="ds-table ks-table" aria-label="ACLs">
          <thead><tr><th class="ks-pick"></th><th>Who</th><th>Permission</th><th>Action</th><th>On</th><th>Host</th><th class="r"></th></tr></thead>
          <tbody>
            {#each shownAcls as a (aclKey(a))}
              {@const w = who(a.principal)}
              <tr>
                <td class="ks-pick"><input type="checkbox" checked={picked.has(aclKey(a))} onchange={() => togglePick(a)} aria-label="Select {aclSentence(a)}" /></td>
                <td><span class="ks-who"><Icon name={w.kind === 'RedpandaRole' ? 'users' : 'user'} size={13} /><span class="ds-name">{w.label}</span>{#if w.kind === 'RedpandaRole'}<span class="ks-dim">role</span>{/if}</span></td>
                <td><span class="ks-perm" class:deny={a.permission === 'DENY'}>{a.permission === 'DENY' ? 'Deny' : 'Allow'}</span></td>
                <td title={a.operation}>{operationText(a.operation)}</td>
                <td>
                  <span class="ks-dim">{resourceText(a.resource_type)}</span>
                  {#if a.resource_type !== 'CLUSTER'}
                    <span class="mono">{a.resource_name === '*' ? 'all' : a.resource_name}</span>{#if a.pattern_type === 'PREFIXED'}<span class="ks-dim ks-gap">starts with</span>{/if}
                  {/if}
                </td>
                <td class="mono ks-dim">{a.host === '*' ? 'any' : a.host}</td>
                <td class="r"><button type="button" class="eg-btn um-ghost-danger" aria-label="Delete ACL" title="Delete ACL" onclick={() => deleteAcls([a])}><Icon name="trash" size={13} /></button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
  {/if}
</div>

{#if grantFor !== null}
  <AclGrantDialog
    {connId}
    {users}
    {roles}
    {topics}
    {groups}
    rolesSupported={redpanda}
    principal={grantFor}
    onClose={() => (grantFor = null)}
    onDone={(n) => {
      grantFor = null
      toasts.success(n === 1 ? 'Granted access' : `Created ${n} ACLs`)
      tab = tab === 'users' || tab === 'roles' ? tab : 'acls'
      void load()
    }}
  />
{/if}

{#if userDlg}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !uBusy && (userDlg = null)}>
    <div class="um-dlg sm" role="dialog" aria-modal="true" aria-label={userDlg.mode === 'create' ? 'Create user' : 'Change password'} tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name={userDlg.mode === 'create' ? 'user' : 'key'} size={18} /></span>
        <div class="um-dlg-title">
          <b>{userDlg.mode === 'create' ? 'Create user' : `Change password of ${userDlg.name}`}</b>
          <span>A SASL/SCRAM user clients sign in with</span>
        </div>
        <span class="um-dlg-x" role="button" tabindex="0" aria-label="Close dialog" onclick={() => !uBusy && (userDlg = null)} onkeydown={(e) => e.key === 'Enter' && !uBusy && (userDlg = null)}><Icon name="close" size={16} /></span>
      </div>
      <div class="um-dlg-body">
        {#if userDlg.mode === 'create'}
          <label class="um-field">
            User name
            <input class="um-input mono" class:invalid={!!uName && !!uNameErr} bind:value={uName} use:autofocus aria-label="User name" spellcheck="false" autocomplete="off" />
            {#if uName && uNameErr}<span class="um-field-err">{uNameErr}</span>{/if}
          </label>
        {/if}
        <label class="um-field">
          Password
          <span class="um-pw">
            <input class="um-input mono" type={uShow ? 'text' : 'password'} bind:value={uPass} aria-label="Password" autocomplete="new-password" />
            <button type="button" class="eg-btn" aria-label={uShow ? 'Hide password' : 'Show password'} title={uShow ? 'Hide' : 'Show'} onclick={() => (uShow = !uShow)}><Icon name={uShow ? 'eye-off' : 'eye'} size={13} /></button>
            <button type="button" class="eg-btn" title="Generate a strong password" onclick={generate}><Icon name="sparkle" size={13} /> Generate</button>
          </span>
          {#if uPass && uPassErr}<span class="um-field-err">{uPassErr}</span>{/if}
        </label>
        <div class="um-field">
          Mechanism
          <div class="um-seg" role="group" aria-label="Mechanism">
            {#each SCRAM_ALGORITHMS as a (a)}
              <span role="button" tabindex="0" aria-pressed={uAlg === a} onclick={() => (uAlg = a)} onkeydown={(e) => e.key === 'Enter' && (uAlg = a)}>{a}</span>
            {/each}
          </div>
          <span class="um-field-hint">Clients must use the same mechanism to sign in.</span>
        </div>
        {#if userDlg.mode === 'create' && roles.length}
          <div class="um-field">
            Add to roles
            <div class="ks-checks">
              {#each roles as r (r)}
                <label class="um-checkline"><input type="checkbox" checked={uRoles.includes(r)} onchange={() => (uRoles = uRoles.includes(r) ? uRoles.filter((x) => x !== r) : [...uRoles, r])} /> {r}</label>
              {/each}
            </div>
          </div>
        {/if}
        {#if uError}<div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span>{uError}</span></div>{/if}
      </div>
      <div class="um-dlg-foot">
        {#if userDlg.mode === 'create'}<span class="um-dlg-foot-note">Next: choose what the user may do.</span>{/if}
        <button type="button" class="cfm-btn" onclick={() => (userDlg = null)} disabled={uBusy}>Cancel</button>
        <button type="button" class="cfm-btn primary" onclick={saveUser} disabled={uBusy || !!uNameErr || !!uPassErr}>{uBusy ? 'Saving…' : userDlg.mode === 'create' ? 'Create user' : 'Change password'}</button>
      </div>
    </div>
  </div>
{/if}

{#if roleDlg}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !rBusy && (roleDlg = false)}>
    <div class="um-dlg sm" role="dialog" aria-modal="true" aria-label="Create role" tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="users" size={18} /></span>
        <div class="um-dlg-title"><b>Create role</b><span>Grant permissions to the role, then add users to it</span></div>
        <span class="um-dlg-x" role="button" tabindex="0" aria-label="Close dialog" onclick={() => !rBusy && (roleDlg = false)} onkeydown={(e) => e.key === 'Enter' && !rBusy && (roleDlg = false)}><Icon name="close" size={16} /></span>
      </div>
      <div class="um-dlg-body">
        <label class="um-field">
          Role name
          <input class="um-input mono" class:invalid={!!rName && !!rNameErr} bind:value={rName} use:autofocus aria-label="Role name" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && createRole()} />
          {#if rName && rNameErr}<span class="um-field-err">{rNameErr}</span>{/if}
        </label>
        {#if rError}<div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span>{rError}</span></div>{/if}
      </div>
      <div class="um-dlg-foot">
        <button type="button" class="cfm-btn" onclick={() => (roleDlg = false)} disabled={rBusy}>Cancel</button>
        <button type="button" class="cfm-btn primary" onclick={createRole} disabled={rBusy || !!rNameErr}>{rBusy ? 'Creating…' : 'Create role'}</button>
      </div>
    </div>
  </div>
{/if}

{#if confirm}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !cBusy && (confirm = null)}>
    <div class="um-dlg sm" role="dialog" aria-modal="true" aria-label={confirm.title} tabindex="-1" use:autofocus>
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
        <div class="um-dlg-title"><b>{confirm.title}</b></div>
      </div>
      <div class="um-dlg-body">
        <p class="ks-confirm">{confirm.body}</p>
        {#if confirm.check}<label class="um-checkline"><input type="checkbox" bind:checked={checkValue} /> {confirm.check}</label>{/if}
        {#if cError}<div class="um-callout danger" role="alert"><Icon name="warning" size={15} /><span>{cError}</span></div>{/if}
      </div>
      <div class="um-dlg-foot">
        <button type="button" class="cfm-btn" onclick={() => (confirm = null)} disabled={cBusy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={runConfirm} disabled={cBusy}>{cBusy ? 'Working…' : confirm.action}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .ks {
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
    padding: var(--px-14) var(--px-16);
    overflow: auto;
    min-height: 0;
    flex: 1;
  }
  .ks-bar,
  .ks-tools {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    flex-wrap: wrap;
  }
  .ks-tools .um-input {
    flex: 0 1 var(--px-300);
  }
  .ks-grow {
    flex: 1;
  }
  .ks-count {
    margin-left: var(--px-4);
    font-size: var(--px-11);
    color: var(--muted);
  }
  .ks-table td {
    vertical-align: middle;
  }
  .ks-who {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    color: var(--muted);
  }
  .ks-dim {
    color: var(--muted);
    font-size: var(--px-12);
  }
  .ks-gap {
    margin-left: var(--px-6);
  }
  .ks-actions {
    white-space: nowrap;
  }
  .ks-actions .eg-btn + .eg-btn {
    margin-left: var(--px-4);
  }
  .ks-pick {
    width: var(--px-30);
  }
  .ks-perm {
    font-size: var(--px-11_5);
    font-weight: 600;
    padding: var(--px-1) var(--px-8);
    border-radius: var(--px-9);
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--text);
  }
  .ks-perm.deny {
    background: var(--danger-soft);
    color: var(--danger-text);
  }
  .ks-note {
    display: flex;
    align-items: flex-start;
    gap: var(--px-8);
    font-size: var(--px-12_5);
    color: var(--text2);
    padding: var(--px-8) var(--px-12);
    border-radius: var(--px-8);
    background: var(--panel);
  }
  .ks-roles {
    display: grid;
    grid-template-columns: minmax(var(--px-200), var(--px-300)) 1fr;
    gap: var(--px-12);
    min-height: 0;
  }
  .ks-role-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
  }
  .ks-role {
    width: 100%;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--px-2) var(--px-8);
    align-items: center;
    text-align: left;
    padding: var(--px-8) var(--px-10);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    background: var(--surface);
    color: var(--muted);
    font-family: var(--font-main);
    cursor: pointer;
  }
  .ks-role .ks-dim {
    grid-column: 2;
  }
  .ks-role:hover {
    background: var(--row-hover);
  }
  .ks-role.on {
    border-color: var(--primary);
    box-shadow: 0 0 0 var(--px-1) var(--primary);
  }
  .ks-role-detail {
    display: flex;
    flex-direction: column;
    gap: var(--px-8);
    padding: var(--px-12) var(--px-14);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
  }
  .ks-role-head {
    display: flex;
    align-items: center;
    gap: var(--px-8);
  }
  .ks-members {
    display: flex;
    gap: var(--px-6);
    flex-wrap: wrap;
  }
  .ks-member {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
    padding: var(--px-2) var(--px-4) var(--px-2) var(--px-8);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-12);
    font-size: var(--px-12);
    color: var(--text);
  }
  .ks-member button {
    border: 0;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    display: inline-flex;
    padding: var(--px-2);
    border-radius: var(--px-8);
  }
  .ks-member button:hover {
    color: var(--danger-solid);
  }
  .ks-sentences {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
  }
  .ks-sentences li {
    font-size: var(--px-12_5);
    padding: var(--px-5) var(--px-10);
    border-radius: var(--px-7);
    background: var(--panel);
    color: var(--text);
  }
  .ks-sentences li.deny {
    background: var(--danger-soft);
    color: var(--danger-text);
  }
  .ks-checks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-6) var(--px-14);
  }
  .ks-confirm {
    margin: 0;
    font-size: var(--px-13);
    color: var(--text);
    line-height: 1.5;
  }
</style>
