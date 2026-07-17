<script lang="ts">
  // Create a Cassandra role (U7). Popup (not a tab). LOGIN = a "user"; a role
  // without login/password is a pure group. Runs via cql_exec, refreshes tree.
  import { cassUserWizard } from '$lib/stores/cassuser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { createRole } from '$lib/users/cassandra'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = cassUserWizard.open
  })

  let name = $state('')
  let canLogin = $state(true)
  let superuser = $state(false)
  let password = $state('')
  let showPw = $state(false)
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
      err = null
    }
    wasOpen = dlgOpen
  })

  const cql = $derived(
    name.trim()
      ? createRole({ name: name.trim(), password: canLogin && password ? password : null, login: canLogin, superuser })
      : '',
  )
  const previewCql = $derived.by(() => {
    if (!cql || showPw || !password) return cql
    return cql.replace(`PASSWORD = '${password.replace(/'/g, "''")}'`, "PASSWORD = '••••••'")
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
  <div onkeydown={(e) => e.key === 'Escape' && !busy && cassUserWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && cassUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-540);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Create Role</span>
        <span onclick={() => !busy && cassUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && cassUserWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <label style="font-size:var(--px-12);color:var(--text2)">Role name
          <input bind:value={name} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
        </label>
        <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={canLogin} /> Can login (a user)</label>
        <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={superuser} /> Superuser</label>
        {#if canLogin}
          <div style="display:flex;gap:var(--px-6);align-items:flex-end">
            <label style="font-size:var(--px-12);color:var(--text2);flex:1">Password
              <input type={showPw ? 'text' : 'password'} bind:value={password} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
            </label>
            <span onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">{showPw ? 'Hide' : 'Show'}</span>
            <span onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">Generate</span>
          </div>
        {/if}
        <div style="font-size:var(--px-11);color:var(--muted)">CQL preview</div>
        <pre class="selectable mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11_5);margin:0;max-height:var(--px-120);overflow:auto;color:var(--text2);white-space:pre-wrap">{previewCql || '-- enter a role name'}</pre>
        {#if err}<div style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && cassUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && cassUserWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!cql || busy} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{cql && !busy ? 'pointer' : 'not-allowed'};opacity:{cql && !busy ? 1 : 0.5};font-weight:600">{busy ? 'Creating…' : 'Create role'}</span>
      </div>
    </div>
  </div>
{/if}
