<script lang="ts">
  // CSV Import wizard (Phase 5 · T4) — port modal dòng 1967+. 3 bước: chọn file
  // + preview → mapping cột → options + import. Chạy INSERT qua exec_statement.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { importWizard } from '$lib/stores/import.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { parseCsv } from '$lib/export/rows'
  import { quoteIdent } from '$lib/sql/dialect'
  import { connections } from '$lib/stores/connections.svelte'

  let step = $state(1)
  let fileName = $state('')
  let headers = $state<string[]>([])
  let rows = $state<string[][]>([])
  let delimiter = $state(',')
  let targetTable = $state('')
  let mapping = $state<Record<string, string>>({}) // csvHeader → dbColumn | '—'
  let onConflict = $state<'error' | 'skip'>('error')
  let result = $state<string | null>(null)
  let running = $state(false)

  const system = $derived(connections.byId(importWizard.connId)?.system ?? 'postgres')
  const cache = $derived(importWizard.connId ? explorer.cache[importWizard.connId] : undefined)
  const tables = $derived(cache?.bySchema[importWizard.schema]?.tables ?? [])
  const targetCols = $derived(
    (cache?.bySchema[importWizard.schema]?.tableDetails[targetTable]?.columns ?? []).map((c) => c.name),
  )

  // reset khi mở
  $effect(() => {
    if (importWizard.open) untrack(() => reset())
  })
  function reset() {
    step = 1
    fileName = ''
    headers = []
    rows = []
    targetTable = ''
    mapping = {}
    result = null
  }

  async function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    fileName = file.name
    const text = await file.text()
    const parsed = parseCsv(text, delimiter)
    headers = parsed.headers
    rows = parsed.rows
  }

  async function goMapping() {
    if (!importWizard.connId || !targetTable) return
    // load column detail của bảng đích để map
    await explorer.loadTableDetail(importWizard.connId, importWizard.schema, targetTable)
    // auto-map theo tên (case-insensitive)
    const cols = targetCols
    const m: Record<string, string> = {}
    for (const h of headers) {
      m[h] = cols.find((c) => c.toLowerCase() === h.toLowerCase()) ?? '—'
    }
    mapping = m
    step = 2
  }

  function buildSql(): string {
    const q = (n: string) => quoteIdent(system, n)
    const target = importWizard.schema && system !== 'sqlite' ? `${q(importWizard.schema)}.${q(targetTable)}` : q(targetTable)
    const pairs = headers.map((h, i) => ({ i, col: mapping[h] })).filter((p) => p.col && p.col !== '—')
    const cols = pairs.map((p) => q(p.col)).join(', ')
    const lit = (v: string) => (v === '' ? 'NULL' : /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`)
    const valuesList = rows.map((r) => `(${pairs.map((p) => lit(r[p.i] ?? '')).join(', ')})`).join(',\n  ')
    const conflict = onConflict === 'skip' && system === 'postgres' ? ' ON CONFLICT DO NOTHING' : ''
    return `INSERT INTO ${target} (${cols}) VALUES\n  ${valuesList}${conflict};`
  }

  async function doImport() {
    if (!importWizard.connId) return
    running = true
    result = null
    try {
      const res = await ipc.execStatement(importWizard.connId, buildSql(), 0)
      if (res.ok) {
        result = `✓ ${res.affected ?? rows.length} rows inserted`
        toasts.success(result)
        explorer.refresh(importWizard.connId, { kind: 'table', schema: importWizard.schema, table: targetTable })
      } else {
        result = `✗ ${res.error?.message ?? 'error'}`
      }
    } catch (e) {
      result = `✗ ${e}`
    } finally {
      running = false
      step = 3
    }
  }
</script>

{#if importWizard.open}
  <div onclick={() => importWizard.close()} onkeydown={() => {}} role="presentation" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && importWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-640);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Import CSV → {importWizard.schema || 'table'}</span>
        <span style="font-size:var(--px-11_5);color:var(--muted)">Step {step} / 3</span>
        <span onclick={() => importWizard.close()} onkeydown={(e) => e.key === 'Enter' && importWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        {#if step === 1}
          <label style="font-size:var(--px-12);color:var(--text2)">CSV file
            <input type="file" accept=".csv,text/csv" onchange={onFile} style="display:block;margin-top:var(--px-6)" />
          </label>
          <label style="font-size:var(--px-12);color:var(--text2)">Delimiter
            <select bind:value={delimiter} style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)">
              <option value=",">, (comma)</option><option value=";">; (semicolon)</option><option value={'\t'}>tab</option>
            </select>
          </label>
          {#if headers.length}
            <div style="font-size:var(--px-11);color:var(--muted)">Preview ({rows.length} rows)</div>
            <div style="overflow:auto;border:var(--px-1) solid var(--border);border-radius:var(--px-6)">
              <table class="mono" style="border-collapse:collapse;font-size:var(--px-11)">
                <thead><tr>{#each headers as h (h)}<th style="padding:var(--px-4) var(--px-8);border-bottom:var(--px-1) solid var(--border2);text-align:left;color:var(--text2)">{h}</th>{/each}</tr></thead>
                <tbody>{#each rows.slice(0, 5) as r, ri (ri)}<tr>{#each r as cell, ci (ci)}<td style="padding:var(--px-3) var(--px-8);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{cell}</td>{/each}</tr>{/each}</tbody>
              </table>
            </div>
            <label style="font-size:var(--px-12);color:var(--text2)">Target table
              <select bind:value={targetTable} style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)">
                <option value="">—</option>
                {#each tables as t (t.name)}<option value={t.name}>{t.name}</option>{/each}
              </select>
            </label>
          {/if}
        {:else if step === 2}
          <div style="font-size:var(--px-12);color:var(--text2)">Map CSV columns → {targetTable}</div>
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
          <label style="font-size:var(--px-12);color:var(--text2);margin-top:var(--px-6)">On conflict
            <select bind:value={onConflict} style="margin-left:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)">
              <option value="error">Error</option><option value="skip">Skip (ON CONFLICT DO NOTHING)</option>
            </select>
          </label>
        {:else}
          <div style="font-size:var(--px-14);color:{result?.startsWith('✓') ? '#27AE60' : 'var(--error)'};text-align:center;padding:var(--px-20)">{result}</div>
        {/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        {#if step === 1}
          <span onclick={goMapping} onkeydown={(e) => e.key === 'Enter' && goMapping()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:{targetTable ? 'var(--primary)' : 'var(--panel)'};color:{targetTable ? 'var(--hex-fff)' : 'var(--muted)'};border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Next</span>
        {:else if step === 2}
          <span onclick={() => (step = 1)} onkeydown={(e) => e.key === 'Enter' && (step = 1)} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Back</span>
          <span onclick={doImport} onkeydown={(e) => e.key === 'Enter' && doImport()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">{running ? 'Importing…' : `Import ${rows.length} rows`}</span>
        {:else}
          <span onclick={() => importWizard.close()} onkeydown={(e) => e.key === 'Enter' && importWizard.close()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Done</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
