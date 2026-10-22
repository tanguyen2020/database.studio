<script lang="ts">
  // stream-workspace:nats — NATS cluster workspace (SPEC-NATS-WORKSPACE.md) on the
  // shared stream shell: Overview (status sentence, server, persistence, account
  // usage), Streams (table → Subjects / Consumers / Config) and Key-value buckets.
  // Streams come from the same cache as the Explorer tree, so a change made in one
  // place shows in the other. Nothing is invented: a value the server did not report
  // is not shown (rule 3).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { firstByName } from '$lib/stream/workspace-systems'
  import { natsCreateStream } from '$lib/stores/natsCreateStream.svelte'
  import { natsAddWizard } from '$lib/stores/natsAdd.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import StreamShell, { type ShellSection, type ShellStatus } from '../StreamShell.svelte'
  import StreamTable, { type StreamColumn } from '../StreamTable.svelte'
  import SplitDetail from '../SplitDetail.svelte'
  import StatCards, { type StatCard } from '../StatCards.svelte'
  import HelpTip from '../HelpTip.svelte'
  import AdvancedToggle from '../AdvancedToggle.svelte'
  import NatsKvSection from './NatsKvSection.svelte'
  import NatsMessaging from './NatsMessaging.svelte'
  import NatsObjectStore from './NatsObjectStore.svelte'
  import NatsSubjectMessages from '$lib/components/workspace/NatsSubjectMessages.svelte'
  import PayloadDialog from '$lib/components/viewer/PayloadDialog.svelte'
  import { parseSeq, peekErrorText, seqRangeHint } from '$lib/stream/nats-peek'
  import Icon from '$lib/components/Icon.svelte'
  import Chevron from '$lib/components/Chevron.svelte'
  import { sortRows, type SortState } from '$lib/stream/table'
  import { arrangeTree, streamNodes, subjectKey, type TreeNode } from '$lib/stream/nats-tree'
  import { compactCount, exactUtc, formatBytes, fullCount, plural, relativeTime } from '$lib/stream/humanize'
  import { consumerRows, keepFor, natsStatus, streamConfigWords, streamRows, storedWords, usageTone, usedOf, retentionWords, expireAfter, type ConsumerRow, type StreamRow } from '$lib/stream/nats-workspace'
  import '$lib/components/workspace/users/um.css'

  let { tab }: { tab: TabState } = $props()

  const connId = $derived(tab.connectionId ?? '')
  const profile = $derived(connections.byId(connId))
  const ws = $derived(tab.state as { section?: string; focus?: string; sub?: string; kvKey?: string; subject?: string; autoPick?: boolean })
  const section = $derived(ws.section ?? 'overview')

  let info = $state<ipc.NatsInfo | null>(null)
  let account = $state<ipc.NatsAccount | null>(null)
  let accountError = $state<string | null>(null)
  let loadingInfo = $state(false)
  let buckets = $state<ipc.NatsKvStatus[]>([])
  let bucketsError = $state<string | null>(null)
  let loadingBuckets = $state(false)
  let showSystem = $state(false)

  const cache = $derived(explorer.streaming[connId])
  const streams = $derived((cache?.natsStreams ?? []) as ipc.NatsJsStreamFull[])
  const rows = $derived(streamRows(streams))
  const userRows = $derived(rows.filter((r) => !r.system))
  const shownRows = $derived(showSystem ? rows : userRows)
  const systemCount = $derived(rows.length - userRows.length)
  const persistence = $derived(account ? account.enabled : null)
  const loading = $derived(loadingInfo || loadingBuckets || !!cache?.loading)

  async function loadInfo() {
    if (!connId) return
    loadingInfo = true
    accountError = null
    const [i, a] = await Promise.allSettled([ipc.natsInfo(connId), ipc.natsAccountInfo(connId)])
    info = i.status === 'fulfilled' ? i.value : null
    if (a.status === 'fulfilled') account = a.value
    else {
      account = null
      accountError = String(a.reason)
    }
    loadingInfo = false
  }

  async function loadBuckets() {
    if (!connId) return
    loadingBuckets = true
    bucketsError = null
    try {
      buckets = await ipc.natsKvBucketList(connId)
    } catch (e) {
      bucketsError = String(e)
    } finally {
      loadingBuckets = false
    }
  }

  function refresh() {
    void loadInfo()
    void loadBuckets()
    void explorer.loadStreaming(connId, 'nats', true)
  }

  $effect(() => {
    void connId
    untrack(() => {
      void loadInfo()
      void loadBuckets()
      void explorer.loadStreaming(connId, 'nats')
    })
  })

  function go(next: string, focus?: string) {
    tabs.patchState(tab.id, { section: next, focus, kvKey: undefined, subject: undefined })
  }
  function select(name: string | null) {
    tabs.patchState(tab.id, { focus: name ?? undefined, kvKey: undefined, subject: undefined }, false)
  }
  // A new tab opens on Streams with the first stream's first subject (autoPick, once).
  $effect(() => {
    if (!ws.autoPick || section !== 'streams' || !cache || cache.loading) return
    const first = untrack(() => firstByName(userRows.map((r) => r.name)))
    untrack(() => tabs.patchState(tab.id, first ? { autoPick: undefined, focus: first, sub: 'subjects' } : { autoPick: undefined }, false))
  })

  const sections: ShellSection[] = $derived([
    { id: 'overview', label: 'Overview' },
    { id: 'streams', label: 'Streams', count: cache?.natsStreams ? userRows.length : null },
    { id: 'kv', label: 'Key-value buckets', count: loadingBuckets && !buckets.length ? null : buckets.length || null },
    { id: 'objects', label: 'Object stores' },
    { id: 'messaging', label: 'Publish & subscribe' },
  ])
  // Publish & subscribe stays mounted once opened, so listening goes on while you look at
  // another section; closing the tab stops it.
  let messagingOpened = $state(false)
  $effect(() => {
    if (section === 'messaging') messagingOpened = true
  })

  const DESCRIPTIONS: Record<string, string> = {
    overview: 'A summary of the server: is it running, is persistence on, and how much of the account’s storage is used.',
    streams: 'Streams keep messages published on their subjects so they can be read later. Consumers are the readers of a stream.',
    kv: 'Key-value buckets store keys with values. A bucket can keep earlier versions of each key, and you can watch keys change live.',
    objects: 'Object stores keep files (backups, reports, models…) in buckets on the server, next to your streams.',
    messaging: 'Listen to a subject to see messages as they are published, or send a message yourself. Messages sent here are not stored unless a stream captures their subject.',
  }

  const status: ShellStatus | null = $derived.by(() => {
    if (section !== 'overview') return null
    if (accountError) return { tone: 'bad', headline: 'Could not read the account’s usage', detail: accountError, actionLabel: 'Try again', onAction: refresh }
    const s = natsStatus(account, info?.version ?? null, cache?.natsStreams && !loadingBuckets && !bucketsError ? { streams: userRows.length, buckets: buckets.length } : null)
    if (!s) return null
    return { ...s, ...(s.tone === 'warn' || s.tone === 'bad' ? (account?.enabled ? { actionLabel: 'Show streams', onAction: () => go('streams') } : {}) : {}) }
  })

  const cards: StatCard[] = $derived([
    { label: 'Server', value: info ? `NATS ${info.version}` : '—', sub: info ? `${info.server_name} · ${info.host}:${info.port}` : undefined },
    {
      label: 'Persistence (JetStream)',
      value: account ? (account.enabled ? 'Enabled' : 'Disabled') : '—',
      tone: account ? (account.enabled ? 'ok' : 'warn') : null,
      help: 'Stores messages so they can be read later. Streams and key-value buckets need it.',
      sub: account?.domain ? `domain ${account.domain}` : undefined,
    },
    {
      label: 'Storage used',
      value: account?.enabled ? formatBytes(account.storage) : '—',
      sub: account?.enabled ? (account.max_storage ? `of ${formatBytes(account.max_storage)}` : 'no limit set') : undefined,
      tone: account?.enabled ? usageTone(account.storage, account.max_storage) : null,
      help: 'Messages and values stored on disk by this account.',
    },
    {
      label: 'Memory used',
      value: account?.enabled ? formatBytes(account.memory) : '—',
      sub: account?.enabled ? (account.max_memory ? `of ${formatBytes(account.max_memory)}` : 'no limit set') : undefined,
      tone: account?.enabled ? usageTone(account.memory, account.max_memory) : null,
      help: 'Messages and values this account keeps in memory only.',
    },
    { label: 'Streams', value: cache?.natsStreams ? String(userRows.length) : '—', sub: systemCount ? `${plural(systemCount, 'more')} back buckets` : undefined, onClick: () => go('streams') },
    { label: 'Consumers', value: account?.enabled ? fullCount(account.consumers) : '—', help: 'Readers that keep their own position in a stream.' },
    { label: 'Key-value buckets', value: String(buckets.length), onClick: () => go('kv') },
  ])

  const largest = $derived([...userRows].sort((a, b) => b.bytes - a.bytes).slice(0, 5))
  const fullest = $derived([...buckets].sort((a, b) => b.bytes - a.bytes).slice(0, 5))

  // ---- streams ----
  // The list is a tree: each stream, then its subjects under it (parent → child).
  type Node = TreeNode<StreamRow>
  const streamCols: StreamColumn<Node>[] = [
    { key: 'name', label: 'Stream / subject', min: 'calc(var(--px-140) * 2)', sort: (n) => n.row.name, help: 'Each stream with the subjects it keeps messages for under it.' },
    { key: 'messages', label: 'Messages', align: 'right', width: 'var(--px-90)', sort: (n) => n.row.messages },
    { key: 'size', label: 'Size', align: 'right', width: 'var(--px-84)', sort: (n) => n.row.bytes },
    { key: 'consumers', label: 'Consumers', align: 'right', width: 'var(--px-96)', sort: (n) => n.row.consumers, help: 'Readers that keep their own position in this stream.' },
    { key: 'keep', label: 'Keeps messages for', width: 'var(--px-140)', sort: (n) => n.row.stream.max_age_ms || Number.MAX_SAFE_INTEGER },
  ]
  const colSort = new Map(streamCols.map((c) => [c.key, c.sort]))
  let collapsed = $state<Set<string>>(new Set())
  const nodes = $derived(streamNodes(shownRows, collapsed))
  function arrange(ns: Node[], query: string, sort: SortState | null): Node[] {
    return arrangeTree(ns, query, (streams) => sortRows(streams, sort, (n, key) => colSort.get(key)?.(n)))
  }
  function setOpen(name: string, open: boolean) {
    const next = new Set(collapsed)
    if (open) next.delete(name)
    else next.add(name)
    collapsed = next
  }
  // streams that have subjects to show — what "Expand all / Collapse all" acts on
  const foldable = $derived(nodes.filter((n) => n.kind === 'stream' && n.childCount).map((n) => n.row.name))
  const allOpen = $derived(foldable.every((name) => !collapsed.has(name)))
  function setAllOpen(open: boolean) {
    collapsed = open ? new Set() : new Set(foldable)
  }
  // Messages per subject: one metadata call per subject (the server totals it from
  // its subject index — no message is read), only for the streams that are open.
  // Keyed with the stream's message count so a stream that changed is counted again.
  let subjCounts = $state<Record<string, number | { error: string }>>({})
  const countKey = (stream: string, messages: number, subject: string) => `${subjectKey(stream, subject)}@${messages}`
  const counting = new Set<string>()
  async function countSubjects(want: { stream: string; subject: string; key: string }[]) {
    const queue = [...want]
    const lane = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const st = await ipc.natsJsSubjectStats(connId, job.stream, job.subject)
          subjCounts[job.key] = st.total
        } catch (e) {
          subjCounts[job.key] = { error: String(e) }
        } finally {
          counting.delete(job.key)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, lane))
  }
  $effect(() => {
    const want: { stream: string; subject: string; key: string }[] = []
    for (const n of nodes) {
      if (n.kind !== 'stream' || !n.expanded) continue
      for (const subject of n.row.subjects) {
        const key = countKey(n.row.name, n.row.messages, subject)
        if (counting.has(key) || untrack(() => key in subjCounts)) continue
        counting.add(key)
        want.push({ stream: n.row.name, subject, key })
      }
    }
    if (want.length) void countSubjects(want)
  })

  function pickNode(n: Node) {
    if (n.kind === 'stream') select(n.row.name)
    else tabs.patchState(tab.id, { focus: n.row.name, subject: n.subject, sub: 'subjects', kvKey: undefined }, false)
  }
  function toggleNode(n: Node, open: boolean) {
    if (n.kind === 'stream') setOpen(n.row.name, open)
    else if (!open) select(n.row.name) // ← on a subject goes up to its stream
  }
  const selectedNode = $derived(ws.focus ? (ws.subject ? subjectKey(ws.focus, ws.subject) : ws.focus) : null)

  const focusStream = $derived(section === 'streams' && ws.focus ? streams.find((s) => s.name === ws.focus) ?? null : null)
  const focusRow = $derived(focusStream ? rows.find((r) => r.name === focusStream.name) ?? null : null)
  const sub = $derived((ws.sub as 'subjects' | 'consumers' | 'config' | undefined) ?? 'subjects')
  const focusSubject = $derived(focusRow ? (ws.subject && focusRow.subjects.includes(ws.subject) ? ws.subject : firstByName(focusRow.subjects)) : null)
  // the embedded subject view reads stream + subject from a tab — give it one of its own
  const subjectTab = $derived<TabState | null>(focusStream && focusSubject ? { ...tab, state: { stream: focusStream.name, subject: focusSubject } } : null)

  let consumers = $state<ipc.NatsJsConsumer[]>([])
  let consumersError = $state<string | null>(null)
  let consumersLoading = $state(false)
  const cRows = $derived(consumerRows(consumers))
  async function loadConsumers(name: string) {
    consumersLoading = true
    consumersError = null
    try {
      const list = await ipc.natsJsConsumers(connId, name)
      if (focusStream?.name === name) consumers = list
    } catch (e) {
      consumersError = String(e)
    } finally {
      consumersLoading = false
    }
  }
  $effect(() => {
    const name = focusStream?.name
    untrack(() => {
      consumers = []
      if (name) void loadConsumers(name)
    })
  })

  // dangerous actions (rule U8): the dialog states the consequence with real numbers
  type Danger = { kind: 'purge' | 'delete' | 'consumer' | 'subject'; title: string; body: string; button: string; target: string }
  let danger = $state<Danger | null>(null)
  let dangerBusy = $state(false)
  let dangerError = $state<string | null>(null)

  function askPurge(r: StreamRow) {
    dangerError = null
    danger = { kind: 'purge', title: 'Clear all messages', target: r.name, body: `Clear all ${fullCount(r.messages)} messages from ${r.name}? The stream, its subjects and its consumers stay. This cannot be undone.`, button: `Clear ${fullCount(r.messages)} messages` }
  }
  function askDelete(r: StreamRow) {
    dangerError = null
    danger = { kind: 'delete', title: 'Delete stream', target: r.name, body: `Delete ${r.name} with its ${plural(r.messages, 'message')} and ${plural(r.consumers, 'consumer')}? Publishers on its subjects keep sending, but nothing will be stored. This cannot be undone.`, button: 'Delete stream' }
  }
  function askDeleteConsumer(c: ConsumerRow) {
    if (!focusStream) return
    dangerError = null
    danger = { kind: 'consumer', title: 'Delete consumer', target: c.name, body: `Delete consumer ${c.name} from ${focusStream.name}? Its read position is lost${c.waiting ? ` (${plural(c.waiting, 'message')} it had not read yet stay in the stream)` : ''}. An application using it will get errors. This cannot be undone.`, button: 'Delete consumer' }
  }

  // Remove one subject from the stream (kept from the old explorer tree): the
  // stream and its other subjects stay; the server refuses the last subject.
  function askRemoveSubject(s: string) {
    if (!focusStream) return
    dangerError = null
    danger = { kind: 'subject', title: 'Remove subject', target: s, body: `Remove ${s} from ${focusStream.name}? Its stored messages are cleared, and new messages published on ${s} are no longer kept by this stream. The stream and its other subjects stay. This cannot be undone.`, button: 'Remove subject' }
  }

  async function runDanger() {
    if (!danger || dangerBusy) return
    dangerBusy = true
    dangerError = null
    const d = danger
    try {
      if (d.kind === 'purge') {
        await ipc.natsJsPurgeStream(connId, d.target)
        toasts.success(`Cleared the messages of ${d.target}`)
        for (const s of focusRow?.subjects ?? []) explorer.bumpNatsSubject(connId, d.target, s)
      } else if (d.kind === 'delete') {
        await ipc.natsJsDeleteStream(connId, d.target) // verifies on the server
        toasts.success(`Deleted stream ${d.target}`)
        select(null)
      } else if (d.kind === 'subject' && focusStream) {
        await ipc.natsJsRemoveSubject(connId, focusStream.name, d.target)
        toasts.success(`Removed ${d.target} from ${focusStream.name}`)
        if (ws.subject === d.target) tabs.patchState(tab.id, { subject: undefined })
      } else if (focusStream) {
        await ipc.natsJsDeleteConsumer(connId, focusStream.name, d.target)
        toasts.success(`Deleted consumer ${d.target}`)
        await loadConsumers(focusStream.name)
      }
      danger = null
      await explorer.loadStreaming(connId, 'nats', true)
      void loadInfo()
    } catch (e) {
      dangerError = String(e)
    } finally {
      dangerBusy = false
    }
  }

  function setSub(next: 'subjects' | 'consumers' | 'config') {
    tabs.patchState(tab.id, { sub: next }, false)
  }

  // Open one message by its sequence number (JetStream "get message")
  let peekInput = $state('')
  let peekBusy = $state(false)
  let peekError = $state('')
  let peeked = $state<ipc.NatsJsMessage | null>(null)
  let peekedStream = $state('')
  async function peek() {
    const s = focusStream
    if (!s || peekBusy) return
    const range = { first: s.first_seq, last: s.last_seq }
    const parsed = parseSeq(peekInput, range)
    if ('error' in parsed) {
      peekError = parsed.error
      return
    }
    peekBusy = true
    peekError = ''
    try {
      peeked = await ipc.natsJsPeek(connId, s.name, parsed.seq)
      peekedStream = s.name
    } catch (e) {
      peekError = peekErrorText(e, s.name, parsed.seq, range)
    } finally {
      peekBusy = false
    }
  }
  // a different stream: the box and its answer belonged to the old one
  let peekFor = ''
  $effect(() => {
    const name = focusStream?.name ?? ''
    if (name === peekFor) return
    peekFor = name
    untrack(() => {
      peekInput = ''
      peekError = ''
    })
  })

  function when(iso: string | undefined): string {
    const t = iso ? Date.parse(iso) : NaN
    return Number.isFinite(t) ? relativeTime(t) : '—'
  }
  function whenExact(iso: string | undefined): string {
    const t = iso ? Date.parse(iso) : NaN
    return Number.isFinite(t) ? exactUtc(t) : ''
  }
