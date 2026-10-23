<script lang="ts">
  // Top bar of a User Manager: engine logo + "<what this engine calls its
  // principals>" + connection, a count, the engine-specific actions (New user /
  // New role / scope pickers…) and the shared Refresh button.
  import type { Snippet } from 'svelte'
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { brandKey } from '$lib/scylla/brand'
  import type { SystemType } from '$lib/types'

  interface Props {
    system: SystemType
    connectionId: string | null
    title: string
    count?: number
    countLabel?: string
    refreshing?: boolean
    onRefresh?: () => void
    /** actions shown left of Refresh (primary "New …" button etc.) */
    children?: Snippet
  }
  let { system, connectionId, title, count, countLabel = '', refreshing = false, onRefresh, children }: Props = $props()

  const profile = $derived(connectionId ? connections.byId(connectionId) : null)
  // a ScyllaDB connection shows the ScyllaDB logo (same Cassandra engine)
  const brand = $derived(system === 'cassandra' ? brandKey(profile ?? { system }) : system)
  const db = $derived(connectionId ? connections.databaseOf(connectionId) : '')
  const where = $derived([profile?.name, db].filter(Boolean).join(' · '))
</script>

<div class="um-head">
  <span class="um-head-logo"><SystemIcon system={brand} size={18} /></span>
  <div class="um-head-title">
    <b>{title}</b>
    {#if where}<span>{where}</span>{/if}
  </div>
  {#if count != null}
    <span class="um-count" title="{count} {countLabel}">{count}{countLabel ? ` ${countLabel}` : ''}</span>
  {/if}
  <span class="um-spacer"></span>
  {#if children}{@render children()}{/if}
  {#if onRefresh}
    <span
      class="eg-btn"
      onclick={onRefresh}
      onkeydown={(e) => e.key === 'Enter' && onRefresh?.()}
      role="button"
      tabindex="0"
      aria-busy={refreshing}
      title="Re-read users, roles and grants from the server"
    ><span class="refresh-glyph" class:um-spin={refreshing}><Icon name="refresh" size={12} /></span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
  {/if}
</div>
