<script lang="ts">
  // Stack Management page for one resource kind (resources.ts): searchable list on
  // the left, the definition in a JSON editor on the right with Save / Delete and
  // the kind's own actions (Simulate, Verify, Run now, Start / Stop…). Snapshot
  // repositories also list their snapshots (take / restore / delete).
  import '$lib/elastic/es.css'
  import { focusOnMount } from '$lib/elastic/actions'
  import type { TabState } from '$lib/types'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from './EsIcon.svelte'
  import EsAppIcon from './EsAppIcon.svelte'
  import type { EuiApp } from '$lib/elastic/eui-icons'
  import EsConfirmDialog from './EsConfirmDialog.svelte'
  import { es, seg, EsError } from '$lib/elastic/api'
  import { RESOURCE_KINDS, resourceKind, withConcurrency, type ResourceRow } from '$lib/elastic/resources'
  import { OS_RESOURCE_KINDS } from '$lib/elastic/os-resources'
  import { searchProduct } from '$lib/elastic/flavor'
  import { fmtTimestamp } from '$lib/elastic/format'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { untrack } from 'svelte'

  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  const st = $derived(tab.state as { kind: string; select?: string | null })
  // OpenSearch has its own management APIs (ISM, Snapshot Management, Alerting… — SPEC-OPENSEARCH.md)
  const product = $derived(searchProduct(connId))
  const kind = $derived(resourceKind(st.kind, product.os ? OS_RESOURCE_KINDS : RESOURCE_KINDS))

  // Kibana app icon of the page that manages this kind
  const ICON: Record<string, EuiApp> = {
    'index-templates': 'indexManagement',
    'component-templates': 'indexManagement',
    pipelines: 'pipeline',
    ilm: 'indexManagement',
    'data-streams': 'indexManagement',
    'snapshot-repos': 'management',
    slm: 'management',
    scripts: 'devtools',
    enrich: 'management',
    transforms: 'indexRollup',
    watches: 'watches',
    ism: 'indexManagement',
    sm: 'management',
    rollups: 'indexRollup',
    monitors: 'watches',
  }

  /** the id used in REST paths — the generated id of an OpenSearch monitor, else the name */
  function keyOf(name: string): string {
    return rows.find((r) => r.name === name)?.id ?? name
  }

  let rows = $state<ResourceRow[]>([])
  let loading = $state(false)
  let listError = $state<string | null>(null)
  let filter = $state('')
  let showHidden = $state(false)
  let selected = $state<string | null>(null)
  let isNew = $state(false)
  let draft = $state('')
  let original = $state('')
  let detailError = $state<string | null>(null)
  let busy = $state(false)
  let result = $state<{ label: string; text: string; ok: boolean } | null>(null)
  let confirm = $state<{ title: string; body: string; action: string; typeToConfirm?: string; run: () => Promise<void> } | null>(null)
  let newName = $state<string | null>(null)

  const visible = $derived(rows.filter((r) => (showHidden || !r.name.startsWith('.')) && (!filter || r.name.toLowerCase().includes(filter.toLowerCase()))))
  const hiddenCount = $derived(rows.filter((r) => r.name.startsWith('.')).length)
  const dirty = $derived(draft !== original)
  const parsed = $derived.by(() => {
    if (kind?.saveNoBody) return { ok: true as const, value: null }
    try {
      return { ok: true as const, value: JSON.parse(draft || '{}') }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  async function load(keepSelection = true) {
    if (!kind) return
    loading = true
    listError = null
    try {
      let j: unknown
      try {
        j = await es(connId, kind.listMethod ?? 'GET', kind.listPath, kind.listBody)
      } catch (e) {
        // the plugin has not created its config index yet — nothing there (O15)
        if (kind.emptyOn404 && e instanceof EsError && e.status === 404) j = null
        else throw e
      }
      rows = j === null ? [] : kind.parseList(j).sort((a, b) => a.name.localeCompare(b.name))
      const want = keepSelection ? (selected ?? st.select ?? null) : null
      if (want && rows.some((r) => r.name === want)) await select(want)
      else if (!isNew) {
        selected = null
        draft = original = ''
      }
    } catch (e) {
      listError = String((e as Error).message ?? e)
      rows = []
    } finally {
      loading = false
    }
  }

  async function select(name: string) {
    if (!kind) return
    isNew = false
    selected = name
    result = null
    detailError = null
    snapshots = null
    const row = rows.find((r) => r.name === name)
    let body: unknown = row?.body
    if (kind.getPath) {
      try {
        const j = await es(connId, 'GET', kind.getPath(keyOf(name)))
        body = kind.pickBody ? kind.pickBody(j, name) : j
      } catch (e) {
        detailError = String((e as Error).message ?? e)
      }
    }
    draft = original = JSON.stringify(body ?? {}, null, 2)
    if (st.kind === 'snapshot-repos') void loadSnapshots()
  }

  $effect(() => {
    void st.kind
    void connId
    untrack(() => {
      selected = null
      isNew = false
      draft = original = ''
      void load()
    })
  })
  // explorer "Manage data stream" retargets the selection
  $effect(() => {
    const want = st.select
    untrack(() => {
      if (want && want !== selected && rows.some((r) => r.name === want)) void select(want)
    })
  })

  function startNew() {
    newName = ''
  }

  function confirmNew() {
    if (!kind || !newName?.trim()) return
    const n = newName.trim()
    if (rows.some((r) => r.name === n)) {
      toasts.error(`A ${kind.singular} named ${n} already exists`, 'elasticsearch')
      return
    }
    newName = null
    isNew = true
    selected = n
    result = null
    detailError = null
    snapshots = null
    draft = kind.saveNoBody ? '' : JSON.stringify(kind.template?.(n) ?? {}, null, 2)
    original = ''
  }

  async function save() {
    if (!kind?.savePath || !selected || !parsed.ok || busy) return
    busy = true
    detailError = null
    try {
      const body = kind.saveNoBody ? undefined : parsed.value
      if (isNew) {
        await es(connId, kind.createMethod ?? kind.saveMethod ?? 'PUT', kind.createPath ? kind.createPath(selected) : kind.savePath(selected), body)
      } else {
        const key = keyOf(selected)
        // updates must name the version they replace — read it now, not when the page opened (O14)
        const version = kind.concurrency && kind.getPath ? kind.concurrency(await es(connId, 'GET', kind.getPath(key))) : null
        await es(connId, kind.saveMethod ?? 'PUT', withConcurrency(kind.savePath(key), version), body)
      }
      toasts.success(`${isNew ? 'Created' : 'Saved'} ${kind.singular} ${selected}`, 'elasticsearch')
      isNew = false
      original = draft
      explorer.bumpEs(connId)
      await load()
    } catch (e) {
      detailError = String((e as Error).message ?? e)
    } finally {
      busy = false
    }
  }

  function askDelete() {
    if (!kind?.deletePath || !selected) return
    const name = selected
    confirm = {
      title: `Delete ${kind.singular} ${name}?`,
      body: kind.key === 'data-streams' ? 'The data stream and every backing index are deleted.' : `The ${kind.singular} is removed from the cluster.`,
      action: 'Delete',
      typeToConfirm: kind.key === 'data-streams' || kind.key === 'snapshot-repos' ? name : undefined,
      run: async () => {
        await es(connId, 'DELETE', kind.deletePath!(keyOf(name)))
        toasts.success(`Deleted ${kind.singular} ${name}`, 'elasticsearch')
        selected = null
        draft = original = ''
        explorer.bumpEs(connId)
        await load(false)
      },
    }
  }

  async function runAction(a: NonNullable<NonNullable<typeof kind>['actions']>[number]) {
    if (!selected) return
    busy = true
    try {
      const body = a.body ? a.body(selected, parsed.ok ? parsed.value : null) : undefined
      const r = await es(connId, a.method, a.path(keyOf(selected)), body)
      result = { label: a.label, text: JSON.stringify(r, null, 2), ok: true }
      if (a.key !== 'simulate' && a.key !== 'preview' && a.key !== 'stats') {
        toasts.success(`${a.label}: ${selected}`, 'elasticsearch')
        explorer.bumpEs(connId)
      }
    } catch (e) {
      result = { label: a.label, text: String((e as Error).message ?? e), ok: false }
    } finally {
      busy = false
    }
  }

  // ---- snapshots (snapshot repositories) ---------------------------------------
  interface Snap {
    snapshot: string
    state: string
    indices: string[]
    start_time_in_millis?: number
    duration_in_millis?: number
  }
  let snapshots = $state<Snap[] | null>(null)
  let snapError = $state<string | null>(null)
  let takeForm = $state<{ name: string; indices: string } | null>(null)
  let restoreForm = $state<{ snap: string; indices: string; renamePattern: string; renameReplacement: string } | null>(null)

  async function loadSnapshots() {
    if (!selected) return
    try {
      const r = await es<{ snapshots: Snap[] }>(connId, 'GET', `/_snapshot/${seg(selected)}/_all`)
      snapshots = (r.snapshots ?? []).sort((a, b) => (b.start_time_in_millis ?? 0) - (a.start_time_in_millis ?? 0))
      snapError = null
    } catch (e) {
      snapError = String((e as Error).message ?? e)
    }
  }

  async function takeSnapshot() {
    if (!selected || !takeForm?.name.trim()) return
    busy = true
    try {
      const body: Record<string, unknown> = { include_global_state: false }
      if (takeForm.indices.trim()) body.indices = takeForm.indices.trim()
      await es(connId, 'PUT', `/_snapshot/${seg(selected)}/${seg(takeForm.name.trim())}?wait_for_completion=true`, body)
      toasts.success(`Snapshot ${takeForm.name.trim()} taken`, 'elasticsearch')
      takeForm = null
      await loadSnapshots()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    } finally {
      busy = false
    }
  }

  async function restore() {
    if (!selected || !restoreForm) return
    busy = true
    try {
      const body: Record<string, unknown> = { include_global_state: false }
      if (restoreForm.indices.trim()) body.indices = restoreForm.indices.trim()
      if (restoreForm.renamePattern.trim()) {
        body.rename_pattern = restoreForm.renamePattern.trim()
        body.rename_replacement = restoreForm.renameReplacement
      }
      await es(connId, 'POST', `/_snapshot/${seg(selected)}/${seg(restoreForm.snap)}/_restore?wait_for_completion=true`, body)
      toasts.success(`Restored ${restoreForm.snap}`, 'elasticsearch')
      restoreForm = null
      explorer.bumpEs(connId)
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    } finally {
      busy = false
    }
  }

  function deleteSnapshot(name: string) {
    const repo = selected!
    confirm = {
      title: `Delete snapshot ${name}?`,
      body: `The snapshot is removed from repository ${repo}. Files shared with other snapshots are kept.`,
      action: 'Delete snapshot',
      run: async () => {
        await es(connId, 'DELETE', `/_snapshot/${seg(repo)}/${seg(name)}`)
        toasts.success(`Deleted snapshot ${name}`, 'elasticsearch')
        await loadSnapshots()
      },
    }
  }
</script>

<div class="es-page" data-testid="es-manage">
  {#if !kind}
    <div class="es-empty">Unknown management page.</div>
  {:else}
    <div class="es-header">
      <span class="es-header-icon"><EsAppIcon name={ICON[kind.key] ?? 'management'} size={24} /></span>
      <div style="min-width:0">
        <div class="es-title">{kind.label}</div>
        <div class="es-sub">{kind.blurb}</div>
      </div>
      <div class="es-header-actions">
        <button class="eg-btn" onclick={() => load()} aria-busy={loading}><EsIcon name="refresh" size={13} /> Refresh</button>
        {#if kind.savePath}
          <button class="eg-btn primary" onclick={startNew}><EsIcon name="plus" size={13} /> Create {kind.singular}</button>
        {/if}
      </div>
    </div>

    <div class="es-split" style="flex:1 1 auto;height:auto;min-height:0">
      <aside class="es-side" aria-label="{kind.label} list">
        <div style="padding:var(--px-10);display:flex;flex-direction:column;gap:var(--px-6)">
          <input class="es-input" bind:value={filter} placeholder="Search {kind.label.toLowerCase()}" aria-label="Search {kind.label}" />
          {#if hiddenCount}
            <label style="font-size:var(--px-11_5);color:var(--text2);display:inline-flex;gap:var(--px-5);align-items:center"><input type="checkbox" bind:checked={showHidden} /> Show system ({hiddenCount})</label>
          {/if}
        </div>
        <div style="flex:1 1 auto;overflow:auto;padding:0 var(--px-6) var(--px-10)" role="listbox" aria-label={kind.label}>
          {#if listError}
            <div class="es-callout warn" role="alert" style="margin:var(--px-4)">
              <div>{listError}{#if kind.requires}<div class="es-help">{kind.requires}</div>{/if}</div>
            </div>
          {:else if loading && !rows.length}
            <div class="es-help" style="padding:var(--px-8)">Loading…</div>
          {:else if !visible.length}
            <div class="es-empty" style="padding:var(--px-24) var(--px-12)">
              <div class="es-empty-title" style="font-size:var(--px-14)">Nothing here yet</div>
              {#if kind.savePath}Create the first {kind.singular}.{/if}
            </div>
          {/if}
          {#each visible as r (r.name)}
            <div class="es-row" class:sel={selected === r.name && !isNew} role="option" aria-selected={selected === r.name} tabindex="0" onclick={() => select(r.name)} onkeydown={(e) => e.key === 'Enter' && select(r.name)} title={r.meta ?? r.name}>
              <div style="min-width:0;flex:1 1 auto">
                <div class="es-ellipsis" style="font-weight:600">{r.name}</div>
                {#if r.meta}<div class="es-ellipsis" style="font-size:var(--px-11_5);color:var(--text2)">{r.meta}</div>{/if}
              </div>
              {#each r.badges ?? [] as b (b)}<span class="es-badge {b === 'green' ? 'green' : b === 'yellow' ? 'yellow' : b === 'red' ? 'red' : ''}">{b}</span>{/each}
            </div>
          {/each}
        </div>
      </aside>

      <section class="es-main" style="background:var(--bg)">
        {#if !selected}
          <div class="es-empty" style="margin:auto">
            <div class="es-empty-title">Select a {kind.singular}</div>
            {#if kind.savePath}…or <button class="es-link" style="border:none;background:none;color:var(--es-accent);font-weight:600;cursor:pointer;font:inherit" onclick={startNew}>create a new one</button>.{/if}
          </div>
        {:else}
          <div class="es-body" style="display:flex;flex-direction:column;gap:var(--px-14)">
            <div class="es-card">
              <div class="es-card-h">
                <span class="es-card-title mono">{selected}</span>
                {#if isNew}<span class="es-badge accent">new</span>{:else if dirty}<span class="es-badge yellow">unsaved changes</span>{/if}
                <span style="margin-left:auto;display:flex;gap:var(--px-6);flex-wrap:wrap;justify-content:flex-end">
                  {#if kind.key === 'data-streams' && !isNew}
                    <button class="eg-btn" onclick={() => tabs.openEsIndex(connId, selected!)}><EsIcon name="discover" size={13} /> Discover</button>
                  {/if}
                  {#each !isNew ? (kind.actions ?? []) : [] as a (a.key)}
                    <button class="eg-btn" onclick={() => runAction(a)} disabled={busy}>{a.label}</button>
                  {/each}
                  {#if kind.savePath && (isNew || !kind.saveNoBody)}
                    <button class="eg-btn primary" onclick={save} disabled={busy || !parsed.ok || (!isNew && !dirty)} aria-busy={busy}>{isNew ? `Create ${kind.singular}` : 'Save'}</button>
                  {/if}
                  {#if kind.deletePath && !isNew}
                    <button class="eg-btn ds-danger-outline" onclick={askDelete} aria-label="Delete {kind.singular}"><EsIcon name="trash" size={13} /></button>
                  {/if}
                </span>
              </div>
              <div class="es-card-b">
                {#if detailError}<div class="es-callout danger" role="alert" style="margin-bottom:var(--px-10)">{detailError}</div>{/if}
                {#if kind.saveNoBody && isNew}
                  <div class="es-callout">Creates the data stream from the matching index template (it must have <span class="mono">"data_stream": {'{}'}</span>). Press <b>Create {kind.singular}</b>.</div>
                {:else}
                  <span class="es-label">{kind.saveNoBody || !kind.savePath ? 'Definition (read-only)' : isNew ? `${kind.createMethod ?? kind.saveMethod ?? 'PUT'} ${kind.createPath ? kind.createPath(selected) : kind.savePath(selected)}` : `${kind.saveMethod ?? 'PUT'} ${kind.savePath(keyOf(selected))}`}</span>
                  {#if kind.editorHelp}<div class="es-help" style="margin:0 0 var(--px-6)">{kind.editorHelp}</div>{/if}
                  <CodeView value={draft} language={DS_JSON} readOnly={!kind.savePath || !!kind.saveNoBody} height="auto" minHeight={220} maxHeight={620} onChange={(t) => (draft = t)} onSubmit={save} ariaLabel="{kind.singular} definition" />
                  {#if !parsed.ok}<div class="es-error-text">Invalid JSON — {parsed.error}</div>{/if}
                {/if}
              </div>
            </div>

            {#if result}
              <div class="es-card" data-testid="es-action-result">
                <div class="es-card-h">
                  <span class="es-card-title">{result.label}</span>
                  <span class="es-badge {result.ok ? 'green' : 'red'}">{result.ok ? 'OK' : 'Error'}</span>
                  <button class="eg-btn" style="margin-left:auto" onclick={() => (result = null)}>Close</button>
                </div>
                <div class="es-card-b">
                  {#if result.ok}
                    <CodeView value={result.text} language={DS_JSON} readOnly height="auto" minHeight={100} maxHeight={420} ariaLabel="{result.label} result" />
                  {:else}
                    <div class="es-callout danger">{result.text}</div>
                  {/if}
                </div>
              </div>
            {/if}

            {#if kind.key === 'snapshot-repos' && !isNew}
              <div class="es-card" data-testid="es-snapshots">
                <div class="es-card-h">
                  <span class="es-card-title">Snapshots</span>
                  <span class="es-badge">{snapshots?.length ?? 0}</span>
                  <button class="eg-btn primary" style="margin-left:auto" onclick={() => (takeForm = { name: `snap-${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}`, indices: '' })}><EsIcon name="snapshot" size={13} /> Take snapshot</button>
                </div>
                {#if takeForm}
                  <div class="es-card-b es-toolbar" style="border-bottom:var(--px-1) solid var(--border)">
                    <input class="es-input mono" style="width:var(--px-220)" bind:value={takeForm.name} aria-label="Snapshot name" />
                    <input class="es-input mono" style="flex:1 1 var(--px-200)" bind:value={takeForm.indices} placeholder="Indices (empty = all, e.g. orders,logs-*)" aria-label="Snapshot indices" />
                    <button class="eg-btn primary" onclick={takeSnapshot} disabled={busy || !takeForm.name.trim()}>Take</button>
                    <button class="eg-btn" onclick={() => (takeForm = null)}>Cancel</button>
                  </div>
                {/if}
                {#if restoreForm}
                  <div class="es-card-b" style="border-bottom:var(--px-1) solid var(--border);display:flex;flex-direction:column;gap:var(--px-8)">
                    <div style="font-weight:600">Restore <span class="mono">{restoreForm.snap}</span></div>
                    <div class="es-toolbar">
                      <input class="es-input mono" style="flex:1 1 var(--px-200)" bind:value={restoreForm.indices} placeholder="Indices (empty = all in the snapshot)" aria-label="Restore indices" />
                      <input class="es-input mono" style="width:var(--px-180)" bind:value={restoreForm.renamePattern} placeholder="Rename pattern (.+)" aria-label="Rename pattern" />
                      <input class="es-input mono" style="width:var(--px-180)" bind:value={restoreForm.renameReplacement} placeholder="restored-$1" aria-label="Rename replacement" />
                    </div>
                    <div class="es-help" style="margin:0">An open index with the same name blocks the restore — close / delete it, or rename on restore.</div>
                    <div class="es-toolbar">
                      <button class="eg-btn primary" onclick={restore} disabled={busy}>Restore</button>
                      <button class="eg-btn" onclick={() => (restoreForm = null)}>Cancel</button>
                    </div>
                  </div>
                {/if}
                {#if snapError}
                  <div class="es-card-b"><div class="es-callout danger">{snapError}</div></div>
                {:else if snapshots && snapshots.length}
                  <table class="es-table">
                    <thead><tr><th>Snapshot</th><th>State</th><th>Indices</th><th>Started</th><th class="num">Duration</th><th></th></tr></thead>
                    <tbody>
                      {#each snapshots as s (s.snapshot)}
                        <tr>
                          <td class="mono">{s.snapshot}</td>
                          <td><span class="es-badge {s.state === 'SUCCESS' ? 'green' : s.state === 'FAILED' ? 'red' : 'yellow'}">{s.state}</span></td>
                          <td class="mono es-ellipsis" style="max-width:var(--px-240);font-size:var(--px-11_5)" title={s.indices.join(', ')}>{s.indices.join(', ')}</td>
                          <td>{s.start_time_in_millis ? fmtTimestamp(s.start_time_in_millis) : '—'}</td>
                          <td class="num">{s.duration_in_millis != null ? `${(s.duration_in_millis / 1000).toFixed(1)} s` : '—'}</td>
                          <td style="text-align:right;white-space:nowrap">
                            <button class="eg-btn" onclick={() => (restoreForm = { snap: s.snapshot, indices: '', renamePattern: '', renameReplacement: '' })}>Restore…</button>
                            <button class="eg-btn ds-danger-outline" aria-label="Delete snapshot {s.snapshot}" onclick={() => deleteSnapshot(s.snapshot)}><EsIcon name="trash" size={13} /></button>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                {:else if snapshots}
                  <div class="es-empty">No snapshots in this repository yet.</div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

{#if newName !== null && kind}
  <div class="es-modal-back" role="presentation">
    <div class="es-modal" role="dialog" aria-modal="true" aria-label="Create {kind.singular}" tabindex="-1" use:focusOnMount style="width:min(var(--px-460), 94vw)" onkeydown={(e) => e.key === 'Escape' && (newName = null)}>
      <div class="es-modal-h"><span class="es-card-title" style="font-size:var(--px-15)">Create {kind.singular}</span></div>
      <div class="es-modal-b">
        <label class="es-label" for="es-new-resource-name">Name</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input id="es-new-resource-name" class="es-input mono" style="width:100%" bind:value={newName} placeholder={kind.namePlaceholder ?? `my-${kind.singular.replace(/\s+/g, '-')}`} autofocus spellcheck="false" onkeydown={(e) => e.key === 'Enter' && confirmNew()} />
        <div class="es-help">{kind.saveNoBody ? 'Must match an index template with data_stream enabled.' : 'A starter definition is filled in — adjust it, then press Create.'}</div>
      </div>
      <div class="es-modal-f">
        <button class="eg-btn" onclick={() => (newName = null)}>Cancel</button>
        <button class="eg-btn primary" onclick={confirmNew} disabled={!newName?.trim()}>Continue</button>
      </div>
    </div>
  </div>
{/if}

{#if confirm}
  <EsConfirmDialog title={confirm.title} body={confirm.body} action={confirm.action} typeToConfirm={confirm.typeToConfirm} run={confirm.run} onClose={() => (confirm = null)} />
{/if}