</script>

<StreamShell
  system="nats"
  title={profile?.name ?? 'NATS'}
  subtitle={info ? `NATS ${info.version} · ${info.server_name} · ${info.host}:${info.port}` : loading ? 'Reading server…' : undefined}
  {sections}
  active={section}
  onSection={(id) => go(id)}
  {status}
  description={DESCRIPTIONS[section]}
  {loading}
  onRefresh={refresh}
>
  {#snippet actions()}
    {#if section === 'streams' || section === 'overview'}
      <button type="button" class="cfm-btn primary" onclick={() => natsCreateStream.show(connId)} disabled={persistence === false}>+ Create stream</button>
    {/if}
  {/snippet}

  {#if section === 'overview'}
    <div class="ds-body nc-overview">
      <StatCards items={cards} />
      {#if account?.enabled && (account.max_storage || account.max_memory)}
        <section class="nc-panel nc-usage" aria-label="Account usage">
          <div class="nc-panel-head"><span>Account usage</span></div>
          <div class="nc-usage-body">
            {#each [['Disk', account.storage, account.max_storage], ['Memory', account.memory, account.max_memory]] as [label, used, limit] (label)}
              {#if limit}
                {@const tone = usageTone(Number(used), Number(limit))}
                <div class="nc-meter-row">
                  <span class="nc-meter-label">{label}</span>
                  <div class="nc-meter" role="meter" aria-label="{label} used" aria-valuenow={Number(used)} aria-valuemin={0} aria-valuemax={Number(limit)}>
                    <span class="nc-meter-fill {tone}" style="width:{Math.min(100, (Number(used) / Number(limit)) * 100)}%"></span>
                  </div>
                  <span class="nc-meter-val">{usedOf(Number(used), Number(limit))}</span>
                </div>
              {/if}
            {/each}
          </div>
        </section>
      {/if}
      <div class="nc-two">
        <section class="nc-panel">
          <div class="nc-panel-head"><span>Largest streams</span><button type="button" class="nc-link" onclick={() => go('streams')}>All streams</button></div>
          {#if largest.length === 0}
            <div class="ds-empty">
              {#if cache?.loading}Reading streams…{:else if persistence === false}<b>Persistence is off</b>Streams need JetStream.{:else}<b>No streams yet</b>Streams keep messages so they can be read later.{/if}
            </div>
          {:else}
            <table class="ds-table flush">
              <thead><tr><th>Stream</th><th class="r">Messages</th><th class="r">Size</th><th>Keeps for</th></tr></thead>
              <tbody>
                {#each largest as r (r.name)}
                  <tr class="nc-click" onclick={() => go('streams', r.name)}>
                    <td><button type="button" class="nc-item ds-name" onclick={(e) => { e.stopPropagation(); go('streams', r.name) }}>{r.name}</button></td>
                    <td class="r ds-num nc-num" title={fullCount(r.messages)}>{compactCount(r.messages)}</td>
                    <td class="r ds-num">{formatBytes(r.bytes)}</td>
                    <td class="nc-dim">{r.keepFor}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
        <section class="nc-panel">
          <div class="nc-panel-head"><span>Key-value buckets</span><button type="button" class="nc-link" onclick={() => go('kv')}>All buckets</button></div>
          {#if bucketsError}
            <div class="ds-empty nc-bad">{bucketsError}</div>
          {:else if fullest.length === 0}
            <div class="ds-empty">{#if loadingBuckets}Reading buckets…{:else}<b>No key-value buckets yet</b>A bucket stores keys and their earlier versions.{/if}</div>
          {:else}
            <table class="ds-table flush">
              <thead><tr><th>Bucket</th><th class="r">Keys</th><th class="r">Versions kept</th><th>Keys expire after</th></tr></thead>
              <tbody>
                {#each fullest as b (b.bucket)}
                  <tr class="nc-click" onclick={() => go('kv', b.bucket)}>
                    <td><button type="button" class="nc-item ds-name" onclick={(e) => { e.stopPropagation(); go('kv', b.bucket) }}>{b.bucket}</button></td>
                    <td class="r ds-num">{fullCount(b.keys)}</td>
                    <td class="r ds-num">{b.history}</td>
                    <td class="nc-dim">{expireAfter(b.max_age_ms)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
      </div>
      {#if account}
        <AdvancedToggle>
          <table class="ds-table nc-raw">
            <tbody>
              <tr><th>jetstream</th><td class="mono">{account.enabled ? 'enabled' : `disabled — ${account.reason ?? ''}`}</td></tr>
              <tr><th>storage / max_storage</th><td class="mono">{account.storage} / {account.max_storage ?? -1}</td></tr>
              <tr><th>memory / max_memory</th><td class="mono">{account.memory} / {account.max_memory ?? -1}</td></tr>
              <tr><th>streams / max_streams</th><td class="mono">{account.streams} / {account.max_streams ?? -1}</td></tr>
              <tr><th>consumers / max_consumers</th><td class="mono">{account.consumers} / {account.max_consumers ?? -1}</td></tr>
              <tr><th>api requests / errors</th><td class="mono">{account.api_total} / {account.api_errors}</td></tr>
              {#if info}<tr><th>server_name · go</th><td class="mono">{info.server_name} · {info.go} · max_payload {info.max_payload}</td></tr>{/if}
            </tbody>
          </table>
        </AdvancedToggle>
      {/if}
    </div>
  {:else if section === 'streams'}
    {#if persistence === false}
      <div class="ds-empty nc-off"><b>Streams need persistence (JetStream)</b>JetStream is not enabled for this account, so the server cannot keep messages. Enable it on the server (start nats-server with -js), then refresh.</div>
    {:else}
      <!-- the details host a subject's message list: give them more room by default -->
      <SplitDetail storeKey="nats-streams" open={!!focusStream} initial={32}>
        {#snippet list()}
          <StreamTable
            rows={nodes}
            columns={streamCols}
            rowKey={(n) => n.key}
            ariaLabel="Streams"
            selected={selectedNode}
            onSelect={pickNode}
            onOpen={(n) => (n.kind === 'stream' ? setOpen(n.row.name, !n.expanded) : pickNode(n))}
            filterText={(n) => `${n.row.name} ${n.row.subjects.join(' ')}`}
            {arrange}
            rowLevel={(n) => n.depth}
            rowExpanded={(n) => (n.kind === 'stream' && n.childCount ? n.expanded : undefined)}
            rowKind={(n) => n.kind}
            onToggle={toggleNode}
            filterPlaceholder="Filter streams and subjects…"
            initialSort={{ key: 'name', dir: 'asc' }}
            loading={!!cache?.loading}
            error={cache?.error ?? null}
            emptyTitle="No streams yet"
            emptyBody="Streams keep the messages published on their subjects so applications can read them later."
            emptyActionLabel="+ Create stream"
            onEmptyAction={() => natsCreateStream.show(connId)}
            note={!showSystem && systemCount ? `${plural(systemCount, 'stream')} that back key-value buckets or object stores hidden.` : null}
          >
            {#snippet tools()}
              {#if foldable.length}
                <button type="button" class="eg-btn nc-fold" onclick={() => setAllOpen(!allOpen)} aria-label={allOpen ? 'Collapse all' : 'Expand all'} title={allOpen ? 'Collapse every stream — or press ← on a stream' : 'Expand every stream — or press → on a stream'}>
                  <Icon name={allOpen ? 'fold' : 'unfold'} size={13} />
                </button>
              {/if}
              {#if systemCount}
                <label class="nc-check"><input type="checkbox" bind:checked={showSystem} /> Show bucket streams</label>
              {/if}
            {/snippet}
            {#snippet cell(n, c)}
              {@const r = n.row}
              {#if n.kind === 'subject'}
                {#if c.key === 'name'}<span class="nc-tree-sub"><span class="mono nc-subj nc-fit" title={n.subject}>{n.subject}</span></span>
                {:else if c.key === 'messages'}
                  {@const v = subjCounts[countKey(r.name, r.messages, n.subject)]}
                  {#if typeof v === 'number'}<span class="ds-num nc-num" data-subject-count={n.subject} title="{fullCount(v)} messages on {n.subject}">{compactCount(v)}</span>
                  {:else if v}<span class="nc-dim" data-subject-count={n.subject} title="Could not count: {v.error}">?</span>
                  {:else}<span class="nc-dim" data-subject-count={n.subject} aria-label="Counting messages">…</span>{/if}
                {/if}
              {:else if c.key === 'name'}
                <span class="nc-tree-stream">
                  {#if n.childCount}
                    <button type="button" class="nc-twist" onclick={(e) => { e.stopPropagation(); setOpen(r.name, !n.expanded) }} aria-label="{n.expanded ? 'Collapse' : 'Expand'} {r.name}" title="{n.expanded ? 'Collapse' : 'Expand'} — or double-click the row, or press {n.expanded ? '←' : '→'}" tabindex="-1"><Chevron open={n.expanded} size={12} /></button>
                  {:else}<span class="nc-twist" aria-hidden="true"></span>{/if}
                  <span class="ds-name nc-fit" class:nc-dim={r.system} title={r.name}>{r.name}</span>
                  {#if n.childCount}
                    <button type="button" class="nc-subj-count nc-count-btn" onclick={(e) => { e.stopPropagation(); setOpen(r.name, !n.expanded) }} title="{n.expanded ? 'Hide' : 'Show'} the subjects of {r.name}" tabindex="-1"><span class="nc-fit">{plural(n.childCount, 'subject')}</span></button>
                  {:else}<span class="nc-subj-count">{plural(n.childCount, 'subject')}</span>{/if}
                </span>
              {:else if c.key === 'messages'}<span class="ds-num nc-num" title={fullCount(r.messages)}>{compactCount(r.messages)}</span>
              {:else if c.key === 'size'}<span class="ds-num">{formatBytes(r.bytes)}</span>
              {:else if c.key === 'consumers'}<span class="ds-num">{r.consumers}</span>
              {:else if c.key === 'keep'}<span class:nc-dim={r.keepFor === 'Forever'}>{r.keepFor}</span>
              {/if}
            {/snippet}
          </StreamTable>
        {/snippet}
        {#snippet detail()}
          {#if focusStream && focusRow}
            {@const ret = retentionWords(focusStream.retention)}
            <div class="nc-detail">
              <div class="nc-detail-head">
                <span class="nc-detail-title mono">{focusStream.name}</span>
                <button type="button" class="nc-close" onclick={() => select(null)} aria-label="Close details" title="Close details">×</button>
              </div>
              {#if focusStream.description}<p class="nc-desc">{focusStream.description}</p>{/if}
              <div class="nc-facts">
                <span class="ds-chip">{plural(focusRow.messages, 'message')}</span>
                <span class="ds-chip">{formatBytes(focusRow.bytes)}</span>
                <span class="ds-chip">Keeps messages for {keepFor(focusStream.max_age_ms).toLowerCase()}</span>
                <span class="ds-chip" title={ret.help}>{ret.label}</span>
                <span class="ds-chip">{storedWords(focusStream.storage, focusStream.replicas)}</span>
                {#if focusStream.last_time}<span class="ds-chip" title={whenExact(focusStream.last_time)}>Last message {when(focusStream.last_time)}</span>{/if}
              </div>
              <div class="nc-actions">
                <button type="button" class="cfm-btn" onclick={() => natsAddWizard.show(connId, focusStream.name, '', true)}>+ Add subject…</button>
                <form class="nc-peek" onsubmit={(e) => { e.preventDefault(); void peek() }} title={seqRangeHint({ first: focusStream.first_seq, last: focusStream.last_seq }) || undefined}>
                  <label class="ds-search sm nc-peek-box">
                    <span class="nc-peek-hash" aria-hidden="true">#</span>
                    <input bind:value={peekInput} inputmode="numeric" placeholder="Sequence" aria-label="Message sequence number" oninput={() => (peekError = '')} />
                  </label>
                  <button type="submit" class="cfm-btn" disabled={peekBusy || !peekInput.trim()} aria-busy={peekBusy}>{peekBusy ? 'Opening…' : 'Open message'}</button>
                </form>
                <span class="nc-flex"></span>
                <button type="button" class="cfm-btn ds-danger-outline" onclick={() => askPurge(focusRow)} disabled={focusRow.messages === 0} title={focusRow.messages === 0 ? 'The stream holds no messages' : undefined}>Clear all messages…</button>
                <button type="button" class="cfm-btn ds-danger-outline" onclick={() => askDelete(focusRow)}>Delete stream…</button>
              </div>
              {#if peekError}<div class="nc-error nc-peek-error" role="alert">{peekError}</div>{/if}
              <div class="nc-subtabs" role="tablist" aria-label="Stream details">
                {#each [['subjects', `Subjects ${focusRow.subjects.length}`], ['consumers', `Consumers${consumers.length ? ` ${consumers.length}` : ''}`], ['config', 'Settings']] as [id, label] (id)}
                  <button type="button" role="tab" class="nc-subtab" class:on={sub === id} aria-selected={sub === id} onclick={() => setSub(id as 'subjects' | 'consumers' | 'config')}>{label}</button>
                {/each}
              </div>
              {#if sub === 'subjects'}
                <div class="nc-subjects">
                  {#if focusSubject}<span class="nc-subject-label">Messages on <span class="mono" data-nats-current-subject>{focusSubject}</span>{#if focusRow.subjects.length > 1}<span class="nc-dim">{' · '}pick another subject in the list</span>{/if}</span>{/if}
                  {#if focusSubject && focusRow.subjects.length > 1}
                    <button type="button" class="nc-link nc-danger-link nc-remove-subj" onclick={() => focusSubject && askRemoveSubject(focusSubject)}>Remove <span class="mono">{focusSubject}</span>…</button>
                  {/if}
                </div>
                {#if subjectTab}
                  {#key `${focusStream.name}:${focusSubject}`}
                    <div class="nc-embed" data-nats-subject-view={focusSubject}><NatsSubjectMessages tab={subjectTab} embedded /></div>
                  {/key}
                {:else}
                  <div class="ds-empty"><b>This stream has no subjects</b>Add a subject so the stream keeps the messages published on it.</div>
                {/if}
              {:else if sub === 'consumers'}
                {#if consumersError}
                  <div class="nc-error" role="alert">Could not read the consumers: {consumersError}</div>
                {:else if consumersLoading && consumers.length === 0}
                  <div class="ds-empty" aria-busy="true">Reading consumers…</div>
                {:else if cRows.length === 0}
                  <div class="ds-empty"><b>No consumers yet</b>A consumer appears when an application starts reading this stream with its own saved position.</div>
                {:else}
                  <div class="nc-scroll">
                    <table class="ds-table nc-parts">
                      <thead>
                        <tr>
                          <th>Consumer</th>
                          <th>Reads</th>
                          <th>Starts at</th>
                          <th>Acknowledgement</th>
                          <th class="r" title="Messages it has not received yet">Waiting <HelpTip text="Messages this consumer has not received yet." size={11} /></th>
                          <th class="r" title="Received but not acknowledged yet">Unacknowledged <HelpTip text="Messages it received but has not confirmed as processed." size={11} /></th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each cRows as c (c.name)}
                          <tr>
                            <td><span class="ds-name">{c.name}</span></td>
                            <td class="mono nc-subj">{c.reads}</td>
                            <td>{c.deliver}</td>
                            <td class="nc-dim">{c.ack}</td>
                            <td class="r ds-num" class:nc-warn={c.waiting > 0} class:nc-ok={c.waiting === 0}>{c.waiting === 0 ? 'None' : fullCount(c.waiting)}</td>
                            <td class="r ds-num" class:nc-warn={c.unacked > 0}>{c.unacked === 0 ? 'None' : fullCount(c.unacked)}</td>
                            <td class="r"><button type="button" class="nc-link nc-danger-link" onclick={() => askDeleteConsumer(c)} aria-label="Delete consumer {c.name}">Delete…</button></td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                  <AdvancedToggle>
                    <table class="ds-table nc-parts">
                      <thead><tr><th>name</th><th>deliver_policy</th><th>ack_policy</th><th>filter_subjects</th><th class="r">ack floor</th><th class="r">delivered</th></tr></thead>
                      <tbody>
                        {#each consumers as c (c.name)}
                          <tr><td class="mono">{c.name}</td><td class="mono">{c.deliver_policy}</td><td class="mono">{c.ack_policy}</td><td class="mono">{(c.filter_subjects ?? [c.filter_subject]).join(', ') || '—'}</td><td class="r mono">{c.ack_floor_stream_seq ?? '—'}</td><td class="r mono">{c.delivered_stream_seq ?? '—'}</td></tr>
                        {/each}
                      </tbody>
                    </table>
                  </AdvancedToggle>
                {/if}
              {:else}
                <dl class="nc-config">
                  {#each streamConfigWords(focusStream) as w (w.label)}
                    <div><dt>{w.label}{#if w.help} <HelpTip text={w.help} size={11} />{/if}</dt><dd>{w.value}</dd></div>
                  {/each}
                </dl>
                <AdvancedToggle>
                  <table class="ds-table nc-raw">
                    <tbody>
                      <tr><th>retention</th><td class="mono">{focusStream.retention}</td></tr>
                      <tr><th>storage</th><td class="mono">{focusStream.storage}</td></tr>
                      <tr><th>max_age (ms)</th><td class="mono">{focusStream.max_age_ms ?? '—'}</td></tr>
                      <tr><th>max_msgs</th><td class="mono">{focusStream.max_msgs ?? '—'}</td></tr>
                      <tr><th>max_bytes</th><td class="mono">{focusStream.max_bytes ?? '—'}</td></tr>
                      <tr><th>max_msgs_per_subject</th><td class="mono">{focusStream.max_msgs_per_subject ?? '—'}</td></tr>
                      <tr><th>max_msg_size</th><td class="mono">{focusStream.max_msg_size ?? '—'}</td></tr>
                      <tr><th>discard</th><td class="mono">{focusStream.discard ?? '—'}</td></tr>
                      <tr><th>num_replicas</th><td class="mono">{focusStream.replicas ?? '—'}</td></tr>
                      <tr><th>duplicate_window (ms)</th><td class="mono">{focusStream.duplicate_window_ms ?? '—'}</td></tr>
                      <tr><th>first_seq · last_seq</th><td class="mono">{focusStream.first_seq ?? '—'} · {focusStream.last_seq ?? '—'}</td></tr>
                      <tr><th>created</th><td class="mono">{focusStream.created ?? '—'}</td></tr>
                      <tr><th>subjects</th><td class="mono">{focusStream.subjects.join(', ')}</td></tr>
                    </tbody>
                  </table>
                </AdvancedToggle>
              {/if}
            </div>
          {/if}
        {/snippet}
      </SplitDetail>
      {#if peeked}
        <PayloadDialog
          title={`Message #${peeked.seq.toLocaleString('en-US')}`}
          system="nats"
          subtitle={`NATS message · stream ${peekedStream}`}
          facts={[
            { label: 'Stream', value: peekedStream },
            { label: 'Subject', value: peeked.subject, mono: true },
            { label: 'Sequence', value: peeked.seq },
            { label: 'Time', value: whenExact(peeked.time) || peeked.time },
            ...(peeked.key ? [{ label: 'Key', value: peeked.key, mono: true }] : []),
          ]}
          text={peeked.payload}
          onClose={() => (peeked = null)}
        />
      {/if}
    {/if}
  {:else if section === 'kv'}
    <NatsKvSection
      {connId}
      tabId={tab.id}
      {buckets}
      loading={loadingBuckets}
      error={bucketsError}
      {persistence}
      focus={ws.focus ?? null}
      keyFocus={ws.kvKey ?? null}
      onSelect={(b) => select(b)}
      onSelectKey={(k) => tabs.patchState(tab.id, { kvKey: k ?? undefined }, false)}
      onReload={async () => {
        await loadBuckets()
        void loadInfo()
      }}
    />
  {:else if section === 'objects'}
    <NatsObjectStore {connId} {persistence} />
  {/if}
  {#if messagingOpened}
    <div class="nc-keep" hidden={section !== 'messaging'}>
      <NatsMessaging {connId} />
    </div>
  {/if}
</StreamShell>

{#if danger}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !dangerBusy && (danger = null)}>
    <div class="um-dlg sm" role="alertdialog" aria-modal="true" aria-label={danger.title} tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
        <div class="um-dlg-title"><b>{danger.title}</b><span class="mono">{danger.target}</span></div>
      </div>
      <div class="um-dlg-body">
        <p class="nc-confirm">{danger.body}</p>
        {#if dangerError}<div class="nc-error" role="alert">{dangerError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="nc-flex"></span>
        <button type="button" class="cfm-btn" use:autofocus onclick={() => (danger = null)} disabled={dangerBusy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={runDanger} disabled={dangerBusy}>{dangerBusy ? 'Working…' : danger.button}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .nc-overview {
    gap: var(--px-18);
  }
  .nc-keep {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .nc-keep[hidden] {
    display: none;
  }
  .nc-two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--px-420), 1fr));
    gap: var(--px-18);
  }
  .nc-panel {
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
    overflow: hidden;
    box-shadow: var(--shadow-xs);
  }
  .nc-panel-head {
    display: flex;
    align-items: center;
    padding: var(--px-10) var(--px-14);
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
    border-bottom: var(--px-1) solid var(--border);
  }
  .nc-panel-head span {
    flex: 1;
  }
  .nc-usage-body {
    padding: var(--px-12) var(--px-14);
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
  }
  .nc-meter-row {
    display: grid;
    grid-template-columns: var(--px-70) 1fr auto;
    align-items: center;
    gap: var(--px-12);
    font-size: var(--px-12_5);
  }
  .nc-meter-label {
    color: var(--text2);
    font-weight: 500;
  }
  .nc-meter {
    height: var(--px-8);
    border-radius: var(--px-4);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    overflow: hidden;
  }
  .nc-meter-fill {
    display: block;
    height: 100%;
    background: var(--sacc-green);
  }
  .nc-meter-fill.warn {
    background: var(--sacc-amber);
  }
  .nc-meter-fill.bad {
    background: var(--danger-solid);
  }
  .nc-meter-val {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .nc-link {
    border: 0;
    background: transparent;
    font-family: var(--font-main);
    font-size: var(--px-12);
    font-weight: 500;
    color: var(--primary);
    cursor: pointer;
    padding: var(--px-2) var(--px-4);
    border-radius: var(--px-5);
  }
  .nc-link:hover {
    text-decoration: underline;
  }
  .nc-danger-link {
    color: var(--danger-text);
  }
  .ds-table .r,
  .nc-parts .r {
    text-align: right;
  }
  .nc-click {
    cursor: pointer;
  }
  .nc-item {
    border: 0;
    background: transparent;
    padding: 0;
    font-size: var(--px-12_5);
    cursor: pointer;
  }
  .nc-tree-stream,
  .nc-tree-sub {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    min-width: 0;
    width: 100%;
  }
  .nc-fit {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nc-tree-sub {
    padding-left: var(--px-26);
  }
  .nc-twist {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-22);
    height: var(--px-22);
    margin-left: calc(var(--px-3) * -1);
    margin-right: calc(var(--px-3) * -1);
    padding: 0;
    border: 0;
    border-radius: var(--px-4);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  button.nc-twist:hover {
    background: var(--hover);
    color: var(--text);
  }
  .nc-subj-count {
    font-size: var(--px-11_5);
    color: var(--muted);
    white-space: nowrap;
    flex: 0 1000 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .nc-count-btn {
    display: flex;
    border: 0;
    background: transparent;
    padding: var(--px-2) var(--px-4);
    border-radius: var(--px-4);
    font-family: var(--font-main);
    cursor: pointer;
  }
  .nc-count-btn:hover {
    background: var(--hover);
    color: var(--text2);
  }
  .nc-fold {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
  }
  .nc-subject-label {
    font-size: var(--px-12_5);
    color: var(--text2);
  }
  .nc-subj {
    color: var(--tbl-child);
    font-size: var(--px-12);
  }
  .nc-dim {
    color: var(--muted);
  }
  .nc-num {
    color: var(--tbl-cell);
  }
  .nc-ok {
    color: var(--sacc-green);
    font-weight: 500;
  }
  .nc-warn {
    color: var(--sacc-amber);
    font-weight: 600;
  }
  .nc-bad {
    color: var(--danger-text);
  }
  .nc-off {
    margin: var(--px-18);
  }
  .nc-check {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .nc-detail {
    padding: var(--px-14) var(--px-18) var(--px-18);
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
    flex: 1;
    min-height: 0;
  }
  .nc-detail-head {
    display: flex;
    align-items: center;
    gap: var(--px-10);
  }
  .nc-detail-title {
    flex: 1;
    min-width: 0;
    font-size: var(--px-15);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nc-desc {
    margin: 0;
    color: var(--text2);
    font-size: var(--px-12_5);
  }
  .nc-close {
    border: 0;
    background: transparent;
    font-size: var(--px-18);
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    padding: var(--px-2) var(--px-6);
    border-radius: var(--px-6);
  }
  .nc-close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .nc-facts,
  .nc-actions,
  .nc-subjects {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-8);
  }
  .nc-remove-subj {
    margin-left: auto;
  }
  .nc-peek {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    margin: 0;
  }
  .nc-peek-box {
    width: var(--px-120);
  }
  .nc-peek-hash {
    color: var(--muted);
    font-size: var(--px-12);
  }
  .nc-peek-error {
    margin: 0;
  }
  .nc-flex {
    flex: 1;
  }
  .nc-subtabs {
    display: flex;
    gap: var(--px-4);
    border-bottom: var(--px-1) solid var(--border);
  }
  .nc-subtab {
    border: 0;
    background: transparent;
    padding: var(--px-6) var(--px-10);
    font-family: var(--font-main);
    font-size: var(--px-12_5);
    font-weight: 500;
    color: var(--text2);
    cursor: pointer;
    box-shadow: inset 0 calc(-1 * var(--px-2)) 0 transparent;
  }
  .nc-subtab.on {
    color: var(--text);
    font-weight: 600;
    box-shadow: inset 0 calc(-1 * var(--px-2)) 0 var(--primary);
  }
  .nc-embed {
    flex: 1;
    min-height: var(--px-520);
    display: flex;
    flex-direction: column;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    overflow: hidden;
    background: var(--surface);
  }
  .nc-scroll {
    overflow-x: auto;
  }
  .nc-parts td,
  .nc-parts th {
    white-space: nowrap;
  }
  .nc-config {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--px-220), 1fr));
    gap: var(--px-12) var(--px-18);
  }
  .nc-config dt {
    font-size: var(--px-11_5);
    color: var(--muted);
    font-weight: 500;
  }
  .nc-config dd {
    margin: var(--px-2) 0 0;
    font-size: var(--px-13);
    color: var(--text);
    font-weight: 500;
  }
  .nc-raw th {
    width: var(--px-220);
    font-family: var(--font-mono);
    font-weight: 500;
  }
  .nc-confirm {
    margin: 0;
    line-height: 1.5;
    color: var(--text2);
  }
  .nc-error {
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    background: var(--danger-soft);
    color: var(--danger-text);
    font-size: var(--px-12_5);
  }
</style>
