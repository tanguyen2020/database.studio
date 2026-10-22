<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  // Redis key details — the side panel of the Redis Browser workspace
  // (SPEC-REDIS-BROWSER.md X1: a key never gets a tab of its own). Shows the value per
  // type with View JSON + Copy on each value; a Text value is edited in place, every
  // collection item (hash field, list item, set / sorted-set member) can be edited or
  // removed one at a time; plus Rename, Set expiry and Delete for the key.
  import * as ipc from '$lib/ipc'
  import PayloadDialog from '$lib/components/viewer/PayloadDialog.svelte'
  import PayloadPreview from '$lib/components/viewer/PayloadPreview.svelte'
  import { systemMeta } from '$lib/systems'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import type { Snippet } from 'svelte'
  import { expirySentence, itemNoun as itemWords, typeHelp, typeLabel } from '$lib/stream/redis-keys'
  import { draftOf, itemDeleteOp, itemEditable, itemEditText, planItemEdit, type ItemDraft, type ItemRef } from '$lib/redis/item-edit'

  interface Props {
    connId: string
    keyName: string
    /** called after the key was deleted */
    onDeleted?: (key: string) => void
    /** close the panel */
    onClose?: () => void
    /** called after RENAME succeeded (shows the Rename button) */
    onRenamed?: (from: string, to: string) => void
    /** extra content under the header (e.g. an Advanced block with the encoding) */
    extra?: Snippet
  }
  let { connId, keyName, onDeleted, onClose, onRenamed, extra }: Props = $props()
  const cid = $derived(connId)
  const key = $derived(keyName)
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
  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  async function load() {
    if (!cid || !key) return
    loading = true
    error = null
    mem = null
    try {
      value = await ipc.redisGet(cid, key)
      if (value.value.kind === 'string') stringDraft = value.value.value
      mem = await ipc.redisMemoryUsage(cid, key).catch(() => null)
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }
  $effect(() => {
    void cid
    void key
    void load()
  })

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Copied')
  }

  // JSON viewer popup — pretty-prints the value (falls back to raw text when it isn't
  // valid JSON) with syntax coloring so large payloads (e.g. cache blobs) are readable.
  let viewState = $state<{ label: string; raw: string } | null>(null)
  function viewJson(label: string, raw: string) {
    viewState = { label, raw }
  }

  /** What a successful edit says, in plain words. */
  const PLAIN_EDIT: Record<string, string> = {
    setString: 'Value saved',
    hDel: 'Field removed',
    sRem: 'Member removed',
    zRem: 'Member removed',
    lDelAt: 'Item removed',
    xDel: 'Entry removed',
    hReplace: 'Field saved',
    lSetAt: 'Item saved',
    sReplace: 'Member saved',
    zReplace: 'Member saved',
  }

  async function edit(op: ipc.RedisEditOp): Promise<boolean> {
    if (!cid || !key) return false
    try {
      await ipc.redisEdit(cid, key, op)
      toasts.success(PLAIN_EDIT[op.op] ?? 'Saved')
      await load()
      explorer.bumpRedis(cid)
      return true
    } catch (e) {
      toasts.error(`Edit failed: ${e}`)
      return false
    }
  }

  /** Remove exactly this one item (a list item by its position). */
  function delItem(ref: ItemRef) {
    void edit(itemDeleteOp(ref))
  }

  // Edit one item (form dialog — the backdrop does not close it, rule for forms).
  let itemForm = $state<{ ref: ItemRef; draft: ItemDraft; busy: boolean; error: string | null } | null>(null)
  const itemText = $derived(itemForm ? itemEditText(itemForm.ref) : null)
  function openItem(ref: ItemRef) {
    itemForm = { ref, draft: draftOf(ref), busy: false, error: null }
  }
  async function saveItem() {
    if (!itemForm || itemForm.busy || !cid || !key) return
    const plan = planItemEdit(itemForm.ref, itemForm.draft)
    if ('error' in plan) {
      itemForm.error = plan.error
      return
    }
    itemForm.busy = true
    itemForm.error = null
    try {
      await ipc.redisEdit(cid, key, plan.op)
      itemForm = null
      toasts.success(PLAIN_EDIT[plan.op.op] ?? 'Saved')
      await load()
      explorer.bumpRedis(cid)
    } catch (e) {
      if (itemForm) {
        itemForm.error = String(e)
        itemForm.busy = false
      }
    }
  }
  function formatItemJson() {
    if (!itemForm) return
    try {
      itemForm.draft.value = JSON.stringify(JSON.parse(itemForm.draft.value), null, 2)
    } catch {
      itemForm.error = 'The value is not valid JSON.'
    }
  }

  // Set TTL form (in-app modal — window.prompt isn't reliable in the Tauri webview).
  let ttlForm = $state<{ secs: string } | null>(null)
  function openTtl() {
    const cur = value?.ttl ?? -1
    ttlForm = { secs: cur > 0 ? String(cur) : '' }
  }
  async function saveTtl() {
    if (!cid || !key || !ttlForm) return
    const secs = parseInt(ttlForm.secs, 10) || 0
    ttlForm = null
    try {
      await ipc.redisSetTtl(cid, key, secs)
      toasts.success(secs > 0 ? `${key} now ${expirySentence(secs).toLowerCase()}` : `${key} no longer expires`)
      await load()
      explorer.bumpRedis(cid)
    } catch (e) {
      toasts.error(`Set TTL failed: ${e}`)
    }
  }

  // Delete key — in-app confirm; on delete, refresh the sidebar key list and close.
  let confirmDel = $state(false)
  async function delKey() {
    confirmDel = false
    if (!cid || !key) return
    try {
      await ipc.redisDel(cid, key)
      toasts.success(`Deleted "${key}"`)
      explorer.bumpRedis(cid)
      onDeleted?.(key)
    } catch (e) {
      toasts.error(`DEL failed: ${e}`)
    }
  }

  // Rename. RENAMENX never overwrites an
  // existing key: if the new name is taken Redis answers 0 and nothing changes.
  let renameForm = $state<{ to: string; busy: boolean; error: string | null } | null>(null)
  function openRename() {
    renameForm = { to: key, busy: false, error: null }
  }
  async function saveRename() {
    if (!renameForm || !cid || !key) return
    const to = renameForm.to.trim()
    if (!to || to === key) {
      renameForm.error = !to ? 'Type the new name.' : 'The name did not change.'
      return
    }
    renameForm.busy = true
    renameForm.error = null
    try {
      const out = await ipc.redisCommand(cid, ['RENAMENX', key, to])
      if (/\(integer\) 0$/.test(out.trim())) {
        renameForm.error = `A key named “${to}” already exists. Pick another name, or delete that key first.`
        return
      }
      const from = key
      renameForm = null
      toasts.success(`Renamed to “${to}”`)
      explorer.bumpRedis(cid)
      onRenamed?.(from, to)
    } catch (e) {
      if (renameForm) renameForm.error = String(e)
    } finally {
      if (renameForm) renameForm.busy = false
    }
  }
  const TTL_PRESETS: [string, number][] = [
    ['1 minute', 60],
    ['1 hour', 3600],
    ['1 day', 86400],
    ['1 week', 604800],
    ['Never', 0],
  ]
