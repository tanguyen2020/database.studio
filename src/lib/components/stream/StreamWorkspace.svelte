<script lang="ts">
  // Tab body for 'stream-workspace': picks the cluster workspace of the connection's
  // engine (SPEC-STREAM-SHELL.md §2). Engines join one wave at a time.
  import { untrack } from 'svelte'
  import type { TabState } from '$lib/types'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { systemMeta } from '$lib/systems'
  import KafkaClusterView from './kafka/KafkaClusterView.svelte'
  // stream-workspace:rabbitmq
  import RabbitClusterView from './rabbitmq/RabbitClusterView.svelte'
  import RedisBrowserView from './redis/RedisBrowserView.svelte' // stream-workspace:redis
  import NatsClusterView from './nats/NatsClusterView.svelte' // stream-workspace:nats
  import StreamConnectionState from './StreamConnectionState.svelte'

  let { tab }: { tab: TabState } = $props()
  const profile = $derived(connections.byId(tab.connectionId))
  const system = $derived(profile?.system ?? tab.systemType)

  // The Connections Refresh (reconnect) bumps this tick. These engines have no
  // object tree to re-read, so the workspace itself reloads: the shared Kafka / NATS
  // lists are fetched again and the view is re-mounted so every section reads fresh.
  const reload = $derived(tab.connectionId ? (explorer.reloadTick[tab.connectionId] ?? 0) : 0)
  let seen = untrack(() => reload)
  $effect(() => {
    const r = reload
    if (r === seen) return
    seen = r
    untrack(() => {
      const id = tab.connectionId
      if (id && (system === 'kafka' || system === 'nats')) void explorer.loadStreaming(id, system, true)
    })
  })
</script>

{#if !profile}
  <div class="ds-empty"><b>This connection no longer exists</b>Close this tab, or pick another connection in the sidebar.</div>
{:else if !profile.connected}
  <StreamConnectionState {profile} />
{:else}
  {#key reload}
    {#if system === 'kafka'}
      <KafkaClusterView {tab} />
    {:else if system === 'rabbitmq'}
      <!-- stream-workspace:rabbitmq -->
      <RabbitClusterView {tab} />
    {:else if system === 'redis'}
      <!-- stream-workspace:redis -->
      <RedisBrowserView {tab} />
    {:else if system === 'nats'}
      <!-- stream-workspace:nats -->
      <NatsClusterView {tab} />
    {:else}
      <div class="ds-empty"><b>No workspace for {systemMeta(system).label} yet</b>Use the Explorer in the sidebar for this connection.</div>
    {/if}
  {/key}
{/if}
