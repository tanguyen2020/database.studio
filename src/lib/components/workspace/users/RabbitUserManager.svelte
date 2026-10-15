<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  // RabbitMQ users & access (Management HTTP API): users + tags + password,
  // vhost permissions (configure / write / read regexes) + topic permissions,
  // policies per vhost, and virtual hosts. Every change is applied immediately —
  // the API has no transactions — and the lists are re-read from the broker after.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { autofocus } from '$lib/actions/autofocus'
  import { toasts } from '$lib/stores/toast.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import {
    APPLY_TO,
    KNOWN_TAGS,
    PERMISSION_PRESETS,
    POLICY_KEYS,
    describeRegex,
    generatePassword,
    parsePolicyDefinition,
    policySummary,
    presetOf,
    regexError,
    withPolicyKey,
    type PermissionPresetKey,
  } from '$lib/rabbitmq/access'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const connId = $derived(tab.connectionId ?? '')
  // vhost the connection is opened on (the profile's `database`; '' = '/') — it cannot be deleted from here
  const connVhost = $derived(connections.byId(connId)?.database?.trim() || '/')

  type Section = 'users' | 'permissions' | 'policies' | 'vhosts'
  let section = $state<Section>('users')

  let me = $state<ipc.RabbitWhoami | null>(null)
  let users = $state<ipc.RabbitUser[]>([])
  let perms = $state<ipc.RabbitPermission[]>([])
  let topicPerms = $state<ipc.RabbitTopicPermission[]>([])
  let vhosts = $state<ipc.RabbitVhost[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)
  let usersError = $state<string | null>(null)
  let permsError = $state<string | null>(null)
  let vhostsError = $state<string | null>(null)
  let selected = $state<string | null>(null)
  let userFilter = $state('')

  const isAdmin = $derived(!!me?.tags.includes('administrator'))
  const vhostNames = $derived(vhosts.map((v) => v.name))
  const shownUsers = $derived(users.filter((u) => u.name.toLowerCase().includes(userFilter.trim().toLowerCase())))
  const current = $derived(users.find((u) => u.name === selected) ?? null)
  const userPerms = $derived(perms.filter((p) => p.user === selected).sort((a, b) => a.vhost.localeCompare(b.vhost)))
  const userTopicPerms = $derived(topicPerms.filter((p) => p.user === selected))

  async function load() {
    if (!connId) return
    loading = true
    error = null
    try {
      // Each part on its own: a user without the 'administrator' tag is refused the
      // user / permission lists but can still read vhosts and policies — one refusal
      // must not blank the whole manager (it used to).
      const [w, us, ps, tps, vs] = await Promise.allSettled([
        ipc.rabbitWhoami(connId),
        ipc.rabbitUsers(connId),
        ipc.rabbitPermissions(connId),
        ipc.rabbitTopicPermissions(connId),
        ipc.rabbitVhostList(connId),
      ])
      const val = <T,>(r: PromiseSettledResult<T>, fallback: T): T => (r.status === 'fulfilled' ? r.value : fallback)
      const why = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? String(r.reason) : null)
      me = val(w, null)
      users = val(us, [])
      perms = val(ps, [])
      topicPerms = val(tps, [])
      vhosts = val(vs, [])
      usersError = why(us)
      permsError = why(ps) ?? why(tps)
      vhostsError = why(vs)
      if (w.status === 'rejected') error = String(w.reason)
      const focus = (tab.state as { focus?: string }).focus
      if (!selected || !users.some((u) => u.name === selected)) selected = focus && users.some((u) => u.name === focus) ? focus : (users[0]?.name ?? null)
      if (!policyVhost || !vhosts.some((v) => v.name === policyVhost)) policyVhost = vhosts[0]?.name ?? '/'
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void connId
    untrack(() => void load())
  })

  /** Run a change, report it, re-read from the broker. */
  async function apply(what: string, run: () => Promise<unknown>): Promise<boolean> {
    try {
      await run()
      toasts.success(what, 'rabbitmq')
      await load()
      if (section === 'policies') await loadPolicies()
      return true
    } catch (e) {
      toasts.error(String(e), 'rabbitmq')
      return false
    }
  }

  // ---- confirm (backdrop never closes — rule chung) --------------------------------
  let confirmState = $state<{ title: string; body: string; action: string; run: () => Promise<void> } | null>(null)
  let confirmBusy = $state(false)
  function askConfirm(title: string, body: string, action: string, run: () => Promise<void>) {
    confirmState = { title, body, action, run }
  }
  async function runConfirm() {
    if (!confirmState || confirmBusy) return
    confirmBusy = true
    try {
      await confirmState.run()
      confirmState = null
    } finally {
      confirmBusy = false
    }
  }

  // ---- user detail: tags + password ------------------------------------------------
  let tagDraft = $state<string[]>([])
  let customTag = $state('')
  let newPassword = $state('')
  let showPassword = $state(false)
  // A permission-matrix click selects the user AND opens its editor for that vhost;
  // the editor must open after this effect resets the detail pane, not before.
  let pendingEdit: string | null = null
  $effect(() => {
    const u = current
    untrack(() => {
      tagDraft = u ? [...u.tags] : []
      newPassword = ''
      editPerm = null
      if (u && pendingEdit) {
        const v = pendingEdit
        pendingEdit = null
        openPermFor(v)
      }
    })
  })

  function openPermFor(vhost: string) {
    const p = perms.find((x) => x.user === selected && x.vhost === vhost)
    if (p) openPermEditor(p)
    else {
      openPermEditor()
      if (editPerm) editPerm.vhost = vhost
    }
  }

  function editCell(user: string, vhost: string) {
    section = 'users'
    if (selected === user) openPermFor(vhost)
    else {
      pendingEdit = vhost
      selected = user
    }
  }
  const tagsChanged = $derived(!!current && [...tagDraft].sort().join(',') !== [...current.tags].sort().join(','))
  const customTags = $derived(tagDraft.filter((t) => !KNOWN_TAGS.some((k) => k.tag === t)))

  function toggleTag(tag: string) {
    tagDraft = tagDraft.includes(tag) ? tagDraft.filter((t) => t !== tag) : [...tagDraft, tag]
  }
  function addCustomTag() {
    const t = customTag.trim()
    if (t && !tagDraft.includes(t)) tagDraft = [...tagDraft, t]
    customTag = ''
  }

  // ---- user detail: vhost permission editor ----------------------------------------
  let editPerm = $state<{ vhost: string; preset: PermissionPresetKey; configure: string; write: string; read: string; isNew: boolean } | null>(null)
  const permErrors = $derived(
    editPerm ? (['configure', 'write', 'read'] as const).map((k) => [k, regexError(editPerm![k])] as const).filter(([, e]) => e) : [],
  )

  function openPermEditor(p?: ipc.RabbitPermission) {
    if (p) {
      editPerm = { vhost: p.vhost, preset: presetOf(p), configure: p.configure, write: p.write, read: p.read, isNew: false }
    } else {
      const free = vhostNames.find((v) => !userPerms.some((p) => p.vhost === v)) ?? vhostNames[0] ?? '/'
      editPerm = { vhost: free, preset: 'read-only', configure: '^$', write: '^$', read: '.*', isNew: true }
    }
  }

  function pickPreset(key: PermissionPresetKey) {
    if (!editPerm) return
    editPerm.preset = key
    const p = PERMISSION_PRESETS.find((x) => x.key === key)
    if (p) {
      editPerm.configure = p.configure
      editPerm.write = p.write
      editPerm.read = p.read
    }
  }

  async function savePerm() {
    if (!editPerm || !selected || permErrors.length) return
    const e = editPerm
    const user = selected
    const ok = await apply(`Access to ${e.vhost} saved for ${user}`, () => ipc.rabbitSetPermission(connId, e.vhost, user, e.configure, e.write, e.read))
    if (ok) editPerm = null
  }

  // ---- user detail: topic permissions ------------------------------------------------
  let topicDraft = $state({ vhost: '/', exchange: 'amq.topic', write: '.*', read: '.*' })

  // ---- new user ------------------------------------------------------------------------
  let createOpen = $state(false)
  let nu = $state({ name: '', password: '', show: false, tags: ['management'] as string[], vhost: '', preset: 'read-only' as PermissionPresetKey })
  let createBusy = $state(false)
  let createError = $state<string | null>(null)
  const nameTaken = $derived(users.some((u) => u.name === nu.name.trim()))

  function openCreate() {
    nu = { name: '', password: generatePassword(), show: false, tags: ['management'], vhost: connVhost, preset: 'read-only' }
    createError = null
    createOpen = true
  }

  async function createUser() {
    const name = nu.name.trim()
    if (!name || nameTaken || createBusy) return
    createBusy = true
    createError = null
    try {
      await ipc.rabbitCreateUser(connId, name, nu.password, nu.tags)
      if (nu.vhost) {
        const p = PERMISSION_PRESETS.find((x) => x.key === nu.preset)
        if (p) {
          try {
            await ipc.rabbitSetPermission(connId, nu.vhost, name, p.configure, p.write, p.read)
          } catch (e) {
            toasts.error(`User created, but granting access failed: ${e}`, 'rabbitmq')
          }
        }
      }
      toasts.success(`Created user ${name}`, 'rabbitmq')
      createOpen = false
      await load()
      selected = name
      section = 'users'
    } catch (e) {
      createError = String(e)
    } finally {
      createBusy = false
    }
  }

  // ---- policies --------------------------------------------------------------------------
  let policyVhost = $state('/')
  let policies = $state<ipc.RabbitPolicy[]>([])
  let policiesError = $state<string | null>(null)
  async function loadPolicies() {
    if (!connId) return
    try {
      policies = await ipc.rabbitPolicies(connId, policyVhost)
      policiesError = null
    } catch (e) {
      policies = []
      policiesError = String(e)
    }
  }
  $effect(() => {
    if (section !== 'policies') return
    void policyVhost
    untrack(() => void loadPolicies())
  })

  let policyEdit = $state<{ isNew: boolean; name: string; pattern: string; applyTo: string; priority: number; definition: string } | null>(null)
  let policyError = $state<string | null>(null)
  const policyParsed = $derived(policyEdit ? parsePolicyDefinition(policyEdit.definition) : null)
  const policyPatternError = $derived(policyEdit ? regexError(policyEdit.pattern) : null)

  function openPolicy(p?: ipc.RabbitPolicy) {
    policyError = null
    policyEdit = p
      ? { isNew: false, name: p.name, pattern: p.pattern, applyTo: p.apply_to, priority: p.priority, definition: JSON.stringify(p.definition, null, 2) }
      : { isNew: true, name: '', pattern: '^', applyTo: 'queues', priority: 0, definition: '{\n  "max-length": 10000\n}' }
  }

  async function savePolicy() {
    const p = policyEdit
    if (!p || !policyParsed?.ok || policyPatternError || !p.name.trim()) return
    const def = policyParsed.value
    try {
      await ipc.rabbitSetPolicy(connId, policyVhost, p.name.trim(), p.pattern, p.applyTo, Number(p.priority) || 0, def)
      toasts.success(`Policy ${p.name.trim()} saved`, 'rabbitmq')
      policyEdit = null
      await loadPolicies()
    } catch (e) {
      policyError = String(e) // keep the dialog: fix and save again
    }
  }

  // ---- vhosts ------------------------------------------------------------------------------
  let newVhost = $state({ name: '', description: '' })
  const vhostTaken = $derived(vhostNames.includes(newVhost.name.trim()))

  const PRESET_LABEL: Record<PermissionPresetKey, string> = {
    full: 'Full access',
    'read-only': 'Read only',
    'publish-only': 'Publish only',
    custom: 'Custom',
  }
  const permFor = (user: string, vhost: string) => perms.find((p) => p.user === user && p.vhost === vhost)
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-13);font-weight:700;color:var(--text)">Users &amp; access</span>
    {#if me}
      <span style="font-size:var(--px-11_5);color:var(--muted)">logged in as <span class="mono" style="color:var(--text2)">{me.name}</span>{#if me.tags.length}{' · ' + me.tags.join(', ')}{/if}</span>
    {/if}
    <span style="margin-left:auto;display:flex;gap:var(--px-8)">
      <span onclick={openCreate} onkeydown={(e) => e.key === 'Enter' && openCreate()} role="button" tabindex="0" class="pv-btn primary">＋ New user</span>
      <span onclick={() => load()} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" class="pv-btn" aria-busy={loading}><Icon name="refresh" size={12} /> Refresh</span>
    </span>
  </div>

  {#if me && !isAdmin}
    <div role="note" style="flex:none;padding:var(--px-8) var(--px-14);font-size:var(--px-11_5);color:var(--sacc-amber);border-bottom:var(--px-1) solid var(--border)">
      <span class="mono">{me.name}</span> does not have the <b>administrator</b> tag — the broker will refuse changes to users, permissions and vhosts (policies need <b>policymaker</b>).
    </div>
  {/if}
  {#if error}
    <div role="alert" style="flex:none;padding:var(--px-8) var(--px-14);font-size:var(--px-11_5);color:var(--error);border-bottom:var(--px-1) solid var(--border)">{error}</div>
  {/if}

  <div role="tablist" aria-label="Access sections" style="flex:none;display:flex;gap:var(--px-4);padding:var(--px-6) var(--px-14) 0;border-bottom:var(--px-1) solid var(--border)">
    {#each [['users', `Users (${users.length})`], ['permissions', 'Permissions'], ['policies', 'Policies'], ['vhosts', `Virtual hosts (${vhosts.length})`]] as [key, label] (key)}
      <span role="tab" tabindex="0" aria-selected={section === key} class="ru-tab" class:on={section === key} onclick={() => (section = key as Section)} onkeydown={(e) => e.key === 'Enter' && (section = key as Section)}>{label}</span>
    {/each}
  </div>

  <div style="flex:1;min-height:0;overflow:auto">
    {#if section === 'users' && usersError}
      <div role="alert" data-testid="users-error" style="padding:var(--px-14);font-size:var(--px-12);color:var(--error);line-height:1.5">
        {usersError}
        {#if me}<div style="color:var(--muted);margin-top:var(--px-6)">Logged in as <span class="mono">{me.name}</span> ({me.tags.join(', ') || 'no tags'}). Policies and Virtual hosts can still be read.</div>{/if}
      </div>
    {:else if section === 'users'}
      <div style="display:flex;min-height:100%">
        <!-- user list -->
        <div style="flex:none;width:var(--px-240);max-width:40%;border-right:var(--px-1) solid var(--border);padding:var(--px-8)">
          <input bind:value={userFilter} placeholder="Filter users…" aria-label="Filter users" class="mono ru-input" style="width:100%;margin-bottom:var(--px-6)" spellcheck="false" />
          {#each shownUsers as u (u.name)}
            <div
              class="ru-user"
              class:sel={u.name === selected}
              onclick={() => (selected = u.name)}
              onkeydown={(e) => e.key === 'Enter' && (selected = u.name)}
              role="option"
              aria-selected={u.name === selected}
              tabindex="0"
            >
              <span class="mono" style="font-weight:600;color:var(--tbl-link)">{u.name}</span>
              {#if me?.name === u.name}<span class="ru-badge">you</span>{/if}
              {#if !u.has_password}<span class="ru-badge" title="Cannot log in with a password (certificate / external auth only)">no password</span>{/if}
              <span style="margin-left:auto;font-size:var(--px-10_5);color:var(--tbl-meta);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{u.tags.join(', ') || 'no tags'}</span>
            </div>
          {/each}
          {#if !shownUsers.length && !loading}<div style="font-size:var(--px-11_5);color:var(--muted);padding:var(--px-6)">No users match.</div>{/if}
        </div>

        <!-- user detail -->
        <div style="flex:1;min-width:0;padding:var(--px-12) var(--px-16);display:flex;flex-direction:column;gap:var(--px-16)">
          {#if !current}
            <div style="font-size:var(--px-12);color:var(--muted)">Pick a user.</div>
          {:else}
            <div style="display:flex;align-items:center;gap:var(--px-10)">
              <span class="mono" style="font-size:var(--px-15);font-weight:700;color:var(--text)">{current.name}</span>
              <span
                onclick={() => current && askConfirm('Delete user', `Delete RabbitMQ user "${current.name}"? Its permissions go with it, and anything logged in as it is disconnected.`, 'Delete', async () => { await apply(`Deleted user ${current!.name}`, () => ipc.rabbitDeleteUser(connId, current!.name)) })}
                onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                role="button"
                tabindex="0"
                aria-disabled={me?.name === current.name}
                class="pv-btn"
                title={me?.name === current.name ? 'This connection is logged in as this user' : 'Delete this user'}
                style="margin-left:auto;color:var(--error);{me?.name === current.name ? 'opacity:.5;pointer-events:none' : ''}"
              >Delete user</span>
            </div>

            <!-- tags -->
            <section aria-label="Tags">
              <div class="ru-h">Tags</div>
              <div style="display:flex;flex-wrap:wrap;gap:var(--px-6) var(--px-14)">
                {#each KNOWN_TAGS as k (k.tag)}
                  <label class="ru-check" title={k.hint}><input type="checkbox" checked={tagDraft.includes(k.tag)} onchange={() => toggleTag(k.tag)} /> {k.tag}</label>
                {/each}
                {#each customTags as t (t)}
                  <label class="ru-check"><input type="checkbox" checked onchange={() => toggleTag(t)} /> <span class="mono">{t}</span></label>
                {/each}
              </div>
              <div style="display:flex;gap:var(--px-8);margin-top:var(--px-8);align-items:center">
                <input class="mono ru-input" bind:value={customTag} placeholder="custom tag" aria-label="Custom tag" onkeydown={(e) => e.key === 'Enter' && addCustomTag()} style="width:var(--px-160)" />
                <span onclick={addCustomTag} onkeydown={(e) => e.key === 'Enter' && addCustomTag()} role="button" tabindex="0" class="pv-btn">Add tag</span>
                <span
                  onclick={() => current && apply(`Tags saved for ${current.name}`, () => ipc.rabbitSetUserTags(connId, current!.name, tagDraft))}
                  onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                  role="button"
                  tabindex="0"
                  class="pv-btn primary"
                  style={tagsChanged ? '' : 'opacity:.5;pointer-events:none'}
                >Save tags</span>
              </div>
            </section>

            <!-- password -->
            <section aria-label="Password">
              <div class="ru-h">Password</div>
              <div style="display:flex;gap:var(--px-8);align-items:center;flex-wrap:wrap">
                <input class="mono ru-input" type={showPassword ? 'text' : 'password'} bind:value={newPassword} placeholder="new password" aria-label="New password" autocomplete="new-password" style="width:var(--px-240)" />
                <span onclick={() => (showPassword = !showPassword)} onkeydown={(e) => e.key === 'Enter' && (showPassword = !showPassword)} role="button" tabindex="0" class="pv-btn">{showPassword ? 'Hide' : 'Show'}</span>
                <span onclick={() => { newPassword = generatePassword(); showPassword = true }} onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()} role="button" tabindex="0" class="pv-btn">Generate</span>
                <span
                  onclick={() => current && apply(`Password changed for ${current.name}`, () => ipc.rabbitSetUserPassword(connId, current!.name, newPassword)).then((ok) => ok && (newPassword = ''))}
                  onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                  role="button"
                  tabindex="0"
                  class="pv-btn primary"
                  style={newPassword ? '' : 'opacity:.5;pointer-events:none'}
                >Set password</span>
              </div>
            </section>

            <!-- vhost permissions -->
            <section aria-label="Virtual host access">
              <div class="ru-h">Virtual host access</div>
              {#if !userPerms.length}
                <div style="font-size:var(--px-12);color:var(--muted)">No access to any virtual host — this user can log in but cannot use any vhost.</div>
              {:else}
                <table class="mono ru-table">
                  <thead><tr>{#each ['Virtual host', 'Access', 'Configure', 'Write', 'Read', ''] as h (h || 'x')}<th>{h}</th>{/each}</tr></thead>
                  <tbody>
                    {#each userPerms as p (p.vhost)}
                      <tr>
                        <td style="color:var(--tbl-link);font-weight:600">{p.vhost}</td>
                        <td style="color:var(--text)">{PRESET_LABEL[presetOf(p)]}</td>
                        <td title={describeRegex(p.configure)}>{p.configure || '^$'}</td>
                        <td title={describeRegex(p.write)}>{p.write || '^$'}</td>
                        <td title={describeRegex(p.read)}>{p.read || '^$'}</td>
                        <td style="text-align:right;white-space:nowrap">
                          <span onclick={() => openPermEditor(p)} onkeydown={(e) => e.key === 'Enter' && openPermEditor(p)} role="button" tabindex="0" class="ru-link">Edit</span>
                          <span
                            onclick={() => askConfirm('Remove access', `Remove ${selected}'s access to virtual host "${p.vhost}"?`, 'Remove', async () => { await apply(`Removed access to ${p.vhost}`, () => ipc.rabbitDeletePermission(connId, p.vhost, selected!)) })}
                            onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                            role="button"
                            tabindex="0"
                            class="ru-link"
                            style="color:var(--error);margin-left:var(--px-10)"
                          >Remove</span>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              {#if editPerm}
                <div class="ru-form" aria-label="Access editor">
                  <div style="display:flex;gap:var(--px-10);flex-wrap:wrap;align-items:flex-end">
                    <label class="ru-field">Virtual host
                      <select class="ru-input" bind:value={editPerm.vhost} disabled={!editPerm.isNew} aria-label="Access virtual host">
                        {#each vhostNames as v (v)}<option value={v}>{v}</option>{/each}
                      </select>
                    </label>
                    <div class="ru-field">Access
                      <div style="display:flex;gap:var(--px-6);flex-wrap:wrap">
                        {#each [...PERMISSION_PRESETS.map((p) => ({ key: p.key as PermissionPresetKey, label: p.label, hint: p.hint })), { key: 'custom' as PermissionPresetKey, label: 'Custom', hint: 'Write the three regexes yourself' }] as p (p.key)}
                          <span onclick={() => pickPreset(p.key)} onkeydown={(e) => e.key === 'Enter' && pickPreset(p.key)} role="radio" aria-checked={editPerm.preset === p.key} tabindex="0" title={p.hint} class="ru-chip" class:on={editPerm.preset === p.key}>{p.label}</span>
                        {/each}
                      </div>
                    </div>
                  </div>
                  <div style="display:flex;gap:var(--px-10);flex-wrap:wrap;margin-top:var(--px-8)">
                    {#each [['configure', 'Configure (declare / delete)'], ['write', 'Write (publish / bind into)'], ['read', 'Read (consume / bind from)']] as [k, label] (k)}
                      <label class="ru-field" style="flex:1 1 var(--px-180)">{label}
                        <input class="mono ru-input" bind:value={editPerm[k as 'configure' | 'write' | 'read']} disabled={editPerm.preset !== 'custom'} aria-label={k} spellcheck="false" />
                      </label>
                    {/each}
                  </div>
                  {#each permErrors as [k, msg] (k)}<div role="alert" style="font-size:var(--px-11_5);color:var(--error)">{k}: {msg}</div>{/each}
                  <div style="display:flex;gap:var(--px-8);margin-top:var(--px-10)">
                    <span onclick={savePerm} onkeydown={(e) => e.key === 'Enter' && savePerm()} role="button" tabindex="0" class="pv-btn primary" style={permErrors.length ? 'opacity:.5;pointer-events:none' : ''}>Save access</span>
                    <span onclick={() => (editPerm = null)} onkeydown={(e) => e.key === 'Enter' && (editPerm = null)} role="button" tabindex="0" class="pv-btn">Cancel</span>
                  </div>
                </div>
              {:else}
                <span onclick={() => openPermEditor()} onkeydown={(e) => e.key === 'Enter' && openPermEditor()} role="button" tabindex="0" class="pv-btn" style="margin-top:var(--px-8);display:inline-block">＋ Grant access to a virtual host</span>
              {/if}
            </section>

            <!-- topic permissions -->
            <section aria-label="Topic permissions">
              <div class="ru-h">Topic permissions <span style="font-weight:400;color:var(--muted)">— limit which routing keys this user may publish / consume on topic exchanges</span></div>
              {#if userTopicPerms.length}
                <table class="mono ru-table">
                  <thead><tr>{#each ['Virtual host', 'Exchange', 'Write keys', 'Read keys', ''] as h (h || 'x')}<th>{h}</th>{/each}</tr></thead>
                  <tbody>
                    {#each userTopicPerms as t (t.vhost + '|' + t.exchange)}
                      <tr>
                        <td style="color:var(--tbl-link)">{t.vhost}</td>
                        <td>{t.exchange}</td>
                        <td style="color:var(--tbl-subject)">{t.write}</td>
                        <td style="color:var(--tbl-subject)">{t.read}</td>
                        <td style="text-align:right">
                          <span
                            onclick={() => askConfirm('Remove topic permissions', `Remove every topic permission of ${selected} in "${t.vhost}"? (The broker removes them per virtual host.)`, 'Remove', async () => { await apply('Topic permissions removed', () => ipc.rabbitDeleteTopicPermissions(connId, t.vhost, selected!)) })}
                            onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                            role="button"
                            tabindex="0"
                            class="ru-link"
                            style="color:var(--error)"
                          >Remove</span>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              <div style="display:flex;gap:var(--px-8);flex-wrap:wrap;align-items:flex-end;margin-top:var(--px-6)">
                <label class="ru-field">Virtual host
                  <select class="ru-input" bind:value={topicDraft.vhost} aria-label="Topic permission virtual host">{#each vhostNames as v (v)}<option value={v}>{v}</option>{/each}</select>
                </label>
                <label class="ru-field">Exchange<input class="mono ru-input" bind:value={topicDraft.exchange} aria-label="Topic permission exchange" spellcheck="false" /></label>
                <label class="ru-field">Write keys<input class="mono ru-input" bind:value={topicDraft.write} aria-label="Topic write regex" spellcheck="false" /></label>
                <label class="ru-field">Read keys<input class="mono ru-input" bind:value={topicDraft.read} aria-label="Topic read regex" spellcheck="false" /></label>
                <span
                  onclick={() => selected && apply('Topic permission saved', () => ipc.rabbitSetTopicPermission(connId, topicDraft.vhost, selected!, topicDraft.exchange, topicDraft.write, topicDraft.read))}
                  onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                  role="button"
                  tabindex="0"
                  class="pv-btn"
                  style={topicDraft.exchange.trim() && !regexError(topicDraft.write) && !regexError(topicDraft.read) ? '' : 'opacity:.5;pointer-events:none'}
                >Add</span>
              </div>
            </section>
          {/if}
        </div>
      </div>
    {:else if section === 'permissions'}
      <!-- who can do what, everywhere -->
      <div style="padding:var(--px-12) var(--px-14)">
        {#if permsError}<div role="alert" style="font-size:var(--px-12);color:var(--error);margin-bottom:var(--px-8)">{permsError}</div>{/if}
        <div style="font-size:var(--px-11_5);color:var(--muted);margin-bottom:var(--px-8)">Each cell is the user's access to that virtual host. Click a cell to edit it.</div>
        <table class="mono ru-table" aria-label="Permission matrix">
          <thead><tr><th>User</th>{#each vhostNames as v (v)}<th>{v}</th>{/each}</tr></thead>
          <tbody>
            {#each users as u (u.name)}
              <tr>
                <td style="color:var(--tbl-link);font-weight:600">{u.name}</td>
                {#each vhostNames as v (v)}
                  {@const p = permFor(u.name, v)}
                  <td
                    class="ru-cell"
                    onclick={() => editCell(u.name, v)}
                    onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                    role="button"
                    tabindex="0"
                    title={p ? `configure ${p.configure} · write ${p.write} · read ${p.read}` : 'No access'}
                    style="color:{p ? 'var(--text)' : 'var(--tbl-quiet)'}"
                  >{p ? PRESET_LABEL[presetOf(p)] : '—'}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if section === 'policies'}
      <div style="padding:var(--px-12) var(--px-14);display:flex;flex-direction:column;gap:var(--px-10)">
        <div style="display:flex;gap:var(--px-10);align-items:center">
          <label class="ru-field" style="flex-direction:row;align-items:center;gap:var(--px-6)">Virtual host
            <select class="ru-input" bind:value={policyVhost} aria-label="Policy virtual host">{#each vhostNames as v (v)}<option value={v}>{v}</option>{/each}</select>
          </label>
          <span onclick={() => openPolicy()} onkeydown={(e) => e.key === 'Enter' && openPolicy()} role="button" tabindex="0" class="pv-btn primary" style="margin-left:auto">＋ New policy</span>
        </div>
        {#if policiesError}<div role="alert" style="font-size:var(--px-11_5);color:var(--error)">{policiesError}</div>{/if}
        {#if !policies.length}
          <div style="font-size:var(--px-12);color:var(--muted)">No policies in this virtual host.</div>
        {:else}
          <table class="mono ru-table" aria-label="Policies">
            <thead><tr>{#each ['Name', 'Pattern', 'Applies to', 'Priority', 'Definition', ''] as h (h || 'x')}<th>{h}</th>{/each}</tr></thead>
            <tbody>
              {#each policies as p (p.name)}
                <tr>
                  <td style="color:var(--tbl-link);font-weight:600">{p.name}</td>
                  <td style="color:var(--tbl-subject)">{p.pattern}</td>
                  <td style="color:var(--tbl-meta)">{p.apply_to}</td>
                  <td style="color:var(--syntax-number)">{p.priority}</td>
                  <td style="color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:var(--px-300)" title={policySummary(p.definition)}>{policySummary(p.definition)}</td>
                  <td style="text-align:right;white-space:nowrap">
                    <span onclick={() => openPolicy(p)} onkeydown={(e) => e.key === 'Enter' && openPolicy(p)} role="button" tabindex="0" class="ru-link">Edit</span>
                    <span
                      onclick={() => askConfirm('Delete policy', `Delete policy "${p.name}" from "${policyVhost}"? Queues and exchanges it matched go back to their own settings.`, 'Delete', async () => { await apply(`Deleted policy ${p.name}`, () => ipc.rabbitDeletePolicy(connId, policyVhost, p.name)) })}
                      onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                      role="button"
                      tabindex="0"
                      class="ru-link"
                      style="color:var(--error);margin-left:var(--px-10)"
                    >Delete</span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {:else}
      <div style="padding:var(--px-12) var(--px-14);display:flex;flex-direction:column;gap:var(--px-10)">
        {#if vhostsError}<div role="alert" style="font-size:var(--px-12);color:var(--error)">{vhostsError}</div>{/if}
        <table class="mono ru-table" aria-label="Virtual hosts">
          <thead><tr>{#each ['Name', 'Description', 'Messages', ''] as h (h || 'x')}<th>{h}</th>{/each}</tr></thead>
          <tbody>
            {#each vhosts as v (v.name)}
              <tr>
                <td style="color:var(--tbl-link);font-weight:600">{v.name}</td>
                <td style="color:var(--text2)">{v.description || '—'}</td>
                <td style="color:var(--syntax-number)">{v.messages == null ? '?' : v.messages.toLocaleString('en-US')}</td>
                <td style="text-align:right">
                  <span
                    onclick={() => askConfirm('Delete virtual host', `Delete virtual host "${v.name}"? Every queue, exchange, binding, message, permission and policy in it is deleted. This cannot be undone.`, 'Delete', async () => { await apply(`Deleted virtual host ${v.name}`, () => ipc.rabbitDeleteVhost(connId, v.name)) })}
                    onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
                    role="button"
                    tabindex="0"
                    class="ru-link"
                    aria-disabled={v.name === connVhost}
                    title={v.name === connVhost ? 'This connection is opened on this virtual host' : 'Delete this virtual host'}
                    style="color:var(--error);{v.name === connVhost ? 'opacity:.4;pointer-events:none' : ''}"
                  >Delete</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div style="display:flex;gap:var(--px-8);flex-wrap:wrap;align-items:flex-end">
          <label class="ru-field">New virtual host<input class="mono ru-input" bind:value={newVhost.name} placeholder="staging" aria-label="New virtual host name" spellcheck="false" /></label>
          <label class="ru-field" style="flex:1 1 var(--px-200)">Description<input class="ru-input" bind:value={newVhost.description} aria-label="New virtual host description" /></label>
          <span
            onclick={() => apply(`Created virtual host ${newVhost.name.trim()}`, () => ipc.rabbitCreateVhost(connId, newVhost.name.trim(), newVhost.description)).then((ok) => ok && (newVhost = { name: '', description: '' }))}
            onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()}
            role="button"
            tabindex="0"
            class="pv-btn primary"
            style={newVhost.name.trim() && !vhostTaken ? '' : 'opacity:.5;pointer-events:none'}
          >Create</span>
          {#if vhostTaken}<span style="font-size:var(--px-11_5);color:var(--error)">Already exists.</span>{/if}
        </div>
      </div>
    {/if}
  </div>

  <!-- new user -->
  {#if createOpen}
    <div role="presentation" style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New user"
        onkeydown={(e) => e.key === 'Escape' && (createOpen = false)}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-520), 94%);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);display:flex;flex-direction:column;gap:var(--px-10)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">New user</div>
        <label class="ru-field">User name<input class="mono ru-input" bind:value={nu.name} use:autofocus aria-label="User name" spellcheck="false" /></label>
        {#if nameTaken}<div style="font-size:var(--px-11_5);color:var(--error)">A user with this name already exists.</div>{/if}
        <label class="ru-field">Password
          <span style="display:flex;gap:var(--px-6)">
            <input class="mono ru-input" style="flex:1" type={nu.show ? 'text' : 'password'} bind:value={nu.password} aria-label="Password" autocomplete="new-password" />
            <span onclick={() => (nu.show = !nu.show)} onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()} role="button" tabindex="0" class="pv-btn">{nu.show ? 'Hide' : 'Show'}</span>
            <span onclick={() => { nu.password = generatePassword(); nu.show = true }} onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()} role="button" tabindex="0" class="pv-btn">Generate</span>
          </span>
        </label>
        <div class="ru-field">Tags
          <div style="display:flex;flex-wrap:wrap;gap:var(--px-6) var(--px-14)">
            {#each KNOWN_TAGS as k (k.tag)}
              <label class="ru-check" title={k.hint}><input type="checkbox" checked={nu.tags.includes(k.tag)} onchange={() => (nu.tags = nu.tags.includes(k.tag) ? nu.tags.filter((t) => t !== k.tag) : [...nu.tags, k.tag])} /> {k.tag}</label>
            {/each}
          </div>
        </div>
        <div style="display:flex;gap:var(--px-10);flex-wrap:wrap">
          <label class="ru-field">Give access to
            <select class="ru-input" bind:value={nu.vhost} aria-label="Initial virtual host">
              <option value="">(no virtual host yet)</option>
              {#each vhostNames as v (v)}<option value={v}>{v}</option>{/each}
            </select>
          </label>
          {#if nu.vhost}
            <label class="ru-field">Access
              <select class="ru-input" bind:value={nu.preset} aria-label="Initial access">
                {#each PERMISSION_PRESETS as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
              </select>
            </label>
          {/if}
        </div>
        {#if !nu.tags.includes('management') && !nu.tags.includes('administrator') && !nu.tags.includes('monitoring') && !nu.tags.includes('policymaker')}
          <div style="font-size:var(--px-11);color:var(--muted)">Without a management tag the user can use AMQP but cannot log in to the management API / this app.</div>
        {/if}
        {#if createError}<div role="alert" style="font-size:var(--px-11_5);color:var(--error)">{createError}</div>{/if}
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span onclick={() => (createOpen = false)} onkeydown={(e) => e.key === 'Enter' && (createOpen = false)} role="button" tabindex="0" class="pv-btn">Cancel</span>
          <span onclick={createUser} onkeydown={(e) => e.key === 'Enter' && createUser()} role="button" tabindex="0" class="pv-btn primary" style={nu.name.trim() && !nameTaken && !createBusy ? '' : 'opacity:.5;pointer-events:none'}>{createBusy ? 'Creating…' : 'Create user'}</span>
        </div>
      </div>
    </div>
  {/if}

  <!-- policy editor -->
  {#if policyEdit}
    <div role="presentation" style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={policyEdit.isNew ? 'New policy' : 'Edit policy'}
        onkeydown={(e) => e.key === 'Escape' && (policyEdit = null)}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-720), 94%);max-height:92%;overflow:auto;box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);display:flex;flex-direction:column;gap:var(--px-10)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">{policyEdit.isNew ? 'New policy' : `Edit policy ${policyEdit.name}`} <span style="font-weight:400;font-size:var(--px-11_5);color:var(--muted)">in {policyVhost}</span></div>
        <div style="display:flex;gap:var(--px-10);flex-wrap:wrap">
          <label class="ru-field" style="flex:1 1 var(--px-160)">Name<input class="mono ru-input" bind:value={policyEdit.name} disabled={!policyEdit.isNew} use:autofocus aria-label="Policy name" spellcheck="false" /></label>
          <label class="ru-field" style="flex:1 1 var(--px-200)">Pattern (regex on names)<input class="mono ru-input" bind:value={policyEdit.pattern} aria-label="Policy pattern" spellcheck="false" /></label>
          <label class="ru-field">Applies to
            <select class="ru-input" bind:value={policyEdit.applyTo} aria-label="Applies to">{#each APPLY_TO as a (a)}<option value={a}>{a}</option>{/each}</select>
          </label>
          <label class="ru-field" style="width:var(--px-90)">Priority<input class="mono ru-input" type="number" bind:value={policyEdit.priority} aria-label="Priority" /></label>
        </div>
        {#if policyPatternError}<div role="alert" style="font-size:var(--px-11_5);color:var(--error)">pattern: {policyPatternError}</div>{/if}
        <div class="ru-field">Definition
          <div style="display:flex;flex-wrap:wrap;gap:var(--px-5);margin-bottom:var(--px-4)">
            {#each POLICY_KEYS as k (k.key)}
              <span onclick={() => policyEdit && (policyEdit.definition = withPolicyKey(policyEdit.definition, k.key, k.sample))} onkeydown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLElement).click()} role="button" tabindex="0" title={k.hint} class="ru-chip">＋ {k.key}</span>
            {/each}
          </div>
          <textarea class="mono ru-input" rows="7" bind:value={policyEdit.definition} aria-label="Policy definition" spellcheck="false"></textarea>
        </div>
        {#if policyParsed && !policyParsed.ok}<div role="alert" style="font-size:var(--px-11_5);color:var(--error)">{policyParsed.error}</div>{/if}
        {#if policyError}<div role="alert" style="font-size:var(--px-11_5);color:var(--error)">{policyError}</div>{/if}
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span onclick={() => (policyEdit = null)} onkeydown={(e) => e.key === 'Enter' && (policyEdit = null)} role="button" tabindex="0" class="pv-btn">Cancel</span>
          <span
            onclick={savePolicy}
            onkeydown={(e) => e.key === 'Enter' && savePolicy()}
            role="button"
            tabindex="0"
            class="pv-btn primary"
            style={policyEdit.name.trim() && policyParsed?.ok && !policyPatternError ? '' : 'opacity:.5;pointer-events:none'}
          >Save policy</span>
        </div>
      </div>
    </div>
  {/if}

  {#if confirmState}
    <div role="presentation" style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:70">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={confirmState.title}
        onkeydown={(e) => e.key === 'Escape' && (confirmState = null)}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-460), 92%);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">{confirmState.title}</div>
        <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">{confirmState.body}</div>
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span onclick={() => (confirmState = null)} onkeydown={(e) => e.key === 'Enter' && (confirmState = null)} role="button" tabindex="0" class="pv-btn">Cancel</span>
          <span onclick={runConfirm} onkeydown={(e) => e.key === 'Enter' && runConfirm()} role="button" tabindex="0" class="pv-btn primary" style="background:var(--error);border-color:var(--error);{confirmBusy ? 'opacity:.6;pointer-events:none' : ''}">{confirmState.action}</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .ru-tab {
    font-size: var(--px-12);
    color: var(--text2);
    padding: var(--px-6) var(--px-12);
    border-bottom: var(--px-2) solid transparent;
    cursor: pointer;
  }
  .ru-tab.on {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--primary);
  }
  .ru-input {
    font-size: var(--px-12);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-8);
    color: var(--text);
    outline: none;
    resize: vertical;
  }
  .ru-input:disabled {
    color: var(--text2);
    opacity: 0.8;
  }
  .ru-user {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    padding: var(--px-6) var(--px-8);
    border-radius: var(--px-6);
    cursor: pointer;
    font-size: var(--px-12);
    min-width: 0;
  }
  .ru-user:hover:not(.sel) {
    background: var(--tbl-hover);
  }
  .ru-user.sel {
    background: color-mix(in srgb, var(--primary) 22%, transparent);
  }
  .ru-badge {
    flex: none;
    font-size: var(--px-9_5);
    font-weight: 700;
    color: var(--tbl-meta);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-4);
    padding: 0 var(--px-4);
  }
  .ru-h {
    font-size: var(--px-12);
    font-weight: 700;
    color: var(--tbl-head);
    margin-bottom: var(--px-8);
  }
  .ru-check {
    font-size: var(--px-12);
    color: var(--text2);
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
  }
  .ru-table {
    border-collapse: collapse;
    font-size: var(--px-12);
    width: 100%;
    max-width: var(--px-720);
  }
  .ru-table th {
    text-align: left;
    color: var(--tbl-head);
    font-weight: 600;
    padding: var(--px-6) var(--px-10);
    border-bottom: var(--px-1) solid var(--border2);
  }
  .ru-table td {
    padding: var(--px-6) var(--px-10);
    border-bottom: var(--px-1) solid var(--border);
    color: var(--text2);
  }
  .ru-table tbody tr:nth-child(even) {
    background: var(--tbl-zebra);
  }
  .ru-cell {
    cursor: pointer;
  }
  .ru-cell:hover {
    background: var(--tbl-hover);
  }
  .ru-link {
    color: var(--tbl-link);
    cursor: pointer;
    font-weight: 600;
  }
  .ru-link:hover {
    text-decoration: underline;
  }
  .ru-form {
    margin-top: var(--px-10);
    padding: var(--px-12);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    background: var(--panel);
    max-width: var(--px-720);
  }
  .ru-field {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
    font-size: var(--px-11_5);
    font-weight: 600;
    color: var(--text2);
  }
  .ru-chip {
    font-size: var(--px-11);
    padding: var(--px-3) var(--px-8);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-12);
    color: var(--text2);
    cursor: pointer;
    background: var(--raised);
  }
  .ru-chip.on {
    color: var(--hex-fff);
    background: var(--primary);
    border-color: var(--primary);
  }
</style>
