<script lang="ts" module>
  export type IndexOp = 'reindex' | 'clone' | 'shrink' | 'split' | 'delete-by-query' | 'update-by-query'
</script>

<script lang="ts">
  // Index operations (Kibana Index Management "Manage" menu + the APIs behind it):
  // Reindex, Clone, Shrink, Split, Delete by query, Update by query. Every form
  // previews the exact request; destructive ones count the matching documents
  // first. Resize operations need the source write-blocked — offered as a step.
  import '$lib/elastic/es.css'
  import { untrack } from 'svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsAppIcon from './EsAppIcon.svelte'
  import { es, seg, getSettings } from '$lib/elastic/api'
  import { buildQuery, KqlError } from '$lib/elastic/kql'
  import { indexNameError } from '$lib/elastic/format'
  import { focusOnMount } from '$lib/elastic/actions'

  interface Props {
    connId: string
    index: string
    op: IndexOp
    shards: number | null
    /** replicas of the source — a resized copy does NOT inherit them (defaults to 1) */
    replicas: number | null
    onClose: () => void
    onDone: (msg: string, target?: string) => void
  }
  let { connId, index, op, shards, replicas, onClose, onDone }: Props = $props()

  const TITLE: Record<IndexOp, string> = {
    reindex: 'Reindex',
    clone: 'Clone index',
    shrink: 'Shrink index',
    split: 'Split index',
    'delete-by-query': 'Delete by query',
    'update-by-query': 'Update by query',
  }
  const BLURB: Record<IndexOp, string> = {
    reindex: 'Copy documents (all, or those matching a query) into another index — e.g. to change a mapping. The target is created with dynamic mapping unless it exists.',
    clone: 'Create a copy of this index with the same shards, settings and documents.',
    shrink: 'Create a copy with fewer primary shards (a factor of the current count).',
    split: 'Create a copy with more primary shards (a multiple of the current count).',
    'delete-by-query': 'Delete every document matching the query. This cannot be undone.',
    'update-by-query': 'Run a Painless script on every document matching the query.',
  }

  // seeded once from the props (the dialog is recreated for another op / index)
  const seed = untrack(() => ({ op, index, shards, replicas }))
  let target = $state(seed.op === 'reindex' ? `${seed.index}-v2` : seed.op === 'clone' ? `${seed.index}-clone` : seed.op === 'shrink' ? `${seed.index}-shrunk` : `${seed.index}-split`)
  let query = $state('')
  let pipeline = $state('')
  let script = $state("ctx._source.status = 'archived'")
  let newShards = $state(seed.op === 'split' ? (seed.shards ?? 1) * 2 : 1)
  let newReplicas = $state(seed.replicas ?? 1)
  let blockWrite = $state(true)
  let matched = $state<number | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)

  const isResize = $derived(op === 'clone' || op === 'shrink' || op === 'split')
  const needsTarget = $derived(op === 'reindex' || isResize)
  const targetErr = $derived(needsTarget ? indexNameError(target) : null)

  const dsl = $derived.by(() => {
    try {
      return { q: buildQuery({ text: query, language: 'kql' }), err: null as string | null }
    } catch (e) {
      return { q: null, err: e instanceof KqlError ? e.message : String(e) }
    }
  })

  const request = $derived.by((): { method: string; path: string; body?: unknown } => {
    switch (op) {
      case 'reindex':
        return {
          method: 'POST',
          path: '/_reindex?refresh=true',
          body: { source: { index, ...(query.trim() && dsl.q ? { query: dsl.q } : {}) }, dest: { index: target, ...(pipeline.trim() ? { pipeline: pipeline.trim() } : {}) } },
        }
      case 'clone':
        return { method: 'POST', path: `/${seg(index)}/_clone/${seg(target)}`, body: { settings: { 'index.number_of_replicas': Number(newReplicas) } } }
      case 'shrink':
      case 'split':
        return { method: 'POST', path: `/${seg(index)}/_${op}/${seg(target)}`, body: { settings: { 'index.number_of_shards': Number(newShards), 'index.number_of_replicas': Number(newReplicas) } } }
      case 'delete-by-query':
        return { method: 'POST', path: `/${seg(index)}/_delete_by_query?refresh=true`, body: { query: dsl.q ?? {} } }
      case 'update-by-query':
        return { method: 'POST', path: `/${seg(index)}/_update_by_query?refresh=true&conflicts=proceed`, body: { query: dsl.q ?? {}, script: { source: script, lang: 'painless' } } }
    }
  })
  const preview = $derived(`${request.method} ${request.path}${request.body ? `\n${JSON.stringify(request.body, null, 2)}` : ''}`)

  async function countMatches() {
    if (!dsl.q) return
    try {
      const r = await es<{ count: number }>(connId, 'POST', `/${seg(index)}/_count`, { query: dsl.q })
      matched = r.count
    } catch (e) {
      error = String((e as Error).message ?? e)
    }
  }
  $effect(() => {
    if (op === 'delete-by-query' || op === 'update-by-query') {
      void query
      matched = null
      const t = setTimeout(() => void countMatches(), 300)
      return () => clearTimeout(t)
    }
  })

  const canRun = $derived(!busy && !dsl.err && !targetErr && (op !== 'delete-by-query' || matched != null))

  async function runOp() {
    if (!canRun) return
    busy = true
    error = null
    try {
      if (isResize) {
        const st = await getSettings(connId, index)
        if (st['index.blocks.write'] !== 'true') {
          if (!blockWrite) throw new Error(`${index} must be write-blocked first (index.blocks.write = true)`)
          await es(connId, 'PUT', `/${seg(index)}/_settings`, { 'index.blocks.write': true })
        }
      }
      const r = await es<Record<string, unknown>>(connId, request.method, request.path, request.body)
      if (isResize) {
        // the copy inherits the write block: lift it there, and on the source when we set it
        await es(connId, 'PUT', `/${seg(target)}/_settings`, { 'index.blocks.write': null }).catch(() => {})
        if (blockWrite) await es(connId, 'PUT', `/${seg(index)}/_settings`, { 'index.blocks.write': null }).catch(() => {})
      }
      const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number).toLocaleString('en-US') : '0')
      const msg =
        op === 'reindex'
          ? `Reindexed ${n('total')} documents into ${target} (${n('created')} created, ${n('updated')} updated)`
          : op === 'delete-by-query'
            ? `Deleted ${n('deleted')} documents from ${index}`
            : op === 'update-by-query'
              ? `Updated ${n('updated')} documents in ${index}`
              : `${TITLE[op]}: ${index} → ${target}`
      onDone(msg, needsTarget ? target : undefined)
    } catch (e) {
      error = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }
