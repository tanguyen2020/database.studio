<script lang="ts">
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
  <td style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-4) var(--px-8);white-space:nowrap;text-align:right">
    <span onclick={() => viewJson(label, raw)} onkeydown={(e) => e.key === 'Enter' && viewJson(label, raw)} role="button" tabindex="0" title="View as JSON" style="cursor:pointer;color:var(--muted);margin-right:var(--px-8)">⛶</span>
    <span onclick={() => copy(raw)} onkeydown={(e) => e.key === 'Enter' && copy(raw)} role="button" tabindex="0" title="Copy value" style="cursor:pointer;color:var(--muted)">⧉</span>
    {#if del && id !== undefined}
      <span onclick={() => del(id)} onkeydown={(e) => e.key === 'Enter' && del(id)} role="button" tabindex="0" title="Delete" style="cursor:pointer;color:var(--error);font-size:var(--px-13);margin-left:var(--px-8)">×</span>
    {/if}
  </td>
{/snippet}

{#snippet kvTable(h1: string, h2: string, rows: [string, string][], kind: string, del?: (id: string) => void)}
  <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12_5);table-layout:fixed">
    <thead><tr>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2);font-weight:600;width:var(--px-200)">{h1}</th>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2);font-weight:600">{h2}</th>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);width:var(--px-90)"></th>
    </tr></thead>
    <tbody>
      {#each rows as row, i (i)}
        <tr>
          <td style="padding:var(--px-7) var(--px-14);border-bottom:var(--px-1) solid var(--border);color:var(--sacc-yellow);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={row[0]}>{row[0]}</td>
          <td style="padding:var(--px-7) var(--px-14);border-bottom:var(--px-1) solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={row[1]}>{row[1]}</td>
          {@render actions(row[0], row[1], row[0], del)}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

{#snippet listTable(h1: string, items: string[], kind: string, del?: (id: string) => void)}
  <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12_5);table-layout:fixed">
    <thead><tr>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2);font-weight:600;width:var(--px-60)">{h1}</th>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2);font-weight:600">Value</th>
      <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);width:var(--px-90)"></th>
    </tr></thead>
    <tbody>
      {#each items as item, i (i)}
        <tr>
          <td style="padding:var(--px-7) var(--px-14);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{i}</td>
          <td style="padding:var(--px-7) var(--px-14);border-bottom:var(--px-1) solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={item}>{item}</td>
          {@render actions(String(i), item, item, del)}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<div style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:{accent}"></span>
    <span class="mono" style="font-size:var(--px-13);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{key}</span>
    {#if v}
      <span class="mono" style="flex:none;font-size:var(--px-10);font-weight:700;color:{typeColor(v.key_type)};border:var(--px-1) solid {typeColor(v.key_type)};border-radius:var(--px-4);padding:var(--px-1) var(--px-6)">{v.key_type}</span>
      <span class="mono" style="font-size:var(--px-11);color:var(--muted)">TTL {ttlLabel(v.ttl)}</span>
      {#if mem != null}<span class="mono" style="font-size:var(--px-11);color:var(--muted)" title="MEMORY USAGE">{fmtBytes(mem)}</span>{/if}
    {/if}
    <div style="margin-left:auto;display:flex;gap:var(--px-7)">
      <span onclick={load} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" class="eg-btn">⟳ Refresh</span>
      <span onclick={openTtl} onkeydown={(e) => e.key === 'Enter' && openTtl()} role="button" tabindex="0" class="eg-btn">Set TTL</span>
      <span onclick={() => (confirmDel = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDel = true)} role="button" tabindex="0" class="eg-btn" style="color:var(--error)">Delete</span>
    </div>
  </div>

  <div style="flex:1;overflow:auto;min-height:0">
    {#if loading}
      <div style="padding:var(--px-14);font-size:var(--px-12);color:var(--muted)">Loading…</div>
    {:else if error}
      <div style="padding:var(--px-14);font-size:var(--px-12);color:var(--error)">{error}</div>
    {:else if v?.value.kind === 'string'}
      <div style="padding:var(--px-14);display:flex;flex-direction:column;gap:var(--px-8);height:100%;box-sizing:border-box">
        <div style="flex:none;display:flex;gap:var(--px-8);justify-content:flex-end">
          <span onclick={() => viewJson(key, stringDraft)} onkeydown={(e) => e.key === 'Enter' && viewJson(key, stringDraft)} role="button" tabindex="0" class="eg-btn">⛶ View JSON</span>
          <span onclick={() => copy(stringDraft)} onkeydown={(e) => e.key === 'Enter' && copy(stringDraft)} role="button" tabindex="0" class="eg-btn">⧉ Copy</span>
        </div>
        <textarea
          bind:value={stringDraft}
          class="mono"
          style="flex:1;width:100%;box-sizing:border-box;resize:none;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-10);font-size:var(--px-12_5);color:var(--text);outline:none"
        ></textarea>
        <div style="flex:none;display:flex;justify-content:flex-end">
          <span onclick={() => edit({ op: 'setString', value: stringDraft }, 'SET (saved)')} onkeydown={(e) => e.key === 'Enter' && edit({ op: 'setString', value: stringDraft }, 'SET')} role="button" tabindex="0" style="font-size:var(--px-12);background:var(--primary);color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-6) var(--px-16);cursor:pointer;font-weight:600">Save</span>
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
      <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12);table-layout:fixed">
        <thead><tr>
          <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2);width:var(--px-200)">ID</th>
          <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-14);text-align:left;color:var(--text2)">Fields</th>
          <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);width:var(--px-90)"></th>
        </tr></thead>
        <tbody>
          {#each v.value.entries as e (e.id)}
            {@const fieldsText = e.fields.map((f) => `${f[0]}=${f[1]}`).join('  ')}
            <tr>
              <td style="padding:var(--px-6) var(--px-14);border-bottom:var(--px-1) solid var(--border);color:var(--sacc-orange);white-space:nowrap">{e.id}</td>
              <td style="padding:var(--px-6) var(--px-14);border-bottom:var(--px-1) solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={fieldsText}>{fieldsText}</td>
              {@render actions(e.id, JSON.stringify(Object.fromEntries(e.fields)), e.id, (id) => delItem('stream', id))}
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <div style="padding:var(--px-14);font-size:var(--px-12);color:var(--muted)">(empty / key not found)</div>
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
            <span onclick={() => viewState && copy(viewState.text)} onkeydown={(e) => e.key === 'Enter' && viewState && copy(viewState.text)} role="button" tabindex="0" class="eg-btn">Copy</span>
            <span onclick={() => (viewState = null)} onkeydown={(e) => e.key === 'Enter' && (viewState = null)} role="button" tabindex="0" class="eg-btn">Close</span>
          </span>
        </div>
        <div style="flex:1;min-height:0;display:flex">
          <CodeView
            value={viewState.text}
            language={viewState.isJson ? DS_JSON : 'plaintext'}
            readOnly
            height="100%"
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
  .eg-btn {
    font-size: var(--px-11_5);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-4) var(--px-10);
    cursor: pointer;
  }
  .eg-btn:hover {
    background: var(--hover);
  }
  .eg-btn.primary {
    color: var(--hex-fff);
    background: var(--primary);
    border-color: var(--primary);
    font-weight: 600;
  }
  .eg-btn.danger {
    color: var(--hex-fff);
    background: var(--error);
    border-color: var(--error);
    font-weight: 600;
  }
</style>
