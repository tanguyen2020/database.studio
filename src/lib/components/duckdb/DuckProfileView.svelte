<script lang="ts">
  // Data profile of a DuckDB table, view or query: SUMMARIZE gives every column's
  // count, nulls, distinct values, min / max, mean, deviation and quartiles; each
  // number / date column also gets an equal-width histogram and each text column
  // its most frequent values. A second view shows the raw SUMMARIZE grid.
  import { onMount, untrack } from 'svelte'
  import '$lib/elastic/es.css'
  import '$lib/duckdb/duck.css'
  import * as ipc from '$lib/ipc'
  import Icon from '$lib/components/Icon.svelte'
  import ResultGrid from '$lib/components/results/ResultGrid.svelte'
  import type { QueryResultSet, TabState } from '$lib/types'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { duckExport } from '$lib/stores/duckdb.svelte'
  import {
    columnFamily,
    histogramStatement,
    num,
    profileFrom,
    summarizeStatement,
    topValuesStatement,
    type ProfileSource,
  } from '$lib/duckdb/sql'
  import { duckRows, errorText } from '$lib/duckdb/run'

  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  const source = $derived((tab.state as { source: ProfileSource & { label?: string } }).source)

  interface Summary {
    column_name: string
    column_type: string
    min: string | null
    max: string | null
    approx_unique: unknown
    avg: string | null
    std: string | null
    q25: string | null
    q50: string | null
    q75: string | null
    count: unknown
    null_percentage: unknown
  }
  let summary = $state<Summary[] | null>(null)
  let raw = $state<QueryResultSet | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)
  let ms = $state<number | null>(null)
  let view = $state<'cards' | 'table'>('cards')
  let filter = $state('')
  let hist = $state<Record<string, { buckets: number[]; lo: number; hi: number } | 'loading' | 'error'>>({})
  let top = $state<Record<string, { value: unknown; n: number }[] | 'loading' | 'error'>>({})
  let gen = 0

  const AUTO_DETAIL = 40

  async function load() {
    const mine = ++gen
    loading = true
    error = null
    hist = {}
    top = {}
    const t0 = performance.now()
    try {
      const r = await ipc.execStatement(connId, summarizeStatement(source))
      if (mine !== gen) return
      if (!r.ok) throw new Error(r.error?.message ?? 'SUMMARIZE failed')
      raw = r.result ?? null
      summary = (r.result?.rows ?? []) as unknown as Summary[]
      ms = Math.round(performance.now() - t0)
      void loadDetails(mine)
    } catch (e) {
      if (mine === gen) error = errorText(e)
    } finally {
      if (mine === gen) loading = false
    }
  }

  async function loadDetails(mine: number) {
    // one at a time: the connection runs one statement at a time anyway, and the
    // first cards fill in first
    for (const c of (summary ?? []).slice(0, AUTO_DETAIL)) {
      if (mine !== gen) return
      await loadDetail(c, mine)
    }
  }

  async function loadDetail(c: Summary, mine = gen) {
    const fam = columnFamily(c.column_type)
    const name = c.column_name
    if (fam === 'number' || fam === 'temporal') {
      if ((num(c.count) ?? 0) === 0 || c.min === null) return
      hist = { ...hist, [name]: 'loading' }
      try {
        const rows = await duckRows<{ bucket: unknown; lo: unknown; hi: unknown; n: unknown }>(connId, histogramStatement(source, name, fam))
        if (mine !== gen) return
        const buckets = new Array(20).fill(0)
        let lo = 0
        let hi = 0
        for (const r of rows) {
          const b = num(r.bucket) ?? 0
          buckets[Math.max(0, Math.min(19, b))] += num(r.n) ?? 0
          lo = num(r.lo) ?? lo
          hi = num(r.hi) ?? hi
        }
        hist = { ...hist, [name]: { buckets, lo, hi } }
      } catch {
        if (mine === gen) hist = { ...hist, [name]: 'error' }
      }
    } else if (fam === 'text' || fam === 'boolean') {
      top = { ...top, [name]: 'loading' }
      try {
        const rows = await duckRows<{ value: unknown; n: unknown }>(connId, topValuesStatement(source, name, 6))
        if (mine !== gen) return
        top = { ...top, [name]: rows.map((r) => ({ value: r.value, n: num(r.n) ?? 0 })) }
      } catch {
        if (mine === gen) top = { ...top, [name]: 'error' }
      }
    }
  }

  onMount(() => untrack(() => void load()))

  const rowCount = $derived(summary?.length ? num(summary[0].count) : null)
  const shown = $derived((summary ?? []).filter((c) => !filter.trim() || c.column_name.toLowerCase().includes(filter.trim().toLowerCase())))
  const title = $derived(source.kind === 'table' ? source.table : (source.label ?? 'Query'))
  const subtitle = $derived(source.kind === 'table' ? `${source.database ? `${source.database}.` : ''}${source.schema}` : 'query result')

  function nullPct(c: Summary): number {
    return Math.max(0, Math.min(100, num(c.null_percentage) ?? 0))
  }
  function fmtPct(p: number): string {
    if (p > 0 && p < 1) return p.toFixed(2)
    return Number.isInteger(p) ? String(p) : p.toFixed(1)
  }
  function distinct(c: Summary): number | null {
    const u = num(c.approx_unique)
    const n = num(c.count)
    if (u === null) return null
    return n !== null ? Math.min(u, n) : u
  }
  function fmtNum(v: string | null): string {
    if (v === null || v === undefined) return '—'
    const n = Number(v)
    if (!Number.isFinite(n) || /[-:]/.test(String(v).slice(1))) return String(v)
    if (Number.isInteger(n)) return n.toLocaleString()
    return Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(+n.toPrecision(5))
  }
  function axisLabel(v: number, fam: string): string {
    if (fam === 'temporal') {
      const d = new Date(v * 1000)
      return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10)
    }
    return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(+v.toPrecision(4))
  }
  function box(c: Summary): { a: number; m: number; b: number } | null {
    const lo = Number(c.min)
    const hi = Number(c.max)
    const q1 = Number(c.q25)
    const q2 = Number(c.q50)
    const q3 = Number(c.q75)
    if (![lo, hi, q1, q2, q3].every(Number.isFinite) || hi <= lo) return null
    const p = (x: number) => ((x - lo) / (hi - lo)) * 100
    return { a: p(q1), m: p(q2), b: p(q3) }
  }

  async function openData() {
    if (source.kind !== 'table') return
    try {
      const cid = source.database ? await ipc.attachDatabase(connId, source.database) : connId
      tabs.openTableViewer(cid, source.schema, source.table)
    } catch (e) {
      toasts.error(errorText(e))
    }
  }
  function newQuery() {
    tabs.openSqlTab({ connectionId: connId, title: `${title} · query`, query: `SELECT * FROM ${profileFrom(source)} LIMIT 100;` })
  }
  function exportIt() {
    duckExport.show(connId, source.kind === 'table' ? source : { kind: 'query', sql: source.sql })
  }
