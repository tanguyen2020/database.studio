<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  // Table Data Viewer — mở khi double-click bảng trong Explorer. Filter builder
  // (column/operator/value, AND|OR) + sort đa cột (Shift+click header) + phân
  // trang server-side (LIMIT/OFFSET) qua exec_filtered (tham số hóa). Reuse
  // ResultGrid + editable grid (spec phase-2 §5).
  import ResultGrid, { type EditTarget } from '$lib/components/results/ResultGrid.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { execFiltered, execStatement, listColumns, type FilterCond, type SortSpec } from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { systemMeta } from '$lib/systems'
  import { quoteIdent, qualified } from '$lib/sql/dialect'
  import type { QueryError, QueryResultSet, TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }

  let { tab }: Props = $props()

  // svelte-ignore state_referenced_locally
  const schema = tab.state.schema as string
  // svelte-ignore state_referenced_locally
  const table = tab.state.table as string
  const profile = $derived(connections.byId(tab.connectionId))
  // Which database this viewer is bound to, surfaced in the toolbar. For MySQL/
  // MariaDB/ClickHouse a "schema" IS a database, and a table opened in a non-default
  // one keeps the BASE connection (whose databaseOf() is the connection's default DB,
  // not this table's DB) — so use the table's schema, which is the real database.
  // PG/MSSQL keep databaseOf() (the connection's DB; the schema is shown separately).
  const schemaIsDatabase = $derived(['mysql', 'mariadb', 'clickhouse'].includes(profile?.system ?? ''))
  const dbName = $derived(
    schemaIsDatabase ? schema || connections.databaseOf(tab.connectionId) : connections.databaseOf(tab.connectionId),
  )
  const accent = $derived(systemMeta(profile?.system).accent)

  let data = $state<QueryResultSet | null>(null)
  let error = $state<QueryError | null>(null)
  let loading = $state(false)
  let durationMs = $state(0)
  let pageSize = $state(100)
  let page = $state(0)
  let pkCols = $state<string[]>([])
  let columnNames = $state<string[]>([])
  // Total row count of the table (COUNT(*)) → footer "Page X of Y · N records".
  // Only computed for the unfiltered view; null while filters are active.
  let totalRecords = $state<number | null>(null)

  // filter builder state — seed từ initialFilters (Set as Filter · T12) nếu có
  // svelte-ignore state_referenced_locally
  const seedFilters = (tab.state.initialFilters as FilterCond[] | undefined) ?? []
  let filtersOpen = $state(seedFilters.length > 0)
  let filters = $state<FilterCond[]>(seedFilters.map((f) => ({ ...f })))
  let combinatorOr = $state(false)
  // sort đa cột
  let sorts = $state<SortSpec[]>([])

  const OPS = ['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IS NULL', 'IS NOT NULL']
  const noValue = (op: string) => op === 'IS NULL' || op === 'IS NOT NULL'

  // Editing is enabled for every relational engine, including ClickHouse — the grid
  // routes CH edits to "Generate mutation" (async ALTER … UPDATE/DELETE) instead of
  // an OLTP apply. Only offered on an unfiltered view (PK targeting is unambiguous).
  const editTarget = $derived<EditTarget | undefined>(
    profile && tab.connectionId && filters.length === 0
      ? { connId: tab.connectionId, system: profile.system, schema, table, pkCols, onApplied: () => void load() }
      : undefined,
  )

  async function load() {
    if (!tab.connectionId || !profile) return
    if (!profile.connected) {
      const ok = await connections.connect(tab.connectionId)
      if (!ok) return
    }
    loading = true
    error = null
    try {
      // chỉ gửi filter có giá trị hợp lệ
      const active = filters.filter((f) => f.col && (noValue(f.op) || String(f.value ?? '') !== ''))
      const res = await execFiltered({
        connId: tab.connectionId,
        schema: profile.system === 'sqlite' ? 'main' : schema,
        table,
        filters: active,
        combinatorOr,
        sorts,
        limit: pageSize,
        offset: page * pageSize,
      })
      durationMs = res.duration_ms
      if (res.ok && res.result) {
        data = res.result
        if (columnNames.length === 0) columnNames = res.result.cols.map((c) => c[0])
        try {
          const cols = await listColumns(tab.connectionId, profile.system === 'sqlite' ? 'main' : schema, table)
          pkCols = cols.filter((c) => c.is_pk).map((c) => c.name)
          if (columnNames.length === 0) columnNames = cols.map((c) => c.name)
        } catch {
          pkCols = []
        }
        // Total record count for the footer — exact for the unfiltered table; with
        // an active filter we show the current window instead (no full count).
        if (active.length) {
          totalRecords = null
        } else {
          try {
            const sch = profile.system === 'sqlite' ? 'main' : schema
            const target = profile.system === 'sqlite' ? quoteIdent('sqlite', table) : qualified(profile.system, sch, table)
            const cnt = await execStatement(tab.connectionId, `SELECT COUNT(*) AS c FROM ${target}`)
            const cell = cnt.ok && cnt.result?.rows?.[0] ? Object.values(cnt.result.rows[0])[0] : null
            const n = typeof cell === 'number' ? cell : Number(cell)
            totalRecords = Number.isFinite(n) ? n : null
          } catch {
            totalRecords = null
          }
        }
      } else if (res.error) {
        error = res.error
      }
    } catch (e) {
      error = { system: profile.system, message: String(e), severity: 'error', raw: String(e) }
    } finally {
      loading = false
    }
  }

  $effect(() => {
    if (profile) void load()
  })

  function addFilter() {
    filters = [...filters, { col: columnNames[0] ?? '', op: '=', value: '' }]
    filtersOpen = true
  }
  function removeFilter(i: number) {
    filters = filters.filter((_, idx) => idx !== i)
    page = 0
    void load()
  }
  function applyFilters() {
    page = 0
    void load()
  }
  function toggleSort(col: string, additive: boolean) {
    const existing = sorts.find((s) => s.col === col)
    if (!additive) {
      // click thường: chỉ sort cột này, xoay asc→desc→bỏ
      if (!existing) sorts = [{ col, desc: false }]
      else if (!existing.desc) sorts = [{ col, desc: true }]
      else sorts = []
    } else {
      // Shift+click: thêm/xoay trong danh sách đa cột
      if (!existing) sorts = [...sorts, { col, desc: false }]
      else if (!existing.desc) sorts = sorts.map((s) => (s.col === col ? { ...s, desc: true } : s))
      else sorts = sorts.filter((s) => s.col !== col)
    }
    page = 0
    void load()
  }
  function sortIndicator(col: string): string {
    const idx = sorts.findIndex((s) => s.col === col)
    if (idx < 0) return ''
    const dir = sorts[idx].desc ? '▼' : '▲'
    return sorts.length > 1 ? `${dir}${idx + 1}` : dir
  }

  const hasMore = $derived(!!data && data.total >= pageSize)
  // Footer pagination: total pages from the exact record count (unfiltered view).
  const totalPages = $derived(totalRecords != null ? Math.max(1, Math.ceil(totalRecords / pageSize)) : null)
  const canNext = $derived(totalPages != null ? page + 1 < totalPages : hasMore)
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- toolbar -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);font-size:var(--px-13)">
    {#if profile}
      <SystemBadge system={profile.system} />
    {/if}
    <!-- Connection this viewer is bound to -->
    <span style="font-weight:600;color:var(--text)" title="Connection">{profile?.name ?? '—'}</span>
    <span style="color:var(--muted)">/</span>
    <!-- Database (+ schema) — distinct accent chip so it's unmistakable -->
    <span
      class="mono"
      title={`Database: ${dbName || '(none)'} · ${schema}.${table}`}
      style="display:inline-flex;align-items:center;gap:var(--px-5);font-size:var(--px-11_5);font-weight:600;color:{accent};background:color-mix(in srgb, {accent} 14%, transparent);border:var(--px-1) solid color-mix(in srgb, {accent} 45%, transparent);border-radius:var(--px-6);padding:var(--px-2) var(--px-8)"
    >
      <span style="font-size:var(--px-11)">▤</span>{dbName || 'database'}
    </span>
    <span class="mono" style="color:var(--text2)" title={`${schema}.${table}`}>{schema}.{table}</span>
    <span class="ds-tbtn" aria-expanded={filtersOpen} onclick={() => (filtersOpen = !filtersOpen)} onkeydown={(e) => e.key === 'Enter' && (filtersOpen = !filtersOpen)} role="button" tabindex="0" title="Filter the rows of this table"><Icon name="filter" size={13} />Filters{#if filters.length}<span class="ds-tbtn-badge">{filters.length}</span>{/if}<Icon name="chevron-down" size={12} /></span>
    <div style="margin-left:auto;display:flex;align-items:center;gap:var(--px-10)">
      {#if data}
        <span class="ds-meta ds-num" title="Time the last read took">{durationMs} ms</span>
      {/if}
      <span class="ds-tbtn" onclick={() => { page = 0; void load() }} onkeydown={(e) => e.key === 'Enter' && (page = 0, load())} role="button" tabindex="0" title="Refresh"><Icon name="refresh" size={13} />Refresh</span>
    </div>
  </div>

  {#if filtersOpen}
    <!-- filter builder — spec §5: column/operator/value AND|OR -->
    <div class="tv-filters">
      {#each filters as f, i (i)}
        <div style="display:flex;align-items:center;gap:var(--px-6)">
          {#if i > 0}
            <span
              class="ds-tbtn tv-comb"
              title="Switch between AND and OR"
              onclick={() => (combinatorOr = !combinatorOr)}
              onkeydown={(e) => e.key === 'Enter' && (combinatorOr = !combinatorOr)}
              role="button"
              tabindex="0"
            >{combinatorOr ? 'OR' : 'AND'}</span>
          {:else}
            <span class="tv-where">Where</span>
          {/if}
          <select class="ds-control" bind:value={f.col} aria-label="Column">
            {#each columnNames as c (c)}<option value={c}>{c}</option>{/each}
          </select>
          <select class="ds-control" bind:value={f.op} aria-label="Operator">
            {#each OPS as op (op)}<option value={op}>{op}</option>{/each}
          </select>
          {#if !noValue(f.op)}
            <input class="ds-control" style="flex:1" bind:value={f.value} placeholder="Value" aria-label="Value" onkeydown={(e) => e.key === 'Enter' && applyFilters()} />
          {:else}
            <span style="flex:1"></span>
          {/if}
          <span class="ds-act" style="opacity:1" onclick={() => removeFilter(i)} onkeydown={(e) => e.key === 'Enter' && removeFilter(i)} role="button" tabindex="0" title="Remove this condition" aria-label="Remove this condition"><Icon name="close" size={13} /></span>
        </div>
      {/each}
      <div style="display:flex;gap:var(--px-8)">
        <span class="ds-tbtn" onclick={addFilter} onkeydown={(e) => e.key === 'Enter' && addFilter()} role="button" tabindex="0"><Icon name="plus" size={13} />Add condition</span>
        {#if filters.length}
          <span class="ds-tbtn" style="margin-left:auto" onclick={() => { filters = []; page = 0; void load() }} onkeydown={(e) => e.key === 'Enter' && (filters = [], page = 0, load())} role="button" tabindex="0">Clear</span>
          <span class="ds-tbtn primary" onclick={applyFilters} onkeydown={(e) => e.key === 'Enter' && applyFilters()} role="button" tabindex="0"><Icon name="check" size={13} />Apply filter</span>
        {/if}
      </div>
    </div>
  {/if}

  <!-- sort header bar (click cột để sort; Shift+click thêm cột) -->
  {#if data && columnNames.length > 0}
    <div class="tv-sortbar">
      <span class="tv-sort-label" title="Click a column to sort; Shift+click to add a second sort"><Icon name="sort" size={13} />Sort</span>
      {#each columnNames as c (c)}
        <span
          class="tv-sort"
          class:on={!!sortIndicator(c)}
          aria-pressed={!!sortIndicator(c)}
          onclick={(e) => toggleSort(c, e.shiftKey)}
          onkeydown={(e) => e.key === 'Enter' && toggleSort(c, false)}
          role="button"
          tabindex="0"
        >{c} {sortIndicator(c)}</span>
      {/each}
    </div>
  {/if}

  <div style="min-height:0;flex:1;display:flex;flex-direction:column">
    {#if loading}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">Loading…</div>
    {:else if error}
      <div class="selectable" style="padding:var(--px-16);font-size:var(--px-12_5);color:var(--error)">
        ✗ {error.message}
        {#if error.hint}
          <div style="margin-top:var(--px-4);color:var(--warn)">💡 {error.hint}</div>
        {/if}
      </div>
    {:else if data}
      <ResultGrid {data} {editTarget} />
    {:else}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">
        {profile ? 'No data' : 'Connection not found'}
      </div>
    {/if}
  </div>

  <!-- footer pager — rows/page + record + page count in English -->
  {#if data}
    <div class="tv-foot">
      <label class="ds-field">
        Page size
        <select
          class="ds-control"
          bind:value={pageSize}
          onchange={() => { page = 0; void load() }}
        >
          <option value={100}>100</option>
          <option value={200}>200</option>
          <option value={500}>500</option>
          <option value={1000}>1000</option>
        </select>
      </label>
      <span class="ds-meta ds-num">
        {#if data.rows.length}
          <b>{(page * pageSize + 1).toLocaleString()}–{(page * pageSize + data.rows.length).toLocaleString()}</b>
        {:else}
          0
        {/if}
        {#if totalRecords != null}
          of {totalRecords.toLocaleString()} row{totalRecords === 1 ? '' : 's'}
        {:else}
          (filtered)
        {/if}
      </span>
      <div class="ds-pager" style="margin-left:auto">
        <span aria-disabled={page === 0} onclick={() => { if (page > 0) { page = 0; void load() } }} onkeydown={(e) => e.key === 'Enter' && page > 0 && (page = 0, load())} role="button" tabindex="0" title="First page" aria-label="First page"><Icon name="first" size={13} /></span>
        <span aria-disabled={page === 0} onclick={() => { if (page > 0) { page--; void load() } }} onkeydown={(e) => e.key === 'Enter' && page > 0 && (page--, load())} role="button" tabindex="0" title="Previous page" aria-label="Previous page"><Icon name="chevron-left" size={13} /></span>
        <span class="ds-pager-label">
          Page <b>{(page + 1).toLocaleString()}</b>{totalPages != null ? ` of ${totalPages.toLocaleString()}` : ''}
        </span>
        <span aria-disabled={!canNext} onclick={() => { if (canNext) { page++; void load() } }} onkeydown={(e) => e.key === 'Enter' && canNext && (page++, load())} role="button" tabindex="0" title="Next page" aria-label="Next page"><Icon name="chevron-right" size={13} /></span>
        {#if totalPages != null}
          <span aria-disabled={page + 1 >= totalPages} onclick={() => { if (totalPages != null && page + 1 < totalPages) { page = totalPages - 1; void load() } }} onkeydown={(e) => e.key === 'Enter' && totalPages != null && page + 1 < totalPages && (page = totalPages - 1, load())} role="button" tabindex="0" title="Last page" aria-label="Last page"><Icon name="last" size={13} /></span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  /* Open Data — toolbars follow the shared rule (theme.css .ds-tbtn / .ds-control /
     .ds-pager); only the layout lives here. */
  .tv-filters {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--px-8);
    padding: var(--px-10) var(--px-14);
    border-bottom: var(--px-1) solid var(--border);
    background: var(--header);
  }
  .tv-filters > div {
    align-items: center;
  }
  .tv-where,
  .tv-comb {
    flex: none;
    width: var(--px-56);
    justify-content: center;
  }
  .tv-where {
    font-size: var(--px-12_5);
    color: var(--muted);
    text-align: center;
  }
  .tv-sortbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-6);
    padding: var(--px-7) var(--px-14);
    border-bottom: var(--px-1) solid var(--border);
    background: var(--surface);
    overflow-x: auto;
  }
  .tv-sort-label {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
    margin-right: var(--px-4);
    font-size: var(--px-12);
    font-weight: 500;
    color: var(--muted);
  }
  .tv-sort {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    height: var(--px-26);
    padding: 0 var(--px-10);
    border-radius: var(--px-20);
    border: var(--px-1) solid var(--border);
    background: var(--panel);
    font-size: var(--px-12_5);
    font-weight: 500;
    color: var(--text2);
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
    transition: background-color 0.12s, border-color 0.12s, color 0.12s;
  }
  .tv-sort:hover {
    color: var(--text);
    border-color: color-mix(in srgb, var(--primary) 40%, var(--border2));
    background: color-mix(in srgb, var(--primary) 6%, var(--panel));
  }
  .tv-sort.on {
    color: var(--primary);
    font-weight: 600;
    border-color: color-mix(in srgb, var(--primary) 55%, transparent);
    background: color-mix(in srgb, var(--primary) 10%, transparent);
  }
  .tv-foot {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--px-14);
    padding: var(--px-7) var(--px-14);
    border-top: var(--px-1) solid var(--border);
    background: var(--header);
  }
</style>
