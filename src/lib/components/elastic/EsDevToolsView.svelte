<script lang="ts">
  // Kibana Dev Tools (besides Console): Search Profiler, Grok Debugger, Painless Lab
  // and the Analyzer — each a small form over one REST endpoint, with the result
  // rendered for reading (timing tree, extracted fields, script result, tokens).
  import '$lib/elastic/es.css'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from './EsIcon.svelte'
  import EsAppIcon from './EsAppIcon.svelte'
  import { es, seg } from '$lib/elastic/api'
  import { flattenProfile, type ProfileRow } from '$lib/elastic/devtools'
  import { onMount, untrack } from 'svelte'

  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  type Tool = 'profiler' | 'grok' | 'painless' | 'analyzer'
  const tool = $derived(((tab.state as { tool?: Tool }).tool ?? 'profiler') as Tool)
  function setTool(t: Tool) {
    ;(tab.state as Record<string, unknown>).tool = t
    error = null
  }

  let indices = $state<string[]>([])
  let busy = $state(false)
  let error = $state<string | null>(null)
  onMount(() => {
    void ipc
      .esIndices(connId)
      .then((ix) => {
        indices = ix.filter((i) => !i.hidden && i.status === 'open').map((i) => i.name)
        untrack(() => {
          if (!profIndex) profIndex = indices[0] ?? ''
          if (!anIndex) anIndex = ''
        })
      })
      .catch(() => {})
  })

  async function run(fn: () => Promise<void>) {
    busy = true
    error = null
    try {
      await fn()
    } catch (e) {
      error = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  // ---- Search Profiler ---------------------------------------------------------
  let profIndex = $state('')
  let profQuery = $state('{\n  "query": {\n    "match_all": {}\n  }\n}')
  let profRows = $state<ProfileRow[] | null>(null)
  let profTook = $state<number | null>(null)
  function profile() {
    return run(async () => {
      const body = JSON.parse(profQuery)
      const r = await es<{ took: number; profile?: unknown }>(connId, 'POST', `/${seg(profIndex || '_all')}/_search`, { ...body, profile: true, size: 0 })
      profTook = r.took
      profRows = flattenProfile(r.profile)
    })
  }
  const maxNanos = $derived(Math.max(1, ...(profRows ?? []).map((r) => r.nanos)))

  // ---- Grok Debugger ---------------------------------------------------------------
  let grokSample = $state('55.3.244.1 GET /index.html 15824 0.043')
  let grokPattern = $state('%{IP:client} %{WORD:method} %{URIPATHPARAM:request} %{NUMBER:bytes} %{NUMBER:duration}')
  let grokCustom = $state('')
  let grokOut = $state<string | null>(null)
  function grok() {
    return run(async () => {
      const definitions = Object.fromEntries(
        grokCustom
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf(' ')
            return [l.slice(0, i), l.slice(i + 1).trim()]
          }),
      )
      const r = await es<{ docs: { doc?: { _source: Record<string, unknown> }; error?: { reason?: string } }[] }>(connId, 'POST', '/_ingest/pipeline/_simulate', {
        pipeline: { processors: [{ grok: { field: 'message', patterns: [grokPattern], ...(Object.keys(definitions).length ? { pattern_definitions: definitions } : {}) } }] },
        docs: [{ _source: { message: grokSample } }],
      })
      const d = r.docs[0]
      if (d.error) throw new Error(d.error.reason ?? 'Provided Grok patterns do not match data in the input')
      const { message: _m, ...rest } = d.doc?._source ?? {}
      void _m
      grokOut = JSON.stringify(rest, null, 2)
    })
  }

  // ---- Painless Lab ----------------------------------------------------------------
  let plScript = $state('// params.x and params.y come from Parameters\nreturn params.x * params.y + 1;')
  let plParams = $state('{\n  "x": 6,\n  "y": 7\n}')
  let plContext = $state<'painless_test' | 'filter' | 'score'>('painless_test')
  let plIndex = $state('')
  let plDoc = $state('{\n  "amount": 42\n}')
  let plOut = $state<string | null>(null)
  function painless() {
    return run(async () => {
      const body: Record<string, unknown> = { script: { source: plScript, params: JSON.parse(plParams || '{}') } }
      if (plContext !== 'painless_test') {
        body.context = plContext
        body.context_setup = { index: plIndex || indices[0], document: JSON.parse(plDoc || '{}') }
      }
      const r = await es<{ result: unknown }>(connId, 'POST', '/_scripts/painless/_execute', body)
      plOut = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2)
    })
  }

  // ---- Analyzer ----------------------------------------------------------------------
  let anIndex = $state('')
  let anAnalyzer = $state('standard')
  let anText = $state('The QUICK brown-foxes jumped over 2 lazy dogs!')
  let anTokens = $state<{ token: string; start_offset: number; end_offset: number; type: string; position: number }[] | null>(null)
  function analyze() {
    return run(async () => {
      const r = await es<{ tokens: { token: string; start_offset: number; end_offset: number; type: string; position: number }[] }>(
        connId,
        'POST',
        anIndex ? `/${seg(anIndex)}/_analyze` : '/_analyze',
        { analyzer: anAnalyzer, text: anText },
      )
      anTokens = r.tokens
    })
  }

  const TOOLS: { key: Tool; label: string; app: 'searchProfiler' | 'devtools' | 'console' }[] = [
    { key: 'profiler', label: 'Search Profiler', app: 'searchProfiler' },
    { key: 'grok', label: 'Grok Debugger', app: 'devtools' },
    { key: 'painless', label: 'Painless Lab', app: 'devtools' },
    { key: 'analyzer', label: 'Analyzer', app: 'devtools' },
  ]
