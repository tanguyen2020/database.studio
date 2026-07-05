<script lang="ts">
  // Copy Table to… (T25). Copies a source table's structure + data to another
  // connection/schema: translates the CREATE DDL to the destination dialect
  // (dry-run preview), then copies data page-by-page (bounded memory) with
  // progress + cancel, and verifies the destination row count.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { copyWizard } from '$lib/stores/copy.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { buildCopyDdl } from '$lib/copy/types'
  import { buildExportSelect, supportsOffset } from '$lib/export/query'
  import { buildInsert } from '$lib/import/plan'
  import type { ColumnInfo } from '$lib/types'

  const REL = ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse', 'sqlite']
  const PAGE = 2000

  let srcCols = $state<ColumnInfo[]>([])
  let destConnId = $state('')
  let destSchema = $state('')
  let destTable = $state('')
  let running = $state(false)
  let cancelFlag = $state(false)
  let copied = $state(0)
  let result = $state<string | null>(null)

  // effect-mirror the store open flag (reliable cross-component tracking; see T31 note)
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = copyWizard.open
  })
  const srcSystem = $derived(connections.byId(copyWizard.srcConnId)?.system ?? 'postgres')
  const destSystem = $derived(connections.byId(destConnId)?.system ?? 'postgres')
  const destTargets = $derived(connections.profiles.filter((p) => p.connected && REL.includes(p.system)))
  const ddl = $derived(
    srcCols.length && destConnId
      ? buildCopyDdl(destSystem, destSchema, destTable || copyWizard.srcTable, srcCols)
      : '-- pick a destination connection to preview the CREATE TABLE',
  )

  $effect(() => {
    if (copyWizard.open) untrack(() => void init())
  })
  async function init() {
    running = false
    cancelFlag = false
    copied = 0
    result = null
    destConnId = ''
    destSchema = srcSystem === 'sqlite' ? 'main' : copyWizard.srcSchema
    destTable = copyWizard.srcTable
    srcCols = []
    if (copyWizard.srcConnId) {
      srcCols = await ipc.listColumns(copyWizard.srcConnId, copyWizard.srcSchema, copyWizard.srcTable).catch(() => [])
    }
  }

  function pickDest(id: string) {
    destConnId = id
    const sys = connections.byId(id)?.system
    if (sys === 'sqlite') destSchema = 'main'
  }

  async function run() {
    const src = copyWizard.srcConnId
    if (!src || !destConnId || !srcCols.length) return
    const table = destTable || copyWizard.srcTable
    const cols = srcCols.map((c) => c.name)
    running = true
    cancelFlag = false
    copied = 0
    result = null
    try {
      // 1. Create the destination table (translated DDL).
      const create = await ipc.execStatement(destConnId, ddl, 0)
      if (!create.ok) {
        result = `✗ create failed: ${create.error?.message ?? 'error'}`
        return
      }
      // 2. Copy data page by page (bounded memory).
      let offset = 0
      const paged = supportsOffset(srcSystem)
      for (;;) {
        if (cancelFlag) {
          result = `✗ cancelled after ${copied.toLocaleString()} rows`
          return
        }
        const sql = buildExportSelect({ system: srcSystem, schema: copyWizard.srcSchema, table: copyWizard.srcTable, columns: cols, limit: PAGE, offset })
        const res = await ipc.execStatement(src, sql, 0)
        if (!res.ok) {
          result = `✗ read failed: ${res.error?.message ?? 'error'}`
          return
        }
        const rows = (res.result?.rows ?? []) as Record<string, unknown>[]
        if (rows.length === 0) break
        const values = rows.map((r) => cols.map((c) => (r[c] == null ? null : String(r[c]))))
        const insert = buildInsert({ system: destSystem, schema: destSchema, table, columns: cols, rows: values, mode: 'error' })
        const ins = await ipc.execStatement(destConnId, insert, 0)
        if (!ins.ok) {
          result = `✗ insert failed after ${copied.toLocaleString()} rows: ${ins.error?.message ?? 'error'}`
          return
        }
        copied += rows.length
        if (!paged || rows.length < PAGE) break
        offset += rows.length
      }
      // 3. Verify destination row count.
      const target = destSchema && destSystem !== 'sqlite' ? `"${destSchema}"."${table}"` : `"${table}"`
      const check = await ipc.execStatement(destConnId, `SELECT count(*) AS n FROM ${target}`, 0)
      const destCount = Number((check.result?.rows?.[0] as Record<string, unknown>)?.n ?? -1)
      result = `✓ copied ${copied.toLocaleString()} rows → ${table} (destination count: ${destCount.toLocaleString()})`
      toasts.success(result)
    } catch (e) {
      result = `✗ ${e}`
    } finally {
      running = false
    }
  }
</script>

{#if dlgOpen}
  <div onclick={() => !running && copyWizard.close()} onkeydown={() => {}} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !running && copyWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-640);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Copy {copyWizard.srcTable} to…</span>
        <span onclick={() => !running && copyWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && copyWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-12)">
        <div style="display:flex;gap:var(--px-12);flex-wrap:wrap">
          <label style="font-size:var(--px-12);color:var(--text2);flex:1;min-width:var(--px-220)">Destination connection
            <select value={destConnId} onchange={(e) => pickDest((e.target as HTMLSelectElement).value)} class="mono" style="display:block;margin-top:var(--px-5);width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);font-size:var(--px-12)">
              <option value="">— choose —</option>
              {#each destTargets as p (p.id)}<option value={p.id}>{p.name} ({p.system})</option>{/each}
            </select>
          </label>
          <label style="font-size:var(--px-12);color:var(--text2)">Schema
            <input bind:value={destSchema} class="mono" style="display:block;margin-top:var(--px-5);width:var(--px-120);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);font-size:var(--px-12)" />
          </label>
          <label style="font-size:var(--px-12);color:var(--text2)">Table
            <input bind:value={destTable} class="mono" style="display:block;margin-top:var(--px-5);width:var(--px-150);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);color:var(--text);font-size:var(--px-12)" />
          </label>
        </div>
        <div style="font-size:var(--px-12);color:var(--text2)">DDL preview (destination dialect)</div>
        <pre class="selectable mono" style="max-height:var(--px-200);overflow:auto;border-radius:var(--px-8);background:var(--panel);border:var(--px-1) solid var(--border);padding:var(--px-12);font-size:var(--px-11_5);line-height:1.5;margin:0">{ddl}</pre>
        {#if running}
          <div style="font-size:var(--px-12);color:var(--text2)">Copying… {copied.toLocaleString()} rows</div>
        {/if}
        {#if result !== null}
          <div style="font-size:var(--px-13);color:{result.startsWith('✓') ? '#27AE60' : 'var(--error)'};padding:var(--px-8)">{result}</div>
        {/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !running && copyWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && copyWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Close</span>
        {#if running}
          <span onclick={() => (cancelFlag = true)} onkeydown={(e) => e.key === 'Enter' && (cancelFlag = true)} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--error);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:pointer;font-weight:600">Cancel</span>
        {:else}
          <span onclick={run} onkeydown={(e) => e.key === 'Enter' && run()} role="button" tabindex="0" aria-disabled={!destConnId} style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{destConnId ? 'pointer' : 'not-allowed'};opacity:{destConnId ? 1 : 0.5};font-weight:600">Copy</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
