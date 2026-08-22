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
          toasts.error(res.error?.message ?? 'Failed to create database')
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
        toasts.error(res.error?.message ?? 'Failed to create database')
      }
    } catch (e) {
      toasts.error(String(e))
    } finally {
      busy = false
    }
  }

  const labelStyle = 'font-size:var(--px-12);color:var(--text2);display:flex;flex-direction:column;gap:var(--px-6)'
  const inputStyle =
    'background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-7) var(--px-10);color:var(--text);font-size:var(--px-13);outline:none'
  const hintStyle = 'font-size:var(--px-11);color:var(--muted)'
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div
    onkeydown={(e) => e.key === 'Escape' && !busy && newDatabaseWizard.close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && !busy && newDatabaseWizard.close()}
      role="dialog"
      aria-modal="true"
      aria-label="New Database"
      tabindex="-1"
      style="width:var(--px-460);max-width:94vw;max-height:92vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column"
    >
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">New Database</span>
        <span style="font-size:var(--px-11_5);color:var(--muted)">{system}</span>
        <span onclick={() => !busy && newDatabaseWizard.close()} onkeydown={(e) => e.key === 'Enter' && newDatabaseWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>

      <div style="flex:1;min-height:0;overflow:auto;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <label style={labelStyle}>
          Database name
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:value={name}
            autofocus
            placeholder="new_database"
            spellcheck="false"
            onkeydown={(e) => { if (e.key === 'Enter' && valid) void create() }}
            style={inputStyle}
          />
        </label>
        {#if isMongo}
          <label style={labelStyle}>
            First collection
            <input
              bind:value={coll}
              placeholder="e.g. items"
              spellcheck="false"
              onkeydown={(e) => { if (e.key === 'Enter' && valid) void create() }}
              style={inputStyle}
            />
            <span style={hintStyle}>MongoDB creates a database with its first collection.</span>
          </label>
        {/if}

        {#if optionKind === 'charset-collation'}
          <!-- MySQL / MariaDB: CHARACTER SET + COLLATE, both read from the server -->
          <label style={labelStyle}>
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
          <label style={labelStyle}>
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
            <span style={hintStyle}>Leave both on server default to inherit character_set_server / collation_server.</span>
          </label>
        {:else if optionKind === 'collation'}
          <!-- SQL Server: COLLATE, from sys.fn_helpcollations() -->
          <label style={labelStyle}>
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
            <span style={hintStyle}>Server default is the instance collation ({defaults.collation ?? 'unknown'}).</span>
          </label>
        {:else if optionKind === 'encoding-locale'}
          <!-- PostgreSQL: ENCODING + LC_COLLATE + LC_CTYPE -->
          <label style={labelStyle}>
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
          <label style={labelStyle}>
            Collation locale (LC_COLLATE)
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
          <label style={labelStyle}>
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
            <span style={hintStyle}>Changing encoding or locale requires TEMPLATE template0 — it is added to the statement automatically.</span>
          </label>
        {:else if optionKind === 'server-charset'}
          <div style={hintStyle}>
            Oracle stores the character set per instance, not per schema{oracleCharset ? ` — ${oracleCharset}` : ''}.
          </div>
        {:else if !isMongo && !sqlite}
          <div style={hintStyle}>{system} has no character set or collation at database level.</div>
        {/if}

        {#if optionsLoading}
          <div style={hintStyle}>Reading character sets from the server…</div>
        {:else if optionsError}
          <div style="font-size:var(--px-11_5);color:var(--warn)">Could not read the server's character set list — {optionsError}. You can still create the database on the server defaults.</div>
        {/if}

        {#if sqlite}
          <div style="font-size:var(--px-11_5);color:var(--warn)">SQLite databases are files — create a new connection with a new .sqlite path instead.</div>
        {:else if ddl}
          <pre class="mono selectable" style="margin:0;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-10);font-size:var(--px-11_5);color:var(--text2);white-space:pre-wrap">{ddl}</pre>
        {/if}
      </div>

      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-14) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span
          onclick={() => !busy && newDatabaseWizard.close()}
          onkeydown={(e) => e.key === 'Enter' && !busy && newDatabaseWizard.close()}
          role="button"
          tabindex="0"
          style="margin-left:auto;font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer"
        >Cancel</span>
        <span
          onclick={() => void create()}
          onkeydown={(e) => e.key === 'Enter' && void create()}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{valid && !busy ? 'pointer' : 'not-allowed'};opacity:{valid && !busy ? 1 : 0.5}"
        >{busy ? 'Creating…' : 'Create'}</span>
      </div>
    </div>
  </div>
{/if}
