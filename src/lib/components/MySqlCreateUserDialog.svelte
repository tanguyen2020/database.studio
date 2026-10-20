<script lang="ts">
  import '$lib/components/workspace/users/um.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import Icon from '$lib/components/Icon.svelte'
  // Add a MySQL / MariaDB account (U2). Popup (not a tab). Host is REQUIRED
  // (account = user@host). Auth plugin dropdown differs per engine. Live
  // CREATE USER preview (password masked). Grants/roles are edited afterwards
  // in the manager detail tabs.
  import { myUserWizard } from '$lib/stores/myuser.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { grantWizard } from '$lib/stores/grantwizard.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { createUser, grantRole, setDefaultRole, ql } from '$lib/users/mysql'
  import MultiSelect from '$lib/components/MultiSelect.svelte'

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
  let memberOf = $state<string[]>([])
  let allRoles = $state<string[]>([])
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
      memberOf = []
      err = null
      // load grantable roles: MariaDB flags roles (is_role); MySQL 8 has no such
      // flag, so any existing account can act as a role — list distinct names.
      const cid = myUserWizard.connId
      allRoles = []
      if (cid) {
        ipc
          .usersView(cid, 'users')
          .then((r) => {
            const rows = myUserWizard.system === 'mariadb' ? r.rows.filter((x) => x.is_role === 'Y' || x.is_role === true || x.is_role === 1) : r.rows
            allRoles = [...new Set(rows.map((x) => String(x.user)))]
          })
          .catch(() => (allRoles = []))
      }
    }
    wasOpen = dlgOpen
  })

  // Role grants run after CREATE USER (MySQL/MariaDB cannot grant roles inline).
  // MySQL activates all granted roles by default (SET DEFAULT ROLE ALL);
  // MariaDB has no ALL, so its first role is made the default.
  const roleStmts = $derived.by<string[]>(() => {
    if (!memberOf.length || !user.trim() || !host.trim()) return []
    const u = user.trim(), h = host.trim()
    const out = memberOf.map((r) => grantRole(r, u, h))
    out.push(setDefaultRole(myUserWizard.system, myUserWizard.system === 'mariadb' ? memberOf[0] : 'ALL', u, h))
    return out
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
    if (!sql) return sql
    const base = showPw || !password ? sql : sql.replace(`BY ${ql(password)}`, "BY '••••••'")
    return roleStmts.length ? [base, ...roleStmts].join(';\n') : base
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
      // grant selected roles (separate statements — MySQL/MariaDB grammar).
      for (const stmt of roleStmts) {
        const r = await ipc.execStatement(cid, stmt, 0)
        if (!r.ok) {
          err = `account created, but role grant failed: ${r.error?.message ?? 'error'}`
          break
        }
      }
      toasts.success(`Account ${user.trim()}@${host.trim()} created`, myUserWizard.system)
      await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
      const acctKey = `${user.trim()}@${host.trim()}`
      tabs.openUserManager(cid, acctKey)
      grantWizard.requestAfterCreate(cid, acctKey)
      myUserWizard.close()
    } catch (e) {
      err = String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <div onkeydown={(e) => e.key === 'Escape' && !busy && myUserWizard.close()} role="presentation" class="um-backdrop">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !busy && myUserWizard.close()} role="dialog" aria-modal="true" tabindex="-1" use:focusOnMount class="um-dlg">
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="user" size={18} /></span>
        <div class="um-dlg-title"><b>Add Account</b><span>An account is a user name plus the host it may connect from</span></div>
        <span onclick={() => !busy && myUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && myUserWizard.close()} role="button" tabindex="0" class="um-dlg-x" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>
      <div class="um-dlg-body">
        <div style="display:flex;gap:var(--px-10)">
          <label class="um-field" style="flex:1">User Name
            <input bind:value={user} class="um-input mono" style="width:100%" />
          </label>
          <label class="um-field" style="flex:1">Host <span style="color:var(--error)">*</span>
            <input bind:value={host} list="myhost-list" class="um-input mono" style="width:100%" />
            <datalist id="myhost-list"><option value="%"></option><option value="localhost"></option><option value="10.0.0.%"></option></datalist>
          </label>
        </div>
        <div style="font-size:var(--px-10_5);color:var(--muted)">An account is a (user, host) pair — the same user on a different host is a different account. Use % for any host.</div>
        <label class="um-field">Authentication plugin
          <select bind:value={plugin} class="um-select mono" style="margin-left:var(--px-8)">{#each plugins as p (p)}<option value={p}>{p || '(default)'}</option>{/each}</select>
        </label>
        {#if !noPassword}
          <div style="display:flex;gap:var(--px-6);align-items:flex-end">
            <label class="um-field" style="flex:1">Password
              <input type={showPw ? 'text' : 'password'} bind:value={password} class="um-input mono" style="width:100%" autocomplete="new-password" />
            </label>
            <span class="eg-btn" onclick={() => (showPw = !showPw)} onkeydown={(e) => e.key === 'Enter' && (showPw = !showPw)} role="button" tabindex="0"><Icon name={showPw ? 'eye-off' : 'eye'} size={13} /></span>
            <span class="eg-btn" onclick={generate} onkeydown={(e) => e.key === 'Enter' && generate()} role="button" tabindex="0"><Icon name="sparkle" size={12} />Generate</span>
          </div>
        {/if}
        <label class="um-checkline"><input class="um-check" type="checkbox" bind:checked={accountLocked} /> Account locked</label>
        <label class="um-field">Grant roles
          <div class="um-input" style="padding:0;display:block"><MultiSelect bind:values={memberOf} options={allRoles.filter((r) => r !== user.trim())} placeholder="pick roles to grant…" /></div>
        </label>
        <div class="um-sql-head"><Icon name="code" size={13} />SQL that will run</div>
        <pre class="um-sql selectable">{previewSql || '-- enter a user name and host'}</pre>
        {#if err}<div class="um-err" role="alert"><Icon name="warning" size={14} /><span>{err}</span></div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="cfm-btn" onclick={() => !busy && myUserWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && myUserWizard.close()} role="button" tabindex="0">Cancel</span>
        <span class="cfm-btn primary" onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!sql || busy} style="margin-left:auto;cursor:{sql && !busy ? 'pointer' : 'not-allowed'};opacity:{sql && !busy ? 1 : 0.5}">{busy ? 'Creating…' : 'Create account'}</span>
      </div>
    </div>
  </div>
{/if}
