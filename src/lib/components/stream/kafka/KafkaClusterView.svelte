<script lang="ts">
  // Kafka cluster workspace (SPEC-KAFKA-WORKSPACE.md). Overview, Brokers, Topics,
  // Consumer groups and Schema Registry, built on the shared stream shell. Everything shown is derived
  // from metadata the app already reads — nothing is invented (rule 3).
  // Topics come from the same cache as the Explorer tree, so creating, clearing or
  // deleting a topic anywhere updates both.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import type { TabState } from '$lib/types'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { firstByName } from '$lib/stream/workspace-systems'
  import { kafkaTopicWizard } from '$lib/stores/kafkaTopic.svelte'
  import StreamShell, { type ShellSection, type ShellStatus } from '../StreamShell.svelte'
  import StreamTable, { type StreamColumn } from '../StreamTable.svelte'
  import SplitDetail from '../SplitDetail.svelte'
  import StatCards, { type StatCard } from '../StatCards.svelte'
  import HelpTip from '../HelpTip.svelte'
  import AdvancedToggle from '../AdvancedToggle.svelte'
  import SchemaRegistryWorkspace from '$lib/components/workspace/SchemaRegistryWorkspace.svelte'
  import { kafkaHealth, topicRows, type BrokerStats, type TopicRow } from '$lib/stream/kafka-health'
  import { compactCount, fullCount, plural } from '$lib/stream/humanize'
  import { cleanHost, groupRows, groupState, type GroupRow } from '$lib/stream/kafka-groups'
  import ChangeReadPositionDialog from './ChangeReadPositionDialog.svelte'
  import TopicConfigPanel from './TopicConfigPanel.svelte'
  import KafkaConsumer from '$lib/components/workspace/KafkaConsumer.svelte'
  import KafkaProducer from '$lib/components/workspace/KafkaProducer.svelte'
  import { produceDraftFrom, type ProduceDraft } from '$lib/stream/kafka-produce'
  import KafkaPartitionsDialog from '$lib/components/explorer/KafkaPartitionsDialog.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import '$lib/components/workspace/users/um.css'

  let { tab }: { tab: TabState } = $props()

  const connId = $derived(tab.connectionId ?? '')
  const profile = $derived(connections.byId(connId))
  const ws = $derived(tab.state as { section?: string; focus?: string; sub?: string; autoPick?: boolean })
  const section = $derived(ws.section ?? 'overview')

  let cluster = $state<ipc.KafkaCluster | null>(null)
  let clusterError = $state<string | null>(null)
  let loadingCluster = $state(false)
  let showInternal = $state(false)

  const cache = $derived(explorer.streaming[connId])
  const topics = $derived(cache?.kafkaTopics ?? [])
  const health = $derived(kafkaHealth(cluster, topics))
  const rows = $derived(topicRows(topics))
  const shownRows = $derived(showInternal ? rows : rows.filter((r) => !r.internal))
  const internalCount = $derived(rows.length - rows.filter((r) => !r.internal).length)
  // consumer groups + how far behind each one is (one lag read per group)
  let groups = $state<ipc.KafkaGroup[]>([])
  let groupLags = $state<Record<string, ipc.KafkaLag[] | null>>({})
  let groupsError = $state<string | null>(null)
  let loadingGroups = $state(false)
  const gRows = $derived(groupRows(groups, groupLags))
  const totalBehind = $derived(gRows.some((g) => g.behind == null) && gRows.length ? null : gRows.reduce((s, g) => s + (g.behind ?? 0), 0))
  const furthest = $derived([...gRows].filter((g) => (g.behind ?? 0) > 0).sort((a, b) => (b.behind ?? 0) - (a.behind ?? 0)).slice(0, 5))

  const loading = $derived(loadingCluster || loadingGroups || !!cache?.loading)

  async function loadGroups() {
    if (!connId) return
    loadingGroups = true
    groupsError = null
    try {
      const list = await ipc.kafkaConsumerGroups(connId)
      const lags = await Promise.allSettled(list.map((g) => ipc.kafkaGroupLag(connId, g.name)))
      const next: Record<string, ipc.KafkaLag[] | null> = {}
      list.forEach((g, i) => {
        const r = lags[i]
        next[g.name] = r.status === 'fulfilled' ? r.value : null
      })
      groups = list
      groupLags = next
    } catch (e) {
      groupsError = String(e)
    } finally {
      loadingGroups = false
    }
  }

  // dialogs
  let resetFor = $state<string | null>(null)
  let deleteFor = $state<string | null>(null)
  let deleteBusy = $state(false)
  let deleteError = $state<string | null>(null)
  // the topic details' screen lives in the tab state, so "View messages" anywhere
  // (Explorer, Topics table) can open the workspace straight on it
  type TopicTab = 'messages' | 'partitions' | 'consumers' | 'settings' | 'produce'
  const TOPIC_TABS: TopicTab[] = ['messages', 'partitions', 'consumers', 'settings', 'produce']
  const topicTab = $derived<TopicTab>(TOPIC_TABS.includes(ws.sub as TopicTab) ? (ws.sub as TopicTab) : 'partitions')
  function showTopicTab(sub: TopicTab) {
    // a copied message fills Produce once; leaving the screen drops it
    if (sub !== 'produce') produceDraft = null
    tabs.patchState(tab.id, { sub })
  }
  // "Copy to Produce" on a message: the Produce screen opens filled with it
  let produceDraft = $state<{ topic: string; draft: ProduceDraft } | null>(null)
  let draftSeq = $state(0)
  function copyToProduce(topicName: string, m: ipc.KafkaMsg) {
    produceDraft = { topic: topicName, draft: produceDraftFrom(m) }
    draftSeq++
    showTopicTab('produce')
  }

  // Edit partitions — moved here from the old explorer tree's context menu.
  let partitionsFor = $state<{ topic: string; current: number } | null>(null)

  // Delete topic — moved here from the old explorer tree's context menu.
  let deleteTopicFor = $state<string | null>(null)
  let deleteTopicBusy = $state(false)
  let deleteTopicError = $state<string | null>(null)
  async function deleteTopic() {
    if (!deleteTopicFor || deleteTopicBusy) return
    deleteTopicBusy = true
    deleteTopicError = null
    const name = deleteTopicFor
    try {
      await ipc.kafkaDeleteTopic(connId, name)
      toasts.success(`Deleted topic ${name}`)
      deleteTopicFor = null
      if (ws.focus === name) select(null)
      await explorer.loadStreaming(connId, 'kafka', true)
    } catch (e) {
      deleteTopicError = String(e)
    } finally {
      deleteTopicBusy = false
    }
  }

  async function deleteGroup() {
    if (!deleteFor || deleteBusy) return
    deleteBusy = true
    deleteError = null
    const name = deleteFor
    try {
      await ipc.kafkaDeleteGroup(connId, name)
      toasts.success(`Deleted consumer group ${name}`)
      deleteFor = null
      if (ws.focus === name) select(null)
      await loadGroups()
    } catch (e) {
      deleteError = String(e)
    } finally {
      deleteBusy = false
    }
  }

  async function loadCluster() {
    if (!connId) return
    loadingCluster = true
    clusterError = null
    try {
      cluster = await ipc.kafkaCluster(connId)
    } catch (e) {
      clusterError = String(e)
    } finally {
      loadingCluster = false
    }
  }

  function refresh() {
    void loadCluster()
    void loadGroups()
    void explorer.loadStreaming(connId, 'kafka', true)
  }

  $effect(() => {
    void connId
    untrack(() => {
      void loadCluster()
      void loadGroups()
      void explorer.loadStreaming(connId, 'kafka')
    })
  })

  function go(next: string, focus?: string) {
    tabs.patchState(tab.id, { section: next, focus })
  }
  function select(name: string | null) {
    tabs.patchState(tab.id, { focus: name ?? undefined }, false)
  }
  // A new tab opens on Topics with the first topic's messages (autoPick, once).
  $effect(() => {
    if (!ws.autoPick || section !== 'topics' || !cache || cache.loading) return
    const first = untrack(() => firstByName(shownRows.map((r) => r.name)))
    untrack(() => tabs.patchState(tab.id, first ? { autoPick: undefined, focus: first, sub: 'messages' } : { autoPick: undefined }, false))
  })

  const sections: ShellSection[] = $derived([
    { id: 'overview', label: 'Overview' },
    { id: 'brokers', label: 'Brokers', count: cluster ? cluster.brokers.length : null },
    { id: 'topics', label: 'Topics', count: health.topicCount, badge: health.missingCopies.length ? `${health.missingCopies.length} missing copies` : null },
    { id: 'groups', label: 'Consumer groups', count: groups.length || null, badge: totalBehind ? `${compactCount(totalBehind)} behind` : null },
    { id: 'registry', label: 'Schema Registry' },
  ])

  const DESCRIPTIONS: Record<string, string> = {
    overview: 'A summary of the whole cluster: is it healthy, and what needs attention.',
    brokers: 'Brokers are the servers of the cluster. Each partition has one leader broker and copies on others; a copy is “behind” when it has not caught up with the leader.',
    topics: 'Topics hold your messages. A topic is split into partitions; each partition keeps several copies on different brokers.',
    groups: 'Consumer groups are the applications reading from this cluster. “Behind” = messages they have not read yet.',
    registry: 'Schemas describe the shape of messages so producers and consumers agree on it.',
  }

  const status: ShellStatus | null = $derived.by(() => {
    if (section !== 'overview') return null
    if (clusterError) return { tone: 'bad', headline: 'Could not read the cluster', detail: clusterError, actionLabel: 'Try again', onAction: refresh }
    if (!cluster) return null
    return {
      tone: health.tone,
      headline: health.headline,
      detail: health.detail,
      ...(health.missingCopies.length || health.unavailable.length ? { actionLabel: 'Show affected topics', onAction: () => go('topics') } : {}),
    }
  })

  const cards: StatCard[] = $derived([
    { label: 'Brokers', value: cluster ? String(cluster.brokers.length) : '—', sub: cluster ? `controller: broker ${cluster.controller_id}` : undefined, onClick: () => go('brokers') },
    { label: 'Topics', value: String(health.topicCount), sub: internalCount ? `${internalCount} internal not counted` : undefined, onClick: () => go('topics') },
    { label: 'Partitions', value: fullCount(health.partitionCount), help: 'Topics are split into partitions; messages keep their order within a partition.' },
    { label: 'Missing copies', value: String(health.missingCopies.length), tone: health.missingCopies.length ? 'warn' : 'ok', sub: health.missingCopies.length ? 'partitions not fully copied' : 'every copy is up to date', help: 'Partitions with fewer up-to-date copies than configured.' },
    { label: 'Unavailable', value: String(health.unavailable.length), tone: health.unavailable.length ? 'bad' : 'ok', sub: health.unavailable.length ? 'partitions without a leader' : 'all partitions are served', help: 'Partitions no broker is serving: reads and writes to them fail.' },
    { label: 'Messages kept', value: health.messages == null ? '?' : compactCount(health.messages), tone: 'num', sub: health.messages == null ? 'some offsets could not be read' : 'across your topics', help: 'Messages currently stored, from the oldest to the newest position of each partition.' },
    { label: 'Messages behind', value: totalBehind == null ? '?' : compactCount(totalBehind), tone: totalBehind ? 'warn' : 'ok', sub: groups.length ? `not yet read by ${plural(groups.length, 'group')}` : 'no consumer groups', help: 'Messages the consumer groups have not read yet.', onClick: () => go('groups') },
  ])

  const largest = $derived([...shownRows].filter((r) => r.messages != null).sort((a, b) => (b.messages ?? 0) - (a.messages ?? 0)).slice(0, 5))

  // ---- brokers table ----
  const brokerCols: StreamColumn<BrokerStats>[] = [
    { key: 'id', label: 'Broker', width: 'var(--px-90)', sort: (b) => b.id },
    { key: 'host', label: 'Address', sort: (b) => `${b.host}:${b.port}` },
    { key: 'role', label: 'Role', width: 'var(--px-130)', sort: (b) => (b.isController ? 0 : 1), help: 'The controller manages the cluster: it elects partition leaders.' },
    { key: 'leads', label: 'Leads', align: 'right', width: 'var(--px-120)', sort: (b) => b.leads, help: 'Partitions this broker is the leader for (it serves their reads and writes).' },
    { key: 'holds', label: 'Holds copies', align: 'right', width: 'var(--px-130)', sort: (b) => b.holds, help: 'Partition copies stored on this broker.' },
    { key: 'behind', label: 'Copies behind', align: 'right', width: 'var(--px-140)', sort: (b) => b.behind, help: 'Copies on this broker that have not caught up with their leader.' },
  ]

  // ---- topics table ----
  const topicCols: StreamColumn<TopicRow>[] = [
    { key: 'name', label: 'Topic', sort: (r) => r.name },
    { key: 'partitions', label: 'Partitions', align: 'right', width: 'var(--px-110)', sort: (r) => r.partitions },
    { key: 'messages', label: 'Messages', align: 'right', width: 'var(--px-120)', sort: (r) => r.messages, help: 'Messages currently stored in the topic.' },
  ]

  // ---- consumer groups table ----
  const groupCols: StreamColumn<GroupRow>[] = [
    { key: 'name', label: 'Group', sort: (g) => g.name },
    { key: 'state', label: 'State', width: 'var(--px-110)', sort: (g) => groupState(g.state).label, help: 'Running: consumers are reading. Stopped: no consumer is connected right now.' },
    { key: 'consumers', label: 'Consumers', align: 'right', width: 'var(--px-100)', sort: (g) => g.consumers },
    { key: 'topics', label: 'Reads', width: 'var(--px-140)', sort: (g) => g.topics.join(',') },
    { key: 'behind', label: 'Behind', align: 'right', width: 'var(--px-110)', sort: (g) => g.behind, help: 'Messages this group has not read yet.' },
  ]
  const focusGroup = $derived(section === 'groups' && ws.focus ? groups.find((g) => g.name === ws.focus) ?? null : null)
  const focusGroupLag = $derived(focusGroup ? groupLags[focusGroup.name] ?? null : null)

  const focusTopic = $derived(section === 'topics' && ws.focus ? topics.find((t) => t.name === ws.focus) ?? null : null)
  // groups that have a read position on the focused topic
  const topicReaders = $derived(
    focusTopic
      ? groups
          .map((g) => ({ g, lag: (groupLags[g.name] ?? []).filter((l) => l.topic === focusTopic.name) }))
          .filter((x) => x.lag.length > 0 || x.g.topics?.includes(focusTopic.name))
      : [],
  )
  const focusRow = $derived(focusTopic ? rows.find((r) => r.name === focusTopic.name) ?? null : null)

  /** Messages / Produce of a topic, in its details here (no tab per topic). */
  function openMessages(name: string) {
    tabs.patchState(tab.id, { focus: name, sub: 'messages' })
  }
  // the embedded views read their topic from a tab — give them one of their own
  const topicViewTab = $derived<TabState | null>(focusTopic ? { ...tab, state: { topic: focusTopic.name } } : null)
