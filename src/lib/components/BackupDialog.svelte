<script lang="ts">
  // Backup & Restore — one dialog for every engine (see commands/backup.rs for
  // how each one runs). Two tabs:
  //   Backup  — method card (tool found / server-side / built-in), the database,
  //             format + options, destination, then a progress bar with Stop.
  //   Restore — source file, target database, options, and what it overwrites.
  // The backdrop never closes it (rule for form dialogs); Escape/× do. Pressing
  // Back up / Restore hands the job to backupJobs and closes the dialog: the job
  // runs on outside it, in its own progress window (BackupProgressWindow.svelte).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { backupWizard, type BackupTab } from '$lib/stores/backup.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import SearchSelect from '$lib/components/SearchSelect.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { brandKey, brandMeta, hasFlavors } from '$lib/brand'
  import '$lib/components/workspace/users/um.css'
  import { backupJobs } from '$lib/stores/backupJobs.svelte'
  import {
    baseConnectionId,
    databaseLabel,
    defaultFileName,
    describeBackupFile,
    fileFilters,
    fileName,
    folderOf,
    formatsFor,
    hasContentChoice,
    joinPath,
    loadToolDir,
    restoreImpact,
    restoreToggles,
    saveToolDir,
    sizeLabel,
    targetNoun,
    withExtension,
  } from '$lib/backup/plan'

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = backupWizard.open
  })

  // ---- target --------------------------------------------------------------
  let connId = $state('')
  let system = $state('')
  let tab = $state<BackupTab>('backup')
  let database = $state('')
  let databases = $state<string[]>([])
  let plan = $state<ipc.BackupPlan | null>(null)
  let planLoading = $state(false)
  let planError = $state('')
  let toolDir = $state('')
  let toolDirDraft = $state('')
  let showToolDir = $state(false)

  const base = $derived(baseConnectionId(connId))
  const profile = $derived(connections.byId(base))
  // ScyllaDB / Valkey connections wear their own brand (same engine and backup path)
  const brand = $derived(hasFlavors(system) ? brandKey(profile ?? { system }) : system)
  const meta = $derived(brandMeta(brand))
  const noun = $derived(targetNoun(system))
  const isOracle = $derived(system === 'oracle')
  const fileless = $derived(system === 'sqlite' || system === 'duckdb')
  const formats = $derived(formatsFor(system))
  const production = $derived(profile?.env === 'production')
  const dbShown = $derived(isOracle ? (profile?.user ?? database) : databaseLabel(system, database))

  // Searchable pickers (a server can hold hundreds of databases).
  const backupDbOptions = $derived([
    ...databases.map((d) => ({ value: d, label: databaseLabel(system, d) })),
    ...(system === 'mongodb' ? [{ value: '', label: 'All databases' }] : []),
  ])
  const restoreDbOptions = $derived([
    ...databases.map((d) => ({ value: d, label: databaseLabel(system, d) })),
    ...(system === 'mongodb' ? [{ value: '', label: 'Databases in the archive' }] : []),
  ])
  const diskOptions = $derived((plan?.disks.length ? plan.disks : ['backups']).map((d) => ({ value: d, label: d })))

  /** What a backup contains — named by what you get, not by tool flags. */
  const CONTENTS = [
    { id: 'schema', title: 'Structure only', desc: 'Definitions only (tables, views, indexes, routines) — no rows. Set up an empty copy.', icon: 'columns' },
    { id: 'all', title: 'Structure and data', desc: 'Tables, views, routines and every row — a complete copy.', icon: 'database' },
    { id: 'data', title: 'Data only', desc: 'Rows only — restore into a database that already has the tables.', icon: 'rows' },
  ] as const
  function formatIcon(id: string): 'code' | 'archive' | 'server' | 'download' | 'database' {
    if (id === 'plain' || id === 'sql' || id === 'cql') return 'code'
    if (id === 'bak' || id === 'zip') return 'server'
    if (id === 'bacpac') return 'download'
    if (id === 'db' || id === 'duckdb') return 'database'
    return 'archive'
  }

  // ---- backup form ---------------------------------------------------------
  let format = $state('')
  let content = $state<'all' | 'schema' | 'data'>('schema')
  let clean = $state(false)
  let owner = $state(true)
  let copyOnly = $state(true)
  let compression = $state(false)
  let disk = $state('')
  let dest = $state('')
  /** One sentence above the button: exactly what "Back up" will do. */
  const backupSummary = $derived.by(() => {
    const what = hasContentChoice(system) ? CONTENTS.find((c) => c.id === content)?.title.toLowerCase() : ''
    // SQL Server's two choices already say where the file goes — the sentence says it too
    const fmt = system === 'mssql' ? '' : (formats.find((f) => f.id === format)?.label ?? formats[0]?.label ?? '')
    const file = system === 'clickhouse' ? `${dest || '…'} on disk ${disk || 'backups'}` : fileName(dest) || '…'
    return { target: dbShown || (system === 'mongodb' ? 'all databases' : 'the database'), what, fmt, file }
  })

  // ---- restore form --------------------------------------------------------
  let src = $state('')
  let restoreDb = $state('')
  let rClean = $state(false)
  let rSingle = $state(false)
  let asDatabase = $state('')
  /** SQL Server: restore a .bak on the server, or a .bacpac from this computer. */
  let rSource = $state<'server' | 'local'>('server')

  // SQL Server .bacpac (SqlPackage): a file on THIS computer, unlike the .bak
  const bacpac = $derived(system === 'mssql' && (tab === 'restore' ? rSource === 'local' : format === 'bacpac'))
  const serverSide = $derived(!!plan?.server_side && !bacpac)
  const toolMode = $derived(plan?.method === 'tool' || bacpac)
  const viewReady = $derived(
    !!plan && (bacpac ? plan.connected && !!plan.backup_tool?.found : tab === 'backup' ? plan.backup_ready : plan.restore_ready),
  )

  // ---- job ---------------------------------------------------------------
  // A job of this connection already running (outside the dialog) blocks a second.
  const busy = $derived(backupJobs.activeFor(baseConnectionId(connId)))

  let seenNonce = -1
  $effect(() => {
    const n = backupWizard.nonce
    if (dlgOpen && n !== seenNonce) {
      seenNonce = n
      untrack(() => void init())
    }
  })

  async function init() {
    connId = backupWizard.connId ?? ''
    system = backupWizard.system
    tab = backupWizard.tab
    database = backupWizard.database || ''
    src = backupWizard.src
    asDatabase = ''
    rSource = 'server'
    rClean = false
    rSingle = false
    content = 'schema'
    // mysqldump adds DROP TABLE by default; pg_dump does not.
    clean = system === 'mysql' || system === 'mariadb'
    owner = true
    copyOnly = true
    compression = false
    format = formatsFor(system)[0]?.id ?? ''
    toolDir = loadToolDir(system)
    toolDirDraft = toolDir
    showToolDir = false
    plan = null
    databases = []
    await loadPlan()
    // (TS narrowed `plan` to null above; loadPlan has set it since.)
    const loaded = plan as ipc.BackupPlan | null
    if (!database && loaded) database = loaded.database
    restoreDb = database
    dest = suggestedDest()
    void loadDatabases()
  }

  async function loadPlan() {
    if (!connId) return
    planLoading = true
    planError = ''
    try {
      plan = await ipc.backupPlan(connId, isOracle ? undefined : database || undefined, toolDir || undefined)
      if (plan.disks.length && !disk) disk = plan.disks.includes('backups') ? 'backups' : plan.disks[0]
    } catch (e) {
      planError = String(e)
    } finally {
      planLoading = false
    }
  }

  async function loadDatabases() {
    let list: string[] = []
    try {
      if (['postgres', 'mssql', 'mongodb', 'duckdb'].includes(system)) list = (await ipc.listDatabases(base)).map((d) => d.name)
      else if (['mysql', 'mariadb', 'clickhouse'].includes(system)) list = (await ipc.listSchemas(base)).map((s) => s.name)
      else if (system === 'cassandra') list = await ipc.cassandraKeyspaces(base)
      else if (system === 'redis') {
        const n = await ipc.redisDatabaseCount(base)
        list = Array.from({ length: Math.max(1, n) }, (_, i) => String(i))
      }
    } catch {
      list = []
    }
    const cur = system === 'redis' ? database.replace(/^db/, '') : database
    if (system === 'redis' && cur !== database) database = cur
    if (cur && !list.includes(cur)) list.unshift(cur)
    databases = list
    if (!restoreDb) restoreDb = database
  }

  function suggestedDest(): string {
    const name = defaultFileName(system, isOracle ? (profile?.user ?? 'schema') : database || (profile?.name ?? system), format)
    if (system === 'clickhouse') return name
    return joinPath((bacpac ? plan?.local_dir : plan?.default_dir) ?? '', name)
  }

  function pickDatabase(v: string) {
    if (v === database) return
    const auto = dest === '' || fileName(dest) === fileName(suggestedDest())
    database = v
    if (!restoreDb || restoreDb !== v) restoreDb = v
    void loadPlan().then(() => {
      if (auto) dest = suggestedDest()
    })
  }

  function pickFormat(id: string) {
    format = id
    // SQL Server: .bak goes to the server's folder, .bacpac to this computer
    if (system === 'mssql') dest = suggestedDest()
    else if (dest) dest = withExtension(dest, system, id)
  }

  function pickSource(id: 'server' | 'local') {
    if (rSource === id) return
    rSource = id
    src = ''
  }

  // ---- files ----------------------------------------------------------------
  async function browseDest() {
    if (!IS_TAURI) return
    const { save } = await import('@tauri-apps/plugin-dialog')
    const p = await save({ defaultPath: dest || undefined, filters: fileFilters(system, 'backup') })
    if (p) dest = p
  }

  async function browseSrc() {
    if (!IS_TAURI) return
    const { open } = await import('@tauri-apps/plugin-dialog')
    const p = await open({
      multiple: false,
      directory: false,
      defaultPath: folderOf(src) || plan?.default_dir || undefined,
      filters: fileFilters(system, 'restore'),
    })
    if (typeof p === 'string') src = p
  }

  async function browseToolDir() {
    if (!IS_TAURI) return
    const { open } = await import('@tauri-apps/plugin-dialog')
    const p = await open({ multiple: false, directory: true, defaultPath: toolDirDraft || undefined })
    if (typeof p === 'string') toolDirDraft = p
  }

  async function applyToolDir() {
    toolDir = toolDirDraft.trim()
    saveToolDir(system, toolDir)
    await loadPlan()
    if (plan?.backup_ready || plan?.restore_ready) showToolDir = false
  }

  // ---- run -----------------------------------------------------------------
  /** DuckDB backs up the database its connection sits in — attach the picked one. */
  async function execConn(db: string): Promise<string> {
    if (system === 'duckdb' && db && plan && db !== plan.database) {
      return ipc.attachDatabase(base, db)
    }
    return connId
  }

  const backupBlocked = $derived(
    !plan || !viewReady || !dest.trim() || !!busy || planLoading,
  )

  async function runBackup() {
    if (backupBlocked || !plan) return
    // everything the job needs, read now: the dialog closes (and may be re-opened
    // on another connection) while it runs
    const target = isOracle ? '' : database
    const sys = system
    const path = dest.trim()
    const shown = dbShown
    const db = database
    const options: ipc.BackupOptions = {
      database: target || undefined,
      format: format || undefined,
      content: hasContentChoice(sys) ? content : undefined,
      clean: sys === 'postgres' || sys === 'mysql' || sys === 'mariadb' ? clean : undefined,
      owner: sys === 'postgres' ? owner : undefined,
      copyOnly: sys === 'mssql' ? copyOnly : undefined,
      compression: sys === 'mssql' ? compression : undefined,
      disk: sys === 'clickhouse' ? disk : undefined,
      toolDir: toolDir || undefined,
    }
    const conn = execConn(target)
    backupJobs.start({
      kind: 'backup',
      system: sys,
      connId: base,
      connName: profile?.name ?? '',
      target: shown,
      canStop: true,
      restoreFrom: (o) => ({ path: sys === 'clickhouse' ? fileName(path) : o.path, database: db }),
      run: async (jobId, onProgress) => ipc.backupDatabase(await conn, path, { ...options, jobId }, onProgress),
    })
    backupWizard.close()
  }

  function restoreTarget(): string {
    if ((system === 'clickhouse' || bacpac) && asDatabase.trim()) return asDatabase.trim()
    return restoreDb || database
  }
  const restoreBlocked = $derived(!plan || !viewReady || !src.trim() || !!busy)

  async function runRestore() {
    if (restoreBlocked || !plan) return
    const target = isOracle ? '' : restoreDb || database
    const sys = system
    const owner = base
    const path = src.trim()
    const shown = databaseLabel(sys, restoreTarget())
    const options: ipc.BackupOptions = {
      database: target || undefined,
      clean: restoreToggles(sys, bacpac).some((t) => t.key === 'clean') ? rClean : undefined,
      format: bacpac ? 'bacpac' : undefined,
      singleTransaction: sys === 'postgres' ? rSingle : undefined,
      asDatabase: (sys === 'clickhouse' || bacpac) && asDatabase.trim() ? asDatabase.trim() : undefined,
      disk: sys === 'clickhouse' ? disk : undefined,
      toolDir: toolDir || undefined,
    }
    const conn = execConn(target)
    backupJobs.start({
      kind: 'restore',
      system: sys,
      connId: base,
      connName: profile?.name ?? '',
      target: shown,
      // a SQL Server RESTORE cannot be stopped safely once it starts
      canStop: !(sys === 'mssql' && !bacpac),
      run: async (jobId, onProgress) => ipc.restoreDatabase(await conn, path, { ...options, jobId }, onProgress),
      onDone: () => {
        // What the Explorer shows for this connection is stale now.
        explorer.invalidate(owner)
        explorer.bumpReload(owner)
        if (sys === 'redis') explorer.bumpRedis(owner)
      },
    })
    backupWizard.close()
  }

  function close() {
    backupWizard.close()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }

  /** Where this engine's client tools usually live — a hint, not a default. */
  function toolDirExample(sys: string): string {
    const win = typeof navigator === 'undefined' || /Win/i.test(navigator.platform)
    const ex: Record<string, [string, string]> = {
      postgres: ['C:\\Program Files\\PostgreSQL\\16\\bin', '/opt/homebrew/opt/libpq/bin'],
      mysql: ['C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin', '/opt/homebrew/opt/mysql-client/bin'],
      mariadb: ['C:\\Program Files\\MariaDB 11.4\\bin', '/usr/local/bin'],
      mongodb: ['C:\\Program Files\\MongoDB\\Tools\\100\\bin', '/opt/homebrew/bin'],
      oracle: ['C:\\oracle\\instantclient_23_0', '/opt/oracle/instantclient'],
    }
    const e = ex[sys]
    return e ? `e.g. ${win ? e[0] : e[1]}` : ''
  }
  const missingTool = $derived(
    !!plan && !!plan.install_hint && (bacpac ? !plan.backup_tool?.found : plan.method === 'tool' && !plan.server_side && (!plan.backup_ready || !plan.restore_ready)),
  )
