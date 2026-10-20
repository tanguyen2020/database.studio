<script lang="ts">
  // One context menu for a whole list, instead of one per row.
  //
  // A bits-ui ContextMenu.Root + Trigger per row is cheap for a dozen rows and
  // ruinous for thousands: opening a schema with 3,000 tables built 3,000 menu
  // roots (~6 of the 7 seconds it took), and the menu body itself (e.g. the table
  // menu component) was instantiated per row as well. Here a row only remembers
  // WHICH menu it wants; the menu is built when it is actually opened.
  //
  // How it opens at the pointer: the row's contextmenu event is replayed (same
  // coordinates) on a hidden trigger, so bits-ui positions and focuses the menu
  // exactly as it did with a trigger per row. The replay must bubble — Svelte
  // delegates `contextmenu` to the document root.
  import type { Snippet } from 'svelte'
  import * as ContextMenu from './index'

  let menu = $state<Snippet | null>(null)
  let trigger = $state<HTMLElement | null>(null)

  /** Open `m` at the pointer of `e`. A row without a menu should not call this. */
  export function open(e: MouseEvent, m: Snippet) {
    // something deeper (a nested component's own menu) already handled it
    if (e.defaultPrevented || !trigger) return
    e.preventDefault()
    menu = m
    trigger.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
      }),
    )
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger
    bind:ref={trigger}
    aria-hidden="true"
    tabindex={-1}
    style="position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none"
  />
  {#if menu}{@render menu()}{/if}
</ContextMenu.Root>
