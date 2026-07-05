<script lang="ts">
  // New Database dialog — name input + Cancel/Create. Create runs CREATE DATABASE
  // on the connection (per its engine), refreshes the tree, and closes.
  import * as ipc from '$lib/ipc'
  import { newDatabaseWizard } from '$lib/stores/newdatabase.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { genCreateDatabase } from '$lib/sql/ddl'

  // Reliable open gate for a class-$state singleton toggled from another component.
  let dlgOpen = $state(false)
  $effect(() => {
    dlgOpen = newDatabaseWizard.open
  })

  let name = $state('')
  let busy = $state(false)

  // reset the field each time the dialog opens
  $effect(() => {
    if (newDatabaseWizard.open) name = ''
  })

  const system = $derived(newDatabaseWizard.system)
  const sqlite = $derived(system === 'sqlite')
  const ddl = $derived(name.trim() ? genCreateDatabase(system, name.trim()) : '')
  const valid = $derived(!!name.trim() && !sqlite)

  async function create() {
    const cid = newDatabaseWizard.connId
    if (!cid || !valid || busy) return
    busy = true
    try {
      const res = await ipc.execStatement(cid, ddl, 0)
      if (res.ok) {
        toasts.success(`Database "${name.trim()}" created`, system)
        // refresh the connection's database/schema lists so the new DB shows up
        await explorer.loadDatabases(cid, true).catch(() => {})
        await explorer.refresh(cid, { kind: 'connection' }).catch(() => {})
        newDatabaseWizard.close()
      } else {
        toasts.error(res.error?.message ?? 'Failed to create database')
      }
    } catch (e) {
      toasts.error(String(e))
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <div
    onclick={() => !busy && newDatabaseWizard.close()}
    onkeydown={() => {}}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:56"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && !busy && newDatabaseWizard.close()}
      role="dialog"
      aria-modal="true"
      aria-label="New Database"
      tabindex="-1"
      style="width:var(--px-460);max-width:94vw;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);box-shadow:0 var(--px-30) var(--px-70) var(--rgba-0-0-0-_55);overflow:hidden;display:flex;flex-direction:column"
    >
      <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-15) var(--px-18);border-bottom:var(--px-1) solid var(--border)">
        <span style="font-weight:700;font-size:var(--px-15)">New Database</span>
        <span style="font-size:var(--px-11_5);color:var(--muted)">{system}</span>
        <span onclick={() => !busy && newDatabaseWizard.close()} onkeydown={(e) => e.key === 'Enter' && newDatabaseWizard.close()} role="button" tabindex="0" style="margin-left:auto;cursor:pointer;color:var(--muted);font-size:var(--px-20)">×</span>
      </div>

      <div style="padding:var(--px-16) var(--px-18);display:flex;flex-direction:column;gap:var(--px-10)">
        <label style="font-size:var(--px-12);color:var(--text2);display:flex;flex-direction:column;gap:var(--px-6)">
          Database name
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:value={name}
            autofocus
            placeholder="new_database"
            spellcheck="false"
            onkeydown={(e) => { if (e.key === 'Enter' && valid) void create() }}
            style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-7) var(--px-10);color:var(--text);font-size:var(--px-13);outline:none"
          />
        </label>
        {#if sqlite}
          <div style="font-size:var(--px-11_5);color:var(--warn)">SQLite databases are files — create a new connection with a new .sqlite path instead.</div>
        {:else if ddl}
          <pre class="mono selectable" style="margin:0;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-10);font-size:var(--px-11_5);color:var(--text2);white-space:pre-wrap">{ddl}</pre>
        {/if}
      </div>

      <div style="flex:none;display:flex;gap:var(--px-9);padding:var(--px-14) var(--px-18);border-top:var(--px-1) solid var(--border);background:var(--panel)">
        <span
          onclick={() => !busy && newDatabaseWizard.close()}
          onkeydown={(e) => e.key === 'Enter' && !busy && newDatabaseWizard.close()}
          role="button"
          tabindex="0"
          style="margin-left:auto;font-size:var(--px-12_5);background:var(--surface);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-16);cursor:pointer"
        >Cancel</span>
        <span
          onclick={() => void create()}
          onkeydown={(e) => e.key === 'Enter' && void create()}
          role="button"
          tabindex="0"
          style="font-size:var(--px-12_5);font-weight:600;background:var(--primary);color:var(--hex-fff);border-radius:var(--px-8);padding:var(--px-8) var(--px-18);cursor:{valid && !busy ? 'pointer' : 'not-allowed'};opacity:{valid && !busy ? 1 : 0.5}"
        >{busy ? 'Creating…' : 'Create'}</span>
      </div>
    </div>
  </div>
{/if}
