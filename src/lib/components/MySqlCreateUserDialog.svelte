<script lang="ts">
  // Add a MySQL / MariaDB account (U2). Popup (not a tab). Host is REQUIRED
  // (account = user@host). Auth plugin dropdown differs per engine. Live
  // CREATE USER preview (password masked). Grants/roles are edited afterwards
  // in the manager detail tabs.
  import { myUserWizard } from '$lib/stores/myuser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { createUser, ql } from '$lib/users/mysql'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = myUserWizard.open
  })

  let user = $state('')
  let host = $state('%')
  let plugin = $state('')
  let password = $state('')
  let showPw = $state(false)
  let accountLocked = $state(false)
  let busy = $state(false)
  let err = $state<string | null>(null)

  let wasOpen = false
  $effect(() => {
    if (dlgOpen && !wasOpen) {
      user = ''
      host = '%'
      plugin = ''
      password = ''
      showPw = false
      accountLocked = false
      err = null
    }
    wasOpen = dlgOpen
  })

  const plugins = $derived(
    myUserWizard.system === 'mariadb'
      ? ['', 'mysql_native_password', 'ed25519', 'unix_socket']
      : ['', 'caching_sha2_password', 'mysql_native_password', 'sha256_password'],
  )
  const noPassword = $derived(plugin === 'unix_socket')

  const sql = $derived(
    user.trim() && host.trim()
      ? createUser(myUserWizard.system, {
          user: user.trim(),
          host: host.trim(),
          password: noPassword ? null : password || null,
          plugin: plugin || null,
          accountLocked,
        })
      : '',
  )
  const previewSql = $derived.by(() => {
    if (!sql || showPw || !password) return sql
    return sql.replace(`BY ${ql(password)}`, "BY '••••••'")
  })

  function generate() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%^*'
    const arr = new Uint32Array(20)
    crypto.getRandomValues(arr)
    password = Array.from(arr, (n) => alphabet[n % alphabet.length]).join('')
    showPw = true
  }

  async function run() {
    const cid = myUserWizard.connId
    if (!cid || !sql || busy) return
    busy = true
    err = null
    try {
      const res = await ipc.execStatement(cid, sql, 0)
      if (!res.ok) {
        err = res.error?.message ?? 'error'
        return
      }
      toasts.success(`Account ${user.trim()}@${host.trim()} created`, myUserWizard.system)
      await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
      myUserWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <div onkeydown={(e) => e.key === 'Escape' && !busy && myUserWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && myUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Add Account</span>
        <span onclick={() => !busy && myUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && myUserWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <div style="display:flex;gap:var(--px-10)">
          <label style="font-size:var(--px-12);color:var(--text2);flex:1">User Name
            <input bind:value={user} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
          </label>
          <label style="font-size:var(--px-12);color:var(--text2);flex:1">Host <span style="color:var(--error)">*</span>
            <input bind:value={host} list="myhost-list" class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
            <datalist id="myhost-list"><option value="%"></option><option value="localhost"></option><option value="10.0.0.%"></option></datalist>
          </label>
        </div>
        <div style="font-size:var(--px-10_5);color:var(--muted)">An account is a (user, host) pair — the same user on a different host is a different account. Use % for any host.</div>
        <label style="font-size:var(--px-12);color:var(--text2)">Authentication plugin
          <select bind:value={plugin} class="mono" style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text)">{#each plugins as p (p)}<option value={p}>{p || '(default)'}</option>{/each}</select>
        </label>
        {#if !noPassword}
          <div style="display:flex;gap:var(--px-6);align-items:flex-end">
            <label style="font-size:var(--px-12);color:var(--text2);flex:1">Password
              <input type={showPw ? 'text' : 'password'} bind:value={password} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
            </label>
            <span onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">{showPw ? 'Hide' : 'Show'}</span>
            <span onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">Generate</span>
          </div>
        {/if}
        <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={accountLocked} /> Account locked</label>
        <div style="font-size:var(--px-11);color:var(--muted)">SQL preview</div>
        <pre class="selectable mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11_5);margin:0;max-height:var(--px-120);overflow:auto;color:var(--text2);white-space:pre-wrap">{previewSql || '-- enter a user name and host'}</pre>
        {#if err}<div style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && myUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && myUserWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!sql || busy} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{sql && !busy ? 'pointer' : 'not-allowed'};opacity:{sql && !busy ? 1 : 0.5};font-weight:600">{busy ? 'Creating…' : 'Create account'}</span>
      </div>
    </div>
  </div>
{/if}
