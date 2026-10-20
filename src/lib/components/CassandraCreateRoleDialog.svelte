<script lang="ts">
  import '$lib/components/workspace/users/um.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import Icon from '$lib/components/Icon.svelte'
  // Create a Cassandra role (U7). Popup (not a tab). LOGIN = a "user"; a role
  // without login/password is a pure group. Runs via cql_exec, refreshes tree.
  import { cassUserWizard } from '$lib/stores/cassuser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { createRole, grantRole } from '$lib/users/cassandra'
  import MultiSelect from '$lib/components/MultiSelect.svelte'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = cassUserWizard.open
  })

  let name = $state('')
  let canLogin = $state(true)
  let superuser = $state(false)
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
      canLogin = true
      superuser = false
      password = ''
      showPw = false
      memberOf = []
      err = null
      const cid = cassUserWizard.connId
      allRoles = []
      if (cid) {
        ipc
          .cqlExec(cid, 'LIST ROLES')
          .then((r) => (allRoles = (r.result?.rows ?? []).map((row) => String((row as Record<string, unknown>).role)).filter(Boolean)))
          .catch(() => (allRoles = []))
      }
    }
    wasOpen = dlgOpen
  })

  const cql = $derived(
    name.trim()
      ? createRole({ name: name.trim(), password: canLogin && password ? password : null, login: canLogin, superuser })
      : '',
  )
  // Role membership is granted after CREATE ROLE (Cassandra: GRANT parent TO x).
  const roleStmts = $derived.by<string[]>(() => (name.trim() && memberOf.length ? memberOf.map((r) => grantRole(r, name.trim())) : []))
  const previewCql = $derived.by(() => {
    if (!cql) return cql
    const base = showPw || !password ? cql : cql.replace(`PASSWORD = '${password.replace(/'/g, "''")}'`, "PASSWORD = '••••••'")
    return roleStmts.length ? [base, ...roleStmts].join(';\n') : base
  })

  function generate() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
    const arr = new Uint32Array(20)
    crypto.getRandomValues(arr)
    password = Array.from(arr, (n) => alphabet[n % alphabet.length]).join('')
    showPw = true
  }

  async function run() {
    const cid = cassUserWizard.connId
    if (!cid || !cql || busy) return
    busy = true
    err = null
    try {
      const res = await ipc.cqlExec(cid, cql)
      if (!res.ok) {
        err = res.error?.message ?? 'error'
        return
      }
      for (const stmt of roleStmts) {
        const r = await ipc.cqlExec(cid, stmt)
        if (!r.ok) {
          err = `role created, but membership grant failed: ${r.error?.message ?? 'error'}`
          break
        }
      }
      toasts.success(`Role ${name.trim()} created`, 'cassandra')
      await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
      tabs.openUserManager(cid, name.trim())
      grantWizard.requestAfterCreate(cid, name.trim())
      cassUserWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <div onkeydown={(e) => e.key === 'Escape' && !busy && cassUserWizard.close()} role="presentation" class="um-backdrop">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && cassUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" use:focusOnMount class="um-dlg" style="width:var(--px-540)">
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="users" size={18} /></span>
        <div class="um-dlg-title"><b>Create Role</b><span>Cassandra · a role can log in, be a superuser, or both</span></div>
        <span onclick={() => !busy && cassUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && cassUserWizard.close()} role="button" tabindex="0" class="um-dlg-x" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>
      <div class="um-dlg-body">
        <label class="um-field">Role name
          <input bind:value={name} class="um-input mono" style="width:100%" />
        </label>
        <label class="um-checkline"><input class="um-check" type="checkbox" bind:checked={canLogin} /> Can login (a user)</label>
        <label class="um-checkline"><input class="um-check" type="checkbox" bind:checked={superuser} /> Superuser</label>
        {#if canLogin}
          <div style="display:flex;gap:var(--px-6);align-items:flex-end">
            <label class="um-field" style="flex:1">Password
              <input type={showPw ? 'text' : 'password'} bind:value={password} class="um-input mono" style="width:100%" autocomplete="new-password" />
            </label>
            <span class="eg-btn" onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0"><Icon name={showPw ? 'eye-off' : 'eye'} size={13} /></span>
            <span class="eg-btn" onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0"><Icon name="sparkle" size={12} />Generate</span>
          </div>
        {/if}
        <label class="um-field">Member of (roles)
          <div class="um-input" style="padding:0;display:block"><MultiSelect bind:values={memberOf} options={allRoles.filter((r) => r !== name.trim())} placeholder="grant role membership…" /></div>
        </label>
        <div class="um-field-hint">CQL preview</div>
        <pre class="um-sql selectable">{previewCql || '-- enter a role name'}</pre>
        {#if err}<div class="um-err" role="alert"><Icon name="warning" size={14} /><span>{err}</span></div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="cfm-btn" onclick={() => !busy && cassUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && cassUserWizard.close()} role="button" tabindex="0">Cancel</span>
        <span class="cfm-btn primary" onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!cql || busy} style="margin-left:auto;cursor:{cql && !busy ? 'pointer' : 'not-allowed'};opacity:{cql && !busy ? 1 : 0.5}">{busy ? 'Creating…' : 'Create role'}</span>
      </div>
    </div>
  </div>
{/if}
