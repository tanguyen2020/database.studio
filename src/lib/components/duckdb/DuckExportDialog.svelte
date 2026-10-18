<script lang="ts">
  // Export from DuckDB with COPY … TO: a table, a query or a whole database
  // (EXPORT DATABASE) to Parquet / CSV / JSON / NDJSON, optionally Hive-partitioned
  // into folders. The exact statement is shown before it runs; the result can be
  // opened again as a query over the written file.
  import '$lib/elastic/es.css'
  import '$lib/duckdb/duck.css'
  import { IS_TAURI } from '$lib/demo'
  import Icon from '$lib/components/Icon.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
  import { duckExport } from '$lib/stores/duckdb.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { focusOnMount } from '$lib/elastic/actions'
  import {
    EXPORT_FORMATS,
    exportDatabaseStatement,
    exportStatement,
    lit,
    previewFile,
    type ExportFormat,
    type ParquetCompression,
  } from '$lib/duckdb/sql'
  import { duckRows, duckRun, errorText } from '$lib/duckdb/run'

  let dlgOpen = $state(false)
  let seenSeq = -1
  $effect(() => {
    dlgOpen = duckExport.open
    if (dlgOpen && duckExport.seq !== seenSeq) {
      seenSeq = duckExport.seq
      reset()
    }
  })

  const connId = $derived(duckExport.connId ?? '')
  const src = $derived(duckExport.source)
  const isDb = $derived(src?.kind === 'database')

  let format = $state<ExportFormat>('parquet')
  let dbFormat = $state<'parquet' | 'csv'>('parquet')
  let compression = $state<ParquetCompression>('zstd')
  let header = $state(true)
  let delimiter = $state(',')
  let partitionBy = $state<string[]>([])
  let overwrite = $state(false)
  let path = $state('')
  let columns = $state<string[]>([])
  let running = $state(false)
  let runErr = $state<string | null>(null)
  let done = $state<{ rows: number | null; path: string } | null>(null)

  function baseName(): string {
    if (!src) return 'export'
    if (src.kind === 'table') return src.table
    if (src.kind === 'database') return `${src.database ?? 'database'}_export`
    return 'query_result'
  }
  const ext = $derived(EXPORT_FORMATS.find((f) => f.id === format)?.ext ?? 'parquet')
  const partitioned = $derived(!isDb && partitionBy.length > 0 && (format === 'parquet' || format === 'csv'))
  const toFolder = $derived(isDb || partitioned)

  function reset() {
    format = 'parquet'
    dbFormat = 'parquet'
    compression = 'zstd'
    header = true
    delimiter = ','
    partitionBy = []
    overwrite = false
    path = ''
    runErr = null
    done = null
    columns = []
    void loadColumns()
  }

  async function loadColumns() {
    const s = duckExport.source
    const cid = duckExport.connId
    if (!s || !cid || s.kind === 'database') return
    try {
      if (s.kind === 'table') {
        const r = await duckRows<{ column_name: string }>(
          cid,
          `SELECT column_name FROM duckdb_columns() WHERE ${s.database ? `database_name = ${lit(s.database)}` : 'database_name = current_database()'} AND schema_name = ${lit(s.schema)} AND table_name = ${lit(s.table)} ORDER BY column_index`,
        )
        columns = r.map((c) => c.column_name)
      } else {
        const r = await duckRows<{ column_name: string }>(cid, `DESCRIBE ${s.sql.trim().replace(/;+\s*$/, '')}`)
        columns = r.map((c) => c.column_name)
      }
    } catch {
      columns = []
    }
  }

  const statement = $derived.by(() => {
    if (!src || !path.trim()) return ''
    if (src.kind === 'database') return exportDatabaseStatement(path.trim(), dbFormat, src.database)
    return exportStatement(src, path.trim(), {
      format,
      compression,
      header,
      delimiter,
      partitionBy: partitioned ? partitionBy : [],
      overwrite: partitioned ? true : overwrite,
    })
  })

  async function choosePath() {
    if (!IS_TAURI) return
    const d = await import('@tauri-apps/plugin-dialog')
    if (toFolder) {
      const r = await d.open({ directory: true, title: isDb ? 'Folder for the exported database' : 'Folder for the partitioned files' })
      if (typeof r === 'string') path = isDb ? `${r.replace(/[\\/]+$/, '')}${r.includes('\\') ? '\\' : '/'}${baseName()}` : r
    } else {
      const r = await d.save({ defaultPath: `${baseName()}.${ext}`, filters: [{ name: format.toUpperCase(), extensions: [ext] }] })
      if (typeof r === 'string') path = r
    }
  }

  function togglePart(c: string) {
    partitionBy = partitionBy.includes(c) ? partitionBy.filter((x) => x !== c) : [...partitionBy, c]
  }

  function close() {
    if (running) return
    duckExport.close()
  }

  async function run() {
    if (running || !statement) return
    running = true
    runErr = null
    try {
      const r = await duckRun(connId, statement)
      done = { rows: r.affected, path: path.trim() }
      toasts.success(isDb ? 'Database exported' : `Wrote ${r.affected?.toLocaleString() ?? ''} rows to ${path.trim()}`)
    } catch (e) {
      runErr = errorText(e)
    } finally {
      running = false
    }
  }

  function queryOutput() {
    if (!done || isDb) return
    const sep = done.path.includes('\\') ? '\\' : '/'
    const p = partitioned ? `${done.path.replace(/[\\/]+$/, '')}${sep}*${sep}*.${ext}` : done.path
    const fmt = format === 'parquet' ? 'parquet' : format === 'csv' ? 'csv' : 'json'
    tabs.openSqlTab({
      connectionId: connId,
      title: 'Exported file',
      query: `${previewFile({ path: p, format: fmt, unionByName: partitioned, json: format === 'ndjson' ? { format: 'newline_delimited' } : undefined, csv: format === 'csv' && delimiter !== ',' ? { delimiter } : undefined }, 100)};`,
    })
    duckExport.close()
  }

  const title = $derived(
    !src ? 'Export' : src.kind === 'table' ? `Export ${src.schema}.${src.table}` : src.kind === 'database' ? `Export database${src.database ? ` ${src.database}` : ''}` : 'Export query result',
  )
