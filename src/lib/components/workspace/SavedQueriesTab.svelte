<script lang="ts">
  // Saved Queries (snippets) tab — port 1:1 từ Database Studio.dc.html
  // dòng 1165-1186. Header + danh sách snippet (📄 tên + badge hệ). Click → mở
  // SQL tab với snippet đó. Ctrl+S ở editor lưu snippet mới (xem SqlWorkspace).
  import * as ipc from '$lib/ipc'
  import type { Snippet } from '$lib/ipc'
  import { systemMeta } from '$lib/systems'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { snippets as snippetStore } from '$lib/stores/snippets.svelte'

  function openSnippet(s: Snippet) {
    tabs.openSqlTab({
      connectionId: connections.selectedId ?? null,
      title: s.name,
      query: s.sql,
    })
  }

  async function remove(e: MouseEvent, s: Snippet) {
    e.stopPropagation()
    await snippetStore.remove(s.id)
    toasts.success(`Deleted "${s.name}"`)
  }

  $effect(() => {
    void snippetStore.load()
  })
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- header — dòng 1167-1170 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-12);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="font-weight:700;font-size:var(--px-13)">Saved Queries</span>
    <span style="font-size:var(--px-11);color:var(--muted)">Ctrl+S saves the current editor</span>
  </div>
  <!-- list — dòng 1171-1184 -->
  <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-8) 0">
    {#each snippetStore.items as s (s.id)}
      {@const meta = systemMeta(s.system ?? 'orphan')}
      <div
        onclick={() => openSnippet(s)}
        onkeydown={(e) => e.key === 'Enter' && openSnippet(s)}
        role="button"
        tabindex="0"
        class="saved-row"
        style="display:flex;align-items:center;gap:var(--px-9);padding:var(--px-6) var(--px-16) var(--px-6) var(--px-38);cursor:pointer;font-size:var(--px-12_5);color:var(--text2)"
      >
        <span style="color:var(--muted)">📄</span>
        <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{s.name}</span>
        {#if s.system}
          <span style="flex:none;font-size:var(--px-9);font-weight:700;border-radius:var(--px-3);padding:var(--px-1) var(--px-6);background:{meta.bg};color:{meta.fg}">{meta.badge}</span>
        {/if}
        <span
          class="saved-del"
          onclick={(e) => remove(e, s)}
          onkeydown={(e) => e.key === 'Enter' && remove(e as unknown as MouseEvent, s)}
          role="button"
          tabindex="0"
          title="Delete"
          style="flex:none;color:var(--muted);font-size:var(--px-13)"
        >×</span>
      </div>
    {:else}
      <div style="padding:var(--px-16);font-size:var(--px-12);color:var(--muted)">
        No snippets yet. Press Ctrl+S in the SQL editor to save one.
      </div>
    {/each}
  </div>
</div>

<style>
  .saved-row:hover {
    background: var(--hover);
  }
  .saved-del {
    opacity: 0;
  }
  .saved-row:hover .saved-del {
    opacity: 1;
  }
</style>
