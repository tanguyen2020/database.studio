<script lang="ts">
  // Table Data Viewer — mở khi double-click bảng trong Explorer. Filter builder
  // (column/operator/value, AND|OR) + sort đa cột (Shift+click header) + phân
  // trang server-side (LIMIT/OFFSET) qua exec_filtered (tham số hóa). Reuse
  // ResultGrid + editable grid (spec phase-2 §5).
  import ResultGrid, { type EditTarget } from '$lib/components/results/ResultGrid.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { execFiltered, listColumns, type FilterCond, type SortSpec } from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
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

  let data = $state<QueryResultSet | null>(null)
  let error = $state<QueryError | null>(null)
  let loading = $state(false)
  let durationMs = $state(0)
  let pageSize = $state(100)
  let page = $state(0)
  let pkCols = $state<string[]>([])
  let columnNames = $state<string[]>([])

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

  const isChSqlite = $derived(profile?.system === 'clickhouse')
  const editTarget = $derived<EditTarget | undefined>(
    profile && !isChSqlite && tab.connectionId && filters.length === 0
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
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- toolbar -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--surface);font-size:var(--px-12)">
    {#if profile}
      <SystemBadge system={profile.system} />
    {/if}
    <span class="mono">{schema}.{table}</span>
    <span class="tv-btn" style="background:{filtersOpen ? 'var(--hover)' : 'var(--panel)'}" onclick={() => (filtersOpen = !filtersOpen)} onkeydown={(e) => e.key === 'Enter' && (filtersOpen = !filtersOpen)} role="button" tabindex="0">Filters {filters.length ? `(${filters.length})` : ''} ▾</span>
    <div style="margin-left:auto;display:flex;align-items:center;gap:var(--px-8)">
      <label style="display:flex;align-items:center;gap:var(--px-4);font-size:var(--px-11);color:var(--text2)">
        Rows / page
        <select
          style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-4);font-size:var(--px-11);color:var(--text)"
          bind:value={pageSize}
          onchange={() => { page = 0; void load() }}
        >
          <option value={100}>100</option>
          <option value={500}>500</option>
          <option value={1000}>1000</option>
        </select>
      </label>
      <span class="tv-btn" onclick={() => { page = 0; void load() }} onkeydown={(e) => e.key === 'Enter' && (page = 0, load())} role="button" tabindex="0" title="Refresh">⟳</span>
      {#if data}
        <span class="mono" style="font-size:var(--px-11);color:var(--muted)">{data.total.toLocaleString()} rows · {durationMs} ms</span>
      {/if}
    </div>
  </div>

  {#if filtersOpen}
    <!-- filter builder — spec §5: column/operator/value AND|OR -->
    <div style="flex:none;padding:var(--px-8) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--header);display:flex;flex-direction:column;gap:var(--px-6)">
      {#each filters as f, i (i)}
        <div style="display:flex;align-items:center;gap:var(--px-6)">
          {#if i > 0}
            <span
              class="tv-btn"
              style="width:var(--px-44);text-align:center"
              onclick={() => (combinatorOr = !combinatorOr)}
              onkeydown={(e) => e.key === 'Enter' && (combinatorOr = !combinatorOr)}
              role="button"
              tabindex="0"
            >{combinatorOr ? 'OR' : 'AND'}</span>
          {:else}
            <span style="width:var(--px-44)"></span>
          {/if}
          <select class="tv-sel" bind:value={f.col}>
            {#each columnNames as c (c)}<option value={c}>{c}</option>{/each}
          </select>
          <select class="tv-sel" bind:value={f.op}>
            {#each OPS as op (op)}<option value={op}>{op}</option>{/each}
          </select>
          {#if !noValue(f.op)}
            <input class="tv-sel mono" style="flex:1" bind:value={f.value} placeholder="value" onkeydown={(e) => e.key === 'Enter' && applyFilters()} />
          {:else}
            <span style="flex:1"></span>
          {/if}
          <span class="tv-btn" onclick={() => removeFilter(i)} onkeydown={(e) => e.key === 'Enter' && removeFilter(i)} role="button" tabindex="0">×</span>
        </div>
      {/each}
      <div style="display:flex;gap:var(--px-8)">
        <span class="tv-btn" onclick={addFilter} onkeydown={(e) => e.key === 'Enter' && addFilter()} role="button" tabindex="0">＋ Add condition</span>
        {#if filters.length}
          <span class="tv-btn" style="margin-left:auto" onclick={() => { filters = []; page = 0; void load() }} onkeydown={(e) => e.key === 'Enter' && (filters = [], page = 0, load())} role="button" tabindex="0">Clear</span>
          <span
            onclick={applyFilters}
            onkeydown={(e) => e.key === 'Enter' && applyFilters()}
            role="button"
            tabindex="0"
            style="font-size:var(--px-11_5);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer"
          >Apply filter</span>
        {/if}
      </div>
    </div>
  {/if}

  <!-- sort header bar (click cột để sort; Shift+click thêm cột) -->
  {#if data && columnNames.length > 0}
    <div style="flex:none;display:flex;gap:var(--px-6);padding:var(--px-4) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--surface);overflow-x:auto">
      <span style="font-size:var(--px-10);color:var(--muted);flex:none;align-self:center">Sort:</span>
      {#each columnNames as c (c)}
        <span
          class="tv-sort"
          style="{sortIndicator(c) ? 'color:var(--primary);border-color:var(--primary)' : ''}"
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
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">Đang tải…</div>
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
        {profile ? 'Không có dữ liệu' : 'Connection không tồn tại'}
      </div>
    {/if}
  </div>

  <!-- pager — dòng 571-587 -->
  {#if data && (page > 0 || hasMore)}
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-7) var(--px-12);border-top:var(--px-1) solid var(--border);background:var(--header)">
      <span class="mono" style="font-size:var(--px-11_5);color:var(--text2)">
        {(page * pageSize + 1).toLocaleString()}–{(page * pageSize + data.rows.length).toLocaleString()}
      </span>
      <div style="margin-left:auto;display:flex;gap:var(--px-5)">
        <span class="tv-pg" style="opacity:{page > 0 ? 1 : 0.4}" onclick={() => { if (page > 0) { page = 0; void load() } }} onkeydown={(e) => e.key === 'Enter' && page > 0 && (page = 0, load())} role="button" tabindex="0">«</span>
        <span class="tv-pg" style="opacity:{page > 0 ? 1 : 0.4}" onclick={() => { if (page > 0) { page--; void load() } }} onkeydown={(e) => e.key === 'Enter' && page > 0 && (page--, load())} role="button" tabindex="0">‹</span>
        <span class="mono" style="align-self:center;font-size:var(--px-11_5);color:var(--text2)">trang {page + 1}</span>
        <span class="tv-pg" style="opacity:{hasMore ? 1 : 0.4}" onclick={() => { if (hasMore) { page++; void load() } }} onkeydown={(e) => e.key === 'Enter' && hasMore && (page++, load())} role="button" tabindex="0">›</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .tv-btn {
    font-size: var(--px-11);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-3) var(--px-9);
    cursor: pointer;
  }
  .tv-btn:hover {
    background: var(--hover);
  }
  .tv-sel {
    background: var(--panel);
    color: var(--text);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-5);
    padding: var(--px-4) var(--px-6);
    font-size: var(--px-11_5);
  }
  .tv-sort {
    flex: none;
    font-size: var(--px-10_5);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-5);
    padding: var(--px-2) var(--px-8);
    cursor: pointer;
    white-space: nowrap;
  }
  .tv-sort:hover {
    background: var(--hover);
  }
  .tv-pg {
    width: var(--px-28);
    height: var(--px-24);
    display: flex;
    align-items: center;
    justify-content: center;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    cursor: pointer;
    font-family: var(--font-mono);
  }
</style>
