<script lang="ts">
  // Saving changes to a connected profile:
  //   Cancel | Save & Reconnect (reload tabs' schema) | Save only (apply next connect)
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'

  const req = $derived(ui.editConnected)
  let busy = $state(false)

  function close() {
    ui.editConnected = null
  }

  async function saveOnly() {
    if (!req) return
    busy = true
    try {
      const saved = await connections.save(req.draft)
      if (saved) {
        toasts.success(`Đã lưu "${saved.name}" — config mới áp dụng ở lần kết nối tiếp theo`, saved.system)
        close()
      }
    } finally {
      busy = false
    }
  }

  async function saveAndReconnect() {
    if (!req) return
    busy = true
    try {
      const saved = await connections.save(req.draft)
      if (!saved) return
      close()
      // Tabs keep their editor content; schema cache reloads via reconnect.
      const ok = await connections.reconnect(saved.id)
      if (ok) {
        toasts.success(`"${saved.name}" đã reconnect với config mới`, saved.system)
      }
      // On failure the tabs show the "Disconnected · Reconnect" banner —
      // content is never lost (reconnect() already flagged connected=false).
    } finally {
      busy = false
    }
  }
</script>

<Dialog.Root open={!!req} onOpenChange={(o) => !o && close()}>
  <Dialog.Content class="max-w-[460px]">
    {#if req}
      <Dialog.Header>
        <Dialog.Title>Apply changes to "{req.draft.profile.name}"?</Dialog.Title>
      </Dialog.Header>
      <p class="text-[12.5px] text-text2">
        {#if req.tabCount > 0}
          Connection này đang có <b>{req.tabCount} tab</b> mở.
        {/if}
        Thay đổi sẽ có hiệu lực ở lần kết nối tiếp theo.
      </p>
      <Dialog.Footer>
        <Button variant="ghost" size="sm" onclick={close} disabled={busy}>Cancel</Button>
        <Button variant="secondary" size="sm" onclick={saveAndReconnect} disabled={busy}>
          Save & Reconnect
        </Button>
        <Button size="sm" onclick={saveOnly} disabled={busy}>Save only</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
