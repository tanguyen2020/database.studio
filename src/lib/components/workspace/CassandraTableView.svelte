<script lang="ts">
  // Cassandra editable data viewer (Phase C3). Loads rows via the dedicated
  // `cql_exec` path (paging state, never LIMIT/OFFSET) and renders ResultGrid with
  // an EditTarget whose Apply/Preview route to the Cassandra grid arms — edits and
  // deletes become CQL UPDATE/DELETE by the full primary key. An optional CQL WHERE
  // (on the partition key) narrows the scan. Cassandra-only; other engines untouched.
  import ResultGrid, { type EditTarget } from '$lib/components/results/ResultGrid.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { cqlExec, cassandraColumns } from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { systemMeta } from '$lib/systems'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { QueryError, QueryResultSet, TabState } from '$lib/types'
  import { untrack } from 'svelte'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  // svelte-ignore state_referenced_locally
  const keyspace = tab.state.keyspace as string
  // svelte-ignore state_referenced_locally
  const table = tab.state.table as string
  const profile = $derived(connections.byId(tab.connectionId))

  let data = $state<QueryResultSet | null>(null)
  let error = $state<QueryError | null>(null)
  let loading = $state(false)
  let durationMs = $state(0)
  let pkCols = $state<string[]>([])
  let nextPage = $state<string | null>(null)
  let whereText = $state('')
  const PAGE = 200

  // Editing enabled once the connection + primary key are known. Apply/Preview go
  // through applyGridChanges/previewGridChanges → Cassandra arms (CQL by full PK).
  const editTarget = $derived<EditTarget | undefined>(
    profile && tab.connectionId && pkCols.length > 0
      ? { connId: tab.connectionId, system: 'cassandra', schema: keyspace, table, pkCols, onApplied: () => void load() }
      : undefined,
  )

  function baseQuery(): string {
    const w = whereText.trim()
    return `SELECT * FROM ${keyspace}.${table}${w ? ` WHERE ${w}` : ''}`
  }

  async function load() {
    if (!tab.connectionId || !profile) return
    loading = true
    error = null
    try {
      // primary key (partition + clustering) for edit targeting
      if (pkCols.length === 0) {
        try {
          const cols = await cassandraColumns(tab.connectionId, keyspace, table)
          pkCols = cols.filter((c) => c.kind === 'partition_key' || c.kind === 'clustering').map((c) => c.name)
        } catch {
          pkCols = []
        }
      }
      const res = await cqlExec(tab.connectionId, baseQuery(), PAGE)
      durationMs = res.duration_ms
      if (res.ok && res.result) {
        data = res.result
        nextPage = res.next_page ?? null
        for (const w of res.warnings ?? []) toasts.show(w, { system: 'cassandra' })
      } else if (res.error) {
        error = { system: 'cassandra', message: res.error.message, severity: 'error', raw: res.error.detail ?? res.error.message }
        data = null
      }
    } catch (e) {
      error = { system: 'cassandra', message: String(e), severity: 'error', raw: String(e) }
    } finally {
      loading = false
    }
  }

  async function loadMore() {
    if (!tab.connectionId || !data || !nextPage) return
    try {
      const res = await cqlExec(tab.connectionId, baseQuery(), PAGE, nextPage)
      if (res.error) {
        toasts.error(res.error.message)
        return
      }
      if (res.result) {
        data = { ...data, rows: [...data.rows, ...res.result.rows], total: data.rows.length + res.result.rows.length }
      }
      nextPage = res.next_page ?? null
    } catch (e) {
      toasts.error(`Load next page failed: ${e}`)
    }
  }

  $effect(() => {
    void tab.connectionId
    untrack(() => void load())
  })
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- toolbar -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--surface);font-size:var(--px-12)">
    {#if profile}
      <SystemBadge system={profile.system} />
    {/if}
    <span style="font-weight:600;color:var(--text)" title="Connection">{profile?.name ?? '—'}</span>
    <span style="color:var(--muted)">/</span>
    <span
      class="mono"
      title={`Keyspace: ${keyspace} · ${keyspace}.${table}`}
      style="display:inline-flex;align-items:center;gap:var(--px-5);font-size:var(--px-11_5);font-weight:600;color:{systemMeta(profile?.system).accent};background:color-mix(in srgb, {systemMeta(profile?.system).accent} 14%, transparent);border:var(--px-1) solid color-mix(in srgb, {systemMeta(profile?.system).accent} 45%, transparent);border-radius:var(--px-6);padding:var(--px-2) var(--px-8)"
    >
      <span style="font-size:var(--px-11)">▤</span>{keyspace}
    </span>
    <span class="mono" style="color:var(--text2)">{keyspace}.{table}</span>
    <input
      class="cv-in mono"
      style="flex:1;max-width:var(--px-460)"
      bind:value={whereText}
      placeholder="WHERE partition_key = … (optional, CQL)"
      onkeydown={(e) => e.key === 'Enter' && load()}
    />
    <span class="cv-btn" onclick={() => load()} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0">Run</span>
    <div style="margin-left:auto;display:flex;align-items:center;gap:var(--px-8)">
      {#if data}
        <span class="mono" style="font-size:var(--px-11);color:var(--muted)">{data.total.toLocaleString()} rows · {durationMs} ms</span>
      {/if}
      {#if nextPage}
        <span class="cv-btn" onclick={loadMore} onkeydown={(e) => e.key === 'Enter' && loadMore()} role="button" tabindex="0" title="Fetch the next page (paging state)">↓ Load next page</span>
      {/if}
    </div>
  </div>

  <div style="min-height:0;flex:1;display:flex;flex-direction:column">
    {#if loading && !data}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">Loading…</div>
    {:else if error}
      <div class="selectable" style="padding:var(--px-16);font-size:var(--px-12_5);color:var(--error)">✗ {error.message}</div>
    {:else if data}
      <ResultGrid {data} {editTarget} />
    {:else}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">
        {profile ? 'No data' : 'Connection not found'}
      </div>
    {/if}
  </div>
</div>

<style>
  .cv-btn {
    font-size: var(--px-11);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-3) var(--px-9);
    cursor: pointer;
  }
  .cv-btn:hover {
    background: var(--hover);
  }
  .cv-in {
    background: var(--panel);
    color: var(--text);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-5);
    padding: var(--px-4) var(--px-8);
    font-size: var(--px-11_5);
  }
</style>
