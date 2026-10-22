<script lang="ts">
  // List on the left, details of the selected item on the right (SPEC-STREAM-SHELL.md
  // §3). The divider is draggable; the split is remembered per `storeKey`. With nothing
  // selected the list takes the full width and no empty detail pane is shown.
  import type { Snippet } from 'svelte'
  import { onDestroy, untrack } from 'svelte'

  interface Props {
    storeKey: string
    open: boolean
    list: Snippet
    detail: Snippet
    /** list share in percent when nothing is remembered yet */
    initial?: number
  }
  let { storeKey, open, list, detail, initial = 55 }: Props = $props()

  const MIN = 30
  const MAX = 75
  function read(): number {
    try {
      const v = Number(localStorage.getItem(`ds.stream.split.${storeKey}`))
      return Number.isFinite(v) && v >= MIN && v <= MAX ? v : initial
    } catch {
      return initial
    }
  }
  let share = $state(untrack(read))
  let host = $state<HTMLDivElement | null>(null)
  let dragging = $state(false)

  function move(e: PointerEvent) {
    if (!host) return
    const r = host.getBoundingClientRect()
    share = Math.max(MIN, Math.min(MAX, ((e.clientX - r.left) / r.width) * 100))
  }
  function up() {
    dragging = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    try {
      localStorage.setItem(`ds.stream.split.${storeKey}`, String(Math.round(share)))
    } catch {
      /* ignore */
    }
  }
  function down(e: PointerEvent) {
    e.preventDefault()
    dragging = true
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  function key(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    share = Math.max(MIN, Math.min(MAX, share + (e.key === 'ArrowRight' ? 3 : -3)))
  }
  onDestroy(() => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  })
</script>

<div class="sd" bind:this={host} class:dragging>
  <div class="sd-list" style={open ? `flex:0 0 ${share}%` : 'flex:1 1 auto'}>{@render list()}</div>
  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="sd-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the details panel"
      aria-valuenow={Math.round(share)}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabindex="0"
      onpointerdown={down}
      onkeydown={key}
    ></div>
    <div class="sd-detail">{@render detail()}</div>
  {/if}
</div>

<style>
  .sd {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .sd.dragging {
    cursor: col-resize;
    user-select: none;
  }
  .sd-list {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .sd-handle {
    flex: none;
    width: var(--px-5);
    cursor: col-resize;
    background: var(--border);
  }
  .sd-handle:hover,
  .sd-handle:focus-visible,
  .sd.dragging .sd-handle {
    background: color-mix(in srgb, var(--primary) 55%, var(--border));
    outline: none;
  }
  .sd-detail {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    overflow: auto;
  }
</style>