</script>

<StreamShell
  system="kafka"
  title={profile?.name ?? 'Kafka'}
  subtitle={cluster ? `${plural(cluster.brokers.length, 'broker')} · controller: broker ${cluster.controller_id}${cluster.brokers[0] ? ` · ${cluster.brokers[0].host}:${cluster.brokers[0].port}` : ''}` : loading ? 'Reading cluster…' : undefined}
  {sections}
  active={section}
  onSection={(id) => go(id)}
  {status}
  description={DESCRIPTIONS[section]}
  {loading}
  onRefresh={refresh}
>
  {#snippet actions()}
    {#if section === 'topics' || section === 'overview'}
      <button type="button" class="cfm-btn primary" onclick={() => kafkaTopicWizard.show(connId)}>+ Create topic</button>
    {/if}
  {/snippet}

  {#if section === 'overview'}
    <div class="ds-body kc-overview">
      <StatCards items={cards} />
      <div class="kc-two">
        <section class="kc-panel">
          <div class="kc-panel-head"><span>Brokers</span><button type="button" class="kc-link" onclick={() => go('brokers')}>All brokers</button></div>
          {#if health.brokers.length === 0}
            <div class="ds-empty">{clusterError ? 'Broker list unavailable.' : 'Reading brokers…'}</div>
          {:else}
            <table class="ds-table flush kc-mini">
              <thead><tr><th>Broker</th><th>Role</th><th class="r">Leads</th><th class="r">Copies behind</th></tr></thead>
              <tbody>
                {#each health.brokers as b (b.id)}
                  <tr>
                    <td><span class="kc-strong">Broker {b.id}</span> <span class="kc-dim mono">{b.host}:{b.port}</span></td>
                    <td>{#if b.isController}<span class="ds-chip live">Controller</span>{:else}<span class="kc-dim">Member</span>{/if}</td>
                    <td class="r ds-num">{fullCount(b.leads)}</td>
                    <td class="r ds-num" class:kc-warn={b.behind > 0}>{fullCount(b.behind)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
        <section class="kc-panel">
          <div class="kc-panel-head"><span>Largest topics</span><button type="button" class="kc-link" onclick={() => go('topics')}>All topics</button></div>
          {#if largest.length === 0}
            <div class="ds-empty">
              {#if cache?.loading}Reading topics…{:else}<b>No topics yet</b>Topics hold your messages.{/if}
            </div>
          {:else}
            <table class="ds-table flush kc-mini">
              <thead><tr><th>Topic</th><th class="r">Partitions</th><th class="r">Messages</th></tr></thead>
              <tbody>
                {#each largest as r (r.name)}
                  <tr class="kc-click" onclick={() => go('topics', r.name)}>
                    <td><button type="button" class="kc-topic ds-name" onclick={(e) => { e.stopPropagation(); go('topics', r.name) }}>{r.name}</button></td>
                    <td class="r ds-num">{r.partitions}</td>
                    <td class="r ds-num kc-num" title={fullCount(r.messages)}>{compactCount(r.messages)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
        <section class="kc-panel">
          <div class="kc-panel-head"><span>Groups furthest behind</span><button type="button" class="kc-link" onclick={() => go('groups')}>All groups</button></div>
          {#if groupsError}
            <div class="ds-empty kc-bad">{groupsError}</div>
          {:else if furthest.length === 0}
            <div class="ds-empty">{loadingGroups ? 'Reading groups…' : groups.length ? 'Every group has read everything.' : 'No consumer groups yet.'}</div>
          {:else}
            <table class="ds-table flush kc-mini">
              <thead><tr><th>Group</th><th>State</th><th class="r">Behind</th></tr></thead>
              <tbody>
                {#each furthest as g (g.name)}
                  {@const st = groupState(g.state)}
                  <tr class="kc-click" onclick={() => go('groups', g.name)}>
                    <td><button type="button" class="kc-topic ds-name" onclick={(e) => { e.stopPropagation(); go('groups', g.name) }}>{g.name}</button></td>
                    <td><span class="kc-state {st.tone}">{st.label}</span></td>
                    <td class="r ds-num kc-warn" title={fullCount(g.behind)}>{compactCount(g.behind)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </section>
      </div>
    </div>
  {:else if section === 'brokers'}
    <StreamTable
      rows={health.brokers}
      columns={brokerCols}
      rowKey={(b) => String(b.id)}
      ariaLabel="Brokers"
      initialSort={{ key: 'id', dir: 'asc' }}
      loading={loadingCluster}
      error={clusterError}
      emptyTitle="No brokers reported"
      emptyBody="The cluster did not return any broker. Check the connection and refresh."
    >
      {#snippet cell(b, c)}
        {#if c.key === 'id'}<span class="kc-strong">Broker {b.id}</span>
        {:else if c.key === 'host'}<span class="mono kc-dim">{b.host}:{b.port}</span>
        {:else if c.key === 'role'}{#if b.isController}<span class="ds-chip live">Controller</span>{:else}<span class="kc-dim">Member</span>{/if}
        {:else if c.key === 'leads'}<span class="ds-num">{fullCount(b.leads)} {b.leads === 1 ? 'partition' : 'partitions'}</span>
        {:else if c.key === 'holds'}<span class="ds-num">{fullCount(b.holds)}</span>
        {:else if c.key === 'behind'}<span class="ds-num" class:kc-warn={b.behind > 0} class:kc-ok={b.behind === 0}>{b.behind === 0 ? 'None' : fullCount(b.behind)}</span>
        {/if}
      {/snippet}
    </StreamTable>
  {:else if section === 'topics'}
    <!-- the details host the topic's message list: give them more room by default -->
    <SplitDetail storeKey="kafka-topics" open={!!focusTopic} initial={32}>
      {#snippet list()}
        <StreamTable
          rows={shownRows}
          columns={topicCols}
          rowKey={(r) => r.name}
          ariaLabel="Topics"
          selected={ws.focus ?? null}
          onSelect={(r) => select(r.name)}
          onOpen={(r) => openMessages(r.name)}
          filterText={(r) => r.name}
          filterPlaceholder="Filter topics…"
          initialSort={{ key: 'name', dir: 'asc' }}
          loading={!!cache?.loading}
          error={cache?.error ?? null}
          emptyTitle="No topics yet"
          emptyBody="Topics hold your messages. Create one to start producing."
          emptyActionLabel="+ Create topic"
          onEmptyAction={() => kafkaTopicWizard.show(connId)}
          note={!showInternal && internalCount ? `${plural(internalCount, 'internal topic')} hidden (used by Kafka itself).` : null}
        >
          {#snippet tools()}
            {#if internalCount}
              <label class="kc-check"><input type="checkbox" bind:checked={showInternal} /> Show internal topics</label>
            {/if}
          {/snippet}
          {#snippet cell(r, c)}
            {#if c.key === 'name'}<span class="ds-name" class:kc-dim={r.internal}>{r.name}</span>{#if r.upToDate < r.partitions}{@const missing = r.partitions - r.upToDate}<span class="kc-flag" role="img" aria-label="{missing} of {r.partitions} partitions missing copies" title="{missing} of {r.partitions} partitions are missing copies — open the topic and see Partitions"><Icon name="warning" size={12} /></span>{/if}
            {:else if c.key === 'partitions'}<span class="ds-num">{r.partitions}</span>
            {:else if c.key === 'messages'}
              {#if r.messages == null}<span class="kc-warn" title={r.offsetsError ? `Count unknown — ${r.offsetsError}` : 'Count unknown'}>?</span>{:else}<span class="ds-num kc-num" title={fullCount(r.messages)}>{compactCount(r.messages)}</span>{/if}
            {/if}
          {/snippet}
        </StreamTable>
      {/snippet}
      {#snippet detail()}
        {#if focusTopic && focusRow}
          <div class="kc-detail">
            <div class="kc-detail-head">
              <span class="kc-detail-title mono">{focusTopic.name}</span>
              <button type="button" class="cfm-btn kc-head-btn" onclick={() => (partitionsFor = { topic: focusTopic.name, current: focusTopic.partitions.length })}>Edit partitions…</button>
              <button type="button" class="cfm-btn ds-danger-outline kc-head-btn" onclick={() => { deleteTopicError = null; deleteTopicFor = focusTopic.name }}>Delete topic…</button>
              <button type="button" class="kc-close" onclick={() => select(null)} aria-label="Close details" title="Close details">×</button>
            </div>
            <div class="kc-facts">
              <span class="ds-chip">{plural(focusRow.partitions, 'partition')}</span>
              <span class="ds-chip">{plural(focusRow.copies, 'copy', 'copies')}</span>
              {#if focusRow.upToDate === focusRow.partitions}<span class="ds-chip live">All copies up to date</span>{:else}<span class="ds-chip warn">{focusRow.partitions - focusRow.upToDate} missing copies</span>{/if}
              <span class="ds-chip">{focusRow.messages == null ? 'messages: unknown' : plural(focusRow.messages, 'message')}</span>
            </div>
            <div class="kc-subtabs" role="tablist" aria-label="Topic details">
              {#each [['messages', 'Messages'], ['partitions', 'Partitions'], ['consumers', `Consumers${topicReaders.length ? ` ${topicReaders.length}` : ''}`], ['settings', 'Settings'], ['produce', 'Produce']] as [id, label] (id)}
                <button type="button" role="tab" class="kc-subtab" class:on={topicTab === id} aria-selected={topicTab === id} onclick={() => showTopicTab(id as TopicTab)}>{label}</button>
              {/each}
            </div>
            {#if topicTab === 'messages' && topicViewTab}
              {#key focusTopic.name}
                <div class="kc-embed" data-kafka-topic-view={focusTopic.name}><KafkaConsumer tab={topicViewTab} embedded onCopyToProduce={(m) => copyToProduce(focusTopic.name, m)} /></div>
              {/key}
            {:else if topicTab === 'produce' && topicViewTab}
              {#key `${focusTopic.name}:${draftSeq}`}
                <div class="kc-embed kc-embed-produce" data-kafka-produce-view={focusTopic.name}><KafkaProducer tab={topicViewTab} embedded draft={produceDraft?.topic === focusTopic.name ? produceDraft.draft : null} /></div>
              {/key}
            {:else if topicTab === 'settings'}
              <TopicConfigPanel {connId} topic={focusTopic.name} />
            {:else if topicTab === 'consumers'}
              {#if topicReaders.length === 0}
                <div class="ds-empty"><b>No consumer group reads this topic</b>Groups appear here once they have read from it.</div>
              {:else}
                <table class="ds-table kc-parts">
                  <thead><tr><th>Group</th><th>State</th><th class="r">Behind on this topic</th></tr></thead>
                  <tbody>
                    {#each topicReaders as x (x.g.name)}
                      {@const st = groupState(x.g.state)}
                      {@const behind = x.lag.reduce((s, l) => s + Math.max(0, l.lag), 0)}
                      <tr class="kc-click" onclick={() => go('groups', x.g.name)}>
                        <td><button type="button" class="kc-topic ds-name" onclick={(e) => { e.stopPropagation(); go('groups', x.g.name) }}>{x.g.name}</button></td>
                        <td><span class="kc-state {st.tone}">{st.label}</span></td>
                        <td class="r ds-num" class:kc-warn={behind > 0} class:kc-ok={behind === 0}>{behind === 0 ? 'Up to date' : fullCount(behind)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            {:else}
            <div class="ds-section-title">Partitions <HelpTip text="Each partition keeps its own order of messages. Position = offset of a message inside its partition." /></div>
            <div class="kc-scroll">
            <table class="ds-table kc-parts">
              <thead><tr><th>Partition</th><th>Leader</th><th title="Copies that are up to date with the leader">Up to date</th><th class="r" title="Position of the oldest message still kept">Oldest</th><th class="r" title="Position the next message will get">Newest</th><th class="r">Messages</th></tr></thead>
              <tbody>
                {#each focusTopic.partitions as p (p.id)}
                  {@const behind = p.replicas.filter((r) => !p.isr.includes(r))}
                  <tr>
                    <td class="ds-num">{p.id}</td>
                    <td>{#if p.leader < 0}<span class="kc-bad">No leader</span>{:else}Broker {p.leader}{/if}</td>
                    <td>{#if behind.length === 0}<span class="kc-ok">All {p.replicas.length}</span>{:else}<span class="kc-warn" title="Behind: broker {behind.join(', ')}">{p.isr.length} of {p.replicas.length}</span>{/if}</td>
                    <td class="r ds-num">{focusTopic.offsets_known === false ? '?' : fullCount(p.low)}</td>
                    <td class="r ds-num">{focusTopic.offsets_known === false ? '?' : fullCount(p.high)}</td>
                    <td class="r ds-num kc-num">{focusTopic.offsets_known === false ? '?' : fullCount(Math.max(0, p.high - p.low))}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            </div>
            <AdvancedToggle>
              <table class="ds-table kc-parts">
                <thead><tr><th>Partition</th><th>Leader id</th><th>Replicas</th><th>In-sync replicas (ISR)</th></tr></thead>
                <tbody>
                  {#each focusTopic.partitions as p (p.id)}
                    <tr><td class="ds-num">{p.id}</td><td class="ds-num">{p.leader}</td><td class="mono">{p.replicas.join(', ')}</td><td class="mono">{p.isr.join(', ')}</td></tr>
                  {/each}
                </tbody>
              </table>
            </AdvancedToggle>
            {/if}
          </div>
        {/if}
      {/snippet}
    </SplitDetail>
  {:else if section === 'groups'}
    <SplitDetail storeKey="kafka-groups" open={!!focusGroup}>
      {#snippet list()}
        <StreamTable
          rows={gRows}
          columns={groupCols}
          rowKey={(g) => g.name}
          ariaLabel="Consumer groups"
          selected={ws.focus ?? null}
          onSelect={(g) => select(g.name)}
          filterText={(g) => `${g.name} ${g.topics.join(' ')}`}
          filterPlaceholder="Filter groups…"
          initialSort={{ key: 'behind', dir: 'desc' }}
          loading={loadingGroups}
          error={groupsError}
          emptyTitle="No consumer groups yet"
          emptyBody="A group appears here as soon as an application starts reading with a group id."
        >
          {#snippet cell(g, c)}
            {#if c.key === 'name'}<span class="ds-name">{g.name}</span>
            {:else if c.key === 'state'}{@const st = groupState(g.state)}<span class="kc-state {st.tone}">{st.label}</span>
            {:else if c.key === 'consumers'}<span class="ds-num">{g.consumers}</span>
            {:else if c.key === 'topics'}<span class="kc-dim">{g.topics.length ? g.topics.join(', ') : '—'}</span>
            {:else if c.key === 'behind'}
              {#if g.behind == null}<span class="kc-dim" title="Could not read this group's positions">?</span>{:else if g.behind === 0}<span class="kc-ok">Up to date</span>{:else}<span class="ds-num kc-warn" title={fullCount(g.behind)}>{compactCount(g.behind)}</span>{/if}
            {/if}
          {/snippet}
        </StreamTable>
      {/snippet}
      {#snippet detail()}
        {#if focusGroup}
          {@const st = groupState(focusGroup.state)}
          {@const behind = (focusGroupLag ?? []).reduce((s, l) => s + Math.max(0, l.lag), 0)}
          <div class="kc-detail">
            <div class="kc-detail-head">
              <span class="kc-detail-title mono">{focusGroup.name}</span>
              <span class="kc-state {st.tone}">{st.label}</span>
              <button type="button" class="kc-close" onclick={() => select(null)} aria-label="Close details" title="Close details">×</button>
            </div>
            <div class="kc-facts">
              <span class="ds-chip">{plural(focusGroup.members.length, 'consumer')} running</span>
              <span class="ds-chip" class:warn={behind > 0} class:live={behind === 0 && !!focusGroupLag}>{focusGroupLag ? (behind === 0 ? 'Read everything' : `${fullCount(behind)} messages behind`) : 'Positions unknown'}</span>
            </div>
            <div class="kc-actions">
              <button type="button" class="cfm-btn" onclick={() => (resetFor = focusGroup.name)}>Change read position…</button>
              <button type="button" class="cfm-btn ds-danger-outline" onclick={() => { deleteError = null; deleteFor = focusGroup.name }}>Delete group…</button>
            </div>
            {#if focusGroup.members.length > 0}
              <div class="ds-section-title">Consumers</div>
              <table class="ds-table kc-parts">
                <thead><tr><th>Application</th><th>Machine</th></tr></thead>
                <tbody>
                  {#each focusGroup.members as m (m.member_id)}
                    <tr><td>{m.client_id || '—'}</td><td class="mono kc-dim">{cleanHost(m.host)}</td></tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            <div class="ds-section-title">How far behind, per partition <HelpTip text="Read up to = the position the group will read next. Behind = messages written after it." /></div>
            {#if !focusGroupLag}
              <div class="ds-empty">Could not read this group's positions. Refresh to try again.</div>
            {:else if focusGroupLag.length === 0}
              <div class="ds-empty"><b>No read positions saved</b>This group has not committed a position on any topic yet.</div>
            {:else}
              <div class="kc-scroll">
                <table class="ds-table kc-parts">
                  <thead><tr><th>Topic</th><th class="r">Partition</th><th class="r">Read up to</th><th class="r">Latest</th><th class="r">Behind</th></tr></thead>
                  <tbody>
                    {#each focusGroupLag as l (l.topic + ':' + l.partition)}
                      <tr>
                        <td><span class="ds-name">{l.topic}</span></td>
                        <td class="r ds-num">{l.partition}</td>
                        <td class="r ds-num">{fullCount(l.committed)}</td>
                        <td class="r ds-num">{fullCount(l.high)}</td>
                        <td class="r ds-num" class:kc-warn={l.lag > 0} class:kc-ok={l.lag === 0}>{l.lag === 0 ? 'None' : fullCount(l.lag)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
            <AdvancedToggle>
              <table class="ds-table kc-parts">
                <thead><tr><th>Member id</th><th>Client id</th><th>Host</th></tr></thead>
                <tbody>
                  {#each focusGroup.members as m (m.member_id)}
                    <tr><td class="mono">{m.member_id}</td><td class="mono">{m.client_id}</td><td class="mono">{m.host}</td></tr>
                  {:else}
                    <tr><td colspan="3" class="kc-dim">No members.</td></tr>
                  {/each}
                </tbody>
              </table>
              <p class="kc-dim kc-small">Assignment protocol: {focusGroup.protocol || '—'} · raw state: {focusGroup.state}</p>
            </AdvancedToggle>
          </div>
        {/if}
      {/snippet}
    </SplitDetail>
  {:else if section === 'registry'}
    <SchemaRegistryWorkspace {tab} />
  {/if}
</StreamShell>

{#if resetFor}
  {@const g = groups.find((x) => x.name === resetFor)}
  <ChangeReadPositionDialog
    {connId}
    group={resetFor}
    consumers={g?.members.length ?? 0}
    {topics}
    lags={groupLags[resetFor] ?? []}
    onClose={() => (resetFor = null)}
    onApplied={() => void loadGroups()}
  />
{/if}

{#if partitionsFor}
  <KafkaPartitionsDialog
    {connId}
    topic={partitionsFor.topic}
    current={partitionsFor.current}
    onClose={() => (partitionsFor = null)}
    onDone={() => {
      partitionsFor = null
      void explorer.loadStreaming(connId, 'kafka', true)
      void loadCluster()
    }}
  />
{/if}

{#if deleteTopicFor}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !deleteTopicBusy && (deleteTopicFor = null)}>
    <div class="um-dlg sm" role="alertdialog" aria-modal="true" aria-label="Delete topic" tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
        <div class="um-dlg-title"><b>Delete topic</b><span class="mono">{deleteTopicFor}</span></div>
      </div>
      <div class="um-dlg-body">
        <p class="kc-confirm">This drops <b class="mono">{deleteTopicFor}</b> and every message in it. Consumers reading it start failing. This cannot be undone.</p>
        {#if deleteTopicError}<div class="kc-error" role="alert">{deleteTopicError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span style="flex:1"></span>
        <button type="button" class="cfm-btn" use:autofocus onclick={() => (deleteTopicFor = null)} disabled={deleteTopicBusy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={deleteTopic} disabled={deleteTopicBusy}>{deleteTopicBusy ? 'Deleting…' : 'Delete topic'}</button>
      </div>
    </div>
  </div>
{/if}

{#if deleteFor}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !deleteBusy && (deleteFor = null)}>
    <div class="um-dlg sm" role="alertdialog" aria-modal="true" aria-label="Delete consumer group" tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
        <div class="um-dlg-title"><b>Delete consumer group</b><span class="mono">{deleteFor}</span></div>
      </div>
      <div class="um-dlg-body">
        <p class="kc-confirm">This removes the read positions saved for <b class="mono">{deleteFor}</b>. An application that later reads with this group id starts from its own default position. This cannot be undone.</p>
        {#if deleteError}<div class="kc-error" role="alert">{deleteError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span style="flex:1"></span>
        <button type="button" class="cfm-btn" use:autofocus onclick={() => (deleteFor = null)} disabled={deleteBusy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={deleteGroup} disabled={deleteBusy}>{deleteBusy ? 'Deleting…' : 'Delete group'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .kc-overview {
    gap: var(--px-18);
  }
  .kc-two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--px-420), 1fr));
    gap: var(--px-18);
  }
  .kc-panel {
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
    overflow: hidden;
    box-shadow: var(--shadow-xs);
  }
  .kc-panel-head {
    display: flex;
    align-items: center;
    padding: var(--px-10) var(--px-14);
    font-size: var(--px-13);
    font-weight: 600;
    color: var(--text);
    border-bottom: var(--px-1) solid var(--border);
  }
  .kc-panel-head span {
    flex: 1;
  }
  .kc-link {
    border: 0;
    background: transparent;
    font-family: var(--font-main);
    font-size: var(--px-12);
    font-weight: 500;
    color: var(--primary);
    cursor: pointer;
    padding: var(--px-2) var(--px-4);
  }
  .kc-mini .r,
  .kc-parts .r {
    text-align: right;
  }
  .kc-click {
    cursor: pointer;
  }
  .kc-topic {
    border: 0;
    background: transparent;
    padding: 0;
    font-size: var(--px-12_5);
    cursor: pointer;
  }
  .kc-strong {
    font-weight: 600;
    color: var(--text);
  }
  .kc-dim {
    color: var(--muted);
  }
  .kc-num {
    color: var(--tbl-cell);
  }
  .kc-ok {
    color: var(--sacc-green);
    font-weight: 500;
  }
  .kc-flag {
    display: inline-flex;
    vertical-align: -2px;
    margin-left: var(--px-6);
    color: var(--sacc-amber);
  }
  .kc-warn {
    color: var(--sacc-amber);
    font-weight: 600;
  }
  .kc-bad {
    color: var(--danger-text);
    font-weight: 600;
  }
  .kc-check {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .kc-embed {
    flex: 1;
    min-height: var(--px-520);
    display: flex;
    flex-direction: column;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    overflow: hidden;
    background: var(--surface);
  }
  .kc-embed-produce {
    min-height: 0;
    overflow: visible;
  }
  .kc-detail {
    padding: var(--px-14) var(--px-18) var(--px-18);
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
  }
  .kc-detail-head {
    display: flex;
    align-items: center;
    gap: var(--px-10);
  }
  .kc-head-btn {
    flex: none;
  }
  .kc-detail-title {
    flex: 1;
    min-width: 0;
    font-size: var(--px-15);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kc-close {
    border: 0;
    background: transparent;
    font-size: var(--px-18);
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    padding: var(--px-2) var(--px-6);
    border-radius: var(--px-6);
  }
  .kc-close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .kc-scroll {
    overflow-x: auto;
  }
  .kc-parts td,
  .kc-parts th {
    white-space: nowrap;
  }
  .kc-state {
    font-size: var(--px-12);
    font-weight: 600;
  }
  .kc-state.ok {
    color: var(--sacc-green);
  }
  .kc-state.warn {
    color: var(--sacc-amber);
  }
  .kc-state.bad {
    color: var(--danger-text);
  }
  .kc-state.quiet {
    color: var(--muted);
  }
  .kc-subtabs {
    display: flex;
    gap: var(--px-4);
    border-bottom: var(--px-1) solid var(--border);
  }
  .kc-subtab {
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
  .kc-subtab.on {
    color: var(--text);
    font-weight: 600;
    box-shadow: inset 0 calc(-1 * var(--px-2)) 0 var(--primary);
  }
  .kc-confirm {
    margin: 0;
    line-height: 1.5;
    color: var(--text2);
  }
  .kc-error {
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    background: var(--danger-soft);
    color: var(--danger-text);
    font-size: var(--px-12_5);
  }
  .kc-small {
    font-size: var(--px-11_5);
    margin: var(--px-6) 0 0;
  }
  .kc-facts,
  .kc-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-8);
  }
</style>
