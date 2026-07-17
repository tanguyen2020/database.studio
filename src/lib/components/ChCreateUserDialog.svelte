<script lang="ts">
  // Create a ClickHouse User / Role (U4). Popup (not a tab). Auth dropdown
  // (sha256 default; no_password / plaintext_password warn). Live preview
  // (password masked). Runs via exec_statement (HTTP) then refreshes Explorer.
  import { chUserWizard } from '$lib/stores/chuser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { createRole, createUser, type ChAuth } from '$lib/users/clickhouse'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = chUserWizard.open
  })
  const mode = $derived(chUserWizard.mode)

  let name = $state('')
  let auth = $state<ChAuth>('sha256_password')
  let password = $state('')
  let showPw = $state(false)
  let busy = $state(false)
  let err = $state<string | null>(null)

  let wasOpen = false
  $effect(() => {
    if (dlgOpen && !wasOpen) {
      name = ''
      auth = 'sha256_password'
      password = ''
      showPw = false
      err = null
    }
    wasOpen = dlgOpen
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
    if (!sql || showPw || !password) return sql
    return sql.replace(`BY '${password.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`, "BY '••••••'")
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
  <div onkeydown={(e) => e.key === 'Escape' && !busy && chUserWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && chUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-540);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Create {mode === 'role' ? 'Role' : 'User'}</span>
        <span onclick={() => !busy && chUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && chUserWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <label style="font-size:var(--px-12);color:var(--text2)">{mode === 'role' ? 'Role name' : 'User name'}
          <input bind:value={name} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
        </label>
        {#if mode === 'user'}
          <label style="font-size:var(--px-12);color:var(--text2)">Authentication
            <select bind:value={auth} class="mono" style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text)">{#each AUTHS as a (a)}<option value={a}>{a}</option>{/each}</select>
          </label>
          {#if auth === 'plaintext_password'}<div style="font-size:var(--px-11);color:var(--warn2)">⚠ plaintext_password stores the password unhashed on the server.</div>{/if}
          {#if auth === 'no_password'}<div style="font-size:var(--px-11);color:var(--warn2)">⚠ no_password allows login without a password.</div>{/if}
          {#if needsPassword}
            <div style="display:flex;gap:var(--px-6);align-items:flex-end">
              <label style="font-size:var(--px-12);color:var(--text2);flex:1">Password
                <input type={showPw ? 'text' : 'password'} bind:value={password} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
              </label>
              <span onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">{showPw ? 'Hide' : 'Show'}</span>
              <span onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">Generate</span>
            </div>
          {/if}
        {/if}
        <div style="font-size:var(--px-11);color:var(--muted)">SQL preview</div>
        <pre class="selectable mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11_5);margin:0;max-height:var(--px-120);overflow:auto;color:var(--text2);white-space:pre-wrap">{previewSql || '-- enter a name'}</pre>
        {#if err}<div style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && chUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && chUserWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!sql || busy} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{sql && !busy ? 'pointer' : 'not-allowed'};opacity:{sql && !busy ? 1 : 0.5};font-weight:600">{busy ? 'Creating…' : 'Create'}</span>
      </div>
    </div>
  </div>
{/if}
