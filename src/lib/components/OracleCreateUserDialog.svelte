<script lang="ts">
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
  <div onkeydown={(e) => e.key === 'Escape' && !busy && oraUserWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && oraUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Create User</span>
        <span onclick={() => !busy && oraUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && oraUserWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <label style="font-size:var(--px-12);color:var(--text2)">User name
          <input bind:value={name} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
        </label>
        <div style="display:flex;gap:var(--px-6);align-items:flex-end">
          <label style="font-size:var(--px-12);color:var(--text2);flex:1">Password
            <input type={showPw ? 'text' : 'password'} bind:value={password} class="mono" style="display:block;margin-top:var(--px-4);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text)" />
          </label>
          <span onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">{showPw ? 'Hide' : 'Show'}</span>
          <span onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-9);cursor:pointer">Generate</span>
        </div>
        <div style="display:flex;gap:var(--px-12);flex-wrap:wrap">
          <label style="font-size:var(--px-12);color:var(--text2)">Default tablespace
            <select bind:value={defaultTablespace} class="mono" style="margin-left:var(--px-6);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text)"><option value="">(default)</option>{#each tablespaces as t (t)}<option value={t}>{t}</option>{/each}</select>
          </label>
          <label style="font-size:var(--px-12);color:var(--text2)">Profile
            <select bind:value={profile} class="mono" style="margin-left:var(--px-6);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text)"><option value="">(default)</option>{#each profiles as p (p)}<option value={p}>{p}</option>{/each}</select>
          </label>
        </div>
        <label style="font-size:var(--px-12_5);color:var(--text);display:flex;align-items:center;gap:var(--px-6)"><input type="checkbox" bind:checked={grantCreateSession} /> Grant CREATE SESSION (required to log in)</label>
        <label style="font-size:var(--px-12);color:var(--text2)">Grant roles
          <div style="margin-top:var(--px-4)"><MultiSelect bind:values={memberOf} options={allRoles.filter((r) => r !== name.trim().toUpperCase())} placeholder="pick roles to grant…" /></div>
        </label>
        <div style="font-size:var(--px-11);color:var(--muted)">SQL preview</div>
        <pre class="selectable mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-10);font-size:var(--px-11_5);margin:0;max-height:var(--px-120);overflow:auto;color:var(--text2);white-space:pre-wrap">{previewSql || '-- enter a name and password'}</pre>
        {#if err}<div style="font-size:var(--px-12);color:var(--error)">✗ {err}</div>{/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !busy && oraUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && oraUserWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Cancel</span>
        <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!stmts.length || busy} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{stmts.length && !busy ? 'pointer' : 'not-allowed'};opacity:{stmts.length && !busy ? 1 : 0.5};font-weight:600">{busy ? 'Creating…' : 'Create user'}</span>
      </div>
    </div>
  </div>
{/if}
