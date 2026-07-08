<script lang="ts">
  // App shell:
  //  TitleBar → [Sidebar: ConnectionList / ObjectExplorer] | [TabBar → Workspace] → StatusBar
  // Global keyboard shortcuts + layout resizers (all sizes persisted).
  import { onMount } from 'svelte'
  import TitleBar from '$lib/components/TitleBar.svelte'
  import StatusBar from '$lib/components/StatusBar.svelte'
  import PropertiesPanel from '$lib/components/PropertiesPanel.svelte'
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
  import RedisWorkspace from '$lib/components/workspace/RedisWorkspace.svelte'
  import RedisPubSub from '$lib/components/workspace/RedisPubSub.svelte'
  import NatsWorkspace from '$lib/components/workspace/NatsWorkspace.svelte'
  import NatsSubjectMessages from '$lib/components/workspace/NatsSubjectMessages.svelte'
  import KafkaWorkspace from '$lib/components/workspace/KafkaWorkspace.svelte'
  import KafkaConsumer from '$lib/components/workspace/KafkaConsumer.svelte'
  import KafkaProducer from '$lib/components/workspace/KafkaProducer.svelte'
  import SchemaRegistryWorkspace from '$lib/components/workspace/SchemaRegistryWorkspace.svelte'
  import CassandraRing from '$lib/components/workspace/CassandraRing.svelte'
  import TableDesigner from '$lib/components/workspace/TableDesigner.svelte'
  import PlanVisualizer from '$lib/components/workspace/PlanVisualizer.svelte'
  import ErDiagram from '$lib/components/workspace/ErDiagram.svelte'
  import SchemaCompare from '$lib/components/workspace/SchemaCompare.svelte'
  import IndexScanner from '$lib/components/workspace/IndexScanner.svelte'
  import IndexManager from '$lib/components/workspace/IndexManager.svelte'
  import AdminView from '$lib/components/workspace/AdminView.svelte'
  import CommandPalette from '$lib/components/CommandPalette.svelte'
  import ClickHouseTtlDialog from '$lib/components/ClickHouseTtlDialog.svelte'
  import ImportDialog from '$lib/components/ImportDialog.svelte'
  import ExportDialog from '$lib/components/ExportDialog.svelte'
  import GenerateScriptsDialog from '$lib/components/GenerateScriptsDialog.svelte'
  import BackupDialog from '$lib/components/BackupDialog.svelte'
  import CopyTableDialog from '$lib/components/CopyTableDialog.svelte'
  import CollationDialog from '$lib/components/CollationDialog.svelte'
  import GenerateTestDataDialog from '$lib/components/GenerateTestDataDialog.svelte'
  import ExecuteRoutineDialog from '$lib/components/ExecuteRoutineDialog.svelte'
  import ClickHouseCreateDialog from '$lib/components/ClickHouseCreateDialog.svelte'
  import NewDatabaseDialog from '$lib/components/NewDatabaseDialog.svelte'
  import Settings from '$lib/components/Settings.svelte'
  import { palette } from '$lib/stores/palette.svelte'
  import { settings } from '$lib/stores/settings.svelte'
  import HistoryTab from '$lib/components/workspace/HistoryTab.svelte'
  import SavedQueriesTab from '$lib/components/workspace/SavedQueriesTab.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import { findShortcut } from '$lib/keys/shortcuts'

  let ready = $state(false)

  onMount(() => {
    void (async () => {
      await ui.loadPersisted()
      await settings.load()
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

    // T21 — bind các shortcut còn thiếu (map thuần ở $lib/keys/shortcuts).
    const sc = findShortcut(e)
    if (sc) {
      e.preventDefault()
      switch (sc.id) {
        case 'format':
          ui.requestFormat()
          break
        case 'copy-json':
          ui.requestCopyJson()
          break
        case 'result-grid':
          ui.requestResultView('grid')
          break
        case 'result-json':
          ui.requestResultView('json')
          break
        case 'result-single':
          ui.requestResultView('single')
          break
        case 'find-in-explorer':
          ui.requestExplorerFind()
          break
      }
      return
    }

    const key = e.key.toLowerCase()

    if (key === 'p' && !e.shiftKey) {
      e.preventDefault()
      palette.toggle()
    } else if (e.key === ',') {
      e.preventDefault()
      settings.show()
    } else if (key === 'h') {
      e.preventDefault()
      tabs.openUtilityTab('history', 'Query History')
    } else if ((key === 't' || key === 'n') && !e.shiftKey) {
      // Ctrl/Cmd+T or Ctrl/Cmd+N → new Query Editor tab
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
    // relative to viewport: dưới title bar 42px (HTML dòng 46) + header/toolbar khu Connections
    ui.connListHeight = Math.min(Math.max(e.clientY - 42 - 66, 120), window.innerHeight - 260)
    ui.persistSizes()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- layout — port từ Database Studio.dc.html dòng 43, 68-71, 170-173 -->
<div style="height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-size:var(--px-13);overflow:hidden">
  <TitleBar />

  <!-- BODY — dòng 68 -->
  <div style="flex:1;display:flex;min-height:0">
    <!-- LEFT SIDEBAR — dòng 71 -->
    <aside
      style="width:{ui.sidebarWidth}px;flex:none;display:flex;flex-direction:column;background:var(--surface);border-right:var(--px-1) solid var(--border);min-height:0"
    >
      <ConnectionList />
      <!-- resizer chiều cao connection list (persist) -->
      <div
        style="flex:none;height:var(--px-5);cursor:row-resize;background:var(--border)"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize"
        onpointerdown={(e) => {
          draggingConnList = true
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onpointermove={dragConnList}
        onpointerup={() => (draggingConnList = false)}
      ></div>
      <div style="min-height:0;flex:1;overflow:hidden;display:flex;flex-direction:column">
        <ObjectExplorer />
      </div>
    </aside>

    <!-- sidebar width resizer — dòng 170 -->
    <div
      style="flex:none;width:var(--px-5);cursor:col-resize;background:var(--border);align-self:stretch"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize width"
      onpointerdown={(e) => {
        draggingSidebar = true
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onpointermove={dragSidebar}
      onpointerup={() => (draggingSidebar = false)}
    ></div>

    <!-- MAIN — dòng 173 -->
    <main style="flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg);overflow:hidden">
      {#snippet paneBody(t: import('$lib/types').TabState)}
        {#key t.id}
          <svelte:boundary>
          {#if t.contentType === 'table-viewer'}
            <TableViewerTab tab={t} />
          {:else if t.contentType === 'history'}
            <HistoryTab />
          {:else if t.contentType === 'saved'}
            <SavedQueriesTab />
          {:else if t.contentType === 'redis'}
            <RedisWorkspace tab={t} />
          {:else if t.contentType === 'redis-pubsub'}
            <RedisPubSub tab={t} />
          {:else if t.contentType === 'nats'}
            <NatsWorkspace tab={t} />
          {:else if t.contentType === 'nats-subject'}
            <NatsSubjectMessages tab={t} />
          {:else if t.contentType === 'kafka'}
            <KafkaWorkspace tab={t} />
          {:else if t.contentType === 'kafka-consumer'}
            <KafkaConsumer tab={t} />
          {:else if t.contentType === 'kafka-producer'}
            <KafkaProducer tab={t} />
          {:else if t.contentType === 'kafka-schema-registry'}
            <SchemaRegistryWorkspace tab={t} />
          {:else if t.contentType === 'cassandra-ring'}
            <CassandraRing tab={t} />
          {:else if t.contentType === 'table-designer'}
            <TableDesigner tab={t} />
          {:else if t.contentType === 'query-plan'}
            <PlanVisualizer tab={t} />
          {:else if t.contentType === 'er-diagram'}
            <ErDiagram tab={t} />
          {:else if t.contentType === 'schema-compare'}
            <SchemaCompare tab={t} />
          {:else if t.contentType === 'index-scanner'}
            <IndexScanner tab={t} />
          {:else if t.contentType === 'index-manager'}
            <IndexManager tab={t} />
          {:else if t.contentType === 'admin'}
            <AdminView tab={t} />
          {:else}
            <SqlWorkspace tab={t} />
          {/if}
          {#snippet failed(error, reset)}
            <!-- Phase 6: error boundary — crash 1 tab không sập cả app -->
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--px-12);padding:var(--px-30);color:var(--muted)">
              <span style="font-size:var(--px-28);color:var(--error)">⚠</span>
              <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">Tab error</div>
              <div class="mono" style="font-size:var(--px-11_5);max-width:var(--px-460);text-align:center;color:var(--text2);white-space:pre-wrap">{String(error)}</div>
              <span onclick={reset} onkeydown={(e) => e.key === 'Enter' && reset()} role="button" tabindex="0" style="font-size:var(--px-12);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-16);cursor:pointer;font-weight:600">Retry</span>
            </div>
          {/snippet}
          </svelte:boundary>
        {/key}
      {/snippet}

      {#snippet emptyPane()}
        {#if connections.profiles.length === 0}
          <!-- Welcome / onboarding (Phase 6 · T7) — chưa có connection nào -->
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--px-14);padding:var(--px-30)">
            <div style="font-size:var(--px-30)">🗄️</div>
            <div style="font-size:var(--px-18);font-weight:700;color:var(--text)">Welcome to Database Studio</div>
            <div style="font-size:var(--px-13);color:var(--muted);text-align:center;max-width:var(--px-460);line-height:1.5">Connect to PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, ClickHouse, Cassandra, Redis, Kafka or NATS to get started.</div>
            <div onclick={() => (ui.pickerOpen = true)} onkeydown={(e) => e.key === 'Enter' && (ui.pickerOpen = true)} role="button" tabindex="0" style="font-size:var(--px-13);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-9) var(--px-20);cursor:pointer;font-weight:600">+ Add first connection</div>
            <div style="font-size:var(--px-11_5);color:var(--muted)">Tip: press <span class="mono" style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-4);padding:var(--px-1) var(--px-6)">Ctrl+P</span> to open the Command Palette</div>
          </div>
        {:else}
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--px-8);font-size:var(--px-13);color:var(--muted)">
            <p>No tabs open</p>
            <div
              onclick={() => tabs.openSqlTab({})}
              onkeydown={(e) => e.key === 'Enter' && tabs.openSqlTab({})}
              role="button"
              tabindex="0"
              style="color:var(--primary);cursor:pointer"
            >+ New SQL tab (Ctrl+T)</div>
          </div>
        {/if}
      {/snippet}

      {#if !ready}
        <div style="flex:1;display:flex;align-items:center;justify-content:center;font-size:var(--px-12);color:var(--muted)">Starting…</div>
      {:else if tabs.splitDir}
        <!-- split view (T11): 2 pane — v = trái|phải, h = trên/dưới -->
        <div style="flex:1;display:flex;flex-direction:{tabs.splitDir === 'v' ? 'row' : 'column'};min-height:0;min-width:0">
          <div style="flex:1;display:flex;flex-direction:column;min-width:0;min-height:0">
            <TabBar pane={0} />
            <div style="flex:1;display:flex;flex-direction:column;min-height:0">
              {#if tabs.activeInPane(0)}{@render paneBody(tabs.activeInPane(0)!)}{:else}{@render emptyPane()}{/if}
            </div>
          </div>
          <div style="flex:none;{tabs.splitDir === 'v' ? 'width:var(--px-1)' : 'height:var(--px-1)'};background:var(--border2)"></div>
          <div style="flex:1;display:flex;flex-direction:column;min-width:0;min-height:0">
            <TabBar pane={1} />
            <div style="flex:1;display:flex;flex-direction:column;min-height:0">
              {#if tabs.activeInPane(1)}{@render paneBody(tabs.activeInPane(1)!)}{:else}{@render emptyPane()}{/if}
            </div>
          </div>
        </div>
      {:else}
        <TabBar />
        <div style="flex:1;display:flex;flex-direction:column;min-height:0">
          {#if tabs.active}{@render paneBody(tabs.active)}{:else}{@render emptyPane()}{/if}
        </div>
      {/if}
      <!-- STATUS BAR nằm trong cột main — dòng 1501 -->
      <StatusBar />
    </main>

    <!-- RIGHT: Object Properties — dòng 1510-1554 -->
    <PropertiesPanel />
  </div>
</div>

<!-- global dialogs + toasts -->
<SystemPicker />
<ConnectionForm />
<DeleteConnectionDialog />
<EditConnectedDialog />
<SaveBeforeCloseDialog />
<CommandPalette />
<ClickHouseTtlDialog />
<ImportDialog />
<ExportDialog />
<GenerateScriptsDialog />
<BackupDialog />
<CopyTableDialog />
<CollationDialog />
<GenerateTestDataDialog />
<ExecuteRoutineDialog />
<ClickHouseCreateDialog />
<NewDatabaseDialog />
<Settings />
<Toasts />
