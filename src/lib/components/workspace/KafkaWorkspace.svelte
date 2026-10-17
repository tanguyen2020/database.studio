<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  import Chevron from '$lib/components/Chevron.svelte'
  // Kafka Cluster Overview + Topic Browser (Phase 4 · T2+T3) — port tinh thần
  // dòng 718-765 (bảng message → topic list ở đây). Header cluster (brokers/
  // controller/counts) + danh sách topic (search, expand → partitions offsets/lag)
  // + Create/Delete topic. Consumer/Producer (T4/T5) mở từ context menu topic (sau).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const profile = $derived(connections.byId(tab.connectionId))

  let cluster = $state<ipc.KafkaCluster | null>(null)
  let topics = $state<ipc.KafkaTopic[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)
  let filter = $state('')
  let expanded = $state<Set<string>>(new Set())
  // view toggle + consumer groups (T6)
  let view = $state<'topics' | 'groups'>('topics')
  let groups = $state<ipc.KafkaGroup[]>([])
  let selGroup = $state<string | null>(null)
  let lag = $state<ipc.KafkaLag[]>([])

  const filtered = $derived(
    topics.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase())),
  )

  async function load() {
    if (!tab.connectionId) return
    loading = true
    error = null
    try {
      ;[cluster, topics] = await Promise.all([
        ipc.kafkaCluster(tab.connectionId),
        ipc.kafkaTopics(tab.connectionId),
      ])
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void tab.connectionId
    untrack(() => void load())
  })

  function toggle(name: string) {
    const next = new Set(expanded)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    expanded = next
  }

  function topicLag(t: ipc.KafkaTopic): number {
    return t.partitions.reduce((s, p) => s + p.lag, 0)
  }

  async function createTopic() {
    if (!tab.connectionId) return
    const name = window.prompt('Topic name:')
    if (!name) return
    const partitions = parseInt(window.prompt('Partitions:', '3') ?? '3', 10) || 1
    const replication = parseInt(window.prompt('Replication factor:', '1') ?? '1', 10) || 1
    try {
      await ipc.kafkaCreateTopic(tab.connectionId, name, partitions, replication)
      toasts.success(`Created topic "${name}"`)
      await load()
    } catch (e) {
      toasts.error(`Create topic failed: ${e}`)
    }
  }

  async function loadGroups() {
    if (!tab.connectionId) return
    try {
      groups = await ipc.kafkaConsumerGroups(tab.connectionId)
    } catch (e) {
      error = String(e)
    }
  }

  async function toggleGroups() {
    view = view === 'groups' ? 'topics' : 'groups'
    if (view === 'groups' && groups.length === 0) await loadGroups()
  }

  async function selectGroup(name: string) {
    if (!tab.connectionId) return
    selGroup = name
    lag = []
    try {
      lag = await ipc.kafkaGroupLag(tab.connectionId, name)
    } catch (e) {
      error = String(e)
    }
  }

  async function resetOffset(topic: string, partition: number) {
    if (!tab.connectionId || !selGroup) return
    const target = window.prompt(`Reset offset "${selGroup}" · ${topic}[${partition}] → earliest / latest / <offset number>:`, 'earliest')
    if (!target) return
    const isNum = /^\d+$/.test(target)
    try {
      await ipc.kafkaResetOffset(tab.connectionId, selGroup, topic, partition, isNum ? 'offset' : target, isNum ? parseInt(target, 10) : 0)
      toasts.success('Offset reset')
      await selectGroup(selGroup)
    } catch (e) {
      toasts.error(`Reset offset failed (group active?): ${e}`)
    }
  }

  async function deleteTopic(name: string) {
    if (!tab.connectionId) return
    if (!window.confirm(`Delete topic "${name}"?`)) return
    try {
      await ipc.kafkaDeleteTopic(tab.connectionId, name)
      toasts.success(`Deleted topic "${name}"`)
      await load()
    } catch (e) {
      toasts.error(`Delete topic failed: ${e}`)
    }
  }
</script>