</script>

<div class="es-page" data-testid="es-devtools">
  <div class="es-header">
    <span class="es-header-icon"><EsAppIcon name={tool === 'profiler' ? 'searchProfiler' : 'devtools'} size={24} /></span>
    <div style="min-width:0">
      <div class="es-title">Dev Tools</div>
      <div class="es-sub">
        {#if tool === 'profiler'}How long each part of a search takes, per shard — find the slow clause.
        {:else if tool === 'grok'}Build and test grok patterns against sample log lines before putting them in a pipeline.
        {:else if tool === 'painless'}Write and run Painless scripts with parameters and a sample document.
        {:else}See how an analyzer splits text into the terms that get indexed and searched.{/if}
      </div>
    </div>
  </div>
  <div class="es-tabs" role="tablist" aria-label="Dev tools">
    {#each TOOLS as t (t.key)}
      <button class="es-tab" class:on={tool === t.key} role="tab" aria-selected={tool === t.key} onclick={() => setTool(t.key)}>{t.label}</button>
    {/each}
  </div>
  <div class="es-body">
    {#if error}<div class="es-callout danger" role="alert" style="margin-bottom:var(--px-12)">{error}</div>{/if}

    {#if tool === 'profiler'}
      <div class="es-card">
        <div class="es-card-b" style="display:flex;flex-direction:column;gap:var(--px-10)">
          <div class="es-toolbar">
            <label class="es-label" style="margin:0" for="es-prof-index">Index</label>
            <input id="es-prof-index" class="es-input mono" style="width:var(--px-240)" bind:value={profIndex} list="es-dt-indices" placeholder="_all" />
            <button class="eg-btn primary" onclick={profile} disabled={busy} aria-busy={busy}><EsIcon name="play" size={13} /> Profile</button>
            {#if profTook != null}<span class="es-badge">took {profTook} ms</span>{/if}
          </div>
          <CodeView value={profQuery} language={DS_JSON} height="auto" minHeight={120} maxHeight={260} onChange={(t) => (profQuery = t)} onSubmit={profile} ariaLabel="Profiled query" />
        </div>
      </div>
      {#if profRows}
        <div class="es-card" data-testid="es-profile">
          <div class="es-card-h"><span class="es-card-title">Query profile</span><span class="es-help" style="margin:0">time per component, all shards</span></div>
          {#if !profRows.length}
            <div class="es-empty">No profile returned.</div>
          {:else}
            <table class="es-table">
              <thead><tr><th>Shard</th><th>Component</th><th>Description</th><th style="width:var(--px-240)">Time</th></tr></thead>
              <tbody>
                {#each profRows as r, i (i)}
                  <tr>
                    <td class="mono" style="font-size:var(--px-11);color:var(--muted)">{r.shard}</td>
                    <td style="padding-left:calc(var(--px-12) + {r.depth} * var(--px-16));font-weight:600">{r.type}</td>
                    <td class="mono es-ellipsis" style="max-width:var(--px-340);font-size:var(--px-11_5)" title={r.description}>{r.description}</td>
                    <td>
                      <div style="display:flex;align-items:center;gap:var(--px-8)">
                        <div style="flex:1 1 auto;height:var(--px-6);background:var(--border);border-radius:var(--px-3);overflow:hidden"><div style="height:100%;width:{(r.nanos / maxNanos) * 100}%;background:var(--es-bar)"></div></div>
                        <span class="mono" style="font-size:var(--px-11_5)">{(r.nanos / 1e6).toFixed(3)} ms</span>
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {/if}
    {:else if tool === 'grok'}
      <div class="es-card">
        <div class="es-card-b" style="display:flex;flex-direction:column;gap:var(--px-12)">
          <div><label class="es-label" for="es-grok-sample">Sample data</label><textarea id="es-grok-sample" class="es-input mono" style="width:100%;min-height:var(--px-60)" bind:value={grokSample}></textarea></div>
          <div><label class="es-label" for="es-grok-pattern">Grok pattern</label><textarea id="es-grok-pattern" class="es-input mono" style="width:100%;min-height:var(--px-60)" bind:value={grokPattern}></textarea></div>
          <div><label class="es-label" for="es-grok-custom">Custom patterns <span style="font-weight:400;color:var(--muted)">(optional — one per line: NAME regex)</span></label><textarea id="es-grok-custom" class="es-input mono" style="width:100%;min-height:var(--px-48)" bind:value={grokCustom} placeholder="POSTFIX_QUEUEID [0-9A-F]{'{10,11}'}"></textarea></div>
          <div><button class="eg-btn primary" onclick={grok} disabled={busy} aria-busy={busy}><EsIcon name="play" size={13} /> Simulate</button></div>
          {#if grokOut}
            <div><span class="es-label">Structured data</span><CodeView value={grokOut} language={DS_JSON} readOnly height="auto" minHeight={80} maxHeight={360} ariaLabel="Grok output" /></div>
          {/if}
        </div>
      </div>
    {:else if tool === 'painless'}
      <div class="es-card">
        <div class="es-card-b" style="display:grid;grid-template-columns:3fr 2fr;gap:var(--px-14)">
          <div style="min-width:0">
            <span class="es-label">Script</span>
            <CodeView value={plScript} language="javascript" height="auto" minHeight={180} maxHeight={360} onChange={(t) => (plScript = t)} onSubmit={painless} ariaLabel="Painless script" />
            <div class="es-toolbar" style="margin-top:var(--px-8)">
              <button class="eg-btn primary" onclick={painless} disabled={busy} aria-busy={busy}><EsIcon name="play" size={13} /> Run</button>
              <span class="es-help" style="margin:0">Ctrl+Enter</span>
            </div>
          </div>
          <div style="min-width:0;display:flex;flex-direction:column;gap:var(--px-10)">
            <div>
              <label class="es-label" for="es-pl-ctx">Context</label>
              <select id="es-pl-ctx" class="es-input" style="width:100%" bind:value={plContext}>
                <option value="painless_test">Basic (painless_test)</option>
                <option value="filter">Filter — script query on a document</option>
                <option value="score">Score — script_score on a document</option>
              </select>
            </div>
            <div><span class="es-label">Parameters</span><CodeView value={plParams} language={DS_JSON} height="auto" minHeight={80} maxHeight={200} onChange={(t) => (plParams = t)} ariaLabel="Painless parameters" /></div>
            {#if plContext !== 'painless_test'}
              <div><label class="es-label" for="es-pl-index">Index</label><input id="es-pl-index" class="es-input mono" style="width:100%" bind:value={plIndex} list="es-dt-indices" placeholder={indices[0] ?? ''} /></div>
              <div><span class="es-label">Sample document</span><CodeView value={plDoc} language={DS_JSON} height="auto" minHeight={80} maxHeight={200} onChange={(t) => (plDoc = t)} ariaLabel="Painless document" /></div>
            {/if}
          </div>
        </div>
      </div>
      {#if plOut != null}
        <div class="es-card" data-testid="es-painless-result">
          <div class="es-card-h"><span class="es-card-title">Output</span></div>
          <div class="es-card-b mono selectable" style="white-space:pre-wrap">{plOut}</div>
        </div>
      {/if}
    {:else}
      <div class="es-card">
        <div class="es-card-b" style="display:flex;flex-direction:column;gap:var(--px-12)">
          <div class="es-toolbar">
            <label class="es-label" style="margin:0" for="es-an-analyzer">Analyzer</label>
            <input id="es-an-analyzer" class="es-input mono" style="width:var(--px-180)" bind:value={anAnalyzer} list="es-analyzers" />
            <label class="es-label" style="margin:0" for="es-an-index">Index <span style="font-weight:400;color:var(--muted)">(for custom analyzers)</span></label>
            <input id="es-an-index" class="es-input mono" style="width:var(--px-200)" bind:value={anIndex} list="es-dt-indices" placeholder="(none)" />
          </div>
          <div><label class="es-label" for="es-an-text">Text</label><textarea id="es-an-text" class="es-input" style="width:100%;min-height:var(--px-60)" bind:value={anText}></textarea></div>
          <div><button class="eg-btn primary" onclick={analyze} disabled={busy} aria-busy={busy}><EsIcon name="play" size={13} /> Analyze</button></div>
        </div>
      </div>
      {#if anTokens}
        <div class="es-card" data-testid="es-tokens">
          <div class="es-card-h"><span class="es-card-title">Tokens</span><span class="es-badge">{anTokens.length}</span></div>
          <div class="es-card-b" style="display:flex;flex-wrap:wrap;gap:var(--px-6)">
            {#each anTokens as t (t.position + t.token)}
              <span class="es-badge accent mono" title="position {t.position} · offsets {t.start_offset}–{t.end_offset} · {t.type}">{t.token}</span>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>

<datalist id="es-dt-indices">{#each indices as i (i)}<option value={i}></option>{/each}</datalist>
<datalist id="es-analyzers">{#each ['standard', 'simple', 'whitespace', 'stop', 'keyword', 'pattern', 'english', 'french', 'german', 'fingerprint'] as a (a)}<option value={a}></option>{/each}</datalist>
