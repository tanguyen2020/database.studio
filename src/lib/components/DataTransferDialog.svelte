<script lang="ts">
  // Data Transfer — copy several tables (structure + data) from one connection to
  // another (or another schema on the same one). Builds on Copy Table (T25): the
  // plan orders tables so a parent is created before its child (copy/plan.ts),
  // then each step runs the same paged read→insert→verify loop with a shared
  // progress + Stop. Frontend-orchestrated (two connections, no backend command).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { transferWizard } from '$lib/stores/transfer.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { planTransfer, type TransferMode, type TransferStep } from '$lib/copy/plan'
  import { buildExportSelect, supportsOffset } from '$lib/export/query'
  import { buildInsert } from '$lib/import/plan'
  import { qualified, quoteIdent } from '$lib/sql/dialect'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import type { ColumnInfo, TableInfo } from '$lib/types'
  import type { ForeignKey } from '$lib/ipc'
  import '$lib/components/workspace/users/um.css'

  const REL = ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse', 'sqlite', 'oracle', 'duckdb']
  const PAGE = 2000

  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = transferWizard.open
  })

  const srcConnId = $derived(transferWizard.srcConnId)
  const srcSchema = $derived(transferWizard.srcSchema)
  const srcSystem = $derived(connections.byId(srcConnId)?.system ?? 'postgres')
  const srcProfile = $derived(connections.byId(srcConnId))

  let tables = $state<TableInfo[]>([])
  let search = $state('')
  let picked = $state<Set<string>>(new Set())
  let destConnId = $state('')
  let destSchema = $state('')
  let mode = $state<TransferMode>('create-if-missing')
  let copyData = $state(true)
  let skipDuplicates = $state(false)
  let error = $state<string | null>(null)
  let stopFlag = $state(false)

  // columns + FKs loaded lazily when we plan
  let steps = $state<TransferStep[]>([])
  let previewOpen = $state(false)

  // run state
  type Phase = 'config' | 'running' | 'done'
  let phase = $state<Phase>('config')
  let curIdx = $state(0)
  let curTable = $state('')
  let curRows = $state(0)
  const log = $state<{ table: string; status: 'ok' | 'fail' | 'skip'; text: string }[]>([])

  const destSystem = $derived(connections.byId(destConnId)?.system ?? 'postgres')
  const destProfile = $derived(connections.byId(destConnId))
  const destTargets = $derived(
    connections.profiles.filter((p) => p.connected && REL.includes(p.system)),
  )
  const shown = $derived.by(() => {
    const q = search.trim().toLowerCase()
    const rel = tables.filter((t) => t.kind === 'table')
    return q ? rel.filter((t) => t.name.toLowerCase().includes(q)) : rel
  })
  const allShownPicked = $derived(shown.length > 0 && shown.every((t) => picked.has(t.name)))
  const chosen = $derived(tables.filter((t) => picked.has(t.name)).map((t) => t.name))
  const canRun = $derived(
    phase === 'config' && chosen.length > 0 && !!destConnId && destSchema.trim().length > 0 && REL.includes(srcSystem),
  )

  $effect(() => {
    if (transferWizard.open) untrack(() => void init())
  })

  async function init() {
    phase = 'config'
    error = null
    stopFlag = false
    steps = []
    previewOpen = false
    log.length = 0
    curIdx = 0
    curRows = 0
    search = ''
    destConnId = ''
    destSchema = srcSystem === 'sqlite' ? 'main' : srcSchema
    mode = 'create-if-missing'
    copyData = true
    skipDuplicates = false
    tables = []
    picked = new Set(transferWizard.preTables)
    if (srcConnId && REL.includes(srcSystem)) {
      tables = await ipc.listTables(srcConnId, srcSchema, { sizes: false }).catch(() => [])
    }
  }

  function toggle(name: string) {
    const next = new Set(picked)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    picked = next
  }
  function toggleAll() {
    const next = new Set(picked)
    if (allShownPicked) for (const t of shown) next.delete(t.name)
    else for (const t of shown) next.add(t.name)
    picked = next
  }
  function pickDest(id: string) {
    destConnId = id
    const sys = connections.byId(id)?.system
    if (sys === 'sqlite' || sys === 'duckdb') destSchema = 'main'
  }

  // Load columns for every picked table, then plan (order + DDL).
  async function buildSteps(): Promise<TransferStep[] | null> {
    if (!srcConnId) return null
    const loaded: { name: string; cols: ColumnInfo[] }[] = []
    for (const name of chosen) {
      const cols = await ipc.listColumns(srcConnId, srcSchema, name).catch(() => [])
      if (!cols.length) {
        error = `Could not read the columns of "${name}". It may have been dropped — refresh and try again.`
        return null
      }
      loaded.push({ name, cols })
    }
    let fks: ForeignKey[] = []
    try {
      fks = await ipc.listForeignKeys(srcConnId, srcSchema)
    } catch {
      fks = [] // no FK info → plain order (still valid)
    }
    return planTransfer({
      tables: loaded,
      foreignKeys: fks,
      destSystem,
      destSchema: destSchema.trim(),
      mode,
      copyData,
    })
  }

  async function preview() {
    error = null
    const s = await buildSteps()
    if (s) {
      steps = s
      previewOpen = true
    }
  }

  function destExists(name: string, destTables: TableInfo[]): boolean {
    return destTables.some((t) => t.name === name)
  }

  async function run() {
    if (!canRun || !srcConnId) return
    error = null
    const s = steps.length ? steps : await buildSteps()
    if (!s) return
    steps = s
    phase = 'running'
    stopFlag = false
    log.length = 0
    curIdx = 0

    // Existence snapshot of the destination schema (for create-if-missing / replace / append guards).
    let destTables: TableInfo[] = []
    try {
      destTables = await ipc.listTables(destConnId, destSchema.trim(), { sizes: false })
    } catch {
      destTables = []
    }

    for (let i = 0; i < steps.length; i++) {
      if (stopFlag) break
      const step = steps[i]
      curIdx = i
      curTable = step.destTable
      curRows = 0
      const exists = destExists(step.destTable, destTables)

      try {
        // 1. structure
        if (step.mode === 'create' && exists) {
          log.push({ table: step.destTable, status: 'skip', text: 'already exists — skipped (Create mode)' })
          continue
        }
        if (step.ddl && (step.mode === 'create' || !exists)) {
          const c = await ipc.execStatement(destConnId, step.ddl, 0)
          if (!c.ok) {
            log.push({ table: step.destTable, status: 'fail', text: `create failed: ${c.error?.message ?? 'error'}` })
            error = `Stopped at "${step.destTable}": create failed.`
            break
          }
        }
        if (step.mode === 'replace' && (exists || step.ddl)) {
          // clear only if it now exists (it does after create, or already did)
          const clr = await ipc.execStatement(destConnId, step.clearSql, 0)
          if (!clr.ok) {
            log.push({ table: step.destTable, status: 'fail', text: `clear failed: ${clr.error?.message ?? 'error'}` })
            error = `Stopped at "${step.destTable}": clear failed.`
            break
          }
        }

        // 2. data (paged)
        if (step.copyData) {
          const paged = supportsOffset(srcSystem)
          let offset = 0
          for (;;) {
            if (stopFlag) break
            const sql = buildExportSelect({
              system: srcSystem,
              schema: srcSchema,
              table: step.srcTable,
              columns: step.columns,
              where: step.where || undefined,
              limit: PAGE,
              offset,
            })
            const res = await ipc.execStatement(srcConnId, sql, 0)
            if (!res.ok) {
              log.push({ table: step.destTable, status: 'fail', text: `read failed: ${res.error?.message ?? 'error'}` })
              error = `Stopped at "${step.destTable}": read failed.`
              phase = 'done'
              return
            }
            const rows = (res.result?.rows ?? []) as Record<string, unknown>[]
            if (rows.length === 0) break
            const values = rows.map((r) => step.columns.map((c) => (r[c] == null ? null : String(r[c]))))
            const insert = buildInsert({
              system: destSystem,
              schema: destSchema.trim(),
              table: step.destTable,
              columns: step.columns,
              rows: values,
              mode: skipDuplicates ? 'skip' : 'error',
            })
            const ins = await ipc.execStatement(destConnId, insert, 0)
            if (!ins.ok) {
              log.push({ table: step.destTable, status: 'fail', text: `insert failed after ${curRows.toLocaleString()} rows: ${ins.error?.message ?? 'error'}` })
              error = `Stopped at "${step.destTable}": insert failed.`
              phase = 'done'
              return
            }
            curRows += rows.length
            if (!paged || rows.length < PAGE) break
            offset += rows.length
          }
        }

        // 3. verify
        if (step.copyData) {
          const t = destSchema.trim() && destSystem !== 'sqlite' ? qualified(destSystem, destSchema.trim(), step.destTable) : quoteIdent(destSystem, step.destTable)
          const check = await ipc.execStatement(destConnId, `SELECT count(*) AS n FROM ${t}`, 0)
          const destCount = Number((check.result?.rows?.[0] as Record<string, unknown>)?.n ?? -1)
          log.push({ table: step.destTable, status: 'ok', text: `${curRows.toLocaleString()} rows copied · destination now ${destCount.toLocaleString()}` })
        } else {
          log.push({ table: step.destTable, status: 'ok', text: 'structure created (no data copied)' })
        }
      } catch (e) {
        log.push({ table: step.destTable, status: 'fail', text: String(e) })
        error = `Stopped at "${step.destTable}".`
        break
      }
    }
    phase = 'done'
    if (stopFlag) {
      toasts.show('Transfer stopped')
    } else if (!error) {
      const ok = log.filter((l) => l.status === 'ok').length
      toasts.success(`Transferred ${ok} table${ok === 1 ? '' : 's'}`)
    }
  }

  function close() {
    if (phase !== 'running') transferWizard.close()
  }

  const MODES: { v: TransferMode; label: string; desc: string }[] = [
    { v: 'create', label: 'Create', desc: 'Make new tables — fails if one already exists' },
    { v: 'create-if-missing', label: 'Create if missing', desc: 'Make tables that are not there yet, append into the rest' },
    { v: 'append', label: 'Append', desc: 'Tables must already exist — add rows' },
    { v: 'replace', label: 'Replace', desc: 'Empty the destination tables first, then copy' },
  ]
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (rule for every form dialog); × / Cancel / Escape do -->
  <div onkeydown={(e) => e.key === 'Escape' && close()} role="presentation" class="um-backdrop">
    <div
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && close()}
      role="dialog"
      aria-modal="true"
      aria-label="Transfer data"
      tabindex="-1"
      class="um-dlg"
      style="width:var(--px-680);max-width:calc(100vw - var(--px-40))"
    >
      <div class="um-dlg-head">
        <span class="um-dlg-icon"><Icon name="upload" size={18} /></span>
        <div class="um-dlg-title">
          <b>Transfer data</b>
          <span>Copy tables from one database to another</span>
        </div>
        {#if phase !== 'running'}
          <span class="um-dlg-x" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0" aria-label="Close" title="Close"><Icon name="close" size={16} /></span>
        {/if}
      </div>

      <div class="um-dlg-body">
        {#if phase === 'config'}
          {#if !REL.includes(srcSystem)}
            <div class="um-callout" style="margin:0"><Icon name="info" size={15} /><span>Data Transfer works with relational engines. For MongoDB use <b>Copy to…</b> on a collection.</span></div>
          {:else}
            <!-- 1 · Source -->
            <div class="um-section-title tr-sec">
              <span>1 · Tables to copy</span>
              <span class="tr-count" aria-live="polite">{chosen.length} selected · from {srcProfile?.name ?? '?'} / {srcSchema}</span>
            </div>
            <div class="tr-tools">
              <label class="ds-search sm tr-search">
                <Icon name="search" size={12} />
                <input bind:value={search} placeholder="Search tables" aria-label="Search tables to transfer" spellcheck="false" />
              </label>
              <span class="eg-btn" onclick={toggleAll} onkeydown={(e) => e.key === 'Enter' && toggleAll()} role="button" tabindex="0">{allShownPicked ? 'Select none' : 'Select all'}</span>
            </div>
            <div class="tr-list" role="group" aria-label="Tables to transfer">
              {#each shown as t (t.name)}
                <label class="tr-row" class:on={picked.has(t.name)}>
                  <input type="checkbox" checked={picked.has(t.name)} onchange={() => toggle(t.name)} aria-label={t.name} />
                  <span class="tr-name mono">{t.name}</span>
                  {#if t.row_estimate != null}<span class="tr-meta mono">{t.row_estimate.toLocaleString()} rows</span>{/if}
                </label>
              {:else}
                <div class="tr-empty">{tables.length ? 'No table matches.' : 'This schema has no tables.'}</div>
              {/each}
            </div>

            <!-- 2 · Destination -->
            <div class="um-section-title tr-sec"><span>2 · Destination</span></div>
            <div class="um-row2">
              <label class="um-field">Connection
                <select class="um-input" value={destConnId} onchange={(e) => pickDest((e.currentTarget as HTMLSelectElement).value)}>
                  <option value="" disabled>Pick a connection…</option>
                  {#each destTargets as p (p.id)}
                    <option value={p.id}>{p.name} · {p.system}</option>
                  {/each}
                </select>
              </label>
              <label class="um-field">Schema
                <input class="um-input mono" bind:value={destSchema} placeholder={destSystem === 'sqlite' ? 'main' : 'public'} spellcheck="false" />
              </label>
            </div>

            <!-- 3 · How -->
            <div class="um-section-title tr-sec"><span>3 · How to copy</span></div>
            <div class="tr-modes" role="radiogroup" aria-label="Transfer mode">
              {#each MODES as m (m.v)}
                <label class="tr-mode" class:on={mode === m.v}>
                  <input type="radio" name="tr-mode" checked={mode === m.v} onchange={() => (mode = m.v)} aria-label={m.label} />
                  <span class="tr-mode-text"><b>{m.label}</b><span>{m.desc}</span></span>
                </label>
              {/each}
            </div>
            <label class="um-toggle">
              <span class="um-toggle-text"><span>Copy data</span><span>Off = create the empty tables only (structure, no rows)</span></span>
              <input type="checkbox" class="um-switch" bind:checked={copyData} aria-label="Copy data" />
            </label>
            <label class="um-toggle">
              <span class="um-toggle-text"><span>Skip duplicate rows</span><span>Ignore rows whose key already exists at the destination (PostgreSQL / MySQL / MariaDB / SQLite)</span></span>
              <input type="checkbox" class="um-switch" bind:checked={skipDuplicates} aria-label="Skip duplicate rows" />
            </label>

            <div class="um-callout warn" style="margin:var(--px-10) 0 0">
              <Icon name="warning" size={15} />
              <span>Only columns and rows are copied — indexes, foreign keys and defaults are not. Use <b>Generate Scripts</b> if you need the full structure. Cross-engine type mapping is approximate.</span>
            </div>

            {#if previewOpen && steps.length}
              <div class="um-section-title tr-sec"><span>Order ({steps.length} tables — parents first)</span></div>
              <div class="tr-steps">
                {#each steps as s, i (s.destTable)}
                  <div class="tr-step">
                    <span class="tr-step-n mono">{i + 1}</span>
                    <span class="tr-step-name mono">{s.srcTable}{s.srcTable !== s.destTable ? ` → ${s.destTable}` : ''}</span>
                    <span class="tr-step-mode">{s.ddl ? 'create' : 'append'}{s.clearSql ? ' + clear' : ''}{s.copyData ? '' : ' · structure only'}</span>
                  </div>
                {/each}
              </div>
            {/if}

            {#if error}
              <div class="um-err" role="alert" style="margin-top:var(--px-10)"><Icon name="warning" size={14} /><span>{error}</span></div>
            {/if}
          {/if}
        {:else}
          <!-- running / done -->
          <div class="tr-run-head">
            <SystemIcon system={srcSystem} size={16} />
            <span class="mono">{srcProfile?.name}/{srcSchema}</span>
            <Icon name="chevron-right" size={14} />
            <SystemIcon system={destSystem} size={16} />
            <span class="mono">{destProfile?.name}/{destSchema}</span>
          </div>
          {#if phase === 'running'}
            <div class="tr-progress">
              <div class="tr-bar"><div class="tr-bar-fill" style="width:{steps.length ? ((curIdx + 1) / steps.length) * 100 : 0}%"></div></div>
              <div class="tr-progress-line">Table {curIdx + 1} of {steps.length} · <span class="mono">{curTable}</span> · {curRows.toLocaleString()} rows</div>
            </div>
          {/if}
          <div class="tr-log" role="log">
            {#each log as l (l.table + l.text)}
              <div class="tr-log-row tr-{l.status}">
                <Icon name={l.status === 'ok' ? 'check' : l.status === 'skip' ? 'info' : 'warning'} size={13} />
                <span class="mono tr-log-name">{l.table}</span>
                <span class="tr-log-text">{l.text}</span>
              </div>
            {/each}
          </div>
          {#if phase === 'done'}
            {@const ok = log.filter((l) => l.status === 'ok').length}
            {@const failed = log.filter((l) => l.status === 'fail').length}
            <div class="tr-summary" class:bad={failed > 0} role="status">
              {stopFlag ? 'Stopped' : failed ? `${ok} copied, ${failed} failed` : `${ok} table${ok === 1 ? '' : 's'} transferred`}
            </div>
          {/if}
        {/if}
      </div>

      <div class="um-dlg-foot">
        {#if phase === 'config' && REL.includes(srcSystem)}
          <span class="eg-btn" onclick={() => void preview()} onkeydown={(e) => e.key === 'Enter' && void preview()} role="button" tabindex="0" aria-disabled={chosen.length === 0 || !destConnId}>Preview order</span>
        {/if}
        <span class="um-spacer"></span>
        {#if phase === 'running'}
          <span class="cfm-btn ds-danger-outline" onclick={() => (stopFlag = true)} onkeydown={(e) => e.key === 'Enter' && (stopFlag = true)} role="button" tabindex="0">Stop</span>
        {:else if phase === 'done'}
          <span class="cfm-btn primary" onclick={() => transferWizard.close()} onkeydown={(e) => e.key === 'Enter' && transferWizard.close()} role="button" tabindex="0">Done</span>
        {:else}
          <span class="cfm-btn" onclick={close} onkeydown={(e) => e.key === 'Enter' && close()} role="button" tabindex="0">Cancel</span>
          <span class="cfm-btn primary" onclick={() => void run()} onkeydown={(e) => e.key === 'Enter' && void run()} role="button" tabindex="0" aria-disabled={!canRun}>Transfer {chosen.length || ''} table{chosen.length === 1 ? '' : 's'}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .tr-sec {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .tr-count {
    font-weight: 500;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
  }
  .tr-tools {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    margin-bottom: var(--px-6);
  }
  .tr-search {
    flex: 1;
  }
  .tr-list {
    max-height: var(--px-200);
    overflow: auto;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    background: var(--surface);
  }
  .tr-row {
    display: flex;
    align-items: center;
    gap: var(--px-9);
    padding: var(--px-6) var(--px-10);
    border-bottom: var(--px-1) solid var(--border);
    cursor: pointer;
  }
  .tr-row:last-child {
    border-bottom: 0;
  }
  .tr-row:hover {
    background: var(--row-hover);
  }
  .tr-name {
    flex: 1;
    min-width: 0;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tr-meta {
    font-size: var(--px-11);
    color: var(--muted);
  }
  .tr-empty {
    padding: var(--px-14);
    color: var(--muted);
    text-align: center;
  }
  .tr-modes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--px-8);
  }
  .tr-mode {
    display: flex;
    gap: var(--px-8);
    padding: var(--px-8) var(--px-10);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    cursor: pointer;
  }
  .tr-mode.on {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 8%, var(--surface));
  }
  .tr-mode-text {
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
  }
  .tr-mode-text b {
    font-size: var(--px-12_5);
  }
  .tr-mode-text span {
    font-size: var(--px-11);
    color: var(--muted);
    line-height: 1.35;
  }
  .tr-steps,
  .tr-log {
    max-height: var(--px-200);
    overflow: auto;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    background: var(--surface);
  }
  .tr-step {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-5) var(--px-10);
    border-bottom: var(--px-1) solid var(--border);
  }
  .tr-step:last-child {
    border-bottom: 0;
  }
  .tr-step-n {
    width: var(--px-20);
    color: var(--muted);
    text-align: right;
  }
  .tr-step-name {
    flex: 1;
    min-width: 0;
    color: var(--text);
  }
  .tr-step-mode {
    font-size: var(--px-11);
    color: var(--muted);
  }
  .tr-run-head {
    display: flex;
    align-items: center;
    gap: var(--px-7);
    font-size: var(--px-12_5);
    color: var(--text2);
    margin-bottom: var(--px-10);
  }
  .tr-progress {
    margin-bottom: var(--px-10);
  }
  .tr-bar {
    height: var(--px-7);
    border-radius: var(--px-6);
    background: var(--panel);
    overflow: hidden;
  }
  .tr-bar-fill {
    height: 100%;
    background: var(--primary);
    transition: width 0.2s ease;
  }
  .tr-progress-line {
    margin-top: var(--px-6);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .tr-log-row {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-5) var(--px-10);
    border-bottom: var(--px-1) solid var(--border);
    font-size: var(--px-12);
  }
  .tr-log-row:last-child {
    border-bottom: 0;
  }
  .tr-log-name {
    flex: none;
    color: var(--text);
  }
  .tr-log-text {
    color: var(--text2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tr-ok {
    color: var(--success);
  }
  .tr-fail {
    color: var(--error);
  }
  .tr-skip {
    color: var(--muted);
  }
  .tr-summary {
    margin-top: var(--px-10);
    font-weight: 600;
    color: var(--success);
  }
  .tr-summary.bad {
    color: var(--error);
  }
</style>
