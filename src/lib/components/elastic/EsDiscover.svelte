<script lang="ts">
  // Discover (Kibana): query bar (KQL / Lucene) + time picker + filter pills, the
  // field list with top values, a hits-over-time histogram, the document table
  // (columns, sort, paging) and the document flyout (view / edit / delete / add).
  import { onMount, untrack } from 'svelte'
  import '$lib/elastic/es.css'
  import * as ipc from '$lib/ipc'
  import EsIcon from './EsIcon.svelte'
  import EsDocFlyout from './EsDocFlyout.svelte'
  import EsFieldToken from './EsFieldToken.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { focusOnMount } from '$lib/elastic/actions'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { search, totalOf, type EsHit, type EsSearchResult } from '$lib/elastic/api'
  import { buildQuery, filterLabel, KqlError, type Filter, type QueryLanguage } from '$lib/elastic/kql'
  import {
    displayValue,
    flattenSource,
    fmtCount,
    fmtTimestamp,
    getPath,
    isAggregatable,
    isDateType,
    sourcePathOf,
    TIME_PRESETS,
    timeRange,
  } from '$lib/elastic/format'
  import { toCsv, withBom } from '$lib/export/rows'
  import { saveText } from '$lib/elastic/save'
  import { searchProduct } from '$lib/elastic/flavor'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'

  interface Props {
    connId: string
    index: string
    /** persisted view state (lives in the tab) */
    view: {
      query?: string
      language?: QueryLanguage
      filters?: Filter[]
      columns?: string[]
      time?: string
      sort?: { field: string; dir: 'asc' | 'desc' }[]
      pageSize?: number
    }
  }
  let { connId, index, view }: Props = $props()

  // ---- state ---------------------------------------------------------------------
  // the view state is read ONCE (it seeds the local state; persist() writes it back)
  const init = untrack(() => ({ ...view }))
  let fields = $state<[string, string][]>([])
  let fieldsError = $state<string | null>(null)
  let queryText = $state(init.query ?? '')
  let language = $state<QueryLanguage>(init.language ?? 'kql')
  let filters = $state<Filter[]>(init.filters ?? [])
  let columns = $state<string[]>(init.columns ?? [])
  let timeKey = $state(init.time ?? 'all')
  let custom = $state<{ from: string; to: string } | null>(null)
  let sort = $state<{ field: string; dir: 'asc' | 'desc' }[]>(init.sort ?? [])
  let pageSize = $state(init.pageSize ?? 50)
  let page = $state(0)
  let result = $state<EsSearchResult | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let queryError = $state<{ message: string; pos: number } | null>(null)
  let fieldSearch = $state('')
  let expandedField = $state<string | null>(null)
  let topValues = $state<{ key: unknown; count: number }[] | null>(null)
  let topError = $state<string | null>(null)
  let flyout = $state<{ hit: EsHit | null } | null>(null)
  let addFilter = $state<{ field: string; op: Filter['op']; value: string } | null>(null)
  let tookMs = $state<number | null>(null)
  let lastRequest = $state<unknown>(null)
  let inspect = $state<'request' | 'response' | null>(null)

  const MAX_WINDOW = 10_000

  const typeMap = $derived(Object.fromEntries(fields))
  // multi-fields (`name.keyword`) are hidden like in Kibana; sorting / top values use them
  const visibleFields = $derived(fields.filter(([f]) => !f.endsWith('.keyword')))
  const timeField = $derived.by(() => {
    const dates = fields.filter(([, t]) => isDateType(t)).map(([f]) => f)
    return dates.find((f) => f === '@timestamp') ?? dates.find((f) => /timestamp|time|date|created/i.test(f)) ?? dates[0] ?? null
  })
  const total = $derived(result ? totalOf(result) : null)
  const hits = $derived(result?.hits.hits ?? [])
  const buckets = $derived(
    ((result?.aggregations?.hist as { buckets?: { key: number; doc_count: number }[]; interval?: string } | undefined)?.buckets ?? []),
  )
  const histInterval = $derived((result?.aggregations?.hist as { interval?: string } | undefined)?.interval ?? '')
  const pageCount = $derived(total ? Math.max(1, Math.ceil(Math.min(total.value, MAX_WINDOW) / pageSize)) : 1)

  /** field used for sorting / aggregating (text → its .keyword when there is one) */
  function aggField(f: string): string | null {
    const t = typeMap[f]
    if (t && isAggregatable(t)) return f
    if (typeMap[`${f}.keyword`]) return `${f}.keyword`
    return null
  }

  function persist() {
    Object.assign(view, { query: queryText, language, filters: $state.snapshot(filters), columns: $state.snapshot(columns), time: timeKey, sort: $state.snapshot(sort), pageSize })
  }

  async function loadFields() {
    try {
      fields = await ipc.esMappingFields(connId, index)
      fieldsError = null
      // default sort: newest first on the time field
      if (!sort.length && timeField) sort = [{ field: timeField, dir: 'desc' }]
    } catch (e) {
      fieldsError = String(e)
    }
  }

  function range() {
    if (custom) return custom
    return timeRange(timeKey)
  }

  let gen = 0
  async function run(resetPage = false) {
    if (resetPage) page = 0
    let query
    try {
      const r = range()
      query = buildQuery({ text: queryText, language, filters, timeField, from: r.from, to: r.to })
      queryError = null
    } catch (e) {
      if (e instanceof KqlError) {
        queryError = { message: e.message, pos: e.pos }
        return
      }
      throw e
    }
    const mine = ++gen
    loading = true
    error = null
    persist()
    try {
      const body: Record<string, unknown> = {
        query,
        from: page * pageSize,
        size: pageSize,
        track_total_hits: true,
        version: true,
      }
      if (sort.length) body.sort = sort.map((s) => ({ [aggField(s.field) ?? s.field]: { order: s.dir, unmapped_type: 'keyword' } }))
      if (timeField) body.aggs = { hist: { auto_date_histogram: { field: timeField, buckets: 48 } } }
      const started = performance.now()
      lastRequest = body
      const r = await search(connId, index, body)
      if (mine !== gen) return
      result = r
      tookMs = r.took ?? Math.round(performance.now() - started)
    } catch (e) {
      if (mine === gen) {
        error = String((e as Error).message ?? e)
        result = null
      }
    } finally {
      if (mine === gen) loading = false
    }
  }

  onMount(() => {
    void (async () => {
      await loadFields()
      await run()
    })()
  })

  // ---- fields --------------------------------------------------------------------
  function toggleColumn(f: string) {
    columns = columns.includes(f) ? columns.filter((c) => c !== f) : [...columns, f]
    persist()
  }

  async function showTop(f: string) {
    if (expandedField === f) {
      expandedField = null
      return
    }
    expandedField = f
    topValues = null
    topError = null
    const af = aggField(f)
    if (!af) {
      // not aggregatable (text without .keyword): sample the current page
      const counts = new Map<string, number>()
      for (const h of hits) {
        const v = getPath(h._source, f)
        if (v == null) continue
        const k = displayValue(v)
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
      topValues = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, count]) => ({ key, count }))
      topError = 'Not aggregatable — values sampled from the current page'
      return
    }
    try {
      const r = range()
      const r2 = await search(connId, index, {
        size: 0,
        track_total_hits: true,
        query: buildQuery({ text: queryText, language, filters, timeField, from: r.from, to: r.to }),
        aggs: { top: { terms: { field: af, size: 5 } }, present: { value_count: { field: af } } },
      })
      const b = (r2.aggregations?.top as { buckets: { key: unknown; key_as_string?: string; doc_count: number }[] }).buckets
      topValues = b.map((x) => ({ key: x.key_as_string ?? x.key, count: x.doc_count }))
    } catch (e) {
      topError = String((e as Error).message ?? e)
    }
  }

  function addPill(field: string, value: unknown, negate: boolean) {
    const f = sourcePathOf(field)
    filters = [...filters, { field: f, op: negate ? 'is not' : 'is', value: displayValue(value) }]
    void run(true)
  }

  function removePill(i: number) {
    filters = filters.filter((_, j) => j !== i)
    void run(true)
  }

  function togglePill(i: number) {
    filters = filters.map((f, j) => (j === i ? { ...f, disabled: !f.disabled } : f))
    void run(true)
  }

  function invertPill(i: number) {
    const swap: Partial<Record<Filter['op'], Filter['op']>> = { is: 'is not', 'is not': 'is', exists: 'does not exist', 'does not exist': 'exists' }
    filters = filters.map((f, j) => (j === i && swap[f.op] ? { ...f, op: swap[f.op]! } : f))
    void run(true)
  }

  function commitFilter() {
    if (!addFilter || !addFilter.field) return
    const f: Filter =
      addFilter.op === 'is one of'
        ? { field: addFilter.field, op: 'is one of', values: addFilter.value.split(',').map((s) => s.trim()).filter(Boolean) }
        : addFilter.op === 'exists' || addFilter.op === 'does not exist'
          ? { field: addFilter.field, op: addFilter.op }
          : { field: addFilter.field, op: addFilter.op, value: addFilter.value }
    filters = [...filters, f]
    addFilter = null
    void run(true)
  }

  // ---- sort / paging ---------------------------------------------------------------
  function sortBy(f: string) {
    if (!aggField(f)) return
    const cur = sort.find((s) => s.field === f)
    sort = cur ? (cur.dir === 'desc' ? [{ field: f, dir: 'asc' }] : []) : [{ field: f, dir: 'desc' }]
    void run(true)
  }

  function go(p: number) {
    page = Math.max(0, Math.min(pageCount - 1, p))
    void run()
  }

  // ---- histogram ---------------------------------------------------------------------
  function intervalMs(i: string): number {
    const m = /^(\d+)(ms|s|m|h|d|w|M|y)$/.exec(i)
    if (!m) return 86_400_000
    const u: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, M: 2_592_000_000, y: 31_536_000_000 }
    return Number(m[1]) * u[m[2]]
  }
  const maxCount = $derived(Math.max(1, ...buckets.map((b) => b.doc_count)))

  function zoom(b: { key: number }) {
    const ms = intervalMs(histInterval)
    custom = { from: new Date(b.key).toISOString(), to: new Date(b.key + ms).toISOString() }
    void run(true)
  }

  function setTime(k: string) {
    custom = null
    timeKey = k
    void run(true)
  }

  // ---- export --------------------------------------------------------------------------
  async function exportPage(fmt: 'csv' | 'json') {
    const rows = hits.map((h) => ({ _id: h._id, _index: h._index, ...flattenSource(h._source ?? {}) }))
    const headers = columns.length ? ['_id', ...(timeField && !columns.includes(timeField) ? [timeField] : []), ...columns] : [...new Set(rows.flatMap((r) => Object.keys(r)))]
    const content = fmt === 'csv' ? withBom(toCsv(headers, rows)) : JSON.stringify(hits.map((h) => ({ _id: h._id, _index: h._index, ...h._source })), null, 2)
    const ok = await saveText(`${index.replace(/[^\w.-]+/g, '_')}-page${page + 1}.${fmt}`, content, fmt, fmt === 'csv' ? 'text/csv' : 'application/json')
    if (ok) toasts.success(`Exported ${hits.length} documents`, 'elasticsearch')
  }

  function summary(src: Record<string, unknown> | undefined) {
    const flat = flattenSource(src ?? {})
    return Object.entries(flat).slice(0, 14)
  }

  function docsChanged() {
    explorer.bumpEs(connId)
    void run()
  }

  const timeLabel = $derived(custom ? `${fmtTimestamp(custom.from)} → ${fmtTimestamp(custom.to)}` : (TIME_PRESETS.find((p) => p.key === timeKey)?.label ?? 'All time'))
