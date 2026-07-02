<script lang="ts">
  // Delete connection. When tabs are using it: Cancel / Close tabs & Delete /
  // Force Delete (tabs become orphaned — gray ⚠ badge, content kept).
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { connections } from '$lib/stores/connections.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'

  const target = $derived(ui.deleteTarget)
  const affectedTabs = $derived(target ? tabs.tabsForConnection(target.id) : [])

  function close() {
    ui.deleteTarget = null
  }

  async function deleteOnly() {
    if (!target) return
    const name = target.name
    await connections.remove(target.id)
    toasts.success(`Đã xóa "${name}"`)
    close()
  }

  async function closeTabsAndDelete() {
    if (!target) return
    tabs.forceClose(affectedTabs.map((t) => t.id))
    await deleteOnly()
  }

  async function forceDelete() {
    if (!target) return
    const id = target.id
    const name = target.name
    await connections.remove(id)
    tabs.orphanByConnection(id)
    toasts.success(`Đã xóa "${name}" — ${affectedTabs.length} tab chuyển sang orphaned`)
    close()
  }
</script>

<Dialog.Root open={!!target} onOpenChange={(o) => !o && close()}>
  <Dialog.Content class="max-w-[480px]">
    {#if target}
      <Dialog.Header>
        <Dialog.Title>Delete connection "{target.name}"?</Dialog.Title>
      </Dialog.Header>

      {#if affectedTabs.length > 0}
        <div class="rounded-md border border-warn/50 bg-panel px-3 py-2 text-[12.5px]">
          <p class="mb-1 font-medium text-warn">
            ⚠ Connection này đang được dùng bởi {affectedTabs.length} tab:
          </p>
          <ul class="ml-4 list-disc text-text2">
            {#each affectedTabs.slice(0, 6) as t (t.id)}
              <li class="truncate">{t.title}</li>
            {/each}
            {#if affectedTabs.length > 6}
              <li>… và {affectedTabs.length - 6} tab khác</li>
            {/if}
          </ul>
        </div>
        <p class="text-[11.5px] text-mutedfg">
          <b>Force Delete</b> giữ nguyên các tab (trạng thái orphaned — không chạy được query
          nhưng không mất nội dung editor).
        </p>
        <Dialog.Footer>
          <Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
          <Button variant="secondary" size="sm" onclick={closeTabsAndDelete}>
            Close tabs & Delete
          </Button>
          <Button variant="destructive" size="sm" onclick={forceDelete}>Force Delete</Button>
        </Dialog.Footer>
      {:else}
        <p class="text-[12.5px] text-text2">Không có tab nào đang dùng connection này.</p>
        <Dialog.Footer>
          <Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
          <Button variant="destructive" size="sm" onclick={deleteOnly}>Delete</Button>
        </Dialog.Footer>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
