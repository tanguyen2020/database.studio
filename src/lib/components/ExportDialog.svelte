<script lang="ts">
  // Export wizard (Phase 5 · T14). Table or current-result export with
  // format / column-subset / WHERE / LIMIT / filename. Table mode streams via
  // paged SELECT (LIMIT/OFFSET) so large tables don't need one huge query.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { exportWizard } from '$lib/stores/export.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { settings } from '$lib/stores/settings.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { toCsv, toJson, toSqlInsert, toExcelHtml, download } from '$lib/export/rows'
  import { toXml } from '$lib/export/clipboard'
  import { buildExportSelect, supportsOffset } from '$lib/export/query'
  import { save as saveFileDialog } from '@tauri-apps/plugin-dialog'

  type Fmt = 'csv' | 'json' | 'sql' | 'xls' | 'xml'
  const EXT: Record<Fmt, string> = { csv: 'csv', json: 'json', sql: 'sql', xls: 'xls', xml: 'xml' }
  const MIME: Record<Fmt, string> = {
    csv: 'text/csv',
    json: 'application/json',
    sql: 'text/plain',
    xls: 'application/vnd.ms-excel',
    xml: 'application/xml',
  }
  const PAGE = 5000

  let format = $state<Fmt>('csv')
  let cols = $state<string[]>([]) // selected columns
  let whereClause = $state('')
  let limit = $state<number | null>(null)
  let filename = $state('export.csv')
  let running = $state(false)
  let fetched = $state(0)
  let result = $state<string | null>(null)
  let streaming = $state(false)
  let exportId = $state('')

  const system = $derived(connections.byId(exportWizard.connId)?.system ?? 'postgres')
  const isTable = $derived(exportWizard.mode === 'table')
  // Header target: table mode shows db.schema.table (skipping the db prefix on
  // schema-as-database engines where schema already IS the db); result mode → "result".
  const db = $derived(connections.databaseOf(exportWizard.connId))
  const target = $derived.by(() => {
    if (!isTable) return 'result'
    const dbPart = db && db !== exportWizard.schema ? `${db}.` : ''
    const schemaPart = exportWizard.schema ? `${exportWizard.schema}.` : ''
    return `${dbPart}${schemaPart}${exportWizard.table}`
  })
  const cache = $derived(exportWizard.connId ? explorer.cache[exportWizard.connId] : undefined)
  const available = $derived.by(() => {
    if (exportWizard.mode === 'result') return exportWizard.resultHeaders
    return (cache?.bySchema[exportWizard.schema]?.tableDetails[exportWizard.table]?.columns ?? []).map(
      (c) => c.name,
    )
  })

  // reset + preload columns on open
  $effect(() => {
    if (exportWizard.open) untrack(() => void init())
  })
  async function init() {
    format = 'csv'
    whereClause = ''
    limit = null
    running = false
    fetched = 0
    result = null
    filename = `${exportWizard.table || 'export'}.csv`
    if (exportWizard.mode === 'table' && exportWizard.connId) {
      await explorer.loadTableDetail(exportWizard.connId, exportWizard.schema, exportWizard.table)
    }
    cols = [...available]
  }

  function setFormat(f: Fmt) {
    format = f
    filename = filename.replace(/\.[^.]+$/, '') + '.' + EXT[f]
  }

  function toggleCol(c: string) {
    cols = cols.includes(c) ? cols.filter((x) => x !== c) : [...cols, c]
  }

  function serialize(headers: string[], rows: Record<string, unknown>[]): string {
    if (format === 'csv') return toCsv(headers, rows)
    if (format === 'json') return toJson(rows.map((r) => Object.fromEntries(headers.map((h) => [h, r[h]]))))
    if (format === 'sql') return toSqlInsert(exportWizard.table || 'export', headers, rows)
    if (format === 'xml') return toXml(headers, rows)
    return toExcelHtml(headers, rows)
  }

  async function fetchTableRows(headers: string[]): Promise<Record<string, unknown>[] | null> {
    const connId = exportWizard.connId!
    const base = { system, schema: exportWizard.schema, table: exportWizard.table, columns: headers, where: whereClause }
    const cap = limit && limit > 0 ? limit : null
    // Single shot when we can't page (MSSQL/Cassandra) or a small explicit cap.
    if (!supportsOffset(system) || (cap != null && cap <= PAGE)) {
      const sql = buildExportSelect({ ...base, limit: cap })
      const res = await ipc.execStatement(connId, sql, 0)
      if (!res.ok) {
        result = `✗ ${res.error?.message ?? 'error'}`
        return null
      }
      const rows = (res.result?.rows ?? []) as Record<string, unknown>[]
      fetched = rows.length
      return rows
    }
    // Paged streaming.
    const all: Record<string, unknown>[] = []
    let offset = 0
    for (;;) {
      const remaining = cap != null ? cap - all.length : Infinity
      const pageLimit = Math.min(PAGE, remaining)
      if (pageLimit <= 0) break
      const sql = buildExportSelect({ ...base, limit: pageLimit, offset })
      const res = await ipc.execStatement(connId, sql, 0)
      if (!res.ok) {
        result = `✗ ${res.error?.message ?? 'error'}`
        return null
      }
      const rows = (res.result?.rows ?? []) as Record<string, unknown>[]
      all.push(...rows)
      fetched = all.length
      if (rows.length < pageLimit) break
      offset += rows.length
    }
    return all
  }

  // T24 — stream a table export straight to a file (bounded memory) when the
  // streaming_io setting is on. PostgreSQL + ClickHouse + csv/json/sql; else the
  // in-memory path.
  const canStream = $derived(
    isTable && IS_TAURI && (system === 'postgres' || system === 'clickhouse') && ['csv', 'json', 'sql'].includes(format) && settings.value.streamingIo,
  )

  async function runStreaming(headers: string[]) {
    const connId = exportWizard.connId!
    const path = await saveFileDialog({ defaultPath: filename, filters: [{ name: format.toUpperCase(), extensions: [EXT[format]] }] })
    if (!path) return
    const cap = limit && limit > 0 ? limit : null
    const sql = buildExportSelect({ system, schema: exportWizard.schema, table: exportWizard.table, columns: headers, where: whereClause, limit: cap })
    exportId = `exp-${Date.now()}-${Math.floor(fetched)}-${headers.length}`
    running = true
    streaming = true
    result = null
    fetched = 0
    try {
      const n = await ipc.exportQueryToFile(connId, sql, path, format as 'csv' | 'json' | 'sql', exportWizard.table, exportId, (rows) => (fetched = rows))
      result = `✓ exported ${n.toLocaleString()} rows → ${path}`
      toasts.success(result)
    } catch (e) {
      result = `✗ ${e}`
    } finally {
      running = false
      streaming = false
    }
  }

  async function cancelStreaming() {
    if (exportId) await ipc.cancelExport(exportId)
  }

  async function runExport() {
    if (!exportWizard.connId) return
    const headers = cols.length ? cols : [...available]
    if (!headers.length) {
      toasts.error('No columns selected')
      return
    }
    if (canStream) {
      await runStreaming(headers)
      return
    }
    running = true
    result = null
    fetched = 0
    try {
      let rows: Record<string, unknown>[] | null
      if (exportWizard.mode === 'result') {
        const cap = limit && limit > 0 ? limit : exportWizard.resultRows.length
        rows = exportWizard.resultRows.slice(0, cap)
        fetched = rows.length
      } else {
        rows = await fetchTableRows(headers)
      }
      if (rows === null) return // error already set
      const content = serialize(headers, rows)
      download(filename, content, MIME[format])
      result = `✓ exported ${rows.length} rows → ${filename}`
      toasts.success(result)
    } catch (e) {
      result = `✗ ${e}`
    } finally {
      running = false
    }
  }
