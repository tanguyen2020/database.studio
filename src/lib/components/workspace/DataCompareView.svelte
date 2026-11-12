<script lang="ts">
  // Data Compare — row-level diff of two tables (same or different connection).
  // Pick a source table and a target table, choose key columns (default = the
  // source primary key) and the columns to compare, then Compare. The result is
  // four buckets — Only in source (→ INSERT), Different (→ UPDATE), Only in
  // target (→ DELETE), Same — and a sync script that makes the target match the
  // source. Row classification + SQL live in compare/data-diff.ts (pure).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { editorLanguageId } from '$lib/editor/dialect'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { splitStatements } from '$lib/sql/statements'
  import { buildExportSelect, supportsOffset } from '$lib/export/query'
  import {
    buildDataSync,
    classifyRows,
    duplicateKeys,
    makeKeyed,
    type DataDiff,
    type DiffPair,
    type Row,
  } from '$lib/compare/data-diff'
  import type { TabState, ColumnInfo } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const RELATIONAL = ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse', 'oracle', 'duckdb']
  const PAGE = 2000
  const ROW_CAP = 200_000 // v1 buffers both sides in memory; cap honestly + warn

  const options = $derived(connections.profiles.filter((p) => RELATIONAL.includes(p.system)))

  type DcState = { srcConn?: string | null; srcSchema?: string; srcTable?: string; presetTick?: number }
  const st0 = untrack(() => tab.state) as DcState

  // --- source / target selection -------------------------------------------
  let srcConn = $state<string | null>(st0.srcConn ?? null)
  let srcSchema = $state(st0.srcSchema ?? '')
  let srcTable = $state(st0.srcTable ?? '')
  let srcWhere = $state('')
  let tgtConn = $state<string | null>(null)
  let tgtSchema = $state('')
  let tgtTable = $state('')
  let tgtWhere = $state('')

  let srcSchemas = $state<string[]>([])
  let tgtSchemas = $state<string[]>([])
  let srcTables = $state<string[]>([])
  let tgtTables = $state<string[]>([])
  let srcCols = $state<ColumnInfo[]>([])
  let tgtCols = $state<ColumnInfo[]>([])

  let keyCols = $state<string[]>([])
  let cmpCols = $state<string[]>([])
  let keyTouched = $state(false)
  let cmpTouched = $state(false)

  const srcProfile = $derived(connections.byId(srcConn))
  const tgtProfile = $derived(connections.byId(tgtConn))
  const tgtSystem = $derived(tgtProfile?.system ?? 'postgres')

  // columns present on BOTH tables (we can only compare shared columns)
  const commonCols = $derived.by(() => {
    const t = new Set(tgtCols.map((c) => c.name))
    return srcCols.filter((c) => t.has(c.name)).map((c) => c.name)
  })

  // --- run state ------------------------------------------------------------
  let loading = $state(false)
  let compared = $state(false)
  let warn = $state<string | null>(null)
  let diff = $state<DataDiff | null>(null)
  let srcCapped = $state(false)
  let tgtCapped = $state(false)
  let view = $state<'rows' | 'sync'>('rows')
  let bucket = $state<'onlySrc' | 'different' | 'onlyTgt'>('different')
  let openRow = $state<string | null>(null)

  // which buckets go into the sync script (DELETE off by default — it is destructive)
  let incInsert = $state(true)
  let incUpdate = $state(true)
  let incDelete = $state(false)

  // apply confirmation
  let confirming = $state(false)
  let confirmText = $state('')
  let applying = $state(false)

  async function ensureConnected(id: string | null): Promise<boolean> {
    if (!id) return false
    const p = connections.byId(id)
    if (!p) return false
    if (p.connected) return true
    return await connections.connect(id)
  }

  async function loadSchemas(connId: string, sys: string): Promise<string[]> {
    try {
      if (sys === 'postgres' || sys === 'mssql' || sys === 'oracle') return (await ipc.listSchemas(connId)).map((s) => s.name)
      return (await ipc.listSchemas(connId)).map((s) => s.name)
    } catch {
      return []
    }
  }
  async function loadTables(connId: string, schema: string): Promise<string[]> {
    try {
      return (await ipc.listTables(connId, schema, { sizes: false })).filter((t) => t.kind === 'table').map((t) => t.name)
    } catch {
      return []
    }
  }

  // source side: load schema list when the connection changes
  $effect(() => {
    const c = srcConn
    const sys = srcProfile?.system
    if (c && sys) untrack(() => void (async () => { if (await ensureConnected(c)) srcSchemas = await loadSchemas(c, sys) })())
    else srcSchemas = []
  })
  $effect(() => {
    const c = tgtConn
    const sys = tgtProfile?.system
    if (c && sys) untrack(() => void (async () => { if (await ensureConnected(c)) tgtSchemas = await loadSchemas(c, sys) })())
    else tgtSchemas = []
  })
  $effect(() => {
    const c = srcConn
    const s = srcSchema
    if (c && s) untrack(() => void loadTables(c, s).then((t) => (srcTables = t)))
    else srcTables = []
  })
  $effect(() => {
    const c = tgtConn
    const s = tgtSchema
    if (c && s) untrack(() => void loadTables(c, s).then((t) => (tgtTables = t)))
    else tgtTables = []
  })
  $effect(() => {
    const c = srcConn
    const s = srcSchema
    const t = srcTable
    if (c && s && t) untrack(() => void ipc.listColumns(c, s, t).then((cols) => (srcCols = cols)).catch(() => (srcCols = [])))
    else srcCols = []
  })
  $effect(() => {
    const c = tgtConn
    const s = tgtSchema
    const t = tgtTable
    if (c && s && t) untrack(() => void ipc.listColumns(c, s, t).then((cols) => (tgtCols = cols)).catch(() => (tgtCols = [])))
    else tgtCols = []
  })

  // default key = source PK ∩ common; default compare = common minus keys —
  // until the user touches those lists.
  $effect(() => {
    const common = commonCols
    const pk = srcCols.filter((c) => c.is_pk).map((c) => c.name).filter((n) => common.includes(n))
    untrack(() => {
      if (!keyTouched) keyCols = pk.length ? pk : common.slice(0, 1)
      if (!cmpTouched) cmpCols = common.filter((c) => !keyCols.includes(c))
    })
  })

  function toggle(list: string[], name: string): string[] {
    return list.includes(name) ? list.filter((n) => n !== name) : [...list, name]
  }

  const canCompare = $derived(
    !!srcConn && !!srcSchema && !!srcTable && !!tgtConn && !!tgtSchema && !!tgtTable && keyCols.length > 0 && !loading,
  )

  async function fetchAll(connId: string, schema: string, table: string, cols: string[], where: string): Promise<{ rows: Row[]; capped: boolean }> {
    const sys = connections.byId(connId)?.system ?? 'postgres'
    const rows: Row[] = []
    if (!supportsOffset(sys)) {
      // no stable paging → single shot, still cap
      const sql = buildExportSelect({ system: sys, schema, table, columns: cols, where, limit: ROW_CAP })
      const r = await ipc.execStatement(connId, sql, 0)
      if (!r.ok) throw new Error(r.error?.message ?? 'read failed')
      return { rows: (r.result?.rows ?? []) as Row[], capped: (r.result?.rows?.length ?? 0) >= ROW_CAP }
    }
    for (let offset = 0; offset < ROW_CAP; offset += PAGE) {
      const sql = buildExportSelect({ system: sys, schema, table, columns: cols, where, limit: PAGE, offset })
      const r = await ipc.execStatement(connId, sql, 0)
      if (!r.ok) throw new Error(r.error?.message ?? 'read failed')
      const page = (r.result?.rows ?? []) as Row[]
      rows.push(...page)
      if (page.length < PAGE) return { rows, capped: false }
    }
    return { rows, capped: true }
  }

  async function compare() {
    if (!canCompare || !srcConn || !tgtConn) return
    loading = true
    warn = null
    diff = null
    compared = false
    openRow = null
    try {
      if (!(await ensureConnected(srcConn)) || !(await ensureConnected(tgtConn))) {
        toasts.error('Could not open both connections')
        return
      }
      const cols = [...keyCols, ...cmpCols.filter((c) => !keyCols.includes(c))]
      const [s, t] = await Promise.all([
        fetchAll(srcConn, srcSchema, srcTable, cols, srcWhere),
        fetchAll(tgtConn, tgtSchema, tgtTable, cols, tgtWhere),
      ])
      srcCapped = s.capped
      tgtCapped = t.capped
      const srcKeyed = makeKeyed(s.rows, keyCols, cmpCols)
      const tgtKeyed = makeKeyed(t.rows, keyCols, cmpCols)
      const dupS = duplicateKeys(srcKeyed)
      const dupT = duplicateKeys(tgtKeyed)
      diff = classifyRows(srcKeyed, tgtKeyed, cmpCols)
      compared = true
      view = 'rows'
      bucket = diff.different.length ? 'different' : diff.onlySrc.length ? 'onlySrc' : 'onlyTgt'
      const notes: string[] = []
      if (dupS.length || dupT.length) notes.push(`The key is not unique (${dupS.length + dupT.length} repeated) — rows with a repeated key may classify wrongly. Pick columns that identify a row.`)
      if (s.capped || t.capped) notes.push(`Only the first ${ROW_CAP.toLocaleString()} rows (ordered by key) were read — add a WHERE to narrow the comparison.`)
      if (srcProfile?.system !== tgtProfile?.system) notes.push('Comparing across different engines — values are matched as text, so type differences may show as changes.')
      warn = notes.length ? notes.join(' ') : null
    } catch (e) {
      toasts.error(String((e as Error)?.message ?? e))
    } finally {
      loading = false
    }
  }

  const syncOpts = $derived({
    system: tgtSystem,
    schema: tgtSchema,
    table: tgtTable,
    keyCols,
    cmpCols,
  })
  const syncScript = $derived(
    diff ? buildDataSync(diff, syncOpts, { insert: incInsert, update: incUpdate, del: incDelete }) : '',
  )
  const plannedCount = $derived(
    !diff ? 0 : (incInsert ? diff.onlySrc.length : 0) + (incUpdate ? diff.different.length : 0) + (incDelete ? diff.onlyTgt.length : 0),
  )
  const production = $derived(tgtProfile?.env === 'production')
  const needTyped = $derived(incDelete || production)

  function startApply() {
    if (!syncScript.trim() || plannedCount === 0) return
    confirmText = ''
    confirming = true
  }
  async function doApply() {
    if (!tgtConn) return
    applying = true
    try {
      const stmts = splitStatements(syncScript, tgtSystem).map((s) => s.sql).filter((s) => s.trim() && !/^\s*--/.test(s))
      let done = 0
      for (const sql of stmts) {
        const r = await ipc.execStatement(tgtConn, sql, 0)
        if (!r.ok) throw new Error(`${r.error?.message ?? 'statement failed'}\n${sql}`)
        done++
      }
      confirming = false
      toasts.success(`Applied ${done} statement${done === 1 ? '' : 's'} to the target`)
      await compare()
    } catch (e) {
      toasts.error(String((e as Error)?.message ?? e))
    } finally {
      applying = false
    }
  }

  const rows = $derived.by<(DiffPair | { key: string; row: Row })[]>(() => {
    if (!diff) return []
    if (bucket === 'different') return diff.different
    if (bucket === 'onlySrc') return diff.onlySrc.map((r) => ({ key: r.key, row: r.row }))
    return diff.onlyTgt.map((r) => ({ key: r.key, row: r.row }))
  })

  function cell(v: unknown): string {
    if (v == null) return 'NULL'
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  }
</script>

