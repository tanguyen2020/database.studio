<script lang="ts">
  import '$lib/components/workspace/users/um.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import Icon from '$lib/components/Icon.svelte'
  // Create a ClickHouse User / Role (U4). Popup (not a tab). Auth dropdown
  // (sha256 default; no_password / plaintext_password warn). Live preview
  // (password masked). Runs via exec_statement (HTTP) then refreshes Explorer.
  import { chUserWizard } from '$lib/stores/chuser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { createRole, createUser, grantRole, setDefaultRole, type ChAuth } from '$lib/users/clickhouse'
  import MultiSelect from '$lib/components/MultiSelect.svelte'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = chUserWizard.open
  })
  const mode = $derived(chUserWizard.mode)

  let name = $state('')
  let auth = $state<ChAuth>('sha256_password')
  let password = $state('')
  let showPw = $state(false)
  let memberOf = $state<string[]>([])
  let allRoles = $state<string[]>([])
  let busy = $state(false)
  let err = $state<string | null>(null)

  let wasOpen = false
  $effect(() => {
    if (dlgOpen && !wasOpen) {
      name = ''
      auth = 'sha256_password'
      password = ''
      showPw = false
      memberOf = []
      err = null
      const cid = chUserWizard.connId
      allRoles = []
      if (cid) ipc.usersView(cid, 'roles').then((r) => (allRoles = r.rows.map((x) => String(x.name)))).catch(() => (allRoles = []))
    }
    wasOpen = dlgOpen
  })

  // Role grants run after CREATE USER (inline DEFAULT ROLE requires the role to
  // already be granted), then all granted roles become default.
  const roleStmts = $derived.by<string[]>(() => {
    const n = name.trim()
    if (mode !== 'user' || !memberOf.length || !n) return []
    const out = memberOf.map((r) => grantRole(r, n))
    out.push(setDefaultRole('ALL', n))
    return out
  })

  const AUTHS: ChAuth[] = ['sha256_password', 'no_password', 'plaintext_password']
  const needsPassword = $derived(auth !== 'no_password')

  const sql = $derived.by(() => {
    const n = name.trim()
    if (!n) return ''
    if (mode === 'role') return createRole(n)
    return createUser({ name: n, auth, password: needsPassword ? password : null })
  })
  const previewSql = $derived.by(() => {
    if (!sql) return sql
    const base = showPw || !password ? sql : sql.replace(`BY '${password.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`, "BY '••••••'")
    return roleStmts.length ? [base, ...roleStmts].join(';\n') : base
  })

  function generate() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
    const arr = new Uint32Array(24)
    crypto.getRandomValues(arr)
    password = Array.from(arr, (n) => alphabet[n % alphabet.length]).join('')
    showPw = true
  }

  async function run() {
    const cid = chUserWizard.connId
    if (!cid || !sql || busy) return
    busy = true
    err = null
    try {
      const res = await ipc.execStatement(cid, sql, 0)
      if (!res.ok) {
        err = res.error?.message ?? 'error'
        return
      }
      for (const stmt of roleStmts) {
        const r = await ipc.execStatement(cid, stmt, 0)
        if (!r.ok) {
          err = `user created, but role grant failed: ${r.error?.message ?? 'error'}`
          break
        }
      }
      toasts.success(`${mode === 'role' ? 'Role' : 'User'} ${name.trim()} created`, 'clickhouse')
      await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
      tabs.openUserManager(cid, name.trim())
      grantWizard.requestAfterCreate(cid, name.trim())
      chUserWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <div onkeydown={(e) => e.key === 'Escape' && !busy && chUserWizard.close()} role="presentation" class="um-backdrop">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && chUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" use:focusOnMount class="um-dlg" style="width:var(--px-540)">
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="user" size={18} /></span>
        <div class="um-dlg-title"><b>Create {mode === 'role' ? 'Role' : 'User'}</b><span>ClickHouse access control</span></div>
        <span onclick={() => !busy && chUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && chUserWizard.close()} role="button" tabindex="0" class="um-dlg-x" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>
      <div class="um-dlg-body">
        <label class="um-field">{mode === 'role' ? 'Role name' : 'User name'}
          <input bind:value={name} class="um-input mono" style="width:100%" />
        </label>
        {#if mode === 'user'}
          <label class="um-field">Authentication
            <select bind:value={auth} class="um-select mono" style="margin-left:var(--px-8)">{#each AUTHS as a (a)}<option value={a}>{a}</option>{/each}</select>
          </label>
          {#if auth === 'plaintext_password'}<div class="um-callout warn" style="margin:0"><Icon name="warning" size={14} /><span>plaintext_password stores the password unhashed on the server.</span></div>{/if}
          {#if auth === 'no_password'}<div class="um-callout warn" style="margin:0"><Icon name="warning" size={14} /><span>no_password allows login without a password.</span></div>{/if}
          {#if needsPassword}
            <div style="display:flex;gap:var(--px-6);align-items:flex-end">
              <label class="um-field" style="flex:1">Password
                <input type={showPw ? 'text' : 'password'} bind:value={password} class="um-input mono" style="width:100%" autocomplete="new-password" />
              </label>
              <span class="eg-btn" onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0"><Icon name={showPw ? 'eye-off' : 'eye'} size={13} /></span>
              <span class="eg-btn" onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0"><Icon name="sparkle" size={12} />Generate</span>
            </div>
          {/if}
          <label class="um-field">Grant roles
            <div class="um-input" style="padding:0;display:block"><MultiSelect bind:values={memberOf} options={allRoles.filter((r) => r !== name.trim())} placeholder="pick roles to grant…" /></div>
          </label>
        {/if}
        <div class="um-sql-head"><Icon name="code" size={13} />SQL that will run</div>
        <pre class="um-sql selectable">{previewSql || '-- enter a name'}</pre>
        {#if err}<div class="um-err" role="alert"><Icon name="warning" size={14} /><span>{err}</span></div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="cfm-btn" onclick={() => !busy && chUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && chUserWizard.close()} role="button" tabindex="0">Cancel</span>
        <span class="cfm-btn primary" onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!sql || busy} style="margin-left:auto;cursor:{sql && !busy ? 'pointer' : 'not-allowed'};opacity:{sql && !busy ? 1 : 0.5}">{busy ? 'Creating…' : 'Create'}</span>
      </div>
    </div>
  </div>
{/if}
