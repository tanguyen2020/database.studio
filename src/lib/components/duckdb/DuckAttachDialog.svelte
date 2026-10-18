<script lang="ts">
  // ATTACH another database to the DuckDB connection: an existing or new .duckdb
  // file, or a SQLite file (read through DuckDB's sqlite extension), optionally
  // read-only. The alias is how it shows in the tree and in queries (alias.schema.table).
  import '$lib/elastic/es.css'
  import '$lib/duckdb/duck.css'
  import { IS_TAURI } from '$lib/demo'
  import Icon from '$lib/components/Icon.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
  import { duckAttach } from '$lib/stores/duckdb.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { focusOnMount } from '$lib/elastic/actions'
  import { aliasFromPath, attachStatement, extensionStatements, type AttachType } from '$lib/duckdb/sql'
  import { DuckError, duckRows, duckRun, duckRunAll, errorText } from '$lib/duckdb/run'

  let dlgOpen = $state(false)
  let seenSeq = -1
  $effect(() => {
    dlgOpen = duckAttach.open
    if (dlgOpen && duckAttach.seq !== seenSeq) {
      seenSeq = duckAttach.seq
      reset()
    }
  })

  let path = $state('')
  let alias = $state('')
  let aliasTouched = $state(false)
  let type = $state<AttachType>('duckdb')
  let readOnly = $state(false)
  let taken = $state<string[]>([])
  let running = $state(false)
  let err = $state<string | null>(null)
  let missingExt = $state<string | null>(null)

  function reset() {
    path = ''
    alias = ''
    aliasTouched = false
    type = 'duckdb'
    readOnly = false
    err = null
    missingExt = null
    const cid = duckAttach.connId
    if (cid)
      void duckRows<{ name: string }>(cid, 'SELECT database_name AS name FROM duckdb_databases()')
        .then((r) => (taken = r.map((d) => d.name.toLowerCase())))
        .catch(() => (taken = []))
  }

  function setPath(v: string) {
    path = v
    if (/\.(db|sqlite|sqlite3)$/i.test(v)) type = 'sqlite'
    else if (/\.(duckdb|ddb)$/i.test(v)) type = 'duckdb'
    if (!aliasTouched) alias = v.trim() ? aliasFromPath(v) : ''
  }

  async function browse(create: boolean) {
    if (!IS_TAURI) return
    const d = await import('@tauri-apps/plugin-dialog')
    const filters = [
      { name: 'DuckDB', extensions: ['duckdb', 'ddb', 'db'] },
      { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] },
    ]
    const r = create ? await d.save({ defaultPath: 'new.duckdb', filters: [filters[0]] }) : await d.open({ multiple: false, filters })
    if (typeof r === 'string') setPath(r)
  }

  const aliasProblem = $derived.by(() => {
    const a = alias.trim()
    if (!a) return 'Give the database a name.'
    if (taken.includes(a.toLowerCase())) return `A database named ${a} is already attached.`
    return null
  })
  const statement = $derived(path.trim() && alias.trim() ? attachStatement(path.trim(), alias.trim(), { readOnly, type }) : '')

  async function run() {
    if (running || aliasProblem || !statement) return
    running = true
    err = null
    missingExt = null
    try {
      await duckRun(duckAttach.connId ?? '', statement)
      toasts.success(`Attached ${alias.trim()}`)
      duckAttach.onDone?.(alias.trim())
      duckAttach.close()
    } catch (e) {
      err = errorText(e)
      missingExt = e instanceof DuckError ? e.extension : null
    } finally {
      running = false
    }
  }

  async function installMissing() {
    if (!missingExt) return
    running = true
    try {
      await duckRunAll(duckAttach.connId ?? '', extensionStatements('install-load', missingExt))
      toasts.success(`Installed and loaded ${missingExt}`)
      missingExt = null
    } catch (e) {
      err = errorText(e)
    } finally {
      running = false
    }
    await run()
  }

  function close() {
    if (!running) duckAttach.close()
  }
</script>

{#if dlgOpen}
  <div class="es-modal-back dk-modal" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label="Attach database" tabindex="-1" use:focusOnMount
      onkeydown={(e) => e.key === 'Escape' && close()} style="width:min(var(--px-600),96vw)">
      <div class="es-modal-h" style="border-bottom:var(--px-1) solid var(--border);padding-bottom:var(--px-12)">
        <span class="es-header-icon" style="width:var(--px-34);height:var(--px-34)"><Icon name="link" size={16} /></span>
        <div>
          <div class="es-card-title" style="font-size:var(--px-16)">Attach database</div>
          <div class="es-help" style="margin:0">Query and join it together with this connection's data</div>
        </div>
      </div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-14);padding-top:var(--px-14)">
        <div class="dk-field wide">
          <label class="es-label" for="dk-att-path">Database file</label>
          <div style="display:flex;gap:var(--px-8)">
            <input id="dk-att-path" class="es-input mono" style="flex:1" value={path} oninput={(e) => setPath((e.currentTarget as HTMLInputElement).value)}
              placeholder="C:\data\lake.duckdb" spellcheck="false" />
            {#if IS_TAURI}
              <button class="eg-btn" onclick={() => browse(false)}><Icon name="folder" size={13} /> Open…</button>
              <button class="eg-btn" onclick={() => browse(true)} title="Create a new, empty DuckDB file"><Icon name="plus" size={13} /> New…</button>
            {/if}
          </div>
          <div class="es-help">A DuckDB file that does not exist yet is created.</div>
        </div>
        <div class="dk-form">
          <div class="dk-field">
            <label class="es-label" for="dk-att-alias">Name (alias)</label>
            <input id="dk-att-alias" class="es-input mono" bind:value={alias} oninput={() => (aliasTouched = true)} spellcheck="false" />
          </div>
          <div class="dk-field">
            <span class="es-label">Type</span>
            <div class="es-seg" role="radiogroup" aria-label="Database type">
              <button class:on={type === 'duckdb'} onclick={() => (type = 'duckdb')}>DuckDB</button>
              <button class:on={type === 'sqlite'} onclick={() => (type = 'sqlite')}>SQLite</button>
            </div>
          </div>
          <div class="dk-field" style="justify-content:flex-end">
            <label class="dk-check"><input type="checkbox" bind:checked={readOnly} /> Read-only</label>
          </div>
        </div>
        {#if type === 'sqlite'}
          <div class="es-callout"><Icon name="info" size={14} /><div>SQLite files are read through DuckDB's <code>sqlite</code> extension (installed on first use).</div></div>
        {/if}
        {#if alias.trim() && aliasProblem}<div class="es-error-text">{aliasProblem}</div>{/if}
        {#if statement}
          <div>
            <div class="es-label">Statement</div>
            <CodeView value={statement} language={editorLanguageId('duckdb')} readOnly height="auto" minHeight={36} maxHeight={90} ariaLabel="Attach statement" />
          </div>
        {/if}
        {#if err}
          <div class="es-callout danger" role="alert">
            <Icon name="warning" size={14} />
            <div style="flex:1;min-width:0;white-space:pre-wrap">{err}</div>
            {#if missingExt}<button class="eg-btn primary" disabled={running} onclick={installMissing}>Install & load {missingExt}</button>{/if}
          </div>
        {/if}
      </div>
      <div class="es-modal-f">
        <button class="cfm-btn" disabled={running} onclick={close}>Cancel</button>
        <button class="cfm-btn primary" disabled={running || !!aliasProblem || !statement} onclick={run}>{running ? 'Attaching…' : 'Attach'}</button>
      </div>
    </div>
  </div>
{/if}
