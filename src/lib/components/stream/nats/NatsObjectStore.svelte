<script lang="ts">
  // NATS workspace › Object stores: buckets of files kept by JetStream. Pick a bucket to
  // see its files; upload, download and delete them. (Moved here from the classic NATS
  // tab; the window.prompt it used is now an in-app form, and deletes ask first.)
  import { onMount } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import Icon from '$lib/components/Icon.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import { formatBytes } from '$lib/format/bytes'
  import { plural } from '$lib/stream/humanize'

  let { connId, persistence = null }: { connId: string; persistence?: boolean | null } = $props()

  let buckets = $state<string[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let selected = $state<string | null>(null)
  let objects = $state<ipc.NatsObjInfo[]>([])
  let loadingObjects = $state(false)

  let creating = $state(false)
  let newName = $state('')
  let createError = $state<string | null>(null)
  const nameProblem = $derived(
    !newName.trim()
      ? null
      : !/^[A-Za-z0-9_-]+$/.test(newName.trim())
        ? 'Use letters, digits, "-" and "_" only'
        : buckets.includes(newName.trim())
          ? 'A bucket with this name already exists'
          : null,
  )

  let confirm = $state<{ title: string; body: string; button: string; run: () => Promise<void> } | null>(null)
  let confirmBusy = $state(false)
  let confirmError = $state<string | null>(null)

  onMount(() => void loadBuckets())

  async function loadBuckets() {
    loading = true
    error = null
    try {
      buckets = (await ipc.natsObjBuckets(connId)).sort((a, b) => a.localeCompare(b))
      if (selected && !buckets.includes(selected)) selected = null
      if (!selected && buckets.length) await pick(buckets[0])
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }
  async function pick(b: string) {
    selected = b
    loadingObjects = true
    try {
      objects = await ipc.natsObjList(connId, b)
    } catch (e) {
      objects = []
      toasts.error(`Could not list ${b}: ${e}`)
    } finally {
      loadingObjects = false
    }
  }
  async function create() {
    const name = newName.trim()
    if (!name || nameProblem) return
    createError = null
    try {
      await ipc.natsObjCreate(connId, name)
      creating = false
      newName = ''
      await loadBuckets()
      await pick(name)
    } catch (e) {
      createError = String(e)
    }
  }
  async function upload() {
    if (!selected) return
    if (!IS_TAURI) return toasts.show('Uploading files works in the desktop app')
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({ multiple: false })
    if (typeof path !== 'string') return
    const name = path.split(/[\\/]/).pop() ?? 'object'
    try {
      await ipc.natsObjPutFile(connId, selected, name, path)
      toasts.success(`Uploaded ${name}`)
      await pick(selected)
    } catch (e) {
      toasts.error(`Upload failed: ${e}`)
    }
  }
  async function download(name: string) {
    if (!selected) return
    if (!IS_TAURI) return toasts.show('Downloading files works in the desktop app')
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: name })
    if (typeof path !== 'string') return
    try {
      await ipc.natsObjGetFile(connId, selected, name, path)
      toasts.success(`Saved ${name}`)
    } catch (e) {
      toasts.error(`Download failed: ${e}`)
    }
  }
  function askDeleteObject(o: ipc.NatsObjInfo) {
    const bucket = selected
    if (!bucket) return
    confirm = {
      title: 'Delete file',
      body: `Delete ${o.name} (${formatBytes(o.size)}) from ${bucket}? This cannot be undone.`,
      button: 'Delete file',
      run: async () => {
        await ipc.natsObjDelete(connId, bucket, o.name)
        await pick(bucket)
      },
    }
  }
  function askDeleteBucket() {
    const bucket = selected
    if (!bucket) return
    confirm = {
      title: 'Delete bucket',
      body: `Delete the bucket ${bucket} and ${plural(objects.length, 'file')} in it? This cannot be undone.`,
      button: objects.length ? `Delete bucket and ${plural(objects.length, 'file')}` : 'Delete bucket',
      run: async () => {
        await ipc.natsObjDeleteBucket(connId, bucket)
        selected = null
        objects = []
        await loadBuckets()
      },
    }
  }
  async function runConfirm() {
    if (!confirm) return
    confirmBusy = true
    confirmError = null
    try {
      await confirm.run()
      confirm = null
    } catch (e) {
      confirmError = String(e)
    } finally {
      confirmBusy = false
    }
  }
  const totalBytes = $derived(objects.reduce((n, o) => n + o.size, 0))
