<script lang="ts">
  // Tab bar — port 1:1 từ Database Studio.dc.html dòng 174-189:
  // bar 40px nền --header; tab = icon hệ 15px + (connName 9px / title 12px 600),
  // underline 2px accent khi active, opacity .62 khi inactive, dirty ● màu accent,
  // nút × 16×16, nút + cuối strip. (Prototype dùng ICON hệ, không phải badge 2 ký tự.)
  // Drag reorder / double-click rename / context menu / More tabs: hành vi theo spec.
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { systemMeta } from '$lib/systems'
  import { tabs } from '$lib/stores/tabs.svelte'

  // pane = 0 (mặc định / khi không split) hoặc 1 (pane thứ hai của split view)
  let { pane = 0 }: { pane?: 0 | 1 } = $props()
  const paneTabs = $derived(tabs.tabsInPane(pane))
  const activeId = $derived(pane === 1 ? tabs.activeTabId1 : tabs.activeTabId)

  let stripEl = $state<HTMLDivElement | null>(null)
  let dragIdx = $state<number | null>(null)
  let dropIdx = $state<number | null>(null)
  let renamingId = $state<string | null>(null)
  let renameValue = $state('')
  let hasOverflow = $state(false)

  $effect(() => {
    void tabs.tabs.length
    requestAnimationFrame(() => {
      if (stripEl) hasOverflow = stripEl.scrollWidth > stripEl.clientWidth + 4
    })
  })

  function startRename(id: string, current: string) {
    renamingId = id
    renameValue = current
  }

  function commitRename() {
    if (renamingId) tabs.rename(renamingId, renameValue)
    renamingId = null
  }

  function onDragStart(e: DragEvent, idx: number) {
    dragIdx = idx
    e.dataTransfer?.setData('text/plain', String(idx))
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(e: DragEvent, idx: number) {
    e.preventDefault()
    dropIdx = idx
  }

  function onDrop(e: DragEvent, idx: number) {
    e.preventDefault()
    if (dragIdx !== null) tabs.reorder(dragIdx, idx)
    dragIdx = null
    dropIdx = null
  }

  function scrollActiveIntoView(node: HTMLElement, isActive: boolean) {
    if (isActive) node.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    return {
      update(active: boolean) {
        if (active) node.scrollIntoView({ inline: 'nearest', block: 'nearest' })
      },
    }
  }
</script>

<!-- TAB BAR — dòng 175 -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  style="flex:none;display:flex;align-items:stretch;background:var(--header);border-bottom:var(--px-1) solid var(--border);height:var(--px-40);overflow-x:auto;overflow-y:hidden;{tabs.splitDir && tabs.activePane === pane ? 'box-shadow:inset 0 var(--px-2) 0 var(--primary)' : ''}"
  bind:this={stripEl}
  class="scrollbar-none"
  onpointerdown={() => tabs.focusPane(pane)}
>
  {#each paneTabs as tab (tab.id)}
    {@const idx = tabs.tabs.indexOf(tab)}
    {@const meta = systemMeta(tab.systemType)}
    {@const isActive = tab.id === activeId}
    <!-- the pinned Objects tab is a system tab: no close, no drag, no rename -->
    {@const closable = tab.contentType !== 'objects'}
    <ContextMenu.Root>
      <ContextMenu.Trigger style="display:flex;align-items:stretch;min-width:0">
        <!-- tab — dòng 177 -->
        <div
          role="tab"
          tabindex="0"
          aria-selected={isActive}
          draggable={renamingId !== tab.id && closable}
          use:scrollActiveIntoView={isActive}
          onclick={() => tabs.activate(tab.id)}
          onauxclick={(e) => {
            if (e.button === 1 && closable) tabs.requestClose([tab.id])
          }}
          ondblclick={() => closable && startRename(tab.id, tab.title)}
          onkeydown={(e) => e.key === 'Enter' && tabs.activate(tab.id)}
          ondragstart={(e) => onDragStart(e, idx)}
          ondragover={(e) => onDragOver(e, idx)}
          ondrop={(e) => onDrop(e, idx)}
          ondragend={() => {
            dragIdx = null
            dropIdx = null
          }}
          style="display:flex;align-items:center;gap:var(--px-8);padding:0 var(--px-11);margin:var(--px-4) var(--px-3) 0;cursor:pointer;border-top-left-radius:var(--px-8);border-top-right-radius:var(--px-8);border-bottom:var(--px-2) solid {isActive ? meta.accent : 'transparent'};background:{isActive ? 'var(--surface)' : 'transparent'};opacity:{isActive ? 1 : 0.62};min-width:0;max-width:var(--px-220);{dropIdx === idx && dragIdx !== null && dragIdx !== idx ? 'outline:var(--px-1) solid var(--primary);' : ''}"
        >
          <span style="flex:none;display:flex;align-items:center"><SystemIcon system={tab.systemType} size={15} /></span>
          {#if renamingId === tab.id}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              style="width:100%;border:none;border-bottom:var(--px-1) solid var(--primary);background:transparent;font-size:var(--px-12);outline:none;color:var(--text)"
              bind:value={renameValue}
              autofocus
              onblur={commitRename}
              onkeydown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') renamingId = null
              }}
            />
          {:else}
            <div style="min-width:0;display:flex;flex-direction:column;line-height:1.15">
              <span style="font-size:var(--px-9);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{tab.connectionName}</span>
              <span style="font-size:var(--px-12);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)">{tab.title}</span>
            </div>
          {/if}
          {#if tab.isPinned}
            <!-- pin theo spec phase-1 mục 4 (prototype không hiển thị pin) -->
            <span style="flex:none;font-size:var(--px-10);color:var(--text2)" title="Pinned">📌</span>
          {/if}
          <!-- dirtyMark: '●' hoặc chuỗi rỗng (dòng 4680) — span rỗng không chiếm width -->
          <span style="flex:none;color:{tab.isDirty ? meta.accent : 'transparent'};font-size:var(--px-13)" title={tab.isDirty ? 'Unsaved changes' : ''}>{tab.isDirty ? '●' : ''}</span>
          {#if closable}
            <span
              onclick={(e) => {
                e.stopPropagation()
                tabs.requestClose([tab.id])
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  tabs.requestClose([tab.id])
                }
              }}
              role="button"
              tabindex="0"
              title="Close (Ctrl+W)"
              class="tab-close"
              style="flex:none;font-size:var(--px-16);line-height:1;width:var(--px-18);height:var(--px-18);display:flex;align-items:center;justify-content:center;border-radius:var(--px-4)"
            >×</span>
          {/if}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content class="w-52">
        {#if !closable}
          <!-- pinned system tab: no close / duplicate / split / rename actions -->
          <ContextMenu.Item disabled>Objects (pinned)</ContextMenu.Item>
        {:else}
          <ContextMenu.Item onclick={() => tabs.togglePin(tab.id)}>
            {tab.isPinned ? 'Unpin' : 'Pin'}
          </ContextMenu.Item>
          <ContextMenu.Item onclick={() => tabs.duplicate(tab.id)}>Duplicate</ContextMenu.Item>
          <ContextMenu.Item onclick={() => startRename(tab.id, tab.title)}>Rename</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item onclick={() => tabs.requestClose([tab.id])}>Close</ContextMenu.Item>
          <ContextMenu.Item disabled={tabs.tabs.length <= 1} onclick={() => tabs.closeOthers(tab.id)}>
            Close Others
          </ContextMenu.Item>
          <ContextMenu.Item disabled={idx === tabs.tabs.length - 1} onclick={() => tabs.closeToRight(tab.id)}>
            Close to the Right
          </ContextMenu.Item>
          <ContextMenu.Item onclick={() => tabs.requestClose(tabs.tabs.map((t) => t.id))}>Close All</ContextMenu.Item>
          <ContextMenu.Separator />
          {#if !tabs.splitDir}
            <ContextMenu.Item disabled={tabs.tabs.length <= 1} onclick={() => tabs.moveToSplit(tab.id, 'v')}>Split Right</ContextMenu.Item>
            <ContextMenu.Item disabled={tabs.tabs.length <= 1} onclick={() => tabs.moveToSplit(tab.id, 'h')}>Split Down</ContextMenu.Item>
          {:else}
            <ContextMenu.Item onclick={() => tabs.moveToSplit(tab.id)}>Move to Other Pane</ContextMenu.Item>
            <ContextMenu.Item onclick={() => tabs.toggleSplitDir()}>Toggle Split Direction</ContextMenu.Item>
            <ContextMenu.Item onclick={() => tabs.closeSplit()}>Close Split (Merge)</ContextMenu.Item>
          {/if}
        {/if}
      </ContextMenu.Content>
    </ContextMenu.Root>
  {/each}

  <!-- nút + — dòng 188 (mở trong pane hiện tại của bar) -->
  <div
    onclick={() => tabs.openSqlTab({ pane })}
    onkeydown={(e) => e.key === 'Enter' && tabs.openSqlTab({ pane })}
    role="button"
    tabindex="0"
    title="New SQL tab (Ctrl+T)"
    style="display:flex;align-items:center;padding:0 var(--px-12);cursor:pointer;color:var(--muted);font-size:var(--px-16)"
  >+</div>

  {#if tabs.splitDir}
    <div
      onclick={() => tabs.closeSplit()}
      onkeydown={(e) => e.key === 'Enter' && tabs.closeSplit()}
      role="button"
      tabindex="0"
      title="Close split (merge to one pane)"
      style="display:flex;align-items:center;padding:0 var(--px-10);cursor:pointer;color:var(--muted);font-size:var(--px-13)"
    >⊟</div>
  {/if}

  {#if hasOverflow}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        style="display:flex;width:var(--px-28);flex:none;align-items:center;justify-content:center;border-left:var(--px-1) solid var(--border);font-size:var(--px-11);color:var(--text2)"
        title="More tabs"
      >⌄</DropdownMenu.Trigger>
      <DropdownMenu.Content class="max-h-[50vh] w-64 overflow-y-auto" align="end">
        {#each paneTabs as tab (tab.id)}
          <DropdownMenu.Item onclick={() => tabs.activate(tab.id)}>
            <SystemIcon system={tab.systemType} size={15} />
            <span style="margin-left:var(--px-6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{tab.title}</span>
            {#if tab.isDirty}<span style="margin-left:auto">●</span>{/if}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
</div>

<style>
  .scrollbar-none::-webkit-scrollbar {
    display: none;
  }
  .tab-close {
    color: var(--text2);
    transition: background 0.12s, color 0.12s;
  }
  .tab-close:hover {
    background: var(--error);
    color: var(--hex-fff);
  }
</style>