</script>

<div class="es-page dk-page" data-testid="duckdb-profile">
  <header class="es-header">
    <span class="es-header-icon"><Icon name="chart" size={20} /></span>
    <div style="min-width:0">
      <div class="es-title">{title}</div>
      <div class="es-sub">
        Data profile · {subtitle}
        {#if summary}· {rowCount?.toLocaleString() ?? '—'} rows · {summary.length} columns{ms !== null ? ` · ${ms} ms` : ''}{/if}
      </div>
    </div>
    <div class="es-header-actions">
      {#if source.kind === 'table'}<button class="eg-btn" onclick={openData}><Icon name="table" size={13} /> Open data</button>{/if}
      <button class="eg-btn" onclick={newQuery}><Icon name="query" size={13} /> New query</button>
      <button class="eg-btn" onclick={exportIt}><Icon name="download" size={13} /> Export…</button>
      <button class="eg-btn" onclick={load} aria-busy={loading}>
        <span class:es-spin={loading} style="display:inline-flex"><Icon name="refresh" size={13} /></span>
        {loading ? 'Profiling…' : 'Refresh'}
      </button>
    </div>
  </header>
  <div class="es-tabs" style="align-items:center;gap:var(--px-10);padding-top:var(--px-8);padding-bottom:var(--px-8);border-bottom:var(--px-1) solid var(--border)">
    <input class="es-input" style="width:var(--px-252)" placeholder="Filter columns…" bind:value={filter} aria-label="Filter columns" />
    <div class="es-seg" role="group" aria-label="Profile view">
      <button class:on={view === 'cards'} onclick={() => (view = 'cards')}>Columns</button>
      <button class:on={view === 'table'} onclick={() => (view = 'table')}>Summary table</button>
    </div>
    {#if summary}<span class="es-help" style="margin:0 0 0 auto">{shown.length} of {summary.length} columns</span>{/if}
  </div>
  <div class="es-body" style={view === 'table' ? 'display:flex;flex-direction:column;padding:0' : ''}>
    {#if error}
      <div class="es-callout danger" role="alert"><Icon name="warning" size={14} /><div style="white-space:pre-wrap;flex:1">{error}</div><button class="eg-btn" onclick={load}>Retry</button></div>
    {:else if !summary}
      <div class="es-empty"><span class="es-spin"><Icon name="refresh" size={16} /></span><div style="margin-top:var(--px-8)">Profiling…</div></div>
    {:else if view === 'table'}
      {#if raw}<ResultGrid data={raw} system="duckdb" />{/if}
    {:else}
      <div class="dk-cols">
        {#each shown as c (c.column_name)}
          {@const fam = columnFamily(c.column_type)}
          {@const h = hist[c.column_name]}
          {@const tv = top[c.column_name]}
          {@const bx = fam === 'number' ? box(c) : null}
          {@const np = nullPct(c)}
          <article class="dk-col" data-column={c.column_name}>
            <div class="dk-col-h">
              <span class="dk-col-name" title={c.column_name}>{c.column_name}</span>
              <span class="dk-type {fam}" style="margin-left:auto" title={c.column_type}>{c.column_type.length > 22 ? `${c.column_type.slice(0, 20)}…` : c.column_type}</span>
            </div>
            <dl class="dk-mini" style="margin:0">
              <div><dt>Distinct</dt><dd>{distinct(c)?.toLocaleString() ?? '—'}</dd></div>
              <div>
                <dt>Nulls</dt>
                <dd style={np > 0 ? 'color:var(--dk-red)' : ''}>{fmtPct(np)}%</dd>
              </div>
              <div><dt>Rows</dt><dd>{num(c.count)?.toLocaleString() ?? '—'}</dd></div>
            </dl>
            <div class="dk-meter red" title="{np.toFixed(2)}% null" aria-label="Null share"><span style="width:{np}%"></span></div>
            {#if fam === 'number' || fam === 'temporal'}
              {#if h && typeof h === 'object'}
                {@const max = Math.max(1, ...h.buckets)}
                <div class="dk-hist" aria-label="Distribution">
                  {#each h.buckets as b, i (i)}<span style="height:{b ? Math.max(3, (b / max) * 100) : 0}%" title="{b.toLocaleString()} rows"></span>{/each}
                </div>
                <div class="dk-axis"><span>{axisLabel(h.lo, fam)}</span><span>{axisLabel(h.hi, fam)}</span></div>
              {:else if h === 'loading'}
                <div class="dk-hist" style="opacity:.35"><span style="height:30%"></span><span style="height:60%"></span><span style="height:45%"></span></div>
              {/if}
              <dl class="dk-mini" style="margin:0">
                <div><dt>Min</dt><dd title={c.min ?? ''}>{fmtNum(c.min)}</dd></div>
                <div><dt>{fam === 'number' ? 'Mean' : 'Median'}</dt><dd title={(fam === 'number' ? c.avg : c.q50) ?? ''}>{fmtNum(fam === 'number' ? c.avg : c.q50)}</dd></div>
                <div><dt>Max</dt><dd title={c.max ?? ''}>{fmtNum(c.max)}</dd></div>
              </dl>
              {#if bx}
                <div class="dk-box" title="25% {c.q25} · median {c.q50} · 75% {c.q75}" aria-label="Quartiles">
                  <span class="line"></span><span class="iqr" style="left:{bx.a}%;width:{Math.max(1, bx.b - bx.a)}%"></span><span class="med" style="left:{bx.m}%"></span>
                </div>
                <div class="dk-axis"><span>Q1 {fmtNum(c.q25)}</span><span>median {fmtNum(c.q50)}</span><span>Q3 {fmtNum(c.q75)}</span></div>
                {#if c.std !== null}<div class="es-help" style="margin:0">std. deviation {fmtNum(c.std)}</div>{/if}
              {/if}
            {:else}
              {#if Array.isArray(tv) && tv.length}
                {@const max = Math.max(1, ...tv.map((t) => t.n))}
                <div class="dk-top" aria-label="Most frequent values">
                  {#each tv as t, i (i)}
                    <div class="dk-top-row">
                      <span class="es-ellipsis" title={t.value === null ? 'NULL' : String(t.value)} style={t.value === null ? 'color:var(--muted);font-style:italic' : ''}>{t.value === null ? 'NULL' : String(t.value) || '(empty)'}</span>
                      <div class="dk-meter blue"><span style="width:{(t.n / max) * 100}%"></span></div>
                      <span style="text-align:right;font-variant-numeric:tabular-nums">{t.n.toLocaleString()}</span>
                    </div>
                  {/each}
                </div>
              {:else if tv === 'loading'}
                <div class="es-help" style="margin:0">Counting values…</div>
              {:else if !tv && fam !== 'nested' && fam !== 'other'}
                <button class="eg-btn" style="align-self:flex-start" onclick={() => loadDetail(c)}>Show top values</button>
              {/if}
              <dl class="dk-mini" style="margin:0">
                <div style="grid-column:span 2"><dt>Min</dt><dd title={c.min ?? ''}>{c.min ?? '—'}</dd></div>
                <div><dt>Max</dt><dd title={c.max ?? ''}>{c.max ?? '—'}</dd></div>
              </dl>
            {/if}
          </article>
        {:else}
          <div class="es-empty">No column matches “{filter}”.</div>
        {/each}
      </div>
    {/if}
  </div>
</div>
