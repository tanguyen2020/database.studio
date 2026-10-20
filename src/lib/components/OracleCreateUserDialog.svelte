<script lang="ts">
  import '$lib/components/workspace/users/um.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import Icon from '$lib/components/Icon.svelte'
  // Create an Oracle user (U6). Popup (not a tab). Emits CREATE USER (+ optional
  // GRANT CREATE SESSION, on by default — without it the user cannot log in).
  // Password goes in IDENTIFIED BY "…" (double-quoted, no " allowed).
  import { oraUserWizard } from '$lib/stores/orauser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { createUser, grantRole } from '$lib/users/oracle'
  import MultiSelect from '$lib/components/MultiSelect.svelte'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = oraUserWizard.open
  })

  let name = $state('')
  let password = $state('')
  let showPw = $state(false)
  let defaultTablespace = $state('')
  let tablespaces = $state<string[]>([])
  let profile = $state('')
  let profiles = $state<string[]>([])
  let grantCreateSession = $state(true)
  let memberOf = $state<string[]>([])
  let allRoles = $state<string[]>([])
  let busy = $state(false)
  let err = $state<string | null>(null)

  let wasOpen = false
  $effect(() => {
    if (dlgOpen && !wasOpen) {
      name = ''
      password = ''
      showPw = false
      defaultTablespace = ''
      profile = ''
      grantCreateSession = true
      memberOf = []
      err = null
      void loadLookups()
    }
    wasOpen = dlgOpen
  })

  async function loadLookups() {
    const cid = oraUserWizard.connId
    if (!cid) return
    const [ts, pf, rl] = await Promise.all([
      ipc.usersView(cid, 'tablespaces').catch(() => ({ rows: [] as Record<string, unknown>[] })),
      ipc.usersView(cid, 'profiles').catch(() => ({ rows: [] as Record<string, unknown>[] })),
      ipc.usersView(cid, 'roles').catch(() => ({ rows: [] as Record<string, unknown>[] })),
    ])
    tablespaces = ts.rows.map((r) => String(r.name))
    profiles = pf.rows.map((r) => String(r.name))
    allRoles = rl.rows.map((r) => String(r.name))
  }

  const stmts = $derived.by<string[]>(() => {
    if (!name.trim() || !password) return []
    try {
      const base = createUser({
        name: name.trim(),
        password,
        defaultTablespace: defaultTablespace || null,
        profile: profile || null,
        grantCreateSession,
      })
      // grant selected roles (separate GRANT statements).
      return [...base, ...memberOf.map((r) => grantRole(r, name.trim()))]
    } catch {
      return []
    }
  })
  const previewSql = $derived.by(() => {
    const joined = stmts.join(';\n') + (stmts.length ? ';' : '')
    if (!joined || showPw || !password) return joined
    return joined.replace(`IDENTIFIED BY "${password}"`, 'IDENTIFIED BY "••••••"')
  })

  function generate() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
    const arr = new Uint32Array(20)
    crypto.getRandomValues(arr)
    password = Array.from(arr, (n) => alphabet[n % alphabet.length]).join('')
    showPw = true
  }

  async function run() {
    const cid = oraUserWizard.connId
    if (!cid || !stmts.length || busy) return
    busy = true
    err = null
    try {
      for (const sql of stmts) {
        const res = await ipc.execStatement(cid, sql, 0)
        if (!res.ok) {
          err = res.error?.message ?? 'error'
          return
        }
      }
      toasts.success(`User ${name.trim().toUpperCase()} created`, 'oracle')
      await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
      // Oracle uses per-owner grant buttons (no shared wizard) → just focus the
      // manager on the new user; grants are assigned from its Privileges tabs.
      tabs.openUserManager(cid, name.trim().toUpperCase())
      oraUserWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <div onkeydown={(e) => e.key === 'Escape' && !busy && oraUserWizard.close()} role="presentation" class="um-backdrop">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && oraUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" use:focusOnMount class="um-dlg">
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="user" size={18} /></span>
        <div class="um-dlg-title"><b>Create User</b><span>Oracle · the new user is also a schema</span></div>
        <span onclick={() => !busy && oraUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && oraUserWizard.close()} role="button" tabindex="0" class="um-dlg-x" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>
      <div class="um-dlg-body">
        <label class="um-field">User name
          <input bind:value={name} class="um-input mono" style="width:100%" />
        </label>
        <div style="display:flex;gap:var(--px-6);align-items:flex-end">
          <label class="um-field" style="flex:1">Password
            <input type={showPw ? 'text' : 'password'} bind:value={password} class="um-input mono" style="width:100%" autocomplete="new-password" />
          </label>
          <span class="eg-btn" onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0"><Icon name={showPw ? 'eye-off' : 'eye'} size={13} /></span>
          <span class="eg-btn" onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0"><Icon name="sparkle" size={12} />Generate</span>
        </div>
        <div style="display:flex;gap:var(--px-12);flex-wrap:wrap">
          <label class="um-field">Default tablespace
            <select bind:value={defaultTablespace} class="um-select mono"><option value="">(default)</option>{#each tablespaces as t (t)}<option value={t}>{t}</option>{/each}</select>
          </label>
          <label class="um-field">Profile
            <select bind:value={profile} class="um-select mono"><option value="">(default)</option>{#each profiles as p (p)}<option value={p}>{p}</option>{/each}</select>
          </label>
        </div>
        <label class="um-checkline"><input class="um-check" type="checkbox" bind:checked={grantCreateSession} /> Grant CREATE SESSION (required to log in)</label>
        <label class="um-field">Grant roles
          <div class="um-input" style="padding:0;display:block"><MultiSelect bind:values={memberOf} options={allRoles.filter((r) => r !== name.trim().toUpperCase())} placeholder="pick roles to grant…" /></div>
        </label>
        <div class="um-sql-head"><Icon name="code" size={13} />SQL that will run</div>
        <pre class="um-sql selectable">{previewSql || '-- enter a name and password'}</pre>
        {#if err}<div class="um-err" role="alert"><Icon name="warning" size={14} /><span>{err}</span></div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="cfm-btn" onclick={() => !busy && oraUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && oraUserWizard.close()} role="button" tabindex="0">Cancel</span>
        <span class="cfm-btn primary" onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!stmts.length || busy} style="margin-left:auto;cursor:{stmts.length && !busy ? 'pointer' : 'not-allowed'};opacity:{stmts.length && !busy ? 1 : 0.5}">{busy ? 'Creating…' : 'Create user'}</span>
      </div>
    </div>
  </div>
{/if}
