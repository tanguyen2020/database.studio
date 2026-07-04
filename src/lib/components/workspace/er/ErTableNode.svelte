<script lang="ts">
  // Node bảng trong ER diagram (Phase 5 · T8) — header + rows PK🔑/FK🔗.
  import { Handle, Position } from '@xyflow/svelte'
  import type { ErTable } from '$lib/er/mermaid'

  interface Props {
    data: { table: ErTable; showAll: boolean }
  }
  let { data }: Props = $props()
  const rows = $derived(data.showAll ? data.table.columns : data.table.columns.filter((c) => c.pk || c.fk))
</script>

<div style="min-width:190px;background:var(--panel);border:1px solid var(--border2);border-radius:8px;overflow:hidden;font-size:11px">
  <Handle type="target" position={Position.Left} style="opacity:0" />
  <div style="background:var(--raised);padding:6px 10px;font-weight:700;font-size:12px;color:var(--text);border-bottom:1px solid var(--border)" class="mono">{data.table.name}</div>
  <div>
    {#each rows as c (c.name)}
      <div style="display:flex;align-items:center;gap:6px;padding:3px 10px;border-bottom:1px solid var(--border)">
        <span style="width:14px;flex:none">{c.pk ? '🔑' : c.fk ? '🔗' : ''}</span>
        <span class="mono" style="color:var(--text2)">{c.name}</span>
        <span class="mono" style="margin-left:auto;color:var(--muted);font-size:10px">{c.type}</span>
      </div>
    {/each}
  </div>
  <Handle type="source" position={Position.Right} style="opacity:0" />
</div>
