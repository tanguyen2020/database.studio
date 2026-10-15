<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  // Redis single-key viewer (opened from the sidebar key browser). Shows the value
  // per type (string editor / hash / zset / list / set / stream) with a View-JSON
  // popup + Copy on each value, Set TTL, Add item, and Delete key.
  import * as ipc from '$lib/ipc'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { systemMeta } from '$lib/systems'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const key = $derived((tab.state as { key?: string }).key ?? '')
  const accent = systemMeta('redis').accent

  let value = $state<ipc.RedisKeyValue | null>(null)
  const v = $derived(value)
  let loading = $state(false)
  let error = $state<string | null>(null)
  let stringDraft = $state('')
  let mem = $state<number | null>(null)

  // Theme-aware streaming accents (legible on both the light + dark result grid).
  const TYPE_COLOR: Record<string, string> = {
    string: 'var(--sacc-blue)',
    hash: 'var(--sacc-yellow)',
    list: 'var(--sacc-cyan)',
    set: 'var(--sacc-mauve)',
    zset: 'var(--sacc-red)',
    stream: 'var(--sacc-orange)',
  }
  const typeColor = (t: string) => TYPE_COLOR[t] ?? 'var(--text2)'
  const TYPE_LABEL: Record<string, string> = {
    string: 'String',
    hash: 'Hash',
    list: 'List',
    set: 'Set',
    zset: 'Sorted set',
    stream: 'Stream',
  }
  /** TTL in plain words for the header (the sidebar keeps the compact form). */
  function ttlText(ttl: number): string {
    if (ttl === -1) return 'No expiry'
    if (ttl === -2) return 'Expired'
    return `Expires in ${ttlLabel(ttl)}`
  }
  const itemCount = $derived.by(() => {
    const val = v?.value
    if (!val) return null
    if (val.kind === 'hash') return val.fields.length
    if (val.kind === 'zset') return val.members.length
    if (val.kind === 'list') return val.items.length
    if (val.kind === 'set') return val.members.length
    if (val.kind === 'stream') return val.entries.length
    return null
  })
  const itemNoun = $derived(
    v?.value.kind === 'hash'
      ? { one: 'field', many: 'fields' }
      : v?.value.kind === 'stream'
        ? { one: 'entry', many: 'entries' }
        : v?.value.kind === 'zset' || v?.value.kind === 'set'
          ? { one: 'member', many: 'members' }
          : { one: 'item', many: 'items' },
  )
  function ttlLabel(ttl: number): string {
    if (ttl === -1) return '∞'
    if (ttl === -2) return 'expired'
    if (ttl < 60) return `${ttl}s`
    if (ttl < 3600) return `${Math.floor(ttl / 60)}m`
    return `${Math.floor(ttl / 3600)}h`
  }
  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  async function load() {
    if (!tab.connectionId || !key) return
    loading = true
    error = null
    mem = null
    try {
      value = await ipc.redisGet(tab.connectionId, key)
      if (value.value.kind === 'string') stringDraft = value.value.value
      mem = await ipc.redisMemoryUsage(tab.connectionId, key).catch(() => null)
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void tab.connectionId
    void key
    void load()
  })

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Copied')
  }

  // JSON viewer popup — pretty-prints the value (falls back to raw text when it isn't
  // valid JSON) with syntax coloring so large payloads (e.g. cache blobs) are readable.
  let viewState = $state<{ label: string; text: string; isJson: boolean } | null>(null)
  function viewJson(label: string, raw: string) {
    let text = raw
    let isJson = false
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2)
      isJson = true
    } catch {
      // not JSON — show raw
    }
    viewState = { label, text, isJson }
  }

  async function edit(op: ipc.RedisEditOp, okMsg: string) {
    if (!tab.connectionId || !key) return
    try {
      await ipc.redisEdit(tab.connectionId, key, op)
      toasts.success(okMsg)
      await load()
      explorer.bumpRedis(tab.connectionId)
    } catch (e) {
      toasts.error(`Edit failed: ${e}`)
    }
  }

  function delItem(kind: string, id: string) {
    if (kind === 'hash') void edit({ op: 'hDel', field: id }, `HDEL ${id}`)
    else if (kind === 'set') void edit({ op: 'sRem', member: id }, `SREM ${id}`)
    else if (kind === 'zset') void edit({ op: 'zRem', member: id }, `ZREM ${id}`)
    else if (kind === 'list') void edit({ op: 'lRem', value: id }, 'LREM')
    else if (kind === 'stream') void edit({ op: 'xDel', id }, `XDEL ${id}`)
  }

  // Set TTL form (in-app modal — window.prompt isn't reliable in the Tauri webview).
  let ttlForm = $state<{ secs: string } | null>(null)
  function openTtl() {
    const cur = value?.ttl ?? -1
    ttlForm = { secs: cur > 0 ? String(cur) : '' }
  }
  async function saveTtl() {
    if (!tab.connectionId || !key || !ttlForm) return
    const secs = parseInt(ttlForm.secs, 10) || 0
    ttlForm = null
    try {
      await ipc.redisSetTtl(tab.connectionId, key, secs)
      toasts.success(secs > 0 ? `EXPIRE ${secs}s` : 'PERSIST')
      await load()
      explorer.bumpRedis(tab.connectionId)
    } catch (e) {
      toasts.error(`Set TTL failed: ${e}`)
    }
  }

  // Delete key — in-app confirm; on delete, refresh the sidebar key list and close.
  let confirmDel = $state(false)
  async function delKey() {
    confirmDel = false
    if (!tab.connectionId || !key) return
    try {
      await ipc.redisDel(tab.connectionId, key)
      toasts.success(`Deleted "${key}"`)
      explorer.bumpRedis(tab.connectionId)
      tabs.requestClose([tab.id])
    } catch (e) {
      toasts.error(`DEL failed: ${e}`)
    }
  }
