<script lang="ts">
  // Sidebar "Connections" — port 1:1 từ Database Studio.dc.html dòng 73-130:
  // header CONNECTIONS + toolbar (New/Edit/Sync | NewQuery/ER/DDL/Compare/Filter,
  // gating theo selConn/selRel dòng 4783-4797) + filter box + cây My Databases
  // (category label + group per hệ + connection row, dòng 98-125).
  // Context menu dùng bits-ui (chức năng như connMenu của prototype).
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
  const REL_SYSTEMS = ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse', 'sqlite']
  const isRelational = (system: string) => REL_SYSTEMS.includes(system)
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
      // MongoDB: collections live in the ObjectExplorer sidebar; open a query
      // editor (mongosh-style: db.coll.find({...})) like the Cassandra CQL editor.
      else if (p.system === 'mongodb') tabs.openSqlTab({ connectionId: p.id, title: 'Untitled Mongo' })
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
        onclick={() => select(p)}
        ondblclick={() => openOrToggle(p)}
        onkeydown={(e) => e.key === 'Enter' && openOrToggle(p)}
        role="button"
        tabindex="0"
        style="display:flex;align-items:center;gap:var(--px-9);padding:var(--px-6) var(--px-6) var(--px-6) 0;border-radius:var(--px-7);cursor:pointer;position:relative;margin-bottom:var(--px-1)"
      >
        <ConnectionIndicator system={p.system} />
        {#if connections.connecting.has(p.id)}
          <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;flex:none;background:var(--warn)" title="Connecting…"></span>
        {:else if connections.connectErrors[p.id] && !p.connected}
          <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;flex:none;background:var(--error)" title="Connect failed: {connections.connectErrors[p.id]}"></span>
        {:else}
          <span style="width:var(--px-7);height:var(--px-7);border-radius:50%;flex:none;background:{p.connected ? systemMeta(p.system).accent : 'var(--sys-orphan-accent)'}" title={p.connected ? `Connected · ${p.latency_ms ?? '–'} ms` : 'Disconnected'}></span>
        {/if}
        <div style="flex:1;min-width:0">
          <div class="conn-name mono" style="font-weight:600;font-size:var(--px-12_5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{p.name}</div>
          <div class="mono" style="font-size:var(--px-10);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{p.system === 'sqlite' ? p.sqlite_path || ':memory:' : `${p.host}:${p.port}`}</div>
        </div>
        {#if p.ephemeral}
          <span style="flex:none;margin-right:var(--px-6);font-size:var(--px-8_5);font-weight:700;letter-spacing:.04em;padding:var(--px-1) var(--px-5);border-radius:var(--px-4);background:var(--panel);color:var(--muted);border:var(--px-1) solid var(--border)" title="One-off · not saved">1×</span>
        {/if}
        <span style="flex:none;margin-right:var(--px-7);font-size:var(--px-8_5);font-weight:700;letter-spacing:.04em;padding:var(--px-1) var(--px-5);border-radius:var(--px-4);background:{envMeta(p.env).bg};color:{envMeta(p.env).fg}">{envMeta(p.env).label}</span>
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Content class="w-56">
      <ContextMenu.Item onclick={() => newQueryConsole(p)}>New Query Console</ContextMenu.Item>
      {#if isRelational(p.system) && p.system !== 'sqlite'}
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
      <ContextMenu.Separator />
      {#if p.ephemeral}
        <ContextMenu.Item class="text-error data-highlighted:text-error" onclick={() => connections.remove(p.id)}>
          Close (one-off)
        </ContextMenu.Item>
      {:else}
        <ContextMenu.Item onclick={() => connections.load()}>Refresh</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item class="text-error data-highlighted:text-error" onclick={() => (ui.deleteTarget = p)}>
          Delete Connection
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>
{/snippet}

<div style="flex:none;border-bottom:var(--px-1) solid var(--border)">
  <!-- header — dòng 74-76 -->
  <div style="padding:var(--px-9) var(--px-12) var(--px-5)">
    <span style="font-size:var(--px-10_5);font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)">Connections</span>
  </div>

  <!-- toolbar — dòng 77-87 -->
  <div style="display:flex;align-items:center;gap:var(--px-1);padding:0 var(--px-8) var(--px-7);color:var(--text2)">
    <span class="tbtn" onclick={() => (ui.pickerOpen = true)} onkeydown={(e) => e.key === 'Enter' && (ui.pickerOpen = true)} role="button" tabindex="0" title="New connection" style="cursor:pointer">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
    </span>
    <span class="tbtn" onclick={() => selConn && (ui.formProfile = { ...selConn })} onkeydown={(e) => e.key === 'Enter' && selConn && (ui.formProfile = { ...selConn })} role="button" tabindex="0" title="Properties / Edit connection" style="cursor:{selConn ? 'pointer' : 'not-allowed'};opacity:{selConn ? 1 : 0.35}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M5 19l2-2"></path></svg>
    </span>
    <span class="tbtn" onclick={() => selConn && connections.load()} onkeydown={(e) => e.key === 'Enter' && selConn && connections.load()} role="button" tabindex="0" title="Synchronize" style="cursor:{selConn ? 'pointer' : 'not-allowed'};opacity:{selConn ? 1 : 0.35}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 6.1"></path><path d="M20 4v5h-5"></path></svg>
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
    <span class="tbtn" onclick={toggleFilter} onkeydown={(e) => e.key === 'Enter' && toggleFilter()} role="button" tabindex="0" title="Filter connections" style="cursor:pointer;background:{filterOpen ? 'var(--hover)' : 'transparent'}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h18l-7 8v6l-4 2v-8z"></path></svg>
    </span>
  </div>

  <!-- filter box — dòng 88-96 -->
  {#if filterOpen}
    <div style="padding:0 var(--px-10) var(--px-7)">
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

  <!-- cây connections — dòng 97-130 -->
  <div style="padding:0 var(--px-6) var(--px-8);height:{ui.connListHeight}px;overflow:auto">
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <div class="hoverable" onclick={() => (myDbOpen = !myDbOpen)} onkeydown={(e) => e.key === 'Enter' && (myDbOpen = !myDbOpen)} role="button" tabindex="0" style="display:flex;align-items:center;gap:var(--px-7);padding:var(--px-5) var(--px-6);border-radius:var(--px-6);cursor:pointer">
          <span class="mono" style="width:var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">{myDbOpen ? '▾' : '▸'}</span>
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
              <span class="mono" style="width:var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">{collapsed.has(`folder:${folder.name}`) ? '▸' : '▾'}</span>
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
              <span class="mono" style="width:var(--px-12);text-align:center;font-size:var(--px-12);color:var(--muted)">{collapsed.has(group.system) ? '▸' : '▾'}</span>
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