</script>

{#snippet actions(label: string, raw: string, ref?: ItemRef)}
  <!-- row actions: quiet until the row is hovered, delete turns red only on hover -->
  <td class="rk-act">
    <span class="rk-ic" onclick={() => viewJson(label, raw)} onkeydown={(e) => e.key === 'Enter' && viewJson(label, raw)} role="button" tabindex="0" title="View as JSON"><Icon name="expand" size={13} /></span>
    <span class="rk-ic" onclick={() => copy(raw)} onkeydown={(e) => e.key === 'Enter' && copy(raw)} role="button" tabindex="0" title="Copy value"><Icon name="copy" size={13} /></span>
    {#if ref && itemEditable(ref.kind)}
      <span class="rk-ic" onclick={() => openItem(ref)} onkeydown={(e) => e.key === 'Enter' && openItem(ref)} role="button" tabindex="0" title="Edit this item"><Icon name="edit" size={13} /></span>
    {/if}
    {#if ref}
      <span class="rk-ic danger" onclick={() => delItem(ref)} onkeydown={(e) => e.key === 'Enter' && delItem(ref)} role="button" tabindex="0" title="Delete this item"><Icon name="trash" size={13} /></span>
    {/if}
  </td>
{/snippet}

{#snippet kvTable(h1: string, h2: string, rows: [string, string][], kind: 'hash' | 'zset')}
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
          <td class="rk-v" class:num={kind === 'zset'} title={row[1]}>{#if kind === 'zset'}{row[1]}{:else}<PayloadPreview text={row[1]} />{/if}</td>
          {@render actions(row[0], row[1], kind === 'zset' ? { kind, name: row[0], value: row[0], score: Number(row[1]) } : { kind, name: row[0], value: row[1] })}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

{#snippet listTable(h1: string, items: string[], kind: 'list' | 'set')}
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
          <td class="rk-v" title={item}><PayloadPreview text={item} /></td>
          {@render actions(String(i), item, kind === 'list' ? { kind, index: i, value: item } : { kind, name: item, value: item })}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

<div style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative;background:var(--bg)">
    <!-- header: plain words (rule U1/U4) -->
    <div class="rk-head rk-panel">
      <div class="rk-title rk-title-row">
        {#if v}<span class="rk-type" style="--tc:{typeColor(v.key_type)}" title={typeHelp(v.key_type)}>{typeLabel(v.key_type)}</span>{/if}
        <span class="rk-name mono" title={key}>{key}</span>
        {#if onClose}<button type="button" class="rk-close" onclick={onClose} aria-label="Close details" title="Close details">×</button>{/if}
      </div>
      {#if v}
        <div class="rk-meta">
          <span class:warn={v.ttl === -2}>{expirySentence(v.ttl)}</span>
          {#if itemCount != null}<span class="dot">·</span><span>{itemWords(v.key_type, itemCount)}</span>{/if}
          {#if mem != null}<span class="dot">·</span><span title="Memory this key uses on the server">{fmtBytes(mem)}</span>{/if}
        </div>
      {/if}
      <div class="rk-btns rk-btns-panel">
        <button type="button" class="cfm-btn rk-btn" onclick={load} disabled={loading} title="Read the key again from Redis"><Icon name="refresh" size={12} />Refresh</button>
        {#if onRenamed}<button type="button" class="cfm-btn" onclick={openRename} disabled={!v || v.key_type === 'none'}>Rename…</button>{/if}
        <button type="button" class="cfm-btn" onclick={openTtl} disabled={!v || v.key_type === 'none'} title="Set when Redis deletes this key automatically">Set expiry…</button>
        <button type="button" class="cfm-btn ds-danger-outline" onclick={() => (confirmDel = true)} disabled={!v || v.key_type === 'none'}>Delete…</button>
      </div>
      {@render extra?.()}
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
          <span onclick={() => edit({ op: 'setString', value: stringDraft })} onkeydown={(e) => e.key === 'Enter' && edit({ op: 'setString', value: stringDraft })} role="button" tabindex="0" class="cfm-btn primary">Save</span>
        </div>
      </div>
    {:else if v?.value.kind === 'hash'}
      {@render kvTable('Field', 'Value', v.value.fields.map((f) => [f[0], f[1]]), 'hash')}
    {:else if v?.value.kind === 'zset'}
      {@render kvTable('Member', 'Score', v.value.members.map((m) => [m[0], String(m[1])]), 'zset')}
    {:else if v?.value.kind === 'list'}
      {@render listTable('#', v.value.items, 'list')}
    {:else if v?.value.kind === 'set'}
      {@render listTable('#', v.value.members, 'set')}
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
              {@render actions(e.id, JSON.stringify(Object.fromEntries(e.fields)), { kind: 'stream', name: e.id, value: fieldsText })}
            </tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <div class="rk-note">This key is empty or no longer exists.</div>
    {/if}
  </div>

  {#if viewState}
    <PayloadDialog
      title="Value"
      system="redis"
      subtitle={`Redis ${(value?.key_type ?? 'key').toLowerCase()} · ${key}`}
      facts={[
        { label: 'Key', value: key ?? '', mono: true },
        ...(viewState.label && viewState.label !== key ? [{ label: 'Item', value: viewState.label, mono: true }] : []),
        ...(value?.key_type ? [{ label: 'Type', value: value.key_type }] : []),
      ]}
      text={viewState.raw}
      onClose={() => (viewState = null)}
    />
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
          <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">Set expiry</div>
          <div style="font-size:var(--px-12);color:var(--text2);line-height:1.45">Redis deletes <span class="mono" style="color:var(--text)">{key}</span> automatically after this time. Leave it empty to keep the key forever.</div>
          <div class="rk-presets" role="group" aria-label="Common expiry times">
            {#each TTL_PRESETS as [label, secs] (label)}
              <button type="button" class="rk-preset" aria-pressed={ttlForm.secs === (secs ? String(secs) : '')} onclick={() => ttlForm && (ttlForm.secs = secs ? String(secs) : '')}>{label}</button>
            {/each}
          </div>
          <span style="font-size:var(--px-11_5);color:var(--muted)">Seconds{ttlForm.secs && Number(ttlForm.secs) > 0 ? ` — ${expirySentence(Number(ttlForm.secs)).toLowerCase()}` : ''}</span>
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
        onkeydown={(e) => { if (e.key === 'Escape') confirmDel = false; if (e.key === 'Enter' && confirmDel && e.target === e.currentTarget) void delKey() }}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-420), 92vw);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
          <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">Delete this key</div>
          <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">Delete <span class="mono" style="color:var(--text)">{key}</span>{#if v && itemCount != null} and its {itemWords(v.key_type, itemCount)}{/if}? Apps that read this key will no longer find it. This cannot be undone.</div>
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span use:autofocus onclick={() => (confirmDel = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDel = false)} role="button" tabindex="0" class="eg-btn">Cancel</span>
          <span onclick={delKey} onkeydown={(e) => e.key === 'Enter' && delKey()} role="button" tabindex="0" class="eg-btn danger">Delete key</span>
        </div>
      </div>
    </div>
  {/if}

  {#if itemForm && itemText}
    <div role="presentation" style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60">
      <div
        class="rk-item-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={itemText.title}
        tabindex="-1"
        onkeydown={(e) => {
          if (e.key === 'Escape' && !itemForm?.busy) itemForm = null
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void saveItem()
        }}
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">{itemText.title}</div>
        <div style="font-size:var(--px-12);color:var(--text2);line-height:1.45">
          {#if itemForm.ref.kind === 'hash'}Change the value, or the field name to rename it.{:else if itemForm.ref.kind === 'list'}Replaces the item at position {itemForm.ref.index}. The other items keep their place.{:else if itemForm.ref.kind === 'set'}Replaces the member. A set never holds the same member twice.{:else}Change the member or its score — the list is ordered by score.{/if}
          Saved straight to <span class="mono" style="color:var(--text)">{key}</span>.
        </div>
        {#if itemText.nameLabel}
          <label class="rk-item-field">
            {itemText.nameLabel}
            <input class="mono ds-control" use:autofocus bind:value={itemForm.draft.name} spellcheck="false" onkeydown={(e) => e.key === 'Enter' && void saveItem()} />
          </label>
        {/if}
        {#if itemText.scoreLabel}
          <label class="rk-item-field">
            {itemText.scoreLabel}
            <input class="mono ds-control" bind:value={itemForm.draft.score} inputmode="decimal" spellcheck="false" onkeydown={(e) => e.key === 'Enter' && void saveItem()} />
          </label>
        {/if}
        {#if itemText.valueLabel}
          <label class="rk-item-field">
            <span class="rk-item-label">{itemText.valueLabel}<button type="button" class="rk-item-fmt" onclick={formatItemJson} title="Pretty-print the value as JSON">Format JSON</button></span>
            {#if itemText.nameLabel}
              <textarea class="mono rk-text rk-item-text" bind:value={itemForm.draft.value} spellcheck="false"></textarea>
            {:else}
              <textarea class="mono rk-text rk-item-text" use:autofocus bind:value={itemForm.draft.value} spellcheck="false"></textarea>
            {/if}
          </label>
        {/if}
        {#if itemForm.error}<div class="rk-err" role="alert">{itemForm.error}</div>{/if}
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end;align-items:center">
          <span style="margin-right:auto;font-size:var(--px-11_5);color:var(--muted)">Ctrl+Enter saves</span>
          <button type="button" class="cfm-btn" onclick={() => (itemForm = null)} disabled={itemForm.busy}>Cancel</button>
          <button type="button" class="cfm-btn primary" onclick={saveItem} disabled={itemForm.busy}>{itemForm.busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if renameForm}
    <!-- stream-workspace:redis — Rename (form dialog: backdrop does not close it) -->
    <div role="presentation" style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Rename key"
        tabindex="-1"
        onkeydown={(e) => { if (e.key === 'Escape' && !renameForm?.busy) renameForm = null }}
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-420), 92vw);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);display:flex;flex-direction:column;gap:var(--px-10)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">Rename key</div>
        <div style="font-size:var(--px-12);color:var(--text2);line-height:1.45">The value and expiry stay the same. Apps that still use <span class="mono" style="color:var(--text)">{key}</span> will no longer find it.</div>
        <label style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-12);color:var(--text2)">
          New name
          <input
            class="mono ds-control"
            use:autofocus
            bind:value={renameForm.to}
            spellcheck="false"
            onkeydown={(e) => e.key === 'Enter' && void saveRename()}
          />
        </label>
        {#if renameForm.error}<div class="rk-err" role="alert">{renameForm.error}</div>{/if}
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <button type="button" class="cfm-btn" onclick={() => (renameForm = null)} disabled={renameForm.busy}>Cancel</button>
          <button type="button" class="cfm-btn primary" onclick={saveRename} disabled={renameForm.busy}>{renameForm.busy ? 'Renaming…' : 'Rename'}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .rk-item-dlg {
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-14);
    padding: var(--px-18);
    width: min(var(--px-520), 92vw);
    box-shadow: 0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
  }
  .rk-item-field {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .rk-item-label {
    display: flex;
    align-items: center;
  }
  .rk-item-fmt {
    margin-left: auto;
    border: 0;
    background: transparent;
    color: var(--primary);
    font-size: var(--px-11_5);
    cursor: pointer;
  }
  .rk-item-text {
    min-height: var(--px-140);
    max-height: 50vh;
  }
  /* stream-workspace:redis — embedded side-panel bits */
  .rk-panel {
    flex-direction: column;
    align-items: stretch;
    gap: var(--px-8);
  }
  .rk-title-row {
    width: 100%;
  }
  .rk-title-row .rk-name {
    flex: 1;
    min-width: 0;
    font-size: var(--px-14);
  }
  .rk-close {
    flex: none;
    border: 0;
    background: transparent;
    font-size: var(--px-18);
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    padding: var(--px-2) var(--px-6);
    border-radius: var(--px-6);
  }
  .rk-close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .rk-btns-panel {
    margin-left: 0;
    flex-wrap: wrap;
  }
  .rk-btns-panel :global(.cfm-btn) {
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
  }
  .rk-presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-6);
  }
  .rk-preset {
    border: var(--px-1) solid var(--border2);
    background: var(--raised);
    color: var(--text2);
    border-radius: var(--px-12);
    padding: var(--px-3) var(--px-10);
    font-family: var(--font-main);
    font-size: var(--px-12);
    cursor: pointer;
  }
  .rk-preset:hover {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border2));
  }
  .rk-preset[aria-pressed='true'] {
    border-color: var(--primary);
    color: var(--text);
    background: color-mix(in srgb, var(--primary) 12%, var(--raised));
  }
  .rk-err {
    padding: var(--px-8) var(--px-10);
    border-radius: var(--px-8);
    background: var(--danger-soft);
    color: var(--danger-text);
    font-size: var(--px-12);
  }
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
    display: inline-flex;
    align-items: center;
    gap: var(--px-5);
    font-size: var(--px-11);
    font-weight: 500;
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    padding: var(--px-2) var(--px-9);
  }
  .rk-type::before {
    content: '';
    width: var(--px-6);
    height: var(--px-6);
    border-radius: 50%;
    background: var(--tc);
    flex: none;
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
    /* view · copy · edit · delete */
    width: var(--px-140);
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
    padding-right: var(--px-10);
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