</script>

{#snippet actions(label: string, raw: string, id?: string, del?: (id: string) => void)}
  <!-- row actions: quiet until the row is hovered, delete turns red only on hover -->
  <td class="rk-act">
    <span class="rk-ic" onclick={() => viewJson(label, raw)} onkeydown={(e) => e.key === 'Enter' && viewJson(label, raw)} role="button" tabindex="0" title="View as JSON"><Icon name="expand" size={13} /></span>
    <span class="rk-ic" onclick={() => copy(raw)} onkeydown={(e) => e.key === 'Enter' && copy(raw)} role="button" tabindex="0" title="Copy value"><Icon name="copy" size={13} /></span>
    {#if del && id !== undefined}
      <span class="rk-ic danger" onclick={() => del(id)} onkeydown={(e) => e.key === 'Enter' && del(id)} role="button" tabindex="0" title="Delete this item"><Icon name="trash" size={13} /></span>
    {/if}
  </td>
{/snippet}

{#snippet kvTable(h1: string, h2: string, rows: [string, string][], kind: string, del?: (id: string) => void)}
  <table class="rk-table">
    <thead><tr>
      <th style="width:var(--px-240)">{h1}</th>
      <th>{h2}</th>
      <th class="rk-act-h"></th>
    </tr></thead>
    <tbody>
      {#each rows as row, i (i)}
        <tr>
          <td class="rk-k" title={row[0]}>{row[0]}</td>
          <td class="rk-v" class:num={kind === 'zset'} title={row[1]}>{row[1]}</td>
          {@render actions(row[0], row[1], row[0], del)}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

{#snippet listTable(h1: string, items: string[], kind: string, del?: (id: string) => void)}
  <table class="rk-table">
    <thead><tr>
      <th style="width:var(--px-60)">{h1}</th>
      <th>Value</th>
      <th class="rk-act-h"></th>
    </tr></thead>
    <tbody>
      {#each items as item, i (i)}
        <tr>
          <td class="rk-idx">{i}</td>
          <td class="rk-v" title={item}>{item}</td>
          {@render actions(String(i), item, item, del)}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<div style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative;background:var(--bg)">
  <!-- header: what the key is (type, name) and its facts in plain words -->
  <div class="rk-head">
    <div class="rk-title">
      {#if v}<span class="rk-type" style="--tc:{typeColor(v.key_type)}">{TYPE_LABEL[v.key_type] ?? v.key_type}</span>{/if}
      <span class="rk-name" title={key}>{key}</span>
    </div>
    {#if v}
      <div class="rk-meta">
        <span class:warn={v.ttl === -2}>{ttlText(v.ttl)}</span>
        {#if itemCount != null}<span class="dot">·</span><span>{itemCount.toLocaleString()} {itemCount === 1 ? itemNoun.one : itemNoun.many}</span>{/if}
        {#if mem != null}<span class="dot">·</span><span title="MEMORY USAGE">{fmtBytes(mem)}</span>{/if}
      </div>
    {/if}
    <div class="rk-btns">
      <span onclick={load} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" class="eg-btn rk-btn"><Icon name="refresh" size={12} />Refresh</span>
      <span onclick={openTtl} onkeydown={(e) => e.key === 'Enter' && openTtl()} role="button" tabindex="0" class="eg-btn">Set TTL</span>
      <span onclick={() => (confirmDel = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDel = true)} role="button" tabindex="0" class="eg-btn rk-del">Delete</span>
    </div>
  </div>

  <div class="rk-body">
    {#if loading}
      <div class="rk-note">Loading…</div>
    {:else if error}
      <div class="rk-note" style="color:var(--error)">{error}</div>
    {:else if v?.value.kind === 'string'}
      <div style="padding:var(--px-14);display:flex;flex-direction:column;gap:var(--px-10);height:100%;box-sizing:border-box">
        <div style="flex:none;display:flex;gap:var(--px-8);justify-content:flex-end">
          <span onclick={() => viewJson(key, stringDraft)} onkeydown={(e) => e.key === 'Enter' && viewJson(key, stringDraft)} role="button" tabindex="0" class="eg-btn rk-btn"><Icon name="expand" size={12} />View JSON</span>
          <span onclick={() => copy(stringDraft)} onkeydown={(e) => e.key === 'Enter' && copy(stringDraft)} role="button" tabindex="0" class="eg-btn rk-btn"><Icon name="copy" size={12} />Copy</span>
        </div>
        <textarea
          bind:value={stringDraft}
          class="mono rk-text"
        ></textarea>
        <div style="flex:none;display:flex;justify-content:flex-end">
          <span onclick={() => edit({ op: 'setString', value: stringDraft }, 'SET (saved)')} onkeydown={(e) => e.key === 'Enter' && edit({ op: 'setString', value: stringDraft }, 'SET')} role="button" tabindex="0" class="cfm-btn primary">Save</span>
        </div>
      </div>
    {:else if v?.value.kind === 'hash'}
      {@render kvTable('Field', 'Value', v.value.fields.map((f) => [f[0], f[1]]), 'hash', (id) => delItem('hash', id))}
    {:else if v?.value.kind === 'zset'}
      {@render kvTable('Member', 'Score', v.value.members.map((m) => [m[0], String(m[1])]), 'zset', (id) => delItem('zset', id))}
    {:else if v?.value.kind === 'list'}
      {@render listTable('#', v.value.items, 'list', (id) => delItem('list', id))}
    {:else if v?.value.kind === 'set'}
      {@render listTable('#', v.value.members, 'set', (id) => delItem('set', id))}
    {:else if v?.value.kind === 'stream'}
      <table class="rk-table">
        <thead><tr>
          <th style="width:var(--px-200)">ID</th>
          <th>Fields</th>
          <th class="rk-act-h"></th>
        </tr></thead>
        <tbody>
          {#each v.value.entries as e (e.id)}
            {@const fieldsText = e.fields.map((f) => `${f[0]}=${f[1]}`).join('  ')}
            <tr>
              <td class="rk-k" style="white-space:nowrap">{e.id}</td>
              <td class="rk-v" title={fieldsText}>{fieldsText}</td>
              {@render actions(e.id, JSON.stringify(Object.fromEntries(e.fields)), e.id, (id) => delItem('stream', id))}
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <div class="rk-note">This key is empty or no longer exists.</div>
    {/if}
  </div>

  {#if viewState}
    <div
      role="presentation"
      style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:50;padding:var(--px-20)"
    >
      <div
        role="dialog"
        aria-modal="true"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.key === 'Escape' && (viewState = null)}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-720), 100%);max-height:100%;display:flex;flex-direction:column;box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
        <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-10)">
          <span style="font-size:var(--px-14);font-weight:600;color:var(--text)">Value</span>
          <span class="mono" style="font-size:var(--px-11);color:var(--sacc-yellow);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{viewState.label}</span>
          {#if !viewState.isJson}<span style="font-size:var(--px-10_5);color:var(--muted)">(not JSON — raw value)</span>{/if}
          <span style="margin-left:auto;display:flex;gap:var(--px-8)">
            <span onclick={() => viewState && copy(viewState.text)} onkeydown={(e) => e.key === 'Enter' && viewState && copy(viewState.text)} role="button" tabindex="0" class="pv-btn primary">Copy</span>
            <span onclick={() => (viewState = null)} onkeydown={(e) => e.key === 'Enter' && (viewState = null)} role="button" tabindex="0" class="pv-btn">Close</span>
          </span>
        </div>
        <div style="flex:1;min-height:0;display:flex">
          <CodeView
            value={viewState.text}
            language={viewState.isJson ? DS_JSON : 'plaintext'}
            readOnly
            height="auto"
            maxHeight={520}
            minHeight={160}
            ariaLabel="Payload"
          />
        </div>
      </div>
    </div>
  {/if}

  {#if ttlForm}
    <div
      role="presentation"
      style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60"
    >
      <div
        role="dialog"
        aria-modal="true"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => { if (e.key === 'Escape') ttlForm = null; if (e.key === 'Enter') void saveTtl() }}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-380), 92vw);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);display:flex;flex-direction:column;gap:var(--px-10)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">Set TTL</div>
        <div style="font-size:var(--px-11_5);color:var(--muted)">Expiry in seconds for <span class="mono" style="color:var(--text2)">{key}</span>. 0 or empty removes the expiry (PERSIST).</div>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:value={ttlForm.secs}
          placeholder="e.g. 3600 (empty = no expiry)"
          inputmode="numeric"
          autofocus
          class="mono"
          style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-10);font-size:var(--px-12_5);color:var(--text);outline:none"
        />
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span onclick={() => (ttlForm = null)} onkeydown={(e) => e.key === 'Enter' && (ttlForm = null)} role="button" tabindex="0" class="eg-btn">Cancel</span>
          <span onclick={saveTtl} onkeydown={(e) => e.key === 'Enter' && saveTtl()} role="button" tabindex="0" class="eg-btn primary">Save</span>
        </div>
      </div>
    </div>
  {/if}

  {#if confirmDel}
    <div
      role="presentation"
      style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60"
    >
      <div
        role="dialog"
        aria-modal="true"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => { if (e.key === 'Escape') confirmDel = false; if (e.key === 'Enter') void delKey() }}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-420), 92vw);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">Delete key</div>
        <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">Delete key <span class="mono" style="color:var(--text)">{key}</span>? This runs DEL and cannot be undone.</div>
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span use:autofocus onclick={() => (confirmDel = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDel = false)} role="button" tabindex="0" class="eg-btn">Cancel</span>
          <span onclick={delKey} onkeydown={(e) => e.key === 'Enter' && delKey()} role="button" tabindex="0" class="eg-btn danger">Delete</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .rk-head {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--px-6) var(--px-14);
    padding: var(--px-12) var(--px-16);
    border-bottom: var(--px-1) solid var(--border);
    background: var(--surface);
  }
  .rk-title {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    min-width: 0;
  }
  .rk-type {
    flex: none;
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--tc);
    background: color-mix(in srgb, var(--tc) 13%, transparent);
    border-radius: var(--px-10);
    padding: var(--px-2) var(--px-9);
  }
  .rk-name {
    font-size: var(--px-15);
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rk-meta {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--muted);
  }
  .rk-meta .dot {
    opacity: 0.6;
  }
  .rk-meta .warn {
    color: var(--error);
  }
  .rk-btns {
    margin-left: auto;
    display: flex;
    gap: var(--px-7);
  }
  .rk-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
  }
  .rk-del {
    color: var(--error);
  }
  .rk-del:hover {
    border-color: var(--error);
    background: color-mix(in srgb, var(--error) 8%, var(--raised));
  }
  .rk-body {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
  .rk-note {
    padding: var(--px-16);
    font-size: var(--px-12_5);
    color: var(--muted);
  }
  .rk-text {
    flex: 1;
    width: 100%;
    box-sizing: border-box;
    resize: none;
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    padding: var(--px-12);
    font-size: var(--px-12_5);
    line-height: 1.5;
    color: var(--text);
    outline: none;
  }
  .rk-table {
    border-collapse: collapse;
    width: 100%;
    table-layout: fixed;
    background: var(--surface);
  }
  .rk-table th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--header);
    border-bottom: var(--px-1) solid var(--border);
    padding: var(--px-8) var(--px-16);
    text-align: left;
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
  }
  .rk-table th.rk-act-h {
    width: var(--px-100);
  }
  .rk-table td {
    padding: var(--px-8) var(--px-16);
    border-bottom: var(--px-1) solid var(--border);
    font-family: var(--font-mono);
    font-size: var(--px-12_5);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rk-table tbody tr:nth-child(even) {
    background: var(--grid-zebra);
  }
  .rk-table tbody tr:hover {
    background: color-mix(in srgb, var(--primary) 6%, transparent);
  }
  .rk-k {
    color: var(--text);
    font-weight: 500;
  }
  .rk-v {
    color: var(--text2);
  }
  .rk-v.num {
    color: var(--syntax-number);
    font-variant-numeric: tabular-nums;
  }
  .rk-idx {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .rk-table td.rk-act {
    text-align: right;
    overflow: visible;
  }
  .rk-ic {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--px-24);
    height: var(--px-24);
    border-radius: var(--px-6);
    color: var(--muted);
    cursor: pointer;
    opacity: 0.35;
  }
  .rk-table tr:hover .rk-ic,
  .rk-ic:focus-visible {
    opacity: 1;
  }
  .rk-ic:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .rk-ic.danger:hover {
    color: var(--error);
    background: color-mix(in srgb, var(--error) 12%, transparent);
  }
</style>
