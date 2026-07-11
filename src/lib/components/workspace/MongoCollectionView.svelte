<script lang="ts">
  // MongoDB collection document viewer (M3). Loads documents via the dedicated
  // `mongo_exec` path (find + skip/limit paging) against the collection's own
  // database, and renders ResultGrid with an EditTarget keyed on `_id` — inline
  // edits become updateOne({_id},{$set}), deletes deleteOne({_id}), inserts
  // insertOne(doc). An optional JSON filter narrows the query.
  import ResultGrid, { type EditTarget } from '$lib/components/results/ResultGrid.svelte'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { mongoExec } from '$lib/ipc'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { QueryError, QueryResultSet, TabState } from '$lib/types'
  import { untrack } from 'svelte'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  // svelte-ignore state_referenced_locally
  const database = tab.state.database as string
  // svelte-ignore state_referenced_locally
  const collection = tab.state.collection as string
  const profile = $derived(connections.byId(tab.connectionId))

  let data = $state<QueryResultSet | null>(null)
  let error = $state<QueryError | null>(null)
  let loading = $state(false)
  let durationMs = $state(0)
  let filterText = $state('{}')
  let loaded = $state(0)
  let hasMore = $state(false)
  const PAGE = 100

  // Editing enabled once connected. Apply/Preview route through
  // applyGridChanges/previewGridChanges → Mongo arms (by `_id`).
  const editTarget = $derived<EditTarget | undefined>(
    profile && tab.connectionId
      ? {
          connId: tab.connectionId,
          system: 'mongodb',
          schema: database,
          table: collection,
          pkCols: ['_id'],
          onApplied: () => void load(),
        }
      : undefined,
  )

  function query(skip: number): string {
    const f = filterText.trim() || '{}'
    return `db.${collection}.find(${f}).skip(${skip}).limit(${PAGE})`
  }

  async function load() {
    if (!tab.connectionId || !profile) return
    loading = true
    error = null
    try {
      const res = await mongoExec(tab.connectionId, query(0), database, PAGE)
      durationMs = res.duration_ms
      if (res.ok && res.result) {
        data = res.result
        loaded = res.result.rows.length
        hasMore = res.result.rows.length >= PAGE
        for (const w of res.warnings ?? []) toasts.show(w, { system: 'mongodb' })
      } else if (res.error) {
        error = res.error
        data = null
      }
    } catch (e) {
      error = { system: 'mongodb', message: String(e), severity: 'error', raw: String(e) }
    } finally {
      loading = false
    }
  }

  async function loadMore() {
    if (!tab.connectionId || !data || !hasMore) return
    try {
      const res = await mongoExec(tab.connectionId, query(loaded), database, PAGE)
      if (res.error) {
        toasts.error(res.error.message)
        return
      }
      if (res.result) {
        data = {
          ...data,
          rows: [...data.rows, ...res.result.rows],
          total: data.rows.length + res.result.rows.length,
        }
        loaded += res.result.rows.length
        hasMore = res.result.rows.length >= PAGE
      }
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
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-7) var(--px-12);border-bottom:var(--px-1) solid var(--border);background:var(--surface);font-size:var(--px-12)">
    {#if profile}
      <SystemBadge system={profile.system} />
    {/if}
    <span class="mono">{database}.{collection}</span>
    <input
      class="mv-in mono"
      style="flex:1;max-width:var(--px-460)"
      bind:value={filterText}
      placeholder={'filter (JSON), e.g. {"age":{"$gt":18}}'}
      onkeydown={(e) => e.key === 'Enter' && load()}
    />
    <span class="mv-btn" onclick={() => load()} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0">Run</span>
    <div style="margin-left:auto;display:flex;align-items:center;gap:var(--px-8)">
      {#if data}
        <span class="mono" style="font-size:var(--px-11);color:var(--muted)">{data.total.toLocaleString()} docs · {durationMs} ms</span>
      {/if}
      {#if hasMore}
        <span class="mv-btn" onclick={loadMore} onkeydown={(e) => e.key === 'Enter' && loadMore()} role="button" tabindex="0" title="Fetch the next page (skip/limit)">↓ Load next page</span>
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
        {profile ? 'No documents' : 'Connection not found'}
      </div>
    {/if}
  </div>
</div>

<style>
  .mv-btn {
    font-size: var(--px-11);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-3) var(--px-9);
    cursor: pointer;
  }
  .mv-btn:hover {
    background: var(--hover);
  }
  .mv-in {
    background: var(--panel);
    color: var(--text);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-5);
    padding: var(--px-4) var(--px-8);
    font-size: var(--px-11_5);
  }
</style>
