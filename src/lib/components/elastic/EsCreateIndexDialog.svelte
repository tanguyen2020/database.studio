<script lang="ts">
  // "Create index" (Kibana Index Management): name, shards / replicas / refresh
  // interval, a field-by-field mapping editor (or raw JSON), aliases — and a live
  // preview of the exact request that will be sent.
  import '$lib/elastic/es.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from './EsIcon.svelte'
  import EsAppIcon from './EsAppIcon.svelte'
  import { createIndex } from '$lib/elastic/api'
  import { FIELD_TYPES } from '$lib/elastic/console'
  import { indexNameError } from '$lib/elastic/format'

  interface Props {
    connId: string
    existing: string[]
    onClose: () => void
    onCreated: (name: string) => void
  }
  let { connId, existing, onClose, onCreated }: Props = $props()

  let name = $state('')
  let shards = $state(1)
  let replicas = $state(1)
  let refresh = $state('1s')
  let aliases = $state('')
  let mode = $state<'fields' | 'json'>('fields')
  let fields = $state<{ name: string; type: string }[]>([
    { name: '@timestamp', type: 'date' },
    { name: '', type: 'keyword' },
  ])
  let rawJson = $state('{\n  "properties": {}\n}')
  let busy = $state(false)
  let error = $state<string | null>(null)

  const nameErr = $derived(name ? indexNameError(name) ?? (existing.includes(name.trim()) ? 'An index with this name already exists' : null) : null)

  const mappings = $derived.by((): { value: unknown; error: string | null } => {
    if (mode === 'json') {
      try {
        return { value: JSON.parse(rawJson), error: null }
      } catch (e) {
        return { value: null, error: (e as Error).message }
      }
    }
    const properties: Record<string, unknown> = {}
    for (const f of fields) {
      const n = f.name.trim()
      if (!n) continue
      // `user.name` → nested objects, like Kibana's mapping editor
      const parts = n.split('.')
      let cur = properties
      for (const p of parts.slice(0, -1)) {
        const node = (cur[p] ??= { properties: {} }) as { properties: Record<string, unknown> }
        cur = node.properties
      }
      cur[parts[parts.length - 1]] = f.type === 'text' ? { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } } : { type: f.type }
    }
    return { value: { properties }, error: null }
  })

  const body = $derived({
    settings: { number_of_shards: Number(shards) || 1, number_of_replicas: Number(replicas) || 0, refresh_interval: refresh || '1s' },
    mappings: mappings.value ?? {},
    ...(aliases.trim() ? { aliases: Object.fromEntries(aliases.split(',').map((a) => [a.trim(), {}]).filter(([a]) => a)) } : {}),
  })
  const preview = $derived(`PUT /${name.trim() || '<name>'}\n${JSON.stringify(body, null, 2)}`)
  const canCreate = $derived(!!name.trim() && !nameErr && !mappings.error && !busy)

  async function create() {
    if (!canCreate) return
    busy = true
    error = null
    try {
      await createIndex(connId, name.trim(), body)
      onCreated(name.trim())
    } catch (e) {
      error = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  function autofocus(node: HTMLElement) {
    node.focus()
  }
</script>

<div class="es-modal-back" role="presentation">
  <div class="es-modal" role="dialog" aria-modal="true" aria-label="Create index" tabindex="-1" use:focusOnMount style="width:min(var(--px-840), 95vw)" onkeydown={(e) => e.key === 'Escape' && !busy && onClose()}>
    <div class="es-modal-h">
      <span class="es-header-icon" style="width:var(--px-34);height:var(--px-34)"><EsAppIcon name="indexManagement" size={20} /></span>
      <div>
        <div class="es-card-title" style="font-size:var(--px-16)">Create index</div>
        <div class="es-sub" style="margin-top:0">Settings, field mappings and aliases — Elasticsearch adds new fields automatically (dynamic mapping) unless you define them here.</div>
      </div>
    </div>
    <div class="es-modal-b" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-16)">
      <div style="display:flex;flex-direction:column;gap:var(--px-12);min-width:0">
        <div>
          <label class="es-label" for="es-new-index-name">Index name</label>
          <input id="es-new-index-name" class="es-input mono" class:invalid={!!nameErr} style="width:100%" bind:value={name} placeholder="orders-2026" spellcheck="false" autocomplete="off" use:autofocus onkeydown={(e) => e.key === 'Enter' && create()} />
          {#if nameErr}<div class="es-error-text">{nameErr}</div>{:else}<div class="es-help">Lowercase; no spaces or \ / * ? " &lt; &gt; | , #.</div>{/if}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--px-10)">
          <div>
            <label class="es-label" for="es-new-shards">Primary shards</label>
            <input id="es-new-shards" class="es-input" type="number" min="1" max="1024" style="width:100%" bind:value={shards} />
          </div>
          <div>
            <label class="es-label" for="es-new-replicas">Replicas</label>
            <input id="es-new-replicas" class="es-input" type="number" min="0" max="10" style="width:100%" bind:value={replicas} />
          </div>
          <div>
            <label class="es-label" for="es-new-refresh">Refresh</label>
            <input id="es-new-refresh" class="es-input mono" style="width:100%" bind:value={refresh} placeholder="1s" />
          </div>
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-5)">
            <span class="es-label" style="margin:0">Mappings</span>
            <span class="es-seg" style="margin-left:auto">
              <button class:on={mode === 'fields'} onclick={() => (mode = 'fields')}>Fields</button>
              <button class:on={mode === 'json'} onclick={() => (mode = 'json')}>JSON</button>
            </span>
          </div>
          {#if mode === 'fields'}
            <div style="display:flex;flex-direction:column;gap:var(--px-6)" data-testid="es-new-fields">
              {#each fields as fl, i (i)}
                <div style="display:flex;gap:var(--px-6)">
                  <input class="es-input mono" style="flex:1 1 auto" bind:value={fl.name} placeholder="field.name" aria-label="Field name {i + 1}" spellcheck="false" />
                  <select class="es-input" style="width:var(--px-140)" bind:value={fl.type} aria-label="Field type {i + 1}">
                    {#each FIELD_TYPES as t (t)}<option value={t}>{t}</option>{/each}
                  </select>
                  <button class="eg-btn" title="Remove field" aria-label="Remove field {i + 1}" onclick={() => (fields = fields.filter((_, j) => j !== i))}><EsIcon name="trash" size={13} /></button>
                </div>
              {/each}
              <button class="eg-btn" style="align-self:flex-start" onclick={() => (fields = [...fields, { name: '', type: 'keyword' }])}><EsIcon name="plus" size={13} /> Add field</button>
              <div class="es-help">A <b>text</b> field also gets a <span class="mono">.keyword</span> sub-field for sorting and aggregations.</div>
            </div>
          {:else}
            <CodeView value={rawJson} language={DS_JSON} height="auto" minHeight={160} maxHeight={260} onChange={(t) => (rawJson = t)} ariaLabel="Mappings JSON" />
            {#if mappings.error}<div class="es-error-text">Invalid JSON — {mappings.error}</div>{/if}
          {/if}
        </div>
        <div>
          <label class="es-label" for="es-new-aliases">Aliases <span style="font-weight:400;color:var(--muted)">(optional, comma separated)</span></label>
          <input id="es-new-aliases" class="es-input mono" style="width:100%" bind:value={aliases} placeholder="orders-current" spellcheck="false" />
        </div>
      </div>
      <div style="min-width:0;display:flex;flex-direction:column">
        <span class="es-label">Request</span>
        <CodeView value={preview} language={DS_JSON} readOnly height="auto" minHeight={200} maxHeight={460} ariaLabel="Create index request" />
      </div>
    </div>
    {#if error}
      <div class="es-callout danger" role="alert" style="margin:0 var(--px-20) var(--px-10)">{error}</div>
    {/if}
    <div class="es-modal-f">
      <button class="eg-btn" onclick={onClose} disabled={busy}>Cancel</button>
      <button class="eg-btn primary" onclick={create} disabled={!canCreate} aria-busy={busy}>{busy ? 'Creating…' : 'Create index'}</button>
    </div>
  </div>
</div>
