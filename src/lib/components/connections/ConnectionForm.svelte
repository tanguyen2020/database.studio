<script lang="ts">
  // Type-aware connection form (create + edit).
  // Editing a connected profile with connection-affecting changes triggers the
  // Save & Reconnect decision dialog instead of saving silently.
  import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import type { ProfilePublic, TestResult } from '$lib/types'

  const profile = $derived(ui.formProfile)
  const isNew = $derived(!profile?.id)
  const meta = $derived(systemMeta(profile?.system))

  // Local editable copy + secrets (never round-tripped back from backend)
  let draft = $state<ProfilePublic | null>(null)
  let password = $state('')
  let passwordTouched = $state(false)
  let sshPassword = $state('')
  let sshPasswordTouched = $state(false)
  let testing = $state(false)
  let testResult = $state<TestResult | null>(null)
  let saving = $state(false)

  $effect(() => {
    // reset local state whenever a different profile opens
    if (profile) {
      draft = JSON.parse(JSON.stringify(profile))
      if (draft && draft.port === 0 && meta.defaultPort) draft.port = meta.defaultPort
      password = ''
      passwordTouched = false
      sshPassword = ''
      sshPasswordTouched = false
      testResult = null
    } else {
      draft = null
    }
  })

  const isSqlite = $derived(draft?.system === 'sqlite')
  const isMssql = $derived(draft?.system === 'mssql')
  const showUserPass = $derived(!isSqlite && !(isMssql && draft?.mssql_auth === 'windows'))

  function close() {
    ui.formProfile = null
  }

  async function browseSqliteFile() {
    const picked = await openFileDialog({
      multiple: false,
      filters: [
        { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (typeof picked === 'string' && draft) {
      draft.sqlite_path = picked
      if (!draft.name) draft.name = picked.split(/[\\/]/).pop() ?? picked
    }
  }

  function buildDraftPayload() {
    return {
      profile: draft! as ProfilePublic,
      password: passwordTouched ? password : null,
      ssh_password: sshPasswordTouched ? sshPassword : null,
    }
  }

  async function runTest() {
    if (!draft) return
    testing = true
    testResult = null
    try {
      testResult = await connections.test(buildDraftPayload())
    } catch (e) {
      testResult = { ok: false, error: String(e) }
    } finally {
      testing = false
    }
  }

  /** Fields whose change affects the live connection (not name/group/env). */
  function connectionAffectingChanged(): boolean {
    if (!profile || !draft) return false
    const keys = ['host', 'port', 'database', 'user', 'ssl', 'sqlite_path', 'sqlite_mode', 'mssql_auth'] as const
    const changed = keys.some((k) => JSON.stringify(profile[k]) !== JSON.stringify(draft![k]))
    const sshChanged = JSON.stringify(profile.ssh) !== JSON.stringify(draft.ssh)
    return changed || sshChanged || passwordTouched || sshPasswordTouched
  }

  async function save() {
    if (!draft) return
    if (!draft.name.trim()) {
      toasts.error('Connection cần có tên')
      return
    }
    const payload = buildDraftPayload()

    // Edit-while-connected: ask Save & Reconnect / Save only (spec phase-1 §3).
    const original = connections.byId(draft.id)
    if (!isNew && original?.connected && connectionAffectingChanged()) {
      ui.editConnected = {
        draft: payload,
        tabCount: tabs.tabsForConnection(draft.id).length,
      }
      close()
      return
    }

    saving = true
    try {
      const saved = await connections.save(payload)
      if (saved) {
        toasts.success(`Đã lưu "${saved.name}"`, saved.system)
        close()
      }
    } finally {
      saving = false
    }
  }
</script>

<Dialog.Root open={!!draft} onOpenChange={(o) => !o && close()}>
  <Dialog.Content class="max-w-[600px]">
    {#if draft}
      <Dialog.Header>
        <Dialog.Title class="flex items-center gap-2">
          <SystemBadge system={draft.system} />
          {isNew ? `New ${meta.label} Connection` : `Edit "${draft.name}"`}
        </Dialog.Title>
      </Dialog.Header>

      <div class="grid max-h-[62vh] gap-3 overflow-y-auto pr-1">
        <!-- common: name / group / environment -->
        <div class="grid grid-cols-2 gap-3">
          <label class="grid gap-1">
            <span class="text-[11px] font-medium text-text2">Name</span>
            <input class="form-input" bind:value={draft.name} placeholder="Prod PG" />
          </label>
          <label class="grid gap-1">
            <span class="text-[11px] font-medium text-text2">Group</span>
            <input class="form-input" bind:value={draft.group} placeholder="Production" />
          </label>
        </div>
        <label class="grid gap-1">
          <span class="text-[11px] font-medium text-text2">Environment</span>
          <select class="form-input" bind:value={draft.env}>
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="development">Development</option>
            <option value="local">Local</option>
          </select>
        </label>

        {#if isSqlite}
          <!-- SQLite: file + mode (embedded, file-based — no host/port) -->
          <label class="grid gap-1">
            <span class="text-[11px] font-medium text-text2">Database file</span>
            <div class="flex gap-2">
              <input
                class="form-input grow"
                bind:value={draft.sqlite_path}
                placeholder="D:\data\app.db"
                disabled={draft.sqlite_mode === 'in-memory'}
              />
              <Button
                variant="secondary"
                size="sm"
                onclick={browseSqliteFile}
                disabled={draft.sqlite_mode === 'in-memory'}
              >
                Browse…
              </Button>
            </div>
          </label>
          <label class="grid gap-1">
            <span class="text-[11px] font-medium text-text2">Mode</span>
            <select class="form-input" bind:value={draft.sqlite_mode}>
              <option value="read-write">Read-Write</option>
              <option value="read-only">Read-Only</option>
              <option value="in-memory">In-Memory</option>
            </select>
          </label>
          <p class="text-[11px] text-mutedfg">
            SQLite là embedded file-based database — không cần host/port/user.
          </p>
        {:else}
          <!-- network systems -->
          <div class="grid grid-cols-[1fr_110px] gap-3">
            <label class="grid gap-1">
              <span class="text-[11px] font-medium text-text2">Host</span>
              <input class="form-input" bind:value={draft.host} placeholder="localhost" />
            </label>
            <label class="grid gap-1">
              <span class="text-[11px] font-medium text-text2">Port</span>
              <input class="form-input" type="number" bind:value={draft.port} />
            </label>
          </div>
          <label class="grid gap-1">
            <span class="text-[11px] font-medium text-text2">Database</span>
            <input
              class="form-input"
              bind:value={draft.database}
              placeholder={draft.system === 'postgres' ? 'postgres' : ''}
            />
          </label>

          {#if isMssql}
            <label class="grid gap-1">
              <span class="text-[11px] font-medium text-text2">Authentication</span>
              <select class="form-input" bind:value={draft.mssql_auth}>
                <option value="sql">SQL Server Authentication</option>
                <option value="windows">Windows Authentication</option>
              </select>
            </label>
            {#if draft.mssql_auth === 'windows'}
              <p class="text-[11px] text-mutedfg">
                Integrated Security=SSPI — dùng phiên Windows hiện tại, không cần user/password.
              </p>
            {/if}
          {/if}

          {#if showUserPass}
            <div class="grid grid-cols-2 gap-3">
              <label class="grid gap-1">
                <span class="text-[11px] font-medium text-text2">User</span>
                <input class="form-input" bind:value={draft.user} />
              </label>
              <label class="grid gap-1">
                <span class="text-[11px] font-medium text-text2">
                  Password
                  {#if !isNew && draft.has_password && !passwordTouched}
                    <span class="text-mutedfg">(đã lưu — nhập để đổi)</span>
                  {/if}
                </span>
                <input
                  class="form-input"
                  type="password"
                  value={password}
                  placeholder={!isNew && draft.has_password ? '••••••••' : ''}
                  oninput={(e) => {
                    password = e.currentTarget.value
                    passwordTouched = true
                  }}
                />
              </label>
            </div>
          {/if}

          <label class="flex items-center gap-2 text-[12px]">
            <input type="checkbox" bind:checked={draft.ssl} />
            Use SSL/TLS
          </label>

          <!-- SSH tunnel -->
          <div class="rounded-md border border-border bg-panel p-3">
            <label class="flex items-center gap-2 text-[12px] font-medium">
              <input type="checkbox" bind:checked={draft.ssh.enabled} />
              SSH Tunnel
            </label>
            {#if draft.ssh.enabled}
              <div class="mt-2 grid gap-2">
                <div class="grid grid-cols-[1fr_90px] gap-2">
                  <input class="form-input" bind:value={draft.ssh.host} placeholder="bastion.example.com" />
                  <input class="form-input" type="number" bind:value={draft.ssh.port} placeholder="22" />
                </div>
                <input class="form-input" bind:value={draft.ssh.user} placeholder="ssh user" />
                <select class="form-input" bind:value={draft.ssh.auth}>
                  <option value="password">Password</option>
                  <option value="key">Private key file</option>
                </select>
                {#if draft.ssh.auth === 'password'}
                  <input
                    class="form-input"
                    type="password"
                    value={sshPassword}
                    placeholder="SSH password"
                    oninput={(e) => {
                      sshPassword = e.currentTarget.value
                      sshPasswordTouched = true
                    }}
                  />
                {:else}
                  <div class="flex gap-2">
                    <input
                      class="form-input grow"
                      bind:value={draft.ssh.key_path}
                      placeholder="C:\Users\me\.ssh\id_ed25519"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onclick={async () => {
                        const picked = await openFileDialog({ multiple: false })
                        if (typeof picked === 'string' && draft) draft.ssh.key_path = picked
                      }}
                    >
                      Browse…
                    </Button>
                  </div>
                  <p class="text-[10.5px] text-mutedfg">
                    Chỉ lưu đường dẫn — private key không bị copy vào app.
                  </p>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        {#if testResult}
          <div
            class="rounded-md border px-3 py-2 text-[12px]"
            style="border-color: {testResult.ok ? 'var(--success)' : 'var(--error)'};
                   color: {testResult.ok ? 'var(--success)' : 'var(--error)'};"
          >
            {#if testResult.ok}
              ✓ Kết nối thành công · {testResult.latency_ms} ms
              {#if testResult.server_version}
                <div class="mt-0.5 truncate text-text2">{testResult.server_version}</div>
              {/if}
            {:else}
              ✗ {testResult.error}
            {/if}
          </div>
        {/if}
      </div>

      <Dialog.Footer class="flex items-center gap-2">
        <Button variant="outline" size="sm" onclick={runTest} disabled={testing}>
          {testing ? 'Testing…' : 'Test Connection'}
        </Button>
        <div class="grow"></div>
        <Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
        <Button size="sm" onclick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>

<style>
  .form-input {
    border: 1px solid var(--input);
    background: var(--surface);
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 12.5px;
    outline: none;
    color: var(--text);
  }
  .form-input:focus {
    border-color: var(--ring);
  }
  .form-input:disabled {
    opacity: 0.5;
  }
</style>
