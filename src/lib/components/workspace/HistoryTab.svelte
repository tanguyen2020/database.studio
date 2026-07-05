<script lang="ts">
  // Query History tab — port 1:1 từ Database Studio.dc.html dòng 858-880.
  // Header: title + ô search (⌕, debounce) + count. Mỗi dòng: ts mono 130px +
  // badge hệ 2 ký tự + sql + rows + ms. Click → mở SQL tab mới với query đó.
  import * as ipc from '$lib/ipc'
  import type { HistoryEntry } from '$lib/ipc'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'

  let entries = $state<HistoryEntry[]>([])
  let search = $state('')
  let timer: ReturnType<typeof setTimeout> | null = null

  async function load() {
    try {
      entries = await ipc.listHistory({ search: search.trim() || undefined })
    } catch {
      entries = []
    }
  }

  $effect(() => {
    void search
    if (timer) clearTimeout(timer)
    timer = setTimeout(load, 300)
  })

  function openQuery(h: HistoryEntry) {
    const profile = connections.byId(h.connection_id)
    tabs.openSqlTab({
      connectionId: profile ? h.connection_id : (connections.selectedId ?? null),
      title: 'History query',
      query: h.sql,
    })
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- header — dòng 861-868 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-12);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="font-weight:700;font-size:var(--px-13)">Query History</span>
    <div style="display:flex;align-items:center;gap:var(--px-6);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-5) var(--px-9);width:var(--px-300)">
      <span style="color:var(--muted);font-size:var(--px-12)">⌕</span>
      <input
        bind:value={search}
        placeholder="Search queries…"
        style="border:none;background:transparent;color:var(--text);font-size:var(--px-12);outline:none;width:100%;font-family:inherit"
      />
    </div>
    <span style="font-size:var(--px-11_5);color:var(--muted);margin-left:auto">{entries.length} queries</span>
  </div>
  <!-- list — dòng 869-879 -->
  <div style="flex:1;overflow:auto;min-height:0">
    {#each entries as h (h.executed_at + h.sql)}
      {@const meta = systemMeta(h.system)}
      <div
        onclick={() => openQuery(h)}
        onkeydown={(e) => e.key === 'Enter' && openQuery(h)}
        role="button"
        tabindex="0"
        class="hist-row"
        style="display:flex;align-items:center;gap:var(--px-12);padding:var(--px-9) var(--px-16);border-bottom:var(--px-1) solid var(--border);cursor:pointer"
      >
        <span class="mono" style="flex:none;font-size:var(--px-10_5);color:var(--muted);width:var(--px-130)">{h.executed_at}</span>
        <span style="flex:none;font-size:var(--px-9);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:{meta.bg};color:{meta.fg};border:var(--px-1) solid {meta.border}">{meta.badge}</span>
        <span class="mono" style="flex:1;min-width:0;font-size:var(--px-12);color:{h.ok ? 'var(--text2)' : 'var(--error)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{h.sql}</span>
        <span class="mono" style="flex:none;font-size:var(--px-11);color:var(--text2);width:var(--px-90);text-align:right">{h.row_count != null ? `${h.row_count.toLocaleString()} rows` : ''}</span>
        <span class="mono" style="flex:none;font-size:var(--px-11);color:var(--muted);width:var(--px-54);text-align:right">{h.duration_ms != null ? `${h.duration_ms}ms` : ''}</span>
      </div>
    {:else}
      <div style="padding:var(--px-16);font-size:var(--px-12);color:var(--muted)">
        {search ? 'No matching queries' : 'No query history yet'}
      </div>
    {/each}
  </div>
</div>

<style>
  .hist-row:hover {
    background: var(--hover);
  }
</style>
