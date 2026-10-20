<script lang="ts">
  // New Database dialog — name input + character set / collation + Cancel/Create.
  // Create runs CREATE DATABASE on the connection (per its engine), refreshes the
  // tree, and closes.
  //
  // Character set / collation: every option offered here is READ FROM THE SERVER
  // (see sql/database-options.ts for the catalog queries), per engine —
  //   MySQL/MariaDB  CHARACTER SET + COLLATE
  //   SQL Server     COLLATE
  //   PostgreSQL     ENCODING + LC_COLLATE + LC_CTYPE (needs TEMPLATE template0)
  //   Oracle         instance-wide NLS character set → read-only info
  //   others         no database-level charset/collation
  // Every field starts on "Server default", which emits the plain
  // `CREATE DATABASE <name>;` exactly as before.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { newDatabaseWizard } from '$lib/stores/newdatabase.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { genCreateDatabase } from '$lib/sql/ddl'
  import SearchSelect from '$lib/components/SearchSelect.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { systemMeta } from '$lib/systems'
  import { highlightSql, sqlTokenColor } from '$lib/format/sql'
  import '$lib/components/workspace/users/um.css'
  import {
    buildAllCollationsQuery,
    buildCharsetsQuery,
    buildMssqlCollationsQuery,
    buildMssqlServerCollationQuery,
    buildOracleCharsetQuery,
    buildPgDefaultsQuery,
    buildPgEncodingsQuery,
    buildPgLocalesFallbackQuery,
    buildPgLocalesQuery,
    buildServerCharsetQuery,
    collationsFor,
    databaseOptionKind,
    formatOracleCharset,
    parseCharsets,
    parseCollations,
    parseServerDefaults,
    pluck,
    serverDefaultLabel,
    type CharsetInfo,
    type CollationInfo,
    type DatabaseOptions,
    type ServerDefaults,
  } from '$lib/sql/database-options'

  // Reliable open gate for a class-$state singleton toggled from another component.
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = newDatabaseWizard.open
  })

  let name = $state('')
  let coll = $state('') // MongoDB: first collection (a DB persists only with ≥1 collection)
  let busy = $state(false)

  // charset/collation state — null everywhere means "leave it to the server"
  let charset = $state<string | null>(null)
  let collation = $state<string | null>(null)
  let encoding = $state<string | null>(null)
  let lcCollate = $state<string | null>(null)
  let lcCtype = $state<string | null>(null)
  let charsets = $state<CharsetInfo[]>([])
  let collations = $state<CollationInfo[]>([])
  let encodings = $state<string[]>([])
  let locales = $state<string[]>([])
  let defaults = $state<ServerDefaults>({})
  let oracleCharset = $state('')
  let optionsLoading = $state(false)
  let optionsError = $state('')

  const system = $derived(newDatabaseWizard.system)
  const sqlite = $derived(system === 'sqlite')
  const isMongo = $derived(system === 'mongodb')
  const optionKind = $derived(databaseOptionKind(system))

  // reset the fields each time the dialog opens, then read the server's lists
  $effect(() => {
    if (newDatabaseWizard.open) {
      name = ''
      coll = ''
      untrack(() => void resetOptions())
    }
  })

  function resetOptions() {
    charset = null
    collation = null
    encoding = null
    lcCollate = null
    lcCtype = null
    charsets = []
    collations = []
    encodings = []
    locales = []
    defaults = {}
    oracleCharset = ''
    optionsError = ''
    void loadOptions()
  }

  async function rows(query: string): Promise<Record<string, unknown>[]> {
    const cid = newDatabaseWizard.connId
    if (!cid) return []
    const res = await ipc.execStatement(cid, query, 0)
    if (!res.ok) throw new Error(res.error?.message ?? 'query failed')
    return (res.result?.rows ?? []) as Record<string, unknown>[]
  }

  async function loadOptions() {
    const kind = databaseOptionKind(newDatabaseWizard.system)
    if (kind === 'none' || !newDatabaseWizard.connId) return
    optionsLoading = true
    try {
      if (kind === 'charset-collation') {
        charsets = parseCharsets(await rows(buildCharsetsQuery()))
        collations = parseCollations(await rows(buildAllCollationsQuery()))
        defaults = parseServerDefaults(await rows(buildServerCharsetQuery()))
      } else if (kind === 'collation') {
        collations = pluck(await rows(buildMssqlCollationsQuery()), 'name').map((n) => ({ name: n, charset: '' }))
        defaults = parseServerDefaults(await rows(buildMssqlServerCollationQuery()))
      } else if (kind === 'encoding-locale') {
        encodings = pluck(await rows(buildPgEncodingsQuery()), 'name')
        // pg_collation columns are nullable/renamed across versions → fall back to
        // the locales existing databases were created with, which every version has.
        locales = await rows(buildPgLocalesQuery())
          .then((r) => pluck(r, 'locale'))
          .catch(async () => pluck(await rows(buildPgLocalesFallbackQuery()), 'locale'))
        defaults = parseServerDefaults(await rows(buildPgDefaultsQuery()))
      } else if (kind === 'server-charset') {
        oracleCharset = formatOracleCharset(await rows(buildOracleCharsetQuery()))
      }
    } catch (e) {
      // A read-only catalog query failed (permissions, unusual server) — the dialog
      // still creates databases, just on the server defaults.
      optionsError = String(e instanceof Error ? e.message : e)
    } finally {
      optionsLoading = false
    }
  }

  /** Collations offered for the picked charset (server default charset when unset).
   *  Charset-less collations stay in the list: MariaDB 10.10+ ships contextually
   *  typed unicode collations (uca1400_*) that apply to any charset. */
  const collationOptions = $derived(
    optionKind === 'charset-collation'
      ? collationsFor(collations, charset ?? defaults.charset ?? '')
      : collations.map((c) => c.name),
  )

  const opts = $derived<DatabaseOptions>({
    charset: charset ?? undefined,
    collation: collation ?? undefined,
    encoding: encoding ?? undefined,
    lcCollate: lcCollate ?? undefined,
    lcCtype: lcCtype ?? undefined,
  })

  // Relational: CREATE DATABASE DDL. MongoDB: a database materializes when its first
  // collection is created, so the "statement" is db.createCollection(<coll>) run
  // against the new database (via mongo_exec, not the SQL execStatement path).
  const ddl = $derived(
    isMongo
      ? name.trim() && coll.trim()
        ? `use ${name.trim()}\ndb.createCollection(${JSON.stringify(coll.trim())})`
        : ''
      : name.trim()
        ? genCreateDatabase(system, name.trim(), opts)
        : '',
  )
  const valid = $derived(!!name.trim() && !sqlite && (!isMongo || !!coll.trim()))

  function pickCharset(v: string | null) {
    charset = v
    // a collation from another charset would be rejected by the server → clear it
    if (collation && !collationsFor(collations, v ?? defaults.charset ?? '').includes(collation)) collation = null
  }

  function pickLcCollate(v: string | null) {
    lcCollate = v
    // LC_CTYPE almost always matches LC_COLLATE → mirror it until touched directly
    if (v && !lcCtype) lcCtype = v
  }

  async function create() {
    const cid = newDatabaseWizard.connId
    if (!cid || !valid || busy) return
    busy = true
    try {
      if (isMongo) {
        // Create the first collection in the target database → the DB now exists.
        const res = await ipc.mongoExec(cid, `db.createCollection(${JSON.stringify(coll.trim())})`, name.trim())
        if (res.ok) {
          toasts.success(`Database "${name.trim()}" created`, system)
          await explorer.loadDatabases(cid, true).catch(() => {})
          await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
          newDatabaseWizard.close()
        } else {
          createError = res.error?.message ?? 'The server refused to create the database.'
        }
        return
      }
      const res = await ipc.execStatement(cid, ddl, 0)
      if (res.ok) {
        toasts.success(`Database "${name.trim()}" created`, system)
        // refresh the connection's database/schema lists so the new DB shows up
        await explorer.loadDatabases(cid, true).catch(() => {})
        await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
        newDatabaseWizard.close()
      } else {
        createError = res.error?.message ?? 'The server refused to create the database.'
      }
    } catch (e) {
      createError = String(e instanceof Error ? e.message : e)
    } finally {
      busy = false
    }
  }

  // ---- presentation -----------------------------------------------------------
  const profile = $derived(newDatabaseWizard.connId ? connections.byId(newDatabaseWizard.connId) : null)
  const engineLabel = $derived(systemMeta(system).label)
  // Databases the server already has (schema-as-database engines list schemas), so
  // a duplicate name is caught before the server refuses it.
  const existing = $derived.by(() => {
    const c = newDatabaseWizard.connId ? explorer.cache[newDatabaseWizard.connId] : undefined
    const names = [...(c?.databases ?? []).map((d) => d.name), ...(['mysql', 'mariadb', 'clickhouse'].includes(system) ? (c?.schemas ?? []).map((s) => s.name) : [])]
    return new Set(names.map((n) => n.toLowerCase()))
  })
  const taken = $derived(!!name.trim() && existing.has(name.trim().toLowerCase()))
  let createError = $state('')
  $effect(() => {
    void name
    void coll
    createError = ''
  })
  const optionsTitle = $derived(
    optionKind === 'encoding-locale' ? 'Encoding & locale' : optionKind === 'collation' ? 'Collation' : 'Character set & collation',
  )
  const optionsDesc = $derived(
    optionKind === 'encoding-locale'
      ? 'How text is stored and sorted. Leave on server default unless your application needs a specific locale.'
      : optionKind === 'collation'
        ? 'How text is compared and sorted in this database.'
        : 'How text is stored and compared. utf8mb4 stores every language and emoji.',
  )
  const usingDefaults = $derived(!charset && !collation && !encoding && !lcCollate && !lcCtype)
  async function copySql() {
    try {
      await navigator.clipboard.writeText(ddl)
      toasts.success('SQL copied')
    } catch {
      /* clipboard unavailable — the statement is selectable */
    }
  }
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !busy && newDatabaseWizard.close()} role="presentation" class="um-backdrop">
    <div
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && !busy && newDatabaseWizard.close()}
      role="dialog"
      aria-modal="true"
      aria-label="New Database"
      tabindex="-1"
      class="um-dlg"
      style="width:var(--px-520)"
    >
      <div class="um-dlg-head">
        <span class="um-dlg-icon plain"><SystemIcon {system} size={20} /></span>
        <div class="um-dlg-title">
          <b>Create database</b>
          <span title={profile?.name ?? ''}>{profile?.name && profile.name !== engineLabel ? `on ${profile.name} · ${engineLabel}` : `on ${engineLabel}`}</span>
        </div>
        <span class="um-dlg-x" onclick={() => !busy && newDatabaseWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && newDatabaseWizard.close()} role="button" tabindex="0" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
      </div>

      <div class="um-dlg-body">
        {#if sqlite}
          <div class="um-callout" style="margin:0"><Icon name="info" size={15} /><span>An SQLite database is a single file. To start a new one, create a <b>new connection</b> and pick a new <span class="mono">.sqlite</span> file path.</span></div>
        {:else}
          <label class="um-field">
            Database name
            <!-- svelte-ignore a11y_autofocus -->
            <input
              bind:value={name}
              autofocus
              placeholder="new_database"
              spellcheck="false"
              autocomplete="off"
              class="um-input mono"
              class:invalid={taken}
              style="font-size:var(--px-13_5);min-height:var(--px-34)"
              onkeydown={(e) => { if (e.key === 'Enter' && valid && !taken) void create() }}
            />
            {#if taken}
              <span class="um-field-err">A database named “{name.trim()}” already exists on this server.</span>
            {:else}
              <span class="um-field-hint">Letters, digits and underscores are safest. Other characters are quoted automatically.</span>
            {/if}
          </label>
          {#if isMongo}
            <label class="um-field">
              First collection
              <input bind:value={coll} placeholder="e.g. items" spellcheck="false" autocomplete="off" class="um-input mono" onkeydown={(e) => { if (e.key === 'Enter' && valid && !taken) void create() }} />
              <span class="um-field-hint">MongoDB only keeps a database once it has a collection, so the first one is created with it.</span>
            </label>
          {/if}

          {#if optionKind === 'charset-collation' || optionKind === 'collation' || optionKind === 'encoding-locale'}
            <div class="um-group">
              <div class="um-group-title">{optionsTitle}</div>
              <div class="um-field-hint" style="margin-top:calc(-1 * var(--px-4))">{optionsDesc}{usingDefaults ? ' Currently using the server defaults.' : ''}</div>
              {#if optionKind === 'charset-collation'}
                <!-- MySQL / MariaDB: CHARACTER SET + COLLATE, both read from the server -->
                <div class="um-row2">
                  <label class="um-field">
                    Character set
                    <SearchSelect
                      value={charset}
                      onChange={pickCharset}
                      legible
                      wide
                      limit={200}
                      title="CHARACTER SET — read from information_schema.CHARACTER_SETS"
                      placeholder={serverDefaultLabel(defaults.charset)}
                      options={[{ value: null, label: serverDefaultLabel(defaults.charset) }, ...charsets.map((c) => ({ value: c.name, label: c.name }))]}
                    />
                  </label>
                  <label class="um-field">
                    Collation
                    <SearchSelect
                      bind:value={collation}
                      legible
                      wide
                      limit={200}
                      title="COLLATE — read from information_schema.COLLATIONS"
                      placeholder={serverDefaultLabel(defaults.collation)}
                      options={[{ value: null, label: serverDefaultLabel(defaults.collation) }, ...collationOptions.map((c) => ({ value: c, label: c }))]}
                    />
                  </label>
                </div>
              {:else if optionKind === 'collation'}
                <!-- SQL Server: COLLATE, from sys.fn_helpcollations() -->
                <label class="um-field">
                  Collation
                  <SearchSelect
                    bind:value={collation}
                    legible
                    wide
                    limit={200}
                    title="COLLATE — read from sys.fn_helpcollations()"
                    placeholder={serverDefaultLabel(defaults.collation)}
                    options={[{ value: null, label: serverDefaultLabel(defaults.collation) }, ...collationOptions.map((c) => ({ value: c, label: c }))]}
                  />
                  <span class="um-field-hint">Server default is the instance collation ({defaults.collation ?? 'unknown'}).</span>
                </label>
              {:else}
                <!-- PostgreSQL: ENCODING + LC_COLLATE + LC_CTYPE -->
                <label class="um-field">
                  Encoding
                  <SearchSelect
                    bind:value={encoding}
                    legible
                    wide
                    limit={200}
                    title="ENCODING — encodings this server build supports"
                    placeholder={serverDefaultLabel(defaults.encoding)}
                    options={[{ value: null, label: serverDefaultLabel(defaults.encoding) }, ...encodings.map((e) => ({ value: e, label: e }))]}
                  />
                </label>
                <div class="um-row2">
                  <label class="um-field">
                    Sort order (LC_COLLATE)
                    <SearchSelect
                      value={lcCollate}
                      onChange={pickLcCollate}
                      legible
                      wide
                      limit={200}
                      title="LC_COLLATE — locales known to this server"
                      placeholder={serverDefaultLabel(defaults.lcCollate)}
                      options={[{ value: null, label: serverDefaultLabel(defaults.lcCollate) }, ...locales.map((l) => ({ value: l, label: l }))]}
                    />
                  </label>
                  <label class="um-field">
                    Character type (LC_CTYPE)
                    <SearchSelect
                      bind:value={lcCtype}
                      legible
                      wide
                      limit={200}
                      title="LC_CTYPE — locales known to this server"
                      placeholder={serverDefaultLabel(defaults.lcCtype)}
                      options={[{ value: null, label: serverDefaultLabel(defaults.lcCtype) }, ...locales.map((l) => ({ value: l, label: l }))]}
                    />
                  </label>
                </div>
                <span class="um-field-hint">Changing the encoding or locale copies from <span class="mono">template0</span> — that is added to the statement automatically.</span>
              {/if}
              {#if optionsLoading}
                <span class="um-field-hint" style="display:inline-flex;align-items:center;gap:var(--px-6)"><span class="refresh-glyph um-spin"><Icon name="refresh" size={12} /></span>Reading the options this server supports…</span>
              {:else if optionsError}
                <div class="um-callout warn" style="margin:0"><Icon name="warning" size={15} /><span>Couldn't read the server's list ({optionsError}). You can still create the database with the server defaults.</span></div>
              {/if}
            </div>
          {:else if optionKind === 'server-charset'}
            <div class="um-callout" style="margin:0"><Icon name="info" size={15} /><span>Oracle sets the character set for the whole instance, not per schema{oracleCharset ? ` — this one uses ${oracleCharset}` : ''}.</span></div>
          {:else if !isMongo}
            <div class="um-callout" style="margin:0"><Icon name="info" size={15} /><span>{engineLabel} has no character set or collation at database level.</span></div>
          {/if}

          <div class="um-group">
            <div class="um-sql-head">
              <Icon name="code" size={13} />SQL that will run
              {#if ddl}<span class="um-link" style="margin-left:auto;font-size:var(--px-12)" onclick={copySql} onkeydown={(e) => e.key === 'Enter' && void copySql()} role="button" tabindex="0">Copy</span>{/if}
            </div>
            <pre class="um-sql selectable">{#if ddl}{#each highlightSql(ddl) as tk, i (i)}<span style="color:{sqlTokenColor(tk.kind)}">{tk.text}</span>{/each}{:else}<span style="color:var(--muted)">-- type a database name{isMongo ? ' and a first collection' : ''}</span>{/if}</pre>
          </div>

          {#if createError}
            <div class="um-err" role="alert"><Icon name="warning" size={14} /><span>{createError}</span></div>
          {/if}
        {/if}
      </div>

      <div class="um-dlg-foot">
        <span class="um-dlg-foot-note">{sqlite ? '' : 'Shows up in the Explorer right away.'}</span>
        <span class="um-spacer"></span>
        <span class="cfm-btn" onclick={() => !busy && newDatabaseWizard.close()} onkeydown={(e) => e.key === 'Enter' && !busy && newDatabaseWizard.close()} role="button" tabindex="0">Cancel</span>
        {#if !sqlite}
          <span
            class="cfm-btn primary"
            onclick={() => !taken && void create()}
            onkeydown={(e) => e.key === 'Enter' && !taken && void create()}
            role="button"
            tabindex="0"
            aria-disabled={!valid || busy || taken}
          >{busy ? 'Creating…' : 'Create database'}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
