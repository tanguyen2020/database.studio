<script lang="ts">
  // Status bar: ● accent dot (gray when disconnected) · connection name ·
  // system badge · current schema · latency · row count of the active result.
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { results } from '$lib/stores/results.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'

  const tab = $derived(tabs.active)
  const profile = $derived(connections.byId(tab?.connectionId))
  const exec = $derived(tab ? results.get(tab.id) : undefined)
  const currentSchema = $derived.by(() => {
    if (!profile) return null
    const schemas = explorer.cache[profile.id]?.schemas
    return schemas?.find((s) => s.is_default)?.name ?? schemas?.[0]?.name ?? null
  })
</script>

<div class="flex h-[24px] shrink-0 items-center gap-2 border-t border-border bg-header px-2 text-[11px] text-text2">
  {#if profile}
    <span
      class="h-[7px] w-[7px] rounded-full"
      style="background: {profile.connected ? systemMeta(profile.system).accent : 'var(--border2)'};"
    ></span>
    <span class="font-medium text-foreground">{profile.name}</span>
    <SystemBadge system={profile.system} />
    {#if currentSchema}
      <span class="mono">{currentSchema}</span>
    {/if}
    {#if profile.connected && profile.latency_ms != null}
      <span class="text-mutedfg">·</span>
      <span>{profile.latency_ms} ms</span>
    {/if}
  {:else if tab?.systemType === 'orphan'}
    <SystemBadge system="orphan" />
    <span class="text-mutedfg">orphaned tab</span>
  {:else}
    <span class="h-[7px] w-[7px] rounded-full bg-border2"></span>
    <span class="text-mutedfg">No connection</span>
  {/if}
  <div class="grow"></div>
  {#if exec?.running}
    <span class="animate-pulse">Đang chạy…</span>
  {:else if exec}
    <span>{exec.totalMs} ms</span>
    {#if exec.lastRowCount != null}
      <span class="text-mutedfg">·</span>
      <span>{exec.lastRowCount.toLocaleString()} rows</span>
    {/if}
  {/if}
</div>
