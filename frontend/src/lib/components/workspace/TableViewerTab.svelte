<script lang="ts">
  // Table Data Viewer (Phase-1 basic): opened by double-clicking a table in
  // the explorer. Runs a dialect-correct preview SELECT through the real
  // driver and reuses the result grid. Filter builder → Phase 2.
  import ResultGrid from '$lib/components/results/ResultGrid.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { execStatement } from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { selectStarSql } from '$lib/sql/dialect'
  import type { QueryError, QueryResultSet, TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }

  let { tab }: Props = $props()

  // fixed at open time (component remounts per tab via {#key})
  // svelte-ignore state_referenced_locally
  const schema = tab.state.schema as string
  // svelte-ignore state_referenced_locally
  const table = tab.state.table as string
  const profile = $derived(connections.byId(tab.connectionId))

  let data = $state<QueryResultSet | null>(null)
  let error = $state<QueryError | null>(null)
  let loading = $state(false)
  let durationMs = $state(0)
  let limit = $state(500)

  async function load() {
    if (!tab.connectionId || !profile) return
    if (!profile.connected) {
      const ok = await connections.connect(tab.connectionId)
      if (!ok) return
    }
    loading = true
    error = null
    try {
      const sql = selectStarSql(profile.system, schema, table, limit)
      const res = await execStatement(tab.connectionId, sql, 1)
      durationMs = res.duration_ms
      if (res.ok && res.result) {
        data = res.result
      } else if (res.error) {
        error = res.error
      }
    } catch (e) {
      error = {
        system: profile.system,
        message: String(e),
        severity: 'error',
        raw: String(e),
      }
    } finally {
      loading = false
    }
  }

  $effect(() => {
    if (profile) void load()
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex h-[34px] shrink-0 items-center gap-2 border-b border-border bg-header px-2 text-[12px]">
    {#if profile}
      <SystemBadge system={profile.system} />
    {/if}
    <span class="mono">{schema}.{table}</span>
    <div class="grow"></div>
    <label class="flex items-center gap-1 text-[11px] text-text2">
      Limit
      <select
        class="rounded border border-input bg-surface px-1 py-0.5 text-[11px]"
        bind:value={limit}
        onchange={load}
      >
        <option value={100}>100</option>
        <option value={500}>500</option>
        <option value={1000}>1000</option>
      </select>
    </label>
    <button class="rounded px-1.5 py-0.5 text-text2 hover:bg-hover" title="Refresh" onclick={load}>⟳</button>
    {#if data}
      <span class="text-[11px] text-mutedfg">{data.total.toLocaleString()} rows · {durationMs} ms</span>
    {/if}
  </div>
  <div class="min-h-0 grow">
    {#if loading}
      <div class="flex h-full items-center justify-center text-[12px] text-mutedfg">Đang tải…</div>
    {:else if error}
      <div class="selectable p-4 text-[12.5px] text-error">
        ✗ {error.message}
        {#if error.hint}
          <div class="mt-1 text-warn">💡 {error.hint}</div>
        {/if}
      </div>
    {:else if data}
      <ResultGrid {data} />
    {:else}
      <div class="flex h-full items-center justify-center text-[12px] text-mutedfg">
        {profile ? 'Không có dữ liệu' : 'Connection không tồn tại'}
      </div>
    {/if}
  </div>
</div>
