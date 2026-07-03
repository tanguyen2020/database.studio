<script lang="ts">
  // Tab bar: system badge + connection name + title + dirty dot + pin.
  // Active tab = 2px accent underline; inactive dimmed 60% (color kept).
  // Drag & drop reorder, overflow scroll + "More tabs" dropdown,
  // double-click rename, right-click context menu.
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { systemMeta } from '$lib/systems'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { connections } from '$lib/stores/connections.svelte'

  let stripEl = $state<HTMLDivElement | null>(null)
  let dragIdx = $state<number | null>(null)
  let dropIdx = $state<number | null>(null)
  let renamingId = $state<string | null>(null)
  let renameValue = $state('')
  let hasOverflow = $state(false)

  $effect(() => {
    // re-check overflow whenever the tab list changes
    void tabs.tabs.length
    requestAnimationFrame(() => {
      if (stripEl) hasOverflow = stripEl.scrollWidth > stripEl.clientWidth + 4
    })
  })

  function newTab() {
    tabs.openSqlTab({})
  }

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

<div class="flex h-[34px] items-stretch border-b border-border bg-header">
  <div
    bind:this={stripEl}
    class="scrollbar-none flex min-w-0 grow items-stretch overflow-x-auto"
    style="scrollbar-width: none;"
  >
    {#each tabs.tabs as tab, idx (tab.id)}
      {@const meta = systemMeta(tab.systemType)}
      {@const isActive = tab.id === tabs.activeTabId}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <div
            class="group relative flex max-w-[220px] min-w-[120px] cursor-pointer select-none items-center gap-1.5 border-r border-border px-2.5
              {isActive ? 'bg-surface' : 'bg-transparent hover:bg-hover/50'}
              {dropIdx === idx && dragIdx !== null && dragIdx !== idx ? 'outline outline-1 outline-primary' : ''}"
            style={isActive ? '' : 'opacity: 0.6;'}
            role="tab"
            tabindex="0"
            aria-selected={isActive}
            draggable={renamingId !== tab.id}
            use:scrollActiveIntoView={isActive}
            onclick={() => tabs.activate(tab.id)}
            onauxclick={(e) => {
              if (e.button === 1) tabs.requestClose([tab.id])
            }}
            ondblclick={() => startRename(tab.id, tab.title)}
            onkeydown={(e) => e.key === 'Enter' && tabs.activate(tab.id)}
            ondragstart={(e) => onDragStart(e, idx)}
            ondragover={(e) => onDragOver(e, idx)}
            ondrop={(e) => onDrop(e, idx)}
            ondragend={() => {
              dragIdx = null
              dropIdx = null
            }}
          >
            <SystemBadge system={tab.systemType} />
            {#if renamingId === tab.id}
              <!-- svelte-ignore a11y_autofocus -->
              <input
                class="w-full border-b border-primary bg-transparent text-[12px] outline-none"
                bind:value={renameValue}
                autofocus
                onblur={commitRename}
                onkeydown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') renamingId = null
                }}
              />
            {:else}
              <div class="min-w-0 grow leading-tight">
                {#if tab.connectionName}
                  <div class="truncate text-[9px] text-mutedfg">{tab.connectionName}</div>
                {/if}
                <div class="truncate text-[12px]">{tab.title}</div>
              </div>
            {/if}
            {#if tab.isPinned}
              <span class="text-[10px] text-text2" title="Pinned">📌</span>
            {/if}
            {#if tab.isDirty}
              <span class="text-[13px] leading-none" style="color: {meta.accent};" title="Unsaved changes">●</span>
            {/if}
            <button
              class="rounded px-0.5 text-[13px] leading-none text-mutedfg opacity-0 hover:bg-hover hover:text-foreground group-hover:opacity-100
                {isActive ? 'opacity-60' : ''}"
              title="Close (Ctrl+W)"
              onclick={(e) => {
                e.stopPropagation()
                tabs.requestClose([tab.id])
              }}
            >
              ×
            </button>
            <!-- active underline: 2px system accent -->
            {#if isActive}
              <span
                class="absolute inset-x-0 bottom-0 h-[2px]"
                style="background: {meta.accent};"
              ></span>
            {/if}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Content class="w-52">
          <ContextMenu.Item onclick={() => tabs.togglePin(tab.id)}>
            {tab.isPinned ? 'Unpin' : 'Pin'}
          </ContextMenu.Item>
          <ContextMenu.Item onclick={() => tabs.duplicate(tab.id)}>Duplicate</ContextMenu.Item>
          <ContextMenu.Item onclick={() => startRename(tab.id, tab.title)}>Rename</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item onclick={() => tabs.requestClose([tab.id])}>Close</ContextMenu.Item>
          <ContextMenu.Item
            disabled={tabs.tabs.length <= 1}
            onclick={() => tabs.closeOthers(tab.id)}
          >
            Close Others
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={idx === tabs.tabs.length - 1}
            onclick={() => tabs.closeToRight(tab.id)}
          >
            Close to the Right
          </ContextMenu.Item>
          <ContextMenu.Item
            onclick={() => tabs.requestClose(tabs.tabs.map((t) => t.id))}
          >
            Close All
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>
    {/each}

    <button
      class="flex w-[30px] shrink-0 items-center justify-center text-[16px] text-text2 hover:bg-hover hover:text-foreground"
      title="New SQL tab (Ctrl+T)"
      onclick={newTab}
    >
      +
    </button>
  </div>

  {#if hasOverflow}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="flex w-[28px] shrink-0 items-center justify-center border-l border-border text-[11px] text-text2 hover:bg-hover"
        title="More tabs"
      >
        ⌄
      </DropdownMenu.Trigger>
      <DropdownMenu.Content class="max-h-[50vh] w-64 overflow-y-auto" align="end">
        {#each tabs.tabs as tab (tab.id)}
          <DropdownMenu.Item onclick={() => tabs.activate(tab.id)}>
            <SystemBadge system={tab.systemType} />
            <span class="ml-1.5 truncate">{tab.title}</span>
            {#if tab.isDirty}<span class="ml-auto">●</span>{/if}
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
</style>
