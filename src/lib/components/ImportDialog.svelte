<script lang="ts">
  // Import wizard (Phase 5 · T4 + T13) — port modal dòng 1967+. 3 bước:
  //   1) Source: format CSV/JSON + file + delimiter/encoding/header (CSV) + preview + target
  //   2) Mapping cột
  //   3) Options (batch size + on-conflict) → Import (batched, progress bar) → result
  // Import chạy theo BATCH qua exec_statement để không dựng 1 câu INSERT khổng lồ;
  // ClickHouse ép batch + tắt on-conflict (append-only). SQL sinh ở $lib/import/plan.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { importWizard } from '$lib/stores/import.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { parseCsv } from '$lib/export/rows'
  import { connections } from '$lib/stores/connections.svelte'
  import {
    buildInsert,
    chunk,
    conflictSupported,
    parseJson,
    type ConflictMode,
    type ImportFormat,
  } from '$lib/import/plan'

  let step = $state(1)
  let format = $state<ImportFormat>('csv')
  let fileBuf = $state<ArrayBuffer | null>(null)
  let fileName = $state('')
  let fileInputEl = $state<HTMLInputElement | null>(null)
  let headers = $state<string[]>([])
  let rows = $state<string[][]>([])
  let delimiter = $state(',')
  let encoding = $state('utf-8')
  let hasHeader = $state(true)
  let targetTable = $state('')
  let mapping = $state<Record<string, string>>({}) // csvHeader → dbColumn | '—'
  let onConflict = $state<ConflictMode>('error')
  let batchSize = $state(1000)
  let parseError = $state<string | null>(null)
  let result = $state<string | null>(null)
  let running = $state(false)
  let progress = $state({ done: 0, total: 0 }) // rows inserted / total

  const system = $derived(connections.byId(importWizard.connId)?.system ?? 'postgres')
  // MongoDB is schemaless: the target collection is pre-set and CSV/JSON headers
  // become document fields directly (no column mapping against a fixed schema).
  const isMongo = $derived(system === 'mongodb')
  const conflictOk = $derived(conflictSupported(system))
  const cache = $derived(importWizard.connId ? explorer.cache[importWizard.connId] : undefined)
  const tables = $derived(cache?.bySchema[importWizard.schema]?.tables ?? [])
  const targetCols = $derived(
    (cache?.bySchema[importWizard.schema]?.tableDetails[targetTable]?.columns ?? []).map((c) => c.name),
  )
  const pct = $derived(progress.total ? Math.round((progress.done / progress.total) * 100) : 0)

  // reset khi mở
  $effect(() => {
    if (importWizard.open) untrack(() => reset())
  })
  // ClickHouse: on-conflict không áp dụng → ép về 'error'
  $effect(() => {
    if (!conflictOk && onConflict !== 'error') untrack(() => (onConflict = 'error'))
  })
  function reset() {
    step = 1
    format = 'csv'
    fileBuf = null
    fileName = ''
    headers = []
    rows = []
    delimiter = ','
    encoding = 'utf-8'
    hasHeader = true
    targetTable = importWizard.table // MongoDB: pre-set collection; relational: '' (chosen below)
    mapping = {}
    onConflict = 'error'
    batchSize = 1000
    parseError = null
    result = null
    progress = { done: 0, total: 0 }
  }

  async function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    fileName = file.name
    fileBuf = await file.arrayBuffer()
    if (/\.json$/i.test(file.name)) format = 'json'
    parseFile()
  }

  function parseFile() {
    if (!fileBuf) return
    parseError = null
    try {
      const text = new TextDecoder(encoding).decode(fileBuf)
      if (format === 'json') {
        const parsed = parseJson(text)
        headers = parsed.headers
        rows = parsed.rows
      } else {
        const parsed = parseCsv(text, delimiter)
        if (hasHeader) {
          headers = parsed.headers
          rows = parsed.rows
        } else {
          // không có dòng tiêu đề → tự sinh col_1..col_N, dòng đầu là dữ liệu
          const n = parsed.headers.length
          headers = Array.from({ length: n }, (_, i) => `col_${i + 1}`)
          rows = [parsed.headers, ...parsed.rows]
        }
      }
    } catch (err) {
      headers = []
      rows = []
      parseError = String(err)
    }
  }

  async function goMapping() {
    if (!importWizard.connId || !targetTable) return
    // MongoDB: no fixed columns — map each header to itself and skip the mapping
    // step; the fields go straight into the documents.
    if (isMongo) {
      mapping = Object.fromEntries(headers.map((h) => [h, h]))
      step = 3
      return
    }
    await explorer.loadTableDetail(importWizard.connId, importWizard.schema, targetTable)
    const cols = targetCols
    const m: Record<string, string> = {}
    for (const h of headers) {
      m[h] = cols.find((c) => c.toLowerCase() === h.toLowerCase()) ?? '—'
    }
    mapping = m
    step = 2
  }

  /** columns đã map (bỏ skip) + rows tương ứng theo đúng thứ tự cột. */
  function mappedPlan() {
    const pairs = headers.map((h, i) => ({ i, col: mapping[h] })).filter((p) => p.col && p.col !== '—')
    const columns = pairs.map((p) => p.col)
    const mappedRows = rows.map((r) => pairs.map((p) => r[p.i] ?? ''))
    return { columns, mappedRows }
  }

  async function doImport() {
    if (!importWizard.connId) return
    const { columns, mappedRows } = mappedPlan()
    if (!columns.length) {
      toasts.error('No columns mapped')
      return
    }
    running = true
    result = null
    progress = { done: 0, total: mappedRows.length }
    const batches = chunk(mappedRows, batchSize)
    let inserted = 0
    // MongoDB: batched insertMany. JSON is re-parsed from the file so nested
    // objects/arrays and real types survive (the header/row pipeline flattens
    // them to strings). CSV cells are coerced conservatively — leading-zero
    // strings (zip/ids) and integers beyond 2^53 stay strings to avoid silent loss.
    if (isMongo) {
      const coerce = (v: string): unknown => {
        if (v === '') return null
        if (v === 'true') return true
        if (v === 'false') return false
        if (v === '0' || /^-?[1-9]\d*$/.test(v)) {
          const n = Number(v)
          return Number.isSafeInteger(n) ? n : v
        }
        if (/^-?(?:0|[1-9]\d*)\.\d+$/.test(v)) return Number(v)
        return v
      }
      let docs: unknown[]
      if (format === 'json' && fileBuf) {
        try {
          const parsed = JSON.parse(new TextDecoder(encoding).decode(fileBuf))
          docs = Array.isArray(parsed) ? parsed : [parsed]
        } catch (e) {
          result = `✗ invalid JSON: ${e}`
          running = false
          return
        }
      } else {
        docs = mappedRows.map((r) => Object.fromEntries(columns.map((c, i) => [c, coerce(String(r[i] ?? ''))])))
      }
      progress = { done: 0, total: docs.length }
      try {
        for (let i = 0; i < docs.length; i += batchSize) {
          const batch = docs.slice(i, i + batchSize)
          const q = `db.${targetTable}.insertMany(${JSON.stringify(batch)})`
          const res = await ipc.mongoExec(importWizard.connId, q, importWizard.schema)
          if (res.error) {
            result = `✗ ${res.error.message} (sau ${inserted} docs)`
            return
          }
          inserted += res.affected ?? batch.length
          progress = { done: inserted, total: docs.length }
        }
        result = `✓ ${inserted} documents inserted`
        toasts.success(result)
      } catch (e) {
        result = `✗ ${e} (sau ${inserted} docs)`
      } finally {
        running = false
      }
      return
    }
    try {
      for (const batch of batches) {
        const sql = buildInsert({
          system,
          schema: importWizard.schema,
          table: targetTable,
          columns,
          rows: batch,
          mode: onConflict,
        })
        const res = await ipc.execStatement(importWizard.connId, sql, 0)
        if (!res.ok) {
          result = `✗ ${res.error?.message ?? 'error'} (sau ${inserted} rows)`
          return
        }
        inserted += res.affected ?? batch.length
        progress = { done: inserted, total: mappedRows.length }
      }
      result = `✓ ${inserted} rows inserted (${batches.length} batch)`
      toasts.success(result)
      explorer.refresh(importWizard.connId, { kind: 'table', schema: importWizard.schema, table: targetTable })
    } catch (e) {
      result = `✗ ${e} (sau ${inserted} rows)`
    } finally {
      running = false
    }
  }
