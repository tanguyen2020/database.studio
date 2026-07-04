<script lang="ts">
  // ER Diagram (Phase 5 · T8) — SvelteFlow + dagre. Fetch schema (tables+cols+FK),
  // custom table nodes, FK edges, auto-layout, zoom/pan/minimap, toggle columns,
  // export PNG/SVG/Mermaid. Toolbar port dòng 1257-1276.
  import '@xyflow/svelte/dist/style.css'
  import { untrack } from 'svelte'
  import { SvelteFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/svelte'
  import Dagre from '@dagrejs/dagre'
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { toMermaid, toSvg, tableSize, type ErTable } from '$lib/er/mermaid'
  import ErTableNode from './er/ErTableNode.svelte'
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

  const summary = $derived(`${tables.length} tables · ${fks.length} relationships`)

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
    const g = new Dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: 50, ranksep: 90 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const t of tables) {
      const s = tableSize(t)
      g.setNode(t.name, { width: s.w, height: s.h })
    }
    for (const fk of fks) {
      if (tables.some((t) => t.name === fk.to_table) && tables.some((t) => t.name === fk.from_table)) {
        g.setEdge(fk.to_table, fk.from_table)
      }
    }
    Dagre.layout(g)
    const pos: Record<string, { x: number; y: number }> = {}
    nodes = tables.map((t) => {
      const n = g.node(t.name)
      const s = tableSize(t)
      const p = { x: (n?.x ?? 0) - s.w / 2, y: (n?.y ?? 0) - s.h / 2 }
      pos[t.name] = p
      return { id: t.name, type: 'table', position: p, data: { table: t, showAll } }
    })
    positions = pos
    edges = fks
      .filter((fk) => pos[fk.to_table] && pos[fk.from_table])
      .map((fk, i) => ({
        id: `fk-${i}`,
        source: fk.to_table,
        target: fk.from_table,
        label: fk.from_column,
        animated: false,
        style: 'stroke: var(--primary)',
      }))
  }

  // re-render node data khi toggle showAll (giữ vị trí)
  function applyShowAll() {
    nodes = nodes.map((n) => ({ ...n, data: { ...(n.data as object), showAll } }))
  }

  $effect(() => {
    void tab.connectionId
    untrack(() => void load())
  })

  function copyMermaid() {
    void navigator.clipboard.writeText(toMermaid(tables, fks)).then(() => toasts.success('Đã copy Mermaid'))
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

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="font-size:var(--px-12);color:var(--text2);font-weight:600">{schema || 'schema'}</span>
    <span style="font-size:var(--px-11_5);color:var(--muted)">{summary}</span>
    <div style="margin-left:auto;display:flex;gap:var(--px-7)">
      <span onclick={() => { showAll = !showAll; applyShowAll() }} onkeydown={(e) => e.key === 'Enter' && (showAll = !showAll, applyShowAll())} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">{showAll ? 'PK+FK only' : 'Show all columns'}</span>
      <span onclick={layout} onkeydown={(e) => e.key === 'Enter' && layout()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">Auto-layout</span>
      <span onclick={downloadPng} onkeydown={(e) => e.key === 'Enter' && downloadPng()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">PNG</span>
      <span onclick={downloadSvg} onkeydown={(e) => e.key === 'Enter' && downloadSvg()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-10);cursor:pointer">SVG</span>
      <span onclick={copyMermaid} onkeydown={(e) => e.key === 'Enter' && copyMermaid()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);cursor:pointer;font-weight:600">Mermaid</span>
    </div>
  </div>
  <div style="flex:1;position:relative;min-height:0">
    {#if error}
      <div style="padding:var(--px-16);color:var(--error);font-size:var(--px-12)">{error}</div>
    {:else}
      <SvelteFlow bind:nodes bind:edges {nodeTypes} fitView>
        <Background />
        <Controls />
        <MiniMap />
      </SvelteFlow>
    {/if}
  </div>
</div>
