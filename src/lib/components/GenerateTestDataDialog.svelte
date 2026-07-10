<script lang="ts">
  // Generate Test Data (T26). Per-column generator + row count + preview, then
  // batched INSERTs. FK columns pull values from the parent's key pool; NOT NULL
  // and UNIQUE are respected by the pure generator (testdata/generate.ts).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { testDataWizard } from '$lib/stores/testdata.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { generateRows, type ColumnGen, type GenKind } from '$lib/testdata/generate'
  import { buildInsert, chunk } from '$lib/import/plan'
  import { buildExportSelect } from '$lib/export/query'
  import { quoteIdent } from '$lib/sql/dialect'
  import type { ForeignKey } from '$lib/ipc'
  import type { ColumnInfo } from '$lib/types'

  const KINDS: GenKind[] = ['sequence', 'number', 'decimal', 'bool', 'name', 'email', 'phone', 'date', 'timestamp', 'uuid', 'enum', 'text', 'fk', 'null']

  let cols = $state<ColumnInfo[]>([])
  let fks = $state<ForeignKey[]>([])
  let kind = $state<Record<string, GenKind>>({})
  // explicit value set (comma-separated) per column — used by enum / fk / bool
  let vals = $state<Record<string, string>>({})
  // whether to generate a value for the column; identity/auto-increment columns
  // default to OFF so the engine assigns them.
  let include = $state<Record<string, boolean>>({})
  let count = $state(100)
  let running = $state(false)
  let done = $state(0)
  let result = $state<string | null>(null)

  // effect-mirror the store open flag (reliable cross-component tracking; see T31 note)
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = testDataWizard.open
  })
  const system = $derived(connections.byId(testDataWizard.connId)?.system ?? 'postgres')
  const fkOf = $derived(new Map(fks.filter((f) => f.from_table === testDataWizard.table).map((f) => [f.from_column, f])))

  function defaultKind(c: ColumnInfo): GenKind {
    if (fkOf.has(c.name)) return 'fk'
    const n = c.name.toLowerCase()
    const t = c.data_type.toLowerCase()
    if (c.is_pk && /int|serial/.test(t)) return 'sequence'
    if (n.includes('email')) return 'email'
    if (n.includes('phone')) return 'phone'
    if (n.includes('name')) return 'name'
    if (n.includes('uuid') || /uuid/.test(t)) return 'uuid'
    if (/bool|bit/.test(t)) return 'bool'
    if (/timestamp|datetime/.test(t)) return 'timestamp'
    if (/date/.test(t)) return 'date'
    if (/numeric|decimal|real|double|float/.test(t)) return 'decimal'
    if (/int/.test(t)) return 'number'
    return 'text'
  }

  $effect(() => {
    if (testDataWizard.open) untrack(() => void init())
  })
  async function init() {
    running = false
    done = 0
    result = null
    count = 100
    vals = {}
    const cid = testDataWizard.connId
    if (!cid) return
    cols = await ipc.listColumns(cid, testDataWizard.schema, testDataWizard.table).catch(() => [])
    fks = await ipc.listForeignKeys(cid, testDataWizard.schema).catch(() => [])
    const k: Record<string, GenKind> = {}
    const inc: Record<string, boolean> = {}
    for (const c of cols) {
      k[c.name] = defaultKind(c)
      // Auto-increment/identity columns are excluded by default (the DB fills them).
      inc[c.name] = !c.auto_increment
    }
    kind = k
    include = inc
  }

  // Columns that will actually be generated + inserted.
  const activeCols = $derived(cols.filter((c) => include[c.name] !== false))
  // Kinds that accept an explicit value list (comma-separated).
  const takesValues = (k: GenKind) => k === 'enum' || k === 'fk' || k === 'bool'
  function parsedValues(name: string): string[] | undefined {
    const raw = vals[name]
    if (!raw) return undefined
    const arr = raw.split(',').map((s) => s.trim()).filter(Boolean)
    return arr.length ? arr : undefined
  }

  function specFor(c: ColumnInfo, pool?: (string | number)[]): ColumnGen {
    return {
      name: c.name,
      kind: kind[c.name] ?? 'text',
      nullable: c.nullable,
      unique: c.is_pk,
      values: parsedValues(c.name),
      pool,
    }
  }

  // Preview a handful of rows client-side (no DB writes). FK columns without an
  // explicit value list preview against a dummy pool.
  const preview = $derived.by(() => {
    if (!activeCols.length) return { columns: [] as string[], rows: [] as (string | number | null)[][] }
    return generateRows(
      activeCols.map((c) => specFor(c, fkOf.has(c.name) && !parsedValues(c.name) ? [1, 2, 3] : undefined)),
      Math.min(5, count),
      7,
      system,
    )
  })

  async function run() {
    const cid = testDataWizard.connId
    if (!cid || !activeCols.length || count < 1) return
    running = true
    done = 0
    result = null
    try {
      // Fetch FK parent pools so generated FK values reference real parent rows.
      // Skipped when the user supplied explicit values for that FK column.
      const pools: Record<string, (string | number)[]> = {}
      for (const c of activeCols) {
        const fk = fkOf.get(c.name)
        if (!fk || parsedValues(c.name)) continue
        const q = quoteIdent(system, fk.to_column)
        const sql = buildExportSelect({ system, schema: testDataWizard.schema, table: fk.to_table, columns: [fk.to_column], limit: 5000 })
        const res = await ipc.execStatement(cid, `SELECT DISTINCT ${q} FROM (${sql.replace(/;?\s*$/, '')}) _p`, 0)
        pools[c.name] = ((res.result?.rows ?? []) as Record<string, unknown>[]).map((r) => r[fk.to_column] as string | number).filter((v) => v != null)
        if (pools[c.name].length === 0) {
          result = `✗ ${c.name}: parent ${fk.to_table} has no rows to reference — seed it first`
          return
        }
      }
      const specs = activeCols.map((c) => specFor(c, pools[c.name]))
      const { columns, rows } = generateRows(specs, count, 1, system)
      const target = testDataWizard.table
      for (const batch of chunk(rows, 1000)) {
        const insert = buildInsert({ system, schema: testDataWizard.schema, table: target, columns, rows: batch as (string | null)[][], mode: 'error' })
        const res = await ipc.execStatement(cid, insert, 0)
        if (!res.ok) {
          result = `✗ insert failed after ${done.toLocaleString()} rows: ${res.error?.message ?? 'error'}`
          return
        }
        done += batch.length
      }
      result = `✓ generated ${done.toLocaleString()} rows into ${target}`
      toasts.success(result)
    } catch (e) {
      result = `✗ ${e}`
    } finally {
      running = false
    }
  }
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing input); use × / Cancel / Escape -->
  <div onkeydown={(e) => e.key === 'Escape' && !running && testDataWizard.close()} role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56">
    <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && !running && testDataWizard.close()} role="dialog" aria-modal="true" tabindex="-1" style="width:var(--px-840);max-width:95vw;max-height:90vh;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column">
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">Generate test data · {testDataWizard.table}</span>
        <span onclick={() => !running && testDataWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && testDataWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>
      <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <label style="font-size:var(--px-12);color:var(--text2)">Rows
          <input type="number" min="1" max="1000000" bind:value={count} style="margin-left:var(--px-8);width:var(--px-110);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text)" />
        </label>
        <div style="font-size:var(--px-11);color:var(--muted)">Per-column generator <span style="color:var(--muted)">— untick a column to let the database assign it (identity / auto-increment)</span></div>
        <div style="display:flex;flex-direction:column;gap:var(--px-4);max-height:var(--px-300);overflow:auto;border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-8)">
          {#each cols as c (c.name)}
            {@const off = include[c.name] === false}
            <div style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-11_5);opacity:{off ? 0.5 : 1}">
              <input type="checkbox" bind:checked={include[c.name]} title="Include this column in the generated INSERT" style="flex:none" />
              <span class="mono" style="width:var(--px-200);color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="{c.name} {c.data_type}">{c.name} <span style="color:var(--muted)">{c.data_type}{c.is_pk ? ' PK' : ''}{fkOf.has(c.name) ? ' FK' : ''}{c.auto_increment ? ' AUTO' : ''}</span></span>
              <select bind:value={kind[c.name]} disabled={off} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-4);padding:0 var(--px-4);color:var(--text);font-size:var(--px-11);flex:none">
                {#each KINDS as k (k)}<option value={k}>{k}</option>{/each}
              </select>
              {#if takesValues(kind[c.name])}
                <input
                  bind:value={vals[c.name]}
                  disabled={off}
                  placeholder={kind[c.name] === 'enum' ? 'values: a, b, c' : kind[c.name] === 'bool' ? 'true, false' : 'FK values (optional, comma-separated)'}
                  class="mono"
                  style="flex:1;min-width:var(--px-160);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-4);padding:0 var(--px-6);color:var(--text);font-size:var(--px-11)"
                />
              {/if}
            </div>
          {/each}
        </div>
        {#if preview.rows.length}
          <div style="font-size:var(--px-11);color:var(--muted)">Preview (first {preview.rows.length})</div>
          <div style="overflow:auto;border:var(--px-1) solid var(--border);border-radius:var(--px-6)">
            <table class="mono" style="border-collapse:collapse;font-size:var(--px-10_5)">
              <thead><tr>{#each preview.columns as h (h)}<th style="padding:var(--px-3) var(--px-8);border-bottom:var(--px-1) solid var(--border2);text-align:left;color:var(--text2)">{h}</th>{/each}</tr></thead>
              <tbody>{#each preview.rows as r, ri (ri)}<tr>{#each r as cell, ci (ci)}<td style="padding:var(--px-2) var(--px-8);border-bottom:var(--px-1) solid var(--border);color:var(--muted);white-space:nowrap">{cell === null ? 'NULL' : cell}</td>{/each}</tr>{/each}</tbody>
            </table>
          </div>
        {/if}
        {#if running}<div style="font-size:var(--px-12);color:var(--text2)">Inserting… {done.toLocaleString()} rows</div>{/if}
        {#if result !== null}<div style="font-size:var(--px-13);color:{result.startsWith('✓') ? '#27AE60' : 'var(--error)'};padding:var(--px-6) 0">{result}</div>{/if}
      </div>
      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-13) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span onclick={() => !running && testDataWizard.close()} onkeydown={(e) => e.key === 'Enter' && !running && testDataWizard.close()} role="button" tabindex="0" style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer">Close</span>
        <span onclick={() => !running && run()} onkeydown={(e) => e.key === 'Enter' && !running && run()} role="button" tabindex="0" style="margin-left:auto;font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{running ? 'not-allowed' : 'pointer'};opacity:{running ? 0.6 : 1};font-weight:600">{running ? 'Generating…' : 'Generate'}</span>
      </div>
    </div>
  </div>
{/if}