</script>

{#if importWizard.open}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !running && importWizard.close()} role="presentation" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !running && importWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-640);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Import {format.toUpperCase()} → {importWizard.schema || 'table'}</span>
        <span style="font-size:var(--px-11_5);color:var(--muted)">Step {step} / 3</span>
        <span onclick={() => !running && importWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && importWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        {#if step === 1}
          <div style="display:flex;gap:var(--px-16);font-size:var(--px-12);color:var(--text2)">
            Format
            <label style="display:flex;align-items:center;gap:var(--px-5);cursor:pointer"><input type="radio" name="fmt" value="csv" checked={format === 'csv'} onchange={() => { format = 'csv'; parseFile() }} /> CSV</label>
            <label style="display:flex;align-items:center;gap:var(--px-5);cursor:pointer"><input type="radio" name="fmt" value="json" checked={format === 'json'} onchange={() => { format = 'json'; parseFile() }} /> JSON</label>
          </div>
          <div style="font-size:var(--px-12);color:var(--text2)">
            {format === 'json' ? 'JSON' : 'CSV'} file
            <div style="display:flex;align-items:center;gap:var(--px-8);margin-top:var(--px-6)">
              <input
                bind:this={fileInputEl}
                type="file"
                accept={format === 'json' ? '.json,application/json' : '.csv,text/csv'}
                onchange={onFile}
                style="display:none"
              />
              <button
                type="button"
                onclick={() => fileInputEl?.click()}
                style="flex:none;font-size:var(--px-12);font-weight:600;background:var(--panel);border:var(--px-1) solid var(--border2);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);color:var(--text);cursor:pointer"
              >Choose file…</button>
              <input
                type="text"
                readonly
                value={fileName}
                placeholder="No file selected"
                title={fileName}
                class="mono"
                style="flex:1;min-width:0;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-10);color:{fileName ? 'var(--text)' : 'var(--muted)'};outline:none;text-overflow:ellipsis"
              />
            </div>
          </div>
          <div style="display:flex;gap:var(--px-16);flex-wrap:wrap;align-items:center">
            {#if format === 'csv'}
              <label style="font-size:var(--px-12);color:var(--text2)">Delimiter
                <select bind:value={delimiter} onchange={parseFile} style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)">
                  <option value=",">, (comma)</option><option value=";">; (semicolon)</option><option value={'\t'}>tab</option>
                </select>
              </label>
              <label style="display:flex;align-items:center;gap:var(--px-6);font-size:var(--px-12);color:var(--text2);cursor:pointer">
                <input type="checkbox" bind:checked={hasHeader} onchange={parseFile} /> First row is header
              </label>
            {/if}
            <label style="font-size:var(--px-12);color:var(--text2)">Encoding
              <select bind:value={encoding} onchange={parseFile} style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)">
                <option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="windows-1252">Windows-1252</option>
              </select>
            </label>
          </div>
          {#if parseError}
            <div style="font-size:var(--px-11_5);color:var(--error)">Parse error: {parseError}</div>
          {/if}
          {#if headers.length}
            <div style="font-size:var(--px-11);color:var(--muted)">Preview ({rows.length} rows)</div>
            <div style="overflow:auto;border:var(--px-1) solid var(--border);border-radius:var(--px-6)">
              <table class="mono" style="border-collapse:collapse;font-size:var(--px-11)">
                <thead><tr>{#each headers as h (h)}<th style="padding:var(--px-4) var(--px-8);border-bottom:var(--px-1) solid var(--border2);text-align:left;color:var(--text2)">{h}</th>{/each}</tr></thead>
                <tbody>{#each rows.slice(0, 5) as r, ri (ri)}<tr>{#each r as cell, ci (ci)}<td style="padding:var(--px-3) var(--px-8);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{cell}</td>{/each}</tr>{/each}</tbody>
              </table>
            </div>
            {#if isMongo}
              <div style="font-size:var(--px-12);color:var(--text2)">Target collection <span class="mono" style="color:var(--text)">{targetTable}</span> — headers become document fields</div>
            {:else}
              <label style="font-size:var(--px-12);color:var(--text2)">Target table
                <select bind:value={targetTable} style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)">
                  <option value="">—</option>
                  {#each tables as t (t.name)}<option value={t.name}>{t.name}</option>{/each}
                </select>
              </label>
            {/if}
          {/if}
        {:else if step === 2}
          <div style="font-size:var(--px-12);color:var(--text2)">Map columns → {targetTable}</div>
          {#each headers as h (h)}
            <div style="display:flex;align-items:center;gap:var(--px-10)">
              <span class="mono" style="width:var(--px-150);font-size:var(--px-12);color:var(--text2)">{h}</span>
              <span style="color:var(--muted)">→</span>
              <select bind:value={mapping[h]} style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text);font-size:var(--px-12)">
                <option value="—">— skip —</option>
                {#each targetCols as c (c)}<option value={c}>{c}</option>{/each}
              </select>
            </div>
          {/each}
        {:else if step === 3 && !running && result === null}
          <!-- Options step -->
          <div style="font-size:var(--px-13);font-weight:600;color:var(--text)">Options</div>
          <label style="font-size:var(--px-12);color:var(--text2)">Batch size (rows / INSERT)
            <input type="number" min="1" bind:value={batchSize} style="margin-left:var(--px-8);width:var(--px-90);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)" />
          </label>
          <label style="font-size:var(--px-12);color:{conflictOk ? 'var(--text2)' : 'var(--muted)'}">On conflict
            <select bind:value={onConflict} disabled={!conflictOk} style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text);opacity:{conflictOk ? 1 : 0.5}">
              <option value="error">Error on duplicate</option>
              <option value="skip">Skip duplicates</option>
            </select>
          </label>
          {#if !conflictOk}
            <div style="font-size:var(--px-11);color:var(--muted)">{system === 'clickhouse' ? 'ClickHouse: append-only — on-conflict does not apply, INSERT is always batched.' : 'This engine does not support skip-duplicate within a single INSERT.'}</div>
          {/if}
        {:else}
          <!-- progress + result -->
          {#if running || progress.total > 0}
            <div style="font-size:var(--px-12);color:var(--text2)">{running ? 'Importing' : 'Done'} — {progress.done} / {progress.total} rows ({pct}%)</div>
            <div style="height:var(--px-10);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);overflow:hidden">
              <div style="height:100%;width:{pct}%;background:var(--primary);transition:width .15s"></div>
            </div>
          {/if}
          {#if result !== null}
            <div style="font-size:var(--px-14);color:{result.startsWith('✓') ? '#27AE60' : 'var(--error)'};text-align:center;padding:var(--px-16)">{result}</div>
          {/if}
        {/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        {#if step === 1}
          <span onclick={goMapping} onkeydown={(e) => e.key === 'Enter' && goMapping()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:{targetTable ? 'var(--primary)' : 'var(--panel)'};color:{targetTable ? 'var(--hex-fff)' : 'var(--muted)'};border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Next</span>
        {:else if step === 2}
          <span onclick={() => (step = 1)} onkeydown={(e) => e.key === 'Enter' && (step = 1)} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Back</span>
          <span onclick={() => (step = 3)} onkeydown={(e) => e.key === 'Enter' && (step = 3)} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Next</span>
        {:else if step === 3 && result === null}
          <span onclick={() => !running && (step = 2)} onkeydown={(e) => e.key === 'Enter' && !running && (step = 2)} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:{running ? 'not-allowed' : 'pointer'};opacity:{running ? 0.5 : 1}">Back</span>
          <span onclick={() => !running && doImport()} onkeydown={(e) => e.key === 'Enter' && !running && doImport()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{running ? 'not-allowed' : 'pointer'};opacity:{running ? 0.6 : 1};font-weight:600">{running ? `Importing… ${pct}%` : `Import ${rows.length} rows`}</span>
        {:else}
          <span onclick={() => importWizard.close()} onkeydown={(e) => e.key === 'Enter' && importWizard.close()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Done</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
