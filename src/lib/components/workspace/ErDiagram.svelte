<script lang="ts">
  // ER Diagram (Phase 5 · T8) — SvelteFlow + dagre. Fetch schema (tables+cols+FK),
  // custom table nodes, FK edges, auto-layout, zoom/pan/minimap, toggle columns,
  // export PNG/SVG/Mermaid. Toolbar port dòng 1257-1276.
  import '@xyflow/svelte/dist/style.css'
  import { untrack } from 'svelte'
  import { SvelteFlow, Background, Controls, MiniMap, MarkerType, type Node, type Edge } from '@xyflow/svelte'
  import Dagre from '@dagrejs/dagre'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { toMermaid, toSvg, tableSize, type ErTable } from '$lib/er/mermaid'
  import { addTable, flowPosition, visibleTables, relationshipFromConnection, type Viewport, type RelConnection } from '$lib/er/diagram'
  import ErTableNode from './er/ErTableNode.svelte'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { genForeignKey } from '$lib/sql/ddl'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const nodeTypes = { table: ErTableNode }
  const schema = $derived((tab.state as { schema?: string }).schema ?? '')

  let tables = $state<ErTable[]>([])
  let fks = $state<ipc.ForeignKey[]>([])
  let nodes = $state.raw<Node[]>([])
  let edges = $state.raw<Edge[]>([])
  let showAll = $state(true)
  let error = $state<string | null>(null)
  let positions = $state<Record<string, { x: number; y: number }>>({})

  // AUDIT-3 item 1 — drag & drop tables from the sidebar. `included` (in tab.state)
  // is undefined for the default "all tables" view, or an explicit subset for a
  // diagram the user builds by dragging. `viewport` is bound so drop points map
  // to canvas coordinates.
  const included = $derived((tab.state as { included?: string[] }).included)
  let viewport = $state<Viewport>({ x: 0, y: 0, zoom: 1 })
  let paneEl = $state<HTMLDivElement | null>(null)

  // T20 — create-relationship + Save-to-DB + in-tab Ctrl+F
  const system = $derived(connections.byId(tab.connectionId)?.system ?? 'postgres')
  let pendingFks = $state<ipc.ForeignKey[]>([])
  let relOpen = $state(false)
  let relFromTable = $state('')
  let relFromCol = $state('')
  let relToTable = $state('')
  let relToCol = $state('')
  let search = $state('')
  let searchEl = $state<HTMLInputElement | null>(null)
  const fromCols = $derived(tables.find((t) => t.name === relFromTable)?.columns.map((c) => c.name) ?? [])
  const toCols = $derived(tables.find((t) => t.name === relToTable)?.columns.map((c) => c.name) ?? [])

  const summary = $derived(`${tables.length} tables · ${fks.length + pendingFks.length} relationships`)

  function addRelationship() {
    if (!relFromTable || !relFromCol || !relToTable || !relToCol) {
      toasts.error('Pick from/to table + column')
      return
    }
    pendingFks = [
      ...pendingFks,
      { name: `fk_${relFromTable}_${relFromCol}`, from_table: relFromTable, from_column: relFromCol, to_table: relToTable, to_column: relToCol },
    ]
    relOpen = false
    relFromCol = ''
    relToCol = ''
    layout()
  }

  // Phase 3 — hand-drawn relationship. Svelte Flow's connection system (pointer-
  // based, touch-safe) drives the drag: grabbing a column's source anchor draws a
  // temp line to the cursor, and dropping on another column's target anchor fires
  // `onconnect` with the endpoints. We turn that into a pending FK (child.col →
  // parent.col) — same model + arrow style as the "+ Relationship" builder — so the
  // existing FK/edge rendering (layout/edgeFor) is reused untouched. An invalid drop
  // (not on an anchor) never fires onconnect, so the temp line just disappears.
  function onConnect(conn: RelConnection) {
    const rel = relationshipFromConnection(conn, fks, pendingFks)
    if (!rel) return // incomplete (anchor-less drop) or duplicate → ignore
    pendingFks = [...pendingFks, { name: `fk_${rel.from_table}_${rel.from_column}`, ...rel }]
    layout()
    toasts.success(`Relationship ${rel.from_table}.${rel.from_column} → ${rel.to_table}.${rel.to_column} (unsaved — use “Save to DB”)`)
  }

  function saveToDb() {
    if (!pendingFks.length || !tab.connectionId) return
    const sql = pendingFks.map((fk) => genForeignKey(system, schema, fk)).join('\n')
    tabs.openSqlTab({ connectionId: tab.connectionId, title: `Add Relationships · ${schema}`, query: `-- Review carefully before running\n${sql}` })
  }

  function applySearch() {
    const s = search.trim().toLowerCase()
    nodes = nodes.map((n) => ({ ...n, style: !s || n.id.toLowerCase().includes(s) ? '' : 'opacity:0.25' }))
  }

  async function load() {
    if (!tab.connectionId) return
    error = null
    try {
      const tbls = await ipc.listTables(tab.connectionId, schema)
      const real = tbls.filter((t) => t.kind === 'table')
      const withCols: ErTable[] = []
      for (const t of real) {
        const cols = await ipc.listColumns(tab.connectionId, schema, t.name)
        withCols.push({
          name: t.name,
          columns: cols.map((c) => ({ name: c.name, type: c.data_type, pk: c.is_pk, fk: c.is_fk })),
        })
      }
      tables = withCols
      fks = await ipc.listForeignKeys(tab.connectionId, schema).catch(() => [])
      layout()
    } catch (e) {
      error = String(e)
    }
  }

  function layout() {
    const shown = visibleTables(tables, included)
    const g = new Dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 90 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const t of shown) {
      const s = tableSize(t)
      g.setNode(t.name, { width: s.w, height: s.h })
    }
    for (const fk of fks) {
      if (shown.some((t) => t.name === fk.to_table) && shown.some((t) => t.name === fk.from_table)) {
        g.setEdge(fk.to_table, fk.from_table)
      }
    }
    Dagre.layout(g)
    const saved = (tab.state as { positions?: Record<string, { x: number; y: number }> }).positions ?? {}
    const pos: Record<string, { x: number; y: number }> = {}
    nodes = shown.map((t) => {
      const n = g.node(t.name)
      const s = tableSize(t)
      // Ưu tiên vị trí đã lưu (persist qua tab.state); nếu chưa có → dùng dagre.
      const p = saved[t.name] ?? { x: (n?.x ?? 0) - s.w / 2, y: (n?.y ?? 0) - s.h / 2 }
      pos[t.name] = p
      return { id: t.name, type: 'table', position: p, data: { table: t, showAll } }
    })
    positions = pos
    // Arrow points from the child (FK side, N) to the referenced parent (1).
    const edgeFor = (fk: ipc.ForeignKey, i: number, pending: boolean): Edge => ({
      id: pending ? `pfk-${i}` : `fk-${i}`,
      source: fk.from_table,
      target: fk.to_table,
      label: `${fk.from_column} · N:1`,
      animated: pending,
      markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color: pending ? 'var(--success)' : 'var(--primary)' },
      style: pending ? 'stroke: #27AE60; stroke-dasharray: 5 4' : 'stroke: var(--primary)',
    })
    edges = [
      ...fks.filter((fk) => pos[fk.to_table] && pos[fk.from_table]).map((fk, i) => edgeFor(fk, i, false)),
      ...pendingFks.filter((fk) => pos[fk.to_table] && pos[fk.from_table]).map((fk, i) => edgeFor(fk, i, true)),
    ]
  }

  // re-render node data khi toggle showAll (giữ vị trí)
  function applyShowAll() {
    nodes = nodes.map((n) => ({ ...n, data: { ...(n.data as object), showAll } }))
  }

  // #2 — Persist vị trí node vào tab.state.positions (kéo xong → lưu, debounce
  // qua tabs.schedulePersist) → mở lại tab giữ đúng layout cũ.
  function saveLayout() {
    const p: Record<string, { x: number; y: number }> = {}
    for (const n of nodes) p[n.id] = { x: n.position.x, y: n.position.y }
    tab.state = { ...(tab.state as object), positions: p }
    tabs.schedulePersist()
  }

  // Auto-layout: xoá vị trí đã lưu rồi tính lại bằng dagre.
  function autoLayout() {
    tab.state = { ...(tab.state as object), positions: {} }
    layout()
  }

  // Drop a table dragged from the Object Explorer onto the canvas (AUDIT-3 item 1).
  function onDrop(e: DragEvent) {
    e.preventDefault()
    const raw = e.dataTransfer?.getData('application/x-ds-er-table') || e.dataTransfer?.getData('text/plain')
    if (!raw || !paneEl) return
    let payload: { schema?: string; table?: string }
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    const name = payload.table
    if (!name || (payload.schema && payload.schema !== schema)) return
    // Accept even if the table list isn't loaded yet; only reject a name that is
    // known NOT to belong to this schema.
    if (tables.length && !tables.some((t) => t.name === name)) return
    const rect = paneEl.getBoundingClientRect()
    const p = flowPosition(e.clientX, e.clientY, rect, viewport)
    const saved = { ...((tab.state as { positions?: Record<string, { x: number; y: number }> }).positions ?? {}) }
    saved[name] = p
    tab.state = { ...(tab.state as object), included: addTable(included, name), positions: saved }
    layout()
    tabs.schedulePersist()
  }

  $effect(() => {
    void tab.connectionId
    untrack(() => void load())
  })

  function copyMermaid() {
    void navigator.clipboard.writeText(toMermaid(tables, fks)).then(() => toasts.success('Copied Mermaid'))
  }
  function downloadSvg() {
    triggerDownload(new Blob([toSvg(tables, fks, positions)], { type: 'image/svg+xml' }), `er_${schema || 'schema'}.svg`)
  }
  function downloadPng() {
    const svg = toSvg(tables, fks, positions)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width * 2
      canvas.height = img.height * 2
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.scale(2, 2)
      ctx.drawImage(img, 0, 0)
      canvas.toBlob((b) => b && triggerDownload(b, `er_${schema || 'schema'}.png`), 'image/png')
    }
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  }
  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      searchEl?.focus()
      searchEl?.select()
    }
  }}
