<script lang="ts">
  // Save-while-connected dialog: Cancel | Save & Reconnect | Save only.
  // Không có trong HTML prototype (spec phase-1 §3) — dùng đúng ngôn ngữ modal
  // của prototype (khung 460px như save-before-close dòng 2093-2113).
  import { connections } from '$lib/stores/connections.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { ui } from '$lib/stores/ui.svelte'

  const req = $derived(ui.editConnected)
  let busy = $state(false)

  function close() {
    ui.editConnected = null
  }

  async function saveOnly() {
    if (!req || busy) return
    busy = true
    try {
      const saved = await connections.save(req.draft)
      if (saved) {
        toasts.success(`Saved "${saved.name}" — new config applies on next connect`, saved.system)
        close()
      }
    } finally {
      busy = false
    }
  }

  async function saveAndReconnect() {
    if (!req || busy) return
    busy = true
    try {
      const saved = await connections.save(req.draft)
      if (!saved) return
      close()
      // Tabs giữ nguyên nội dung editor; reconnect thất bại → banner "Disconnected · Reconnect"
      const ok = await connections.reconnect(saved.id)
      if (ok) {
        toasts.success(`"${saved.name}" reconnected with the new config`, saved.system)
      }
    } finally {
      busy = false
    }
  }
</script>

{#if req}
  <div
    onclick={close}
    onkeydown={(e) => e.key === 'Escape' && close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:58"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="alertdialog"
      aria-label="Apply changes"
      tabindex="-1"
      style="width:var(--px-460);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden"
    >
      <div style="padding:var(--px-18) var(--px-20) var(--px-8);display:flex;align-items:center;gap:var(--px-10)">
        <span style="font-size:var(--px-18);color:var(--hex-f0a020)">⚠</span>
        <span style="font-weight:700;font-size:var(--px-15)">Apply changes to "{req.draft.profile.name}"?</span>
      </div>
      <div style="padding:0 var(--px-20) var(--px-14)">
        <div style="font-size:var(--px-12_5);color:var(--text2)">
          {#if req.tabCount > 0}
            This connection has <b>{req.tabCount} tab(s)</b> open.
          {/if}
          Changes take effect on the next connection.
        </div>
      </div>
      <div style="display:flex;gap:var(--px-9);padding:var(--px-14) var(--px-20);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span
          onclick={close}
          onkeydown={(e) => e.key === 'Enter' && close()}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-14);cursor:pointer"
        >Cancel</span>
        <span
          onclick={saveAndReconnect}
          onkeydown={(e) => e.key === 'Enter' && saveAndReconnect()}
          role="button"
          tabindex="0"
          style="margin-left:auto;font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-14);cursor:pointer"
        >Save &amp; Reconnect</span>
        <span
          onclick={saveOnly}
          onkeydown={(e) => e.key === 'Enter' && saveOnly()}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer;font-weight:600"
        >Save only</span>
      </div>
    </div>
  </div>
{/if}
