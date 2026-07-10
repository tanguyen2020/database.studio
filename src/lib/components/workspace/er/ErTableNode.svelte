<script lang="ts">
  // Node bảng trong ER diagram (Phase 5 · T8) — header + rows PK🔑/FK🔗.
  // Mỗi cột có một cặp anchor (Handle source phải / target trái, id = tên cột) để
  // vẽ tay quan hệ (Phase 3). Cặp Handle mức-node (id rỗng, ẩn) GIỮ NGUYÊN để mũi
  // tên FK tự động (edgeFor, không set handle) vẫn bám như cũ — không phá code cũ.
  import { Handle, Position } from '@xyflow/svelte'
  import type { ErTable } from '$lib/er/mermaid'

  interface Props {
    data: { table: ErTable; showAll: boolean }
  }
  let { data }: Props = $props()
  const rows = $derived(data.showAll ? data.table.columns : data.table.columns.filter((c) => c.pk || c.fk))
</script>

<div class="er-node" style="min-width:190px;background:var(--panel);border:1px solid var(--border2);border-radius:8px;overflow:hidden;font-size:11px">
  <!-- node-level default handles (id rỗng) — mũi tên FK tự động bám vào đây (giữ nguyên) -->
  <Handle type="target" position={Position.Left} style="opacity:0" />
  <Handle type="source" position={Position.Right} style="opacity:0" />
  <div style="background:var(--raised);padding:6px 10px;font-weight:700;font-size:12px;color:var(--text);border-bottom:1px solid var(--border)" class="mono">{data.table.name}</div>
  <div>
    {#each rows as c (c.name)}
      <div style="position:relative;display:flex;align-items:center;gap:6px;padding:3px 10px;border-bottom:1px solid var(--border)">
        <!-- per-column anchors: kéo từ source (phải) sang target (trái) cột khác -->
        <Handle type="target" position={Position.Left} id={c.name} class="col-anchor" />
        <span style="width:14px;flex:none">{c.pk ? '🔑' : c.fk ? '🔗' : ''}</span>
        <span class="mono" style="color:var(--text2)">{c.name}</span>
        <span class="mono" style="margin-left:auto;color:var(--muted);font-size:10px">{c.type}</span>
        <Handle type="source" position={Position.Right} id={c.name} class="col-anchor" />
      </div>
    {/each}
  </div>
</div>

<style>
  /* Per-column anchor dots — subtle by default, brighten when hovering the node so
     they're easy to grab for hand-drawing a relationship (Svelte Flow's Handle DOM
     is a child of this component, so target it via :global). */
  :global(.er-node .col-anchor) {
    width: var(--px-9);
    height: var(--px-9);
    background: var(--primary);
    border: var(--px-2) solid var(--panel);
    opacity: 0.35;
    transition: opacity 0.12s ease;
  }
  :global(.er-node:hover .col-anchor) {
    opacity: 1;
  }
</style>
