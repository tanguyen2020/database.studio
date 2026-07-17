<script lang="ts">
  // Create a MongoDB user (U5). Popup (not a tab). Command-based (createUser) —
  // no SQL. The user belongs to an authentication database; initial roles are
  // picked as built-in role @ database.
  import { mongoUserWizard } from '$lib/stores/mongouser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { DB_BUILTIN_ROLES, type RoleRef } from '$lib/users/mongodb'

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
  <div onkeydown={(e) => e.key === 'Escape' && !busy && mongoUserWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && mongoUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Add User · {mongoUserWizard.database}</span>
        <span onclick={() => !busy && mongoUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && mongoUserWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <label style="font-size:var(--px-12);color:var(--text2)">User name
          <input bind:value={user} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
        </label>
        <div style="display:flex;gap:var(--px-6);align-items:flex-end">
          <label style="font-size:var(--px-12);color:var(--text2);flex:1">Password
            <input type={showPw ? 'text' : 'password'} bind:value={password} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
          </label>
          <span onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">{showPw ? 'Hide' : 'Show'}</span>
          <span onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">Generate</span>
        </div>
        <label style="font-size:var(--px-12);color:var(--text2)">Roles on database
          <input bind:value={roleDb} class="mono" style="margin-left:var(--px-8);width:var(--px-180);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
        </label>
        <div style="display:flex;flex-wrap:wrap;gap:var(--px-10)">
          {#each DB_BUILTIN_ROLES as r (r)}
            <label style="font-size:var(--px-11_5);color:var(--text);display:flex;align-items:center;gap:var(--px-4)"><input type="checkbox" checked={checkedRoles[r] ?? false} onchange={(e) => (checkedRoles = { ...checkedRoles, [r]: (e.currentTarget as HTMLInputElement).checked })} /> {r}</label>
          {/each}
        </div>
        <div style="font-size:var(--px-11);color:var(--muted)">Command preview</div>
        <pre class="selectable mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11);margin:0;max-height:var(--px-120);overflow:auto;color:var(--text2);white-space:pre-wrap">{preview || '-- enter a user name'}</pre>
        {#if err}<div style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && mongoUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && mongoUserWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!canRun || busy} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{canRun && !busy ? 'pointer' : 'not-allowed'};opacity:{canRun && !busy ? 1 : 0.5};font-weight:600">{busy ? 'Creating…' : 'Create user'}</span>
      </div>
    </div>
  </div>
{/if}