/>
<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="font-size:var(--px-12);color:var(--text2);font-weight:600">{schema || 'schema'}</span>
    <span style="font-size:var(--px-11_5);color:var(--muted)">{summary}</span>
    <input
      bind:this={searchEl}
      bind:value={search}
      oninput={applySearch}
      placeholder="Find table (Ctrl+F)…"
      aria-label="Find table"
      style="width:var(--px-150);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-8);color:var(--text);font-size:var(--px-11)"
    />
    <div style="margin-left:auto;display:flex;gap:var(--px-7)">
      <span onclick={() => (relOpen = !relOpen)} onkeydown={(e) => e.key === 'Enter' && (relOpen = !relOpen)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">+ Relationship</span>
      {#if pendingFks.length}
        <span onclick={saveToDb} onkeydown={(e) => e.key === 'Enter' && saveToDb()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:#27AE60;color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer;font-weight:600">Save to DB ({pendingFks.length})</span>
      {/if}
      <span onclick={() => { showAll = !showAll; applyShowAll() }} onkeydown={(e) => e.key === 'Enter' && (showAll = !showAll, applyShowAll())} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">{showAll ? 'PK+FK only' : 'Show all columns'}</span>
      <span onclick={autoLayout} onkeydown={(e) => e.key === 'Enter' && autoLayout()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Auto-layout</span>
      <span onclick={downloadPng} onkeydown={(e) => e.key === 'Enter' && downloadPng()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">PNG</span>
      <span onclick={downloadSvg} onkeydown={(e) => e.key === 'Enter' && downloadSvg()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">SVG</span>
      <span onclick={copyMermaid} onkeydown={(e) => e.key === 'Enter' && copyMermaid()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer;font-weight:600">Mermaid</span>
    </div>
  </div>
  {#if relOpen}
    <div style="flex:none;display:flex;align-items:flex-end;gap:var(--px-10);padding:var(--px-8) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--panel);flex-wrap:wrap">
      <span style="font-size:var(--px-11);color:var(--muted)">New FK: (child)</span>
      <label style="font-size:var(--px-10);color:var(--text2);display:flex;flex-direction:column;gap:var(--px-2)">from table
        <select bind:value={relFromTable} style="background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-3) var(--px-6);color:var(--text);font-size:var(--px-11)">
          <option value="">—</option>{#each tables as t (t.name)}<option value={t.name}>{t.name}</option>{/each}
        </select>
      </label>
      <label style="font-size:var(--px-10);color:var(--text2);display:flex;flex-direction:column;gap:var(--px-2)">column
        <select bind:value={relFromCol} style="background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-3) var(--px-6);color:var(--text);font-size:var(--px-11)">
          <option value="">—</option>{#each fromCols as c (c)}<option value={c}>{c}</option>{/each}
        </select>
      </label>
      <span style="font-size:var(--px-12);color:var(--muted)">→ (parent)</span>
      <label style="font-size:var(--px-10);color:var(--text2);display:flex;flex-direction:column;gap:var(--px-2)">to table
        <select bind:value={relToTable} style="background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-3) var(--px-6);color:var(--text);font-size:var(--px-11)">
          <option value="">—</option>{#each tables as t (t.name)}<option value={t.name}>{t.name}</option>{/each}
        </select>
      </label>
      <label style="font-size:var(--px-10);color:var(--text2);display:flex;flex-direction:column;gap:var(--px-2)">column
        <select bind:value={relToCol} style="background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-5);padding:var(--px-3) var(--px-6);color:var(--text);font-size:var(--px-11)">
          <option value="">—</option>{#each toCols as c (c)}<option value={c}>{c}</option>{/each}
        </select>
      </label>
      <span onclick={addRelationship} onkeydown={(e) => e.key === 'Enter' && addRelationship()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">Add</span>
    </div>
  {/if}
  <!-- drop target: tables dragged from the Object Explorer land here (item 1) -->
  <div
    bind:this={paneEl}
    role="application"
    style="flex:1;position:relative;min-height:0"
    ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy' }}
    ondrop={onDrop}
  >
    {#if error}
      <div style="padding:var(--px-16);color:var(--error);font-size:var(--px-12)">{error}</div>
    {:else}
      <SvelteFlow bind:nodes bind:edges bind:viewport {nodeTypes} fitView onnodedragstop={saveLayout} onconnect={onConnect}>
        <Background />
        <Controls />
        <MiniMap />
      </SvelteFlow>
      {#if nodes.length === 0}
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;color:var(--muted);font-size:var(--px-12_5);text-align:center">
          Drag tables from the Explorer here to build the diagram
        </div>
      {/if}
    {/if}
  </div>
</div>
