<script lang="ts">
  // Import a file into DuckDB (CSV / TSV, Parquet, JSON / NDJSON, Excel; a glob or
  // URL works too). 1 · File: DuckDB detects the layout (DESCRIBE over the reader)
  // 2 · Columns: preview + keep / re-type columns 3 · Destination: new table,
  // replace, append (matched by name) or a view that reads the file in place —
  // with the exact statement shown before it runs.
  import '$lib/elastic/es.css'
  import '$lib/duckdb/duck.css'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import Icon from '$lib/components/Icon.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import ResultGrid from '$lib/components/results/ResultGrid.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
  import { dataTypes } from '$lib/sql/datatypes'
  import { duckImport } from '$lib/stores/duckdb.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { focusOnMount } from '$lib/elastic/actions'
  import type { QueryResultSet } from '$lib/types'
  import {
    bool,
    countFile,
    DEFAULT_CSV,
    describeFile,
    detectFormat,
    extensionStatements,
    FILE_FORMATS,
    IMPORT_MODES,
    importSelect,
    importStatement,
    lit,
    num,
    previewFile,
    tableNameFromPath,
    type CsvOptions,
    type FileFormat,
    type FileSource,
    type ImportColumn,
    type ImportMode,
  } from '$lib/duckdb/sql'
  import { DuckError, duckRows, duckRun, duckRunAll, errorText } from '$lib/duckdb/run'

  // effect-mirror of the store's flag (reliable cross-component tracking)
  let dlgOpen = $state(false)
  let seenSeq = -1
  $effect(() => {
    dlgOpen = duckImport.open
    if (dlgOpen && duckImport.seq !== seenSeq) {
      seenSeq = duckImport.seq
      reset()
    }
  })

  const connId = $derived(duckImport.connId ?? '')
  let step = $state<1 | 2 | 3>(1)
  let path = $state('')
  let format = $state<FileFormat>('csv')
  let formatTouched = $state(false)
  let csv = $state<CsvOptions>({ ...DEFAULT_CSV })
  let jsonFormat = $state<'auto' | 'array' | 'newline_delimited'>('auto')
  let sheet = $state('')
  let xlsxHeader = $state<'auto' | 'yes' | 'no'>('auto')
  let addFilename = $state(false)
  let unionByName = $state(false)

  let detecting = $state(false)
  let detectErr = $state<string | null>(null)
  let missingExt = $state<string | null>(null)
  let installing = $state(false)
  let columns = $state<ImportColumn[]>([])
  let preview = $state<QueryResultSet | null>(null)
  let fileRows = $state<number | null>(null)

  let mode = $state<ImportMode>('create')
  let databases = $state<{ name: string; current: boolean; readonly: boolean }[]>([])
  let database = $state('')
  let schemas = $state<string[]>([])
  let schema = $state('main')
  let tables = $state<string[]>([])
  let table = $state('')
  let running = $state(false)
  let runErr = $state<string | null>(null)
  let done = $state<{ rows: number | null; target: string; database: string | null; schema: string; table: string; mode: ImportMode } | null>(null)

  function reset() {
    step = 1
    path = duckImport.path
    format = detectFormat(path) ?? 'csv'
    formatTouched = false
    csv = { ...DEFAULT_CSV }
    jsonFormat = 'auto'
    sheet = ''
    xlsxHeader = 'auto'
    addFilename = false
    unionByName = /[*?]/.test(path)
    detectErr = null
    missingExt = null
    columns = []
    preview = null
    fileRows = null
    mode = duckImport.table ? 'append' : 'create'
    schema = duckImport.schema || 'main'
    table = duckImport.table ?? ''
    database = duckImport.database ?? ''
    runErr = null
    done = null
    void loadDatabases()
  }

  function close() {
    if (running) return
    duckImport.close()
  }

  const source = $derived<FileSource>({
    path: path.trim(),
    format,
    csv,
    json: { format: jsonFormat },
    xlsx: { sheet, header: xlsxHeader },
    filename: addFilename,
    unionByName,
  })
  const isGlob = $derived(/[*?]/.test(path))

  function onPathInput(v: string) {
    path = v
    if (!formatTouched) format = detectFormat(v) ?? format
    if (/[*?]/.test(v)) unionByName = true
    columns = []
    preview = null
    detectErr = null
    missingExt = null
  }

  async function browse() {
    if (!IS_TAURI) return
    const { open } = await import('@tauri-apps/plugin-dialog')
    const r = await open({
      multiple: false,
      title: 'Choose a data file',
      filters: [
        { name: 'Data files', extensions: ['csv', 'tsv', 'txt', 'parquet', 'pq', 'json', 'jsonl', 'ndjson', 'xlsx', 'gz'] },
        ...FILE_FORMATS.map((f) => ({ name: f.label, extensions: f.extensions.filter((e) => !e.includes('.')) })),
      ],
    })
    if (typeof r === 'string') {
      onPathInput(r)
      if (!table) table = tableNameFromPath(r)
      void detect()
    }
  }

  async function detect() {
    if (!source.path || detecting) return
    detecting = true
    detectErr = null
    missingExt = null
    try {
      const desc = await duckRows<{ column_name: string; column_type: string }>(connId, describeFile(source))
      columns = desc.map((d) => ({ name: d.column_name, include: true, type: '', detected: d.column_type }))
      const r = await ipc.execStatement(connId, previewFile(source, 100))
      if (!r.ok) throw new DuckError(r.error?.message ?? 'Preview failed')
      preview = r.result ?? null
      if (!table) table = tableNameFromPath(source.path)
      // the full row count can take a while on a huge file — it is a nice-to-have
      fileRows = null
      void duckRows<{ rows: unknown }>(connId, countFile(source))
        .then((c) => (fileRows = num(c[0]?.rows)))
        .catch(() => {})
    } catch (e) {
      columns = []
      preview = null
      detectErr = errorText(e)
      missingExt = e instanceof DuckError ? e.extension : null
    } finally {
      detecting = false
    }
  }

  async function installMissing() {
    if (!missingExt || installing) return
    installing = true
    try {
      await duckRunAll(connId, extensionStatements('install-load', missingExt))
      toasts.success(`Installed and loaded ${missingExt}`)
      missingExt = null
      await detect()
    } catch (e) {
      detectErr = errorText(e)
    } finally {
      installing = false
    }
  }

  function openAsQuery() {
    tabs.openSqlTab({ connectionId: connId, title: `${tableNameFromPath(source.path)} · file`, query: `${previewFile(source, 100)};` })
    close()
  }

  // ---- destination ---------------------------------------------------------
  async function loadDatabases() {
    if (!duckImport.connId) return
    try {
      const rows = await duckRows<{ name: string; current: unknown; readonly: unknown }>(
        duckImport.connId,
        'SELECT database_name AS name, (database_name = current_database()) AS current, readonly FROM duckdb_databases() WHERE NOT internal ORDER BY current DESC, name',
      )
      databases = rows.map((r) => ({ name: r.name, current: bool(r.current), readonly: bool(r.readonly) }))
      if (!database) database = databases.find((d) => d.current)?.name ?? databases[0]?.name ?? ''
    } catch {
      databases = []
    }
  }
  $effect(() => {
    const db = database
    const cid = connId
    if (!db || !cid || !dlgOpen) return
    void duckRows<{ schema_name: string }>(
      cid,
      `SELECT schema_name FROM duckdb_schemas() WHERE database_name = ${lit(db)} AND NOT internal ORDER BY schema_name`,
    )
      .then((r) => {
        schemas = r.map((s) => s.schema_name)
        if (schemas.length && !schemas.includes(schema)) schema = schemas.includes('main') ? 'main' : schemas[0]
      })
      .catch(() => (schemas = ['main']))
  })
  $effect(() => {
    const db = database
    const sc = schema
    const cid = connId
    if (!db || !sc || !cid || !dlgOpen) return
    void duckRows<{ table_name: string }>(
      cid,
      `SELECT table_name FROM duckdb_tables() WHERE database_name = ${lit(db)} AND schema_name = ${lit(sc)} ORDER BY table_name`,
    )
      .then((r) => (tables = r.map((t) => t.table_name)))
      .catch(() => (tables = []))
  })

  const currentDb = $derived(databases.find((d) => d.current)?.name ?? '')
  const targetDb = $derived(database && database !== currentDb ? database : null)
  const targetReadOnly = $derived(databases.find((d) => d.name === database)?.readonly ?? false)
  const exists = $derived(tables.includes(table.trim()))
  const statement = $derived(
    table.trim() ? importStatement(mode, schema || 'main', table.trim(), importSelect(source, columns.length ? columns : undefined), targetDb) : '',
  )
  const destProblem = $derived.by(() => {
    if (!table.trim()) return 'Enter a table name.'
    if (targetReadOnly) return `${database} is attached read-only.`
    if (mode === 'create' && exists) return `${schema}.${table.trim()} already exists — choose Replace table or Append to table.`
    if (mode === 'append' && !exists) return `${schema}.${table.trim()} does not exist yet — choose New table.`
    if (!columns.some((c) => c.include)) return 'Keep at least one column.'
    return null
  })

  async function run() {
    if (running || destProblem) return
    running = true
    runErr = null
    try {
      const r = await duckRun(connId, statement)
      done = { rows: r.affected, target: `${schema}.${table.trim()}`, database: targetDb, schema, table: table.trim(), mode }
      explorer.invalidate(connId)
      void explorer.refresh(connId, { kind: 'schema', schema })
      toasts.success(
        mode === 'view' ? `View ${schema}.${table.trim()} created over the file` : `Imported ${r.affected?.toLocaleString() ?? ''} rows into ${schema}.${table.trim()}`,
      )
    } catch (e) {
      runErr = errorText(e)
    } finally {
      running = false
    }
  }

  async function openResult() {
    if (!done) return
    const cid = done.database ? await ipc.attachDatabase(connId, done.database) : connId
    tabs.openTableViewer(cid, done.schema, done.table)
    duckImport.close()
  }
  function profileResult() {
    if (!done) return
    tabs.openDuckProfile(connId, { kind: 'table', schema: done.schema, table: done.table, database: done.database })
    duckImport.close()
  }

  const types = dataTypes('duckdb')
  const canNext1 = $derived(columns.length > 0 && !detecting)
