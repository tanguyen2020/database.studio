<script lang="ts">
  // Kafka Cluster Overview + Topic Browser (Phase 4 · T2+T3) — port tinh thần
  // dòng 718-765 (bảng message → topic list ở đây). Header cluster (brokers/
  // controller/counts) + danh sách topic (search, expand → partitions offsets/lag)
  // + Create/Delete topic. Consumer/Producer (T4/T5) mở từ context menu topic (sau).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
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
    const name = window.prompt('Tên topic:')
    if (!name) return
    const partitions = parseInt(window.prompt('Partitions:', '3') ?? '3', 10) || 1
    const replication = parseInt(window.prompt('Replication factor:', '1') ?? '1', 10) || 1
    try {
      await ipc.kafkaCreateTopic(tab.connectionId, name, partitions, replication)
      toasts.success(`Đã tạo topic "${name}"`)
      await load()
    } catch (e) {
      toasts.error(`Tạo topic thất bại: ${e}`)
    }
  }

  async function deleteTopic(name: string) {
    if (!tab.connectionId) return
    if (!window.confirm(`Xóa topic "${name}"?`)) return
    try {
      await ipc.kafkaDeleteTopic(tab.connectionId, name)
      toasts.success(`Đã xóa topic "${name}"`)
      await load()
    } catch (e) {
      toasts.error(`Xóa topic thất bại: ${e}`)
    }
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- cluster overview header -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-12);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:#8B5CF6"></span>
    <span style="font-weight:700;font-size:var(--px-13)">{profile?.name ?? 'Kafka'} Cluster</span>
    {#if cluster}
      <span class="mono" style="font-size:var(--px-11);color:var(--text2)">{cluster.brokers.length} brokers · controller #{cluster.controller_id} · {cluster.topic_count} topics · {cluster.partition_count} partitions</span>
    {/if}
    <div style="margin-left:auto;display:flex;gap:var(--px-8)">
      <span onclick={createTopic} onkeydown={(e) => e.key === 'Enter' && createTopic()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">＋ Topic</span>
      <span onclick={load} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">⟳ Refresh</span>
    </div>
  </div>

  <!-- broker chips -->
  {#if cluster}
    <div style="flex:none;display:flex;gap:var(--px-8);padding:var(--px-8) var(--px-14);border-bottom:var(--px-1) solid var(--border);flex-wrap:wrap">
      {#each cluster.brokers as b (b.id)}
        <span class="mono" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-9)">#{b.id} {b.host}:{b.port}{b.id === cluster.controller_id ? ' ★' : ''}</span>
      {/each}
    </div>
  {/if}

  <!-- topic search -->
  <div style="flex:none;padding:var(--px-8) var(--px-14)">
    <input bind:value={filter} placeholder="Filter topics…" class="mono" style="width:100%;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-9);font-size:var(--px-12);color:var(--text);outline:none" />
  </div>

  <!-- topic list -->
  <div style="flex:1;overflow:auto;min-height:0;padding:0 var(--px-8) var(--px-10)">
    {#if error}
      <div style="padding:var(--px-14);font-size:var(--px-12);color:var(--error)">{error}</div>
    {:else if loading && topics.length === 0}
      <div style="padding:var(--px-14);font-size:var(--px-12);color:var(--muted)">Đang tải metadata…</div>
    {:else if filtered.length === 0}
      <div style="padding:var(--px-14);font-size:var(--px-12);color:var(--muted)">Không có topic khớp.</div>
    {:else}
      {#each filtered as t (t.name)}
        {@const open = expanded.has(t.name)}
        <div
          onclick={() => toggle(t.name)}
          onkeydown={(e) => e.key === 'Enter' && toggle(t.name)}
          role="button"
          tabindex="0"
          style="display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-8);border-radius:var(--px-6);cursor:pointer"
        >
          <span class="mono" style="width:var(--px-10);text-align:center;font-size:var(--px-9);color:var(--muted)">{open ? '▾' : '▸'}</span>
          <span class="mono" style="font-size:var(--px-12_5);font-weight:600;color:{t.internal ? 'var(--muted)' : '#8B5CF6'}">{t.name}</span>
          <span class="mono" style="font-size:var(--px-10_5);color:var(--muted)">{t.partitions.length}p · lag {topicLag(t).toLocaleString()}</span>
          <span
            onclick={(e) => {
              e.stopPropagation()
              deleteTopic(t.name)
            }}
            onkeydown={(e) => e.key === 'Enter' && (e.stopPropagation(), deleteTopic(t.name))}
            role="button"
            tabindex="0"
            title="Delete topic"
            style="margin-left:auto;flex:none;color:var(--error);font-size:var(--px-12);cursor:pointer;padding:0 var(--px-6)"
          >×</span>
        </div>
        {#if open}
          <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-11_5);margin:var(--px-2) 0 var(--px-8) var(--px-22)">
            <thead><tr>
              {#each ['P', 'Leader', 'Replicas', 'ISR', 'Earliest', 'Latest', 'Lag'] as h (h)}
                <th style="text-align:left;padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2);font-weight:600">{h}</th>
              {/each}
            </tr></thead>
            <tbody>
              {#each t.partitions as p (p.id)}
                <tr>
                  <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:#d19a66">{p.id}</td>
                  <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border)">{p.leader}</td>
                  <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{p.replicas.join(',')}</td>
                  <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{p.isr.join(',')}</td>
                  <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border)">{p.low.toLocaleString()}</td>
                  <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border)">{p.high.toLocaleString()}</td>
                  <td style="padding:var(--px-4) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:{p.lag > 0 ? '#e5c07b' : 'var(--muted)'}">{p.lag.toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {/each}
    {/if}
  </div>
</div>
