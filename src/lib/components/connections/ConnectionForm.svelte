<script lang="ts">
  // Connection Manager modal — port 1:1 từ Database Studio.dc.html dòng 2167-2273
  // (markup) + object `cm` dòng 5762-5809 (logic labels/flags per hệ).
  // Logic lưu/test/Save & Reconnect giữ từ store connections/tabs/ui.
  import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { connectionChanged } from '$lib/connection/changes'
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
  // DuckDB is embedded too: a file path (or :memory:) + mode, no server, no auth.
  const isDuckdb = $derived(draft?.system === 'duckdb')
  const isFileDb = $derived(isSqlite || isDuckdb)
  const isMssql = $derived(draft?.system === 'mssql')
  const isRedis = $derived(draft?.system === 'redis')
  const isNats = $derived(draft?.system === 'nats')
  const isKafka = $derived(draft?.system === 'kafka')
  const isCassandra = $derived(draft?.system === 'cassandra')
  const isOracle = $derived(draft?.system === 'oracle')
  // RabbitMQ: host/port = Management HTTP API; `database` carries the virtual host.
  const isRabbit = $derived(draft?.system === 'rabbitmq')
  // Elasticsearch: REST API (9200); host may be a full URL (Elastic Cloud / proxy);
  // `mssql_auth` carries the auth method (basic | apikey | bearer | none).
  const isElastic = $derived(draft?.system === 'elasticsearch')
  const esAuth = $derived(isElastic ? draft?.mssql_auth || 'basic' : '')
  const hostLabel = $derived(isKafka ? 'Host / Bootstrap' : isCassandra ? 'Contact points' : isDuckdb ? 'Database file' : 'Host')
  const hostPlaceholder = $derived(
    isSqlite
      ? '/data/local.db'
      : isDuckdb
        ? '/data/analytics.duckdb'
      : isKafka
        ? '192.168.1.10  (or broker1:9092,broker2:9092)'
        : isCassandra
          ? '10.0.5.1,10.0.5.2'
          : isElastic
            ? 'localhost  (or https://my-deployment.es.io)'
            : 'localhost',
  )
  const dbPlaceholder = $derived(draft?.system === 'postgres' ? 'postgres' : isOracle ? 'FREEPDB1' : '')
  // port từ dòng 5791-5796: auth flags MSSQL
  const authWindows = $derived(isMssql && draft?.mssql_auth === 'windows')
  const authShowUser = $derived(!authWindows && !isDuckdb && !(isElastic && esAuth !== 'basic'))
  const authShowPass = $derived(!authWindows && !isDuckdb && !(isElastic && esAuth === 'none'))
  const passLabel = $derived(esAuth === 'apikey' ? 'API key' : esAuth === 'bearer' ? 'Bearer token' : 'Password')
  const sshMode = $derived(draft?.ssh.auth === 'key' ? 'key' : 'password')
  // the Credentials section only appears when this engine asks for something in it
  const showCreds = $derived(!isNats && !isKafka && !isDuckdb ? true : authShowUser || authShowPass)
  const subtitle = $derived(
    isFileDb
      ? `${meta.label} · embedded, no server needed`
      : isQuick
        ? `${meta.label} · used once, not saved to your list`
        : isNew
          ? `${meta.label} · tell us how to reach the server`
          : `${meta.label} · ${draft?.host ?? ''}${draft?.port ? ':' + draft.port : ''}`,
  )

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
        draft.name = isSqlite
          ? draft.sqlite_path || 'SQLite'
          : isDuckdb
            ? draft.sqlite_path.split(/[\\/]/).pop() || 'DuckDB'
            : draft.host || draft.system
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
      filters: isDuckdb
        ? [
            { name: 'DuckDB database', extensions: ['duckdb', 'ddb', 'db'] },
            { name: 'All files', extensions: ['*'] },
          ]
        : [
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
  // Any config field counts (engine-specific ones too — Kafka SASL, Cassandra DC,
  // TLS…); only the labels (name / group / environment) don't need a reconnect.
  function connectionAffectingChanged(): boolean {
    if (!profile || !draft) return false
    return connectionChanged(profile, draft) || passwordTouched || sshPasswordTouched
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

  // the first thing to type is the name — land the caret there when the form opens
  const focusName = (node: HTMLInputElement) => {
    requestAnimationFrame(() => {
      node.focus()
      node.select()
    })
  }

  function backToPicker() {
    close()
    ui.pickerOpen = true
  }
</script>

{#if draft}
  <!-- overlay — port dòng 2168. Backdrop-click does NOT close the form (avoid
       losing entered connection details); use the × button or Escape. -->
  <div
    onkeydown={(e) => e.key === 'Escape' && close()}
    role="presentation"
    class="cm-overlay"
  >
    <!-- panel — port dòng 2169 -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={isNew ? 'New connection' : draft.name}
      tabindex="-1"
      class="cm-panel"
      style="--cm-accent:{meta.accent}"
    >
      <div style="flex:1;display:flex;flex-direction:column;min-width:0;min-height:0">
        <!-- header — port dòng 2173-2181 -->
        <div class="cm-head">
          {#if isNew}
            <span
              class="cm-back"
              onclick={backToPicker}
              onkeydown={(e) => e.key === 'Enter' && backToPicker()}
              role="button"
              tabindex="0"
              title="Choose another type"
            >‹ Back</span>
          {/if}
          <span class="cm-tile"><SystemIcon system={draft.system} size={22} /></span>
          <div class="cm-titles">
            <div class="cm-title">
              <span>{isNew ? (isQuick ? 'Quick Connect' : 'New connection') : draft.name || 'Connection'}</span>
              {#if isQuick}<span class="cm-badge">one-off · not saved</span>{/if}
            </div>
            <div class="cm-subtitle">{subtitle}</div>
          </div>
          <span
            class="cm-x"
            onclick={close}
            onkeydown={(e) => e.key === 'Enter' && close()}
            role="button"
            tabindex="0"
            title="Close"
            aria-label="Close dialog"
          ><Icon name="close" size={14} /></span>
        </div>

        <!-- body — port dòng 2182-2261. The panel sizes to its content (no fixed
             height); past 90vh only this body scrolls, header/footer stay put. -->
        <div class="cm-body">
          <div class="cm-grid">
            <div class="cm-sec">General</div>
            <!-- row 1: name | environment -->
            <div>
              <div class="cm-label">Connection name</div>
              <input class="cm-input" bind:value={draft.name} placeholder={isNew ? `My ${meta.label}` : ''} use:focusName aria-label="Connection name" />
            </div>
            <div>
              <div class="cm-label">Environment</div>
              <select class="cm-input" bind:value={draft.env}>
                <option value="production">Production</option>
                <option value="staging">Staging</option>
                <option value="development">Development</option>
                <option value="local">Local</option>
              </select>
            </div>

            <div class="cm-sec">{isFileDb ? 'Database' : 'Server'}</div>
            {#if isFileDb}
              <!-- port dòng 2192-2195 -->
              <div style="grid-column:1/3">
                <div class="cm-label">Mode</div>
                <select class="cm-input" bind:value={draft.sqlite_mode}>
                  <option value="read-write">Read-Write</option>
                  <option value="read-only">Read-Only</option>
                  <option value="in-memory">In-Memory (:memory:)</option>
                </select>
              </div>
              <div class="cm-note">
                {#if isDuckdb}
                  DuckDB is an embedded analytical database (one file, or in-memory). No server required — a new file is created when the path does not exist.
                {:else}
                  SQLite is an embedded file-based database. No server required.
                {/if}
              </div>
            {/if}

            <!-- host + port — port dòng 2196-2201 (SQLite: Host = file path).
                 Kafka: Host (IP) + Port like the other systems — the backend joins
                 them into `host:port`; a full bootstrap list (host:port,host:port)
                 typed in Host is still honored (used verbatim, Port ignored). -->
            <div style="grid-column:1/3;display:grid;grid-template-columns:2fr 1fr;gap:var(--px-14)">
              <div>
                <div class="cm-label">{hostLabel}</div>
                {#if isFileDb}
                  <!-- SQLite is file-based: the path input keeps its double-click
                       shortcut, plus a visible Browse button (the double-click was
                       an invisible affordance nobody could discover). -->
                  <div style="display:flex;gap:var(--px-6)">
                    <input
                      class="cm-input mono"
                      style="flex:1;min-width:0"
                      bind:value={draft.sqlite_path}
                      placeholder={hostPlaceholder}
                      title={isDuckdb ? 'Path to the .duckdb file — double-click or use Browse…' : 'Path to the .db file — double-click or use Browse…'}
                      disabled={draft.sqlite_mode === 'in-memory'}
                      ondblclick={browseSqliteFile}
                    />
                    <span
                      onclick={() => draft?.sqlite_mode !== 'in-memory' && browseSqliteFile()}
                      onkeydown={(e) => e.key === 'Enter' && draft?.sqlite_mode !== 'in-memory' && browseSqliteFile()}
                      role="button"
                      tabindex="0"
                      title={draft.sqlite_mode === 'in-memory' ? 'In-memory database — no file' : isDuckdb ? 'Choose a DuckDB database file' : 'Choose a SQLite database file'}
                      aria-disabled={draft.sqlite_mode === 'in-memory'}
                      class="cm-browse"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>Browse…
                    </span>
                  </div>
                {:else}
                  <input class="cm-input mono" bind:value={draft.host} placeholder={hostPlaceholder} />
                {/if}
              </div>
              <div>
                <div class="cm-label">Port</div>
                {#if isFileDb}
                  <input class="cm-input mono" value="" disabled />
                {:else}
                  <input class="cm-input mono" type="number" bind:value={draft.port} />
                {/if}
              </div>
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
                <div class="cm-label">Schema Registry URL <span class="cm-opt">(optional)</span></div>
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

            {#if isElastic}
              <div style="grid-column:1/3">
                <div class="cm-label">Authentication</div>
                <select class="cm-input" value={esAuth} onchange={(e) => draft && (draft.mssql_auth = e.currentTarget.value)} aria-label="Elasticsearch authentication">
                  <option value="basic">Basic — user &amp; password</option>
                  <option value="apikey">API key</option>
                  <option value="bearer">Bearer token</option>
                  <option value="none">None (security disabled)</option>
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
                  <div class="cm-help">
                    User = <span class="mono">clientId@tenantId</span>, Password = client secret. A token is fetched from Azure AD (login.microsoftonline.com) at connect.
                  </div>
                {/if}
              </div>
            {/if}

            <!-- credentials row: [Connect by (Oracle)] · Database · User · Password —
                 one row, as many equal columns as fields this engine shows. Kept after
                 the engine-specific blocks (MSSQL auth, Kafka SASL…) that decide
                 whether User / Password appear at all. -->
            {#if showCreds}<div class="cm-sec">Credentials</div>{/if}
            <div class="cm-cred-row">
              {#if isOracle}
                <!-- Oracle connect kind (reuses mssql_auth): Service Name vs SID. -->
                <div>
                  <div class="cm-label">Connect by</div>
                  <select class="cm-input" bind:value={draft.mssql_auth}>
                    <option value="">Service Name</option>
                    <option value="sid">SID</option>
                  </select>
                </div>
              {/if}

              <!-- database — port dòng 2205-2207 (Redis: DB index 0–15; NATS/Kafka: ẩn) -->
              {#if !isNats && !isKafka && !isDuckdb && !isElastic}
                <div>
                  {#if isRedis}
                    <div class="cm-label">DB Index</div>
                    <select class="cm-input" bind:value={draft.database}>
                      {#each Array.from({ length: 16 }, (_, i) => String(i)) as n (n)}
                        <option value={n}>{n}</option>
                      {/each}
                    </select>
                  {:else if isRabbit}
                    <div class="cm-label">Virtual host</div>
                    <input class="cm-input mono" bind:value={draft.database} placeholder="/" aria-label="Virtual host" />
                  {:else if isOracle}
                    <!-- Oracle connects by service name (default) or SID; the value goes
                         in `database` and the kind is stored in `mssql_auth` (reused). -->
                    <div class="cm-label">{draft.mssql_auth === 'sid' ? 'SID' : 'Service name'}</div>
                    <input class="cm-input mono" bind:value={draft.database} placeholder={dbPlaceholder} />
                  {:else}
                    <div class="cm-label">Database</div>
                    <input class="cm-input mono" bind:value={draft.database} placeholder={dbPlaceholder} />
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
                <div>
                  <div class="cm-label">
                    {passLabel} <span class="cm-lock" title="Stored encrypted with AES-256 on this device">· AES-256 encrypted</span>
                    {#if !isNew && draft.has_password && !passwordTouched}
                      <span class="cm-opt">(saved — type to change)</span>
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
            </div>

            {#if isRabbit}
              <!-- RabbitMQ is browsed through its Management HTTP API: say which port
                   that is, since the AMQP port (5672) is the one people know. -->
              <div data-testid="rabbit-port-hint" class="cm-note">
                Port is the <span class="mono cm-code">Management HTTP API</span> (15672, or 15671 with SSL) — not the AMQP port 5672. The <span class="mono cm-code">rabbitmq_management</span> plugin must be enabled, and the user needs the <span class="mono cm-code">management</span> tag. Leave Virtual host empty for <span class="mono cm-code">/</span>.
              </div>
            {/if}
            {#if isElastic}
              <div data-testid="es-port-hint" class="cm-note">
                Port is the <span class="mono cm-code">REST API</span> (9200) — not the transport port 9300 or Kibana (5601). Elasticsearch 8 serves HTTPS by default: turn on <b>SSL</b> and set its CA certificate (<span class="mono cm-code">http_ca.crt</span>). For Elastic Cloud paste the endpoint URL as Host. An API key may be the encoded value or <span class="mono cm-code">id:api_key</span>.
              </div>
            {/if}
            {#if authWindows}
              <!-- port dòng 2218-2220 -->
              <div class="cm-note">
                Connecting as <span class="mono cm-code">{draft.user || 'current user'}</span> · current Windows session (Integrated Security=SSPI)
              </div>
            {/if}
          </div>

          <!-- SSH / SSL toggles — port dòng 2225-2228 -->
          <div class="cm-sec cm-sec-free">Security</div>
          <div class="cm-toggles">
            <div
              class="cm-toggle"
              class:on={draft.ssh.enabled}
              onclick={() => draft && (draft.ssh.enabled = !draft.ssh.enabled)}
              onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), draft && (draft.ssh.enabled = !draft.ssh.enabled))}
              role="switch"
              aria-checked={draft.ssh.enabled}
              aria-label="SSH Tunnel"
              tabindex="0"
            >
              <span class="cm-toggle-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6"></path><path d="M12 19h8"></path></svg></span>
              <span class="cm-toggle-text"><b>SSH Tunnel</b><span>Reach the server through a bastion host</span></span>
              <span class="cm-switch" aria-hidden="true"><span></span></span>
            </div>
            <div
              class="cm-toggle"
              class:on={draft.ssl}
              onclick={() => draft && (draft.ssl = !draft.ssl)}
              onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), draft && (draft.ssl = !draft.ssl))}
              role="switch"
              aria-checked={draft.ssl}
              aria-label="SSL/TLS"
              tabindex="0"
            >
              <span class="cm-toggle-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg></span>
              <span class="cm-toggle-text"><b>SSL/TLS</b><span>Encrypt the traffic to the server</span></span>
              <span class="cm-switch" aria-hidden="true"><span></span></span>
            </div>
          </div>

          {#if draft.ssh.enabled}
            <!-- SSH panel — port dòng 2229-2260 -->
            <div class="cm-subpanel">
              <div style="display:grid;grid-template-columns:2fr 1fr;gap:var(--px-14);margin-bottom:var(--px-14)">
                <div>
                  <div class="cm-label">SSH Host</div>
                  <input class="cm-input mono" bind:value={draft.ssh.host} />
                </div>
                <div>
                  <div class="cm-label">SSH Port</div>
                  <input class="cm-input mono" type="number" bind:value={draft.ssh.port} />
                </div>
              </div>
              <div class="cm-label">Authentication</div>
              <div class="ds-seg cm-ssh-seg" role="group" aria-label="SSH authentication">
                <span
                  onclick={() => draft && (draft.ssh.auth = 'password')}
                  onkeydown={(e) => e.key === 'Enter' && draft && (draft.ssh.auth = 'password')}
                  role="button"
                  tabindex="0"
                  aria-pressed={sshMode === 'password'}
                >Username / Password</span>
                <span
                  onclick={() => draft && (draft.ssh.auth = 'key')}
                  onkeydown={(e) => e.key === 'Enter' && draft && (draft.ssh.auth = 'key')}
                  role="button"
                  tabindex="0"
                  aria-pressed={sshMode === 'key'}
                >Private Key</span>
              </div>
              {#if sshMode === 'password'}
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-14)">
                  <div>
                    <div class="cm-label">SSH Username</div>
                    <input class="cm-input mono" bind:value={draft.ssh.user} />
                  </div>
                  <div>
                    <div class="cm-label">SSH Password</div>
                    <input
                      class="cm-input mono"
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
                    <input class="cm-input mono" bind:value={draft.ssh.user} />
                  </div>
                  <div>
                    <div class="cm-label">Passphrase <span class="cm-opt">(optional)</span></div>
                    <input class="cm-input mono" type="password" disabled title="Passphrase-protected key: phase sau" />
                  </div>
                  <div style="grid-column:1/3">
                    <div class="cm-label">Private Key File</div>
                    <div style="display:flex;gap:var(--px-8)">
                      <input
                        class="cm-input mono"
                        style="flex:1;min-width:0"
                        bind:value={draft.ssh.key_path}
                        placeholder="~/.ssh/id_rsa"
                      />
                      <span
                        onclick={browseSshKey}
                        onkeydown={(e) => e.key === 'Enter' && browseSshKey()}
                        role="button"
                        tabindex="0"
                        class="cm-browse"
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
            <div class="cm-subpanel">
              <div class="cm-label">TLS Certificates <span class="cm-opt">(optional — leave blank for system CA)</span></div>
              <div style="display:grid;gap:var(--px-10);margin-top:var(--px-6)">
                {#each certFields as cf (cf.field)}
                  <div>
                    <div class="cm-label">{cf.label}</div>
                    <div style="display:flex;gap:var(--px-8)">
                      <input class="cm-input mono" style="flex:1;min-width:0" bind:value={draft[cf.field]} placeholder={cf.placeholder} />
                      <span
                        onclick={() => browseCert(cf.field)}
                        onkeydown={(e) => e.key === 'Enter' && browseCert(cf.field)}
                        role="button"
                        tabindex="0"
                        class="cm-browse"
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
        <div class="cm-foot">
          {#if testing}
            <span class="cm-result busy"><Icon name="refresh" size={12} />Testing the connection…</span>
          {:else if testResult?.ok}
            <span class="cm-result ok"><span>✓</span>Connection successful · {testResult.latency_ms} ms</span>
          {:else if testResult}
            <span class="cm-result bad" title={testResult.error}><span>✗</span><span class="cm-result-msg">{testResult.error}</span></span>
          {:else}
            <span class="cm-foot-hint">Test first to check the details — nothing is saved until you connect.</span>
          {/if}
          <div class="cm-foot-actions">
            <span
              onclick={runTest}
              onkeydown={(e) => e.key === 'Enter' && runTest()}
              role="button"
              tabindex="0"
              class="cfm-btn"
              aria-busy={testing}
            >{testing ? 'Testing…' : 'Test connection'}</span>
            <span
              onclick={close}
              onkeydown={(e) => e.key === 'Enter' && close()}
              role="button"
              tabindex="0"
              title="Close this dialog"
              class="cfm-btn"
            >Close</span>
            {#if isQuick}
              <span
                onclick={connectQuick}
                onkeydown={(e) => e.key === 'Enter' && connectQuick()}
                role="button"
                tabindex="0"
                class="cfm-btn primary cm-go"
              >{saving ? 'Connecting…' : 'Connect'}</span>
            {:else}
              <span
                onclick={save}
                onkeydown={(e) => e.key === 'Enter' && save()}
                role="button"
                tabindex="0"
                class="cfm-btn primary cm-go"
              >{saving ? 'Connecting…' : 'Connect'}</span>
            {/if}
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ---- shell ---------------------------------------------------------- */
  .cm-overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--rgba-0-0-0-_5);
    backdrop-filter: blur(var(--px-2));
  }
  /* The panel sizes to its content (no fixed height); past 90vh only the body
     scrolls, header and footer stay put. */
  .cm-panel {
    width: var(--px-840);
    max-width: 94vw;
    max-height: 90vh;
    display: flex;
    overflow: hidden;
    background: var(--surface);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-14);
    box-shadow: var(--shadow-lg);
  }

  /* ---- header: engine tile · title + one plain sentence · close -------- */
  .cm-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-14) var(--px-20);
    border-bottom: var(--px-1) solid var(--border);
    background: linear-gradient(180deg, color-mix(in srgb, var(--cm-accent) 7%, transparent), transparent);
  }
  .cm-back {
    display: inline-flex;
    align-items: center;
    height: var(--px-28);
    padding: 0 var(--px-10);
    border-radius: var(--px-7);
    font-size: var(--px-12);
    font-weight: 500;
    color: var(--text2);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
    cursor: pointer;
  }
  .cm-back:hover {
    color: var(--text);
    border-color: var(--border2);
  }
  .cm-tile {
    flex: none;
    width: var(--px-40);
    height: var(--px-40);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-10);
    background: color-mix(in srgb, var(--cm-accent) 14%, var(--surface));
    border: var(--px-1) solid color-mix(in srgb, var(--cm-accent) 30%, transparent);
  }
  .cm-titles {
    min-width: 0;
    flex: 1;
  }
  .cm-title {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    font-size: var(--px-16);
    font-weight: 650;
    color: var(--text);
    line-height: 1.25;
  }
  .cm-subtitle {
    margin-top: var(--px-2);
    font-size: var(--px-12_5);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cm-badge {
    font-size: var(--px-11);
    font-weight: 500;
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-20);
    padding: var(--px-2) var(--px-8);
  }
  .cm-x {
    flex: none;
    width: var(--px-28);
    height: var(--px-28);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-7);
    color: var(--muted);
    cursor: pointer;
  }
  .cm-x:hover {
    color: var(--text);
    background: var(--hover);
  }

  /* ---- body ------------------------------------------------------------ */
  .cm-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: var(--px-4) var(--px-20) var(--px-18);
  }
  .cm-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--px-12) var(--px-14);
  }
  /* section caption: a quiet heading with a hairline, so the form reads as
     General → Server → Credentials → Security instead of one wall of boxes */
  .cm-sec {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: var(--px-10);
    margin: var(--px-8) 0 calc(var(--px-4) * -1);
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
  }
  .cm-sec::after {
    content: '';
    flex: 1;
    height: var(--px-1);
    background: var(--border);
  }
  .cm-sec-free {
    margin: var(--px-18) 0 var(--px-10);
  }

  /* Database · User · Password on one row: one equal column per visible field,
     inputs aligned on the bottom edge even when a label wraps. */
  .cm-cred-row {
    grid-column: 1 / -1;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: var(--px-14);
    align-items: end;
  }
  .cm-label {
    font-size: var(--px-12);
    color: var(--text2);
    margin-bottom: var(--px-5);
    font-weight: 500;
  }
  .cm-opt {
    color: var(--muted);
    font-weight: 400;
  }
  .cm-lock {
    color: var(--sacc-green);
    font-weight: 500;
  }
  .cm-help {
    margin-top: var(--px-6);
    font-size: var(--px-12);
    color: var(--muted);
    line-height: 1.45;
  }
  .cm-input {
    width: 100%;
    height: var(--px-38);
    background: var(--bg);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    padding: 0 var(--px-12);
    font-size: var(--px-13);
    color: var(--text);
    outline: none;
    font-family: inherit;
    transition: border-color 0.12s, box-shadow 0.12s, background 0.12s;
  }
  /* light: a white field reads as editable; the page grey made it look disabled */
  :global(:root:not(.dark)) .cm-input:not(:disabled) {
    background: var(--surface);
  }
  .cm-input::placeholder {
    color: var(--muted);
  }
  .cm-input:hover:not(:disabled):not(:focus) {
    border-color: color-mix(in srgb, var(--primary) 35%, var(--border2));
  }
  .cm-input:focus {
    border-color: var(--primary);
    background: var(--surface);
    box-shadow: 0 0 0 var(--px-3) var(--ring-soft);
  }
  .cm-input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  select.cm-input {
    cursor: pointer;
  }
  .cm-note {
    grid-column: 1 / -1;
    font-size: var(--px-12);
    line-height: 1.5;
    color: var(--text2);
    background: color-mix(in srgb, var(--primary) 6%, var(--panel));
    border: var(--px-1) solid color-mix(in srgb, var(--primary) 18%, var(--border));
    border-radius: var(--px-8);
    padding: var(--px-10) var(--px-12);
  }
  .cm-code {
    color: var(--text);
  }
  .cm-browse {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    height: var(--px-38);
    padding: 0 var(--px-14);
    border-radius: var(--px-8);
    font-size: var(--px-12_5);
    font-weight: 500;
    color: var(--text);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    box-shadow: var(--shadow-xs);
    cursor: pointer;
  }
  .cm-browse:hover:not([aria-disabled='true']) {
    border-color: var(--primary);
    color: var(--primary);
  }
  .cm-browse[aria-disabled='true'] {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ---- security: two option cards with a real switch ------------------- */
  .cm-toggles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--px-12);
  }
  .cm-toggle {
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-10) var(--px-14);
    border-radius: var(--px-10);
    border: var(--px-1) solid var(--border);
    background: var(--surface);
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s, box-shadow 0.12s;
  }
  .cm-toggle:hover {
    border-color: var(--border2);
    box-shadow: var(--shadow-sm);
  }
  .cm-toggle.on {
    border-color: color-mix(in srgb, var(--primary) 55%, transparent);
    background: color-mix(in srgb, var(--primary) 6%, var(--surface));
  }
  .cm-toggle-icon {
    flex: none;
    width: var(--px-34);
    height: var(--px-34);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-8);
    color: var(--text2);
    background: var(--panel);
  }
  .cm-toggle.on .cm-toggle-icon {
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 14%, transparent);
  }
  .cm-toggle-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
  }
  .cm-toggle-text b {
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
  }
  .cm-toggle-text span {
    font-size: var(--px-12);
    color: var(--muted);
  }
  .cm-switch {
    flex: none;
    position: relative;
    width: var(--px-34);
    height: var(--px-20);
    border-radius: var(--px-20);
    background: var(--border2);
    transition: background 0.15s;
  }
  .cm-switch > span {
    position: absolute;
    top: var(--px-3);
    left: var(--px-3);
    width: var(--px-14);
    height: var(--px-14);
    border-radius: 50%;
    background: var(--hex-fff);
    box-shadow: var(--shadow-xs);
    transition: transform 0.15s;
  }
  .cm-toggle.on .cm-switch {
    background: var(--primary);
  }
  .cm-toggle.on .cm-switch > span {
    transform: translateX(var(--px-14));
  }
  .cm-subpanel {
    margin-top: var(--px-12);
    padding: var(--px-16);
    border-radius: var(--px-10);
    border: var(--px-1) solid var(--border);
    background: var(--panel);
  }
  .cm-subpanel .cm-input {
    background: var(--surface);
  }
  .cm-ssh-seg {
    margin-bottom: var(--px-14);
  }

  /* ---- footer ---------------------------------------------------------- */
  .cm-foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-14) var(--px-20);
    border-top: var(--px-1) solid var(--border);
    background: var(--panel);
  }
  .cm-foot-hint {
    font-size: var(--px-12);
    color: var(--muted);
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cm-result {
    display: inline-flex;
    align-items: center;
    gap: var(--px-7);
    min-width: 0;
    padding: var(--px-5) var(--px-10);
    border-radius: var(--px-20);
    font-size: var(--px-12_5);
    font-weight: 600;
  }
  .cm-result.ok {
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--sacc-green) 12%, transparent);
  }
  .cm-result.bad {
    color: var(--danger-text);
    background: var(--danger-soft);
  }
  .cm-result.busy {
    color: var(--text2);
    background: var(--hover);
  }
  .cm-result-msg {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cm-foot-actions {
    margin-left: auto;
    flex: none;
    display: flex;
    gap: var(--px-8);
  }
  .cm-go {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--px-96);
  }
</style>