</script>

<div class="esd" data-testid="es-discover">
  <!-- query bar -->
  <div class="esd-bar">
    <span class="es-seg" title="Query language">
      <button class:on={language === 'kql'} onclick={() => { language = 'kql'; void run(true) }} title={searchProduct(connId).queryLanguageLong}>{searchProduct(connId).queryLanguage}</button>
      <button class:on={language === 'lucene'} onclick={() => { language = 'lucene'; void run(true) }} title="Lucene query syntax">Lucene</button>
    </span>
    <div class="esd-q" class:invalid={!!queryError}>
      <EsIcon name="search" size={14} />
      <input
        bind:value={queryText}
        placeholder={language === 'kql' ? 'Search… e.g. status:paid and amount >= 100' : 'Search… e.g. status:paid AND amount:[100 TO *]'}
        aria-label="Search query"
        spellcheck="false"
        onkeydown={(e) => e.key === 'Enter' && run(true)}
      />
    </div>
    {#if timeField}
      <span class="esd-time" title="Time range on {timeField}">
        <EsIcon name="calendar" size={14} />
        {#if custom}
          <span class="es-ellipsis" style="max-width:var(--px-300)">{timeLabel}</span>
          <button class="es-pill-x" aria-label="Clear custom range" onclick={() => setTime(timeKey)}><EsIcon name="close" size={11} /></button>
        {:else}
          <select value={timeKey} onchange={(e) => setTime((e.currentTarget as HTMLSelectElement).value)} aria-label="Time range">
            {#each TIME_PRESETS as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
          </select>
        {/if}
      </span>
    {/if}
    <button class="eg-btn primary esd-update" onclick={() => run(true)} aria-busy={loading}>
      {#if loading}<span class="es-spin"><EsIcon name="refresh" size={13} /></span>{:else}<EsIcon name="refresh" size={13} />{/if}
      {loading ? 'Searching…' : 'Refresh'}
    </button>
  </div>
  {#if queryError}
    <div class="esd-qerr" role="alert">{language === 'kql' ? `${searchProduct(connId).queryLanguage} syntax error` : 'Syntax error'}: {queryError.message} (at character {queryError.pos + 1})</div>
  {/if}

  <!-- filter pills -->
  <div class="esd-filters">
    {#each filters as fl, i (i)}
      <span class="es-pill" class:neg={fl.op === 'is not' || fl.op === 'does not exist'} class:off={fl.disabled} title={filterLabel(fl)}>
        <button class="esd-pill-label" onclick={() => togglePill(i)} title={fl.disabled ? 'Enable filter' : 'Temporarily disable'}>{filterLabel(fl)}</button>
        <button class="es-pill-x" title="Include / exclude results" aria-label="Invert filter" onclick={() => invertPill(i)}>±</button>
        <button class="es-pill-x" aria-label="Remove filter {filterLabel(fl)}" onclick={() => removePill(i)}><EsIcon name="close" size={11} /></button>
      </span>
    {/each}
    {#if addFilter}
      <span class="esd-addf" role="group" aria-label="Add filter">
        <select class="es-input" style="padding:var(--px-3) var(--px-6)" bind:value={addFilter.field} aria-label="Filter field">
          <option value="" disabled>Field…</option>
          {#each visibleFields as [f] (f)}<option value={f}>{f}</option>{/each}
        </select>
        <select class="es-input" style="padding:var(--px-3) var(--px-6)" bind:value={addFilter.op} aria-label="Filter operator">
          {#each ['is', 'is not', 'is one of', 'exists', 'does not exist'] as op (op)}<option value={op}>{op}</option>{/each}
        </select>
        {#if addFilter.op !== 'exists' && addFilter.op !== 'does not exist'}
          <input class="es-input" style="padding:var(--px-3) var(--px-8);width:var(--px-160)" bind:value={addFilter.value} placeholder={addFilter.op === 'is one of' ? 'a, b, c' : 'value'} aria-label="Filter value" onkeydown={(e) => e.key === 'Enter' && commitFilter()} />
        {/if}
        <button class="eg-btn primary" onclick={commitFilter} disabled={!addFilter.field}>Add</button>
        <button class="eg-btn" onclick={() => (addFilter = null)}>Cancel</button>
      </span>
    {:else}
      <button class="esd-addbtn" onclick={() => (addFilter = { field: '', op: 'is', value: '' })}><EsIcon name="filter" size={12} /> Add filter</button>
    {/if}
  </div>

  <div class="esd-split">
    <!-- field list -->
    <aside class="esd-side" aria-label="Fields">
      <div style="padding:var(--px-10) var(--px-10) var(--px-6)">
        <input class="es-input" style="width:100%" bind:value={fieldSearch} placeholder="Search field names" aria-label="Search field names" />
      </div>
      {#if fieldsError}<div class="es-callout danger" style="margin:var(--px-8)">{fieldsError}</div>{/if}
      <div class="esd-fields">
        {#if columns.length}
          <div class="esd-fh">Selected fields <span>{columns.length}</span></div>
          {#each columns as f (f)}
            <div class="esd-field sel">
              <EsFieldToken type={typeMap[f] ?? ''} />
              <span class="es-ellipsis" style="flex:1 1 auto">{f}</span>
              <button class="esd-fbtn" aria-label="Remove column {f}" title="Remove column" onclick={() => toggleColumn(f)}><EsIcon name="close" size={11} /></button>
            </div>
          {/each}
        {/if}
        <div class="esd-fh">Available fields <span>{visibleFields.length}</span></div>
        {#each visibleFields.filter(([f]) => !columns.includes(f) && (!fieldSearch || f.toLowerCase().includes(fieldSearch.toLowerCase()))) as [f, t] (f)}
          <div class="esd-field" class:open={expandedField === f}>
            <EsFieldToken type={t} />
            <button class="esd-fname es-ellipsis" onclick={() => showTop(f)} title="Show top values of {f}">{f}</button>
            <button class="esd-fbtn" aria-label="Add column {f}" title="Add as column" onclick={() => toggleColumn(f)}><EsIcon name="plus" size={12} /></button>
          </div>
          {#if expandedField === f}
            <div class="esd-top" data-testid="es-top-values">
              <div class="esd-top-h">Top 5 values</div>
              {#if topValues === null && !topError}
                <div class="es-help">Loading…</div>
              {:else}
                {#each topValues ?? [] as tv (String(tv.key))}
                  {@const pct = total && total.value ? Math.round((tv.count / total.value) * 1000) / 10 : 0}
                  <div class="esd-tv">
                    <div class="esd-tv-row">
                      <span class="es-ellipsis mono" style="flex:1 1 auto" title={displayValue(tv.key)}>{displayValue(tv.key)}</span>
                      <span class="esd-tv-pct">{pct}%</span>
                      <button class="esd-fbtn" title="Filter for value" aria-label="Filter for {displayValue(tv.key)}" onclick={() => addPill(f, tv.key, false)}><EsIcon name="filterInclude" size={12} /></button>
                      <button class="esd-fbtn" title="Filter out value" aria-label="Filter out {displayValue(tv.key)}" onclick={() => addPill(f, tv.key, true)}><EsIcon name="filterExclude" size={12} /></button>
                    </div>
                    <div class="esd-tv-bar"><span style="width:{Math.min(100, pct)}%"></span></div>
                  </div>
                {/each}
                {#if topError}<div class="es-help">{topError}</div>{/if}
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    </aside>

    <!-- results -->
    <section class="esd-main">
      <div class="esd-summary">
        {#if total}
          <span class="esd-hits" data-testid="es-hits"><b>{fmtCount(total.value)}</b>{total.exact ? '' : '+'} hits</span>
        {:else if loading}
          <span class="esd-hits">Searching…</span>
        {/if}
        {#if tookMs != null && !loading}<span class="es-badge">{tookMs} ms</span>{/if}
        {#if timeField}<span class="es-badge" title="Time field">{timeField}</span>{/if}
        <span style="margin-left:auto;display:flex;gap:var(--px-6)">
          <button class="eg-btn" onclick={() => (inspect = 'request')} disabled={!lastRequest} title="Show the request sent to {searchProduct(connId).name} and its response"><EsIcon name="inspect" size={13} /> Inspect</button>
          <button class="eg-btn" onclick={() => (flyout = { hit: null })}><EsIcon name="plus" size={13} /> Add document</button>
          <button class="eg-btn" onclick={() => exportPage('csv')} disabled={!hits.length} title="Export this page as CSV"><EsIcon name="download" size={13} /> CSV</button>
          <button class="eg-btn" onclick={() => exportPage('json')} disabled={!hits.length} title="Export this page as JSON"><EsIcon name="download" size={13} /> JSON</button>
        </span>
      </div>

      {#if timeField && buckets.length}
        <div class="esd-hist" role="img" aria-label="Hits over time">
          <svg viewBox="0 0 {buckets.length * 10} 60" preserveAspectRatio="none" class="esd-hist-svg">
            {#each buckets as b, i (b.key)}
              {@const h = (b.doc_count / maxCount) * 56}
              <rect
                x={i * 10 + 1}
                y={60 - h}
                width="8"
                height={Math.max(h, b.doc_count ? 1 : 0)}
                class="esd-bar"
                role="button"
                tabindex="-1"
                onclick={() => zoom(b)}
                onkeydown={() => {}}
              ><title>{fmtTimestamp(b.key)} — {fmtCount(b.doc_count)} hits (click to zoom)</title></rect>
            {/each}
          </svg>
          <div class="esd-hist-axis">
            <span>{fmtTimestamp(buckets[0].key)}</span>
            <span>per {histInterval}</span>
            <span>{fmtTimestamp(buckets[buckets.length - 1].key)}</span>
          </div>
        </div>
      {/if}

      {#if error}
        <div class="es-callout danger" role="alert" style="margin:var(--px-12)">{error}</div>
      {/if}

      <div class="esd-table-wrap">
        {#if !loading && result && !hits.length}
          <div class="es-empty">
            <div class="es-empty-title">No results match your search criteria</div>
            Expand the time range, remove filters or check the query.
          </div>
        {:else}
          <table class="es-table esd-table" data-testid="es-doc-grid">
            <thead>
              <tr>
                <th style="width:var(--px-30)"></th>
                {#if timeField && !columns.includes(timeField)}
                  <th class="esd-sortable" onclick={() => sortBy(timeField!)} title="Sort by {timeField}">
                    {timeField}
                    {#if sort[0]?.field === timeField}{sort[0].dir === 'desc' ? '↓' : '↑'}{/if}
                  </th>
                {/if}
                {#if columns.length}
                  {#each columns as c (c)}
                    <th class:esd-sortable={!!aggField(c)} onclick={() => sortBy(c)} title={aggField(c) ? `Sort by ${c}` : `${c} is not sortable`}>
                      {c}
                      {#if sort[0]?.field === c}{sort[0].dir === 'desc' ? '↓' : '↑'}{/if}
                    </th>
                  {/each}
                {:else}
                  <th>Document</th>
                {/if}
              </tr>
            </thead>
            <tbody>
              {#each hits as h (h._index + h._id)}
                <tr class="esd-row" ondblclick={() => (flyout = { hit: h })}>
                  <td>
                    <button class="esd-fbtn" aria-label="Inspect document {h._id}" title="Inspect document" onclick={() => (flyout = { hit: h })}><EsIcon name="expand" size={12} /></button>
                  </td>
                  {#if timeField && !columns.includes(timeField)}
                    <td class="mono" style="white-space:nowrap">{fmtTimestamp(getPath(h._source, timeField))}</td>
                  {/if}
                  {#if columns.length}
                    {#each columns as c (c)}
                      {@const v = getPath(h._source, sourcePathOf(c))}
                      <td class="mono esd-cell" title={displayValue(v)}>{isDateType(typeMap[c] ?? '') ? fmtTimestamp(v) : displayValue(v)}</td>
                    {/each}
                  {:else}
                    <td class="esd-doc">
                      {#each summary(h._source) as [k, v] (k)}
                        <span class="esd-kv"><span class="esd-k">{k}</span> <span class="esd-v">{displayValue(v)}</span></span>
                      {/each}
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      {#if total && total.value > 0}
        <div class="esd-pager">
          <span style="color:var(--text2)">
            Rows per page
            <select class="es-input" style="padding:var(--px-2) var(--px-6);margin-left:var(--px-4)" value={pageSize} aria-label="Rows per page" onchange={(e) => { pageSize = Number((e.currentTarget as HTMLSelectElement).value); void run(true) }}>
              {#each [25, 50, 100, 500] as n (n)}<option value={n}>{n}</option>{/each}
            </select>
          </span>
          <span style="color:var(--text2)" data-testid="es-range">{fmtCount(page * pageSize + 1)}–{fmtCount(Math.min((page + 1) * pageSize, total.value))} of {fmtCount(total.value)}</span>
          <span style="margin-left:auto;display:flex;gap:var(--px-4);align-items:center">
            <button class="eg-btn" disabled={page === 0} onclick={() => go(0)} aria-label="First page">«</button>
            <button class="eg-btn" disabled={page === 0} onclick={() => go(page - 1)} aria-label="Previous page">‹</button>
            <span style="padding:0 var(--px-6)">Page {page + 1} of {pageCount}</span>
            <button class="eg-btn" disabled={page >= pageCount - 1} onclick={() => go(page + 1)} aria-label="Next page">›</button>
            <button class="eg-btn" disabled={page >= pageCount - 1} onclick={() => go(pageCount - 1)} aria-label="Last page">»</button>
          </span>
          {#if total.value > MAX_WINDOW}
            <span class="es-help" style="width:100%">Only the first {fmtCount(MAX_WINDOW)} hits can be paged (index.max_result_window) — narrow the search to reach the rest.</span>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>

{#if inspect}
  <div class="es-flyout-back" role="presentation">
    <div class="es-flyout" role="dialog" aria-modal="true" aria-label="Inspect" tabindex="-1" use:focusOnMount onkeydown={(e) => e.key === 'Escape' && (inspect = null)}>
      <div class="es-modal-h" style="border-bottom:var(--px-1) solid var(--border)">
        <span class="es-card-title" style="font-size:var(--px-16)">Inspect</span>
        <span class="es-seg" style="margin-left:var(--px-12)">
          <button class:on={inspect === 'request'} onclick={() => (inspect = 'request')}>Request</button>
          <button class:on={inspect === 'response'} onclick={() => (inspect = 'response')}>Response</button>
        </span>
        <button class="eg-btn" style="margin-left:auto" onclick={() => tabs.openEsConsole(connId, true, `POST /${index}/_search\n${JSON.stringify(lastRequest, null, 2)}\n`)}><EsIcon name="console" size={13} /> Open in Console</button>
        <button class="eg-btn" aria-label="Close" onclick={() => (inspect = null)}><EsIcon name="close" size={13} /></button>
      </div>
      <div style="flex:1 1 auto;min-height:0;padding:var(--px-12) var(--px-16);display:flex;flex-direction:column">
        {#if inspect === 'request'}
          <span class="es-label mono">POST /{index}/_search</span>
          <CodeView value={JSON.stringify(lastRequest, null, 2)} language={DS_JSON} readOnly height="100%" ariaLabel="Inspect request" />
        {:else}
          <CodeView value={JSON.stringify(result, null, 2)} language={DS_JSON} readOnly height="100%" ariaLabel="Inspect response" />
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if flyout}
  <EsDocFlyout
    {connId}
    {index}
    hit={flyout.hit}
    fieldTypes={typeMap}
    {columns}
    onClose={() => (flyout = null)}
    onChanged={docsChanged}
    onFilter={(f, v, neg) => {
      flyout = null
      addPill(f, v, neg)
    }}
    onToggleColumn={toggleColumn}
  />
{/if}

<style>
  .esd {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }
  .esd-bar {
    display: flex;
    gap: var(--px-8);
    align-items: center;
    padding: var(--px-10) var(--px-16) var(--px-6);
    background: var(--surface);
    flex-wrap: wrap;
  }
  .esd-q {
    flex: 1 1 var(--px-300);
    display: flex;
    align-items: center;
    gap: var(--px-8);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    padding: var(--px-6) var(--px-10);
    color: var(--muted);
    min-width: 0;
  }
  .esd-q:focus-within {
    border-color: var(--es-accent);
    box-shadow: 0 0 0 var(--px-3) color-mix(in srgb, var(--es-accent) 18%, transparent);
  }
  .esd-q.invalid {
    border-color: var(--es-red);
  }
  .esd-q input {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    font-family: var(--font-mono);
    font-size: var(--px-13);
    color: var(--text);
  }
  .esd-time {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    padding: var(--px-4) var(--px-8);
    color: var(--es-accent);
    font-size: var(--px-12_5);
  }
  .esd-time select {
    border: none;
    background: transparent;
    font: inherit;
    color: var(--text);
    outline: none;
    cursor: pointer;
  }
  .esd-update {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  .esd-qerr {
    padding: 0 var(--px-16) var(--px-6);
    background: var(--surface);
    color: var(--es-red);
    font-size: var(--px-12);
  }
  .esd-filters {
    display: flex;
    gap: var(--px-6);
    flex-wrap: wrap;
    align-items: center;
    padding: var(--px-4) var(--px-16) var(--px-10);
    background: var(--surface);
    border-bottom: var(--px-1) solid var(--border);
  }
  .esd-pill-label {
    border: none;
    background: transparent;
    font: inherit;
    color: inherit;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0;
  }
  .esd-addbtn {
    border: none;
    background: transparent;
    color: var(--es-accent);
    font: inherit;
    font-size: var(--px-12);
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
  }
  .esd-addf {
    display: inline-flex;
    gap: var(--px-6);
    align-items: center;
    flex-wrap: wrap;
  }
  .esd-split {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .esd-side {
    flex: none;
    width: var(--px-252);
    border-right: var(--px-1) solid var(--border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .esd-fields {
    flex: 1 1 auto;
    overflow: auto;
    padding: 0 var(--px-6) var(--px-12);
  }
  .esd-fh {
    font-size: var(--px-11_5);
    font-weight: 600;
    color: var(--text2);
    padding: var(--px-8) var(--px-6) var(--px-4);
    display: flex;
    justify-content: space-between;
  }
  .esd-fh span {
    color: var(--muted);
    font-weight: 500;
  }
  .esd-field {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    padding: var(--px-3) var(--px-6);
    border-radius: var(--px-6);
    font-size: var(--px-12_5);
    min-width: 0;
  }
  .esd-field:hover,
  .esd-field.open {
    background: var(--hover);
  }
  .esd-field.sel {
    background: color-mix(in srgb, var(--es-accent) 10%, transparent);
  }
  .esd-fname {
    flex: 1 1 auto;
    text-align: left;
    border: none;
    background: transparent;
    font: inherit;
    color: var(--text);
    cursor: pointer;
    padding: 0;
  }
  .esd-fbtn {
    border: none;
    background: transparent;
    color: var(--text2);
    cursor: pointer;
    border-radius: var(--px-5);
    padding: var(--px-2) var(--px-4);
    display: inline-flex;
    align-items: center;
    font: inherit;
    font-size: var(--px-12);
  }
  .esd-fbtn:hover {
    background: color-mix(in srgb, var(--es-accent) 15%, transparent);
    color: var(--es-accent);
  }
  .esd-field .esd-fbtn {
    opacity: 0;
  }
  .esd-field:hover .esd-fbtn,
  .esd-field.sel .esd-fbtn,
  .esd-field.open .esd-fbtn {
    opacity: 1;
  }
  .esd-top {
    margin: var(--px-2) var(--px-4) var(--px-8) var(--px-26);
    padding: var(--px-8) var(--px-10);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
  }
  .esd-top-h {
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--text2);
    margin-bottom: var(--px-6);
  }
  .esd-tv + .esd-tv {
    margin-top: var(--px-6);
  }
  .esd-tv-row {
    display: flex;
    align-items: center;
    gap: var(--px-4);
    font-size: var(--px-12);
  }
  .esd-tv-pct {
    color: var(--text2);
    font-variant-numeric: tabular-nums;
    font-size: var(--px-11_5);
  }
  .esd-tv-bar {
    height: var(--px-4);
    border-radius: var(--px-2);
    background: var(--border);
    margin-top: var(--px-3);
    overflow: hidden;
  }
  .esd-tv-bar span {
    display: block;
    height: 100%;
    background: var(--es-bar);
  }
  .esd-main {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
  .esd-summary {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-10) var(--px-16);
    border-bottom: var(--px-1) solid var(--border);
    flex-wrap: wrap;
  }
  .esd-hits {
    font-size: var(--px-14);
    color: var(--text);
  }
  .esd-hist {
    padding: var(--px-10) var(--px-16) var(--px-6);
    border-bottom: var(--px-1) solid var(--border);
  }
  .esd-hist-svg {
    width: 100%;
    height: var(--px-80);
    display: block;
  }
  .esd-bar {
    fill: var(--es-bar);
    cursor: zoom-in;
  }
  .esd-bar:hover {
    fill: var(--es-bar-hover);
  }
  .esd-hist-axis {
    display: flex;
    justify-content: space-between;
    font-size: var(--px-11);
    color: var(--muted);
    margin-top: var(--px-4);
  }
  .esd-table-wrap {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }
  .esd-table td {
    font-size: var(--px-12);
  }
  .esd-sortable {
    cursor: pointer;
  }
  .esd-sortable:hover {
    color: var(--es-accent);
  }
  .esd-row {
    cursor: default;
  }
  .esd-cell {
    max-width: var(--px-300);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .esd-doc {
    line-height: 1.6;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--px-12);
  }
  .esd-kv {
    margin-right: var(--px-10);
  }
  .esd-k {
    background: color-mix(in srgb, var(--es-accent) 10%, transparent);
    color: var(--text);
    font-weight: 600;
    border-radius: var(--px-3);
    padding: 0 var(--px-4);
  }
  .esd-v {
    color: var(--text2);
    word-break: break-word;
  }
  .esd-pager {
    display: flex;
    align-items: center;
    gap: var(--px-14);
    padding: var(--px-8) var(--px-16);
    border-top: var(--px-1) solid var(--border);
    font-size: var(--px-12_5);
    flex-wrap: wrap;
  }
</style>
