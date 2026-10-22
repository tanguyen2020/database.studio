<script lang="ts">
  // RabbitMQ cluster workspace (SPEC-RABBITMQ-WORKSPACE.md): Overview, Queues,
  // Exchanges, Connections, Nodes and Users & access on the shared stream shell.
  // Everything comes from the Management HTTP API; a value the broker did not report
  // stays unknown (rule 3). The queue / exchange details embed the existing views
  // (messages, live, bindings, publish), so nothing the old tabs could do is lost.
  import { onDestroy, untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { firstByName } from '$lib/stream/workspace-systems'
  import { toasts } from '$lib/stores/toast.svelte'
  import StreamShell, { type ShellSection, type ShellStatus } from '../StreamShell.svelte'
  import StreamTable, { type StreamColumn } from '../StreamTable.svelte'
  import SplitDetail from '../SplitDetail.svelte'
  import StatCards, { type StatCard } from '../StatCards.svelte'
  import RateChart, { type RateSeries } from '../RateChart.svelte'
  import HelpTip from '../HelpTip.svelte'
  import AdvancedToggle from '../AdvancedToggle.svelte'
  import RabbitQueueView from '$lib/components/workspace/RabbitQueueView.svelte'
  import RabbitExchangeView from '$lib/components/workspace/RabbitExchangeView.svelte'
  import RabbitUserManager from '$lib/components/workspace/users/RabbitUserManager.svelte'
  import RabbitCreateDialog from '$lib/components/explorer/RabbitCreateDialog.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import { pushSample, type Sample } from '$lib/stream/rates'
  import { compactCount, exactUtc, formatBytes, fullCount, plural, relativeTime } from '$lib/stream/humanize'
  import {
    clientLabel,
    diskUsage,
    formatRate,
    memoryUsage,
    nodeAlarms,
    queueAttention,
    rabbitStatus,
    uptimeText,
    type QueueAttention,
  } from '$lib/stream/rabbitmq-health'
  import { queueFeatures, queueTypeHelp, queueTypeLabel } from '$lib/stream/rabbitmq-arguments'
  import { exchangeLabel, isBuiltinExchange, sortExchanges } from '$lib/rabbitmq/format'
  import { exchangeFocusKey, exchangeFromFocus, type RabbitWorkspaceState } from '$lib/stream/rabbitmq-nav'
  import '$lib/components/workspace/users/um.css'

  let { tab }: { tab: TabState } = $props()

  const connId = $derived(tab.connectionId ?? '')
  const profile = $derived(connections.byId(connId))
  const ws = $derived(tab.state as RabbitWorkspaceState)
  const section = $derived(ws.section ?? 'overview')

  // ---- data ----------------------------------------------------------------------
  let overview = $state<ipc.RabbitOverview | null>(null)
  let overviewError = $state<string | null>(null)
  let vhosts = $state<string[]>([])
  let queues = $state<ipc.RabbitQueue[]>([])
  let queuesError = $state<string | null>(null)
  let exchanges = $state<ipc.RabbitExchange[]>([])
  let exchangesError = $state<string | null>(null)
  let nodes = $state<ipc.RabbitNode[] | null>(null)
  let nodesError = $state<string | null>(null)
  let conns = $state<ipc.RabbitConnection[]>([])
  let connsError = $state<string | null>(null)
  let connsLoaded = $state(false)
  let loadingOverview = $state(false)
  let loadingLists = $state(false)
  let loadingNodes = $state(false)
  let loadingConns = $state(false)
  /** said once when the remembered vhost does not exist and another was picked */
  let vhostNote = $state<string | null>(null)

  const vhost = $derived(ws.vhost || overview?.vhost || profile?.database?.trim() || '/')
  const loading = $derived(loadingOverview || loadingLists || loadingNodes || loadingConns)

  async function loadOverview() {
    if (!connId) return
    loadingOverview = true
    try {
      const [ov, vs] = await Promise.all([ipc.rabbitOverview(connId), ipc.rabbitVhosts(connId)])
      overview = ov
      vhosts = vs
      overviewError = null
      // A remembered / profile vhost that does not exist: follow the one the
      // connection really opened on, and say so (never a bare "Not found").
      // Compare against what was ASKED for — the backend already fell back, so
      // `ov.vhost` alone would always look valid.
      const wanted = ws.vhost || profile?.database?.trim() || '/'
      if (vs.length && !vs.includes(wanted)) {
        const next = vs.includes(ov.vhost) ? ov.vhost : vs[0]
        vhostNote = `Virtual host '${wanted}' does not exist on this broker — showing '${next}'.`
        tabs.patchState(tab.id, { vhost: next }, false)
      }
      sampleRates(ov)
    } catch (e) {
      overviewError = String(e)
    } finally {
      loadingOverview = false
    }
  }

  // A newer list load supersedes an older one (switching vhost twice quickly).
  let listGen = 0
  let queuesLoaded = $state(false)
  async function loadLists() {
    if (!connId) return
    const mine = ++listGen
    const v = vhost
    loadingLists = true
    try {
      const [qs, xs] = await Promise.allSettled([ipc.rabbitQueues(connId, v), ipc.rabbitExchanges(connId, v)])
      if (mine !== listGen) return
      queues = qs.status === 'fulfilled' ? qs.value : []
      queuesLoaded = true
      exchanges = xs.status === 'fulfilled' ? xs.value : []
      queuesError = qs.status === 'rejected' ? String(qs.reason) : null
      exchangesError = xs.status === 'rejected' ? String(xs.reason) : null
    } finally {
      if (mine === listGen) loadingLists = false
    }
  }

  async function loadNodes() {
    if (!connId) return
    loadingNodes = true
    try {
      nodes = await ipc.rabbitNodes(connId)
      nodesError = null
    } catch (e) {
      nodes = null
      nodesError = String(e)
    } finally {
      loadingNodes = false
    }
  }

  async function loadConns() {
    if (!connId) return
    loadingConns = true
    try {
      conns = await ipc.rabbitConnections(connId)
      connsError = null
    } catch (e) {
      connsError = String(e)
    } finally {
      connsLoaded = true
      loadingConns = false
    }
  }

  function refresh() {
    void loadOverview()
    void loadLists()
    void loadNodes()
    if (connsLoaded || section === 'connections') void loadConns()
    explorer.bumpRabbit(connId)
  }

  $effect(() => {
    void connId
    untrack(() => {
      void loadOverview()
      void loadNodes()
    })
  })

  // queue / exchange lists follow the vhost
  $effect(() => {
    void vhost
    untrack(() => void loadLists())
  })

  $effect(() => {
    if (section !== 'connections') return
    untrack(() => {
      if (!connsLoaded) void loadConns()
    })
  })

  // Another component changed the broker (purge, publish, create, delete…).
  let seenTick = untrack(() => explorer.rabbitTick[connId] ?? 0)
  $effect(() => {
    const tick = explorer.rabbitTick[connId] ?? 0
    untrack(() => {
      if (tick === seenTick) return
      seenTick = tick
      void loadLists()
    })
  })

  // ---- rates: sample the overview every 5 s while Overview is on screen ----------
  const RATE_WINDOW = 10 * 60_000
  const SAMPLE_MS = 5_000
  let pubSeries = $state<Sample[]>([])
  let delSeries = $state<Sample[]>([])
  let ackSeries = $state<Sample[]>([])
  let now = $state(Date.now())

  function sampleRates(ov: ipc.RabbitOverview) {
    const t = Date.now()
    now = t
    if (ov.publish_rate != null) pubSeries = pushSample(pubSeries, { t, v: ov.publish_rate }, RATE_WINDOW)
    if (ov.deliver_rate != null) delSeries = pushSample(delSeries, { t, v: ov.deliver_rate }, RATE_WINDOW)
    if (ov.ack_rate != null) ackSeries = pushSample(ackSeries, { t, v: ov.ack_rate }, RATE_WINDOW)
  }

  let docVisible = $state(typeof document === 'undefined' ? true : document.visibilityState !== 'hidden')
  const onVisibility = () => (docVisible = document.visibilityState !== 'hidden')
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  onDestroy(() => {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  })
  const tabShown = $derived(tabs.activeTabId === tab.id || tabs.activeTabId1 === tab.id)
  const sampling = $derived(section === 'overview' && tabShown && docVisible && !!connId)

  $effect(() => {
    if (!sampling) return
    const timer = setInterval(async () => {
      try {
        const ov = await ipc.rabbitOverview(connId)
        overview = ov
        sampleRates(ov)
      } catch {
        /* a missed sample leaves a gap; the next one tries again */
      }
    }, SAMPLE_MS)
    return () => clearInterval(timer)
  })

  const series: RateSeries[] = $derived([
    { label: 'Incoming', color: 'var(--primary)', samples: pubSeries },
    { label: 'Delivered', color: 'var(--sacc-green)', samples: delSeries },
    { label: 'Confirmed', color: 'var(--sacc-amber)', samples: ackSeries, dashed: true },
  ])
  const ratesReported = $derived(overview == null || overview.publish_rate != null || overview.deliver_rate != null || overview.ack_rate != null)

  // ---- health ----------------------------------------------------------------------
  const attention: QueueAttention[] = $derived(queueAttention(queues))
  const alarms = $derived((nodes ?? []).flatMap(nodeAlarms))
  const health = $derived(rabbitStatus(overview, nodes, attention))

  function go(next: string, focus?: string) {
    tabs.patchState(tab.id, { section: next, focus, sub: undefined })
  }
  function select(focus: string | null, sub?: string) {
    tabs.patchState(tab.id, { focus: focus ?? undefined, sub }, false)
  }
  // A new tab opens on Queues with the first queue's messages (autoPick, once).
  $effect(() => {
    if (!ws.autoPick || section !== 'queues' || !queuesLoaded) return
    const first = untrack(() => firstByName(queues.map((q) => q.name)))
    untrack(() => tabs.patchState(tab.id, first ? { autoPick: undefined, focus: first, sub: 'messages' } : { autoPick: undefined }, false))
  })
  function setVhost(v: string) {
    vhostNote = null
    tabs.patchState(tab.id, { vhost: v, focus: undefined })
  }

  const sections: ShellSection[] = $derived([
    { id: 'overview', label: 'Overview' },
    { id: 'queues', label: 'Queues', count: queues.length || null, badge: attention.length ? `${attention.length} need${attention.length === 1 ? 's' : ''} attention` : null },
    { id: 'exchanges', label: 'Exchanges', count: exchanges.length || null },
    { id: 'connections', label: 'Connections', count: overview ? overview.connections : null },
    { id: 'nodes', label: 'Nodes', count: nodes ? nodes.length : null, badge: alarms.length ? 'Alarm' : null },
    { id: 'access', label: 'Users & access' },
  ])

  const DESCRIPTIONS: Record<string, string> = {
    overview: 'A summary of the whole broker: is it healthy, how fast messages flow, and what needs attention.',
    queues: 'Queues hold messages until an application reads them. “Waiting” = not picked up yet; “In progress” = delivered, not confirmed yet.',
    exchanges: 'Exchanges receive published messages and route them to queues through bindings.',
    connections: 'Applications connected to the broker. Closing one disconnects that application; most reconnect on their own.',
    nodes: 'The servers of the broker. Above the memory limit or below the disk safety margin, every publisher is paused.',
    access: 'Users, what they may do in each virtual host, and policies that set rules on queues.',
  }

  const status: ShellStatus | null = $derived.by(() => {
    if (section !== 'overview') return null
    if (overviewError) return { tone: 'bad', headline: 'Could not read the broker', detail: overviewError, actionLabel: 'Try again', onAction: refresh }
    if (!overview) return null
    return {
      tone: health.tone,
      headline: health.headline,
      detail: health.detail,
      ...(health.actionSection ? { actionLabel: health.actionLabel ?? 'Show', onAction: () => go(health.actionSection!) } : {}),
    }
  })

  const cards: StatCard[] = $derived([
    { label: 'Waiting', value: overview ? compactCount(overview.messages_ready) : '—', tone: 'num', sub: overview ? `${fullCount(overview.messages_ready)} messages` : undefined, help: 'Messages no consumer has picked up yet.' },
    { label: 'In progress', value: overview ? compactCount(overview.messages_unacknowledged) : '—', tone: overview && overview.messages_unacknowledged > 0 ? 'warn' : 'num', sub: 'delivered, not confirmed yet', help: 'Delivered to a consumer, not confirmed yet.' },
    { label: 'Queues', value: overview ? fullCount(overview.queues) : '—', sub: attention.length ? `${attention.length} need attention in ${vhost}` : 'across every virtual host', tone: attention.length ? 'warn' : null, onClick: () => go('queues') },
    { label: 'Consumers', value: overview ? fullCount(overview.consumers) : '—', sub: 'applications reading', help: 'Subscriptions reading from queues right now.' },
    { label: 'Connections', value: overview ? fullCount(overview.connections) : '—', sub: overview ? plural(overview.channels, 'channel') : undefined, onClick: () => go('connections') },
    {
      label: 'Alarms',
      value: nodes ? String(alarms.length) : '?',
      tone: nodes ? (alarms.length ? 'bad' : 'ok') : null,
      sub: nodes ? (alarms.length ? 'publishers may be paused' : 'memory and disk are fine') : 'node details unavailable',
      help: 'Memory or disk alarms pause every publisher until the node recovers.',
      onClick: () => go('nodes'),
    },
  ])

  // ---- queues table ------------------------------------------------------------------
  const attentionByQueue = $derived(new Map(attention.map((a) => [a.queue, a])))
  const queueCols: StreamColumn<ipc.RabbitQueue>[] = [
    { key: 'name', label: 'Queue', sort: (q) => q.name },
    { key: 'type', label: 'Type', width: 'var(--px-90)', sort: (q) => q.queue_type, help: 'Classic: one node. Quorum: copied to several nodes. Stream: a re-readable log.' },
    { key: 'features', label: 'Features', width: 'var(--px-160)', help: 'Durable: survives a restart. Auto-delete: removed when its last consumer leaves. Exclusive: tied to one connection.' },
    { key: 'ready', label: 'Waiting', align: 'right', width: 'var(--px-100)', sort: (q) => q.messages_ready, help: 'Messages no consumer has picked up yet.' },
    { key: 'unacked', label: 'In progress', align: 'right', width: 'var(--px-110)', sort: (q) => q.messages_unacknowledged, help: 'Delivered to a consumer, not confirmed yet.' },
    { key: 'consumers', label: 'Consumers', align: 'right', width: 'var(--px-100)', sort: (q) => q.consumers, help: 'Applications reading from the queue right now.' },
    { key: 'in', label: 'Incoming', align: 'right', width: 'var(--px-100)', sort: (q) => q.publish_rate, help: 'Messages per second arriving.' },
    { key: 'out', label: 'Delivered', align: 'right', width: 'var(--px-100)', sort: (q) => q.deliver_rate, help: 'Messages per second handed to consumers.' },
  ]
  const focusQueue = $derived(section === 'queues' && ws.focus ? queues.find((q) => q.name === ws.focus) ?? null : null)
  // keep the details open for a queue that the list has not caught up with yet
  const focusQueueName = $derived(section === 'queues' && ws.focus ? ws.focus : null)

  // ---- exchanges table ---------------------------------------------------------------
  const sortedExchanges = $derived(sortExchanges(exchanges))
  const exchangeCols: StreamColumn<ipc.RabbitExchange>[] = [
    { key: 'name', label: 'Exchange', sort: (x) => (x.name === '' ? '' : x.name) },
    { key: 'type', label: 'Type', width: 'var(--px-130)', sort: (x) => x.exchange_type, help: 'Direct: exact routing key. Topic: pattern. Fanout: every bound queue. Headers: by message headers.' },
    { key: 'features', label: 'Features', width: 'var(--px-200)' },
  ]
  const focusExchangeName = $derived(section === 'exchanges' && ws.focus ? exchangeFromFocus(ws.focus) : null)

  // ---- connections -------------------------------------------------------------------
  const connCols: StreamColumn<ipc.RabbitConnection>[] = [
    { key: 'app', label: 'Application', sort: (c) => clientLabel(c), help: 'The name the application gave its connection, else its client library.' },
    { key: 'host', label: 'Machine', width: 'var(--px-150)', sort: (c) => c.peer_host },
    { key: 'user', label: 'User', width: 'var(--px-110)', sort: (c) => c.user },
    { key: 'vhost', label: 'Virtual host', width: 'var(--px-110)', sort: (c) => c.vhost },
    { key: 'channels', label: 'Channels', align: 'right', width: 'var(--px-90)', sort: (c) => c.channels, help: 'Lightweight sessions inside the connection; each consumer or publisher uses one.' },
    { key: 'tls', label: 'Encrypted', width: 'var(--px-100)', sort: (c) => (c.ssl ? 0 : 1), help: 'Whether the connection uses TLS.' },
    { key: 'recv', label: 'Receiving', align: 'right', width: 'var(--px-100)', sort: (c) => c.recv_rate, help: 'Data per second the broker receives from the application.' },
    { key: 'send', label: 'Sending', align: 'right', width: 'var(--px-100)', sort: (c) => c.send_rate, help: 'Data per second the broker sends to the application.' },
    { key: 'since', label: 'Connected', width: 'var(--px-120)', sort: (c) => -(c.connected_at ?? 0) },
  ]
  const focusConn = $derived(section === 'connections' && ws.focus ? conns.find((c) => c.name === ws.focus) ?? null : null)
  const byteRate = (r: number | null | undefined) => (r == null ? '—' : `${formatBytes(Math.round(r))}/s`)

  let closeFor = $state<ipc.RabbitConnection | null>(null)
  let closeBusy = $state(false)
  let closeError = $state<string | null>(null)
  async function closeConnection() {
    if (!closeFor || closeBusy) return
    closeBusy = true
    closeError = null
    const target = closeFor
    try {
      await ipc.rabbitCloseConnection(connId, target.name, 'Closed from Database Studio')
      toasts.success(`Closed the connection of ${clientLabel(target)}`, 'rabbitmq')
      closeFor = null
      if (ws.focus === target.name) select(null)
      await loadConns()
      void loadOverview()
      void loadLists()
    } catch (e) {
      closeError = String(e)
    } finally {
      closeBusy = false
    }
  }

  // ---- create queue / exchange (also requested from the sidebar) ----------------------
  let createKind = $state<'queue' | 'exchange' | null>(null)
  $effect(() => {
    const req = ws.create
    if (!req) return
    untrack(() => {
      createKind = req
      tabs.patchState(tab.id, { create: undefined }, false)
    })
  })
  async function created(kind: 'queue' | 'exchange', v: string, name: string) {
    createKind = null
    toasts.success(`Created ${kind} ${name}`, 'rabbitmq')
    tabs.patchState(tab.id, { section: kind === 'queue' ? 'queues' : 'exchanges', vhost: v, focus: kind === 'queue' ? name : exchangeFocusKey(name), sub: undefined })
    explorer.bumpRabbit(connId)
    await loadLists()
  }

  const nodeOk = (n: ipc.RabbitNode) => n.running && !n.mem_alarm && !n.disk_free_alarm && n.partitions.length === 0
</script>

<StreamShell
  system="rabbitmq"
  title={profile?.name ?? 'RabbitMQ'}
  subtitle={overview ? `RabbitMQ ${overview.rabbitmq_version} · ${overview.cluster_name || overview.node} · virtual host ${vhost}` : loadingOverview ? 'Reading broker…' : undefined}
  {sections}
  active={section}
  onSection={(id) => go(id)}
  {status}
  description={DESCRIPTIONS[section]}
  {loading}
  onRefresh={refresh}
>
  {#snippet actions()}
    {#if section === 'overview' || section === 'queues' || section === 'exchanges'}
      <label class="rw-vhost">
        <span>Virtual host</span>
        <select value={vhost} onchange={(e) => setVhost((e.currentTarget as HTMLSelectElement).value)} aria-label="Workspace virtual host" class="ds-control">
          {#each vhosts.length ? vhosts : [vhost] as v (v)}<option value={v}>{v}</option>{/each}
        </select>
      </label>
    {/if}
    {#if section === 'queues' || section === 'overview'}
      <button type="button" class="cfm-btn primary" onclick={() => (createKind = 'queue')}>+ Create queue</button>
    {/if}
    {#if section === 'exchanges'}
      <button type="button" class="cfm-btn primary" onclick={() => (createKind = 'exchange')}>+ Create exchange</button>
    {/if}
  {/snippet}

  {#if vhostNote && (section === 'overview' || section === 'queues' || section === 'exchanges')}
    <div class="rw-note" role="note" data-testid="workspace-vhost-note">{vhostNote} Set <b>Virtual host</b> in the connection to choose another.</div>
  {/if}

  {#if section === 'overview'}
    <div class="ds-body rw-overview" data-testid="rabbit-overview">
      <StatCards items={cards} />
      <section class="rw-panel">
        <div class="rw-panel-head"><span>Message flow, per second</span><HelpTip text="Incoming = published to the broker. Delivered = handed to consumers. Confirmed = acknowledged by consumers. Sampled every 5 seconds while this section is open." /></div>
        <div class="rw-panel-body">
          {#if !ratesReported}
            <div class="ds-empty"><b>The broker reports no message rates</b>Statistics collection may be turned off on this broker.</div>
          {:else}
            <RateChart {series} windowMs={RATE_WINDOW} {now} ariaLabel="Messages per second: incoming, delivered and confirmed over the last 10 minutes" />
          {/if}
        </div>
      </section>
      <div class="rw-two">
        <section class="rw-panel">
          <div class="rw-panel-head"><span>Queues needing attention</span><button type="button" class="rw-link" onclick={() => go('queues')}>All queues</button></div>
          {#if queuesError}
            <div class="ds-empty rw-bad">{queuesError}</div>
          {:else if loadingLists && queues.length === 0}
            <div class="ds-empty">Reading queues…</div>
          {:else if attention.length === 0}
            <div class="ds-empty"><b>Nothing needs attention</b>Every queue with messages has a consumer, and no dead-letter queue is filling up.</div>
          {:else}
            <ul class="rw-attn" data-testid="queues-attention">
              {#each attention.slice(0, 8) as a (a.queue)}
                <li class="rw-attn-row {a.tone}">
                  <span class="rw-attn-icon" aria-hidden="true"><Icon name="warning" size={14} /></span>
                  <div class="rw-attn-text">
                    <button type="button" class="rw-qlink ds-name" onclick={() => go('queues', a.queue)}>{a.queue}</button>
                    <span>{a.reason}</span>
                  </div>
                  <button type="button" class="cfm-btn rw-attn-act" onclick={() => tabs.patchState(tab.id, { section: 'queues', focus: a.queue, sub: a.action === 'See consumers' ? 'consumers' : undefined })}>{a.action}</button>
                </li>
              {/each}
            </ul>
            {#if attention.length > 8}<div class="rw-more">+ {attention.length - 8} more — <button type="button" class="rw-link" onclick={() => go('queues')}>see all queues</button></div>{/if}
          {/if}
        </section>
        <section class="rw-panel">
          <div class="rw-panel-head"><span>Nodes</span><button type="button" class="rw-link" onclick={() => go('nodes')}>All nodes</button></div>
          {#if nodesError}
            <div class="ds-empty rw-bad" role="alert"><b>Node details are not available</b>{nodesError}</div>
          {:else if !nodes}
            <div class="ds-empty">Reading nodes…</div>
          {:else}
            <table class="ds-table flush rw-mini">
              <thead><tr><th>Node</th><th>Status</th><th>Memory</th><th>Free disk</th></tr></thead>
              <tbody>
                {#each nodes as n (n.name)}
                  {@const mem = memoryUsage(n, formatBytes)}
                  {@const disk = diskUsage(n, formatBytes)}
                  <tr>
                    <td class="mono rw-strong">{n.name}</td>
                    <td>{#if nodeOk(n)}<span class="rw-ok">Healthy</span>{:else}<span class="rw-badtxt">{nodeAlarms(n)[0] ?? 'Problem'}</span>{/if}</td>
                    <td class:rw-warn={mem.tone === 'warn'} class:rw-badtxt={mem.tone === 'bad'}>{mem.pct == null ? 'Not reported' : `${Math.round(mem.pct)}% of limit`}</td>
                    <td class:rw-warn={disk.tone === 'warn'} class:rw-badtxt={disk.tone === 'bad'}>{n.disk_free == null ? 'Not reported' : formatBytes(n.disk_free)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
      </div>
    </div>
  {:else if section === 'queues'}
    <SplitDetail storeKey="rabbit-queues" open={!!focusQueueName}>
      {#snippet list()}
        <StreamTable
          rows={queues}
          columns={queueCols}
          rowKey={(q) => q.name}
          ariaLabel="Queues"
          selected={ws.focus ?? null}
          onSelect={(q) => select(q.name)}
          onOpen={(q) => select(q.name, 'messages')}
          filterText={(q) => q.name}
          filterPlaceholder="Filter queues…"
          initialSort={{ key: 'name', dir: 'asc' }}
          loading={loadingLists}
          error={queuesError}
          emptyTitle="No queues in this virtual host"
          emptyBody={`Queues hold messages until an application reads them. Create one in ${vhost}, or switch the virtual host.`}
          emptyActionLabel="+ Create queue"
          onEmptyAction={() => (createKind = 'queue')}
          note={attention.length ? `${plural(attention.length, 'queue')} need${attention.length === 1 ? 's' : ''} attention — see the Overview for the reason.` : null}
        >
          {#snippet cell(q, c)}
            {#if c.key === 'name'}
              <span class="ds-name" title={q.name}>{q.name}</span>
              {#if attentionByQueue.get(q.name)}{@const a = attentionByQueue.get(q.name)!}<span class="rw-flag" title={a.reason} aria-label={`Needs attention: ${a.reason}`}><Icon name="warning" size={12} /></span>{/if}
            {:else if c.key === 'type'}<span title={queueTypeHelp(q.queue_type)}>{queueTypeLabel(q.queue_type)}</span>
            {:else if c.key === 'features'}
              <span class="rw-feats">{#each queueFeatures(q) as f (f.label)}<span class="rw-feat" title={f.help}>{f.label}</span>{/each}</span>
            {:else if c.key === 'ready'}
              {#if q.messages_ready == null}<span class="rw-dim" title="The broker has not reported this count yet">?</span>{:else}<span class="ds-num" title={fullCount(q.messages_ready)}>{compactCount(q.messages_ready)}</span>{/if}
            {:else if c.key === 'unacked'}
              {#if q.messages_unacknowledged == null}<span class="rw-dim">?</span>{:else}<span class="ds-num" class:rw-warn={q.messages_unacknowledged > 0} title={fullCount(q.messages_unacknowledged)}>{compactCount(q.messages_unacknowledged)}</span>{/if}
            {:else if c.key === 'consumers'}
              {#if q.consumers == null}<span class="rw-dim">?</span>{:else}<span class="ds-num" class:rw-warn={q.consumers === 0 && (q.messages_ready ?? 0) > 0}>{q.consumers === 0 ? 'None' : q.consumers}</span>{/if}
            {:else if c.key === 'in'}<span class="ds-num rw-rate">{formatRate(q.publish_rate)}</span>
            {:else if c.key === 'out'}<span class="ds-num rw-rate">{formatRate(q.deliver_rate)}</span>
            {/if}
          {/snippet}
        </StreamTable>
      {/snippet}
      {#snippet detail()}
        {#if focusQueueName}
          {#key `${vhost}|${focusQueueName}`}
            {#if focusQueue && attentionByQueue.get(focusQueue.name)}
              {@const a = attentionByQueue.get(focusQueue.name)!}
              <div class="rw-callout {a.tone}" role="status"><Icon name="warning" size={14} /> <span>{a.reason}</span></div>
            {/if}
            <RabbitQueueView
              {tab}
              {vhost}
              name={focusQueueName}
              embedded
              initialSection={ws.sub}
              onClose={() => select(null)}
              onDeleted={() => {
                select(null)
                void loadLists()
              }}
            />
          {/key}
        {/if}
      {/snippet}
    </SplitDetail>
  {:else if section === 'exchanges'}
    <SplitDetail storeKey="rabbit-exchanges" open={focusExchangeName != null}>
      {#snippet list()}
        <StreamTable
          rows={sortedExchanges}
          columns={exchangeCols}
          rowKey={(x) => exchangeFocusKey(x.name)}
          ariaLabel="Exchanges"
          selected={ws.focus ?? null}
          onSelect={(x) => select(exchangeFocusKey(x.name))}
          filterText={(x) => exchangeLabel(x.name)}
          filterPlaceholder="Filter exchanges…"
          loading={loadingLists}
          error={exchangesError}
          emptyTitle="No exchanges in this virtual host"
          emptyBody="Exchanges route published messages to queues."
          emptyActionLabel="+ Create exchange"
          onEmptyAction={() => (createKind = 'exchange')}
        >
          {#snippet cell(x, c)}
            {#if c.key === 'name'}<span class="ds-name" class:rw-dim={isBuiltinExchange(x.name)}>{exchangeLabel(x.name)}</span>
            {:else if c.key === 'type'}<span>{x.exchange_type}</span>
            {:else if c.key === 'features'}
              <span class="rw-feats">
                <span class="rw-feat" title={x.durable ? 'Survives a broker restart.' : 'Lost when the broker restarts.'}>{x.durable ? 'Durable' : 'Temporary'}</span>
                {#if x.auto_delete}<span class="rw-feat" title="Deleted when its last binding is removed.">Auto-delete</span>{/if}
                {#if x.internal}<span class="rw-feat" title="Clients cannot publish to it directly.">Internal</span>{/if}
                {#if isBuiltinExchange(x.name)}<span class="rw-feat" title="Created by the broker; it cannot be deleted.">Built-in</span>{/if}
              </span>
            {/if}
          {/snippet}
        </StreamTable>
      {/snippet}
      {#snippet detail()}
        {#if focusExchangeName != null}
          {#key `${vhost}|${focusExchangeName}`}
            <RabbitExchangeView
              {tab}
              {vhost}
              name={focusExchangeName}
              embedded
              onClose={() => select(null)}
              onDeleted={() => {
                select(null)
                void loadLists()
              }}
            />
          {/key}
        {/if}
      {/snippet}
    </SplitDetail>
  {:else if section === 'connections'}
    <SplitDetail storeKey="rabbit-connections" open={!!focusConn}>
      {#snippet list()}
        <StreamTable
          rows={conns}
          columns={connCols}
          rowKey={(c) => c.name}
          ariaLabel="Connections"
          selected={ws.focus ?? null}
          onSelect={(c) => select(c.name)}
          filterText={(c) => `${clientLabel(c)} ${c.peer_host} ${c.user} ${c.vhost}`}
          filterPlaceholder="Filter connections…"
          initialSort={{ key: 'app', dir: 'asc' }}
          loading={loadingConns}
          error={connsError}
          emptyTitle="No application is connected"
          emptyBody="Applications appear here while they hold an AMQP connection to the broker. This app reads the management API and is not listed."
        >
          {#snippet cell(c, col)}
            {#if col.key === 'app'}<span class="rw-strong">{clientLabel(c)}</span>{#if !c.client_name}<span class="rw-dim"> · unnamed</span>{/if}
            {:else if col.key === 'host'}<span class="mono rw-dim">{c.peer_host || '—'}</span>
            {:else if col.key === 'user'}<span>{c.user}</span>
            {:else if col.key === 'vhost'}<span class="mono">{c.vhost}</span>
            {:else if col.key === 'channels'}<span class="ds-num">{c.channels ?? '—'}</span>
            {:else if col.key === 'tls'}{#if c.ssl}<span class="rw-ok">Yes (TLS)</span>{:else}<span class="rw-dim">No</span>{/if}
            {:else if col.key === 'recv'}<span class="ds-num rw-rate">{byteRate(c.recv_rate)}</span>
            {:else if col.key === 'send'}<span class="ds-num rw-rate">{byteRate(c.send_rate)}</span>
            {:else if col.key === 'since'}<span title={c.connected_at ? exactUtc(c.connected_at) : undefined}>{c.connected_at ? relativeTime(c.connected_at) : '—'}</span>
            {/if}
          {/snippet}
        </StreamTable>
      {/snippet}
      {#snippet detail()}
        {#if focusConn}
          <div class="rw-detail" data-testid="connection-detail">
            <div class="rw-detail-head">
              <span class="rw-detail-title">{clientLabel(focusConn)}</span>
              <button type="button" class="rw-close" onclick={() => select(null)} aria-label="Close details" title="Close details">×</button>
            </div>
            <div class="rw-facts">
              <span class="ds-chip">{focusConn.state ? focusConn.state[0].toUpperCase() + focusConn.state.slice(1) : 'Unknown state'}</span>
              <span class="ds-chip">{plural(focusConn.channels ?? 0, 'channel')}</span>
              <span class="ds-chip" class:live={focusConn.ssl}>{focusConn.ssl ? 'Encrypted (TLS)' : 'Not encrypted'}</span>
            </div>
            <dl class="rw-dl">
              <dt>Machine</dt><dd class="mono">{focusConn.peer_host}{focusConn.peer_port ? `:${focusConn.peer_port}` : ''}</dd>
              <dt>User</dt><dd>{focusConn.user}</dd>
              <dt>Virtual host</dt><dd class="mono">{focusConn.vhost}</dd>
              <dt>Client library</dt><dd>{[focusConn.client_product, focusConn.client_version].filter(Boolean).join(' ') || '—'}{focusConn.client_platform ? ` · ${focusConn.client_platform}` : ''}</dd>
              <dt>Connected</dt><dd title={focusConn.connected_at ? exactUtc(focusConn.connected_at) : undefined}>{focusConn.connected_at ? relativeTime(focusConn.connected_at) : '—'}</dd>
              <dt>Received</dt><dd>{focusConn.recv_bytes == null ? '—' : formatBytes(focusConn.recv_bytes)} · {byteRate(focusConn.recv_rate)}</dd>
              <dt>Sent</dt><dd>{focusConn.send_bytes == null ? '—' : formatBytes(focusConn.send_bytes)} · {byteRate(focusConn.send_rate)}</dd>
            </dl>
            <div class="rw-actions">
              <button type="button" class="cfm-btn ds-danger-outline" onclick={() => { closeError = null; closeFor = focusConn }}>Close connection…</button>
            </div>
            <AdvancedToggle>
              <dl class="rw-dl">
                <dt>Connection name</dt><dd class="mono">{focusConn.name}</dd>
                <dt>Protocol</dt><dd>{focusConn.protocol || '—'}</dd>
                <dt>Node</dt><dd class="mono">{focusConn.node || '—'}</dd>
              </dl>
            </AdvancedToggle>
          </div>
        {/if}
      {/snippet}
    </SplitDetail>
  {:else if section === 'nodes'}
    <div class="ds-body rw-nodes" data-testid="rabbit-nodes">
      {#if nodesError}
        <div class="ds-empty rw-bad" role="alert"><b>Node details are not available</b>{nodesError}</div>
      {:else if !nodes}
        <div class="ds-empty" aria-busy="true">Reading nodes…</div>
      {:else if nodes.length === 0}
        <div class="ds-empty"><b>The broker reported no node</b>Refresh to try again.</div>
      {:else}
        {#each nodes as n (n.name)}
          {@const mem = memoryUsage(n, formatBytes)}
          {@const disk = diskUsage(n, formatBytes)}
          <section class="rw-panel rw-node" data-node={n.name}>
            <div class="rw-panel-head">
              <span class="mono">{n.name}</span>
              {#if nodeOk(n)}<span class="ds-chip live">Healthy</span>{:else}<span class="ds-chip bad">Needs attention</span>{/if}
            </div>
            <div class="rw-panel-body rw-node-body">
              {#each nodeAlarms(n) as alarm (alarm)}<div class="rw-callout bad" role="alert"><Icon name="warning" size={14} /> <span>{alarm} — publishers are paused until it recovers.</span></div>{/each}
              <div class="rw-metric">
                <span class="rw-metric-label">Memory used <HelpTip text="Above the memory limit the broker pauses every publisher until memory is freed." /></span>
                <span class="rw-metric-value" class:rw-warn={mem.tone === 'warn'} class:rw-badtxt={mem.tone === 'bad'}>{mem.label}</span>
                {#if mem.pct != null}<div class="rw-bar" role="meter" aria-label="Memory used against the limit" aria-valuenow={Math.round(mem.pct)} aria-valuemin={0} aria-valuemax={100}><span class={mem.tone} style="width:{mem.pct}%"></span></div>{/if}
              </div>
              <div class="rw-metric">
                <span class="rw-metric-label">Free disk <HelpTip text="Disk safety margin: below it the broker pauses every publisher until space is freed." /></span>
                <span class="rw-metric-value" class:rw-warn={disk.tone === 'warn'} class:rw-badtxt={disk.tone === 'bad'}>{disk.label}</span>
              </div>
              <div class="rw-metric">
                <span class="rw-metric-label">Running for</span>
                <span class="rw-metric-value">{n.running ? uptimeText(n.uptime_ms) : 'Not running'}</span>
              </div>
              <AdvancedToggle>
                <dl class="rw-dl">
                  <dt>File descriptors</dt><dd>{n.fd_used == null ? '—' : `${fullCount(n.fd_used)} of ${fullCount(n.fd_total)}`}</dd>
                  <dt>Erlang processes</dt><dd>{n.proc_used == null ? '—' : `${fullCount(n.proc_used)} of ${fullCount(n.proc_total)}`}</dd>
                  <dt>Sockets</dt><dd>{n.sockets_used == null ? '—' : `${fullCount(n.sockets_used)} of ${fullCount(n.sockets_total)}`}</dd>
                  <dt>Memory limit (high watermark)</dt><dd class="mono">{n.mem_limit == null ? '—' : fullCount(n.mem_limit)} bytes</dd>
                  <dt>Disk free limit</dt><dd class="mono">{n.disk_free_limit == null ? '—' : fullCount(n.disk_free_limit)} bytes</dd>
                  <dt>Node type</dt><dd>{n.node_type || '—'}</dd>
                </dl>
              </AdvancedToggle>
            </div>
          </section>
        {/each}
      {/if}
    </div>
  {:else if section === 'access'}
    <div class="rw-access">
      <RabbitUserManager {tab} />
    </div>
  {/if}
</StreamShell>

{#if createKind}
  {@const kind = createKind}
  <RabbitCreateDialog
    {connId}
    {kind}
    {vhosts}
    initialVhost={vhost}
    exchangeTypes={overview?.exchange_types?.length ? overview.exchange_types : ['direct', 'fanout', 'headers', 'topic']}
    onClose={() => (createKind = null)}
    onCreated={(v, n) => created(kind, v, n)}
  />
{/if}

{#if closeFor}
  {@const c = closeFor}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !closeBusy && (closeFor = null)}>
    <div class="um-dlg sm" role="alertdialog" aria-modal="true" aria-label="Close connection" tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="close" size={18} /></span>
        <div class="um-dlg-title"><b>Close connection</b><span>{clientLabel(c)} · {c.peer_host}</span></div>
      </div>
      <div class="um-dlg-body">
        <p class="rw-confirm">
          This disconnects <b>{clientLabel(c)}</b>{c.peer_host ? ` on ${c.peer_host}` : ''}: its {plural(c.channels ?? 0, 'channel')} close, its consumers stop receiving, and messages it has not confirmed go back to their queues. Most applications reconnect on their own.
        </p>
        {#if closeError}<div class="rw-error" role="alert">{closeError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span style="flex:1"></span>
        <button type="button" class="cfm-btn" use:autofocus onclick={() => (closeFor = null)} disabled={closeBusy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={closeConnection} disabled={closeBusy}>{closeBusy ? 'Closing…' : `Close connection of ${clientLabel(c)}`}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .rw-vhost {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .rw-vhost select {
    max-width: var(--px-160);
  }
  .rw-note {
    flex: none;
    margin: var(--px-10) var(--px-18) 0;
    padding: var(--px-8) var(--px-12);
    border-radius: var(--px-8);
    font-size: var(--px-12);
    color: var(--text2);
    background: color-mix(in srgb, var(--sacc-amber) 9%, var(--surface));
    border: var(--px-1) solid color-mix(in srgb, var(--sacc-amber) 35%, var(--border));
  }
  .rw-overview,
  .rw-nodes {
    gap: var(--px-18);
  }
  .rw-two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--px-420), 1fr));
    gap: var(--px-18);
  }
  .rw-panel {
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
    overflow: hidden;
    box-shadow: var(--shadow-xs);
  }
  .rw-panel-head {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-10) var(--px-14);
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
    border-bottom: var(--px-1) solid var(--border);
  }
  .rw-panel-head > span:first-child {
    flex: 1;
  }
  .rw-panel-body {
    padding: var(--px-12) var(--px-14);
  }
  .rw-link {
    border: 0;
    background: transparent;
    font-family: var(--font-main);
    font-size: var(--px-12);
    font-weight: 500;
    color: var(--primary);
    cursor: pointer;
    padding: var(--px-2) var(--px-4);
  }
  .rw-attn {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .rw-attn-row {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-10) var(--px-14);
    border-bottom: var(--px-1) solid var(--border);
  }
  .rw-attn-row:last-child {
    border-bottom: 0;
  }
  .rw-attn-icon {
    display: inline-flex;
    color: var(--sacc-amber);
  }
  .rw-attn-row.bad .rw-attn-icon {
    color: var(--danger-text);
  }
  .rw-attn-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  .rw-attn-act {
    flex: none;
  }
  .rw-more {
    padding: var(--px-8) var(--px-14);
    font-size: var(--px-12);
    color: var(--muted);
  }
  .rw-qlink {
    align-self: flex-start;
    border: 0;
    background: transparent;
    padding: 0;
    font-size: var(--px-12_5);
    cursor: pointer;
  }
  .rw-flag {
    display: inline-flex;
    margin-left: var(--px-6);
    color: var(--sacc-amber);
    vertical-align: middle;
  }
  .rw-feats {
    display: inline-flex;
    gap: var(--px-4);
  }
  .rw-feat {
    font-size: var(--px-11);
    padding: 0 var(--px-6);
    border-radius: var(--px-9);
    border: var(--px-1) solid var(--border2);
    color: var(--text2);
  }
  .rw-rate {
    color: var(--tbl-cell);
  }
  .rw-mini th,
  .rw-mini td {
    white-space: nowrap;
  }
  .rw-strong {
    font-weight: 600;
    color: var(--text);
  }
  .rw-dim {
    color: var(--muted);
  }
  .rw-ok {
    color: var(--sacc-green);
    font-weight: 600;
  }
  .rw-warn {
    color: var(--sacc-amber);
    font-weight: 600;
  }
  .rw-badtxt {
    color: var(--danger-text);
    font-weight: 600;
  }
  .rw-bad {
    color: var(--danger-text);
  }
  .rw-callout {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    margin: var(--px-10) var(--px-14) 0;
    padding: var(--px-8) var(--px-12);
    border-radius: var(--px-8);
    font-size: var(--px-12_5);
    color: var(--text);
    background: color-mix(in srgb, var(--sacc-amber) 10%, var(--surface));
    border: var(--px-1) solid color-mix(in srgb, var(--sacc-amber) 40%, var(--border));
  }
  .rw-callout :global(svg) {
    flex: none;
    color: var(--sacc-amber);
  }
  .rw-callout.bad {
    background: var(--danger-soft);
    border-color: color-mix(in srgb, var(--danger-solid) 45%, var(--border));
  }
  .rw-callout.bad :global(svg) {
    color: var(--danger-text);
  }
  .rw-node-body {
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
  }
  .rw-node-body .rw-callout {
    margin: 0;
  }
  .rw-metric {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
  }
  .rw-metric-label {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .rw-metric-value {
    font-size: var(--px-14);
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .rw-bar {
    height: var(--px-6);
    border-radius: var(--px-3);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    overflow: hidden;
    max-width: var(--px-420);
  }
  .rw-bar span {
    display: block;
    height: 100%;
    background: var(--sacc-green);
  }
  .rw-bar span.warn {
    background: var(--sacc-amber);
  }
  .rw-bar span.bad {
    background: var(--danger-solid);
  }
  .rw-detail {
    padding: var(--px-14) var(--px-18) var(--px-18);
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
  }
  .rw-detail-head {
    display: flex;
    align-items: center;
    gap: var(--px-10);
  }
  .rw-detail-title {
    flex: 1;
    min-width: 0;
    font-size: var(--px-15);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rw-close {
    border: 0;
    background: transparent;
    font-size: var(--px-18);
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    padding: var(--px-2) var(--px-6);
    border-radius: var(--px-6);
  }
  .rw-close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .rw-facts,
  .rw-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-8);
  }
  .rw-dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--px-6) var(--px-18);
    margin: 0;
    font-size: var(--px-12_5);
  }
  .rw-dl dt {
    color: var(--tbl-meta);
  }
  .rw-dl dd {
    margin: 0;
    color: var(--text);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .rw-confirm {
    margin: 0;
    line-height: 1.5;
    color: var(--text2);
  }
  .rw-error {
    margin-top: var(--px-10);
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    background: var(--danger-soft);
    color: var(--danger-text);
    font-size: var(--px-12_5);
  }
  .rw-access {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