</script>

{#if dlgOpen}
  <!-- backdrop does NOT close (form dialog rule) — × / Escape / Close do -->
  <div class="um-backdrop" role="presentation" onkeydown={onKey}>
    <div class="um-dlg bk-dlg" role="dialog" aria-modal="true" aria-label="Backup & Restore" tabindex="-1" onkeydown={onKey}>
      <div class="um-dlg-head">
        <span class="um-dlg-icon plain"><SystemIcon system={brand} size={20} /></span>
        <div class="um-dlg-title">
          <b>Backup &amp; Restore</b>
          <span title={`${profile?.name ?? ''} · ${dbShown}`}>{profile?.name ?? meta.label}{dbShown ? ` · ${dbShown}` : ''}</span>
        </div>
        <span class="um-dlg-x" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0" aria-label="Close dialog" title="Close"><Icon name="close" size={16} /></span>
      </div>

      <div class="bk-tabs" role="tablist" aria-label="Backup & Restore">
        {#each [['backup', 'Backup', 'download'], ['restore', 'Restore', 'upload']] as const as [id, label, icon] (id)}
          <span
            role="tab"
            tabindex="0"
            class="bk-tab"
            aria-selected={tab === id}
            onclick={() => (tab = id)}
            onkeydown={(e) => e.key === 'Enter' && (tab = id)}
          ><Icon name={icon} size={14} /> {label}</span>
        {/each}
      </div>

      <div class="um-dlg-body bk-body">
        {#if planLoading && !plan}
          <div class="bk-muted"><span class="um-spin bk-ico"><Icon name="refresh" size={13} /></span> Checking what this connection can do…</div>
        {:else if planError}
          <div class="um-err" role="alert"><Icon name="warning" size={14} /><span>{planError}</span></div>
        {:else if plan && plan.method === 'unsupported'}
          <div class="um-callout" style="margin:0"><Icon name="info" size={15} /><span>{meta.label} has no database backup here. Use the engine's own tooling.</span></div>
        {:else if plan}
          <!-- method card -->
          <div class="bk-method" data-ready={viewReady}>
            <span class="bk-method-ico"><Icon name={serverSide ? 'server' : toolMode ? 'archive' : 'database'} size={18} /></span>
            <div class="bk-method-text">
              <b>
                {#if toolMode && !serverSide}
                  {tab === 'backup' ? (plan.backup_tool?.version ?? plan.method_label) : (plan.restore_tools.filter((t) => t.found).map((t) => t.version ?? t.name).join(' · ') || plan.restore_tools.map((t) => t.name).join(' / '))}
                {:else}
                  {plan.method_label}
                {/if}
              </b>
              <span>
                {#if toolMode && !serverSide}
                  {@const t = tab === 'backup' ? plan.backup_tool : plan.restore_tools.find((x) => x.found)}
                  {@const p = t?.path}
                  {#if p && t?.bundled}
                    <span class="bk-bundled" title={p}><Icon name="check" size={12} /> Included with Database Studio — nothing to install</span>
                  {:else if p}<span class="mono" title={p}>{p}</span>{:else}Client tool not found on this computer{/if}
                {:else if serverSide}
                  Runs on the database server — the file path is on the server's disk, not on this computer.
                {:else if plan.method === 'built-in'}
                  Built into Database Studio — nothing to install. The file is saved on this computer.
                {:else}
                  Runs inside the app through the open connection.
                {/if}
              </span>
            </div>
            {#if viewReady}
              <span class="bk-chip ok"><Icon name="check" size={12} /> Ready</span>
            {:else if plan.needs_connection && !plan.connected}
              <span class="bk-chip warn">Connection closed</span>
            {:else}
              <span class="bk-chip warn">Not ready</span>
            {/if}
            {#if toolMode && !serverSide}
              <span class="bk-link" onclick={() => (showToolDir = !showToolDir)} onkeydown={(e) => e.key === 'Enter' && (showToolDir = !showToolDir)} role="button" tabindex="0" title="Use client tools from another folder">Locate…</span>
            {/if}
          </div>

          {#if missingTool || showToolDir}
            <div class="bk-locate">
              {#if missingTool && plan.install_hint}
                <div class="um-callout warn" style="margin:0"><Icon name="warning" size={15} /><span>{plan.install_hint}</span></div>
              {/if}
              <label class="um-field">
                <span>Client tools folder</span>
                <span class="bk-row">
                  <input class="um-input mono" bind:value={toolDirDraft} placeholder={toolDirExample(system)} spellcheck="false" aria-label="Client tools folder" onkeydown={(e) => e.key === 'Enter' && void applyToolDir()} />
                  {#if IS_TAURI}<span class="cfm-btn" onclick={browseToolDir} onkeydown={(e) => e.key === 'Enter' && void browseToolDir()} role="button" tabindex="0"><Icon name="folder" size={13} /> Browse…</span>{/if}
                  <span class="cfm-btn" onclick={applyToolDir} onkeydown={(e) => e.key === 'Enter' && void applyToolDir()} role="button" tabindex="0"><Icon name="refresh" size={13} /> Check again</span>
                </span>
                <span class="um-field-hint">Leave empty to search PATH and the usual install folders (PostgreSQL, pgAdmin, MySQL, MariaDB, MongoDB Tools…). Remembered for this engine.</span>
              </label>
            </div>
          {/if}

          {#each plan.warnings as w (w)}
            <div class="um-callout" style="margin:0"><Icon name="info" size={15} /><span>{w}</span></div>
          {/each}

          {#if tab === 'backup'}
            <div class="um-group">
              <div class="um-group-title">Source</div>
              {#if isOracle}
                <div class="bk-kv"><span>Schema</span><b class="mono">{profile?.user}</b><span class="bk-muted">Data Pump exports the schema of the connected user.</span></div>
              {:else if fileless && system === 'sqlite'}
                <div class="bk-kv"><span>Database file</span><b class="mono" title={profile?.sqlite_path}>{fileName(profile?.sqlite_path ?? '') || ':memory:'}</b></div>
              {:else}
                <div class="um-field">
                  <span>{noun[0].toUpperCase() + noun.slice(1)}</span>
                  <SearchSelect value={database} options={backupDbOptions} legible wide ariaLabel="Database to back up" placeholder={`Search ${noun}s…`} onChange={(v) => pickDatabase(v ?? '')} />
                  {#if databases.length > 8}<span class="um-field-hint">{databases.length} {noun}s on this connection — type to search.</span>{/if}
                </div>
              {/if}
            </div>

            {#if hasContentChoice(system)}
              <div class="um-group">
                <div class="um-group-title">What to include</div>
                <div class="bk-contents" role="radiogroup" aria-label="What to include">
                  {#each CONTENTS as c (c.id)}
                    <span class="bk-content" role="radio" tabindex="0" aria-checked={content === c.id} onclick={() => (content = c.id)} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (content = c.id)}>
                      <span class="bk-content-head">
                        <span class="bk-content-ico" aria-hidden="true"><Icon name={c.icon} size={16} /></span>
                        <span class="bk-radio" aria-hidden="true"></span>
                      </span>
                      <b>{c.title}</b>
                      <span>{c.desc}</span>
                    </span>
                  {/each}
                </div>
              </div>
            {/if}

            <div class="um-group">
              <div class="um-group-title">{formats.length > 1 ? 'Format & options' : 'Options'}</div>
              {#if formats.length > 1}
                <div class="bk-formats" role="radiogroup" aria-label="Format">
                  {#each formats as f (f.id)}
                    <span class="bk-format" role="radio" tabindex="0" aria-checked={format === f.id} onclick={() => pickFormat(f.id)} onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && pickFormat(f.id)}>
                      <span class="bk-format-ico" aria-hidden="true"><Icon name={formatIcon(f.id)} size={15} /></span>
                      <span class="bk-format-text"><b>{f.label}</b><span>{f.desc}</span></span>
                    </span>
                  {/each}
                </div>
              {:else if formats[0]}
                <div class="bk-kv"><span>Format</span><b>{formats[0].label}</b><span class="bk-muted">{formats[0].desc}</span></div>
              {/if}

              <div class="um-toggles">
                {#if system === 'postgres'}
                  <label class="um-toggle"><span class="um-toggle-text"><span>Add DROP statements</span><span>Restoring then replaces existing objects (DROP … IF EXISTS before each CREATE).</span></span><input type="checkbox" class="um-switch" bind:checked={clean} disabled={content === 'data'} /></label>
                  <label class="um-toggle"><span class="um-toggle-text"><span>Include ownership &amp; privileges</span><span>Turn off to restore into a server where the original roles do not exist.</span></span><input type="checkbox" class="um-switch" bind:checked={owner} /></label>
                {:else if system === 'mysql' || system === 'mariadb'}
                  <label class="um-toggle"><span class="um-toggle-text"><span>Add DROP TABLE statements</span><span>Restoring then replaces existing tables. Off: the restore fails on tables that already exist.</span></span><input type="checkbox" class="um-switch" bind:checked={clean} /></label>
                {:else if system === 'mssql' && !bacpac}
                  <label class="um-toggle"><span class="um-toggle-text"><span>Copy-only backup</span><span>Does not disturb the server's regular backup schedule (log chain).</span></span><input type="checkbox" class="um-switch" bind:checked={copyOnly} /></label>
                  <label class="um-toggle"><span class="um-toggle-text"><span>Compress</span><span>Smaller file. Not available on SQL Server Express.</span></span><input type="checkbox" class="um-switch" bind:checked={compression} /></label>
                {/if}
              </div>
            </div>

            <div class="um-group">
              <div class="um-group-title">{serverSide ? 'Save on the server' : 'Save to'}</div>
              {#if system === 'clickhouse'}
                <div class="um-row2">
                  <div class="um-field"><span>Backup disk</span>
                    <SearchSelect value={disk} options={diskOptions} legible wide ariaLabel="Backup disk" onChange={(v) => (disk = v ?? '')} />
                  </div>
                  <label class="um-field"><span>File name</span><input class="um-input mono" bind:value={dest} aria-label="Backup file" spellcheck="false" /></label>
                </div>
              {:else}
                <label class="um-field">
                  <span>{serverSide ? 'File path on the server' : 'File'}</span>
                  <span class="bk-row">
                    <input class="um-input mono" bind:value={dest} aria-label="Backup file" spellcheck="false" />
                    {#if !serverSide && IS_TAURI}<span class="cfm-btn" onclick={browseDest} onkeydown={(e) => e.key === 'Enter' && void browseDest()} role="button" tabindex="0"><Icon name="folder" size={13} /> Browse…</span>{/if}
                  </span>
                  {#if serverSide && system === 'mssql'}<span class="um-field-hint">The SQL Server service account must be able to write to this folder.</span>{/if}
                  {#if serverSide && isOracle}<span class="um-field-hint">The folder must exist on the database server; it is registered as the DBSTUDIO_DUMP directory.</span>{/if}
                </label>
              {/if}
            </div>

            <div class="bk-summary" aria-label="Backup summary">
              <Icon name="info" size={14} />
              <span>
                Backs up <b>{backupSummary.target}</b>{#if backupSummary.what}{' — '}<b>{backupSummary.what}</b>{/if}{#if backupSummary.fmt}{', as '}<b>{backupSummary.fmt}</b>{/if}{', to '}<b class="mono">{backupSummary.file}</b>{serverSide ? ' on the server' : ''}.
              </span>
            </div>
          {:else if tab === 'restore'}
            <div class="um-group">
              <div class="um-group-title">Restore from</div>
              {#if system === 'mssql'}
                <div class="um-seg" role="group" aria-label="Backup location">
                  {#each [['server', 'File on the server (.bak)'], ['local', 'File on this computer (.bacpac)']] as const as [id, label] (id)}
                    <span role="button" tabindex="0" aria-pressed={rSource === id} onclick={() => pickSource(id)} onkeydown={(e) => e.key === 'Enter' && pickSource(id)}>{label}</span>
                  {/each}
                </div>
              {/if}
              {#if system === 'clickhouse'}
                <div class="um-row2">
                  <div class="um-field"><span>Backup disk</span>
                    <SearchSelect value={disk} options={diskOptions} legible wide ariaLabel="Backup disk" onChange={(v) => (disk = v ?? '')} />
                  </div>
                  <label class="um-field"><span>File name</span><input class="um-input mono" bind:value={src} aria-label="Backup file to restore" spellcheck="false" placeholder="analytics_2026-10-19_0930.zip" /></label>
                </div>
              {:else}
                <label class="um-field">
                  <span>{serverSide ? 'Backup file on the server' : 'Backup file'}</span>
                  <span class="bk-row">
                    <input class="um-input mono" bind:value={src} aria-label="Backup file to restore" spellcheck="false" placeholder={serverSide ? (plan.default_dir ? joinPath(plan.default_dir, 'backup.bak') : 'path on the server') : 'Choose a backup file…'} />
                    {#if !serverSide && IS_TAURI}<span class="cfm-btn" onclick={browseSrc} onkeydown={(e) => e.key === 'Enter' && void browseSrc()} role="button" tabindex="0"><Icon name="folder" size={13} /> Browse…</span>{/if}
                  </span>
                  {#if src && describeBackupFile(system, src)}<span class="um-field-hint">{describeBackupFile(system, src)}</span>{/if}
                </label>
              {/if}
              {#if plan.recent.length && !bacpac}
                <div class="bk-recent">
                  <span class="bk-muted">Recent backups of {database} on this server</span>
                  {#each plan.recent as r (r.path + r.finished)}
                    <span class="bk-recent-row" role="button" tabindex="0" aria-pressed={src === r.path} onclick={() => (src = r.path)} onkeydown={(e) => e.key === 'Enter' && (src = r.path)}>
                      <Icon name="archive" size={13} /><span class="mono" title={r.path}>{fileName(r.path)}</span><span class="bk-muted">{r.finished}{r.size ? ` · ${sizeLabel(r.size)}` : ''}</span>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>

            <div class="um-group">
              <div class="um-group-title">Restore into</div>
              {#if isOracle}
                <div class="bk-kv"><span>Schema</span><b class="mono">{profile?.user}</b></div>
              {:else if system === 'sqlite'}
                <div class="bk-kv"><span>Database file</span><b class="mono">{fileName(profile?.sqlite_path ?? '') || ':memory:'}</b></div>
              {:else if system === 'cassandra'}
                <div class="bk-kv"><span>Keyspace</span><b>The keyspace named in the backup file</b></div>
              {:else}
                <div class="um-row2">
                  <div class="um-field">
                    <span>{noun[0].toUpperCase() + noun.slice(1)}</span>
                    <SearchSelect value={restoreDb} options={restoreDbOptions} legible wide ariaLabel="Restore into" placeholder={`Search ${noun}s…`} onChange={(v) => (restoreDb = v ?? '')} />
                  </div>
                  {#if system === 'clickhouse' || bacpac}
                    <label class="um-field"><span>Restore as (optional)</span><input class="um-input mono" bind:value={asDatabase} placeholder="same name" aria-label="Restore as" /></label>
                  {/if}
                </div>
              {/if}
              {#if restoreToggles(system, bacpac).length}
                <div class="um-toggles">
                  {#each restoreToggles(system, bacpac) as t (t.key)}
                    <label class="um-toggle"><span class="um-toggle-text"><span>{t.label}</span><span>{t.help}</span></span>
                      {#if t.key === 'clean'}<input type="checkbox" class="um-switch" bind:checked={rClean} />{:else}<input type="checkbox" class="um-switch" bind:checked={rSingle} />{/if}
                    </label>
                  {/each}
                </div>
              {/if}
              <div class="bk-danger">
                <Icon name="warning" size={15} />
                <div>
                  <b>{restoreImpact(system, databaseLabel(system, restoreTarget()), bacpac)}</b>
                  {#if production}<span>This is a <b>production</b> connection.</span>{/if}
                </div>
              </div>
            </div>
          {/if}

          {#if busy}
            <div class="bk-busy" role="note">
              <Icon name="info" size={14} />
              <span>A {busy.kind} of <b>{busy.target || 'this connection'}</b> is still running. Start another one when it ends.</span>
            </div>
          {/if}
        {/if}
      </div>

      <div class="um-dlg-foot">
        <span class="um-dlg-foot-note">
          {#if tab === 'backup' && plan && !serverSide && plan.method !== 'unsupported'}Saved on this computer{:else if tab === 'backup' && serverSide}Written by the server{/if}
        </span>
        <span class="um-spacer"></span>
        <span class="cfm-btn" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0">Close</span>
        {#if tab === 'backup' && plan && plan.method !== 'unsupported'}
          <span class="cfm-btn primary" onclick={runBackup} onkeydown={(e) => e.key === 'Enter' && void runBackup()} role="button" tabindex="0" aria-disabled={backupBlocked}>
            <Icon name="download" size={13} /> Back up
          </span>
        {:else if tab === 'restore' && plan && plan.method !== 'unsupported'}
          <span class="cfm-btn danger" onclick={runRestore} onkeydown={(e) => e.key === 'Enter' && void runRestore()} role="button" tabindex="0" aria-disabled={restoreBlocked}>
            <Icon name="upload" size={13} /> Restore
          </span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .bk-dlg {
    width: var(--px-720);
  }
  .bk-body {
    gap: var(--px-14);
  }
  .bk-tabs {
    flex: none;
    display: flex;
    gap: var(--px-4);
    padding: var(--px-8) var(--px-16) 0;
    border-bottom: var(--px-1) solid var(--border);
  }
  .bk-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    padding: var(--px-7) var(--px-12) var(--px-8);
    font-size: var(--px-12_5);
    font-weight: 500;
    color: var(--text2);
    cursor: pointer;
    border-bottom: var(--px-2) solid transparent;
    margin-bottom: calc(-1 * var(--px-1));
    border-radius: var(--px-6) var(--px-6) 0 0;
  }
  .bk-tab:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--primary) 7%, transparent);
  }
  .bk-tab[aria-selected='true'] {
    color: var(--primary);
    border-bottom-color: var(--primary);
    font-weight: 600;
  }
  .bk-method {
    display: flex;
    align-items: center;
    gap: var(--px-12);
    padding: var(--px-12) var(--px-14);
    border-radius: var(--px-10);
    border: var(--px-1) solid var(--border);
    background: var(--panel);
  }
  .bk-method[data-ready='true'] {
    border-color: color-mix(in srgb, var(--success) 35%, var(--border));
    background: color-mix(in srgb, var(--success) 6%, var(--panel));
  }
  .bk-method-ico {
    width: var(--px-34);
    height: var(--px-34);
    border-radius: var(--px-9);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    color: var(--primary);
    background: color-mix(in srgb, var(--primary) 11%, var(--surface));
  }
  .bk-method-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
  }
  .bk-method-text b {
    font-size: var(--px-13);
    font-weight: 600;
  }
  .bk-method-text > span {
    font-size: var(--px-11_5);
    color: var(--muted);
    /* long paths wrap — the whole text stays readable */
    overflow-wrap: anywhere;
  }
  .bk-bundled {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    color: var(--success);
    font-weight: 500;
  }
  .bk-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    padding: var(--px-2) var(--px-8);
    border-radius: var(--px-10);
    font-size: var(--px-11);
    font-weight: 600;
    flex: none;
    white-space: nowrap;
  }
  .bk-chip.ok {
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }
  .bk-chip.warn {
    color: var(--sacc-amber);
    background: color-mix(in srgb, var(--sacc-amber) 12%, transparent);
  }
  .bk-link {
    font-size: var(--px-12);
    font-weight: 500;
    color: var(--primary);
    cursor: pointer;
    white-space: nowrap;
  }
  .bk-link:hover {
    text-decoration: underline;
  }
  .bk-locate {
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
  }
  .bk-row {
    display: flex;
    gap: var(--px-8);
    align-items: center;
  }
  .bk-row > .um-input {
    flex: 1;
    min-width: 0;
  }
  .bk-muted {
    font-size: var(--px-11_5);
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  .bk-ico {
    display: inline-flex;
  }
  .bk-kv {
    display: flex;
    align-items: baseline;
    gap: var(--px-10);
    font-size: var(--px-12_5);
    flex-wrap: wrap;
  }
  .bk-kv > span:first-child {
    color: var(--text2);
    font-weight: 500;
    min-width: var(--px-90);
  }
  .bk-formats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--px-8);
  }
  .bk-format {
    display: flex;
    align-items: flex-start;
    gap: var(--px-10);
    padding: var(--px-10) var(--px-12);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-9);
    background: var(--raised);
    cursor: pointer;
  }
  .bk-format-text {
    display: flex;
    flex-direction: column;
    gap: var(--px-3);
    min-width: 0;
  }
  .bk-format b {
    font-size: var(--px-12_5);
    font-weight: 600;
  }
  .bk-format-text span {
    font-size: var(--px-11_5);
    color: var(--muted);
  }
  .bk-format-ico,
  .bk-content-ico {
    flex: none;
    width: var(--px-28);
    height: var(--px-28);
    border-radius: var(--px-8);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text2);
    background: var(--hover);
  }
  .bk-format:hover,
  .bk-content:hover {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border2));
  }
  .bk-format[aria-checked='true'],
  .bk-content[aria-checked='true'] {
    border-color: var(--primary);
    box-shadow: inset 0 0 0 var(--px-1) var(--primary);
    background: color-mix(in srgb, var(--primary) 7%, var(--raised));
  }
  .bk-format[aria-checked='true'] b,
  .bk-content[aria-checked='true'] b {
    color: var(--primary);
  }
  .bk-format[aria-checked='true'] .bk-format-ico,
  .bk-content[aria-checked='true'] .bk-content-ico {
    color: var(--hex-fff);
    background: var(--primary);
  }
  .bk-format:focus-visible,
  .bk-content:focus-visible {
    outline: var(--px-2) solid color-mix(in srgb, var(--primary) 55%, transparent);
    outline-offset: var(--px-1);
  }
  /* what a backup contains: three cards, named by the result */
  .bk-contents {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--px-8);
  }
  .bk-content {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
    padding: var(--px-10) var(--px-12) var(--px-12);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    background: var(--raised);
    cursor: pointer;
  }
  .bk-content-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--px-4);
  }
  .bk-content b {
    font-size: var(--px-13);
    font-weight: 600;
  }
  .bk-content > span:last-child {
    font-size: var(--px-11_5);
    line-height: 1.4;
    color: var(--muted);
  }
  .bk-radio {
    width: var(--px-16);
    height: var(--px-16);
    border-radius: 50%;
    border: var(--px-2) solid var(--border2);
    background: var(--surface);
  }
  .bk-content[aria-checked='true'] .bk-radio {
    border-color: var(--primary);
    background: radial-gradient(circle, var(--primary) 0 var(--px-4), var(--surface) var(--px-5));
  }
  /* numbered steps: 1 Source · 2 What to include · 3 Format · 4 Save to */
  .bk-body {
    counter-reset: bk-step;
  }
  .bk-body :global(.um-group-title)::before {
    counter-increment: bk-step;
    content: counter(bk-step);
    flex: none;
    width: var(--px-18);
    height: var(--px-18);
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--px-10);
    letter-spacing: 0;
    color: var(--hex-fff);
    background: var(--primary);
  }
  .bk-summary {
    display: flex;
    gap: var(--px-8);
    align-items: flex-start;
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-9);
    font-size: var(--px-12_5);
    line-height: 1.5;
    color: var(--text2);
    background: var(--hover);
  }
  .bk-summary > :global(svg) {
    flex: none;
    margin-top: var(--px-3);
    color: var(--primary);
  }
  .bk-summary b {
    color: var(--text);
    font-weight: 600;
  }
  .bk-recent {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
  }
  .bk-recent-row {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-6) var(--px-10);
    border-radius: var(--px-7);
    border: var(--px-1) solid var(--border);
    cursor: pointer;
    font-size: var(--px-12);
  }
  .bk-recent-row:hover {
    background: color-mix(in srgb, var(--primary) 7%, transparent);
  }
  .bk-recent-row[aria-pressed='true'] {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 10%, transparent);
  }
  .bk-recent-row .mono {
    flex: 1;
    min-width: 0;
    /* long paths wrap — the whole text stays readable */
    overflow-wrap: anywhere;
  }
  .bk-danger {
    display: flex;
    gap: var(--px-10);
    padding: var(--px-11) var(--px-13);
    border-radius: var(--px-9);
    border: var(--px-1) solid color-mix(in srgb, var(--danger-solid) 30%, var(--border));
    background: color-mix(in srgb, var(--danger-solid) 6%, var(--surface));
    font-size: var(--px-12_5);
  }
  .bk-danger > :first-child {
    color: var(--danger-solid);
    margin-top: var(--px-2);
  }
  .bk-danger b {
    font-weight: 600;
  }
</style>
