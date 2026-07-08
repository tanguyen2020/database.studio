<script lang="ts">
  // Save-before-close — Cancel / Don't Save / Save. "Save" writes each dirty SQL
  // editor tab to a .sql file via a native save dialog (item 4), then closes;
  // in the browser (demo/tests) it falls back to marking clean + persisting.
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'

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
    const toClose: string[] = []
    for (const t of pending) {
      const live = tabs.byId(t.id)
      if (!live) continue
      const query = ((live.state as { query?: string }).query ?? '').trim()
      // SQL editor tab with content, in Tauri → save to a file the user picks.
      if (IS_TAURI && live.contentType === 'sql-editor' && query) {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const suggested = `${(live.title || 'query').replace(/[^\w.-]+/g, '_')}.sql`
        const path = await save({ defaultPath: suggested, filters: [{ name: 'SQL', extensions: ['sql'] }] })
        if (!path) continue // user cancelled this file dialog → keep the tab open
        try {
          await ipc.writeTextFile(path, query.endsWith('\n') ? query : `${query}\n`)
          toasts.success(`Saved → ${path}`)
        } catch (e) {
          toasts.error(String(e))
          continue
        }
      }
      live.isDirty = false
      toClose.push(t.id)
    }
    await tabs.persist()
    if (toClose.length) tabs.forceClose(toClose)
    tabs.pendingClose = null
  }
</script>

{#if pending}
  <div
    onkeydown={(e) => e.key === 'Escape' && cancel()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:58"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      role="alertdialog"
      aria-label="Save changes before closing?"
      tabindex="-1"
      style="width:var(--px-460);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden"
    >
      <div style="padding:var(--px-18) var(--px-20) var(--px-8);display:flex;align-items:center;gap:var(--px-10)">
        <span style="font-size:var(--px-18);color:var(--hex-f0a020)">⚠</span>
        <span style="font-weight:700;font-size:var(--px-15)">Save changes before closing?</span>
      </div>
      <div style="padding:0 var(--px-20) var(--px-14)">
        <div style="font-size:var(--px-12_5);color:var(--text2);margin-bottom:var(--px-8)">
          {dirtyTabs.length} tab(s) have unsaved changes:
        </div>
        <div style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-9);padding:var(--px-6);max-height:var(--px-160);overflow:auto">
          {#each dirtyTabs as t (t.id)}
            <div class="mono" style="font-size:var(--px-12);padding:var(--px-5) var(--px-9);color:var(--text2)">● {t.title}</div>
          {/each}
        </div>
      </div>
      <div style="display:flex;gap:var(--px-9);padding:var(--px-14) var(--px-20);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span
          onclick={cancel}
          onkeydown={(e) => e.key === 'Enter' && cancel()}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-14);cursor:pointer"
        >Cancel</span>
        <span
          onclick={dontSave}
          onkeydown={(e) => e.key === 'Enter' && dontSave()}
          role="button"
          tabindex="0"
          style="margin-left:auto;font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-14);cursor:pointer"
        >Don't Save</span>
        <span
          onclick={saveAndClose}
          onkeydown={(e) => e.key === 'Enter' && saveAndClose()}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer;font-weight:600"
        >Save</span>
      </div>
    </div>
  </div>
{/if}
