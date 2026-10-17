<script lang="ts">
  // Elasticsearch browser in the ObjectExplorer sidebar (Kibana-style navigation):
  // cluster health header, quick actions, then Indices · Data streams · Aliases,
  // Stack Management resources, Cluster pages, Security and Dev tools. Clicking an
  // index / stream / alias opens Discover on it; management rows open their page.
  import { untrack } from 'svelte'
  import '$lib/elastic/es.css'
  import * as ipc from '$lib/ipc'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import Chevron from '$lib/components/Chevron.svelte'
  import EsIcon, { type EsIconName } from '$lib/components/elastic/EsIcon.svelte'
  import EsCreateIndexDialog from '$lib/components/elastic/EsCreateIndexDialog.svelte'
  import EsConfirmDialog from '$lib/components/elastic/EsConfirmDialog.svelte'
  import { armCollapse, treeOut } from '$lib/ui/tree-motion'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { es, aliases as listAliases, indexAction, type AliasEntry, type IndexAction, seg } from '$lib/elastic/api'
  import { fmtCompact, formatBytes, healthColor, healthLabel } from '$lib/elastic/format'
  import { RESOURCE_KINDS } from '$lib/elastic/resources'

  interface Props {
    connId: string
    refreshKey?: number
    onReloaded?: () => void
  }
  let { connId, refreshKey = 0, onReloaded }: Props = $props()

  let overview = $state<ipc.EsOverview | null>(null)
  let indices = $state<ipc.EsIndex[]>([])
  let streams = $state<{ name: string; status: string; indices: number }[]>([])
  let aliasList = $state<AliasEntry[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)
  let indicesError = $state<string | null>(null)
  let filter = $state('')
  let showHidden = $state(false)
  let open = $state<Record<string, boolean>>({ indices: true, streams: true, aliases: false, manage: true, cluster: false, security: false, tools: true })

  const f = $derived(filter.trim().toLowerCase())
  const visibleIndices = $derived(
    indices.filter((i) => (showHidden || (!i.hidden && !i.data_stream)) && (!f || i.name.toLowerCase().includes(f))),
  )
  const hiddenCount = $derived(indices.filter((i) => i.hidden || i.data_stream).length)
  const visibleStreams = $derived(streams.filter((s) => !f || s.name.toLowerCase().includes(f)))
  const aliasNames = $derived([...new Set(aliasList.map((a) => a.alias))].filter((a) => (showHidden || !a.startsWith('.')) && (!f || a.toLowerCase().includes(f))))

  const active = $derived.by(() => {
    const t = tabs.active
    if (!t || t.connectionId !== connId) return null
    const s = t.state as { index?: string; kind?: string; section?: string }
    if (t.contentType === 'es-index') return `i:${s.index}`
    if (t.contentType === 'es-manage') return `m:${s.kind}`
    if (t.contentType === 'es-cluster') return `c:${s.section}`
    if (t.contentType === 'es-console') return 'tool:console'
    if (t.contentType === 'es-devtools') return `dt:${(t.state as { tool?: string }).tool ?? 'profiler'}`
    return null
  })

  let gen = 0
  async function load() {
    const mine = ++gen
    loading = true
    error = null
    try {
      const [ov, ix, ds, al] = await Promise.allSettled([
        ipc.esOverview(connId),
        ipc.esIndices(connId),
        es<{ data_streams?: { name: string; status?: string; indices?: unknown[] }[] }>(connId, 'GET', '/_data_stream'),
        listAliases(connId),
      ])
      if (mine !== gen) return
      overview = ov.status === 'fulfilled' ? ov.value : null
      if (ov.status === 'rejected') error = String(ov.reason)
      indices = ix.status === 'fulfilled' ? ix.value : []
      indicesError = ix.status === 'rejected' ? String(ix.reason) : null
      streams =
        ds.status === 'fulfilled'
          ? (ds.value.data_streams ?? []).map((d) => ({ name: d.name, status: String(d.status ?? ''), indices: (d.indices ?? []).length }))
          : []
      aliasList = al.status === 'fulfilled' ? al.value : []
    } catch (e) {
      if (mine === gen) error = String(e)
    } finally {
      if (mine === gen) {
        loading = false
        onReloaded?.()
      }
    }
  }

  let seen = { key: 0, tick: 0 }
  $effect(() => {
    void connId
    untrack(() => {
      seen = { key: refreshKey, tick: explorer.esTick[connId] ?? 0 }
      overview = null
      indices = []
      streams = []
      aliasList = []
      void load()
    })
  })
  $effect(() => {
    const key = refreshKey
    const tick = explorer.esTick[connId] ?? 0
    untrack(() => {
      if (key === seen.key && tick === seen.tick) return
      seen = { key, tick }
      void load()
    })
  })

  function toggle(k: string) {
    if (open[k]) armCollapse()
    open[k] = !open[k]
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Copied', 'elasticsearch')
  }

  // ---- index actions ----------------------------------------------------------
  async function runAction(name: string, a: IndexAction, label: string) {
    try {
      await indexAction(connId, name, a)
      toasts.success(`${label}: ${name}`, 'elasticsearch')
      explorer.bumpEs(connId)
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  let confirm = $state<{ title: string; body: string; action: string; typeToConfirm?: string; run: () => Promise<void> } | null>(null)

  function deleteIndex(name: string) {
    confirm = {
      title: `Delete index ${name}?`,
      body: `Every document, the mapping and the settings of "${name}" are removed permanently. Snapshots are not affected.`,
      action: 'Delete index',
      typeToConfirm: name,
      run: async () => {
        await es(connId, 'DELETE', `/${seg(name)}`)
        toasts.success(`Deleted index ${name}`, 'elasticsearch')
        explorer.bumpEs(connId)
      },
    }
  }

  function closeIndex(name: string) {
    confirm = {
      title: `Close index ${name}?`,
      body: 'A closed index keeps its data on disk but cannot be searched or written until it is opened again.',
      action: 'Close index',
      run: async () => runAction(name, 'close', 'Closed'),
    }
  }

  function deleteStream(name: string) {
    confirm = {
      title: `Delete data stream ${name}?`,
      body: 'The data stream and ALL of its backing indices are deleted.',
      action: 'Delete data stream',
      typeToConfirm: name,
      run: async () => {
        await es(connId, 'DELETE', `/_data_stream/${seg(name)}`)
        toasts.success(`Deleted data stream ${name}`, 'elasticsearch')
        explorer.bumpEs(connId)
      },
    }
  }

  async function rollover(name: string) {
    try {
      const r = await es<{ new_index: string }>(connId, 'POST', `/${seg(name)}/_rollover`)
      toasts.success(`Rolled over to ${r.new_index}`, 'elasticsearch')
      explorer.bumpEs(connId)
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  function removeAlias(alias: string) {
    const targets = aliasList.filter((a) => a.alias === alias).map((a) => a.index)
    confirm = {
      title: `Remove alias ${alias}?`,
      body: `The alias is removed from ${targets.join(', ')}. The indices and their documents stay.`,
      action: 'Remove alias',
      run: async () => {
        await es(connId, 'POST', '/_aliases', { actions: targets.map((index) => ({ remove: { index, alias } })) })
        toasts.success(`Removed alias ${alias}`, 'elasticsearch')
        explorer.bumpEs(connId)
      },
    }
  }

  let createOpen = $state(false)

  const kindIcon: Record<string, EsIconName> = {
    'index-templates': 'template',
    'component-templates': 'component',
    pipelines: 'pipeline',
    ilm: 'lifecycle',
    'data-streams': 'stream',
    'snapshot-repos': 'snapshot',
    slm: 'history',
    scripts: 'script',
    enrich: 'enrich',
    transforms: 'transform',
    watches: 'watch',
  }

  const CLUSTER_PAGES = [
    { key: 'overview', label: 'Overview', icon: 'cluster' },
    { key: 'nodes', label: 'Nodes', icon: 'node' },
    { key: 'shards', label: 'Shards & allocation', icon: 'shard' },
    { key: 'tasks', label: 'Tasks', icon: 'task' },
    { key: 'settings', label: 'Cluster settings', icon: 'gear' },
  ] as const
</script>

<div class="esx" data-testid="es-explorer">
  <!-- cluster header -->
  <div class="esx-head">
    <div class="esx-cluster">
      <span class="es-dot" style="background:{healthColor(overview?.status)}" aria-hidden="true"></span>
      <span class="esx-cname es-ellipsis" title={overview?.info.cluster_uuid ?? ''}>{overview?.info.cluster_name || (loading ? 'Connecting…' : 'Cluster')}</span>
      {#if overview?.status}
        <span class="es-badge {overview.status}" data-testid="es-health">{healthLabel(overview.status)}</span>
      {/if}
    </div>
    <div class="esx-meta" data-testid="es-summary">
      {#if loading && !overview}
        <span class="es-spin" aria-hidden="true"><EsIcon name="refresh" size={12} /></span> Loading cluster…
      {:else if overview}
        {overview.info.distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'}
        {overview.info.version || ''}{#if overview.docs != null} · {fmtCompact(overview.docs)} docs{/if}{#if overview.store_bytes != null} · {formatBytes(overview.store_bytes)}{/if}
      {/if}
    </div>
    <div class="esx-actions">
      <button class="esx-act primary" onclick={() => (createOpen = true)} title="Create a new index"><EsIcon name="plus" size={13} /> Index</button>
      <button class="esx-act" onclick={() => tabs.openEsConsole(connId)} title="Dev Tools console"><EsIcon name="console" size={13} /> Console</button>
      <button class="esx-act" onclick={() => tabs.openEsQuery(connId, 'esql')} title="ES|QL / SQL query"><EsIcon name="sql" size={13} /> Query</button>
    </div>
    <div class="esx-filter">
      <EsIcon name="search" size={13} />
      <input bind:value={filter} placeholder="Filter indices, streams, aliases…" aria-label="Filter indices" spellcheck="false" />
      <label class="esx-hidden" title="Include system/hidden indices and data stream backing indices">
        <input type="checkbox" bind:checked={showHidden} /> Hidden{hiddenCount ? ` (${hiddenCount})` : ''}
      </label>
    </div>
  </div>

  {#if error}
    <div class="es-callout danger" role="alert" style="margin:var(--px-8)">{error}</div>
  {/if}
  {#if overview?.warning}
    <div class="es-callout warn" role="note" style="margin:var(--px-8);font-size:var(--px-11_5)">Limited privileges: {overview.warning}</div>
  {/if}

  <div class="esx-tree" aria-busy={loading} role="tree" aria-label="Elasticsearch">
    <!-- Indices -->
    <div class="esx-row head" role="treeitem" aria-selected="false" aria-expanded={open.indices} tabindex="0" onclick={() => toggle('indices')} onkeydown={(e) => e.key === 'Enter' && toggle('indices')}>
      <span class="esx-chev"><Chevron open={open.indices} size={12} /></span>
      <EsIcon name="index" size={14} />
      <span class="esx-label">Indices</span>
      <span class="esx-count">{visibleIndices.length}</span>
    </div>
    {#if open.indices}
      {#if indicesError}
        <div class="esx-empty" role="alert" style="color:var(--es-red)">{indicesError}</div>
      {:else if !visibleIndices.length && !loading}
        <div class="esx-empty">{f ? 'No index matches the filter' : 'No indices yet — create one with ＋ Index'}</div>
      {/if}
      {#each visibleIndices as ix (ix.name)}
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            <div
              out:treeOut|global
              class="esx-row leaf"
              class:sel={active === `i:${ix.name}`}
              role="treeitem"
              aria-selected={active === `i:${ix.name}`}
              tabindex="0"
              title="{ix.name} · {ix.status === 'close' ? 'closed' : healthLabel(ix.health)} · {ix.primaries ?? '?'} primary / {ix.replicas ?? '?'} replica"
              onclick={() => tabs.openEsIndex(connId, ix.name)}
              onkeydown={(e) => e.key === 'Enter' && tabs.openEsIndex(connId, ix.name)}
            >
              <span class="es-dot" style="background:{ix.status === 'close' ? 'var(--border2)' : healthColor(ix.health)}" aria-hidden="true"></span>
              <span class="esx-name es-ellipsis" style={ix.hidden ? 'color:var(--text2)' : ''}>{ix.name}</span>
              {#if ix.status === 'close'}
                <span class="es-badge" title="Closed index">closed</span>
              {:else}
                <span class="esx-meta-r">{fmtCompact(ix.docs_count)} · {formatBytes(ix.store_bytes)}</span>
              {/if}
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Content class="w-56">
            <ContextMenu.Item onclick={() => tabs.openEsIndex(connId, ix.name, 'discover')}>Discover documents</ContextMenu.Item>
            <ContextMenu.Item onclick={() => tabs.openEsIndex(connId, ix.name, 'mappings')}>Mappings</ContextMenu.Item>
            <ContextMenu.Item onclick={() => tabs.openEsIndex(connId, ix.name, 'settings')}>Settings</ContextMenu.Item>
            <ContextMenu.Item onclick={() => tabs.openEsIndex(connId, ix.name, 'stats')}>Statistics</ContextMenu.Item>
            <ContextMenu.Item onclick={() => tabs.openEsConsole(connId, true, `GET /${ix.name}/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}\n`)}>Query in console</ContextMenu.Item>
            <ContextMenu.Separator />
            {#if ix.status === 'close'}
              <ContextMenu.Item onclick={() => runAction(ix.name, 'open', 'Opened')}>Open index</ContextMenu.Item>
            {:else}
              <ContextMenu.Item onclick={() => runAction(ix.name, 'refresh', 'Refreshed')}>Refresh</ContextMenu.Item>
              <ContextMenu.Item onclick={() => runAction(ix.name, 'flush', 'Flushed')}>Flush</ContextMenu.Item>
              <ContextMenu.Item onclick={() => runAction(ix.name, 'forcemerge', 'Force merged')}>Force merge</ContextMenu.Item>
              <ContextMenu.Item onclick={() => runAction(ix.name, 'clear-cache', 'Cache cleared')}>Clear cache</ContextMenu.Item>
              <ContextMenu.Item onclick={() => closeIndex(ix.name)}>Close index…</ContextMenu.Item>
            {/if}
            <ContextMenu.Separator />
            <ContextMenu.Item onclick={() => copy(ix.name)}>Copy name</ContextMenu.Item>
            <ContextMenu.Item variant="destructive" onclick={() => deleteIndex(ix.name)}>Delete index…</ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
      {/each}
    {/if}

    <!-- Data streams -->
    <div class="esx-row head" role="treeitem" aria-selected="false" aria-expanded={open.streams} tabindex="0" onclick={() => toggle('streams')} onkeydown={(e) => e.key === 'Enter' && toggle('streams')}>
      <span class="esx-chev"><Chevron open={open.streams} size={12} /></span>
      <EsIcon name="stream" size={14} />
      <span class="esx-label">Data streams</span>
      <span class="esx-count">{visibleStreams.length}</span>
    </div>
    {#if open.streams}
      {#if !visibleStreams.length && !loading}
        <div class="esx-empty">No data streams</div>
      {/if}
      {#each visibleStreams as ds (ds.name)}
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            <div out:treeOut|global class="esx-row leaf" class:sel={active === `i:${ds.name}`} role="treeitem" aria-selected={active === `i:${ds.name}`} tabindex="0" title="{ds.name} · {ds.indices} backing indices" onclick={() => tabs.openEsIndex(connId, ds.name)} onkeydown={(e) => e.key === 'Enter' && tabs.openEsIndex(connId, ds.name)}>
              <span class="es-dot" style="background:{healthColor(ds.status)}" aria-hidden="true"></span>
              <span class="esx-name es-ellipsis">{ds.name}</span>
              <span class="esx-meta-r">{ds.indices} idx</span>
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Content class="w-56">
            <ContextMenu.Item onclick={() => tabs.openEsIndex(connId, ds.name)}>Discover documents</ContextMenu.Item>
            <ContextMenu.Item onclick={() => tabs.openEsManage(connId, 'data-streams', 'Data streams', ds.name)}>Manage data stream</ContextMenu.Item>
            <ContextMenu.Item onclick={() => rollover(ds.name)}>Roll over</ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onclick={() => copy(ds.name)}>Copy name</ContextMenu.Item>
            <ContextMenu.Item variant="destructive" onclick={() => deleteStream(ds.name)}>Delete data stream…</ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
      {/each}
    {/if}

    <!-- Aliases -->
    <div class="esx-row head" role="treeitem" aria-selected="false" aria-expanded={open.aliases} tabindex="0" onclick={() => toggle('aliases')} onkeydown={(e) => e.key === 'Enter' && toggle('aliases')}>
      <span class="esx-chev"><Chevron open={open.aliases} size={12} /></span>
      <EsIcon name="alias" size={14} />
      <span class="esx-label">Aliases</span>
      <span class="esx-count">{aliasNames.length}</span>
    </div>
    {#if open.aliases}
      {#if !aliasNames.length && !loading}
        <div class="esx-empty">No aliases</div>
      {/if}
      {#each aliasNames as a (a)}
        {@const targets = aliasList.filter((x) => x.alias === a)}
        <ContextMenu.Root>
          <ContextMenu.Trigger>
            <div out:treeOut|global class="esx-row leaf" class:sel={active === `i:${a}`} role="treeitem" aria-selected={active === `i:${a}`} tabindex="0" title="{a} → {targets.map((t) => t.index).join(', ')}" onclick={() => tabs.openEsIndex(connId, a)} onkeydown={(e) => e.key === 'Enter' && tabs.openEsIndex(connId, a)}>
              <EsIcon name="alias" size={12} />
              <span class="esx-name es-ellipsis">{a}</span>
              <span class="esx-meta-r">→ {targets.length === 1 ? targets[0].index : `${targets.length} indices`}</span>
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Content class="w-56">
            <ContextMenu.Item onclick={() => tabs.openEsIndex(connId, a)}>Discover documents</ContextMenu.Item>
            <ContextMenu.Item onclick={() => copy(a)}>Copy name</ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item variant="destructive" onclick={() => removeAlias(a)}>Remove alias…</ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
      {/each}
    {/if}

    <!-- Stack Management -->
    <div class="esx-row head" role="treeitem" aria-selected="false" aria-expanded={open.manage} tabindex="0" onclick={() => toggle('manage')} onkeydown={(e) => e.key === 'Enter' && toggle('manage')}>
      <span class="esx-chev"><Chevron open={open.manage} size={12} /></span>
      <EsIcon name="wrench" size={14} />
      <span class="esx-label">Stack Management</span>
    </div>
    {#if open.manage}
      {#each RESOURCE_KINDS as k (k.key)}
        <div out:treeOut|global class="esx-row leaf" class:sel={active === `m:${k.key}`} role="treeitem" aria-selected={active === `m:${k.key}`} tabindex="0" title={k.blurb} onclick={() => tabs.openEsManage(connId, k.key, k.label)} onkeydown={(e) => e.key === 'Enter' && tabs.openEsManage(connId, k.key, k.label)}>
          <span class="esx-ic"><EsIcon name={kindIcon[k.key] ?? 'gear'} size={13} /></span>
          <span class="esx-name es-ellipsis">{k.label}</span>
        </div>
      {/each}
    {/if}

    <!-- Cluster -->
    <div class="esx-row head" role="treeitem" aria-selected="false" aria-expanded={open.cluster} tabindex="0" onclick={() => toggle('cluster')} onkeydown={(e) => e.key === 'Enter' && toggle('cluster')}>
      <span class="esx-chev"><Chevron open={open.cluster} size={12} /></span>
      <EsIcon name="cluster" size={14} />
      <span class="esx-label">Cluster</span>
    </div>
    {#if open.cluster}
      {#each CLUSTER_PAGES as p (p.key)}
        <div out:treeOut|global class="esx-row leaf" class:sel={active === `c:${p.key}`} role="treeitem" aria-selected={active === `c:${p.key}`} tabindex="0" onclick={() => tabs.openEsCluster(connId, p.key)} onkeydown={(e) => e.key === 'Enter' && tabs.openEsCluster(connId, p.key)}>
          <span class="esx-ic"><EsIcon name={p.icon} size={13} /></span>
          <span class="esx-name es-ellipsis">{p.label}</span>
        </div>
      {/each}
    {/if}

    <!-- Security -->
    <div class="esx-row head" role="treeitem" aria-selected="false" aria-expanded={open.security} tabindex="0" onclick={() => toggle('security')} onkeydown={(e) => e.key === 'Enter' && toggle('security')}>
      <span class="esx-chev"><Chevron open={open.security} size={12} /></span>
      <EsIcon name="shield" size={14} />
      <span class="esx-label">Security</span>
    </div>
    {#if open.security}
      {#each [{ s: 'users', l: 'Users', i: 'user' }, { s: 'roles', l: 'Roles', i: 'shield' }, { s: 'apikeys', l: 'API keys', i: 'key' }, { s: 'mappings', l: 'Role mappings', i: 'alias' }] as r (r.s)}
        <div out:treeOut|global class="esx-row leaf" role="treeitem" aria-selected="false" tabindex="0" onclick={() => tabs.openUserManager(connId, `section:${r.s}`)} onkeydown={(e) => e.key === 'Enter' && tabs.openUserManager(connId, `section:${r.s}`)}>
          <span class="esx-ic"><EsIcon name={r.i as EsIconName} size={13} /></span>
          <span class="esx-name es-ellipsis">{r.l}</span>
        </div>
      {/each}
    {/if}

    <!-- Tools -->
    <div class="esx-row head" role="treeitem" aria-selected="false" aria-expanded={open.tools} tabindex="0" onclick={() => toggle('tools')} onkeydown={(e) => e.key === 'Enter' && toggle('tools')}>
      <span class="esx-chev"><Chevron open={open.tools} size={12} /></span>
      <EsIcon name="wrench" size={14} />
      <span class="esx-label">Dev tools</span>
    </div>
    {#if open.tools}
      <div out:treeOut|global class="esx-row leaf" class:sel={active === 'tool:console'} role="treeitem" aria-selected={active === 'tool:console'} tabindex="0" onclick={() => tabs.openEsConsole(connId)} onkeydown={(e) => e.key === 'Enter' && tabs.openEsConsole(connId)}>
        <span class="esx-ic"><EsIcon name="console" size={13} /></span><span class="esx-name">Console</span>
      </div>
      <div out:treeOut|global class="esx-row leaf" role="treeitem" aria-selected="false" tabindex="0" onclick={() => tabs.openEsQuery(connId, 'esql')} onkeydown={(e) => e.key === 'Enter' && tabs.openEsQuery(connId, 'esql')}>
        <span class="esx-ic"><EsIcon name="sql" size={13} /></span><span class="esx-name">ES|QL query</span>
      </div>
      <div out:treeOut|global class="esx-row leaf" role="treeitem" aria-selected="false" tabindex="0" onclick={() => tabs.openEsQuery(connId, 'sql')} onkeydown={(e) => e.key === 'Enter' && tabs.openEsQuery(connId, 'sql')}>
        <span class="esx-ic"><EsIcon name="sql" size={13} /></span><span class="esx-name">SQL query</span>
      </div>
      {#each [{ t: 'profiler', l: 'Search Profiler', i: 'inspect' }, { t: 'grok', l: 'Grok Debugger', i: 'pipeline' }, { t: 'painless', l: 'Painless Lab', i: 'script' }, { t: 'analyzer', l: 'Analyzer', i: 'search' }] as d (d.t)}
        <div out:treeOut|global class="esx-row leaf" class:sel={active === `dt:${d.t}`} role="treeitem" aria-selected={active === `dt:${d.t}`} tabindex="0" onclick={() => tabs.openEsDevTools(connId, d.t as 'profiler')} onkeydown={(e) => e.key === 'Enter' && tabs.openEsDevTools(connId, d.t as 'profiler')}>
          <span class="esx-ic"><EsIcon name={d.i as EsIconName} size={13} /></span><span class="esx-name">{d.l}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>

{#if createOpen}
  <EsCreateIndexDialog
    {connId}
    existing={indices.map((i) => i.name)}
    onClose={() => (createOpen = false)}
    onCreated={(name) => {
      createOpen = false
      explorer.bumpEs(connId)
      tabs.openEsIndex(connId, name)
    }}
  />
{/if}

{#if confirm}
  <EsConfirmDialog
    title={confirm.title}
    body={confirm.body}
    action={confirm.action}
    typeToConfirm={confirm.typeToConfirm}
    run={confirm.run}
    onClose={() => (confirm = null)}
  />
{/if}

<style>
  .esx {
    display: flex;
    flex-direction: column;
    min-height: 0;
    font-family: var(--font-main);
  }
  .esx-head {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--sidebar);
    padding: var(--px-10) var(--px-10) var(--px-8);
    border-bottom: var(--px-1) solid var(--border);
    display: flex;
    flex-direction: column;
    gap: var(--px-6);
  }
  .esx-cluster {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    min-width: 0;
  }
  .esx-cname {
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
    flex: 1 1 auto;
  }
  .esx-meta {
    font-size: var(--px-11_5);
    color: var(--text2);
    display: flex;
    align-items: center;
    gap: var(--px-4);
    font-variant-numeric: tabular-nums;
  }
  .esx-actions {
    display: flex;
    gap: var(--px-6);
    flex-wrap: wrap;
  }
  .esx-act {
    appearance: none;
    font: inherit;
    font-size: var(--px-11_5);
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    padding: var(--px-4) var(--px-9);
    border-radius: var(--px-7);
    border: var(--px-1) solid var(--border2);
    background: var(--raised);
    color: var(--text);
    cursor: pointer;
  }
  .esx-act:hover {
    border-color: var(--es-accent);
    color: var(--es-accent);
  }
  .esx-act.primary {
    background: var(--es-accent);
    border-color: var(--es-accent);
    color: var(--surface);
  }
  .esx-act.primary:hover {
    filter: brightness(1.07);
    color: var(--surface);
  }
  .esx-filter {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-7);
    padding: var(--px-4) var(--px-8);
    color: var(--muted);
  }
  .esx-filter input:not([type='checkbox']) {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    font: inherit;
    font-size: var(--px-12);
    color: var(--text);
  }
  .esx-hidden {
    display: inline-flex;
    align-items: center;
    gap: var(--px-3);
    font-size: var(--px-11);
    color: var(--text2);
    white-space: nowrap;
    cursor: pointer;
  }
  .esx-tree {
    padding: var(--px-4) var(--px-6) var(--px-16);
  }
  .esx-row {
    display: flex;
    align-items: center;
    gap: var(--px-7);
    padding: var(--px-5) var(--px-8);
    border-radius: var(--px-6);
    cursor: pointer;
    min-width: 0;
    color: var(--text);
  }
  .esx-row:hover:not(.sel) {
    background: color-mix(in srgb, var(--es-accent) 9%, transparent);
  }
  .esx-row.sel {
    background: color-mix(in srgb, var(--es-accent) 18%, transparent);
  }
  .esx-row.head {
    margin-top: var(--px-4);
    color: var(--text2);
  }
  .esx-row.leaf {
    padding-left: calc(var(--px-8) + var(--px-20));
  }
  .esx-chev {
    flex: none;
    width: var(--px-12);
    display: inline-flex;
    justify-content: center;
    color: var(--muted);
  }
  .esx-label {
    font-size: var(--px-12_5);
    font-weight: 600;
    color: var(--text);
  }
  .esx-count {
    margin-left: auto;
    font-size: var(--px-11);
    color: var(--text2);
    font-variant-numeric: tabular-nums;
  }
  .esx-ic {
    color: var(--es-accent);
    display: inline-flex;
  }
  .esx-name {
    font-size: var(--px-12_5);
    flex: 1 1 auto;
  }
  .esx-meta-r {
    margin-left: auto;
    flex: 0 100 auto;
    font-size: var(--px-11);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .esx-empty {
    padding: var(--px-4) var(--px-12) var(--px-4) calc(var(--px-8) + var(--px-20));
    font-size: var(--px-11_5);
    color: var(--muted);
  }
</style>
