<script lang="ts">
  // Create a SQL Server Login / User / Role (U3). Popup (not a tab). Mode picks
  // the flow: Login (SQL or Windows auth), User (map to a login, or WITHOUT
  // LOGIN), Role. User/Role run on the bound database via a sub-connection.
  import { mssqlUserWizard } from '$lib/stores/mssqluser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { createLogin, createUser, createDbRole, createWindowsLogin } from '$lib/users/mssql'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = mssqlUserWizard.open
  })

  const mode = $derived(mssqlUserWizard.mode)

  let name = $state('')
  let authType = $state<'sql' | 'windows'>('sql')
  let password = $state('')
  let showPw = $state(false)
  let checkPolicy = $state(true)
  let loginForUser = $state('')
  let withoutLogin = $state(false)
  let busy = $state(false)
  let err = $state<string | null>(null)

  let wasOpen = false
  $effect(() => {
    if (dlgOpen && !wasOpen) {
      name = ''
      authType = 'sql'
      password = ''
      showPw = false
      checkPolicy = true
      loginForUser = mssqlUserWizard.logins[0] ?? ''
      withoutLogin = false
      err = null
    }
    wasOpen = dlgOpen
  })

  const title = $derived(mode === 'login' ? 'New Login' : mode === 'user' ? 'New User' : 'New Role')

  const sql = $derived.by(() => {
    const n = name.trim()
    if (!n) return ''
    if (mode === 'login') {
      if (authType === 'windows') return createWindowsLogin(n)
      return createLogin({ name: n, password, checkPolicy })
    }
    if (mode === 'user') {
      return createUser(n, withoutLogin ? null : loginForUser || null)
    }
    return createDbRole(n)
  })
  const previewSql = $derived.by(() => {
    if (!sql || showPw || !password) return sql
    return sql.replace(`PASSWORD = N'${password.replace(/'/g, "''")}'`, "PASSWORD = N'••••••'")
  })

  function generate() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%^*'
    const arr = new Uint32Array(20)
    crypto.getRandomValues(arr)
    password = Array.from(arr, (n) => alphabet[n % alphabet.length]).join('')
    showPw = true
  }

  async function run() {
    const cid = mssqlUserWizard.connId
    if (!cid || !sql || busy) return
    busy = true
    err = null
    try {
      // User/Role are database-scoped → run on a sub-connection to that DB.
      let target = cid
      if (mode !== 'login' && mssqlUserWizard.database) {
        target = await ipc.attachDatabase(cid, mssqlUserWizard.database)
      }
      const res = await ipc.execStatement(target, sql, 0)
      if (!res.ok) {
        err = res.error?.message ?? 'error'
        return
      }
      toasts.success(`${title} ${name.trim()} created`, 'mssql')
      await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
      mssqlUserWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <div onkeydown={(e) => e.key === 'Escape' && !busy && mssqlUserWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && mssqlUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-540);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">{title}{mode !== 'login' && mssqlUserWizard.database ? ` · ${mssqlUserWizard.database}` : ''}</span>
        <span onclick={() => !busy && mssqlUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && mssqlUserWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <label style="font-size:var(--px-12);color:var(--text2)">{mode === 'role' ? 'Role name' : mode === 'user' ? 'User name' : 'Login name'}
          <input bind:value={name} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
        </label>
        {#if mode === 'login'}
          <div style="display:flex;gap:var(--px-14)">
            <label style="font-size:var(--px-12);color:var(--text);display:flex;align-items:center;gap:var(--px-4)"><input type="radio" bind:group={authType} value="sql" /> SQL authentication</label>
            <label style="font-size:var(--px-12);color:var(--text);display:flex;align-items:center;gap:var(--px-4)"><input type="radio" bind:group={authType} value="windows" /> Windows authentication</label>
          </div>
          {#if authType === 'sql'}
            <div style="display:flex;gap:var(--px-6);align-items:flex-end">
              <label style="font-size:var(--px-12);color:var(--text2);flex:1">Password
                <input type={showPw ? 'text' : 'password'} bind:value={password} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
              </label>
              <span onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">{showPw ? 'Hide' : 'Show'}</span>
              <span onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">Generate</span>
            </div>
            <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={checkPolicy} /> Enforce password policy</label>
          {:else}
            <div style="font-size:var(--px-11);color:var(--muted)">Windows login — enter as DOMAIN\name. Azure AD logins can only be created on Azure SQL.</div>
          {/if}
        {:else if mode === 'user'}
          <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={withoutLogin} /> Without login (contained)</label>
          {#if !withoutLogin}
            <label style="font-size:var(--px-12);color:var(--text2)">For login
              <select bind:value={loginForUser} class="mono" style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text)">
                {#each mssqlUserWizard.logins as l (l)}<option value={l}>{l}</option>{/each}
              </select>
            </label>
          {/if}
        {/if}
        <div style="font-size:var(--px-11);color:var(--muted)">SQL preview</div>
        <pre class="selectable mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11_5);margin:0;max-height:var(--px-120);overflow:auto;color:var(--text2);white-space:pre-wrap">{previewSql || '-- enter a name'}</pre>
        {#if err}<div style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && mssqlUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && mssqlUserWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!sql || busy} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{sql && !busy ? 'pointer' : 'not-allowed'};opacity:{sql && !busy ? 1 : 0.5};font-weight:600">{busy ? 'Creating…' : 'Create'}</span>
      </div>
    </div>
  </div>
{/if}
