<script lang="ts">
  // Một node trong cây kế hoạch (Phase 5 · T1). Đệ quy con; hotspot đỏ/cam;
  // tooltip hiện toàn bộ extra. Chiều rộng thanh row tỉ lệ log(rows).
  import type { PlanNode } from '$lib/ipc'
  import Self from './PlanNodeBox.svelte'

  interface Props {
    node: PlanNode
    depth?: number
  }
  let { node, depth = 0 }: Props = $props()

  const rows = $derived(node.actual_rows ?? node.estimated_rows ?? 0)
  // width bar 0..1 theo log10(rows)
  const rowBar = $derived(Math.min(1, Math.log10(Math.max(rows, 1)) / 7))
  const tip = $derived(
    Object.entries(node.extra)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
  )
</script>

<div style="margin-left:{depth === 0 ? 0 : 20}px;border-left:{depth === 0 ? 'none' : '1px dashed var(--border2)'};padding-left:{depth === 0 ? 0 : 10}px">
  <div
    title={tip}
    style="display:inline-flex;flex-direction:column;gap:2px;margin:4px 0;padding:8px 12px;border-radius:8px;min-width:180px;
      border:1px solid {node.is_hotspot ? '#e0803a' : 'var(--border)'};
      background:{node.is_hotspot ? 'rgba(224,128,58,.12)' : 'var(--panel)'}"
  >
    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:12.5px;font-weight:700;color:{node.is_hotspot ? '#e0803a' : 'var(--text)'}">{node.operation}</span>
      {#if node.is_hotspot}<span style="font-size:9px;font-weight:700;background:#e0803a;color:#0f1219;border-radius:3px;padding:1px 5px">HOTSPOT</span>{/if}
      {#if node.extra['Relation Name']}<span class="mono" style="font-size:10.5px;color:var(--muted)">{node.extra['Relation Name']}</span>{/if}
      {#if node.extra['Index Name']}<span class="mono" style="font-size:10.5px;color:#56b6c2">{node.extra['Index Name']}</span>{/if}
    </div>
    <div style="display:flex;align-items:center;gap:10px;font-size:10px;color:var(--muted)" class="mono">
      {#if node.cost_pct != null}<span style="font-weight:700;color:{node.is_hotspot ? '#e0803a' : 'var(--text2)'}">Cost {node.cost_pct}%</span>{/if}
      {#if node.estimated_cost != null}<span>cost {node.estimated_cost.toFixed(1)}</span>{/if}
      {#if node.estimated_rows != null}<span>est {Math.round(node.estimated_rows).toLocaleString()}</span>{/if}
      {#if node.actual_rows != null}<span style="color:var(--text2)">act {Math.round(node.actual_rows).toLocaleString()}</span>{/if}
      {#if node.actual_time_ms != null}<span style="color:var(--text2)">{node.actual_time_ms.toFixed(1)}ms</span>{/if}
    </div>
    <!-- row-count bar (chiều rộng ~ số rows) -->
    <div style="height:3px;border-radius:2px;background:linear-gradient(90deg,{node.is_hotspot ? '#e0803a' : 'var(--primary)'} {rowBar * 100}%, var(--border) {rowBar * 100}%)"></div>
  </div>
  {#each node.children as child, i (i)}
    <Self node={child} depth={depth + 1} />
  {/each}
</div>
