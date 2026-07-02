<script lang="ts">
  // Save-before-close for dirty tabs: Cancel / Don't Save / Save.
  // "Save" (Phase 1) keeps the buffer by persisting tab state, then closes.
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import SystemBadge from '$lib/components/SystemBadge.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'

  const pending = $derived(tabs.pendingClose)
  const dirtyTabs = $derived(pending?.filter((t) => t.isDirty) ?? [])

  function cancel() {
    tabs.pendingClose = null
  }

  function dontSave() {
    if (pending) tabs.forceClose(pending.map((t) => t.id))
  }

  async function saveAndClose() {
    if (!pending) return
    // Mark clean (content already lives in tab.state.query) and persist.
    for (const t of pending) {
      const live = tabs.byId(t.id)
      if (live) live.isDirty = false
    }
    await tabs.persist()
    tabs.forceClose(pending.map((t) => t.id))
  }
</script>

<Dialog.Root open={!!pending} onOpenChange={(o) => !o && cancel()}>
  <Dialog.Content class="max-w-[440px]">
    {#if pending}
      <Dialog.Header>
        <Dialog.Title>Lưu thay đổi trước khi đóng?</Dialog.Title>
      </Dialog.Header>
      <div class="text-[12.5px] text-text2">
        {dirtyTabs.length} tab có thay đổi chưa lưu:
        <ul class="mt-1.5 grid gap-1">
          {#each dirtyTabs as t (t.id)}
            <li class="flex items-center gap-1.5">
              <SystemBadge system={t.systemType} />
              <span class="truncate">{t.title}</span>
            </li>
          {/each}
        </ul>
      </div>
      <Dialog.Footer>
        <Button variant="ghost" size="sm" onclick={cancel}>Cancel</Button>
        <Button variant="secondary" size="sm" onclick={dontSave}>Don't Save</Button>
        <Button size="sm" onclick={saveAndClose}>Save</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