</script>

<div class="es-modal-back" role="presentation">
  <div class="es-modal" role="dialog" aria-modal="true" aria-label={TITLE[op]} tabindex="-1" use:focusOnMount style="width:min(var(--px-840), 95vw)" onkeydown={(e) => e.key === 'Escape' && !busy && onClose()}>
    <div class="es-modal-h">
      <span class="es-header-icon" style="width:var(--px-34);height:var(--px-34)"><EsAppIcon name="indexManagement" size={20} /></span>
      <div>
        <div class="es-card-title" style="font-size:var(--px-16)">{TITLE[op]} <span class="mono" style="color:var(--text2);font-weight:500">{index}</span></div>
        <div class="es-sub" style="margin-top:0">{BLURB[op]}</div>
      </div>
    </div>
    <div class="es-modal-b" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-16)">
      <div style="display:flex;flex-direction:column;gap:var(--px-12);min-width:0">
        {#if needsTarget}
          <div>
            <label class="es-label" for="es-op-target">{op === 'reindex' ? 'Destination index' : 'Target index'}</label>
            <input id="es-op-target" class="es-input mono" class:invalid={!!targetErr} style="width:100%" bind:value={target} spellcheck="false" />
            {#if targetErr}<div class="es-error-text">{targetErr}</div>{/if}
          </div>
        {/if}
        {#if op === 'shrink' || op === 'split'}
          <div>
            <label class="es-label" for="es-op-shards">Primary shards <span style="font-weight:400;color:var(--muted)">(now {shards ?? '?'})</span></label>
            <input id="es-op-shards" class="es-input" type="number" min="1" style="width:var(--px-120)" bind:value={newShards} />
          </div>
        {/if}
        {#if isResize}
          <div>
            <label class="es-label" for="es-op-replicas">Replicas <span style="font-weight:400;color:var(--muted)">(the copy does not inherit them)</span></label>
            <input id="es-op-replicas" class="es-input" type="number" min="0" style="width:var(--px-120)" bind:value={newReplicas} />
          </div>
          <label style="display:flex;gap:var(--px-8);align-items:flex-start;font-size:var(--px-12_5)">
            <input type="checkbox" bind:checked={blockWrite} style="margin-top:var(--px-3)" />
            <span>Block writes on <span class="mono">{index}</span> while copying, then lift the block (required by Elasticsearch).</span>
          </label>
        {/if}
        {#if op === 'reindex' || op === 'delete-by-query' || op === 'update-by-query'}
          <div>
            <label class="es-label" for="es-op-query">{op === 'reindex' ? 'Only documents matching (KQL, optional)' : 'Documents matching (KQL)'}</label>
            <input id="es-op-query" class="es-input mono" class:invalid={!!dsl.err} style="width:100%" bind:value={query} placeholder="status:refunded and amount < 10" spellcheck="false" />
            {#if dsl.err}<div class="es-error-text">{dsl.err}</div>{/if}
            {#if matched != null}
              <div class="es-help" data-testid="es-op-matched"><b>{matched.toLocaleString('en-US')}</b> documents match{query.trim() ? '' : ' (every document)'}.</div>
            {/if}
          </div>
        {/if}
        {#if op === 'reindex'}
          <div><label class="es-label" for="es-op-pipeline">Ingest pipeline <span style="font-weight:400;color:var(--muted)">(optional)</span></label><input id="es-op-pipeline" class="es-input mono" style="width:100%" bind:value={pipeline} /></div>
        {/if}
        {#if op === 'update-by-query'}
          <div><span class="es-label">Painless script</span><CodeView value={script} language="javascript" height="auto" minHeight={80} maxHeight={200} onChange={(t) => (script = t)} ariaLabel="Update script" /></div>
        {/if}
        {#if op === 'delete-by-query' && matched != null && matched > 0}
          <div class="es-callout danger">{matched.toLocaleString('en-US')} documents will be deleted permanently.</div>
        {/if}
      </div>
      <div style="min-width:0">
        <span class="es-label">Request</span>
        <CodeView value={preview} language={DS_JSON} readOnly height="auto" minHeight={160} maxHeight={420} ariaLabel="Index operation request" />
      </div>
    </div>
    {#if error}<div class="es-callout danger" role="alert" style="margin:0 var(--px-20) var(--px-10)">{error}</div>{/if}
    <div class="es-modal-f">
      <button class="eg-btn" onclick={onClose} disabled={busy}>Cancel</button>
      <button class="eg-btn {op === 'delete-by-query' ? 'danger' : 'primary'}" onclick={runOp} disabled={!canRun} aria-busy={busy}>{busy ? 'Working…' : TITLE[op]}</button>
    </div>
  </div>
</div>