<div class="dc">
  <div class="dc-setup">
    <div class="dc-side">
      <div class="dc-side-h">Source <span class="dc-hint">the table that is correct</span></div>
      <div class="dc-pickers">
        <select bind:value={srcConn} aria-label="Source connection">
          <option value={null}>Connection…</option>
          {#each options as p (p.id)}<option value={p.id}>{p.name} · {p.system}</option>{/each}
        </select>
        <select bind:value={srcSchema} aria-label="Source schema" disabled={!srcConn}>
          <option value="">Schema…</option>
          {#each srcSchemas as s (s)}<option value={s}>{s}</option>{/each}
        </select>
        <select bind:value={srcTable} aria-label="Source table" disabled={!srcSchema}>
          <option value="">Table…</option>
          {#each srcTables as t (t)}<option value={t}>{t}</option>{/each}
        </select>
      </div>
      <input class="dc-where" bind:value={srcWhere} placeholder="WHERE (optional)" aria-label="Source filter" />
    </div>

    <div class="dc-arrow">→</div>

    <div class="dc-side">
      <div class="dc-side-h">Target <span class="dc-hint">the table that will be changed</span></div>
      <div class="dc-pickers">
        <select bind:value={tgtConn} aria-label="Target connection">
          <option value={null}>Connection…</option>
          {#each options as p (p.id)}<option value={p.id}>{p.name} · {p.system}</option>{/each}
        </select>
        <select bind:value={tgtSchema} aria-label="Target schema" disabled={!tgtConn}>
          <option value="">Schema…</option>
          {#each tgtSchemas as s (s)}<option value={s}>{s}</option>{/each}
        </select>
        <select bind:value={tgtTable} aria-label="Target table" disabled={!tgtSchema}>
          <option value="">Table…</option>
          {#each tgtTables as t (t)}<option value={t}>{t}</option>{/each}
        </select>
      </div>
      <input class="dc-where" bind:value={tgtWhere} placeholder="WHERE (optional)" aria-label="Target filter" />
    </div>
  </div>

  {#if commonCols.length > 0}
    <div class="dc-cols">
      <div class="dc-col-group">
        <span class="dc-col-label">Key columns</span>
        {#each commonCols as c (c)}
          <label class="dc-chk"><input type="checkbox" checked={keyCols.includes(c)} onchange={() => { keyTouched = true; keyCols = toggle(keyCols, c) }} />{c}</label>
        {/each}
      </div>
      <div class="dc-col-group">
        <span class="dc-col-label">Compare</span>
        {#each commonCols.filter((c) => !keyCols.includes(c)) as c (c)}
          <label class="dc-chk"><input type="checkbox" checked={cmpCols.includes(c)} onchange={() => { cmpTouched = true; cmpCols = toggle(cmpCols, c) }} />{c}</label>
        {/each}
      </div>
    </div>
  {/if}

  <div class="dc-run">
    <button class="eg-btn primary" disabled={!canCompare} onclick={compare}>{loading ? 'Comparing…' : 'Compare'}</button>
    {#if warn}<span class="dc-warn" role="note">⚠ {warn}</span>{/if}
  </div>

  {#if compared && diff}
    <div class="dc-cards">
      <button class="dc-card" class:active={bucket === 'onlySrc'} onclick={() => { bucket = 'onlySrc'; view = 'rows' }}>
        <span class="dc-n dc-ins">{diff.onlySrc.length}</span><span class="dc-lbl">Only in source</span><span class="dc-sub">→ INSERT</span>
      </button>
      <button class="dc-card" class:active={bucket === 'different'} onclick={() => { bucket = 'different'; view = 'rows' }}>
        <span class="dc-n dc-upd">{diff.different.length}</span><span class="dc-lbl">Different</span><span class="dc-sub">→ UPDATE</span>
      </button>
      <button class="dc-card" class:active={bucket === 'onlyTgt'} onclick={() => { bucket = 'onlyTgt'; view = 'rows' }}>
        <span class="dc-n dc-del">{diff.onlyTgt.length}</span><span class="dc-lbl">Only in target</span><span class="dc-sub">→ DELETE</span>
      </button>
      <div class="dc-card dc-same"><span class="dc-n">{diff.same}</span><span class="dc-lbl">Same</span></div>
    </div>

    <div class="dc-tabs">
      <button class:active={view === 'rows'} onclick={() => (view = 'rows')}>Rows</button>
      <button class:active={view === 'sync'} onclick={() => (view = 'sync')}>Sync script</button>
    </div>

    {#if view === 'rows'}
      <div class="dc-rows">
        {#if rows.length === 0}
          <div class="dc-empty">No rows in this group.</div>
        {:else}
          {#each rows as r (r.key)}
            {#if bucket === 'different'}
              {@const p = r as DiffPair}
              <div class="dc-row">
                <button class="dc-row-h" onclick={() => (openRow = openRow === p.key ? null : p.key)}>
                  <span class="dc-key">{p.keyVals.map(cell).join(' · ')}</span>
                  <span class="dc-chg">{p.cells.length} column{p.cells.length === 1 ? '' : 's'} differ</span>
                </button>
                {#if openRow === p.key}
                  <table class="dc-diff">
                    <thead><tr><th>Column</th><th>Source</th><th>Target</th></tr></thead>
                    <tbody>
                      {#each p.cells as c (c.col)}
                        <tr><td class="dc-cn">{c.col}</td><td class="dc-sv">{cell(c.src)}</td><td class="dc-tv">{cell(c.tgt)}</td></tr>
                      {/each}
                    </tbody>
                  </table>
                {/if}
              </div>
            {:else}
              {@const rr = r as { key: string; row: Row }}
              <div class="dc-row"><div class="dc-row-h static"><span class="dc-key">{rr.key.split('\u001f').map((s) => s.replace(/^[sj]|^\u0000NULL$/, (m) => (m === '\u0000NULL' ? 'NULL' : ''))).join(' · ')}</span></div></div>
            {/if}
          {/each}
        {/if}
      </div>
    {:else}
      <div class="dc-sync">
        <div class="dc-sync-bar">
          <label class="dc-chk"><input type="checkbox" bind:checked={incInsert} />INSERT ({diff.onlySrc.length})</label>
          <label class="dc-chk"><input type="checkbox" bind:checked={incUpdate} />UPDATE ({diff.different.length})</label>
          <label class="dc-chk dc-danger-chk"><input type="checkbox" bind:checked={incDelete} />DELETE ({diff.onlyTgt.length})</label>
          <span class="dc-spacer"></span>
          <button class="eg-btn ds-danger-outline" disabled={plannedCount === 0} onclick={startApply}>Apply to target ({plannedCount})</button>
        </div>
        <div class="dc-code">
          <CodeView value={syncScript || '-- nothing selected'} language={editorLanguageId(tgtSystem)} ariaLabel="Sync script" height="auto" minHeight={120} maxHeight={520} />
        </div>
      </div>
    {/if}
  {/if}

  {#if confirming}
    <div class="dc-backdrop" role="presentation">
      <div class="dc-dlg" role="dialog" aria-modal="true" aria-label="Apply sync">
        <div class="dc-dlg-h">Apply {plannedCount} change{plannedCount === 1 ? '' : 's'} to the target</div>
        <div class="dc-dlg-b">
          <div class="dc-callout">
            This runs
            {#if incInsert && diff}<b>{diff.onlySrc.length} INSERT</b>{/if}{#if incUpdate && diff}{incInsert ? ', ' : ''}<b>{diff.different.length} UPDATE</b>{/if}{#if incDelete && diff}, <b>{diff.onlyTgt.length} DELETE</b>{/if}
            on <b>{tgtSchema ? tgtSchema + '.' : ''}{tgtTable}</b> in <b>{tgtProfile?.name}</b>.
            {#if incDelete}<span class="dc-del-warn"> DELETE removes rows from the target permanently.</span>{/if}
            {#if production}<span class="dc-del-warn"> This is a <b>production</b> connection.</span>{/if}
          </div>
          {#if needTyped}
            <label class="dc-type">Type the table name <b>{tgtTable}</b> to confirm:
              <input bind:value={confirmText} aria-label="Confirm table name" />
            </label>
          {/if}
        </div>
        <div class="dc-dlg-f">
          <button class="cfm-btn" onclick={() => (confirming = false)} disabled={applying}>Cancel</button>
          <button class="cfm-btn danger" disabled={applying || (needTyped && confirmText !== tgtTable)} onclick={doApply}>{applying ? 'Applying…' : 'Apply'}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .dc { display: flex; flex-direction: column; height: 100%; overflow: auto; padding: var(--px-12); gap: var(--px-12); background: var(--bg); color: var(--text); }
  .dc-setup { display: flex; align-items: stretch; gap: var(--px-12); }
  .dc-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--px-6); padding: var(--px-10); border: var(--px-1) solid var(--border); border-radius: var(--px-8); background: var(--surface); }
  .dc-side-h { font-weight: 600; font-size: var(--px-13); }
  .dc-hint { font-weight: 400; color: var(--muted); font-size: var(--px-11); margin-left: var(--px-6); }
  .dc-pickers { display: flex; gap: var(--px-6); flex-wrap: wrap; }
  .dc-pickers select, .dc-where { background: var(--raised); color: var(--text); border: var(--px-1) solid var(--border2); border-radius: var(--px-6); padding: var(--px-4) var(--px-6); font-size: var(--px-12); min-width: 0; flex: 1; }
  .dc-arrow { align-self: center; color: var(--muted); font-size: var(--px-18); }
  .dc-cols { display: flex; flex-direction: column; gap: var(--px-6); padding: var(--px-8) var(--px-10); border: var(--px-1) solid var(--border); border-radius: var(--px-8); background: var(--surface); }
  .dc-col-group { display: flex; align-items: center; gap: var(--px-10); flex-wrap: wrap; }
  .dc-col-label { font-weight: 600; font-size: var(--px-12); color: var(--text2); min-width: var(--px-72); }
  .dc-chk { display: inline-flex; align-items: center; gap: var(--px-4); font-size: var(--px-12); cursor: pointer; }
  .dc-run { display: flex; align-items: center; gap: var(--px-10); }
  .dc-warn { color: var(--sacc-amber); font-size: var(--px-12); }
  .dc-cards { display: flex; gap: var(--px-10); }
  .dc-card { flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: var(--px-2); padding: var(--px-10) var(--px-12); border: var(--px-1) solid var(--border); border-radius: var(--px-8); background: var(--surface); cursor: pointer; }
  .dc-card.active { border-color: var(--primary); box-shadow: inset 0 0 0 var(--px-1) var(--primary); }
  .dc-card.dc-same { cursor: default; }
  .dc-n { font-size: var(--px-20); font-weight: 700; font-variant-numeric: tabular-nums; }
  .dc-ins { color: var(--sacc-green); }
  .dc-upd { color: var(--sacc-amber); }
  .dc-del { color: var(--tbl-alert); }
  .dc-lbl { font-size: var(--px-12); font-weight: 600; }
  .dc-sub { font-size: var(--px-11); color: var(--muted); }
  .dc-tabs { display: flex; gap: var(--px-4); border-bottom: var(--px-1) solid var(--border); }
  .dc-tabs button { background: none; border: none; padding: var(--px-6) var(--px-12); font-size: var(--px-12); color: var(--text2); cursor: pointer; border-bottom: var(--px-2) solid transparent; }
  .dc-tabs button.active { color: var(--text); border-bottom-color: var(--primary); font-weight: 600; }
  .dc-rows { display: flex; flex-direction: column; gap: var(--px-4); }
  .dc-empty { color: var(--muted); font-size: var(--px-12); padding: var(--px-12); }
  .dc-row { border: var(--px-1) solid var(--border); border-radius: var(--px-6); background: var(--surface); }
  .dc-row-h { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: var(--px-10); padding: var(--px-6) var(--px-10); background: none; border: none; cursor: pointer; text-align: left; color: var(--text); }
  .dc-row-h.static { cursor: default; }
  .dc-key { font-family: var(--font-mono); font-size: var(--px-12); }
  .dc-chg { font-size: var(--px-11); color: var(--sacc-amber); }
  .dc-diff { width: 100%; border-collapse: collapse; font-size: var(--px-12); }
  .dc-diff th { text-align: left; padding: var(--px-4) var(--px-10); color: var(--text2); border-top: var(--px-1) solid var(--border); font-weight: 600; }
  .dc-diff td { padding: var(--px-4) var(--px-10); border-top: var(--px-1) solid var(--border); font-family: var(--font-mono); vertical-align: top; }
  .dc-cn { color: var(--text2); font-family: var(--font-main) !important; }
  .dc-sv { color: var(--sacc-green); }
  .dc-tv { color: var(--tbl-alert); }
  .dc-sync { display: flex; flex-direction: column; gap: var(--px-8); }
  .dc-sync-bar { display: flex; align-items: center; gap: var(--px-14); }
  .dc-danger-chk { color: var(--tbl-alert); }
  .dc-spacer { flex: 1; }
  .dc-code { border: var(--px-1) solid var(--border); border-radius: var(--px-6); overflow: hidden; }
  .dc-backdrop { position: fixed; inset: 0; background: var(--rgba-0-0-0-_5); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .dc-dlg { width: min(var(--px-520), 92vw); background: var(--surface); border: var(--px-1) solid var(--border2); border-radius: var(--px-10); box-shadow: var(--shadow-lg); }
  .dc-dlg-h { padding: var(--px-12) var(--px-14); font-weight: 600; font-size: var(--px-14); border-bottom: var(--px-1) solid var(--border); }
  .dc-dlg-b { padding: var(--px-14); display: flex; flex-direction: column; gap: var(--px-12); }
  .dc-callout { background: var(--raised); border: var(--px-1) solid var(--border2); border-radius: var(--px-6); padding: var(--px-10); font-size: var(--px-12); line-height: 1.5; }
  .dc-del-warn { color: var(--tbl-alert); }
  .dc-type { display: flex; flex-direction: column; gap: var(--px-4); font-size: var(--px-12); }
  .dc-type input { background: var(--raised); color: var(--text); border: var(--px-1) solid var(--border2); border-radius: var(--px-6); padding: var(--px-6); }
  .dc-dlg-f { display: flex; justify-content: flex-end; gap: var(--px-8); padding: var(--px-12) var(--px-14); border-top: var(--px-1) solid var(--border); }
</style>
