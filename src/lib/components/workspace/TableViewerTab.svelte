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

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- toolbar table viewer — cùng ngôn ngữ editor toolbar (dòng 230) -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--surface);font-size:var(--px-12)">
    {#if profile}
      <SystemBadge system={profile.system} />
    {/if}
    <span class="mono">{schema}.{table}</span>
    <div style="margin-left:auto;display:flex;align-items:center;gap:var(--px-8)">
      <label style="display:flex;align-items:center;gap:var(--px-4);font-size:var(--px-11);color:var(--text2)">
        Limit
        <select
          style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-4);font-size:var(--px-11);color:var(--text)"
          bind:value={limit}
          onchange={load}
        >
          <option value={100}>100</option>
          <option value={500}>500</option>
          <option value={1000}>1000</option>
        </select>
      </label>
      <span
        onclick={load}
        onkeydown={(e) => e.key === 'Enter' && load()}
        role="button"
        tabindex="0"
        title="Refresh"
        style="color:var(--muted);cursor:pointer;font-size:var(--px-13)"
      >⟳</span>
      {#if data}
        <span class="mono" style="font-size:var(--px-11);color:var(--muted)">{data.total.toLocaleString()} rows · {durationMs} ms</span>
      {/if}
    </div>
  </div>
  <div style="min-height:0;flex:1;display:flex;flex-direction:column">
    {#if loading}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">Đang tải…</div>
    {:else if error}
      <div class="selectable" style="padding:var(--px-16);font-size:var(--px-12_5);color:var(--error)">
        ✗ {error.message}
        {#if error.hint}
          <div style="margin-top:var(--px-4);color:var(--warn)">💡 {error.hint}</div>
        {/if}
      </div>
    {:else if data}
      <ResultGrid {data} />
    {:else}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">
        {profile ? 'Không có dữ liệu' : 'Connection không tồn tại'}
      </div>
    {/if}
  </div>
</div>