</script>

<div class="no" data-nats-objects>
  {#if persistence === false}
    <div class="ds-empty"><b>Object stores need persistence (JetStream)</b>JetStream is not enabled for this account. Enable it on the server (start nats-server with -js), then refresh.</div>
  {:else}
    <aside class="no-side" aria-label="Object store buckets">
      <div class="no-side-head">
        <span>Buckets</span>
        <button type="button" class="cfm-btn" onclick={() => { creating = !creating; createError = null }} aria-expanded={creating}><Icon name="plus" size={12} />New bucket</button>
      </div>
      {#if creating}
        <form class="no-new" onsubmit={(e) => { e.preventDefault(); void create() }}>
          <input class="ds-control mono" bind:value={newName} placeholder="bucket-name" aria-label="New bucket name" spellcheck="false" use:autofocus onkeydown={(e) => e.key === 'Escape' && (creating = false)} />
          {#if nameProblem}<span class="no-warn">{nameProblem}</span>{/if}
          {#if createError}<span class="no-err" role="alert">{createError}</span>{/if}
          <div class="no-new-actions">
            <button type="button" class="cfm-btn" onclick={() => (creating = false)}>Cancel</button>
            <button type="submit" class="cfm-btn primary" disabled={!newName.trim() || !!nameProblem}>Create bucket</button>
          </div>
        </form>
      {/if}
      {#if loading}
        <div class="no-note">Reading buckets…</div>
      {:else if error}
        <div class="no-err" role="alert">Could not read the buckets: {error}</div>
      {:else if buckets.length === 0}
        <div class="no-note">No buckets yet. A bucket holds files (backups, reports, models…) next to your streams.</div>
      {:else}
        <ul class="no-list">
          {#each buckets as b (b)}
            <li><button type="button" class="no-item" class:on={selected === b} aria-current={selected === b} onclick={() => pick(b)}><Icon name="archive" size={13} /><span class="ds-name">{b}</span></button></li>
          {/each}
        </ul>
      {/if}
    </aside>
    <section class="no-main" aria-label="Files">
      {#if selected}
        <div class="no-main-head">
          <span class="no-title mono">{selected}</span>
          <span class="no-meta">{plural(objects.length, 'file')} · {formatBytes(totalBytes)}</span>
          <span class="no-flex"></span>
          <button type="button" class="cfm-btn primary" onclick={upload}><Icon name="upload" size={12} />Upload file…</button>
          <button type="button" class="cfm-btn ds-danger-outline" onclick={askDeleteBucket}>Delete bucket…</button>
        </div>
        {#if loadingObjects}
          <div class="no-note">Reading files…</div>
        {:else if objects.length === 0}
          <div class="ds-empty"><b>This bucket is empty</b>Upload a file to keep it in {selected}.</div>
        {:else}
          <table class="no-table" aria-label="Files in {selected}">
            <colgroup><col /><col style="width:var(--px-110)" /><col style="width:var(--px-90)" /><col style="width:var(--px-90)" /></colgroup>
            <thead><tr><th>Name</th><th class="r">Size</th><th class="r">Chunks</th><th></th></tr></thead>
            <tbody>
              {#each objects as o (o.name)}
                <tr>
                  <td><span class="ds-name" title={o.name}>{o.name}</span></td>
                  <td class="r ds-num">{formatBytes(o.size)}</td>
                  <td class="r ds-num">{o.chunks}</td>
                  <td class="r no-acts">
                    <button type="button" class="no-icon" onclick={() => download(o.name)} title="Download {o.name}" aria-label="Download {o.name}"><Icon name="download" size={13} /></button>
                    <button type="button" class="no-icon danger" onclick={() => askDeleteObject(o)} title="Delete {o.name}" aria-label="Delete {o.name}"><Icon name="trash" size={13} /></button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {:else if !loading && buckets.length}
        <div class="ds-empty"><b>Pick a bucket</b>Select a bucket on the left to see its files.</div>
      {/if}
    </section>
  {/if}
</div>

{#if confirm}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !confirmBusy && (confirm = null)}>
    <div class="um-dlg sm" role="alertdialog" aria-modal="true" aria-label={confirm.title} tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
        <div class="um-dlg-title"><b>{confirm.title}</b></div>
      </div>
      <div class="um-dlg-body">
        <p class="no-confirm">{confirm.body}</p>
        {#if confirmError}<div class="no-err" role="alert">{confirmError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="no-flex"></span>
        <button type="button" class="cfm-btn" use:autofocus onclick={() => (confirm = null)} disabled={confirmBusy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={runConfirm} disabled={confirmBusy}>{confirmBusy ? 'Deleting…' : confirm.button}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .no {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: var(--px-14);
    padding: var(--px-14);
    background: var(--bg);
  }
  .no-side {
    width: var(--px-240);
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--px-8);
    padding: var(--px-12);
    background: var(--surface);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    overflow: auto;
  }
  .no-side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--tbl-th);
  }
  .no-side-head .cfm-btn,
  .no-main-head .cfm-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
  }
  .no-new {
    display: flex;
    flex-direction: column;
    gap: var(--px-6);
  }
  .no-new-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--px-6);
  }
  .no-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
  }
  .no-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--px-8);
    border: 0;
    background: transparent;
    color: var(--muted);
    padding: var(--px-6) var(--px-8);
    border-radius: var(--px-6);
    cursor: pointer;
    text-align: left;
  }
  .no-item:hover {
    background: var(--tbl-hover);
  }
  .no-item.on {
    background: color-mix(in srgb, var(--text) 11%, var(--surface));
  }
  .no-item.on .ds-name {
    font-weight: 600;
  }
  .no-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
    padding: var(--px-14);
    background: var(--surface);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    overflow: auto;
  }
  .no-main-head {
    display: flex;
    align-items: center;
    gap: var(--px-10);
  }
  .no-title {
    font-size: var(--px-14);
    font-weight: 600;
    color: var(--text);
  }
  .no-meta,
  .no-note {
    font-size: var(--px-12);
    color: var(--muted);
  }
  .no-flex {
    flex: 1;
  }
  .no-warn {
    font-size: var(--px-11_5);
    color: var(--sacc-amber);
  }
  .no-err {
    font-size: var(--px-12);
    color: var(--danger-text);
  }
  .no-confirm {
    margin: 0;
    font-size: var(--px-13);
    color: var(--text2);
  }
  .no-table {
    width: 100%;
    table-layout: fixed;
    border-collapse: separate;
    border-spacing: 0;
    font-size: var(--px-12_5);
  }
  .no-table th {
    text-align: left;
    color: var(--tbl-th);
    font-size: var(--px-12);
    font-weight: 600;
    padding: var(--px-6) var(--px-12);
    border-bottom: var(--px-1) solid var(--border2);
  }
  .no-table td {
    padding: var(--px-6) var(--px-12);
    border-bottom: var(--px-1) solid var(--border);
    color: var(--tbl-cell);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .no-table tbody tr:hover {
    background: var(--tbl-hover);
  }
  .no-table .r {
    text-align: right;
  }
  .no-acts {
    white-space: nowrap;
  }
  .no-icon {
    border: 0;
    background: transparent;
    color: var(--muted);
    display: inline-flex;
    padding: var(--px-3);
    border-radius: var(--px-4);
    cursor: pointer;
  }
  .no-icon:hover {
    background: var(--hover);
    color: var(--text);
  }
  .no-icon.danger:hover {
    color: var(--danger-text);
  }
</style>