<div class="ds-ws">
  <!-- cluster overview header -->
  <div class="ds-ws-head">
    <span class="ds-ws-icon" style="color:var(--sacc-purple);background:color-mix(in srgb, var(--sacc-purple) 13%, transparent)" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="6" cy="12" r="2.2" /><circle cx="18" cy="5.5" r="2.2" /><circle cx="18" cy="18.5" r="2.2" /><path d="M8 11 L16 6.5" /><path d="M8 13 L16 17.5" /></svg>
    </span>
    <div class="ds-ws-titles">
      <span class="ds-ws-title">{profile?.name ?? 'Kafka'} Cluster</span>
      {#if cluster}
        <span class="ds-ws-sub">{cluster.brokers.length} brokers · controller #{cluster.controller_id} · {cluster.topic_count} topics · {cluster.partition_count} partitions</span>
      {/if}
    </div>
    <div class="ds-ws-actions">
      <span onclick={toggleGroups} onkeydown={(e) => e.key === 'Enter' && toggleGroups()} role="button" tabindex="0" class="cfm-btn" class:primary={view === 'groups'} aria-pressed={view === 'groups'}>Consumer Groups</span>
      <span onclick={() => tab.connectionId && tabs.openKafkaSchemaRegistry(tab.connectionId)} onkeydown={(e) => e.key === 'Enter' && tab.connectionId && tabs.openKafkaSchemaRegistry(tab.connectionId)} role="button" tabindex="0" class="cfm-btn">Schema Registry</span>
      {#if view === 'topics'}
        <span onclick={createTopic} onkeydown={(e) => e.key === 'Enter' && createTopic()} role="button" tabindex="0" class="cfm-btn">＋ Topic</span>
      {/if}
      <span onclick={() => { load(); if (view === 'groups') loadGroups() }} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" class="cfm-btn"><Icon name="refresh" size={12} /> Refresh</span>
    </div>
  </div>

  {#if view === 'groups'}
    <!-- consumer groups (T6) -->
    <div style="flex:1;display:flex;min-height:0">
      <div style="width:var(--px-300);flex:none;border-right:var(--px-1) solid var(--border);overflow:auto;padding:var(--px-10) var(--px-8);background:var(--surface)">
        {#if groups.length === 0}
          <div class="ds-empty">No consumer groups.</div>
        {:else}
          {#each groups as g (g.name)}
            <div onclick={() => selectGroup(g.name)} onkeydown={(e) => e.key === 'Enter' && selectGroup(g.name)} role="button" tabindex="0" class="kw-item" class:on={selGroup === g.name}>
              <div style="font-size:var(--px-13);font-weight:600;color:var(--text)">{g.name}</div>
              <div style="font-size:var(--px-11_5);color:var(--muted)">{g.state} · {g.members.length} members · {g.protocol || '—'}</div>
            </div>
          {/each}
        {/if}
      </div>
      <div class="ds-body">
        {#if !selGroup}
          <div class="ds-empty"><b>Pick a consumer group</b>Select a group on the left to see its members and lag.</div>
        {:else}
          {@const grp = groups.find((g) => g.name === selGroup)}
          {#if grp && grp.members.length > 0}
            <div class="ds-section-title">Members</div>
            {#each grp.members as m (m.member_id)}
              <div style="font-size:var(--px-12_5);color:var(--text2)">{m.client_id} @ {m.host} <span class="mono" style="font-size:var(--px-11_5);color:var(--muted)">({m.member_id})</span></div>
            {/each}
          {/if}
          <div class="ds-section-title">Lag per partition</div>
          <table class="ds-table" style="font-size:var(--px-12)">
            <thead><tr>
              {#each ['Topic', 'P', 'Committed', 'Latest', 'Lag', ''] as h (h)}
                <th>{h}</th>
              {/each}
            </tr></thead>
            <tbody>
              {#each lag as l (l.topic + ':' + l.partition)}
                <tr>
                  <td style="font-variant-numeric:tabular-nums;color:var(--sacc-purple)">{l.topic}</td>
                  <td style="font-variant-numeric:tabular-nums;color:var(--muted)">{l.partition}</td>
                  <td style="font-variant-numeric:tabular-nums">{l.committed.toLocaleString()}</td>
                  <td style="font-variant-numeric:tabular-nums">{l.high.toLocaleString()}</td>
                  <td style="font-variant-numeric:tabular-nums;color:{l.lag > 100 ? 'var(--error)' : l.lag > 0 ? 'var(--sacc-amber)' : 'var(--muted)'};font-weight:600">{l.lag.toLocaleString()}</td>
                  <td style="font-variant-numeric:tabular-nums"><span onclick={() => resetOffset(l.topic, l.partition)} onkeydown={(e) => e.key === 'Enter' && resetOffset(l.topic, l.partition)} role="button" tabindex="0" class="eg-btn">Reset</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>
  {:else}

  <!-- broker chips -->
  {#if cluster}
    <div class="ds-toolbar">
      <span class="ds-field" style="margin-right:var(--px-2)">Brokers</span>
      {#each cluster.brokers as b (b.id)}
        <span class="ds-chip" class:live={b.id === cluster.controller_id} title={b.id === cluster.controller_id ? 'Controller' : 'Broker'}>#{b.id} <span class="mono" style="font-weight:500">{b.host}:{b.port}</span>{b.id === cluster.controller_id ? ' · controller' : ''}</span>
      {/each}
    </div>
  {/if}

  <!-- topic search -->
  <div style="flex:none;padding:var(--px-12) var(--px-18) var(--px-4)">
    <span class="ds-search" style="width:100%">
      <Icon name="search" size={13} />
      <input bind:value={filter} placeholder="Filter topics…" aria-label="Filter topics" />
    </span>
  </div>

  <!-- topic list -->
  <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-4) var(--px-12) var(--px-12)">
    {#if error}
      <div class="ds-empty" style="color:var(--danger-text)">{error}</div>
    {:else if loading && topics.length === 0}
      <div class="ds-empty">Loading metadata…</div>
    {:else if filtered.length === 0}
      <div class="ds-empty">No matching topics.</div>
    {:else}
      {#each filtered as t (t.name)}
        {@const open = expanded.has(t.name)}
        <div
          onclick={() => toggle(t.name)}
          onkeydown={(e) => e.key === 'Enter' && toggle(t.name)}
          role="button"
          tabindex="0"
          class="kw-topic"
        >
          <span class="mono" style="width:var(--px-10);text-align:center;font-size:var(--px-9);color:var(--muted)"><Chevron open={open} size={10} /></span>
          <span style="font-size:var(--px-13);font-weight:600;color:{t.internal ? 'var(--muted)' : 'var(--text)'}">{t.name}</span>
          <span class="ds-meta">{t.partitions.length} partition{t.partitions.length === 1 ? '' : 's'} · lag {topicLag(t).toLocaleString()}</span>
          <span
            onclick={(e) => {
              e.stopPropagation()
              tab.connectionId && tabs.openKafkaTool(tab.connectionId, 'kafka-consumer', t.name)
            }}
            onkeydown={(e) => e.key === 'Enter' && tab.connectionId && tabs.openKafkaTool(tab.connectionId, 'kafka-consumer', t.name)}
            role="button"
            tabindex="0"
            title="Open Consumer"
            class="eg-btn"
            style="margin-left:auto;flex:none"
          >Consume</span>
          <span
            onclick={(e) => {
              e.stopPropagation()
              tab.connectionId && tabs.openKafkaTool(tab.connectionId, 'kafka-producer', t.name)
            }}
            onkeydown={(e) => e.key === 'Enter' && tab.connectionId && tabs.openKafkaTool(tab.connectionId, 'kafka-producer', t.name)}
            role="button"
            tabindex="0"
            title="Open Producer"
            class="eg-btn"
            style="flex:none"
          >Produce</span>
          <span
            onclick={(e) => {
              e.stopPropagation()
              deleteTopic(t.name)
            }}
            onkeydown={(e) => e.key === 'Enter' && (e.stopPropagation(), deleteTopic(t.name))}
            role="button"
            tabindex="0"
            title="Delete topic"
            class="ds-act"
            style="flex:none;color:var(--danger-text)"
          ><Icon name="trash" size={13} /></span>
        </div>
        {#if open}
          <table class="ds-table" style="font-size:var(--px-12);width:calc(100% - var(--px-28));margin:var(--px-4) 0 var(--px-10) var(--px-28)">
            <thead><tr>
              {#each ['P', 'Leader', 'Replicas', 'ISR', 'Earliest', 'Latest', 'Lag'] as h (h)}
                <th>{h}</th>
              {/each}
            </tr></thead>
            <tbody>
              {#each t.partitions as p (p.id)}
                <tr>
                  <td style="font-variant-numeric:tabular-nums;color:var(--syntax-number)">{p.id}</td>
                  <td style="font-variant-numeric:tabular-nums">{p.leader}</td>
                  <td style="font-variant-numeric:tabular-nums;color:var(--muted)">{p.replicas.join(',')}</td>
                  <td style="font-variant-numeric:tabular-nums;color:var(--muted)">{p.isr.join(',')}</td>
                  <td style="font-variant-numeric:tabular-nums">{p.low.toLocaleString()}</td>
                  <td style="font-variant-numeric:tabular-nums">{p.high.toLocaleString()}</td>
                  <td style="font-variant-numeric:tabular-nums;color:{p.lag > 0 ? 'var(--sacc-amber)' : 'var(--muted)'}">{p.lag.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {/each}
    {/if}
  </div>
  {/if}
</div>

<style>
  .kw-item {
    padding: var(--px-8) var(--px-10);
    border-radius: var(--px-8);
    cursor: pointer;
  }
  .kw-item:hover {
    background: var(--hover);
  }
  .kw-item.on {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .kw-topic {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    padding: var(--px-8) var(--px-10);
    border-radius: var(--px-8);
    cursor: pointer;
  }
  .kw-topic:hover {
    background: var(--surface);
    box-shadow: var(--shadow-xs);
  }
</style>
