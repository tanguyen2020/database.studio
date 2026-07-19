<script lang="ts">
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
  <div onkeydown={(e) => e.key === 'Escape' && !busy && pgRoleWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && pgRoleWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Create Login/Group Role</span>
        <span onclick={() => !busy && pgRoleWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && pgRoleWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <label style="font-size:var(--px-12);color:var(--text2)">Role name
          <input bind:value={name} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
        </label>
        <div style="display:flex;flex-direction:column;gap:var(--px-4)">
          <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={canLogin} /> Can login?</label>
          <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={superuser} /> Superuser?</label>
          <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={createrole} /> Create roles?</label>
          <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={createdb} /> Create databases?</label>
          <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={inheritRights} /> Inherit rights from the parent roles?</label>
          <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={replication} /> Can initiate streaming replication and backups?</label>
          <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={bypassrls} /> Bypass RLS?</label>
        </div>
        {#if canLogin}
          <div style="display:flex;gap:var(--px-6);align-items:flex-end">
            <label style="font-size:var(--px-12);color:var(--text2);flex:1">Password
              <input type={showPw ? 'text' : 'password'} bind:value={password} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
            </label>
            <span onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" title="Show/hide password" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">{showPw ? 'Hide' : 'Show'}</span>
            <span onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">Generate</span>
          </div>
        {/if}
        <div style="display:flex;gap:var(--px-12);flex-wrap:wrap">
          <label style="font-size:var(--px-12);color:var(--text2)">Connection limit
            <input type="number" bind:value={connLimit} placeholder="-1" style="width:var(--px-90);margin-left:var(--px-6);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
          </label>
          <label style="font-size:var(--px-12);color:var(--text2)">Account expires
            <input type="text" bind:value={validUntil} placeholder="2026-12-31 or empty" class="mono" style="width:var(--px-180);margin-left:var(--px-6);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text)" />
          </label>
        </div>
        <label style="font-size:var(--px-12);color:var(--text2)">Member of (roles)
          <div style="margin-top:var(--px-4)"><MultiSelect bind:values={memberOf} options={allRoles.filter((r) => r !== name.trim())} placeholder="grant role membership…" /></div>
        </label>
        <div style="font-size:var(--px-11);color:var(--muted)">SQL preview</div>
        <pre class="selectable mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11_5);margin:0;max-height:var(--px-120);overflow:auto;color:var(--text2);white-space:pre-wrap">{previewSql || '-- enter a role name'}</pre>
        {#if err}<div style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && pgRoleWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && pgRoleWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!sql || busy} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{sql && !busy ? 'pointer' : 'not-allowed'};opacity:{sql && !busy ? 1 : 0.5};font-weight:600">{busy ? 'Creating…' : canLogin ? 'Create login role' : 'Create group role'}</span>
      </div>
    </div>
  </div>
{/if}