</script>

{#if dlgOpen && src}
  <div class="es-modal-back dk-modal" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" use:focusOnMount
      onkeydown={(e) => e.key === 'Escape' && close()} style="width:min(var(--px-720),96vw)">
      <div class="es-modal-h" style="border-bottom:var(--px-1) solid var(--border);padding-bottom:var(--px-12)">
        <span class="es-header-icon" style="width:var(--px-34);height:var(--px-34)"><Icon name="download" size={16} /></span>
        <div style="min-width:0">
          <div class="es-card-title" style="font-size:var(--px-16)">{title}</div>
          <div class="es-help" style="margin:0">{isDb ? 'EXPORT DATABASE writes schema.sql, load.sql and one file per table' : 'COPY … TO writes the rows to a file'}</div>
        </div>
      </div>
      <div class="es-modal-b" style="display:flex;flex-direction:column;gap:var(--px-14);padding-top:var(--px-14)">
        {#if done}
          <div class="es-empty" style="padding:var(--px-34) var(--px-24)" data-testid="duckdb-export-done">
            <div style="display:inline-flex;width:var(--px-48);height:var(--px-48);border-radius:50%;align-items:center;justify-content:center;background:var(--dk-green-soft);color:var(--dk-green);margin-bottom:var(--px-12)"><Icon name="check" size={22} /></div>
            <div class="es-empty-title">Export complete</div>
            <div>{#if !isDb}<b>{done.rows?.toLocaleString() ?? '—'}</b> rows written to {/if}<span class="mono" style="word-break:break-all">{done.path}</span></div>
            {#if !isDb}
              <div style="margin-top:var(--px-14)"><button class="eg-btn" onclick={queryOutput}><Icon name="query" size={13} /> Query the exported file</button></div>
            {/if}
          </div>
        {:else}
          {#if isDb}
            <div>
              <div class="es-label">Table files</div>
              <div class="es-seg" role="radiogroup" aria-label="Table file format">
                <button class:on={dbFormat === 'parquet'} onclick={() => (dbFormat = 'parquet')}>Parquet</button>
                <button class:on={dbFormat === 'csv'} onclick={() => (dbFormat = 'csv')}>CSV</button>
              </div>
              <div class="es-help">Re-import later with <b>Import database…</b> (IMPORT DATABASE) on any DuckDB connection.</div>
            </div>
          {:else}
            <div>
              <div class="es-label">Format</div>
              <div class="dk-choices" role="radiogroup" aria-label="Export format">
                {#each EXPORT_FORMATS as f (f.id)}
                  <button class="dk-choice" class:on={format === f.id} role="radio" aria-checked={format === f.id} onclick={() => { format = f.id; path = path.replace(/\.(parquet|csv|json|ndjson)$/i, `.${f.ext}`) }}>
                    <span class="dk-choice-title">{f.label}</span>
                    <span class="dk-choice-help">.{f.ext}</span>
                  </button>
                {/each}
              </div>
            </div>
            <div class="dk-form">
              {#if format === 'parquet'}
                <div class="dk-field">
                  <label class="es-label" for="dk-exp-comp">Compression</label>
                  <select id="dk-exp-comp" class="es-input" bind:value={compression}>
                    <option value="zstd">ZSTD (smallest)</option><option value="snappy">Snappy (fastest)</option><option value="gzip">GZIP</option><option value="uncompressed">None</option>
                  </select>
                </div>
              {:else if format === 'csv'}
                <div class="dk-field">
                  <label class="es-label" for="dk-exp-delim">Delimiter</label>
                  <select id="dk-exp-delim" class="es-input" bind:value={delimiter}><option value=",">Comma ,</option><option value=";">Semicolon ;</option><option value={'\\t'}>Tab</option><option value="|">Pipe |</option></select>
                </div>
                <div class="dk-field" style="justify-content:flex-end"><label class="dk-check"><input type="checkbox" bind:checked={header} /> Header row</label></div>
              {/if}
              {#if !partitioned}
                <div class="dk-field" style="justify-content:flex-end"><label class="dk-check"><input type="checkbox" bind:checked={overwrite} /> Overwrite if it exists</label></div>
              {/if}
            </div>
            {#if (format === 'parquet' || format === 'csv') && columns.length}
              <div>
                <div class="es-label">Partition by <span class="es-help" style="display:inline;font-weight:400">— optional: one folder per value (<code>col=value/</code>)</span></div>
                <div class="es-toolbar" data-testid="duckdb-export-partition">
                  {#each columns as c (c)}
                    <label class="dk-check" style="padding:var(--px-3) var(--px-8);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);{partitionBy.includes(c) ? 'background:var(--dk-accent-soft);border-color:var(--dk-accent)' : ''}">
                      <input type="checkbox" checked={partitionBy.includes(c)} onchange={() => togglePart(c)} /> {c}
                    </label>
                  {/each}
                </div>
              </div>
            {/if}
          {/if}
          <div class="dk-field wide">
            <label class="es-label" for="dk-exp-path">{toFolder ? 'Destination folder' : 'Destination file'}</label>
            <div style="display:flex;gap:var(--px-8)">
              <input id="dk-exp-path" class="es-input mono" style="flex:1" bind:value={path} spellcheck="false"
                placeholder={toFolder ? `C:\\exports\\${baseName()}` : `C:\\exports\\${baseName()}.${ext}`} />
              {#if IS_TAURI}<button class="eg-btn" onclick={choosePath}><Icon name="folder" size={13} /> Choose…</button>{/if}
            </div>
            {#if toFolder}<div class="es-help">{isDb ? 'The folder is created; it must not already contain an export.' : 'Existing files in the folder are kept unless they have the same name.'}</div>{/if}
          </div>
          {#if statement}
            <div>
              <div class="es-label">Statement</div>
              <CodeView value={statement} language={editorLanguageId('duckdb')} readOnly height="auto" minHeight={44} maxHeight={140} ariaLabel="Export statement" />
            </div>
          {/if}
          {#if runErr}<div class="es-callout danger" role="alert"><Icon name="warning" size={14} /><div style="white-space:pre-wrap">{runErr}</div></div>{/if}
        {/if}
      </div>
      <div class="es-modal-f">
        {#if done}
          <button class="cfm-btn" onclick={close}>Done</button>
        {:else}
          <button class="cfm-btn" disabled={running} onclick={close}>Cancel</button>
          <button class="cfm-btn primary" disabled={running || !statement} onclick={run}>{running ? 'Exporting…' : 'Export'}</button>
        {/if}
      </div>
    </div>
  </div>
{/if}
