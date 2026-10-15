<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
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
  style="flex:none;display:flex;align-items:stretch;background:var(--header);border-bottom:var(--px-1) solid var(--border);height:var(--px-40);{tabs.splitDir && tabs.activePane === pane ? 'box-shadow:inset 0 var(--px-2) 0 var(--primary)' : ''}"
  onpointerdown={() => tabs.focusPane(pane)}
>
  <!-- only the tabs scroll; + / split / More tabs stay pinned on the right -->
  <div
    bind:this={stripEl}
    class="scrollbar-none"
    style="flex:1;min-width:0;display:flex;align-items:stretch;overflow-x:auto;overflow-y:hidden"
    onwheel={(e) => {
      if (stripEl && Math.abs(e.deltaY) > Math.abs(e.deltaX)) stripEl.scrollLeft += e.deltaY
    }}
  >
  {#each paneTabs as tab (tab.id)}
    {@const idx = tabs.tabs.indexOf(tab)}
    {@const meta = systemMeta(tab.systemType)}
    {@const isActive = tab.id === activeId}
    <!-- the pinned Objects tab is a system tab: no close, no drag, no rename -->
    {@const closable = tab.contentType !== 'objects'}
    <ContextMenu.Root>
      <ContextMenu.Trigger style="display:flex;align-items:stretch;flex:none">
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
          title={tab.connectionName ? `${tab.title} — ${tab.connectionName}` : tab.title}
          class="ds-tab"
          class:active={isActive}
          style="--tab-accent:{meta.accent};{dropIdx === idx && dragIdx !== null && dragIdx !== idx ? 'outline:var(--px-1) solid var(--primary);' : ''}"
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
            <!-- title only — the connection (often a host/IP) stays out of the tab strip;
                 it is in the tooltip and in the workspace header -->
            <div style="min-width:0;display:flex;align-items:baseline">
              <span class="ds-tab-title">{tab.title}</span>
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
              style="flex:none;width:var(--px-18);height:var(--px-18);display:flex;align-items:center;justify-content:center;border-radius:var(--px-4)"
            ><Icon name="close" size={12} /></span>
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
  </div>

  <!-- nút + — dòng 188 (mở trong pane hiện tại của bar) -->
  <div
    onclick={() => tabs.openSqlTab({ pane })}
    onkeydown={(e) => e.key === 'Enter' && tabs.openSqlTab({ pane })}
    role="button"
    tabindex="0"
    title="New SQL tab (Ctrl+T)"
    class="tb-ctl"
    style="display:flex;align-items:center;padding:0 var(--px-10);cursor:pointer;color:var(--muted)"
  ><Icon name="plus" size={15} /></div>

  {#if tabs.splitDir}
    <div
      onclick={() => tabs.closeSplit()}
      onkeydown={(e) => e.key === 'Enter' && tabs.closeSplit()}
      role="button"
      tabindex="0"
      title="Close split (merge to one pane)"
      class="tb-ctl"
      style="display:flex;align-items:center;padding:0 var(--px-10);cursor:pointer;color:var(--muted)"
    ><Icon name="merge" size={14} /></div>
  {/if}

  {#if hasOverflow}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        style="display:flex;width:var(--px-28);flex:none;align-items:center;justify-content:center;border-left:var(--px-1) solid var(--border);color:var(--text2)"
        title="More tabs"
      ><Icon name="chevron-down" size={14} /></DropdownMenu.Trigger>
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
  /* Tabs never collapse to an ellipsis-only stub: they keep a readable minimum and
     the strip scrolls (the More-tabs menu lists everything). */
  .ds-tab {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: 0 var(--px-8) 0 var(--px-12);
    margin: var(--px-5) var(--px-2) 0;
    cursor: pointer;
    border-radius: var(--px-8) var(--px-8) 0 0;
    min-width: var(--px-110);
    max-width: var(--px-220);
    color: var(--text2);
    background: transparent;
    box-shadow: inset 0 calc(-1 * var(--px-2)) 0 transparent;
  }
  .ds-tab:hover {
    background: color-mix(in srgb, var(--text) 5%, transparent);
    color: var(--text);
  }
  .ds-tab.active {
    background: var(--surface);
    color: var(--text);
    box-shadow:
      inset 0 calc(-1 * var(--px-2)) 0 var(--tab-accent),
      0 calc(-1 * var(--px-1)) var(--px-3) color-mix(in srgb, var(--text) 6%, transparent);
  }
  .ds-tab-title {
    font-size: var(--px-12_5);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 0 1 auto;
    min-width: var(--px-28);
  }
  .ds-tab.active .ds-tab-title {
    font-weight: 600;
  }
  .ds-tab:not(.active) :global(svg) {
    opacity: 0.8;
  }
  .tb-ctl:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--text) 5%, transparent);
  }
  .tab-close {
    color: var(--muted);
    opacity: 0;
    transition: background 0.12s, color 0.12s, opacity 0.12s;
  }
  .ds-tab:hover .tab-close,
  .ds-tab.active .tab-close,
  .tab-close:focus-visible {
    opacity: 1;
  }
  .tab-close:hover {
    background: color-mix(in srgb, var(--error) 16%, transparent);
    color: var(--error);
  }
</style>
