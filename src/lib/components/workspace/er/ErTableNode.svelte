<script lang="ts">
  // Node bảng trong ER diagram (Phase 5 · T8) — header + rows PK🔑/FK🔗.
  // Mỗi cột có một cặp anchor (Handle source phải / target trái, id = tên cột) để
  // vẽ tay quan hệ (Phase 3). Cặp Handle mức-node (id rỗng, ẩn) GIỮ NGUYÊN để mũi
  // tên FK tự động (edgeFor, không set handle) vẫn bám như cũ — không phá code cũ.
  import { Handle, Position, NodeResizer } from '@xyflow/svelte'
  import type { ErTable } from '$lib/er/mermaid'

  interface Props {
    // SvelteFlow passes the node's `selected` flag + its data to custom nodes.
    data: { table: ErTable; showAll: boolean; onResizeEnd?: () => void }
    selected?: boolean
  }
  let { data, selected = false }: Props = $props()
  const rows = $derived(data.showAll ? data.table.columns : data.table.columns.filter((c) => c.pk || c.fk))
</script>

<!-- Resize: select a table (single click) → drag any corner/edge to shrink or grow
     it. Only visible while selected. onResizeEnd persists the new size (like layout).
     The node fills whatever box the resizer sets; overflow clips excess rows. -->
<NodeResizer isVisible={selected} minWidth={130} minHeight={52} onResizeEnd={() => data.onResizeEnd?.()} />
<div class="er-node" style="position:relative;width:100%;height:100%;min-width:130px;background:var(--panel);border:1px solid var(--border2);border-radius:8px;overflow:hidden;font-size:12px;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility">
  <!-- node-level default handles (id rỗng) — mũi tên FK tự động bám vào đây (giữ nguyên) -->
  <Handle type="target" position={Position.Left} style="opacity:0" />
  <Handle type="source" position={Position.Right} style="opacity:0" />
  <!-- full-node drop target (id `__node__`): while a relationship is being dragged,
       xyflow gives it pointer-events (via .connectionindicator), so releasing ANYWHERE
       on this table registers a drop → resolveConnection defaults it to this table's PK.
       When idle it has no pointer-events, so it never blocks node dragging/clicks. -->
  <Handle type="target" position={Position.Left} id="__node__" class="node-drop" isConnectableStart={false} />
  <div style="background:var(--raised);padding:7px 11px;font-weight:700;font-size:13px;color:var(--text);border-bottom:1px solid var(--border);letter-spacing:0.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" class="mono">{data.table.name}</div>
  <div>
    {#each rows as c (c.name)}
      <!-- per-column anchors: grab the right (source) dot and drag to another table.
           Bigger + always-visible so relationships are easy to draw; the PK anchor is
           emphasized since it's the usual drag origin. -->
      {@const anchorClass = 'col-anchor' + (c.pk ? ' pk-anchor' : '')}
      <div style="position:relative;display:flex;align-items:center;gap:6px;padding:4px 11px;border-bottom:1px solid var(--border)">
        <Handle type="target" position={Position.Left} id={c.name} class={anchorClass} />
        <span style="width:14px;flex:none">{c.pk ? '🔑' : c.fk ? '🔗' : ''}</span>
        <span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-weight:{c.pk ? 600 : 500}">{c.name}</span>
        <span class="mono" style="flex:none;color:var(--muted);font-size:10px">{c.type}</span>
        <Handle type="source" position={Position.Right} id={c.name} class={anchorClass} />
      </div>
    {/each}
  </div>
</div>

<style>
  /* Per-column anchors — tall pill-shaped grab zones on each row edge so drawing a
     relationship is easy (no pixel-hunting a tiny dot). Visible even without hover;
     brighter on node-hover and full on direct hover / while connecting. Svelte
     Flow's Handle DOM is a child of this component, so target it via :global. */
  :global(.er-node .col-anchor) {
    width: var(--px-11);
    height: var(--px-16);
    border-radius: var(--px-3);
    background: var(--primary);
    border: var(--px-2) solid var(--panel);
    opacity: 0.5;
    transition: opacity 0.12s ease;
  }
  /* PK anchor — the usual drag origin — stays clearly visible. */
  :global(.er-node .pk-anchor) {
    opacity: 0.85;
  }
  :global(.er-node:hover .col-anchor) {
    opacity: 0.9;
  }
  :global(.er-node .col-anchor:hover),
  :global(.svelte-flow__handle.connectingfrom.col-anchor) {
    opacity: 1;
  }
  /* Full-node drop target — covers the whole node, invisible; xyflow toggles its
     pointer-events only during a connection drag. */
  :global(.er-node .node-drop) {
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    transform: none;
    border: 0;
    border-radius: var(--px-8);
    background: transparent;
    opacity: 0;
  }
  /* Subtle highlight on the table being dropped onto. */
  :global(.er-node .node-drop.connectingto) {
    background: color-mix(in srgb, var(--primary) 14%, transparent);
    opacity: 1;
  }
</style>
