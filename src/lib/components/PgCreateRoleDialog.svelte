<script lang="ts">
  import '$lib/components/workspace/users/um.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import Icon from '$lib/components/Icon.svelte'
  // Create a PostgreSQL Login/Group Role (U1). Popup (not a tab); pgAdmin-style
  // attribute checkboxes; live CREATE ROLE preview; runs then refreshes the
  // Explorer roles node. "Can login?" flips the primary button label.
  import { pgRoleWizard } from '$lib/stores/pgrole.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { createRole, type RoleOptions } from '$lib/users/postgres'
  import MultiSelect from '$lib/components/MultiSelect.svelte'

  // Effect-mirror open flag (Svelte 5 cross-component tracking — see T31 note).
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = pgRoleWizard.open
  })

  let name = $state('')
  let canLogin = $state(true)
  let superuser = $state(false)
  let createdb = $state(false)
  let createrole = $state(false)
  let inheritRights = $state(true)
  let replication = $state(false)
  let bypassrls = $state(false)
  let password = $state('')
  let showPw = $state(false)
  let connLimit = $state<number | null>(null)
  let validUntil = $state('')
  let memberOf = $state<string[]>([])
  let allRoles = $state<string[]>([])
  let busy = $state(false)
  let err = $state<string | null>(null)

  // Reset the form whenever the dialog opens fresh.
  let wasOpen = false
  $effect(() => {
    if (dlgOpen && !wasOpen) {
      name = ''
      canLogin = true
      superuser = false
      createdb = false
      createrole = false
      inheritRights = true
      replication = false
      bypassrls = false
      password = ''
      showPw = false
      connLimit = null
      validUntil = ''
      memberOf = []
      err = null
      // load existing roles so the new role can be made a member of them.
      const cid = pgRoleWizard.connId
      allRoles = []
      if (cid) ipc.usersView(cid, 'roles').then((r) => (allRoles = r.rows.map((x) => String(x.name)))).catch(() => (allRoles = []))
    }
    wasOpen = dlgOpen
  })

  const opts = $derived.by<RoleOptions>(() => ({
    login: canLogin,
    superuser,
    createdb,
    createrole,
    replication,
    bypassrls,
    inherit: inheritRights,
    connectionLimit: connLimit,
    password: canLogin && password ? password : null,
    validUntil: validUntil || null,
    inRole: memberOf.length ? memberOf : undefined,
  }))

  const sql = $derived(name.trim() ? createRole(name.trim(), opts) : '')

  // Mask the password in the preview unless the user reveals it.
  const previewSql = $derived.by(() => {
    if (!sql) return ''
    if (showPw || !password) return sql
    return sql.replace(`PASSWORD '${password.replace(/'/g, "''")}'`, "PASSWORD '••••••'")
  })

  function generate() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%^*'
    const arr = new Uint32Array(20)
    crypto.getRandomValues(arr)
    password = Array.from(arr, (n) => alphabet[n % alphabet.length]).join('')
    showPw = true
  }

  async function run() {
    const cid = pgRoleWizard.connId
    if (!cid || !sql || busy) return
    busy = true
    err = null
    try {
      const res = await ipc.execStatement(cid, sql, 0)
      if (!res.ok) {
        err = res.error?.message ?? 'error'
        return
      }
      toasts.success(`Role ${name.trim()} created`, 'postgres')
      await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
      // Grant right after create: open the manager on the new role and cue the
      // Grant Access wizard so permissions can be assigned in one flow.
      tabs.openUserManager(cid, name.trim())
      grantWizard.requestAfterCreate(cid, name.trim())
      pgRoleWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !busy && pgRoleWizard.close()} role="presentation" class="um-backdrop">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && pgRoleWizard.close()} role="dialog" aria-modal="true" tabindex="-1" use:focusOnMount class="um-dlg">
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="user" size={18} /></span>
        <div class="um-dlg-title"><b>Create Login/Group Role</b><span>PostgreSQL · a login role can sign in, a group role only bundles privileges</span></div>
        <span onclick={() => !busy && pgRoleWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && pgRoleWizard.close()} role="button" tabindex="0" class="um-dlg-x" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>
      <div class="um-dlg-body">
        <label class="um-field">Role name
          <!-- svelte-ignore a11y_autofocus -->
          <input bind:value={name} class="um-input mono" style="width:100%" placeholder="e.g. app_reader" autofocus spellcheck="false" autocomplete="off" />
        </label>
        <div class="um-group">
          <div class="um-group-title">Type</div>
          <div class="um-seg" role="group" aria-label="Role type" style="align-self:flex-start">
            <span aria-pressed={canLogin} onclick={() => (canLogin = true)} onkeydown={(e) => e.key === 'Enter' && (canLogin = true)} role="button" tabindex="0" title="A role that can sign in"><Icon name="user" size={13} />Login role</span>
            <span aria-pressed={!canLogin} onclick={() => (canLogin = false)} onkeydown={(e) => e.key === 'Enter' && (canLogin = false)} role="button" tabindex="0" title="A role without login that bundles privileges for other roles"><Icon name="users" size={13} />Group role</span>
          </div>
        </div>
        {#if canLogin}
          <div class="um-group">
            <div class="um-group-title">Sign-in</div>
            <label class="um-field">Password
              <div class="um-pw">
                <input type={showPw ? 'text' : 'password'} bind:value={password} class="um-input mono" autocomplete="new-password" placeholder="Leave empty for no password" />
                <span class="eg-btn" onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" title={showPw ? 'Hide password' : 'Show password'} aria-label={showPw ? 'Hide password' : 'Show password'}><Icon name={showPw ? 'eye-off' : 'eye'} size={13} /></span>
                <span class="eg-btn" onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0" title="Generate a strong random password"><Icon name="sparkle" size={12} />Generate</span>
              </div>
            </label>
            <div class="um-row2">
              <label class="um-field">Connection limit
                <input class="um-input" type="number" bind:value={connLimit} placeholder="-1 (unlimited)" />
              </label>
              <label class="um-field">Account expires
                <input type="text" bind:value={validUntil} placeholder="YYYY-MM-DD, empty = never" class="um-input mono" />
              </label>
            </div>
          </div>
        {/if}
        <div class="um-group">
          <div class="um-group-title">Privileges</div>
          <div class="um-toggles">
            {#each [
              ['Superuser', 'Bypasses every permission check. Grant sparingly.', 'superuser'],
              ['Create roles', 'Can create, alter and drop other roles.', 'createrole'],
              ['Create databases', 'Can create new databases.', 'createdb'],
              ['Inherit', 'Uses the privileges of the roles it is a member of.', 'inherit'],
              ['Replication', 'Can start streaming replication and take base backups.', 'replication'],
              ['Bypass RLS', 'Ignores row-level security policies.', 'bypassrls'],
            ] as [label, desc, key] (key)}
              <label class="um-toggle">
                <span class="um-toggle-text"><span>{label}</span><span>{desc}</span></span>
                {#if key === 'superuser'}<input type="checkbox" class="um-switch" bind:checked={superuser} />
                {:else if key === 'createrole'}<input type="checkbox" class="um-switch" bind:checked={createrole} />
                {:else if key === 'createdb'}<input type="checkbox" class="um-switch" bind:checked={createdb} />
                {:else if key === 'inherit'}<input type="checkbox" class="um-switch" bind:checked={inheritRights} />
                {:else if key === 'replication'}<input type="checkbox" class="um-switch" bind:checked={replication} />
                {:else}<input type="checkbox" class="um-switch" bind:checked={bypassrls} />{/if}
              </label>
            {/each}
          </div>
        </div>
        <label class="um-field">Member of
          <div class="um-input" style="padding:0;display:block"><MultiSelect bind:values={memberOf} options={allRoles.filter((r) => r !== name.trim())} placeholder="Add to groups…" /></div>
          <span class="um-field-hint">The new role gets the privileges of every group you pick.</span>
        </label>
        <div class="um-sql-head"><Icon name="code" size={13} />SQL that will run</div>
        <pre class="um-sql selectable">{previewSql || '-- enter a role name'}</pre>
        {#if err}<div class="um-err" role="alert"><Icon name="warning" size={14} /><span>{err}</span></div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="cfm-btn" onclick={() => !busy && pgRoleWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && pgRoleWizard.close()} role="button" tabindex="0">Cancel</span>
        <span class="cfm-btn primary" onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!sql || busy} style="margin-left:auto;cursor:{sql && !busy ? 'pointer' : 'not-allowed'};opacity:{sql && !busy ? 1 : 0.5}">{busy ? 'Creating…' : canLogin ? 'Create login role' : 'Create group role'}</span>
      </div>
    </div>
  </div>
{/if}
