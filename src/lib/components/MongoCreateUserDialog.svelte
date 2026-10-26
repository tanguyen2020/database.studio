<script lang="ts">
  import '$lib/components/workspace/users/um.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import Icon from '$lib/components/Icon.svelte'
  // Create a MongoDB user (U5). Popup (not a tab). Command-based (createUser) —
  // no SQL. The user belongs to an authentication database; initial roles are
  // picked as built-in role @ database.
  import { mongoUserWizard } from '$lib/stores/mongouser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { DB_BUILTIN_ROLES, type RoleRef } from '$lib/users/mongodb'
  import { connections } from '$lib/stores/connections.svelte'
  import { isFerretDB } from '$lib/brand'

  // FerretDB does not enforce roles (SPEC-FERRETDB-DOCUMENTDB.md) — do not pretend to grant any
  const ferret = $derived(isFerretDB(connections.byId(mongoUserWizard.connId)))

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = mongoUserWizard.open
  })

  let user = $state('')
  let password = $state('')
  let showPw = $state(false)
  let roleDb = $state('')
  let checkedRoles = $state<Record<string, boolean>>({})
  let busy = $state(false)
  let err = $state<string | null>(null)

  let wasOpen = false
  $effect(() => {
    if (dlgOpen && !wasOpen) {
      user = ''
      password = ''
      showPw = false
      roleDb = mongoUserWizard.database
      checkedRoles = { read: true }
      err = null
    }
    wasOpen = dlgOpen
  })

  const roles = $derived.by<RoleRef[]>(() =>
    ferret ? [] :
    DB_BUILTIN_ROLES.filter((r) => checkedRoles[r]).map((r) => ({ role: r, db: roleDb || mongoUserWizard.database })),
  )
  const canRun = $derived(!!user.trim() && !!password)
  const preview = $derived.by(() => {
    if (!user.trim()) return ''
    const roleList = roles.map((r) => `${r.role}@${r.db}`).join(', ') || '(none)'
    return `db.getSiblingDB("${mongoUserWizard.database}").createUser({ user: "${user.trim()}", pwd: "${showPw && password ? password : '••••••'}", roles: [ ${roleList} ] })`
  })

  function generate() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
    const arr = new Uint32Array(24)
    crypto.getRandomValues(arr)
    password = Array.from(arr, (n) => alphabet[n % alphabet.length]).join('')
    showPw = true
  }

  async function run() {
    const cid = mongoUserWizard.connId
    if (!cid || !canRun || busy) return
    busy = true
    err = null
    try {
      await ipc.mongoCreateUser(cid, mongoUserWizard.database, user.trim(), password, roles)
      toasts.success(`User ${user.trim()} created`, 'mongodb')
      await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
      // Mongo assigns roles at creation time, so just land on the new user.
      tabs.openUserManager(cid, `${user.trim()}@${mongoUserWizard.database}`)
      mongoUserWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <div onkeydown={(e) => e.key === 'Escape' && !busy && mongoUserWizard.close()} role="presentation" class="um-backdrop">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && mongoUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" use:focusOnMount class="um-dlg">
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="user" size={18} /></span>
        <div class="um-dlg-title"><b>Add User · {mongoUserWizard.database}</b><span>MongoDB · the user signs in against this database</span></div>
        <span onclick={() => !busy && mongoUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && mongoUserWizard.close()} role="button" tabindex="0" class="um-dlg-x" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>
      <div class="um-dlg-body">
        <label class="um-field">User name
          <input bind:value={user} class="um-input mono" style="width:100%" />
        </label>
        <div style="display:flex;gap:var(--px-6);align-items:flex-end">
          <label class="um-field" style="flex:1">Password
            <input type={showPw ? 'text' : 'password'} bind:value={password} class="um-input mono" style="width:100%" autocomplete="new-password" />
          </label>
          <span class="eg-btn" onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0"><Icon name={showPw ? 'eye-off' : 'eye'} size={13} /></span>
          <span class="eg-btn" onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0"><Icon name="sparkle" size={12} />Generate</span>
        </div>
        {#if ferret}
          <div class="um-callout warn" data-testid="ferret-create-note"><Icon name="warning" size={15} /><span><b>No roles to choose on FerretDB.</b> It does not enforce roles — this user will be able to read and write every database.</span></div>
        {:else}
        <label class="um-field">Roles on database
          <input bind:value={roleDb} class="um-input mono" style="margin-left:var(--px-8);width:var(--px-180)" />
        </label>
        <div style="display:flex;flex-wrap:wrap;gap:var(--px-10)">
          {#each DB_BUILTIN_ROLES as r (r)}
            <label class="um-checkline"><input class="um-check" type="checkbox" checked={checkedRoles[r] ?? false} onchange={(e) => (checkedRoles = { ...checkedRoles, [r]: (e.currentTarget as HTMLInputElement).checked })} /> {r}</label>
          {/each}
        </div>
        {/if}
        <div class="um-field-hint">Command preview</div>
        <pre class="um-sql selectable">{preview || '-- enter a user name'}</pre>
        {#if err}<div class="um-err" role="alert"><Icon name="warning" size={14} /><span>{err}</span></div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="cfm-btn" onclick={() => !busy && mongoUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && mongoUserWizard.close()} role="button" tabindex="0">Cancel</span>
        <span class="cfm-btn primary" onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!canRun || busy} style="margin-left:auto;cursor:{canRun && !busy ? 'pointer' : 'not-allowed'};opacity:{canRun && !busy ? 1 : 0.5}">{busy ? 'Creating…' : 'Create user'}</span>
      </div>
    </div>
  </div>
{/if}
