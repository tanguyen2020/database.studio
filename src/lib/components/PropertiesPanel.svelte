<script lang="ts">
  // Object Properties (right sidebar) — port 1:1 từ Database Studio.dc.html
  // dòng 1510-1554. Phase 2: shell + empty state (mặc định mở, 264px, resize,
  // toggle ⇥). Nội dung properties (DDL + stats + index) nối ở Phase 5.
  import { ui } from '$lib/stores/ui.svelte'

  let dragging = $state(false)

  function onDrag(e: PointerEvent) {
    if (!dragging) return
    ui.rightPanelWidth = Math.min(Math.max(window.innerWidth - e.clientX, 180), 480)
    ui.persistSizes()
  }
</script>

{#if ui.rightPanelOpen}
  <!-- resizer — dòng 1512 -->
  <div
    style="flex:none;width:var(--px-5);cursor:col-resize;background:var(--border);align-self:stretch"
    role="separator"
    aria-orientation="vertical"
    title="Drag to resize"
    onpointerdown={(e) => {
      dragging = true
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }}
    onpointermove={onDrag}
    onpointerup={() => (dragging = false)}
  ></div>
  <!-- panel — dòng 1513-1553 -->
  <div style="width:{ui.rightPanelWidth}px;flex:none;display:flex;flex-direction:column;background:var(--surface);border-left:var(--px-1) solid var(--border);min-height:0">
    <div style="flex:none;display:flex;align-items:center;gap:var(--px-8);padding:var(--px-9) var(--px-12);border-bottom:var(--px-1) solid var(--border)">
      <span style="font-size:var(--px-10_5);font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)">Properties</span>
      <span
        onclick={() => (ui.rightPanelOpen = false)}
        onkeydown={(e) => e.key === 'Enter' && (ui.rightPanelOpen = false)}
        role="button"
        tabindex="0"
        title="Hide panel"
        style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-14)"
      >⇥</span>
    </div>
    <div style="flex:1;overflow:auto;min-height:0">
      <!-- empty state — dòng 1519-1524; nội dung prop → Phase 5 -->
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--px-8);color:var(--muted);padding:var(--px-20);text-align:center">
        <span style="font-size:var(--px-22)">⊟</span>
        <div style="font-size:var(--px-12)">Select a table or column in the Explorer to view its properties</div>
      </div>
    </div>
  </div>
{:else}
  <!-- collapsed handle — click to reopen the Properties panel -->
  <div
    onclick={() => (ui.rightPanelOpen = true)}
    onkeydown={(e) => e.key === 'Enter' && (ui.rightPanelOpen = true)}
    role="button"
    tabindex="0"
    title="Show Properties panel"
    style="flex:none;width:var(--px-18);align-self:stretch;display:flex;align-items:center;justify-content:center;cursor:pointer;background:var(--surface);border-left:var(--px-1) solid var(--border);color:var(--muted)"
  >
    <span style="font-size:var(--px-12);font-weight:700;letter-spacing:.1em;writing-mode:vertical-rl;text-orientation:mixed;text-transform:uppercase">⇤ Properties</span>
  </div>
{/if}
