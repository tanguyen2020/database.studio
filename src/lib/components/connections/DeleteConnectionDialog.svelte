<script lang="ts">
  // Delete connection dialog — port 1:1 từ Database Studio.dc.html dòng 2068-2090.
  // Cancel / Close tabs & Delete / Force Delete (tab orphaned: badge xám ⚠, giữ nội dung).
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

{#if target}
  <div
    onclick={close}
    onkeydown={(e) => e.key === 'Escape' && close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:55"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="alertdialog"
      aria-label="Delete connection"
      tabindex="-1"
      style="width:var(--px-480);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden"
    >
      <div style="padding:var(--px-18) var(--px-20) var(--px-8);display:flex;align-items:center;gap:var(--px-10)">
        <span style="font-size:var(--px-18);color:var(--hex-f0a020)">⚠</span>
        <span style="font-weight:700;font-size:var(--px-15)">Delete connection "{target.name}"?</span>
      </div>
      <div style="padding:0 var(--px-20) var(--px-14)">
        <div style="font-size:var(--px-12_5);color:var(--text2);margin-bottom:var(--px-8)">
          This connection is used by {affectedTabs.length} tab(s):
        </div>
        <div style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-9);padding:var(--px-6);max-height:var(--px-160);overflow:auto">
          {#each affectedTabs as t (t.id)}
            <div class="mono" style="font-size:var(--px-12);padding:var(--px-5) var(--px-9);color:var(--text2)">· {t.title}</div>
          {:else}
            <div class="mono" style="font-size:var(--px-12);padding:var(--px-5) var(--px-9);color:var(--muted)">(không có tab nào)</div>
          {/each}
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
          onclick={closeTabsAndDelete}
          onkeydown={(e) => e.key === 'Enter' && closeTabsAndDelete()}
          role="button"
          tabindex="0"
          style="margin-left:auto;font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-14);cursor:pointer"
        >Close tabs &amp; Delete</span>
        <span
          onclick={forceDelete}
          onkeydown={(e) => e.key === 'Enter' && forceDelete()}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);background:var(--hex-e03131);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-14);cursor:pointer;font-weight:600"
        >Force Delete</span>
      </div>
    </div>
  </div>
{/if}