</script>

{#if dlgOpen}
  <div class="es-modal-back dk-modal" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label="Import file" tabindex="-1" use:focusOnMount
      onkeydown={(e) => e.key === 'Escape' && close()} style="width:min(calc(var(--px-480) * 2),96vw);height:min(var(--px-720),92vh)">
      <div class="es-modal-h" style="border-bottom:var(--px-1) solid var(--border);padding-bottom:var(--px-12)">
        <span class="es-header-icon" style="width:var(--px-34);height:var(--px-34)"><Icon name="upload" size={16} /></span>
        <div style="min-width:0">
          <div class="es-card-title" style="font-size:var(--px-16)">Import file</div>
          <div class="es-help" style="margin:0">CSV, Parquet, JSON or Excel — DuckDB detects the columns and types</div>
        </div>
        <div class="dk-steps" style="margin-left:auto" aria-label="Steps">
          {#each [[1, 'File'], [2, 'Columns'], [3, 'Destination']] as [n, label] (n)}
            {#if n !== 1}<span class="dk-step-sep"></span>{/if}
            <span class="dk-step" class:on={step === n} class:done={!done && step > (n as number)}><b>{step > (n as number) || done ? '✓' : n}</b>{label}</span>
          {/each}
        </div>
      </div>

      <div class="es-modal-b" style="flex:1 1 auto;display:flex;flex-direction:column;gap:var(--px-14);padding-top:var(--px-14)">
        {#if done}
          <div class="es-empty" style="padding:var(--px-48) var(--px-24)" data-testid="duckdb-import-done">
            <div style="display:inline-flex;width:var(--px-48);height:var(--px-48);border-radius:50%;align-items:center;justify-content:center;background:var(--dk-green-soft);color:var(--dk-green);margin-bottom:var(--px-12)"><Icon name="check" size={22} /></div>
            <div class="es-empty-title">{done.mode === 'view' ? 'View created' : 'Import complete'}</div>
            <div>
              {#if done.mode === 'view'}
                <b>{done.target}</b> reads the file on every query.
              {:else}
                <b>{done.rows?.toLocaleString() ?? '—'}</b> rows {done.mode === 'append' ? 'appended to' : 'loaded into'} <b>{done.target}</b>.
              {/if}
            </div>
            <div class="es-toolbar" style="justify-content:center;margin-top:var(--px-16)">
              <button class="eg-btn primary" onclick={openResult}><Icon name="table" size={13} /> Open data</button>
              <button class="eg-btn" onclick={profileResult}><Icon name="chart" size={13} /> Profile</button>
              <button class="eg-btn" onclick={reset}><Icon name="upload" size={13} /> Import another file</button>
            </div>
          </div>
        {:else if step === 1}
          <div class="dk-field wide">
            <label class="es-label" for="dk-imp-path">File, folder pattern or URL</label>
            <div style="display:flex;gap:var(--px-8)">
              <input id="dk-imp-path" class="es-input mono" style="flex:1" value={path} oninput={(e) => onPathInput((e.currentTarget as HTMLInputElement).value)}
                onkeydown={(e) => e.key === 'Enter' && detect()} placeholder="C:\data\sales.csv  ·  /data/logs/*.parquet  ·  https://…/file.parquet" spellcheck="false" />
              {#if IS_TAURI}<button class="eg-btn" onclick={browse}><Icon name="folder" size={13} /> Browse…</button>{/if}
            </div>
            <div class="es-help">Use <code>*</code> to read many files at once (e.g. <code>/data/2026-*.csv</code>). Remote URLs (https, s3) load the httpfs extension.</div>
          </div>

          <div>
            <div class="es-label">Format</div>
            <div class="dk-choices" role="radiogroup" aria-label="File format">
              {#each FILE_FORMATS as f (f.id)}
                <button class="dk-choice" class:on={format === f.id} role="radio" aria-checked={format === f.id}
                  onclick={() => { format = f.id; formatTouched = true; columns = []; preview = null }}>
                  <span class="dk-choice-title">{f.label}</span>
                  <span class="dk-choice-help">.{f.extensions.filter((e) => !e.includes('.')).join(' · .')}</span>
                </button>
              {/each}
            </div>
          </div>

          <div class="es-card">
            <div class="es-card-h"><Icon name="sliders" size={14} /><span class="es-card-title">Options</span><span class="es-help" style="margin:0 0 0 auto">anything left on Auto is detected by DuckDB</span></div>
            <div class="es-card-b">
              {#if format === 'csv'}
                <div class="dk-form">
                  <div class="dk-field">
                    <label class="es-label" for="dk-imp-header">Header row</label>
                    <select id="dk-imp-header" class="es-input" bind:value={csv.header}><option value="auto">Auto</option><option value="yes">First row is the header</option><option value="no">No header</option></select>
                  </div>
                  <div class="dk-field">
                    <label class="es-label" for="dk-imp-delim">Delimiter</label>
                    <select id="dk-imp-delim" class="es-input" bind:value={csv.delimiter}>
                      <option value="">Auto</option><option value=",">Comma ,</option><option value=";">Semicolon ;</option><option value={'\\t'}>Tab</option><option value="|">Pipe |</option>
                    </select>
                  </div>
                  <div class="dk-field">
                    <label class="es-label" for="dk-imp-quote">Quote</label>
                    <select id="dk-imp-quote" class="es-input" bind:value={csv.quote}><option value="">Auto</option><option value={'"'}>Double "</option><option value="'">Single '</option></select>
                  </div>
                  <div class="dk-field">
                    <label class="es-label" for="dk-imp-skip">Skip lines</label>
                    <input id="dk-imp-skip" class="es-input" type="number" min="0" bind:value={csv.skip} />
                  </div>
                  <div class="dk-field" style="justify-content:flex-end">
                    <label class="dk-check"><input type="checkbox" bind:checked={csv.allVarchar} /> Read every column as text</label>
                  </div>
                </div>
              {:else if format === 'json'}
                <div class="dk-form">
                  <div class="dk-field">
                    <label class="es-label" for="dk-imp-json">Layout</label>
                    <select id="dk-imp-json" class="es-input" bind:value={jsonFormat}><option value="auto">Auto</option><option value="array">One array of objects</option><option value="newline_delimited">One object per line (NDJSON)</option></select>
                  </div>
                </div>
              {:else if format === 'xlsx'}
                <div class="dk-form">
                  <div class="dk-field">
                    <label class="es-label" for="dk-imp-sheet">Sheet</label>
                    <input id="dk-imp-sheet" class="es-input" bind:value={sheet} placeholder="first sheet" />
                  </div>
                  <div class="dk-field">
                    <label class="es-label" for="dk-imp-xh">Header row</label>
                    <select id="dk-imp-xh" class="es-input" bind:value={xlsxHeader}><option value="auto">Auto</option><option value="yes">First row is the header</option><option value="no">No header</option></select>
                  </div>
                </div>
                <div class="es-help">Excel files are read by DuckDB's <code>excel</code> extension (installed on first use).</div>
              {:else}
                <div class="es-help" style="margin:0">Parquet files describe their own columns and types — nothing to set.</div>
              {/if}
              {#if format !== 'xlsx'}
                <div class="es-toolbar" style="margin-top:var(--px-12)">
                  <label class="dk-check"><input type="checkbox" bind:checked={addFilename} /> Add a <code>filename</code> column</label>
                  <label class="dk-check" title="Several files with different column orders"><input type="checkbox" bind:checked={unionByName} /> Match columns by name across files</label>
                </div>
              {/if}
            </div>
          </div>

          {#if detectErr}
            <div class="es-callout danger" role="alert">
              <Icon name="warning" size={14} />
              <div style="flex:1;min-width:0;white-space:pre-wrap">{detectErr}</div>
              {#if missingExt}
                <button class="eg-btn primary" disabled={installing} onclick={installMissing}>{installing ? 'Installing…' : `Install & load ${missingExt}`}</button>
              {/if}
            </div>
          {:else if columns.length}
            <div class="es-callout" data-testid="duckdb-import-detected">
              <Icon name="check" size={14} />
              <div>Detected <b>{columns.length}</b> columns{fileRows !== null ? ` · ${fileRows.toLocaleString()} rows` : ''}. Continue to review them.</div>
            </div>
          {/if}
        {:else if step === 2}
          <div style="display:grid;grid-template-columns:minmax(var(--px-268),var(--px-340)) 1fr;gap:var(--px-14);min-height:0;flex:1">
            <section class="es-card" style="display:flex;flex-direction:column;min-height:0">
              <div class="es-card-h"><Icon name="columns" size={14} /><span class="es-card-title">Columns</span><span class="es-help" style="margin:0 0 0 auto">{columns.filter((c) => c.include).length} of {columns.length} kept</span></div>
              <div style="overflow:auto;min-height:0">
                <table class="es-table" data-testid="duckdb-import-columns">
                  <thead><tr><th></th><th>Column</th><th>Type</th></tr></thead>
                  <tbody>
                    {#each columns as c, i (c.name)}
                      <tr>
                        <td style="width:var(--px-24)"><input type="checkbox" bind:checked={columns[i].include} aria-label="Keep {c.name}" /></td>
                        <td class="es-ellipsis" style="max-width:var(--px-140);font-weight:500" title={c.name}>{c.name}</td>
                        <td><input class="es-input mono" style="width:var(--px-130);padding:var(--px-4) var(--px-6)" list="dk-imp-types" placeholder={c.detected}
                          bind:value={columns[i].type} aria-label="Type of {c.name}" spellcheck="false" /></td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                <datalist id="dk-imp-types">{#each types as t (t)}<option value={t}></option>{/each}</datalist>
              </div>
            </section>
            <section class="es-card" style="display:flex;flex-direction:column;min-height:0;min-width:0;margin-top:0">
              <div class="es-card-h"><Icon name="rows" size={14} /><span class="es-card-title">Preview</span><span class="es-help" style="margin:0 0 0 auto">first {preview?.rows.length ?? 0} rows{fileRows !== null ? ` of ${fileRows.toLocaleString()}` : ''}</span></div>
              <div style="flex:1;min-height:0;display:flex;flex-direction:column">
                {#if preview}<ResultGrid data={preview} system="duckdb" />{/if}
              </div>
            </section>
          </div>
        {:else}
          <div>
            <div class="es-label">What to do with the data</div>
            <div class="dk-choices" role="radiogroup" aria-label="Import mode" style="grid-template-columns:repeat(auto-fill,minmax(var(--px-200),1fr))">
              {#each IMPORT_MODES as m (m.id)}
                <button class="dk-choice" class:on={mode === m.id} role="radio" aria-checked={mode === m.id} onclick={() => (mode = m.id)}>
                  <span class="dk-choice-title">{m.label}</span>
                  <span class="dk-choice-help">{m.help}</span>
                </button>
              {/each}
            </div>
          </div>
          <div class="dk-form">
            <div class="dk-field">
              <label class="es-label" for="dk-imp-db">Database</label>
              <select id="dk-imp-db" class="es-input" bind:value={database}>
                {#each databases as d (d.name)}<option value={d.name} disabled={d.readonly}>{d.name}{d.current ? ' (current)' : ''}{d.readonly ? ' · read-only' : ''}</option>{/each}
              </select>
            </div>
            <div class="dk-field">
              <label class="es-label" for="dk-imp-schema">Schema</label>
              <select id="dk-imp-schema" class="es-input" bind:value={schema}>
                {#each schemas.length ? schemas : [schema] as s (s)}<option value={s}>{s}</option>{/each}
              </select>
            </div>
            <div class="dk-field">
              <label class="es-label" for="dk-imp-table">{mode === 'view' ? 'View name' : 'Table name'}</label>
              <input id="dk-imp-table" class="es-input mono" bind:value={table} list="dk-imp-tables" spellcheck="false" />
              <datalist id="dk-imp-tables">{#each tables as t (t)}<option value={t}></option>{/each}</datalist>
            </div>
          </div>
          {#if destProblem}
            <div class="es-callout warn"><Icon name="info" size={14} /><div>{destProblem}</div></div>
          {/if}
          <div>
            <div class="es-label">Statement</div>
            <CodeView value={statement} language={editorLanguageId('duckdb')} readOnly height="auto" minHeight={44} maxHeight={160} ariaLabel="Import statement" />
          </div>
          {#if runErr}
            <div class="es-callout danger" role="alert"><Icon name="warning" size={14} /><div style="white-space:pre-wrap">{runErr}</div></div>
          {/if}
        {/if}
      </div>

      <div class="es-modal-f">
        {#if done}
          <button class="cfm-btn" onclick={close}>Done</button>
        {:else}
          {#if step === 1}
            <button class="cfm-btn" style="margin-right:auto" disabled={!source.path} onclick={openAsQuery} title="Open a SELECT over the file in a query tab"><Icon name="query" size={13} /> Query the file instead</button>
          {:else}
            <button class="cfm-btn" style="margin-right:auto" disabled={running} onclick={() => (step = (step - 1) as 1 | 2)}>Back</button>
          {/if}
          <button class="cfm-btn" disabled={running} onclick={close}>Cancel</button>
          {#if step === 1}
            {#if canNext1}
              <button class="cfm-btn" disabled={detecting} onclick={detect}>Detect again</button>
              <button class="cfm-btn primary" onclick={() => (step = 2)}>Next</button>
            {:else}
              <button class="cfm-btn primary" disabled={!source.path || detecting} onclick={detect}>{detecting ? 'Detecting…' : 'Detect columns'}</button>
            {/if}
          {:else if step === 2}
            <button class="cfm-btn primary" disabled={!columns.some((c) => c.include)} onclick={() => (step = 3)}>Next</button>
          {:else}
            <button class="cfm-btn primary" disabled={running || !!destProblem} onclick={run}>{running ? 'Importing…' : mode === 'view' ? 'Create view' : 'Import'}</button>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}
