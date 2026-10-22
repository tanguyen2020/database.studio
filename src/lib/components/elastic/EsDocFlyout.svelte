<script lang="ts">
  // Document detail flyout (Kibana Discover "Expanded document"): Table / JSON views,
  // filter-for / filter-out / toggle-column per field, and editing — replace the
  // document, or create a new one (id optional). Delete asks for confirmation.
  import '$lib/elastic/es.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from './EsIcon.svelte'
  import EsAppIcon from './EsAppIcon.svelte'
  import EsConfirmDialog from './EsConfirmDialog.svelte'
  import { deleteDoc, saveDoc, type EsHit } from '$lib/elastic/api'
  import { displayValue, flattenSource } from '$lib/elastic/format'
  import { toasts } from '$lib/stores/toast.svelte'

  interface Props {
    connId: string
    /** index (or alias / data stream) the tab is on — new documents go here */
    index: string
    /** the hit to show; null = create a new document */
    hit: EsHit | null
    fieldTypes: Record<string, string>
    columns: string[]
    onClose: () => void
    onChanged: () => void
    onFilter?: (field: string, value: unknown, negate: boolean) => void
    onToggleColumn?: (field: string) => void
  }
  let { connId, index, hit, fieldTypes, columns, onClose, onChanged, onFilter, onToggleColumn }: Props = $props()

  const isNew = $derived(hit === null)
  let view = $state<'table' | 'json'>('table')
  let editing = $state(false)
  let draft = $state('')
  let newId = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let confirmDelete = $state(false)
  let fieldFilter = $state('')

  $effect(() => {
    // (re)initialise when the shown document changes
    const h = hit
    editing = h === null
    draft = JSON.stringify(h?._source ?? {}, null, 2)
    error = null
  })

  const flat = $derived(Object.entries(flattenSource(hit?._source ?? {})).filter(([k]) => !fieldFilter || k.toLowerCase().includes(fieldFilter.toLowerCase())))
  const parsed = $derived.by(() => {
    try {
      const v = JSON.parse(draft)
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false as const, error: 'A document must be a JSON object' }
      return { ok: true as const, value: v }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  async function save() {
    if (!parsed.ok || busy) return
    busy = true
    error = null
    try {
      // edit in the concrete index the hit came from (an alias / data stream may span several)
      const target = hit?._index ?? index
      const r = await saveDoc(connId, target, hit?._id ?? (newId.trim() || null), parsed.value)
      toasts.success(isNew ? `Document ${r._id} created` : `Document ${r._id} saved`, 'elasticsearch')
      onChanged()
      onClose()
    } catch (e) {
      error = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  async function copy(text: string, what = 'Copied') {
    await navigator.clipboard.writeText(text)
    toasts.success(what, 'elasticsearch')
  }
</script>

<div class="es-flyout-back" role="presentation">
  <div class="es-flyout" role="dialog" aria-modal="true" aria-label={isNew ? 'New document' : 'Document'} tabindex="-1" use:focusOnMount onkeydown={(e) => e.key === 'Escape' && !busy && onClose()}>
    <div class="es-modal-h" style="border-bottom:var(--px-1) solid var(--border);padding-bottom:var(--px-12)">
      <span class="es-header-icon" style="width:var(--px-34);height:var(--px-34)"><EsAppIcon name="discover" size={20} /></span>
      <div style="min-width:0;flex:1 1 auto">
        <div class="es-card-title" style="font-size:var(--px-16)">{isNew ? 'Add document' : 'Document'}</div>
        {#if hit}
          <div class="es-sub es-ellipsis" style="margin-top:0">
            <span class="mono">{hit._id}</span> · {hit._index}{#if hit._version != null} · version {hit._version}{/if}
          </div>
        {:else}
          <div class="es-sub" style="margin-top:0">Into <span class="mono">{index}</span></div>
        {/if}
      </div>
      {#if hit && !editing}
        <button class="eg-btn" onclick={() => copy(hit._id, 'Copied id')} title="Copy document id"><EsIcon name="copy" size={13} /> Id</button>
        <button class="eg-btn" onclick={() => copy(JSON.stringify(hit._source ?? {}, null, 2), 'Copied JSON')}><EsIcon name="copy" size={13} /> JSON</button>
        <button class="eg-btn primary" onclick={() => (editing = true)}><EsIcon name="edit" size={13} /> Edit</button>
        <button class="eg-btn ds-danger-outline" onclick={() => (confirmDelete = true)} aria-label="Delete document"><EsIcon name="trash" size={13} /></button>
      {/if}
      <button class="eg-btn" onclick={onClose} aria-label="Close" title="Close"><EsIcon name="close" size={13} /></button>
    </div>

    <div style="flex:1 1 auto;min-height:0;overflow:auto;padding:var(--px-14) var(--px-20)">
      {#if editing}
        {#if isNew}
          <label class="es-label" for="es-new-doc-id">Document id <span style="font-weight:400;color:var(--muted)">(optional — Elasticsearch generates one)</span></label>
          <input id="es-new-doc-id" class="es-input mono" style="width:100%;margin-bottom:var(--px-12)" bind:value={newId} placeholder="auto" spellcheck="false" />
        {/if}
        <span class="es-label">Source</span>
        <CodeView value={draft} language={DS_JSON} height="auto" minHeight={240} maxHeight={640} autofocus onChange={(t) => (draft = t)} onSubmit={save} ariaLabel="Document source" />
        {#if !parsed.ok}
          <div class="es-error-text">Invalid JSON — {parsed.error}</div>
        {:else}
          <div class="es-help">{isNew ? 'Indexed with ?refresh=wait_for so it shows up in the next search.' : 'Saving replaces the whole document (PUT _doc). Ctrl+Enter saves.'}</div>
        {/if}
        {#if error}<div class="es-callout danger" role="alert" style="margin-top:var(--px-10)">{error}</div>{/if}
      {:else if hit}
        <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-10)">
          <span class="es-seg">
            <button class:on={view === 'table'} onclick={() => (view = 'table')}><EsIcon name="table" size={12} /> Table</button>
            <button class:on={view === 'json'} onclick={() => (view = 'json')}><EsIcon name="json" size={12} /> JSON</button>
          </span>
          {#if view === 'table'}
            <input class="es-input" style="margin-left:auto;width:var(--px-220)" bind:value={fieldFilter} placeholder="Search field names" aria-label="Search field names" />
          {/if}
        </div>
        {#if view === 'table'}
          <table class="es-table" data-testid="es-doc-table">
            <thead><tr><th style="width:var(--px-90)">Actions</th><th>Field</th><th>Value</th></tr></thead>
            <tbody>
              {#each flat as [k, v] (k)}
                <tr>
                  <td>
                    <span style="display:inline-flex;gap:var(--px-2)">
                      {#if onFilter}
                        <button class="eg-btn" style="padding:var(--px-2) var(--px-5)" title="Filter for value" aria-label="Filter for {k}" onclick={() => onFilter?.(k, v, false)}><EsIcon name="filterInclude" size={12} /></button>
                        <button class="eg-btn" style="padding:var(--px-2) var(--px-5)" title="Filter out value" aria-label="Filter out {k}" onclick={() => onFilter?.(k, v, true)}><EsIcon name="filterExclude" size={12} /></button>
                      {/if}
                      {#if onToggleColumn}
                        <button class="eg-btn" style="padding:var(--px-2) var(--px-5)" title={columns.includes(k) ? 'Remove column' : 'Toggle column in table'} aria-label="Toggle column {k}" onclick={() => onToggleColumn?.(k)}><EsIcon name="table" size={11} /></button>
                      {/if}
                    </span>
                  </td>
                  <td class="mono" style="white-space:nowrap;font-weight:600">{k}{#if fieldTypes[k]}<span style="font-weight:400;color:var(--muted)"> · {fieldTypes[k]}</span>{/if}</td>
                  <td class="mono selectable" style="word-break:break-word">{displayValue(v)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <CodeView value={JSON.stringify({ _index: hit._index, _id: hit._id, _version: hit._version, _source: hit._source }, null, 2)} language={DS_JSON} readOnly height="auto" minHeight={200} maxHeight={900} ariaLabel="Document JSON" />
        {/if}
      {/if}
    </div>

    {#if editing}
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (isNew ? onClose() : (editing = false))} disabled={busy}>Cancel</button>
        <button class="eg-btn primary" onclick={save} disabled={!parsed.ok || busy} aria-busy={busy}>{busy ? 'Saving…' : isNew ? 'Add document' : 'Save document'}</button>
      </div>
    {/if}
  </div>
</div>

{#if confirmDelete && hit}
  <EsConfirmDialog
    title="Delete document {hit._id}?"
    body="The document is removed from {hit._index}. This cannot be undone."
    action="Delete document"
    run={async () => {
      await deleteDoc(connId, hit._index, hit._id)
      toasts.success(`Deleted ${hit._id}`, 'elasticsearch')
      onChanged()
      onClose()
    }}
    onClose={() => (confirmDelete = false)}
  />
{/if}
