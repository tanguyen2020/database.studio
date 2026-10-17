<script lang="ts">
  // Index page (Kibana Discover + Index Management detail): header with health and
  // size, actions (refresh / flush / force merge / clear cache / open-close / delete),
  // and tabs — Discover · Mappings · Settings · Statistics · Aliases · Lifecycle.
  // Works on a concrete index, an alias or a data stream (Discover / Mappings span
  // every backing index).
  import { onMount, untrack } from 'svelte'
  import '$lib/elastic/es.css'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from './EsIcon.svelte'
  import EsAppIcon from './EsAppIcon.svelte'
  import EsDiscover from './EsDiscover.svelte'
  import EsFieldToken from './EsFieldToken.svelte'
  import EsConfirmDialog from './EsConfirmDialog.svelte'
  import EsIndexOpsDialog, { type IndexOp } from './EsIndexOpsDialog.svelte'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import {
    addAlias,
    aliases as listAliases,
    es,
    getMapping,
    getSettings,
    indexAction,
    indexStats,
    putMapping,
    putSettings,
    removeAlias,
    seg,
    type AliasEntry,
    type IndexAction,
    type IndexStats,
    type MappingProps,
  } from '$lib/elastic/api'
  import { FIELD_TYPES } from '$lib/elastic/console'
  import { fmtCount, formatBytes, healthColor, healthLabel } from '$lib/elastic/format'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'

  let { tab }: { tab: TabState } = $props()
  const st = $derived(tab.state as { index: string; section?: string; discover?: Record<string, unknown> })
  const connId = $derived(tab.connectionId ?? '')
  const index = $derived(st.index)
  const section = $derived(st.section ?? 'discover')

  // discover view state lives in the tab (survives tab switches / keep-alive)
  untrack(() => {
    if (!(tab.state as Record<string, unknown>).discover) (tab.state as Record<string, unknown>).discover = {}
  })

  let info = $state<ipc.EsIndex | null>(null)
  let kind = $state<'index' | 'alias' | 'data stream' | 'pattern'>('index')
  let backing = $state<string[]>([])

  async function loadInfo() {
    try {
      const all = await ipc.esIndices(connId)
      info = all.find((i) => i.name === index) ?? null
      if (info) {
        kind = 'index'
        return
      }
      if (index.includes('*') || index.includes(',')) {
        kind = 'pattern'
        backing = all.filter((i) => new RegExp(`^${index.split(',')[0].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(i.name)).map((i) => i.name)
        return
      }
      const ds = await es<{ data_streams?: { indices?: { index_name: string }[] }[] }>(connId, 'GET', `/_data_stream/${seg(index)}`).catch(() => null)
      if (ds?.data_streams?.length) {
        kind = 'data stream'
        backing = (ds.data_streams[0].indices ?? []).map((i) => i.index_name)
        return
      }
      kind = 'alias'
      backing = (await listAliases(connId)).filter((a) => a.alias === index).map((a) => a.index)
    } catch {
      /* the Discover pane reports connection errors */
    }
  }

  onMount(() => {
    void loadInfo()
  })

  function setSection(s: string) {
    ;(tab.state as Record<string, unknown>).section = s // the effect below loads it
  }

  $effect(() => {
    // a retarget from the explorer (openEsIndex(…, 'mappings')) loads that section
    const s = section
    if (s === 'mappings' && !mapping && !mappingError) void loadMapping()
    if (s === 'settings' && !settings && !settingsError) void loadSettings()
    if (s === 'stats' && !stats) void loadStats()
    if (s === 'aliases' && !aliasRows) void loadAliases()
    if (s === 'lifecycle' && !ilm) void loadIlm()
  })

  // ---- actions --------------------------------------------------------------------
  let confirm = $state<{ title: string; body: string; action: string; typeToConfirm?: string; danger?: boolean; run: () => Promise<void> } | null>(null)

  async function act(a: IndexAction, label: string) {
    try {
      await indexAction(connId, index, a)
      toasts.success(`${label} ${index}`, 'elasticsearch')
      explorer.bumpEs(connId)
      void loadInfo()
      if (section === 'stats') void loadStats()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  function askDelete() {
    confirm = {
      title: kind === 'data stream' ? `Delete data stream ${index}?` : `Delete index ${index}?`,
      body: kind === 'data stream' ? 'The data stream and every backing index are deleted permanently.' : 'Every document, the mapping and the settings are removed permanently.',
      action: 'Delete',
      typeToConfirm: index,
      run: async () => {
        await es(connId, 'DELETE', kind === 'data stream' ? `/_data_stream/${seg(index)}` : `/${seg(index)}`)
        toasts.success(`Deleted ${index}`, 'elasticsearch')
        explorer.bumpEs(connId)
        tabs.forceClose([tab.id])
      },
    }
  }

  // ---- index operations (reindex / clone / shrink / split / by-query) -------------
  let opDialog = $state<IndexOp | null>(null)
  let discoverKey = $state(0)

  // ---- mappings -------------------------------------------------------------------
  let mapping = $state<{ properties: MappingProps; raw: unknown } | null>(null)
  let mappingError = $state<string | null>(null)
  let mappingView = $state<'fields' | 'json'>('fields')
  let newField = $state({ name: '', type: 'keyword' })
  let mappingBusy = $state(false)

  async function loadMapping() {
    try {
      mapping = await getMapping(connId, index)
      mappingError = null
    } catch (e) {
      mappingError = String((e as Error).message ?? e)
    }
  }

  interface FieldRow {
    path: string
    depth: number
    type: string
    extra: string
  }
  const fieldRows = $derived.by((): FieldRow[] => {
    const out: FieldRow[] = []
    const walk = (props: MappingProps, prefix: string, depth: number) => {
      for (const [k, v] of Object.entries(props).sort(([a], [b]) => a.localeCompare(b))) {
        const path = prefix ? `${prefix}.${k}` : k
        const type = v.type ?? (v.properties ? 'object' : '?')
        const extra = Object.entries(v)
          .filter(([key]) => !['type', 'properties', 'fields'].includes(key))
          .map(([key, val]) => `${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}`)
          .join(' · ')
        out.push({ path, depth, type, extra })
        for (const [fk, fv] of Object.entries(v.fields ?? {})) out.push({ path: `${path}.${fk}`, depth: depth + 1, type: `${fv.type ?? '?'}`, extra: 'multi-field' })
        if (v.properties) walk(v.properties, path, depth + 1)
      }
    }
    if (mapping) walk(mapping.properties, '', 0)
    return out
  })

  async function addField() {
    const n = newField.name.trim()
    if (!n || mappingBusy) return
    mappingBusy = true
    try {
      const parts = n.split('.')
      const def: Record<string, unknown> = newField.type === 'text' ? { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } } : { type: newField.type }
      let node: Record<string, unknown> = def
      for (let i = parts.length - 1; i > 0; i--) node = { properties: { [parts[i]]: node } }
      await putMapping(connId, index, { properties: { [parts[0]]: node } })
      toasts.success(`Added field ${n}`, 'elasticsearch')
      newField = { name: '', type: newField.type }
      await loadMapping()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    } finally {
      mappingBusy = false
    }
  }

  // ---- settings -------------------------------------------------------------------
  let settings = $state<Record<string, string> | null>(null)
  let settingsError = $state<string | null>(null)
  let edit = $state({ replicas: '', refresh: '', maxWindow: '', readOnly: false, lifecycle: '' })
  let settingsBusy = $state(false)
  let advanced = $state(false)
  let advancedText = $state('{\n  "index": {\n    \n  }\n}')
  let settingsFilter = $state('')

  async function loadSettings() {
    try {
      settings = await getSettings(connId, index)
      settingsError = null
      edit = {
        replicas: settings['index.number_of_replicas'] ?? '',
        refresh: settings['index.refresh_interval'] ?? '1s',
        maxWindow: settings['index.max_result_window'] ?? '10000',
        readOnly: settings['index.blocks.write'] === 'true',
        lifecycle: settings['index.lifecycle.name'] ?? '',
      }
    } catch (e) {
      settingsError = String((e as Error).message ?? e)
    }
  }

  async function saveSettings() {
    if (!settings || settingsBusy) return
    const changes: Record<string, unknown> = {}
    if (edit.replicas !== (settings['index.number_of_replicas'] ?? '')) changes.number_of_replicas = Number(edit.replicas)
    if (edit.refresh !== (settings['index.refresh_interval'] ?? '1s')) changes.refresh_interval = edit.refresh
    if (edit.maxWindow !== (settings['index.max_result_window'] ?? '10000')) changes.max_result_window = Number(edit.maxWindow)
    if (edit.readOnly !== (settings['index.blocks.write'] === 'true')) changes['blocks.write'] = edit.readOnly
    if (edit.lifecycle !== (settings['index.lifecycle.name'] ?? '')) changes['lifecycle.name'] = edit.lifecycle || null
    if (!Object.keys(changes).length) {
      toasts.show('No changes to save', { system: 'elasticsearch' })
      return
    }
    settingsBusy = true
    try {
      await putSettings(connId, index, { index: changes })
      toasts.success('Settings saved', 'elasticsearch')
      await loadSettings()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    } finally {
      settingsBusy = false
    }
  }

  async function saveAdvanced() {
    let body: unknown
    try {
      body = JSON.parse(advancedText)
    } catch (e) {
      toasts.error(`Invalid JSON — ${(e as Error).message}`, 'elasticsearch')
      return
    }
    settingsBusy = true
    try {
      await putSettings(connId, index, body)
      toasts.success('Settings saved', 'elasticsearch')
      await loadSettings()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    } finally {
      settingsBusy = false
    }
  }

  // ---- stats ------------------------------------------------------------------------
  let stats = $state<IndexStats | null>(null)
  let statsError = $state<string | null>(null)
  async function loadStats() {
    try {
      stats = await indexStats(connId, index)
      statsError = null
    } catch (e) {
      statsError = String((e as Error).message ?? e)
    }
  }

  // ---- aliases ------------------------------------------------------------------------
  let aliasRows = $state<AliasEntry[] | null>(null)
  let newAlias = $state({ name: '', writeIndex: false, filter: '' })
  async function loadAliases() {
    const all = await listAliases(connId).catch(() => [] as AliasEntry[])
    const targets = kind === 'index' ? [index] : backing
    aliasRows = all.filter((a) => targets.includes(a.index) || a.alias === index)
  }
  async function createAlias() {
    const n = newAlias.name.trim()
    if (!n) return
    let extra: Record<string, unknown> = {}
    if (newAlias.writeIndex) extra.is_write_index = true
    if (newAlias.filter.trim()) {
      try {
        extra = { ...extra, filter: JSON.parse(newAlias.filter) }
      } catch (e) {
        toasts.error(`Filter is not valid JSON — ${(e as Error).message}`, 'elasticsearch')
        return
      }
    }
    try {
      await addAlias(connId, index, n, extra)
      toasts.success(`Alias ${n} added`, 'elasticsearch')
      newAlias = { name: '', writeIndex: false, filter: '' }
      explorer.bumpEs(connId)
      await loadAliases()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }
  async function dropAlias(a: AliasEntry) {
    try {
      await removeAlias(connId, a.index, a.alias)
      toasts.success(`Alias ${a.alias} removed`, 'elasticsearch')
      explorer.bumpEs(connId)
      await loadAliases()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  // ---- lifecycle ----------------------------------------------------------------------
  let ilm = $state<unknown | null>(null)
  let ilmError = $state<string | null>(null)
  async function loadIlm() {
    try {
      ilm = await es(connId, 'GET', `/${seg(index)}/_ilm/explain?human=true`)
      ilmError = null
    } catch (e) {
      ilmError = String((e as Error).message ?? e)
    }
  }

  const SECTIONS = [
    { key: 'discover', label: 'Discover', icon: 'discover' },
    { key: 'mappings', label: 'Mappings', icon: 'mapping' },
    { key: 'settings', label: 'Settings', icon: 'gear' },
    { key: 'stats', label: 'Statistics', icon: 'stats' },
    { key: 'aliases', label: 'Aliases', icon: 'alias' },
    { key: 'lifecycle', label: 'Lifecycle', icon: 'lifecycle' },
  ] as const
</script>

<div class="es-page" data-testid="es-index-view">
  <div class="es-header">
    <span class="es-header-icon"><EsAppIcon name={section === 'discover' ? 'discover' : 'indexManagement'} size={24} /></span>
    <div style="min-width:0">
      <div class="es-title" title={index}>{index}</div>
      <div class="es-sub" style="display:flex;gap:var(--px-8);align-items:center;flex-wrap:wrap">
        {#if info}
          <span class="es-badge {info.status === 'close' ? '' : info.health}" data-testid="es-index-health">
            <span class="es-dot" style="background:{info.status === 'close' ? 'var(--muted)' : healthColor(info.health)}"></span>
            {info.status === 'close' ? 'Closed' : healthLabel(info.health)}
          </span>
          <span>{fmtCount(info.docs_count)} documents</span>
          <span>·</span>
          <span>{formatBytes(info.store_bytes)}</span>
          <span>·</span>
          <span>{info.primaries ?? '?'} primary / {info.replicas ?? '?'} replica</span>
          {#if info.data_stream}<span class="es-badge accent">data stream {info.data_stream}</span>{/if}
        {:else}
          <span class="es-badge accent">{kind}</span>
          {#if backing.length}<span>{backing.length} {backing.length === 1 ? 'index' : 'indices'}: <span class="mono">{backing.slice(0, 3).join(', ')}{backing.length > 3 ? '…' : ''}</span></span>{/if}
        {/if}
      </div>
    </div>
    <div class="es-header-actions">
      <button class="eg-btn" onclick={() => tabs.openEsConsole(connId, true, `GET /${index}/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}\n`)}><EsIcon name="console" size={13} /> Console</button>
      {#if info?.status === 'close'}
        <button class="eg-btn primary" onclick={() => act('open', 'Opened')}>Open index</button>
      {:else}
        <button class="eg-btn" onclick={() => act('refresh', 'Refreshed')} title="Make recent changes searchable">Refresh</button>
        <button class="eg-btn" onclick={() => act('flush', 'Flushed')} title="Commit the translog to disk">Flush</button>
        <button class="eg-btn" onclick={() => act('forcemerge', 'Force merged')} title="Merge segments (max 1)">Force merge</button>
        <button class="eg-btn" onclick={() => act('clear-cache', 'Cleared cache of')}>Clear cache</button>
        {#if kind === 'index'}
          <button class="eg-btn" onclick={() => (confirm = { title: `Close index ${index}?`, body: 'A closed index cannot be searched or written until it is opened again.', action: 'Close index', danger: false, run: () => act('close', 'Closed') })}>Close</button>
        {/if}
      {/if}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="eg-btn" aria-label="Manage index">Manage ▾</DropdownMenu.Trigger>
        <DropdownMenu.Content class="w-56" align="end">
          <DropdownMenu.Item onclick={() => (opDialog = 'reindex')}>Reindex…</DropdownMenu.Item>
          {#if kind === 'index' && info?.status !== 'close'}
            <DropdownMenu.Item onclick={() => (opDialog = 'clone')}>Clone…</DropdownMenu.Item>
            <DropdownMenu.Item onclick={() => (opDialog = 'shrink')}>Shrink…</DropdownMenu.Item>
            <DropdownMenu.Item onclick={() => (opDialog = 'split')}>Split…</DropdownMenu.Item>
          {/if}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onclick={() => (opDialog = 'update-by-query')}>Update by query…</DropdownMenu.Item>
          <DropdownMenu.Item onclick={() => (opDialog = 'delete-by-query')}>Delete by query…</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      {#if kind === 'index' || kind === 'data stream'}
        <button class="eg-btn danger" onclick={askDelete}><EsIcon name="trash" size={13} /> Delete</button>
      {/if}
    </div>
  </div>

  <div class="es-tabs" role="tablist" aria-label="Index sections">
    {#each SECTIONS as s (s.key)}
      <button class="es-tab" class:on={section === s.key} role="tab" aria-selected={section === s.key} onclick={() => setSection(s.key)}><EsIcon name={s.icon} size={14} /> {s.label}</button>
    {/each}
  </div>

  <div style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column">
    <!-- Discover stays mounted (keeps its query / page) while other sections show -->
    <div style="flex:1 1 auto;min-height:0;{section === 'discover' ? '' : 'display:none'}">
      {#key discoverKey}
        <EsDiscover {connId} {index} view={(tab.state as { discover: Record<string, unknown> }).discover} />
      {/key}
    </div>

    {#if section === 'mappings'}
      <div class="es-body">
        {#if mappingError}
          <div class="es-callout danger" role="alert">{mappingError}</div>
        {:else if !mapping}
          <div class="es-empty">Loading mappings…</div>
        {:else}
          <div class="es-card">
            <div class="es-card-h">
              <span class="es-card-title">Fields</span>
              <span class="es-badge">{fieldRows.length}</span>
              <span class="es-seg" style="margin-left:auto">
                <button class:on={mappingView === 'fields'} onclick={() => (mappingView = 'fields')}>Fields</button>
                <button class:on={mappingView === 'json'} onclick={() => (mappingView = 'json')}>JSON</button>
              </span>
            </div>
            {#if mappingView === 'fields'}
              {#if kind === 'index' || kind === 'pattern'}
                <div class="es-card-b es-toolbar" style="border-bottom:var(--px-1) solid var(--border)">
                  <input class="es-input mono" style="width:var(--px-240)" bind:value={newField.name} placeholder="new.field.name" aria-label="New field name" onkeydown={(e) => e.key === 'Enter' && addField()} />
                  <select class="es-input" bind:value={newField.type} aria-label="New field type">
                    {#each FIELD_TYPES as t (t)}<option value={t}>{t}</option>{/each}
                  </select>
                  <button class="eg-btn primary" onclick={addField} disabled={!newField.name.trim() || mappingBusy}><EsIcon name="plus" size={13} /> Add field</button>
                  <span class="es-help" style="margin:0">Existing field types cannot be changed — reindex into a new index for that.</span>
                </div>
              {/if}
              <table class="es-table" data-testid="es-mapping-table">
                <thead><tr><th>Field</th><th>Type</th><th>Parameters</th></tr></thead>
                <tbody>
                  {#each fieldRows as r (r.path)}
                    <tr>
                      <td class="mono" style="padding-left:calc(var(--px-12) + {r.depth} * var(--px-18))">{r.path.split('.').pop()}<span style="color:var(--muted)">{r.depth ? `  (${r.path})` : ''}</span></td>
                      <td><span style="display:inline-flex;gap:var(--px-6);align-items:center"><EsFieldToken type={r.type} />{r.type}</span></td>
                      <td class="mono" style="color:var(--text2);font-size:var(--px-11_5)">{r.extra}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:else}
              <div class="es-card-b"><CodeView value={JSON.stringify(mapping.raw, null, 2)} language={DS_JSON} readOnly height="auto" minHeight={200} maxHeight={900} ariaLabel="Mappings" /></div>
            {/if}
          </div>
        {/if}
      </div>
    {:else if section === 'settings'}
      <div class="es-body">
        {#if settingsError}
          <div class="es-callout danger" role="alert">{settingsError}</div>
        {:else if !settings}
          <div class="es-empty">Loading settings…</div>
        {:else}
          <div class="es-card">
            <div class="es-card-h"><span class="es-card-title">Dynamic settings</span><span class="es-help" style="margin:0">Applied immediately to the live index.</span></div>
            <div class="es-card-b" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--px-220),1fr));gap:var(--px-14)">
              <div><label class="es-label" for="es-set-replicas">Replicas</label><input id="es-set-replicas" class="es-input" type="number" min="0" style="width:100%" bind:value={edit.replicas} /></div>
              <div><label class="es-label" for="es-set-refresh">Refresh interval</label><input id="es-set-refresh" class="es-input mono" style="width:100%" bind:value={edit.refresh} placeholder="1s or -1" /></div>
              <div><label class="es-label" for="es-set-window">Max result window</label><input id="es-set-window" class="es-input" type="number" min="1" style="width:100%" bind:value={edit.maxWindow} /></div>
              <div><label class="es-label" for="es-set-ilm">Lifecycle policy</label><input id="es-set-ilm" class="es-input mono" style="width:100%" bind:value={edit.lifecycle} placeholder="(none)" /></div>
              <label class="es-label" style="display:flex;align-items:center;gap:var(--px-8);margin-top:var(--px-20)"><input type="checkbox" bind:checked={edit.readOnly} /> Block writes (read-only)</label>
            </div>
            <div class="es-modal-f" style="justify-content:flex-start">
              <button class="eg-btn primary" onclick={saveSettings} disabled={settingsBusy} aria-busy={settingsBusy}>Save settings</button>
              <button class="eg-btn" onclick={() => (advanced = !advanced)}>{advanced ? 'Hide' : 'Edit as JSON…'}</button>
            </div>
            {#if advanced}
              <div class="es-card-b" style="border-top:var(--px-1) solid var(--border)">
                <span class="es-label">PUT /{index}/_settings</span>
                <CodeView value={advancedText} language={DS_JSON} height="auto" minHeight={120} maxHeight={320} onChange={(t) => (advancedText = t)} onSubmit={saveAdvanced} ariaLabel="Settings JSON" />
                <button class="eg-btn primary" style="margin-top:var(--px-8)" onclick={saveAdvanced} disabled={settingsBusy}>Apply JSON</button>
              </div>
            {/if}
          </div>
          <div class="es-card">
            <div class="es-card-h">
              <span class="es-card-title">All settings</span>
              <input class="es-input" style="margin-left:auto;width:var(--px-220)" bind:value={settingsFilter} placeholder="Filter settings" aria-label="Filter settings" />
            </div>
            <table class="es-table" data-testid="es-settings-table">
              <tbody>
                {#each Object.entries(settings).filter(([k]) => !settingsFilter || k.includes(settingsFilter)).sort(([a], [b]) => a.localeCompare(b)) as [k, v] (k)}
                  <tr><td class="mono" style="color:var(--text2)">{k}</td><td class="mono">{v}</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {:else if section === 'stats'}
      <div class="es-body">
        {#if statsError}
          <div class="es-callout danger" role="alert">{statsError}</div>
        {:else if !stats}
          <div class="es-empty">Loading statistics…</div>
        {:else}
          <div class="es-stats" data-testid="es-index-stats">
            <div class="es-stat"><div class="es-stat-label">Documents</div><div class="es-stat-value">{fmtCount(stats.docs)}</div><div class="es-stat-hint">{fmtCount(stats.deleted)} deleted</div></div>
            <div class="es-stat"><div class="es-stat-label">Storage</div><div class="es-stat-value">{formatBytes(stats.storeBytes)}</div><div class="es-stat-hint">incl. replicas</div></div>
            <div class="es-stat"><div class="es-stat-label">Segments</div><div class="es-stat-value">{fmtCount(stats.segments)}</div></div>
            <div class="es-stat"><div class="es-stat-label">Indexing ops</div><div class="es-stat-value">{fmtCount(stats.indexTotal)}</div><div class="es-stat-hint">{fmtCount(stats.indexTimeMs)} ms total</div></div>
            <div class="es-stat"><div class="es-stat-label">Search queries</div><div class="es-stat-value">{fmtCount(stats.searchTotal)}</div><div class="es-stat-hint">{fmtCount(stats.searchTimeMs)} ms total</div></div>
            <div class="es-stat"><div class="es-stat-label">Get requests</div><div class="es-stat-value">{fmtCount(stats.getTotal)}</div></div>
            <div class="es-stat"><div class="es-stat-label">Refreshes</div><div class="es-stat-value">{fmtCount(stats.refreshTotal)}</div></div>
            <div class="es-stat"><div class="es-stat-label">Flushes</div><div class="es-stat-value">{fmtCount(stats.flushTotal)}</div></div>
            <div class="es-stat"><div class="es-stat-label">Merges</div><div class="es-stat-value">{fmtCount(stats.mergesTotal)}</div></div>
          </div>
          <button class="eg-btn" style="margin-top:var(--px-14)" onclick={loadStats}><EsIcon name="refresh" size={13} /> Reload statistics</button>
        {/if}
      </div>
    {:else if section === 'aliases'}
      <div class="es-body">
        <div class="es-card">
          <div class="es-card-h"><span class="es-card-title">Aliases</span><span class="es-badge">{aliasRows?.length ?? 0}</span></div>
          {#if kind === 'index'}
            <div class="es-card-b es-toolbar" style="border-bottom:var(--px-1) solid var(--border)">
              <input class="es-input mono" style="width:var(--px-200)" bind:value={newAlias.name} placeholder="alias-name" aria-label="Alias name" />
              <label style="display:inline-flex;gap:var(--px-6);align-items:center;font-size:var(--px-12_5)"><input type="checkbox" bind:checked={newAlias.writeIndex} /> Write index</label>
              <input class="es-input mono" style="flex:1 1 var(--px-200)" bind:value={newAlias.filter} placeholder={'Filter (optional JSON) {"term":{"status":"paid"}}'} aria-label="Alias filter" />
              <button class="eg-btn primary" onclick={createAlias} disabled={!newAlias.name.trim()}><EsIcon name="plus" size={13} /> Add alias</button>
            </div>
          {/if}
          {#if aliasRows && aliasRows.length}
            <table class="es-table">
              <thead><tr><th>Alias</th><th>Index</th><th>Write index</th><th>Filter</th><th></th></tr></thead>
              <tbody>
                {#each aliasRows as a (a.alias + a.index)}
                  <tr>
                    <td class="mono"><span class="es-link" role="button" tabindex="0" onclick={() => tabs.openEsIndex(connId, a.alias)} onkeydown={(e) => e.key === 'Enter' && tabs.openEsIndex(connId, a.alias)}>{a.alias}</span></td>
                    <td class="mono">{a.index}</td>
                    <td>{a.is_write_index ? 'yes' : '—'}</td>
                    <td class="mono" style="font-size:var(--px-11_5);color:var(--text2)">{a.filter ? JSON.stringify(a.filter) : '—'}</td>
                    <td style="text-align:right"><button class="eg-btn danger" onclick={() => dropAlias(a)} aria-label="Remove alias {a.alias}">Remove</button></td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <div class="es-empty">No aliases point at this {kind}.</div>
          {/if}
        </div>
      </div>
    {:else if section === 'lifecycle'}
      <div class="es-body">
        {#if ilmError}
          <div class="es-callout warn" role="alert">{ilmError}</div>
        {:else if !ilm}
          <div class="es-empty">Loading lifecycle state…</div>
        {:else}
          <div class="es-card">
            <div class="es-card-h">
              <span class="es-card-title">Index lifecycle</span>
              <button class="eg-btn" style="margin-left:auto" onclick={() => tabs.openEsManage(connId, 'ilm', 'Index lifecycle policies')}>Manage policies</button>
            </div>
            <div class="es-card-b">
              {#each Object.values((ilm as { indices?: Record<string, Record<string, unknown>> }).indices ?? {}) as e (String(e.index))}
                <dl class="es-kv" style="margin:0 0 var(--px-12)">
                  <dt>Index</dt><dd class="mono">{e.index}</dd>
                  <dt>Managed</dt><dd>{e.managed ? 'yes' : 'no — attach a policy in Settings'}</dd>
                  {#if e.managed}
                    <dt>Policy</dt><dd class="mono">{e.policy}</dd>
                    <dt>Phase / action / step</dt><dd class="mono">{e.phase} › {e.action} › {e.step}</dd>
                  {/if}
                </dl>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

{#if opDialog}
  {@const op = opDialog}
  <EsIndexOpsDialog
    {connId}
    {index}
    {op}
    shards={info?.primaries ?? null}
    replicas={info?.replicas ?? null}
    onClose={() => (opDialog = null)}
    onDone={(msg, target) => {
      opDialog = null
      toasts.success(msg, 'elasticsearch')
      explorer.bumpEs(connId)
      void loadInfo()
      discoverKey++ // documents changed: search again
      if (target) tabs.openEsIndex(connId, target)
    }}
  />
{/if}

{#if confirm}
  <EsConfirmDialog title={confirm.title} body={confirm.body} action={confirm.action} typeToConfirm={confirm.typeToConfirm} danger={confirm.danger ?? true} run={confirm.run} onClose={() => (confirm = null)} />
{/if}
