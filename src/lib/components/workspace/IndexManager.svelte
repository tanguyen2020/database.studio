<script lang="ts">
  // Index / FK Manager (T29) — per-table tab: list indexes + foreign keys,
  // create/drop each via a form with a live DDL preview, and surface missing-index
  // suggestions (T17). Engine-aware DDL from sql/indexes.ts. Runs the statement
  // then refreshes the lists + the Explorer's table node.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { genAddForeignKey, genCreateIndex, genDropForeignKey, genDropIndex } from '$lib/sql/indexes'
  import type { TabState, IndexInfo, ColumnInfo } from '$lib/types'
  import type { ForeignKey, MissingIndexSuggestion } from '$lib/ipc'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const schema = $derived((tab.state as { schema?: string }).schema ?? '')
  const table = $derived((tab.state as { table?: string }).table ?? '')
  const system = $derived(connections.byId(tab.connectionId)?.system ?? 'postgres')

  let indexes = $state<IndexInfo[]>([])
  let fks = $state<ForeignKey[]>([])
  let cols = $state<ColumnInfo[]>([])
  let tables = $state<string[]>([])
  let suggestions = $state<MissingIndexSuggestion[]>([])
  let error = $state<string | null>(null)
  let busy = $state(false)

  // create-index form
  let ixName = $state('')
  let ixCols = $state<string[]>([])
  let ixUnique = $state(false)
  // add-fk form
  let fkName = $state('')
  let fkFrom = $state('')
  let fkToTable = $state('')
  let fkToCol = $state('')

  const ixDdl = $derived(
    ixCols.length && ixName ? genCreateIndex(system, schema, table, { name: ixName, columns: ixCols, unique: ixUnique }) : '',
  )
  const fkDdl = $derived(
    fkName && fkFrom && fkToTable && fkToCol
      ? genAddForeignKey(system, schema, { name: fkName, from_table: table, from_column: fkFrom, to_table: fkToTable, to_column: fkToCol })
      : '',
  )

  $effect(() => {
    void tab.connectionId
    void table
    untrack(() => void load())
  })

  async function load() {
    const cid = tab.connectionId
    if (!cid) return
    error = null
    try {
      const [ix, allFks, columns, tbls] = await Promise.all([
        ipc.listIndexes(cid, schema, table),
        ipc.listForeignKeys(cid, schema),
        ipc.listColumns(cid, schema, table),
        ipc.listTables(cid, schema).then((t) => t.map((x) => x.name)).catch(() => []),
      ])
      indexes = ix
      fks = allFks.filter((f) => f.from_table === table)
      cols = columns
      tables = tbls
      const scan = await ipc.scanIndexes(cid, schema).catch(() => null)
      suggestions = (scan?.suggestions ?? []).filter((s) => s.table === table)
      ixName = `ix_${table}_`
      fkName = `fk_${table}_`
    } catch (e) {
      error = String(e)
    }
  }

  function toggleIxCol(c: string) {
    ixCols = ixCols.includes(c) ? ixCols.filter((x) => x !== c) : [...ixCols, c]
  }

  async function run(sql: string, label: string) {
    const cid = tab.connectionId
    if (!cid || !sql || busy) return
    busy = true
    try {
      const res = await ipc.execStatement(cid, sql, 0)
      if (!res.ok) {
        toasts.error(`${label} failed: ${res.error?.message ?? 'error'}`, system)
        return
      }
      toasts.success(`${label} ✓`, system)
      await load()
      await explorer.refresh(cid, { kind: 'table', schema, table }).catch(() => {})
    } catch (e) {
      toasts.error(String(e), system)
    } finally {
      busy = false
    }
  }

  const createIndex = () => run(ixDdl, `Create index ${ixName}`)
  const dropIndex = (name: string) => run(genDropIndex(system, schema, table, name), `Drop index ${name}`)
  const addFk = () => run(fkDdl, `Add FK ${fkName}`)
  const dropFk = (name: string) => run(genDropForeignKey(system, schema, table, name), `Drop FK ${name}`)
  function useSuggestion(s: MissingIndexSuggestion) {
    ixCols = [...s.columns]
    ixName = `ix_${table}_${s.columns.join('_')}`.slice(0, 60)
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0;overflow:auto;padding:var(--px-16) var(--px-18);gap:var(--px-14)">
  <div style="font-size:var(--px-15);font-weight:700;color:var(--text)">Indexes & Foreign Keys · {table}</div>
  {#if error}<div style="color:var(--error);font-size:var(--px-12)">{error}</div>{/if}

  {#if suggestions.length}
    <div style="border:var(--px-1) solid var(--warn);border-radius:var(--px-8);padding:var(--px-10);background:var(--panel)">
      <div style="font-size:var(--px-11_5);font-weight:600;color:var(--warn);margin-bottom:var(--px-4)">Missing-index suggestions</div>
      {#each suggestions as s (s.reason)}
        <div style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-11);color:var(--text2);padding:var(--px-2) 0">
          <span class="mono">{s.columns.join(', ') || '(see reason)'}</span>
          <span style="color:var(--muted);flex:1">{s.reason}</span>
          {#if s.columns.length}<span class="eg-btn" role="button" tabindex="0" onclick={() => useSuggestion(s)} onkeydown={(e) => e.key === 'Enter' && useSuggestion(s)}>Use</span>{/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Indexes -->
  <div style="font-size:var(--px-13);font-weight:600;color:var(--text)">Indexes ({indexes.length})</div>
  {#each indexes as ix (ix.name)}
    <div class="mono" style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-11_5);color:var(--text2);border-bottom:var(--px-1) solid var(--border);padding:var(--px-3) 0">
      <span style="font-weight:600;color:var(--text)">{ix.name}</span>
      <span>({ix.columns.join(', ')})</span>
      {#if ix.unique}<span style="color:var(--primary)">UNIQUE</span>{/if}
      {#if ix.primary}<span style="color:var(--muted)">PK</span>{/if}
      <span style="color:var(--muted)">{ix.method}</span>
      {#if !ix.primary}<span class="eg-btn" style="margin-left:auto;color:var(--error)" role="button" tabindex="0" onclick={() => dropIndex(ix.name)} onkeydown={(e) => e.key === 'Enter' && dropIndex(ix.name)}>Drop</span>{/if}
    </div>
  {/each}
  <div style="display:flex;flex-wrap:wrap;align-items:center;gap:var(--px-8);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-10)">
    <input bind:value={ixName} placeholder="index name" class="mono" style="width:var(--px-170);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-11_5)" />
    <label style="font-size:var(--px-11);color:var(--text2)"><input type="checkbox" bind:checked={ixUnique} /> unique</label>
    <div style="display:flex;flex-wrap:wrap;gap:var(--px-4) var(--px-10)">
      {#each cols as c (c.name)}
        <label class="mono" style="font-size:var(--px-11);color:var(--text2)"><input type="checkbox" checked={ixCols.includes(c.name)} onchange={() => toggleIxCol(c.name)} /> {c.name}</label>
      {/each}
    </div>
    <span class="eg-btn" role="button" tabindex="0" aria-disabled={!ixDdl || busy} onclick={createIndex} onkeydown={(e) => e.key === 'Enter' && createIndex()} style="opacity:{ixDdl && !busy ? 1 : 0.5}">Create index</span>
  </div>
  {#if ixDdl}<pre class="mono" style="font-size:var(--px-10_5);color:var(--muted);background:var(--panel);border-radius:var(--px-6);padding:var(--px-8);margin:0;overflow:auto">{ixDdl}</pre>{/if}

  <!-- Foreign keys -->
  <div style="font-size:var(--px-13);font-weight:600;color:var(--text);margin-top:var(--px-6)">Foreign keys ({fks.length})</div>
  {#each fks as fk (fk.name)}
    <div class="mono" style="display:flex;align-items:center;gap:var(--px-8);font-size:var(--px-11_5);color:var(--text2);border-bottom:var(--px-1) solid var(--border);padding:var(--px-3) 0">
      <span style="font-weight:600;color:var(--text)">{fk.name}</span>
      <span>{fk.from_column} → {fk.to_table}.{fk.to_column}</span>
      <span class="eg-btn" style="margin-left:auto;color:var(--error)" role="button" tabindex="0" onclick={() => dropFk(fk.name)} onkeydown={(e) => e.key === 'Enter' && dropFk(fk.name)}>Drop</span>
    </div>
  {/each}
  <div style="display:flex;flex-wrap:wrap;align-items:center;gap:var(--px-8);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-10)">
    <input bind:value={fkName} placeholder="fk name" class="mono" style="width:var(--px-150);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-11_5)" />
    <select bind:value={fkFrom} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text);font-size:var(--px-11)"><option value="">column…</option>{#each cols as c (c.name)}<option value={c.name}>{c.name}</option>{/each}</select>
    <span style="color:var(--muted)">→</span>
    <select bind:value={fkToTable} class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4);color:var(--text);font-size:var(--px-11)"><option value="">table…</option>{#each tables as t (t)}<option value={t}>{t}</option>{/each}</select>
    <input bind:value={fkToCol} placeholder="ref column" class="mono" style="width:var(--px-110);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-8);color:var(--text);font-size:var(--px-11)" />
    <span class="eg-btn" role="button" tabindex="0" aria-disabled={!fkDdl || busy} onclick={addFk} onkeydown={(e) => e.key === 'Enter' && addFk()} style="opacity:{fkDdl && !busy ? 1 : 0.5}">Add FK</span>
  </div>
  {#if fkDdl}<pre class="mono" style="font-size:var(--px-10_5);color:var(--muted);background:var(--panel);border-radius:var(--px-6);padding:var(--px-8);margin:0;overflow:auto">{fkDdl}</pre>{/if}
</div>
