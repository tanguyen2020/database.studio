<script lang="ts">
  // ES|QL / SQL query tab (Kibana Discover's ES|QL mode + SQL): an editor, Run
  // (Ctrl+Enter), results in the app's result grid (sort / copy / export), SQL
  // cursor paging ("Load more") and "Translate to Query DSL".
  import { onMount, untrack } from 'svelte'
  import '$lib/elastic/es.css'
  import * as ipc from '$lib/ipc'
  import type { QueryResultSet, TabState } from '$lib/types'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import ResultGrid from '$lib/components/results/ResultGrid.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from './EsIcon.svelte'
  import EsAppIcon from './EsAppIcon.svelte'
  import { esqlQuery, sqlNext, sqlQuery, sqlTranslate, type TabularResult } from '$lib/elastic/api'
  import { toCsv, withBom } from '$lib/export/rows'
  import { saveText } from '$lib/elastic/save'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'

  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  // the tab object is stable for this component's lifetime
  const st = untrack(() => tab.state as { language?: 'esql' | 'sql'; query?: string })

  let language = $state<'esql' | 'sql'>(st.language ?? 'esql')
  let text = $state(st.query ?? '')
  let indices = $state<string[]>([])
  let running = $state(false)
  let error = $state<string | null>(null)
  let result = $state<TabularResult | null>(null)
  let took = $state<number | null>(null)
  let translated = $state<string | null>(null)
  let editorKey = $state(0)

  const EXAMPLES = $derived.by(() => {
    const ix = indices[0] ?? 'my-index'
    return language === 'esql'
      ? [
          { label: 'First 100 documents', q: `FROM ${ix}\n| LIMIT 100` },
          { label: 'Count by a field', q: `FROM ${ix}\n| STATS count = COUNT(*) BY status\n| SORT count DESC\n| LIMIT 20` },
          { label: 'Filter, keep, sort', q: `FROM ${ix}\n| WHERE amount > 100\n| KEEP @timestamp, customer, amount\n| SORT amount DESC\n| LIMIT 50` },
        ]
      : [
          { label: 'Show indices', q: 'SHOW TABLES' },
          { label: 'Describe an index', q: `DESCRIBE "${ix}"` },
          { label: 'Group and count', q: `SELECT status, COUNT(*) AS n\nFROM "${ix}"\nGROUP BY status\nORDER BY n DESC` },
        ]
  })

  onMount(() => {
    void ipc
      .esIndices(connId)
      .then((ix) => {
        indices = ix.filter((i) => !i.hidden && !i.data_stream && i.status === 'open').map((i) => i.name)
        if (!text.trim()) {
          text = EXAMPLES[0].q
          editorKey++
        }
      })
      .catch(() => {})
  })

  function setLanguage(l: 'esql' | 'sql') {
    if (l === language) return
    language = l
    st.language = l
    result = null
    error = null
    translated = null
    tab.title = l === 'esql' ? 'ES|QL query' : 'SQL query'
    text = EXAMPLES[0].q
    st.query = text
    editorKey++
  }

  async function run() {
    const q = text.trim()
    if (!q || running) return
    running = true
    error = null
    translated = null
    st.query = text
    const started = performance.now()
    try {
      result = language === 'esql' ? await esqlQuery(connId, q) : await sqlQuery(connId, q.replace(/;\s*$/, ''))
      took = Math.round(performance.now() - started)
    } catch (e) {
      error = String((e as Error).message ?? e)
      result = null
    } finally {
      running = false
    }
  }

  async function more() {
    if (!result?.cursor || running) return
    running = true
    try {
      const next = await sqlNext(connId, result.cursor, result.cols)
      result = { cols: result.cols, rows: [...result.rows, ...next.rows], cursor: next.cursor }
    } catch (e) {
      error = String((e as Error).message ?? e)
    } finally {
      running = false
    }
  }

  async function translate() {
    try {
      translated = JSON.stringify(await sqlTranslate(connId, text.trim().replace(/;\s*$/, '')), null, 2)
    } catch (e) {
      error = String((e as Error).message ?? e)
    }
  }

  async function exportCsv() {
    if (!result) return
    const ok = await saveText(`${language}-result.csv`, withBom(toCsv(result.cols.map(([n]) => n), result.rows)), 'csv', 'text/csv')
    if (ok) toasts.success(`Exported ${result.rows.length} rows`, 'elasticsearch')
  }

  const grid = $derived<QueryResultSet | null>(result ? { cols: result.cols, rows: result.rows, total: result.rows.length } : null)
</script>

