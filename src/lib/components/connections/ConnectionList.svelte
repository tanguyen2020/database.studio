<script lang="ts">
  // Sidebar "Connections" — port 1:1 từ Database Studio.dc.html dòng 73-130:
  // header CONNECTIONS + toolbar (New/Edit/Sync | NewQuery/ER/DDL/Compare/Filter,
  // gating theo selConn/selRel dòng 4783-4797) + filter box + cây My Databases
  // (category label + group per hệ + connection row, dòng 98-125).
  // Context menu dùng bits-ui (chức năng như connMenu của prototype).
  import { untrack } from 'svelte'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import ConnectionIndicator from '$lib/components/ConnectionIndicator.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  import { CATEGORY_ORDER, SYSTEM_ORDER, envMeta, systemMeta } from '$lib/systems'
  import { groupByFolder } from '$lib/connections/grouping'
  import { newDatabaseWizard } from '$lib/stores/newdatabase.svelte'
  import { scriptsWizard } from '$lib/stores/scripts.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'
  import type { ProfilePublic } from '$lib/types'

  // Environment badge colors are theme-aware CSS vars (--env-*-bg/fg in app.css):
  // the generated ENV_GEN hex is dark-only, so map the env key → the var suffix and
  // let light/dark mode pick the readable pair. envMeta() still supplies the label.
  const ENV_VAR: Record<string, string> = { production: 'prod', staging: 'stg', development: 'dev', local: 'local' }
  const envKey = (env: string | null | undefined) => ENV_VAR[env ?? 'development'] ?? 'dev'

  // filter theo name/host/database (placeholder dòng 92)
  const filtered = $derived(
    connections.profiles.filter((p) => {
      const q = connections.filter.toLowerCase()
      return (
        p.name.toLowerCase().includes(q) ||
        p.host.toLowerCase().includes(q) ||
        p.database.toLowerCase().includes(q)
      )
    }),
  )

  interface Group {
    category: string
    showCategory: boolean
    system: string
    items: ProfilePublic[]
  }

  const groups = $derived.by(() => {
    const out: Group[] = []
    let lastCategory = ''
    for (const category of CATEGORY_ORDER) {
      for (const system of SYSTEM_ORDER) {
        const meta = systemMeta(system)
        if (meta.category !== category) continue
        const items = filtered.filter((p) => p.system === system)
        if (items.length === 0) continue
        out.push({ category, showCategory: category !== lastCategory, system, items })
        lastCategory = category
      }
    }
    return out
  })

  let myDbOpen = $state(true)
  let filterOpen = $state(false)
  let filterInput = $state<HTMLInputElement | null>(null)
  let collapsed = $state<Set<string>>(new Set())

  const selConn = $derived(connections.byId(connections.selectedId ?? ''))
  // selRel: dòng 4643 chỉ liệt kê pg/mysql/mssql/clickhouse — mâu thuẫn với tab
  // dispatch dòng 2731 (có mariadb/sqlite) và README; theo dispatch + README.
  const REL_SYSTEMS = ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse', 'sqlite', 'oracle']
  const isRelational = (system: string) => REL_SYSTEMS.includes(system)
  // Engines with a user/privilege system (User Manager entry — §1.1).
  const USER_MGR_SYSTEMS = ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse', 'oracle', 'cassandra', 'mongodb']
  const hasUserMgr = (system: string) => USER_MGR_SYSTEMS.includes(system)
  const selRel = $derived(!!selConn && isRelational(selConn.system))
  // View ER / Generate Scripts enable only when a schema/database node (public / dbo /
  // a database) is selected in the Explorer tree AND it belongs to the picked connection.
  const schemaSel = $derived(
    explorer.selectedSchema && selConn && explorer.selectedSchema.base === selConn.id
      ? explorer.selectedSchema
      : null,
  )

  function toggleGroup(system: string) {
    const next = new Set(collapsed)
    if (next.has(system)) next.delete(system)
    else next.add(system)
    collapsed = next
  }

  function select(p: ProfilePublic) {
    connections.selectedId = p.id
  }

  async function openOrToggle(p: ProfilePublic) {
    connections.selectedId = p.id
    if (!p.connected) await connections.connect(p.id)
    // Redis/NATS: mở workspace chuyên biệt (không phải SQL editor)
    if (connections.byId(p.id)?.connected) {
      // Redis: key browser lives in the ObjectExplorer sidebar — do NOT open a tab.
      if (p.system === 'redis') { /* explorer shows keys; open a tab per key on click */ }
      else if (p.system === 'nats') tabs.openNatsTab(p.id)
      // Kafka: topics live in the ObjectExplorer sidebar — do NOT open a cluster tab
      // (click a topic to open its consumer).
      else if (p.system === 'kafka') { /* explorer shows topics; consumer opens per topic */ }
      // Cassandra: CQL editor (tái dùng SQL editor + result grid, title Untitled CQL)
      else if (p.system === 'cassandra') tabs.openSqlTab({ connectionId: p.id, title: 'Untitled CQL' })
      // MongoDB: collections live in the ObjectExplorer sidebar — do NOT open a tab
      // on connect (double-click a collection to open its documents; a mongosh query
      // console is still available via the context menu / New Query).
      else if (p.system === 'mongodb') { /* explorer shows collections; open per collection */ }
    }
  }

  function newQueryConsole(p?: ProfilePublic | null) {
    const target = p ?? selConn
    if (!target) return
    connections.selectedId = target.id
    // Bind to the database selected in the ObjectExplorer when it belongs to this
    // connection (so the Query Editor's Database dropdown pre-selects it). An
    // explicit context-menu pick (p) ignores the tree selection.
    tabs.openQueryConsole({ connectionId: target.id, useSelection: !p })
  }

  // New Database (DataGrip-style): open a dialog to enter the name; Create runs
  // CREATE DATABASE on this connection.
  function newDatabase(p: ProfilePublic) {
    newDatabaseWizard.show(p.id, p.system)
  }

  async function testConn(p: ProfilePublic) {
    toasts.show(`Testing "${p.name}"…`, { system: p.system })
    const res = await connections.test({ profile: p, password: null, ssh_password: null })
    if (res.ok) {
      toasts.success(
        `${p.name}: connected · ${res.latency_ms} ms${res.server_version ? ` · ${res.server_version}` : ''}`,
        p.system,
      )
    } else {
      toasts.error(`${p.name}: ${res.error}`, p.system)
    }
  }

  function connString(p: ProfilePublic): string {
    // KHÔNG nhúng password vào connection string
    switch (p.system) {
      case 'postgres':
        return `postgresql://${p.user}@${p.host}:${p.port}/${p.database}`
      case 'mysql':
      case 'mariadb':
        return `mysql://${p.user}@${p.host}:${p.port}/${p.database}`
      case 'mssql':
        return `Server=${p.host},${p.port};Database=${p.database};User Id=${p.user};`
      case 'sqlite':
        return p.sqlite_mode === 'in-memory' ? 'sqlite::memory:' : `sqlite://${p.sqlite_path}`
      default:
        return `${p.system}://${p.host}:${p.port}`
    }
  }

  async function copyConnString(p: ProfilePublic) {
    await navigator.clipboard.writeText(connString(p))
    toasts.success('Copied connection string (without password)', p.system)
  }

  function toggleFilter() {
    filterOpen = !filterOpen
    if (!filterOpen) connections.filter = ''
    else setTimeout(() => filterInput?.focus(), 0)
  }

  // ---- Section 8: grouping mode + import/export + quick connect ----
  const folders = $derived(groupByFolder(filtered, SYSTEM_ORDER))

  let fileInput = $state<HTMLInputElement | null>(null)

  // ---- toolbar Refresh -------------------------------------------------------
  // "Refresh" means: really reopen the connection. A long-lived session can be
  // holding an old catalog snapshot (and its cached tree), so re-reading the
  // saved profiles is not enough — disconnect, connect again, drop the cached
  // introspection, then ask the Explorer to re-read the tree from the server.
  let resyncing = $state(false)
  /** id being refreshed — the row shows it, so a context-menu Refresh is visible too */
  let refreshingId = $state<string | null>(null)

  async function refreshConnection(target?: ProfilePublic) {
    const c = target ?? selConn
    if (!c || resyncing) return
    resyncing = true
    refreshingId = c.id
    try {
      // Read the state BEFORE re-listing: reopening is about the session the user
      // has open right now, and load() replaces the profile objects.
      const wasConnected = !!c.connected
      // a peer (or another window) may have edited the saved profiles
      await connections.load()
      if (!wasConnected || !connections.byId(c.id)) {
        // nothing to reopen — the list itself is now up to date
        return
      }
      const ok = await connections.reconnect(c.id) // backend: disconnect + connect
      explorer.invalidate(c.id) // cached schemas/tables belong to the old session
      if (ok) {
        explorer.bumpReload(c.id) // Explorer re-reads the tree over the new connection
        toasts.show(`${c.name}: reconnected`, { system: c.system })
      }
    } finally {
      resyncing = false
      refreshingId = null
    }
  }

  function exportConnections() {
    if (connections.profiles.filter((p) => !p.ephemeral).length === 0) {
      toasts.show('No connections to export')
      return
    }
    const blob = new Blob([connections.exportPayload()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'database-studio-connections.json'
    a.click()
    URL.revokeObjectURL(url)
    toasts.success('Exported connections (without passwords)')
  }

  async function onImportFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      const list = Array.isArray(parsed) ? parsed : parsed?.profiles
      if (!Array.isArray(list)) throw new Error('Invalid JSON structure')
      const n = await connections.importProfiles(list)
      toasts.success(`Imported ${n} connection(s)`)
    } catch (err) {
      toasts.error(`Import failed: ${err}`)
    }
  }

  function quickConnect() {
    ui.pickerQuick = true
    ui.pickerOpen = true
  }

  // ---- keyboard: navigate + act on the Connections list ---------------------
  // Ctrl/Cmd+Shift+B focuses the list, then ↑/↓ move, Home/End jump, Enter opens
  // (connects), F2 edits, Delete removes, ←/→ collapse/expand the group. The
  // handler sits on the LIST container so it works whether focus is on the
  // container itself or on a row (keydown bubbles), and selection never depends
  // on a row element still being mounted.
  let listEl = $state<HTMLDivElement | null>(null)

  const visibleProfiles = $derived.by(() => {
    const out: ProfilePublic[] = []
    if (!myDbOpen) return out
    if (ui.connGroupMode === 'folder') {
      for (const f of folders) if (!collapsed.has(`folder:${f.name}`)) out.push(...f.items)
    } else {
      for (const g of groups) if (!collapsed.has(g.system)) out.push(...g.items)
    }
    return out
  })

  function groupKeyOf(p: ProfilePublic): string {
    if (ui.connGroupMode === 'folder') {
      const f = folders.find((x) => x.items.some((i) => i.id === p.id))
      return f ? `folder:${f.name}` : ''
    }
    return p.system
  }

  function revealSelected() {
    const id = connections.selectedId
    if (!id || !listEl) return
    const row = listEl.querySelector<HTMLElement>(`[data-conn-id="${CSS.escape(id)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }

  function moveSelection(delta: number) {
    const list = visibleProfiles
    if (list.length === 0) return
    const cur = list.findIndex((p) => p.id === connections.selectedId)
    const next = cur < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, cur + delta))
    connections.selectedId = list[next].id
    revealSelected()
  }

  function selectEdge(last: boolean) {
    const list = visibleProfiles
    if (list.length === 0) return
    connections.selectedId = list[last ? list.length - 1 : 0].id
    revealSelected()
  }

  function setGroupCollapsed(key: string, isCollapsed: boolean) {
    if (!key) return
    const next = new Set(collapsed)
    if (isCollapsed) next.add(key)
    else next.delete(key)
    collapsed = next
  }

  function onListKeydown(e: KeyboardEvent) {
    // A row's own Enter handler runs first and marks the event handled.
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
    const p = selConn
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        moveSelection(1)
        break
      case 'ArrowUp':
        e.preventDefault()
        moveSelection(-1)
        break
      case 'Home':
        e.preventDefault()
        selectEdge(false)
        break
      case 'End':
        e.preventDefault()
        selectEdge(true)
        break
      case 'Enter':
        if (!p) return
        e.preventDefault()
        void openOrToggle(p)
        break
      case 'F2':
        if (!p || p.ephemeral) return
        e.preventDefault()
        ui.formProfile = { ...p }
        break
      case 'Delete':
        if (!p) return
        e.preventDefault()
        if (p.ephemeral) void connections.remove(p.id)
        else ui.deleteTarget = p
        break
      case 'ArrowLeft':
        if (!p) return
        e.preventDefault()
        setGroupCollapsed(groupKeyOf(p), true)
        break
      case 'ArrowRight':
        if (!p) return
        e.preventDefault()
        setGroupCollapsed(groupKeyOf(p), false)
        break
    }
  }

  function focusList() {
    myDbOpen = true
    if (!connections.selectedId && visibleProfiles.length) connections.selectedId = visibleProfiles[0].id
    listEl?.focus()
    revealSelected()
  }

  // Shortcut signals from App.svelte (Ctrl/Cmd+Shift+E / +K / +O).
  $effect(() => {
    if (!ui.connFocusTick) return
    untrack(() => focusList())
  })
  $effect(() => {
    if (!ui.connFilterTick) return
    untrack(() => {
      filterOpen = true
      setTimeout(() => filterInput?.focus(), 0)
    })
  })
  $effect(() => {
    if (!ui.connToggleTick) return
    untrack(() => {
      const p = selConn
      if (!p) {
        toasts.show('Pick a connection first')
        return
      }
      if (p.connected) void connections.disconnect(p.id)
      else void openOrToggle(p)
    })
  })
</script>

<!-- hidden picker cho Import Connections (JSON) -->
<input
  bind:this={fileInput}
  type="file"
  accept="application/json,.json"
  onchange={onImportFile}
  style="display:none"
/>

<!-- connection row — dùng chung cho cả 2 chế độ nhóm (theo hệ / theo folder) -->
{#snippet connRow(p: ProfilePublic)}
  <ContextMenu.Root>
    <ContextMenu.Trigger>
      <!-- connection row — dòng 116-124. Hover/selected qua class (tránh bẫy
           inline-background nuốt :hover). -->
      <div
        class="conn-row"
        class:selected={connections.selectedId === p.id}
        data-conn-id={p.id}
        onclick={() => select(p)}
        ondblclick={() => openOrToggle(p)}
        onkeydown={(e) => {
          // Mark handled so the list-level handler doesn't open it twice.
          if (e.key === 'Enter') {
            e.preventDefault()
            void openOrToggle(p)
          }
        }}
        role="button"
        tabindex="0"
        style="display:flex;align-items:center;gap:var(--px-9);padding:var(--px-6) var(--px-6) var(--px-6) 0;border-radius:var(--px-7);cursor:pointer;position:relative;margin-bottom:var(--px-1)"
      >
        <ConnectionIndicator system={p.system} />
        {#if refreshingId === p.id}
          <span class="conn-refresh-glyph spinning" style="display:inline-flex;flex:none;color:var(--primary);font-size:var(--px-11)" title="Refreshing — reconnecting and reloading the tree">⟳</span>
        {:else if connections.connecting.has(p.id)}
          <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;flex:none;background:var(--warn)" title="Connecting…"></span>
        {:else if connections.connectErrors[p.id] && !p.connected}
          <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;flex:none;background:var(--error)" title="Not connected — {connections.connectErrors[p.id]}"></span>
        {:else}
          <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;flex:none;background:{p.connected ? systemMeta(p.system).accent : 'var(--sys-orphan-accent)'}" title={p.connected ? `Connected · ${p.latency_ms ?? '–'} ms` : 'Disconnected'}></span>
        {/if}
        <div style="flex:1;min-width:0" aria-busy={refreshingId === p.id}>
          <div class="conn-name mono" style="font-weight:600;font-size:var(--px-12_5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{p.name}</div>
          <div class="mono" style="font-size:var(--px-10);color:{refreshingId === p.id ? 'var(--primary)' : 'var(--muted)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{refreshingId === p.id ? 'Refreshing…' : p.system === 'sqlite' ? p.sqlite_path || ':memory:' : `${p.host}:${p.port}`}</div>
        </div>
        {#if p.ephemeral}
          <span style="flex:none;margin-right:var(--px-6);font-size:var(--px-8_5);font-weight:700;letter-spacing:.04em;padding:var(--px-1) var(--px-5);border-radius:var(--px-4);background:var(--panel);color:var(--muted);border:var(--px-1) solid var(--border)" title="One-off · not saved">1×</span>
        {/if}
        <span style="flex:none;margin-right:var(--px-7);font-size:var(--px-8_5);font-weight:700;letter-spacing:.04em;padding:var(--px-1) var(--px-5);border-radius:var(--px-4);background:var(--env-{envKey(p.env)}-bg);color:var(--env-{envKey(p.env)}-fg)">{envMeta(p.env).label}</span>
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Content class="w-56">
      <ContextMenu.Item onclick={() => newQueryConsole(p)}>New Query Console</ContextMenu.Item>
      {#if (isRelational(p.system) && p.system !== 'sqlite') || p.system === 'mongodb'}
        <ContextMenu.Item onclick={() => newDatabase(p)}>New Database…</ContextMenu.Item>
      {/if}
      {#if p.connected}
        <ContextMenu.Item onclick={() => connections.disconnect(p.id)}>Disconnect</ContextMenu.Item>
      {:else}
        <ContextMenu.Item onclick={() => openOrToggle(p)}>Open Connection</ContextMenu.Item>
      {/if}
      <ContextMenu.Separator />
      {#if !p.ephemeral}
        <ContextMenu.Item onclick={() => (ui.formProfile = { ...p })}>Edit Connection…</ContextMenu.Item>
        <ContextMenu.Item onclick={() => connections.duplicate(p.id)}>Duplicate</ContextMenu.Item>
      {/if}
      <ContextMenu.Item onclick={() => testConn(p)}>Test Connection</ContextMenu.Item>
      <ContextMenu.Item onclick={() => copyConnString(p)}>Copy Connection String</ContextMenu.Item>
      {#if isRelational(p.system)}
        <ContextMenu.Separator />
        <ContextMenu.Item onclick={() => tabs.openSchemaCompare(p.id)}>Compare Schemas…</ContextMenu.Item>
      {/if}
      {#if hasUserMgr(p.system)}
        <ContextMenu.Item onclick={() => tabs.openUserManager(p.id)}>Users &amp; Privileges…</ContextMenu.Item>
      {/if}
      <ContextMenu.Separator />
      {#if p.ephemeral}
        <ContextMenu.Item class="text-error data-highlighted:text-error" onclick={() => connections.remove(p.id)}>
          Close (one-off)
        </ContextMenu.Item>
      {:else}
        <ContextMenu.Item onclick={() => refreshConnection(p)}>Refresh</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item class="text-error data-highlighted:text-error" onclick={() => (ui.deleteTarget = p)}>
          Delete Connection
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>
{/snippet}

<div
  style={ui.sidebarSplit
    ? 'flex:1;min-height:0;display:flex;flex-direction:column'
    : 'flex:none;border-bottom:var(--px-1) solid var(--border)'}
>
  <!-- header — dòng 74-76 -->
  <div
    style={ui.sidebarSplit
      ? 'flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-12) var(--px-5)'
      : 'padding:var(--px-9) var(--px-12) var(--px-5)'}
  >
    <span
      style="font-size:var(--px-10_5);font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)"
      title="Ctrl+Shift+B focus list · ↑/↓ move · Enter open · F2 edit · Delete remove · ←/→ collapse/expand&#10;Ctrl+Shift+N new · Ctrl+Shift+K filter · Ctrl+Shift+O connect/disconnect"
    >Connections</span>
  </div>

  <!-- toolbar — dòng 77-87 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-1);padding:0 var(--px-8) var(--px-7);color:var(--text2)">
    <span class="tbtn" onclick={() => (ui.pickerOpen = true)} onkeydown={(e) => e.key === 'Enter' && (ui.pickerOpen = true)} role="button" tabindex="0" title="New connection (Ctrl+Shift+N)" style="cursor:pointer">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
    </span>
    <span class="tbtn" onclick={() => selConn && (ui.formProfile = { ...selConn })} onkeydown={(e) => e.key === 'Enter' && selConn && (ui.formProfile = { ...selConn })} role="button" tabindex="0" title="Properties / Edit connection" style="cursor:{selConn ? 'pointer' : 'not-allowed'};opacity:{selConn ? 1 : 0.35}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M5 19l2-2"></path></svg>
    </span>
    <span
      class="tbtn"
      onclick={() => refreshConnection()}
      onkeydown={(e) => e.key === 'Enter' && refreshConnection()}
      role="button"
      tabindex="0"
      aria-label="Refresh connection"
      aria-busy={resyncing}
      title={selConn?.connected
        ? `Refresh ${selConn.name} — disconnect, connect again, then reload its tree`
        : 'Refresh — re-read the saved connections (select a connected one to reconnect it)'}
      style="cursor:{selConn && !resyncing ? 'pointer' : 'not-allowed'};opacity:{selConn ? (resyncing ? 0.5 : 1) : 0.35}"
    >
      <span class="conn-refresh-glyph" class:spinning={resyncing} style="display:inline-flex">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 6.1"></path><path d="M20 4v5h-5"></path></svg>
      </span>
    </span>
    <span style="width:var(--px-1);height:var(--px-16);background:var(--border);margin:0 var(--px-3)"></span>
    <span class="tbtn" onclick={() => selRel && newQueryConsole()} onkeydown={(e) => e.key === 'Enter' && selRel && newQueryConsole()} role="button" tabindex="0" title="New query console" style="cursor:{selRel ? 'pointer' : 'not-allowed'};opacity:{selRel ? 1 : 0.35}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="9" cy="5" rx="6.5" ry="2.3"></ellipse><path d="M2.5 5v9c0 1.3 2.9 2.3 6.5 2.3"></path><path d="M2.5 9.5c0 1.3 2.9 2.3 6.5 2.3"></path><line x1="18" y1="14" x2="18" y2="21"></line><line x1="14.5" y1="17.5" x2="21.5" y2="17.5"></line></svg>
    </span>
    <span class="tbtn" onclick={() => schemaSel && tabs.openErDiagram(schemaSel.connId, schemaSel.schema)} onkeydown={(e) => e.key === 'Enter' && schemaSel && tabs.openErDiagram(schemaSel.connId, schemaSel.schema)} role="button" tabindex="0" title={schemaSel ? `View ER diagram of ${schemaSel.schema}` : 'View ER diagram (select a database or schema first)'} style="cursor:{schemaSel ? 'pointer' : 'not-allowed'};opacity:{schemaSel ? 1 : 0.35}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="3.5" width="7.5" height="6.5" rx="1"></rect><rect x="13.5" y="3.5" width="7.5" height="6.5" rx="1"></rect><rect x="8" y="14" width="8" height="6.5" rx="1"></rect><path d="M10.5 6.7h3M12 10v4" stroke-linecap="round"></path></svg>
    </span>
    <span class="tbtn" onclick={() => schemaSel && scriptsWizard.show(schemaSel.connId, schemaSel.schema)} onkeydown={(e) => e.key === 'Enter' && schemaSel && scriptsWizard.show(schemaSel.connId, schemaSel.schema)} role="button" tabindex="0" title={schemaSel ? `Generate scripts for ${schemaSel.schema}` : 'Generate scripts (select a database or schema first)'} style="width:auto;cursor:{schemaSel ? 'pointer' : 'not-allowed'};opacity:{schemaSel ? 1 : 0.35};font-size:var(--px-10);font-weight:700;letter-spacing:.03em;padding:0 var(--px-6)">DDL</span>
    <span class="tbtn" onclick={() => selRel && tabs.openSchemaCompare(selConn?.id ?? null)} onkeydown={(e) => e.key === 'Enter' && selRel && tabs.openSchemaCompare(selConn?.id ?? null)} role="button" tabindex="0" title="Compare schemas" style="cursor:{selRel ? 'pointer' : 'not-allowed'};opacity:{selRel ? 1 : 0.35}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h13l-3-3M5 8l3 3"></path><path d="M19 16H6l3 3M19 16l-3-3"></path></svg>
    </span>
    <span class="tbtn" onclick={toggleFilter} onkeydown={(e) => e.key === 'Enter' && toggleFilter()} role="button" tabindex="0" title="Filter connections (Ctrl+Shift+K)" style="cursor:pointer;background:{filterOpen ? 'var(--hover)' : 'transparent'}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h18l-7 8v6l-4 2v-8z"></path></svg>
    </span>
  </div>

  <!-- filter box — dòng 88-96 -->
  {#if filterOpen}
    <div style="flex:none;padding:0 var(--px-10) var(--px-7)">
      <div style="display:flex;align-items:center;gap:var(--px-6);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-5) var(--px-8)">
        <span style="color:var(--muted);font-size:var(--px-12)">⌕</span>
        <input
          bind:this={filterInput}
          bind:value={connections.filter}
          placeholder="Filter by name, host, database…"
          style="border:none;background:transparent;color:var(--text);font-size:var(--px-12);outline:none;width:100%;font-family:inherit"
        />
        <span onclick={() => (connections.filter = '')} onkeydown={(e) => e.key === 'Enter' && (connections.filter = '')} role="button" tabindex="0" style="cursor:pointer;color:var(--muted);font-size:var(--px-13)">×</span>
      </div>
    </div>
  {/if}

  <!-- cây connections — dòng 97-130. tabindex=-1 + role=tree: the list can take
       keyboard focus (Ctrl/Cmd+Shift+B) and owns the ↑/↓/Enter/F2/Delete keys. -->
  <div
    bind:this={listEl}
    tabindex="-1"
    role="tree"
    aria-label="Connections"
    onkeydown={onListKeydown}
    style="padding:0 var(--px-6) var(--px-8);{ui.sidebarSplit
      ? 'flex:1;min-height:0'
      : `height:${ui.connListHeight}px`};overflow:auto;outline:none"
  >
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <div class="hoverable" onclick={() => (myDbOpen = !myDbOpen)} onkeydown={(e) => e.key === 'Enter' && (myDbOpen = !myDbOpen)} role="button" tabindex="0" style="display:flex;align-items:center;gap:var(--px-7);padding:var(--px-5) var(--px-6);border-radius:var(--px-6);cursor:pointer">
          <span class="mono" style="width:var(--px-16);text-align:center;font-size:var(--px-16);color:var(--text2)">{myDbOpen ? '▾' : '▸'}</span>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
          <span style="font-size:var(--px-11_5);font-weight:700">My Databases</span>
          <span class="mono" style="margin-left:auto;font-size:var(--px-10);color:var(--muted)">{connections.profiles.length}</span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Content class="w-56">
        <ContextMenu.Item onclick={() => ui.setConnGroupMode('type')}>
          {ui.connGroupMode === 'type' ? '✓ ' : ''}Group by Type
        </ContextMenu.Item>
        <ContextMenu.Item onclick={() => ui.setConnGroupMode('folder')}>
          {ui.connGroupMode === 'folder' ? '✓ ' : ''}Group by Folder
        </ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item onclick={quickConnect}>Quick Connect…</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item onclick={() => fileInput?.click()}>Import Connections…</ContextMenu.Item>
        <ContextMenu.Item onclick={exportConnections}>Export Connections…</ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
    {#if myDbOpen}
      <div style="padding-left:var(--px-11)">
        {#if ui.connGroupMode === 'folder'}
          <!-- nhóm theo folder (group field) — Section 8 -->
          {#each folders as folder (folder.name)}
            <div class="hoverable" onclick={() => toggleGroup(`folder:${folder.name}`)} onkeydown={(e) => e.key === 'Enter' && toggleGroup(`folder:${folder.name}`)} role="button" tabindex="0" style="display:flex;align-items:center;gap:var(--px-7);padding:var(--px-8) var(--px-8) var(--px-4) var(--px-4);cursor:pointer">
              <span class="mono" style="width:var(--px-16);text-align:center;font-size:var(--px-16);color:var(--text2)">{collapsed.has(`folder:${folder.name}`) ? '▸' : '▾'}</span>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
              <span style="font-size:var(--px-10);font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)">{folder.name}</span>
              <span class="mono" style="margin-left:auto;font-size:var(--px-10);color:var(--muted)">{folder.items.length}</span>
            </div>
            {#if !collapsed.has(`folder:${folder.name}`)}
              {#each folder.items as p (p.id)}
                {@render connRow(p)}
              {/each}
            {/if}
          {/each}
        {:else}
          <!-- nhóm theo hệ (prototype-faithful) — mặc định -->
          {#each groups as group (group.system)}
            {#if group.showCategory}
              <div style="font-size:var(--px-9_5);font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:var(--px-9) var(--px-12) var(--px-2) var(--px-4)">{group.category}</div>
            {/if}
            <div class="hoverable" onclick={() => toggleGroup(group.system)} onkeydown={(e) => e.key === 'Enter' && toggleGroup(group.system)} role="button" tabindex="0" style="display:flex;align-items:center;gap:var(--px-7);padding:var(--px-8) var(--px-8) var(--px-4) var(--px-4);cursor:pointer">
              <span class="mono" style="width:var(--px-16);text-align:center;font-size:var(--px-16);color:var(--text2)">{collapsed.has(group.system) ? '▸' : '▾'}</span>
              <span style="display:flex;align-items:center;flex:none"><SystemIcon system={group.system} size={16} /></span>
              <span style="font-size:var(--px-10);font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)">{systemMeta(group.system).label}</span>
              <span class="mono" style="margin-left:auto;font-size:var(--px-10);color:var(--muted)">{group.items.length}</span>
            </div>
            {#if !collapsed.has(group.system)}
              {#each group.items as p (p.id)}
                {@render connRow(p)}
              {/each}
            {/if}
          {/each}
        {/if}

        {#if connections.loaded && groups.length === 0}
          <div style="padding:var(--px-12) var(--px-12);font-size:var(--px-12);color:var(--muted);text-align:center">
            {connections.filter ? 'No connections match the filter' : 'No connections yet.'}
            {#if !connections.filter}
              <div onclick={() => (ui.pickerOpen = true)} onkeydown={(e) => e.key === 'Enter' && (ui.pickerOpen = true)} role="button" tabindex="0" style="margin-top:var(--px-8);color:var(--primary);cursor:pointer">+ Add first connection</div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* nút toolbar 26×24 radius 5 (dòng 78) */
  .tbtn {
    width: var(--px-26);
    height: var(--px-24);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-5);
  }
  .conn-refresh-glyph.spinning {
    animation: conn-refresh-spin 900ms linear infinite;
  }
  @keyframes conn-refresh-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .tbtn:hover,
  .hoverable:hover {
    background: var(--hover);
  }
  /* connection row: hover + selected use a primary (blue) tint so they read
     clearly over the softened sidebar in BOTH themes (--hover alone was lighter
     than the light-mode sidebar → nearly invisible). Selected is a stronger tint
     + a left accent bar + a bolder name, so it's unmistakable vs. a mere hover. */
  .conn-row:hover {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
  }
  .conn-row.selected {
    background: color-mix(in srgb, var(--primary) 22%, transparent);
    box-shadow: inset var(--px-3) 0 0 var(--primary);
  }
  .conn-row.selected:hover {
    background: color-mix(in srgb, var(--primary) 30%, transparent);
  }
  .conn-row.selected .conn-name {
    color: var(--primary);
    font-weight: 700;
  }
</style>
