<script lang="ts">
  // Connection Manager modal — port 1:1 từ Database Studio.dc.html dòng 2167-2273
  // (markup) + object `cm` dòng 5762-5809 (logic labels/flags per hệ).
  // Logic lưu/test/Save & Reconnect giữ từ store connections/tabs/ui.
  import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import type { ProfilePublic, TestResult } from '$lib/types'

  const profile = $derived(ui.formProfile)
  const isNew = $derived(!profile?.id)
  const isQuick = $derived(ui.formQuick)
  const meta = $derived(systemMeta(profile?.system))

  // Local editable copy + secrets (không round-trip từ backend)
  let draft = $state<ProfilePublic | null>(null)
  let password = $state('')
  let passwordTouched = $state(false)
  let sshPassword = $state('')
  let sshPasswordTouched = $state(false)
  let testing = $state(false)
  let testResult = $state<TestResult | null>(null)
  let saving = $state(false)

  $effect(() => {
    if (profile) {
      // Dựng object cục bộ + set default port TRƯỚC rồi mới gán 1 lần vào `draft`.
      // (Đọc `draft.port` bên trong effect ghi `draft` → tự-vòng-lặp
      //  effect_update_depth_exceeded → chết mọi tương tác của form.)
      const d = JSON.parse(JSON.stringify(profile)) as ProfilePublic
      if (d.port === 0 && meta.defaultPort) d.port = meta.defaultPort
      draft = d
      password = ''
      passwordTouched = false
      sshPassword = ''
      sshPasswordTouched = false
      testResult = null
    } else {
      draft = null
    }
  })

  // port từ cm object (dòng 5766-5777): rel gồm cả sqlite → form sqlite vẫn
  // hiện Host/Port/Database như prototype; Host = đường dẫn file.
  const isSqlite = $derived(draft?.system === 'sqlite')
  const isMssql = $derived(draft?.system === 'mssql')
  const isRedis = $derived(draft?.system === 'redis')
  const isNats = $derived(draft?.system === 'nats')
  const isKafka = $derived(draft?.system === 'kafka')
  const isCassandra = $derived(draft?.system === 'cassandra')
  const hostLabel = $derived(isKafka ? 'Bootstrap servers' : isCassandra ? 'Contact points' : 'Host')
  const hostPlaceholder = $derived(
    isSqlite
      ? '/data/local.db'
      : isKafka
        ? 'broker1:9092,broker2:9092'
        : isCassandra
          ? '10.0.5.1,10.0.5.2'
          : 'localhost',
  )
  const dbPlaceholder = $derived(draft?.system === 'postgres' ? 'postgres' : '')
  // port từ dòng 5791-5796: auth flags MSSQL
  const authWindows = $derived(isMssql && draft?.mssql_auth === 'windows')
  const authShowUser = $derived(!authWindows)
  const authShowPass = $derived(!authWindows)
  const sshMode = $derived(draft?.ssh.auth === 'key' ? 'key' : 'password')

  // TLS cert fields hiện khi bật SSL — MSSQL chỉ CA (tiberius không mTLS).
  type CertField = { field: 'ssl_ca' | 'ssl_cert' | 'ssl_key'; label: string; placeholder: string }
  const certFields = $derived<CertField[]>(
    isMssql
      ? [{ field: 'ssl_ca', label: 'CA Certificate', placeholder: '~/certs/ca.pem' }]
      : [
          { field: 'ssl_ca', label: 'CA Certificate', placeholder: '~/certs/ca.pem' },
          { field: 'ssl_cert', label: 'Client Certificate', placeholder: '~/certs/client.crt' },
          { field: 'ssl_key', label: 'Client Key', placeholder: '~/certs/client.key' },
        ],
  )

  function close() {
    // Đóng/Cancel khi đang Test → hủy THẬT lần test ở backend (không để treo).
    if (testId) {
      void connections.cancelTest(testId)
      testId = null
    }
    ui.formProfile = null
    ui.formQuick = false
  }

  /** Quick Connect — connect a one-off (unsaved) profile. Name is optional. */
  async function connectQuick() {
    if (!draft || saving) return
    saving = true
    try {
      if (!draft.name.trim()) {
        draft.name = isSqlite ? draft.sqlite_path || 'SQLite' : draft.host || draft.system
      }
      const p = await connections.quickConnect(buildDraftPayload())
      if (p) close()
    } finally {
      saving = false
    }
  }

  // SQLite là file-based: prototype không có native dialog nên Host input kiêm
  // file path; app thật mở picker khi double-click ô path (không thêm element).
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

  async function browseSshKey() {
    const picked = await openFileDialog({ multiple: false })
    if (typeof picked === 'string' && draft) draft.ssh.key_path = picked
  }

  // TLS cert/key picker — lưu path (không copy file). MSSQL chỉ dùng CA.
  async function browseCert(field: 'ssl_ca' | 'ssl_cert' | 'ssl_key') {
    const picked = await openFileDialog({
      multiple: false,
      filters: [
        { name: 'Certificate / Key', extensions: ['pem', 'crt', 'cert', 'key', 'der'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (typeof picked === 'string' && draft) draft[field] = picked
  }

  function buildDraftPayload() {
    return {
      profile: draft! as ProfilePublic,
      password: passwordTouched ? password : null,
      ssh_password: sshPasswordTouched ? sshPassword : null,
    }
  }

  // id của lần Test đang chạy — để Cancel/đóng dialog hủy THẬT ở backend (T10).
  let testId = $state<string | null>(null)
  async function runTest() {
    if (!draft || testing) return
    testing = true
    testResult = null
    const id = crypto.randomUUID()
    testId = id
    try {
      testResult = await connections.test(buildDraftPayload(), id)
    } catch (e) {
      testResult = { ok: false, error: String(e) }
    } finally {
      testing = false
      testId = null
    }
  }

  /** Field đổi có ảnh hưởng connection đang chạy (không tính name/group/env). */
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
      toasts.error('Connection needs a name')
      return
    }
    const payload = buildDraftPayload()

    // Edit-while-connected → dialog Save & Reconnect / Save only (phase-1 §3)
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
        toasts.success(`Saved "${saved.name}"`, saved.system)
        close()
      }
    } finally {
      saving = false
    }
  }

  function backToPicker() {
    close()
    ui.pickerOpen = true
  }
</script>

{#if draft}
  <!-- overlay — port dòng 2168 -->
  <div
    onclick={close}
    onkeydown={(e) => e.key === 'Escape' && close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:50"
  >
    <!-- panel — port dòng 2169 -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={isNew ? 'New connection' : draft.name}
      tabindex="-1"
      style="width:var(--px-840);max-width:94vw;height:var(--px-560);max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-16);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex"
    >
      <div style="flex:1;display:flex;flex-direction:column;min-width:0">
        <!-- header — port dòng 2173-2181 -->
        <div style="display:flex;align-items:center;gap:var(--px-10);padding:var(--px-16) var(--px-20);border-bottom:var(--px-1) solid var(--border)">
          {#if isNew}
            <span
              onclick={backToPicker}
              onkeydown={(e) => e.key === 'Enter' && backToPicker()}
              role="button"
              tabindex="0"
              title="Choose another type"
              style="display:flex;align-items:center;gap:var(--px-5);font-size:var(--px-12);color:var(--text2);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-5) var(--px-10);cursor:pointer"
            >‹ Back</span>
          {/if}
          <span style="width:var(--px-3);height:var(--px-22);border-radius:var(--px-2);background:{meta.accent}"></span>
          <span style="font-weight:700;font-size:var(--px-16)">{isNew ? (isQuick ? 'Quick Connect' : 'New connection') : draft.name || 'Connection'}</span>
          {#if isQuick}<span style="font-size:var(--px-11);color:var(--muted);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-2) var(--px-7)">one-off · not saved</span>{/if}
          <span style="display:flex;align-items:center"><SystemIcon system={draft.system} size={18} /></span>
          <span
            onclick={close}
            onkeydown={(e) => e.key === 'Enter' && close()}
            role="button"
            tabindex="0"
            style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)"
          >×</span>
        </div>

        <!-- body — port dòng 2182-2261 -->
        <div style="flex:1;overflow:auto;padding:var(--px-18) var(--px-20)">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-14)">
            <div style="grid-column:1/3">
              <div class="cm-label">Connection name</div>
              <input class="cm-input" bind:value={draft.name} />
            </div>
            <div style="grid-column:1/3">
              <div class="cm-label">Environment</div>
              <select class="cm-input" bind:value={draft.env}>
                <option value="production">Production</option>
                <option value="staging">Staging</option>
                <option value="development">Development</option>
                <option value="local">Local</option>
              </select>
            </div>

            {#if isSqlite}
              <!-- port dòng 2192-2195 -->
              <div style="grid-column:1/3">
                <div class="cm-label">Mode</div>
                <select class="cm-input" bind:value={draft.sqlite_mode}>
                  <option value="read-write">Read-Write</option>
                  <option value="read-only">Read-Only</option>
                  <option value="in-memory">In-Memory (:memory:)</option>
                </select>
              </div>
              <div style="grid-column:1/3;font-size:var(--px-11_5);color:var(--muted);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-9) var(--px-11)">
                SQLite is an embedded file-based database. No server required.
              </div>
            {/if}

            <!-- host + port — port dòng 2196-2201 (SQLite: Host = file path; Kafka: bootstrap full-width) -->
            <div style="grid-column:1/3;display:grid;grid-template-columns:{isKafka ? '1fr' : '2fr 1fr'};gap:var(--px-14)">
              <div>
                <div class="cm-label">{hostLabel}</div>
                {#if isSqlite}
                  <input
                    class="cm-input mono"
                    bind:value={draft.sqlite_path}
                    placeholder={hostPlaceholder}
                    title="Double-click to browse"
                    disabled={draft.sqlite_mode === 'in-memory'}
                    ondblclick={browseSqliteFile}
                  />
                {:else}
                  <input class="cm-input mono" bind:value={draft.host} placeholder={hostPlaceholder} />
                {/if}
              </div>
              {#if !isKafka}
                <div>
                  <div class="cm-label">Port</div>
                  {#if isSqlite}
                    <input class="cm-input mono" value="" disabled />
                  {:else}
                    <input class="cm-input mono" type="number" bind:value={draft.port} />
                  {/if}
                </div>
              {/if}
            </div>

            <!-- database — port dòng 2205-2207 (Redis: DB index 0–15; NATS/Kafka: ẩn) -->
            <div style={isNats || isKafka ? 'display:none' : ''}>
              {#if isRedis}
                <div class="cm-label">DB Index</div>
                <select class="cm-input" bind:value={draft.database}>
                  {#each Array.from({ length: 16 }, (_, i) => String(i)) as n (n)}
                    <option value={n}>{n}</option>
                  {/each}
                </select>
              {:else}
                <div class="cm-label">Database</div>
                <input class="cm-input mono" bind:value={draft.database} placeholder={dbPlaceholder} />
              {/if}
            </div>

            {#if isKafka}
              <!-- Kafka SASL mechanism (tái dùng field mssql_auth làm auth mode) -->
              <div style="grid-column:1/3">
                <div class="cm-label">Authentication (SASL)</div>
                <select class="cm-input" bind:value={draft.mssql_auth}>
                  <option value="">None (PLAINTEXT)</option>
                  <option value="PLAIN">SASL/PLAIN</option>
                  <option value="SCRAM-SHA-256">SASL/SCRAM-SHA-256</option>
                  <option value="SCRAM-SHA-512">SASL/SCRAM-SHA-512</option>
                </select>
              </div>
              <div style="grid-column:1/3">
                <div class="cm-label">Schema Registry URL <span style="color:var(--muted);font-weight:400">(optional)</span></div>
                <input class="cm-input mono" bind:value={draft.schema_registry_url} placeholder="http://localhost:8081" />
              </div>
            {/if}

            {#if isCassandra}
              <!-- Cassandra: Local datacenter + Consistency level (prototype dòng 2188-2191) -->
              <div>
                <div class="cm-label">Local datacenter</div>
                <input class="cm-input mono" bind:value={draft.cassandra_dc} placeholder="dc1" />
              </div>
              <div>
                <div class="cm-label">Consistency level</div>
                <select class="cm-input" bind:value={draft.cassandra_consistency}>
                  <option value="LOCAL_QUORUM">LOCAL_QUORUM</option>
                  <option value="QUORUM">QUORUM</option>
                  <option value="ONE">ONE</option>
                  <option value="ALL">ALL</option>
                  <option value="LOCAL_ONE">LOCAL_ONE</option>
                  <option value="EACH_QUORUM">EACH_QUORUM</option>
                </select>
              </div>
            {/if}

            {#if isMssql}
              <!-- port dòng 2208-2211 + Azure AD Service Principal (T31) -->
              <div style="grid-column:1/3">
                <div class="cm-label">Authentication</div>
                <select class="cm-input" bind:value={draft.mssql_auth}>
                  <option value="sql">SQL Server Authentication</option>
                  <option value="windows">Windows Authentication</option>
                  <option value="aad-sp">Azure AD (Service Principal)</option>
                </select>
                {#if draft.mssql_auth === 'aad-sp'}
                  <div class="cm-label" style="margin-top:var(--px-6);color:var(--muted);font-weight:400">
                    User = <span class="mono">clientId@tenantId</span>, Password = client secret. A token is fetched from Azure AD (login.microsoftonline.com) at connect.
                  </div>
                {/if}
              </div>
            {/if}

            {#if authShowUser && !isRedis}
              <div>
                <div class="cm-label">User</div>
                <input class="cm-input mono" bind:value={draft.user} />
              </div>
            {/if}
            {#if authShowPass}
              <!-- port dòng 2215-2217: label xanh AES-256; input thật thay div dots -->
              <div style="grid-column:1/3">
                <div class="cm-label">
                  Password <span style="color:var(--hex-27ae60)">· AES-256 encrypted</span>
                  {#if !isNew && draft.has_password && !passwordTouched}
                    <span style="color:var(--muted);font-weight:400">(saved — type to change)</span>
                  {/if}
                </div>
                <input
                  class="cm-input mono"
                  type="password"
                  value={password}
                  placeholder={!isNew && draft.has_password ? '••••••••••••' : ''}
                  oninput={(e) => {
                    password = e.currentTarget.value
                    passwordTouched = true
                  }}
                />
              </div>
            {/if}
            {#if authWindows}
              <!-- port dòng 2218-2220 -->
              <div style="grid-column:1/3;font-size:var(--px-11_5);color:var(--muted);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-9) var(--px-11)">
                Connecting as <span class="mono" style="color:var(--text2)">{draft.user || 'current user'}</span> · current Windows session (Integrated Security=SSPI)
              </div>
            {/if}
          </div>

          <!-- SSH / SSL toggles — port dòng 2225-2228 -->
          <div style="margin-top:var(--px-18);display:flex;gap:var(--px-18)">
            <div
              onclick={() => draft && (draft.ssh.enabled = !draft.ssh.enabled)}
              onkeydown={(e) => e.key === 'Enter' && draft && (draft.ssh.enabled = !draft.ssh.enabled)}
              role="switch"
              aria-checked={draft.ssh.enabled}
              tabindex="0"
              style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-12_5);cursor:pointer"
            >
              <span style="width:var(--px-34);height:var(--px-18);border-radius:var(--px-10);background:{draft.ssh.enabled ? 'var(--hex-27ae60)' : 'var(--border2)'};position:relative;transition:background .15s">
                <span style="position:absolute;top:var(--px-2);{draft.ssh.enabled ? 'right:var(--px-2)' : 'left:var(--px-2)'};width:var(--px-14);height:var(--px-14);border-radius:50%;background:var(--hex-fff)"></span>
              </span>SSH Tunnel
            </div>
            <div
              onclick={() => draft && (draft.ssl = !draft.ssl)}
              onkeydown={(e) => e.key === 'Enter' && draft && (draft.ssl = !draft.ssl)}
              role="switch"
              aria-checked={draft.ssl}
              tabindex="0"
              style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-12_5);color:var(--text2);cursor:pointer"
            >
              <span style="width:var(--px-34);height:var(--px-18);border-radius:var(--px-10);background:{draft.ssl ? 'var(--hex-27ae60)' : 'var(--border2)'};position:relative;transition:background .15s">
                <span style="position:absolute;top:var(--px-2);{draft.ssl ? 'right:var(--px-2)' : 'left:var(--px-2)'};width:var(--px-14);height:var(--px-14);border-radius:50%;background:var(--hex-fff)"></span>
              </span>SSL/TLS
            </div>
          </div>

          {#if draft.ssh.enabled}
            <!-- SSH panel — port dòng 2229-2260 -->
            <div style="margin-top:var(--px-14);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-10);padding:var(--px-14)">
              <div style="display:grid;grid-template-columns:2fr 1fr;gap:var(--px-14);margin-bottom:var(--px-14)">
                <div>
                  <div class="cm-label">SSH Host</div>
                  <input class="cm-input-ssh mono" bind:value={draft.ssh.host} />
                </div>
                <div>
                  <div class="cm-label">SSH Port</div>
                  <input class="cm-input-ssh mono" type="number" bind:value={draft.ssh.port} />
                </div>
              </div>
              <div class="cm-label">Authentication</div>
              <div style="display:flex;background:var(--bg);border:var(--px-1) solid var(--border);border-radius:var(--px-8);overflow:hidden;margin-bottom:var(--px-14);width:fit-content">
                <span
                  onclick={() => draft && (draft.ssh.auth = 'password')}
                  onkeydown={(e) => e.key === 'Enter' && draft && (draft.ssh.auth = 'password')}
                  role="button"
                  tabindex="0"
                  style="padding:var(--px-6) var(--px-16);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{sshMode === 'password' ? meta.accent : 'transparent'};color:{sshMode === 'password' ? 'var(--hex-fff)' : 'var(--text2)'}"
                >Username / Password</span>
                <span
                  onclick={() => draft && (draft.ssh.auth = 'key')}
                  onkeydown={(e) => e.key === 'Enter' && draft && (draft.ssh.auth = 'key')}
                  role="button"
                  tabindex="0"
                  style="padding:var(--px-6) var(--px-16);font-size:var(--px-12);font-weight:600;cursor:pointer;background:{sshMode === 'key' ? meta.accent : 'transparent'};color:{sshMode === 'key' ? 'var(--hex-fff)' : 'var(--text2)'};border-left:var(--px-1) solid var(--border)"
                >Private Key</span>
              </div>
              {#if sshMode === 'password'}
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-14)">
                  <div>
                    <div class="cm-label">SSH Username</div>
                    <input class="cm-input-ssh mono" bind:value={draft.ssh.user} />
                  </div>
                  <div>
                    <div class="cm-label">SSH Password</div>
                    <input
                      class="cm-input-ssh mono"
                      type="password"
                      value={sshPassword}
                      oninput={(e) => {
                        sshPassword = e.currentTarget.value
                        sshPasswordTouched = true
                      }}
                    />
                  </div>
                </div>
              {:else}
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-14)">
                  <div>
                    <div class="cm-label">SSH Username</div>
                    <input class="cm-input-ssh mono" bind:value={draft.ssh.user} />
                  </div>
                  <div>
                    <div class="cm-label">Passphrase <span style="color:var(--muted);font-weight:400">(optional)</span></div>
                    <input class="cm-input-ssh mono" type="password" disabled title="Passphrase-protected key: phase sau" />
                  </div>
                  <div style="grid-column:1/3">
                    <div class="cm-label">Private Key File</div>
                    <div style="display:flex;gap:var(--px-8)">
                      <input
                        class="cm-input-ssh mono"
                        style="flex:1;min-width:0"
                        bind:value={draft.ssh.key_path}
                        placeholder="~/.ssh/id_rsa"
                      />
                      <span
                        onclick={browseSshKey}
                        onkeydown={(e) => e.key === 'Enter' && browseSshKey()}
                        role="button"
                        tabindex="0"
                        style="flex:none;display:flex;align-items:center;gap:var(--px-6);background:var(--bg);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-14);font-size:var(--px-12_5);font-weight:600;cursor:pointer;color:var(--text2)"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>Browse…
                      </span>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          {/if}

          {#if draft.ssl}
            <!-- TLS certificates — lưu path (không copy file); MSSQL chỉ CA -->
            <div style="margin-top:var(--px-14);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-10);padding:var(--px-14)">
              <div class="cm-label">TLS Certificates <span style="color:var(--muted);font-weight:400">(optional — leave blank for system CA)</span></div>
              <div style="display:grid;gap:var(--px-10);margin-top:var(--px-6)">
                {#each certFields as cf (cf.field)}
                  <div>
                    <div class="cm-label">{cf.label}</div>
                    <div style="display:flex;gap:var(--px-8)">
                      <input class="cm-input-ssh mono" style="flex:1;min-width:0" bind:value={draft[cf.field]} placeholder={cf.placeholder} />
                      <span
                        onclick={() => browseCert(cf.field)}
                        onkeydown={(e) => e.key === 'Enter' && browseCert(cf.field)}
                        role="button"
                        tabindex="0"
                        style="flex:none;display:flex;align-items:center;gap:var(--px-6);background:var(--bg);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-14);font-size:var(--px-12_5);font-weight:600;cursor:pointer;color:var(--text2)"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>Browse…
                      </span>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        <!-- footer — port dòng 2262-2269; status hiện sau khi Test thật -->
        <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-14) var(--px-20);border-top:var(--px-1) solid var(--border)">
          {#if testResult?.ok}
            <span style="display:flex;align-items:center;gap:var(--px-7);font-size:var(--px-12_5);color:var(--hex-27ae60);font-weight:600"><span>✓</span>Connection successful · {testResult.latency_ms} ms</span>
          {:else if testResult}
            <span style="display:flex;align-items:center;gap:var(--px-7);font-size:var(--px-12_5);color:var(--error);font-weight:600;min-width:0"><span>✗</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{testResult.error}</span></span>
          {/if}
          <div style="margin-left:auto;display:flex;gap:var(--px-9)">
            <span
              onclick={runTest}
              onkeydown={(e) => e.key === 'Enter' && runTest()}
              role="button"
              tabindex="0"
              style="font-size:var(--px-12_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer"
            >{testing ? 'Testing…' : 'Test connection'}</span>
            <span
              onclick={close}
              onkeydown={(e) => e.key === 'Enter' && close()}
              role="button"
              tabindex="0"
              style="font-size:var(--px-12_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer"
            >Cancel</span>
            {#if isQuick}
              <span
                onclick={connectQuick}
                onkeydown={(e) => e.key === 'Enter' && connectQuick()}
                role="button"
                tabindex="0"
                style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600"
              >{saving ? 'Connecting…' : 'Connect'}</span>
            {:else}
              <span
                onclick={save}
                onkeydown={(e) => e.key === 'Enter' && save()}
                role="button"
                tabindex="0"
                style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600"
              >{saving ? 'Connecting…' : 'Connect'}</span>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* input chuẩn của form — port style inline lặp lại ở dòng 2184+ */
  .cm-label {
    font-size: var(--px-11);
    color: var(--muted);
    margin-bottom: var(--px-5);
    font-weight: 600;
  }
  .cm-input {
    width: 100%;
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    padding: var(--px-9) var(--px-11);
    font-size: var(--px-13);
    color: var(--text);
    outline: none;
    font-family: inherit;
  }
  /* input trong SSH panel — nền --bg, padding 8px 11px (dòng 2232+) */
  .cm-input-ssh {
    width: 100%;
    background: var(--bg);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    padding: var(--px-8) var(--px-11);
    font-size: var(--px-13);
    color: var(--text);
    outline: none;
  }
  .cm-input:disabled,
  .cm-input-ssh:disabled {
    opacity: 0.5;
  }
</style>