<div class="es-page" data-testid="es-query">
  <div class="es-header" style="padding-bottom:var(--px-12)">
    <span class="es-header-icon"><EsAppIcon name="sql" size={24} /></span>
    <div style="min-width:0">
      <div class="es-title">{language === 'esql' ? 'ES|QL' : 'SQL'}</div>
      <div class="es-sub">{language === 'esql' ? 'Piped query language — FROM, WHERE, EVAL, STATS … BY, KEEP, SORT, LIMIT.' : 'Elasticsearch SQL over your indices — results stream through a cursor.'}</div>
    </div>
    <div class="es-header-actions">
      <span class="es-seg" title="Query language">
        <button class:on={language === 'esql'} onclick={() => setLanguage('esql')}>ES|QL</button>
        <button class:on={language === 'sql'} onclick={() => setLanguage('sql')}>SQL</button>
      </span>
    </div>
  </div>

  <div class="esq-editor">
    {#key editorKey}
      <CodeView value={text} language="sql" height="auto" minHeight={110} maxHeight={280} onChange={(t) => (text = t)} onSubmit={run} ariaLabel="{language === 'esql' ? 'ES|QL' : 'SQL'} query" />
    {/key}
    <div class="es-toolbar" style="margin-top:var(--px-8)">
      <button class="eg-btn primary" onclick={run} disabled={running || !text.trim()} aria-busy={running}>
        {#if running}<span class="es-spin"><EsIcon name="refresh" size={13} /></span>{:else}<EsIcon name="play" size={13} />{/if}
        {running ? 'Running…' : 'Run query'}
      </button>
      <span class="es-help" style="margin:0">Ctrl+Enter</span>
      {#if language === 'sql'}
        <button class="eg-btn" onclick={translate} disabled={!text.trim()} title="Show the Query DSL this SQL becomes"><EsIcon name="json" size={13} /> Translate to Query DSL</button>
      {/if}
      <select class="es-input" style="margin-left:auto;padding:var(--px-4) var(--px-8)" aria-label="Examples" value="" onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; if (v) { text = v; editorKey++ } ; (e.currentTarget as HTMLSelectElement).value = '' }}>
        <option value="">Examples…</option>
        {#each EXAMPLES as ex (ex.label)}<option value={ex.q}>{ex.label}</option>{/each}
      </select>
    </div>
  </div>

  <div class="esq-result">
    {#if error}
      <div class="es-callout danger" role="alert" style="margin:var(--px-12) var(--px-16)">{error}</div>
    {/if}
    {#if translated}
      <div class="es-card" style="margin:var(--px-12) var(--px-16)">
        <div class="es-card-h">
          <span class="es-card-title">Query DSL</span>
          <button class="eg-btn" style="margin-left:auto" onclick={() => tabs.openEsConsole(connId, true, `POST /_search\n${translated}\n`)}><EsIcon name="console" size={13} /> Open in console</button>
          <button class="eg-btn" onclick={() => (translated = null)}>Close</button>
        </div>
        <div class="es-card-b"><CodeView value={translated} language={DS_JSON} readOnly height="auto" minHeight={100} maxHeight={320} ariaLabel="Translated Query DSL" /></div>
      </div>
    {/if}
    {#if grid}
      <div class="esq-meta" data-testid="es-query-meta">
        <span><b>{grid.rows.length.toLocaleString('en-US')}</b> rows · {grid.cols.length} columns{#if took != null} · {took} ms{/if}</span>
        {#if result?.cursor}<button class="eg-btn" onclick={more} disabled={running}>Load more</button>{/if}
        <button class="eg-btn" style="margin-left:auto" onclick={exportCsv} disabled={!grid.rows.length}><EsIcon name="download" size={13} /> CSV</button>
      </div>
      <div class="esq-grid">
        {#if grid.rows.length}
          <ResultGrid data={grid} system="elasticsearch" />
        {:else}
          <div class="es-empty"><div class="es-empty-title">No rows</div>The query ran and matched nothing.</div>
        {/if}
      </div>
    {:else if !error && !running}
      <div class="es-empty"><div class="es-empty-title">Run a query</div>Pick an example or write your own, then press Run.</div>
    {/if}
  </div>
</div>

<style>
  .esq-editor {
    flex: none;
    padding: var(--px-12) var(--px-16);
    background: var(--surface);
    border-bottom: var(--px-1) solid var(--border);
  }
  .esq-result {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .esq-meta {
    flex: none;
    display: flex;
    gap: var(--px-10);
    align-items: center;
    padding: var(--px-8) var(--px-16);
    font-size: var(--px-12_5);
    color: var(--text2);
    background: var(--surface);
    border-bottom: var(--px-1) solid var(--border);
  }
  .esq-grid {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
</style>
