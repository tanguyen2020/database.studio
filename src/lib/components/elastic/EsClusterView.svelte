<script lang="ts">
  // Cluster pages (Kibana Stack Monitoring, condensed): overview stats, nodes with
  // JVM / OS / disk usage, shards + allocation explain, running tasks (cancel) and
  // persistent / transient cluster settings.
  import { onMount, untrack } from 'svelte'
  import '$lib/elastic/es.css'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import EsIcon from './EsIcon.svelte'
  import EsAppIcon from './EsAppIcon.svelte'
  import EsConfirmDialog from './EsConfirmDialog.svelte'
  import { es, seg } from '$lib/elastic/api'
  import { fmtCount, formatBytes, healthColor, healthLabel } from '$lib/elastic/format'
  import { toasts } from '$lib/stores/toast.svelte'

  let { tab }: { tab: TabState } = $props()
  const connId = $derived(tab.connectionId ?? '')
  const section = $derived((tab.state as { section?: string }).section ?? 'overview')
  function setSection(s: string) {
    ;(tab.state as Record<string, unknown>).section = s
  }

  let overview = $state<ipc.EsOverview | null>(null)
  let error = $state<string | null>(null)
  let loading = $state(false)

  interface NodeRow {
    id: string
    name: string
    ip: string
    roles: string[]
    version: string
    heapPct: number | null
    heapUsed: number | null
    heapMax: number | null
    ramPct: number | null
    cpu: number | null
    load1: number | null
    diskTotal: number | null
    diskAvail: number | null
    docs: number | null
    uptimeMs: number | null
  }
  let nodes = $state<NodeRow[] | null>(null)
  let shards = $state<Record<string, string>[] | null>(null)
  let shardFilter = $state('')
  let onlyProblems = $state(false)
  let tasks = $state<{ id: string; action: string; description: string; runningMs: number; cancellable: boolean; node: string }[] | null>(null)
  let clusterSettings = $state<{ persistent: Record<string, unknown>; transient: Record<string, unknown> } | null>(null)
  let explain = $state<unknown | null>(null)
  let settingsText = $state('{\n  "persistent": {\n    \n  }\n}')
  let allocation = $state('all')

  async function loadOverview() {
    loading = true
    try {
      overview = await ipc.esOverview(connId)
      error = null
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  async function loadNodes() {
    try {
      type N = Record<string, any>
      const r = await es<{ nodes: Record<string, N> }>(connId, 'GET', '/_nodes/stats/jvm,os,fs,indices')
      nodes = Object.entries(r.nodes ?? {}).map(([id, n]) => ({
        id,
        name: n.name,
        ip: String(n.ip ?? n.host ?? '').split(':')[0],
        roles: n.roles ?? [],
        version: n.version ?? '',
        heapPct: n.jvm?.mem?.heap_used_percent ?? null,
        heapUsed: n.jvm?.mem?.heap_used_in_bytes ?? null,
        heapMax: n.jvm?.mem?.heap_max_in_bytes ?? null,
        ramPct: n.os?.mem?.used_percent ?? null,
        cpu: n.os?.cpu?.percent ?? null,
        load1: n.os?.cpu?.load_average?.['1m'] ?? null,
        diskTotal: n.fs?.total?.total_in_bytes ?? null,
        diskAvail: n.fs?.total?.available_in_bytes ?? null,
        docs: n.indices?.docs?.count ?? null,
        uptimeMs: n.jvm?.uptime_in_millis ?? null,
      }))
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  async function loadShards() {
    try {
      shards = await es<Record<string, string>[]>(connId, 'GET', '/_cat/shards?format=json&bytes=b&h=index,shard,prirep,state,docs,store,ip,node,unassigned.reason')
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  async function loadTasks() {
    try {
      type T = { action: string; description?: string; running_time_in_nanos?: number; cancellable?: boolean }
      const r = await es<{ nodes?: Record<string, { name?: string; tasks: Record<string, T> }> }>(connId, 'GET', '/_tasks?detailed=true&group_by=nodes')
      tasks = Object.values(r.nodes ?? {}).flatMap((n) =>
        Object.entries(n.tasks ?? {}).map(([id, t]) => ({
          id,
          action: t.action,
          description: t.description ?? '',
          runningMs: Math.round((t.running_time_in_nanos ?? 0) / 1e6),
          cancellable: !!t.cancellable,
          node: n.name ?? '',
        })),
      )
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  async function loadSettings() {
    try {
      const r = await es<{ persistent: Record<string, unknown>; transient: Record<string, unknown> }>(connId, 'GET', '/_cluster/settings?flat_settings=true')
      clusterSettings = r
      allocation = String(r.persistent['cluster.routing.allocation.enable'] ?? r.transient['cluster.routing.allocation.enable'] ?? 'all')
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  function loadSection(s: string) {
    if (s === 'overview') void loadOverview()
    if (s === 'nodes') void loadNodes()
    if (s === 'shards') void loadShards()
    if (s === 'tasks') void loadTasks()
    if (s === 'settings') void loadSettings()
  }

  // the overview header needs the cluster summary whatever the section
  onMount(() => {
    if (section !== 'overview') void loadOverview()
  })
  $effect(() => {
    const s = section
    untrack(() => loadSection(s))
  })

  async function explainShard(row: Record<string, string>) {
    try {
      explain = await es(connId, 'POST', '/_cluster/allocation/explain', { index: row.index, shard: Number(row.shard), primary: row.prirep === 'p' })
    } catch (e) {
      explain = { error: String((e as Error).message ?? e) }
    }
  }

  async function explainAny() {
    try {
      explain = await es(connId, 'POST', '/_cluster/allocation/explain')
    } catch (e) {
      explain = { error: String((e as Error).message ?? e) }
    }
  }

  let cancelTask = $state<{ id: string; action: string } | null>(null)

  async function saveAllocation() {
    try {
      await es(connId, 'PUT', '/_cluster/settings', { persistent: { 'cluster.routing.allocation.enable': allocation === 'all' ? null : allocation } })
      toasts.success('Shard allocation updated', 'elasticsearch')
      await loadSettings()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  async function applySettingsJson() {
    let body: unknown
    try {
      body = JSON.parse(settingsText)
    } catch (e) {
      toasts.error(`Invalid JSON — ${(e as Error).message}`, 'elasticsearch')
      return
    }
    try {
      await es(connId, 'PUT', '/_cluster/settings', body)
      toasts.success('Cluster settings updated', 'elasticsearch')
      await loadSettings()
    } catch (e) {
      toasts.error(String((e as Error).message ?? e), 'elasticsearch')
    }
  }

  const visibleShards = $derived(
    (shards ?? []).filter((s) => (!shardFilter || s.index.includes(shardFilter)) && (!onlyProblems || s.state !== 'STARTED')),
  )
  const unassigned = $derived((shards ?? []).filter((s) => s.state === 'UNASSIGNED').length)

  function pctBar(p: number | null) {
    const v = p ?? 0
    return { width: Math.min(100, v), tone: v >= 90 ? 'var(--es-red)' : v >= 75 ? 'var(--es-yellow)' : 'var(--es-bar)' }
  }

  function uptime(ms: number | null) {
    if (ms == null) return '—'
    const d = Math.floor(ms / 86_400_000)
    const h = Math.floor((ms % 86_400_000) / 3_600_000)
    return d ? `${d}d ${h}h` : `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
  }

  const SECTIONS = [
    { key: 'overview', label: 'Overview', icon: 'cluster' },
    { key: 'nodes', label: 'Nodes', icon: 'node' },
    { key: 'shards', label: 'Shards & allocation', icon: 'shard' },
    { key: 'tasks', label: 'Tasks', icon: 'task' },
    { key: 'settings', label: 'Settings', icon: 'gear' },
  ] as const
</script>

<div class="es-page" data-testid="es-cluster">
  <div class="es-header">
    <span class="es-header-icon"><EsAppIcon name="monitoring" size={24} /></span>
    <div style="min-width:0">
      <div class="es-title">{overview?.info.cluster_name || 'Cluster'}</div>
      <div class="es-sub" style="display:flex;gap:var(--px-8);align-items:center;flex-wrap:wrap">
        {#if overview}
          <span class="es-badge {overview.status}"><span class="es-dot" style="background:{healthColor(overview.status)}"></span>{healthLabel(overview.status)}</span>
          <span>{overview.info.distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'} {overview.info.version}</span>
          {#if overview.info.lucene_version}<span>· Lucene {overview.info.lucene_version}</span>{/if}
          {#if overview.info.cluster_uuid}<span class="mono" style="color:var(--muted)">· {overview.info.cluster_uuid}</span>{/if}
        {/if}
      </div>
    </div>
    <div class="es-header-actions">
      <button class="eg-btn" onclick={() => loadSection(section)} aria-busy={loading}><EsIcon name="refresh" size={13} /> Refresh</button>
    </div>
  </div>
  <div class="es-tabs" role="tablist" aria-label="Cluster sections">
    {#each SECTIONS as s (s.key)}
      <button class="es-tab" class:on={section === s.key} role="tab" aria-selected={section === s.key} onclick={() => setSection(s.key)}><EsIcon name={s.icon} size={14} /> {s.label}</button>
    {/each}
  </div>

  <div class="es-body">
    {#if section === 'overview'}
      {#if error}<div class="es-callout danger" role="alert">{error}</div>{/if}
      {#if overview}
        {#if overview.warning}<div class="es-callout warn" style="margin-bottom:var(--px-14)">Some cluster statistics are hidden for this user — {overview.warning}</div>{/if}
        <div class="es-stats" data-testid="es-cluster-stats">
          <div class="es-stat"><div class="es-stat-label">Health</div><div class="es-stat-value" style="color:{healthColor(overview.status)}">{healthLabel(overview.status)}</div><div class="es-stat-hint">{overview.active_shards_percent}% shards active</div></div>
          <div class="es-stat"><div class="es-stat-label">Nodes</div><div class="es-stat-value">{overview.number_of_nodes}</div><div class="es-stat-hint">{overview.number_of_data_nodes} data</div></div>
          <div class="es-stat"><div class="es-stat-label">Indices</div><div class="es-stat-value">{fmtCount(overview.indices)}</div></div>
          <div class="es-stat"><div class="es-stat-label">Documents</div><div class="es-stat-value">{fmtCount(overview.docs)}</div></div>
          <div class="es-stat"><div class="es-stat-label">Disk usage</div><div class="es-stat-value">{formatBytes(overview.store_bytes)}</div></div>
          <div class="es-stat"><div class="es-stat-label">Primary shards</div><div class="es-stat-value">{overview.active_primary_shards}</div><div class="es-stat-hint">{overview.active_shards} active total</div></div>
          <div class="es-stat"><div class="es-stat-label">Unassigned shards</div><div class="es-stat-value" style={overview.unassigned_shards ? 'color:var(--es-yellow)' : ''}>{overview.unassigned_shards}</div><div class="es-stat-hint">{overview.initializing_shards} initializing · {overview.relocating_shards} relocating</div></div>
          <div class="es-stat"><div class="es-stat-label">Pending tasks</div><div class="es-stat-value">{overview.number_of_pending_tasks}</div></div>
        </div>
        {#if overview.status === 'yellow' || overview.status === 'red'}
          <div class="es-callout {overview.status === 'red' ? 'danger' : 'warn'}" style="margin-top:var(--px-16)">
            <div>
              <b>{overview.status === 'red' ? 'Some primary shards are not allocated' : 'Some replica shards are not allocated'}.</b>
              {overview.status === 'yellow' && overview.number_of_data_nodes === 1 ? ' On a single-node cluster replicas can never be placed — set the replicas of those indices to 0.' : ''}
              <button class="es-link" style="border:none;background:none;color:var(--es-accent);font-weight:600;cursor:pointer" onclick={() => { setSection('shards'); void explainAny() }}>Explain allocation →</button>
            </div>
          </div>
        {/if}
      {:else if !error}
        <div class="es-empty">Loading cluster…</div>
      {/if}
    {:else if section === 'nodes'}
      {#if !nodes}
        <div class="es-empty">Loading nodes…</div>
      {:else}
        <div class="es-card">
          <table class="es-table" data-testid="es-nodes">
            <thead><tr><th>Node</th><th>Roles</th><th>JVM heap</th><th>RAM</th><th class="num">CPU</th><th class="num">Load 1m</th><th>Disk</th><th class="num">Docs</th><th>Uptime</th></tr></thead>
            <tbody>
              {#each nodes as n (n.id)}
                {@const heap = pctBar(n.heapPct)}
                {@const ram = pctBar(n.ramPct)}
                {@const diskPct = n.diskTotal && n.diskAvail != null ? Math.round(((n.diskTotal - n.diskAvail) / n.diskTotal) * 100) : null}
                {@const disk = pctBar(diskPct)}
                <tr>
                  <td><div style="font-weight:600">{n.name}</div><div class="mono" style="font-size:var(--px-11);color:var(--muted)">{n.ip} · {n.version}</div></td>
                  <td style="max-width:var(--px-200)">{#each n.roles as r (r)}<span class="es-badge" style="margin:0 var(--px-3) var(--px-3) 0">{r}</span>{/each}</td>
                  <td style="min-width:var(--px-120)"><div class="esn-bar"><span style="width:{heap.width}%;background:{heap.tone}"></span></div><span class="esn-sub">{n.heapPct ?? '—'}% of {formatBytes(n.heapMax)}</span></td>
                  <td style="min-width:var(--px-100)"><div class="esn-bar"><span style="width:{ram.width}%;background:{ram.tone}"></span></div><span class="esn-sub">{n.ramPct ?? '—'}%</span></td>
                  <td class="num">{n.cpu ?? '—'}%</td>
                  <td class="num">{n.load1 ?? '—'}</td>
                  <td style="min-width:var(--px-120)"><div class="esn-bar"><span style="width:{disk.width}%;background:{disk.tone}"></span></div><span class="esn-sub">{formatBytes(n.diskAvail)} free of {formatBytes(n.diskTotal)}</span></td>
                  <td class="num">{fmtCount(n.docs)}</td>
                  <td>{uptime(n.uptimeMs)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else if section === 'shards'}
      <div class="es-toolbar" style="margin-bottom:var(--px-12)">
        <input class="es-input" style="width:var(--px-240)" bind:value={shardFilter} placeholder="Filter by index" aria-label="Filter shards by index" />
        <label style="display:inline-flex;gap:var(--px-6);align-items:center;font-size:var(--px-12_5)"><input type="checkbox" bind:checked={onlyProblems} /> Only not started</label>
        {#if unassigned}<span class="es-badge yellow">{unassigned} unassigned</span>{/if}
        <button class="eg-btn" style="margin-left:auto" onclick={explainAny}>Explain first unassigned shard</button>
      </div>
      {#if explain}
        <div class="es-card" style="margin-bottom:var(--px-14)">
          <div class="es-card-h"><span class="es-card-title">Allocation explanation</span><button class="eg-btn" style="margin-left:auto" onclick={() => (explain = null)}>Close</button></div>
          <div class="es-card-b">
            {#if (explain as { allocate_explanation?: string }).allocate_explanation}
              <div class="es-callout" style="margin-bottom:var(--px-10)">{(explain as { allocate_explanation: string }).allocate_explanation}</div>
            {/if}
            <CodeView value={JSON.stringify(explain, null, 2)} language={DS_JSON} readOnly height="auto" minHeight={120} maxHeight={360} ariaLabel="Allocation explanation" />
          </div>
        </div>
      {/if}
      {#if !shards}
        <div class="es-empty">Loading shards…</div>
      {:else}
        <div class="es-card">
          <table class="es-table" data-testid="es-shards">
            <thead><tr><th>Index</th><th class="num">Shard</th><th>Type</th><th>State</th><th class="num">Docs</th><th class="num">Size</th><th>Node</th><th></th></tr></thead>
            <tbody>
              {#each visibleShards as s, i (i)}
                <tr>
                  <td class="mono">{s.index}</td>
                  <td class="num">{s.shard}</td>
                  <td>{s.prirep === 'p' ? 'primary' : 'replica'}</td>
                  <td><span class="es-badge {s.state === 'STARTED' ? 'green' : s.state === 'UNASSIGNED' ? 'yellow' : ''}">{s.state}</span></td>
                  <td class="num">{s.docs ? fmtCount(Number(s.docs)) : '—'}</td>
                  <td class="num">{s.store ? formatBytes(Number(s.store)) : '—'}</td>
                  <td>{s.node || '—'}</td>
                  <td style="text-align:right">{#if s.state !== 'STARTED'}<button class="eg-btn" onclick={() => explainShard(s)}>Why?</button>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else if section === 'tasks'}
      {#if !tasks}
        <div class="es-empty">Loading tasks…</div>
      {:else if !tasks.length}
        <div class="es-empty"><div class="es-empty-title">No running tasks</div>Long operations (reindex, update by query, snapshot…) show up here.</div>
      {:else}
        <div class="es-card">
          <table class="es-table" data-testid="es-tasks">
            <thead><tr><th>Action</th><th>Description</th><th>Node</th><th class="num">Running</th><th></th></tr></thead>
            <tbody>
              {#each tasks as t (t.id)}
                <tr>
                  <td class="mono" style="font-size:var(--px-12)">{t.action}<div style="color:var(--muted);font-size:var(--px-11)">{t.id}</div></td>
                  <td style="max-width:var(--px-340)" class="es-ellipsis" title={t.description}>{t.description || '—'}</td>
                  <td>{t.node}</td>
                  <td class="num">{(t.runningMs / 1000).toFixed(1)} s</td>
                  <td style="text-align:right">{#if t.cancellable}<button class="eg-btn ds-danger-outline" onclick={() => (cancelTask = { id: t.id, action: t.action })}>Cancel</button>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {:else if section === 'settings'}
      {#if !clusterSettings}
        <div class="es-empty">Loading settings…</div>
      {:else}
        <div class="es-card">
          <div class="es-card-h"><span class="es-card-title">Shard allocation</span><span class="es-help" style="margin:0">Disable before a rolling restart, re-enable afterwards.</span></div>
          <div class="es-card-b es-toolbar">
            <select class="es-input" bind:value={allocation} aria-label="Shard allocation">
              <option value="all">all — allocate every shard</option>
              <option value="primaries">primaries — only primary shards</option>
              <option value="new_primaries">new_primaries — only new primary shards</option>
              <option value="none">none — no allocation</option>
            </select>
            <button class="eg-btn primary" onclick={saveAllocation}>Apply</button>
          </div>
        </div>
        <div class="es-card">
          <div class="es-card-h"><span class="es-card-title">Persistent & transient settings</span></div>
          <table class="es-table" data-testid="es-cluster-settings">
            <thead><tr><th>Scope</th><th>Setting</th><th>Value</th></tr></thead>
            <tbody>
              {#each [...Object.entries(clusterSettings.persistent).map(([k, v]) => ['persistent', k, v]), ...Object.entries(clusterSettings.transient).map(([k, v]) => ['transient', k, v])] as [scope, k, v] (scope + String(k))}
                <tr><td><span class="es-badge">{scope}</span></td><td class="mono">{k}</td><td class="mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>
              {:else}
                <tr><td colspan="3" style="color:var(--muted)">Every setting is at its default.</td></tr>
              {/each}
            </tbody>
          </table>
          <div class="es-card-b" style="border-top:var(--px-1) solid var(--border)">
            <span class="es-label">PUT /_cluster/settings</span>
            <CodeView value={settingsText} language={DS_JSON} height="auto" minHeight={120} maxHeight={320} onChange={(t) => (settingsText = t)} onSubmit={applySettingsJson} ariaLabel="Cluster settings JSON" />
            <button class="eg-btn primary" style="margin-top:var(--px-8)" onclick={applySettingsJson}>Apply settings</button>
            <span class="es-help">Set a value to <span class="mono">null</span> to reset it to its default.</span>
          </div>
        </div>
      {/if}
    {/if}
  </div>
</div>

{#if cancelTask}
  {@const t = cancelTask}
  <EsConfirmDialog
    title="Cancel task?"
    body="{t.action} ({t.id}) is asked to stop. Work done so far is kept."
    action="Cancel task"
    run={async () => {
      await es(connId, 'POST', `/_tasks/${seg(t.id)}/_cancel`)
      toasts.success('Task cancelled', 'elasticsearch')
      await loadTasks()
    }}
    onClose={() => (cancelTask = null)}
  />
{/if}

<style>
  .esn-bar {
    height: var(--px-6);
    border-radius: var(--px-3);
    background: var(--border);
    overflow: hidden;
  }
  .esn-bar span {
    display: block;
    height: 100%;
    border-radius: var(--px-3);
  }
  .esn-sub {
    font-size: var(--px-11);
    color: var(--text2);
    font-variant-numeric: tabular-nums;
  }
</style>