</script>

{#if exportWizard.open}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !running && exportWizard.close()} role="presentation" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !running && exportWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-560);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Export {target}</span>
        <span onclick={() => !running && exportWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && exportWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        <!-- format -->
        <div style="display:flex;gap:var(--px-14);font-size:var(--px-12);color:var(--text2);align-items:center">
          Format
          {#each ['csv', 'json', 'sql', 'xls', 'xml'] as const as f (f)}
            <label style="display:flex;align-items:center;gap:var(--px-5);cursor:pointer"><input type="radio" name="expfmt" checked={format === f} onchange={() => setFormat(f)} /> {f.toUpperCase()}</label>
          {/each}
        </div>
        <!-- columns -->
        <div style="font-size:var(--px-12);color:var(--text2)">Columns ({cols.length}/{available.length})</div>
        <div style="display:flex;flex-wrap:wrap;gap:var(--px-6) var(--px-12);max-height:var(--px-120);overflow:auto;border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-8)">
          {#each available as c (c)}
            <label class="mono" style="display:flex;align-items:center;gap:var(--px-5);font-size:var(--px-11_5);color:var(--text2);cursor:pointer">
              <input type="checkbox" checked={cols.includes(c)} onchange={() => toggleCol(c)} /> {c}
            </label>
          {/each}
        </div>
        {#if isTable}
          <label style="font-size:var(--px-12);color:var(--text2)">WHERE (optional)
            <input bind:value={whereClause} placeholder="status = 'active'" class="mono" style="display:block;margin-top:var(--px-5);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);font-size:var(--px-12)" />
          </label>
        {/if}
        <div style="display:flex;gap:var(--px-16);flex-wrap:wrap">
          <label style="font-size:var(--px-12);color:var(--text2)">Limit (blank = all)
            <input type="number" min="1" bind:value={limit} style="margin-left:var(--px-8);width:var(--px-90);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)" />
          </label>
          <label style="font-size:var(--px-12);color:var(--text2);flex:1">Filename
            <input bind:value={filename} class="mono" style="display:block;margin-top:var(--px-5);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);font-size:var(--px-12)" />
          </label>
        </div>
        {#if running}
          <div style="font-size:var(--px-12);color:var(--text2)">Fetching… {fetched} rows</div>
        {/if}
        {#if result !== null}
          <div style="font-size:var(--px-13);color:{result.startsWith('✓') ? '#27AE60' : 'var(--error)'};text-align:center;padding:var(--px-8)">{result}</div>
        {/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !running && exportWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && exportWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Close</span>
        {#if streaming}
          <span onclick={cancelStreaming} onkeydown={(e) => e.key === 'Enter' && cancelStreaming()} role="button" tabindex="0" title="Cancel the running export" style="margin-left:auto;font-size:var(--px-12_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Cancel</span>
        {:else}
          <span onclick={() => !running && runExport()} onkeydown={(e) => e.key === 'Enter' && !running && runExport()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{running ? 'not-allowed' : 'pointer'};opacity:{running ? 0.6 : 1};font-weight:600">{running ? 'Exporting…' : canStream ? 'Export → file' : 'Export'}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
