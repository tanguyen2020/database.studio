<script lang="ts">
  // Query tab — Elasticsearch: ES|QL + SQL (Kibana Discover's ES|QL mode); OpenSearch:
  // PPL + SQL (the SQL / PPL plugins — SPEC-OPENSEARCH.md O3–O5). An editor, Run
  // (Ctrl+Enter), results in the app's result grid (sort / copy / export), SQL cursor
  // paging ("Load more"), "Translate to Query DSL" (Elasticsearch) or "Explain" (OpenSearch).
  import { onMount, untrack } from 'svelte'
  import '$lib/elastic/es.css'
  import * as ipc from '$lib/ipc'
  import type { QueryResultSet, TabState } from '$lib/types'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import ResultGrid from '$lib/components/results/ResultGrid.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from './EsIcon.svelte'
  import EsAppIcon from './EsAppIcon.svelte'
  import { esqlQuery, osSqlExplain, osSqlNext, osSqlQuery, pplExplain, pplQuery, sqlNext, sqlQuery, sqlTranslate, type TabularResult } from '$lib/elastic/api'
  import { LANGUAGE_HELP, LANGUAGE_LABEL, languageFor, queryLanguages, searchProduct, type QueryLanguage } from '$lib/elastic/flavor'
  import { toCsv, withBom } from '$lib/export/rows'
  import { saveText } from '$lib/elastic/save'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'

  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  // the tab object is stable for this component's lifetime
  const st = untrack(() => tab.state as { language?: QueryLanguage; query?: string })
  // Elasticsearch or OpenSearch — fixed for this tab's connection
  const product = untrack(() => searchProduct(tab.connectionId))
  const languages = queryLanguages(product.flavor)

  let language = $state<QueryLanguage>(languageFor(product.flavor, st.language))
  let text = $state(st.query ?? '')
  let indices = $state<string[]>([])
  let running = $state(false)
  let error = $state<string | null>(null)
  let result = $state<TabularResult | null>(null)
  let took = $state<number | null>(null)
  let translated = $state<string | null>(null)
  /** Explain result is an execution plan (OpenSearch), not Query DSL */
  let translatedIsPlan = $state(false)
  let editorKey = $state(0)

  const EXAMPLES = $derived.by(() => {
    const ix = indices[0] ?? 'my-index'
    if (language === 'ppl')
      return [
        { label: 'First 100 documents', q: `source = ${ix}\n| head 100` },
        { label: 'Count by a field', q: `source = ${ix}\n| stats count() as n by status\n| sort - n\n| head 20` },
        { label: 'Filter, pick fields, sort', q: `source = ${ix}\n| where amount > 100\n| fields @timestamp, customer, amount\n| sort - amount\n| head 50` },
        { label: 'Top values of a field', q: `source = ${ix}\n| top 10 status` },
      ]
    if (language === 'sql' && product.os)
      return [
        { label: 'Show indices', q: 'SHOW TABLES LIKE %' },
        { label: 'Describe an index', q: `DESCRIBE TABLES LIKE ${ix}` },
        { label: 'Group and count', q: `SELECT status, COUNT(*) AS n\nFROM \`${ix}\`\nGROUP BY status\nORDER BY n DESC` },
      ]
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

  function setLanguage(l: QueryLanguage) {
    if (l === language) return
    language = l
    st.language = l
    result = null
    error = null
    translated = null
    tab.title = `${LANGUAGE_LABEL[l]} query`
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
      const query = q.replace(/;\s*$/, '')
      result =
        language === 'esql'
          ? await esqlQuery(connId, q)
          : language === 'ppl'
            ? await pplQuery(connId, query)
            : product.os
              ? await osSqlQuery(connId, query)
              : await sqlQuery(connId, query)
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
      const next = product.os ? await osSqlNext(connId, result.cursor, result.cols) : await sqlNext(connId, result.cursor, result.cols)
      result = { cols: result.cols, rows: [...result.rows, ...next.rows], cursor: next.cursor }
    } catch (e) {
      error = String((e as Error).message ?? e)
    } finally {
      running = false
    }
  }

  async function translate() {
    const q = text.trim().replace(/;\s*$/, '')
    try {
      translatedIsPlan = product.os
      const r = !product.os ? await sqlTranslate(connId, q) : language === 'ppl' ? await pplExplain(connId, q) : await osSqlExplain(connId, q)
      translated = JSON.stringify(r, null, 2)
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
      <div class="es-title">{LANGUAGE_LABEL[language]}</div>
      <div class="es-sub">{language === 'sql' ? `${product.name} SQL over your indices — results stream through a cursor.` : LANGUAGE_HELP[language]}</div>
    </div>
    <div class="es-header-actions">
      <span class="es-seg" title="Query language">
        {#each languages as l (l)}
          <button class:on={language === l} aria-pressed={language === l} onclick={() => setLanguage(l)}>{LANGUAGE_LABEL[l]}</button>
        {/each}
      </span>
    </div>
  </div>

  <div class="esq-editor">
    {#key editorKey}
      <CodeView value={text} language="sql" height="auto" minHeight={110} maxHeight={280} onChange={(t) => (text = t)} onSubmit={run} ariaLabel="{LANGUAGE_LABEL[language]} query" />
    {/key}
    <div class="es-toolbar" style="margin-top:var(--px-8)">
      <button class="eg-btn primary" onclick={run} disabled={running || !text.trim()} aria-busy={running}>
        {#if running}<span class="es-spin"><EsIcon name="refresh" size={13} /></span>{:else}<EsIcon name="play" size={13} />{/if}
        {running ? 'Running…' : 'Run query'}
      </button>
      <span class="es-help" style="margin:0">Ctrl+Enter</span>
      {#if product.os}
        <button class="eg-btn" onclick={translate} disabled={!text.trim()} title="Show how {product.name} will run this {LANGUAGE_LABEL[language]} query"><EsIcon name="json" size={13} /> Explain</button>
      {:else if language === 'sql'}
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
          <span class="es-card-title">{translatedIsPlan ? 'Execution plan' : 'Query DSL'}</span>
          {#if !translatedIsPlan}
            <button class="eg-btn" style="margin-left:auto" onclick={() => tabs.openEsConsole(connId, true, `POST /_search\n${translated}\n`)}><EsIcon name="console" size={13} /> Open in console</button>
          {/if}
          <button class="eg-btn" style={translatedIsPlan ? 'margin-left:auto' : ''} onclick={() => (translated = null)}>Close</button>
        </div>
        <div class="es-card-b"><CodeView value={translated} language={DS_JSON} readOnly height="auto" minHeight={100} maxHeight={320} ariaLabel={translatedIsPlan ? 'Execution plan' : 'Translated Query DSL'} /></div>
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
