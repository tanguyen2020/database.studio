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
  import { systemMeta } from '$lib/systems'
  import { exportWizard } from '$lib/stores/export.svelte'
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
  // Page-based pagination (skip/limit) — consistent with the relational Table Viewer:
  // a total from countDocuments(filter) drives Page X of Y + first/prev/next/last.
  let page = $state(0)
  let pageSize = $state(100)
  let totalRecords = $state<number | null>(null)
  const PAGE_SIZES = [100, 200, 500, 1000]
  const totalPages = $derived(
    totalRecords != null ? Math.max(1, Math.ceil(totalRecords / pageSize)) : null,
  )
  const canNext = $derived(totalPages != null ? page + 1 < totalPages : (data?.rows.length ?? 0) >= pageSize)

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

  const filterArg = () => filterText.trim() || '{}'
  function query(): string {
    return `db.${collection}.find(${filterArg()}).skip(${page * pageSize}).limit(${pageSize})`
  }

  // The exact document count for the current filter → drives the pager's Page X of Y.
  async function loadCount() {
    if (!tab.connectionId) return
    try {
      const res = await mongoExec(tab.connectionId, `db.${collection}.countDocuments(${filterArg()})`, database, 1)
      const c = res.ok ? (res.result?.rows?.[0] as { count?: unknown } | undefined)?.count : undefined
      const n = typeof c === 'number' ? c : Number(c)
      totalRecords = Number.isFinite(n) ? n : null
    } catch {
      totalRecords = null
    }
  }

  // Run the filter (resets to page 0 + recounts). `keepPage` is used by the pager
  // buttons to reload a specific page without re-counting/resetting.
  async function load(keepPage = false) {
    if (!tab.connectionId || !profile) return
    if (!keepPage) page = 0
    loading = true
    error = null
    if (!keepPage) void loadCount()
    try {
      const res = await mongoExec(tab.connectionId, query(), database, pageSize)
      durationMs = res.duration_ms
      if (res.ok && res.result) {
        data = res.result
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

  function gotoPage(p: number) {
    const max = totalPages != null ? totalPages - 1 : p
    const next = Math.max(0, Math.min(p, max))
    if (next === page) return
    page = next
    void load(true)
  }
  function setPageSize(n: number) {
    if (n === pageSize) return
    pageSize = n
    page = 0
    void load(true)
  }

  // Export the loaded documents (CSV/JSON/…) via the shared result-mode wizard.
  function exportDocs() {
    if (!tab.connectionId || !data) return
    const headers = data.cols.map((c) => c[0])
    exportWizard.showResult(tab.connectionId, headers, data.rows)
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
    <span style="font-weight:600;color:var(--text)" title="Connection">{profile?.name ?? '—'}</span>
    <span style="color:var(--muted)">/</span>
    <span
      class="mono"
      title={`Database: ${database} · ${database}.${collection}`}
      style="display:inline-flex;align-items:center;gap:var(--px-5);font-size:var(--px-11_5);font-weight:600;color:{systemMeta(profile?.system).accent};background:color-mix(in srgb, {systemMeta(profile?.system).accent} 14%, transparent);border:var(--px-1) solid color-mix(in srgb, {systemMeta(profile?.system).accent} 45%, transparent);border-radius:var(--px-6);padding:var(--px-2) var(--px-8)"
    >
      <span style="font-size:var(--px-11)">▤</span>{database}
    </span>
    <span class="mono" style="color:var(--text2)">{database}.{collection}</span>
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
        <span class="mono" style="font-size:var(--px-11);color:var(--muted)">{durationMs} ms</span>
        <span class="mv-btn" onclick={exportDocs} onkeydown={(e) => e.key === 'Enter' && exportDocs()} role="button" tabindex="0" title="Export the loaded documents (CSV/JSON)">Export…</span>
      {/if}
    </div>
  </div>

  <div style="min-height:0;flex:1;display:flex;flex-direction:column">
    {#if loading && !data}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">Loading…</div>
    {:else if error}
      <div class="selectable" style="padding:var(--px-16);font-size:var(--px-12_5);color:var(--error)">✗ {error.message}</div>
    {:else if data}
      <ResultGrid {data} {editTarget} system="mongodb" />
    {:else}
      <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">
        {profile ? 'No documents' : 'Connection not found'}
      </div>
    {/if}
  </div>

  <!-- footer pager — docs range + page count + first/prev/next/last + page size,
       consistent with the relational Table Viewer. -->
  {#if data}
    <div class="mono" style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-5) var(--px-12);border-top:var(--px-1) solid var(--border);background:var(--header);font-size:var(--px-11_5);color:var(--text2)">
      <span>
        {#if data.rows.length}
          {(page * pageSize + 1).toLocaleString()}–{(page * pageSize + data.rows.length).toLocaleString()}
        {:else}0{/if}
        {#if totalRecords != null}of {totalRecords.toLocaleString()} doc{totalRecords === 1 ? '' : 's'}{:else}(filtered){/if}
      </span>
      <div style="margin-left:auto;display:flex;align-items:center;gap:var(--px-5)">
        <label style="display:flex;align-items:center;gap:var(--px-5);color:var(--muted)">Page size
          <select
            value={pageSize}
            onchange={(e) => setPageSize(Number(e.currentTarget.value))}
            style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-2) var(--px-6);color:var(--text);font-size:var(--px-11_5)"
          >
            {#each PAGE_SIZES as n (n)}<option value={n}>{n}</option>{/each}
          </select>
        </label>
        <span class="mv-pg" style="opacity:{page > 0 ? 1 : 0.4}" onclick={() => gotoPage(0)} onkeydown={(e) => e.key === 'Enter' && gotoPage(0)} role="button" tabindex="0" title="First page">«</span>
        <span class="mv-pg" style="opacity:{page > 0 ? 1 : 0.4}" onclick={() => gotoPage(page - 1)} onkeydown={(e) => e.key === 'Enter' && gotoPage(page - 1)} role="button" tabindex="0" title="Previous page">‹</span>
        <span style="align-self:center;color:var(--text2)">Page {(page + 1).toLocaleString()}{totalPages != null ? ` of ${totalPages.toLocaleString()}` : ''}</span>
        <span class="mv-pg" style="opacity:{canNext ? 1 : 0.4}" onclick={() => gotoPage(page + 1)} onkeydown={(e) => e.key === 'Enter' && gotoPage(page + 1)} role="button" tabindex="0" title="Next page">›</span>
        {#if totalPages != null}
          <span class="mv-pg" style="opacity:{page + 1 < totalPages ? 1 : 0.4}" onclick={() => gotoPage(totalPages - 1)} onkeydown={(e) => e.key === 'Enter' && gotoPage(totalPages - 1)} role="button" tabindex="0" title="Last page">»</span>
        {/if}
      </div>
    </div>
  {/if}
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
  .mv-pg {
    cursor: pointer;
    padding: 0 var(--px-5);
    font-size: var(--px-13);
    color: var(--text2);
    user-select: none;
  }
  .mv-pg:hover {
    color: var(--text);
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
