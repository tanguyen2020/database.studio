<script lang="ts">
  // App shell:
  //  TitleBar → [Sidebar: ConnectionList / ObjectExplorer] | [TabBar → Workspace] → StatusBar
  // Global keyboard shortcuts + layout resizers (all sizes persisted).
  import { onMount } from 'svelte'
  import TitleBar from '$lib/components/TitleBar.svelte'
  import StatusBar from '$lib/components/StatusBar.svelte'
  import Toasts from '$lib/components/Toasts.svelte'
  import TabBar from '$lib/components/tabs/TabBar.svelte'
  import SaveBeforeCloseDialog from '$lib/components/tabs/SaveBeforeCloseDialog.svelte'
  import ConnectionList from '$lib/components/connections/ConnectionList.svelte'
  import ConnectionForm from '$lib/components/connections/ConnectionForm.svelte'
  import DeleteConnectionDialog from '$lib/components/connections/DeleteConnectionDialog.svelte'
  import EditConnectedDialog from '$lib/components/connections/EditConnectedDialog.svelte'
  import SystemPicker from '$lib/components/connections/SystemPicker.svelte'
  import ObjectExplorer from '$lib/components/explorer/ObjectExplorer.svelte'
  import SqlWorkspace from '$lib/components/workspace/SqlWorkspace.svelte'
  import TableViewerTab from '$lib/components/workspace/TableViewerTab.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { ui } from '$lib/stores/ui.svelte'

  let ready = $state(false)

  onMount(() => {
    void (async () => {
      await ui.loadPersisted()
      await connections.load()
      await tabs.restore()
      ready = true
    })()

    // flush tab state when the window closes
    const flush = () => void tabs.persist()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  })

  function onKeydown(e: KeyboardEvent) {
    const ctrl = e.ctrlKey || e.metaKey
    if (!ctrl) return
    const key = e.key.toLowerCase()

    if (key === 't' && !e.shiftKey) {
      e.preventDefault()
      tabs.openSqlTab({})
    } else if (key === 'w') {
      e.preventDefault()
      tabs.closeActive()
    } else if (key === 't' && e.shiftKey) {
      e.preventDefault()
      tabs.restoreClosed()
    } else if (key === 'tab') {
      e.preventDefault()
      if (e.shiftKey) tabs.prev()
      else tabs.next()
    } else if (/^[1-9]$/.test(e.key)) {
      e.preventDefault()
      tabs.jumpTo(Number(e.key))
    }
  }

  // ---- resizers (sidebar width + connection-list height) ----
  let draggingSidebar = $state(false)
  let draggingConnList = $state(false)

  function dragSidebar(e: PointerEvent) {
    if (!draggingSidebar) return
    ui.sidebarWidth = Math.min(Math.max(e.clientX, 170), 480)
    ui.persistSizes()
  }

  function dragConnList(e: PointerEvent) {
    if (!draggingConnList) return
    // relative to viewport: below the 32px title bar
    ui.connListHeight = Math.min(Math.max(e.clientY - 32, 120), window.innerHeight - 200)
    ui.persistSizes()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full flex-col overflow-hidden">
  <TitleBar />

  <div class="flex min-h-0 grow">
    <!-- sidebar -->
    <aside
      class="flex shrink-0 flex-col overflow-hidden border-r border-border bg-panel"
      style="width: {ui.sidebarWidth}px;"
    >
      <div style="height: {ui.connListHeight}px;" class="shrink-0 overflow-hidden">
        <ConnectionList />
      </div>
      <div
        class="h-[5px] shrink-0 cursor-row-resize border-y border-border bg-header hover:bg-primary/40"
        role="separator"
        aria-orientation="horizontal"
        onpointerdown={(e) => {
          draggingConnList = true
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onpointermove={dragConnList}
        onpointerup={() => (draggingConnList = false)}
      ></div>
      <div class="min-h-0 grow overflow-hidden">
        <ObjectExplorer />
      </div>
    </aside>

    <!-- sidebar width handle -->
    <div
      class="w-[5px] shrink-0 cursor-col-resize border-x border-border bg-header hover:bg-primary/40"
      role="separator"
      aria-orientation="vertical"
      onpointerdown={(e) => {
        draggingSidebar = true
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onpointermove={dragSidebar}
      onpointerup={() => (draggingSidebar = false)}
    ></div>

    <!-- main area -->
    <main class="flex min-w-0 grow flex-col overflow-hidden bg-surface">
      <TabBar />
      <div class="min-h-0 grow">
        {#if !ready}
          <div class="flex h-full items-center justify-center text-[12px] text-mutedfg">
            Đang khởi động…
          </div>
        {:else if tabs.active}
          {#key tabs.active.id}
            {#if tabs.active.contentType === 'table-viewer'}
              <TableViewerTab tab={tabs.active} />
            {:else}
              <SqlWorkspace tab={tabs.active} />
            {/if}
          {/key}
        {:else}
          <div class="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-mutedfg">
            <p>Chưa có tab nào mở</p>
            <button class="text-primary hover:underline" onclick={() => tabs.openSqlTab({})}>
              + New SQL tab (Ctrl+T)
            </button>
          </div>
        {/if}
      </div>
    </main>
  </div>

  <StatusBar />
</div>

<!-- global dialogs + toasts -->
<SystemPicker />
<ConnectionForm />
<DeleteConnectionDialog />
<EditConnectedDialog />
<SaveBeforeCloseDialog />
<Toasts />
