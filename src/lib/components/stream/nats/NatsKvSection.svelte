<script lang="ts">
  // stream-workspace:nats — Key-value buckets of a NATS connection
  // (SPEC-NATS-WORKSPACE.md §1, §3b). Bucket list → keys (value · version · updated)
  // → one key: its value with "Save as new version", every earlier version the bucket
  // still keeps (Updated · Deleted · Cleared), and a live "Watch for changes".
  // Everything shown comes from the server; nothing is invented (rule 3).
  import { onDestroy, untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import StreamTable, { type StreamColumn } from '../StreamTable.svelte'
  import SplitDetail from '../SplitDetail.svelte'
  import HelpTip from '../HelpTip.svelte'
  import AdvancedToggle from '../AdvancedToggle.svelte'
  import Icon from '$lib/components/Icon.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'
  import { compactCount, exactUtc, formatBytes, fullCount, humanDuration, plural, relativeTime } from '$lib/stream/humanize'
  import {
    applyChange,
    bucketRows,
    bucketWords,
    changeLabel,
    deleteBucketText,
    historyRows,
    keyRows,
    prettyValue,
    preview,
    purgeKeyText,
    validBucket,
    validKey,
    type BucketRow,
    type KeyRow,
  } from '$lib/stream/nats-workspace'

  interface Props {
    connId: string
    /** used to make the watch session id unique per tab */
    tabId: string
    buckets: ipc.NatsKvStatus[]
    loading: boolean
    error: string | null
    persistence: boolean | null
    focus: string | null
    keyFocus: string | null
    onSelect: (bucket: string | null) => void
    onSelectKey: (key: string | null) => void
    onReload: () => Promise<void> | void
  }
  let { connId, tabId, buckets, loading, error, persistence, focus, keyFocus, onSelect, onSelectKey, onReload }: Props = $props()

  const rows = $derived(bucketRows(buckets))
  const bucket = $derived(focus ? buckets.find((b) => b.bucket === focus) ?? null : null)

  const cols: StreamColumn<BucketRow>[] = [
    { key: 'bucket', label: 'Bucket', sort: (r) => r.bucket },
    { key: 'keys', label: 'Keys', align: 'right', width: 'var(--px-90)', sort: (r) => r.keys, help: 'Distinct keys in the bucket, deleted ones included until their marker is gone.' },
    { key: 'history', label: 'Versions kept', align: 'right', width: 'var(--px-120)', sort: (r) => r.history, help: 'How many earlier values the bucket keeps for each key.' },
    { key: 'expire', label: 'Keys expire after', width: 'var(--px-140)', sort: (r) => r.status.max_age_ms || Number.MAX_SAFE_INTEGER },
    { key: 'storage', label: 'Storage', width: 'var(--px-180)', sort: (r) => r.storage },
    { key: 'size', label: 'Size', align: 'right', width: 'var(--px-100)', sort: (r) => r.bytes },
  ]

  // ---- keys of the focused bucket ----
  let keys = $state<KeyRow[]>([])
  let keysTruncated = $state(false)
  let keysLoading = $state(false)
  let keysError = $state<string | null>(null)
  let showDeleted = $state(true)
  let keysGen = 0

  async function loadKeys(name: string) {
    const gen = ++keysGen
    keysLoading = true
    keysError = null
    try {
      const r = await ipc.natsKvEntries(connId, name, 2000)
      if (gen !== keysGen) return
      keys = keyRows(r.entries)
      keysTruncated = r.truncated
    } catch (e) {
      if (gen === keysGen) keysError = String(e)
    } finally {
      if (gen === keysGen) keysLoading = false
    }
  }

  $effect(() => {
    const name = focus
    untrack(() => {
      stopWatch()
      keys = []
      if (name) void loadKeys(name)
    })
  })

  const shownKeys = $derived(showDeleted ? keys : keys.filter((k) => !k.deleted))
  const deletedCount = $derived(keys.filter((k) => k.deleted).length)
  const keyCols: StreamColumn<KeyRow>[] = [
    { key: 'key', label: 'Key', sort: (r) => r.key },
    { key: 'value', label: 'Value', sort: (r) => r.value },
    { key: 'version', label: 'Version', align: 'right', width: 'var(--px-90)', sort: (r) => r.revision, help: 'Each change of a key gets a new, higher version number.' },
    { key: 'updated', label: 'Updated', align: 'right', width: 'var(--px-110)', sort: (r) => Date.parse(r.created) || 0 },
  ]

  // ---- one key ----
  const keyRow = $derived(keyFocus ? keys.find((k) => k.key === keyFocus) ?? null : null)
  let history = $state<ipc.NatsKvEntry[]>([])
  let historyLoading = $state(false)
  let historyError = $state<string | null>(null)
  let draft = $state('')
  let draftFrom = $state<number | null>(null)
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  let histGen = 0
  const versions = $derived(historyRows(history))

  async function loadHistory(name: string, key: string, resetDraft = true) {
    const gen = ++histGen
    historyLoading = true
    historyError = null
    try {
      const h = await ipc.natsKvHistory(connId, name, key)
      if (gen !== histGen) return
      history = h
      if (resetDraft) {
        const cur = [...h].sort((a, b) => b.revision - a.revision)[0]
        draft = cur && cur.operation === 'put' ? prettyValue(cur.value) : ''
        draftFrom = cur?.revision ?? null
        saveError = null
      }
    } catch (e) {
      if (gen === histGen) historyError = String(e)
    } finally {
      if (gen === histGen) historyLoading = false
    }
  }

  $effect(() => {
    const name = focus
    const key = keyFocus
    untrack(() => {
      history = []
      draft = ''
      draftFrom = null
      if (name && key) void loadHistory(name, key)
    })
  })

  const current = $derived(versions[0] ?? null)
  const currentValue = $derived(current && !current.marker ? prettyValue(current.value) : '')
  const dirty = $derived(!!current && (current.marker ? draft.length > 0 : draft !== currentValue))

  async function saveVersion() {
    if (!focus || !keyFocus || saving) return
    saving = true
    saveError = null
    const name = focus
    const key = keyFocus
    try {
      const rev = await ipc.natsKvPutVersion(connId, name, key, draft)
      toasts.success(`Saved ${key} as version #${rev}`)
      await loadHistory(name, key)
      await loadKeys(name)
      await onReload()
    } catch (e) {
      saveError = String(e)
    } finally {
      saving = false
    }
  }

  // ---- watch for changes ----
  let watching = $state(false)
  let watchStarting = $state(false)
  let watchNote = $state<string | null>(null)
  let changes = $state<{ entry: ipc.NatsKvEntry; at: number }[]>([])
  let unlisten: (() => void) | null = null
  let watchSession: string | null = null

  async function startWatch() {
    if (!focus || watchStarting) return
    const name = focus
    watchStarting = true
    watchNote = null
    const session = `${tabId}:kv:${name}:${Date.now()}`
    try {
      unlisten = await ipc.onNatsKvWatch(
        session,
        (e) => onChange(name, e),
        (s) => {
          watching = false
          watchNote = s.state === 'error' ? s.message : `Stopped watching: ${s.message}`
        },
      )
      await ipc.natsKvWatch(connId, session, name, '>')
      watchSession = session
      watching = true
      changes = []
    } catch (e) {
      unlisten?.()
      unlisten = null
      watchNote = `Could not watch this bucket: ${String(e)}`
    } finally {
      watchStarting = false
    }
  }

  function stopWatch() {
    unlisten?.()
    unlisten = null
    if (watchSession) void ipc.natsKvUnwatch(watchSession).catch(() => {})
    watchSession = null
    watching = false
  }

  function onChange(name: string, e: ipc.NatsKvEntry) {
    if (name !== focus) return
    changes = [{ entry: e, at: Date.now() }, ...changes].slice(0, 25)
    keys = applyChange(keys, e)
    if (keyFocus === e.key) {
      // a newer version of the key on screen: refresh its history, keep an unsaved edit
      void loadHistory(name, e.key, !dirty)
    }
  }

  onDestroy(stopWatch)

  // ---- dialogs ----
  let createOpen = $state(false)
  let cName = $state('')
  let cDesc = $state('')
  let cHistory = $state(5)
  let cExpire = $state<'never' | '1h' | '1d' | '7d' | '30d' | 'custom'>('never')
  let cExpireMins = $state(60)
  let cStorage = $state<'file' | 'memory'>('file')
  let cMaxMb = $state<number | null>(null)
  let cReplicas = $state(1)
  let cBusy = $state(false)
  let cError = $state<string | null>(null)
  const EXPIRE_SECS: Record<string, number> = { never: 0, '1h': 3600, '1d': 86400, '7d': 7 * 86400, '30d': 30 * 86400 }
  const cExpireSecs = $derived(cExpire === 'custom' ? Math.max(1, Math.round(cExpireMins)) * 60 : EXPIRE_SECS[cExpire])
  const cNameError = $derived(cName ? validBucket(cName.trim()) ?? (buckets.some((b) => b.bucket === cName.trim()) ? 'A bucket with this name already exists.' : null) : null)
  const cSummary = $derived(
    `Keeps ${plural(Math.min(64, Math.max(1, cHistory)), 'version')} per key · keys ${cExpireSecs ? `expire after ${humanDuration(cExpireSecs * 1000)}` : 'never expire'} · ${cStorage === 'memory' ? 'stored in memory' : 'stored on disk'} · ${plural(cReplicas, 'copy', 'copies')}${cMaxMb ? ` · up to ${formatBytes(cMaxMb * 1024 * 1024)}` : ''}`,
  )

  function openCreate() {
    cName = ''
    cDesc = ''
    cHistory = 5
    cExpire = 'never'
    cExpireMins = 60
    cStorage = 'file'
    cMaxMb = null
    cReplicas = 1
    cError = null
    createOpen = true
  }

  async function createBucket() {
    const name = cName.trim()
    if (!name || cNameError || cBusy) return
    cBusy = true
    cError = null
    try {
      await ipc.natsKvCreateBucket(connId, {
        bucket: name,
        description: cDesc.trim() || undefined,
        history: Math.min(64, Math.max(1, Math.round(cHistory))),
        max_age_secs: cExpireSecs,
        storage: cStorage,
        max_bytes: cMaxMb ? Math.round(cMaxMb * 1024 * 1024) : 0,
        replicas: cReplicas,
      })
      toasts.success(`Created key-value bucket ${name}`)
      createOpen = false
      await onReload()
      onSelect(name)
    } catch (e) {
      cError = String(e)
    } finally {
      cBusy = false
    }
  }

  let addOpen = $state(false)
  let aKey = $state('')
  let aValue = $state('')
  let aBusy = $state(false)
  let aError = $state<string | null>(null)
  const aKeyError = $derived(aKey ? validKey(aKey.trim()) : null)
  const aExists = $derived(!!aKey.trim() && keys.some((k) => k.key === aKey.trim() && !k.deleted))

  async function addKey() {
    if (!focus || !aKey.trim() || aKeyError || aBusy) return
    aBusy = true
    aError = null
    const name = focus
    const key = aKey.trim()
    try {
      const rev = await ipc.natsKvPutVersion(connId, name, key, aValue)
      toasts.success(`Saved ${key} (version #${rev})`)
      addOpen = false
      await loadKeys(name)
      await onReload()
      onSelectKey(key)
    } catch (e) {
      aError = String(e)
    } finally {
      aBusy = false
    }
  }

  type Confirm = { kind: 'bucket' | 'key' | 'purge'; title: string; body: string; button: string }
  let confirm = $state<Confirm | null>(null)
  let confirmBusy = $state(false)
  let confirmError = $state<string | null>(null)

  function askDeleteBucket() {
    if (!bucket) return
    confirmError = null
    confirm = { kind: 'bucket', title: 'Delete key-value bucket', body: deleteBucketText(bucket), button: `Delete bucket ${bucket.bucket}` }
  }
  function askDeleteKey() {
    if (!keyFocus) return
    confirmError = null
    confirm = {
      kind: 'key',
      title: 'Delete key',
      body: `Readers will see ${keyFocus} as deleted. Its earlier versions stay in the history (up to ${plural(Math.max(1, bucket?.history ?? 1), 'version')}) until newer changes replace them.`,
      button: 'Delete key',
    }
  }
  function askPurge() {
    if (!keyFocus) return
    confirmError = null
    const n = history.length
    confirm = { kind: 'purge', title: 'Clear history', body: purgeKeyText(keyFocus, n), button: n > 1 ? `Clear ${fullCount(n)} versions` : 'Clear history' }
  }

  async function runConfirm() {
    if (!confirm || !focus || confirmBusy) return
    confirmBusy = true
    confirmError = null
    const name = focus
    try {
      if (confirm.kind === 'bucket') {
        stopWatch()
        await ipc.natsKvDeleteBucket(connId, name)
        toasts.success(`Deleted key-value bucket ${name}`)
        confirm = null
        onSelect(null)
        await onReload()
      } else if (keyFocus) {
        const key = keyFocus
        if (confirm.kind === 'key') await ipc.natsKvDelete(connId, name, key)
        else await ipc.natsKvPurge(connId, name, key)
        toasts.success(confirm.kind === 'key' ? `Deleted ${key}` : `Cleared the history of ${key}`)
        confirm = null
        await loadHistory(name, key)
        await loadKeys(name)
        await onReload()
      }
    } catch (e) {
      confirmError = String(e)
    } finally {
      confirmBusy = false
    }
  }

  function when(iso: string): string {
    const t = Date.parse(iso)
    return Number.isFinite(t) ? relativeTime(t) : '—'
  }
  function whenExact(iso: string): string {
    const t = Date.parse(iso)
    return Number.isFinite(t) ? exactUtc(t) : ''
  }
</script>

{#if persistence === false}
  <div class="ds-empty nk-off">
    <b>Key-value buckets need persistence (JetStream)</b>
    JetStream is not enabled for this account, so the server cannot keep keys. Enable it on the server (start nats-server with -js), then refresh.
  </div>
{:else}
  <SplitDetail storeKey="nats-kv" open={!!bucket}>
    {#snippet list()}
      <StreamTable
        {rows}
        columns={cols}
        rowKey={(r) => r.bucket}
        ariaLabel="Key-value buckets"
        selected={focus}
        onSelect={(r) => onSelect(r.bucket)}
        onOpen={(r) => onSelect(r.bucket)}
        filterText={(r) => r.bucket}
        filterPlaceholder="Filter buckets…"
        initialSort={{ key: 'bucket', dir: 'asc' }}
        {loading}
        {error}
        emptyTitle="No key-value buckets yet"
        emptyBody="A bucket stores keys with their values, and can keep earlier versions of each key."
        emptyActionLabel="+ Create bucket"
        onEmptyAction={openCreate}
      >
        {#snippet tools()}
          <button type="button" class="cfm-btn primary nk-tool" onclick={openCreate}>+ Create bucket</button>
        {/snippet}
        {#snippet cell(r, c)}
          {#if c.key === 'bucket'}<span class="ds-name">{r.bucket}</span>
          {:else if c.key === 'keys'}<span class="ds-num" title={fullCount(r.keys)}>{compactCount(r.keys)}</span>
          {:else if c.key === 'history'}<span class="ds-num">{r.history}</span>
          {:else if c.key === 'expire'}<span class:nk-dim={r.expire === 'Never'}>{r.expire}</span>
          {:else if c.key === 'storage'}<span class="nk-dim">{r.storage}</span>
          {:else if c.key === 'size'}<span class="ds-num nk-num">{formatBytes(r.bytes)}</span>
          {/if}
        {/snippet}
      </StreamTable>
    {/snippet}
    {#snippet detail()}
      {#if bucket}
        <div class="nk-detail">
          <div class="nk-head">
            {#if keyRow || keyFocus}
              <button type="button" class="nk-back" onclick={() => onSelectKey(null)}>← All keys</button>
            {/if}
            <span class="nk-title mono">{keyFocus ? keyFocus : bucket.bucket}</span>
            <button type="button" class="nk-close" onclick={() => onSelect(null)} aria-label="Close details" title="Close details">×</button>
          </div>

          {#if !keyFocus}
            {#if bucket.description}<p class="nk-desc">{bucket.description}</p>{/if}
            <dl class="nk-facts">
              {#each bucketWords(bucket) as w (w.label)}
                <div><dt>{w.label}{#if w.help} <HelpTip text={w.help} />{/if}</dt><dd>{w.value}</dd></div>
              {/each}
            </dl>
            <div class="nk-actions">
              <button type="button" class="cfm-btn primary" onclick={() => { aKey = ''; aValue = ''; aError = null; addOpen = true }}>+ Add key</button>
              <button
                type="button"
                class="cfm-btn nk-watch"
                class:on={watching}
                aria-pressed={watching}
                disabled={watchStarting}
                onclick={() => (watching ? stopWatch() : startWatch())}
                title="Show every change to this bucket as it happens"
              >
                <span class="nk-dot" class:live={watching} aria-hidden="true"></span>
                {watching ? 'Watching for changes' : watchStarting ? 'Starting…' : 'Watch for changes'}
              </button>
              <span class="nk-flex"></span>
              <button type="button" class="cfm-btn ds-danger-outline" onclick={askDeleteBucket}>Delete bucket…</button>
            </div>
            {#if watchNote}<div class="nk-note" role="status">{watchNote}</div>{/if}
            {#if watching}
              <section class="nk-feed" aria-label="Recent changes">
                <div class="ds-section-title">Recent changes <span class="nk-live">● Live</span></div>
                {#if changes.length === 0}
                  <div class="nk-feed-empty">Waiting for the next change… Changes made by any application appear here.</div>
                {:else}
                  <ul>
                    {#each changes as c (c.entry.revision)}
                      <li>
                        <span class="nk-chg {c.entry.operation === 'put' ? 'ok' : 'warn'}">{changeLabel(c.entry.operation)}</span>
                        <button type="button" class="nk-link ds-name" onclick={() => onSelectKey(c.entry.key)}>{c.entry.key}</button>
                        <span class="nk-dim">version #{c.entry.revision}</span>
                        <span class="nk-flex"></span>
                        <span class="nk-dim" title={whenExact(c.entry.created)}>{when(c.entry.created)}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </section>
            {/if}
            <div class="nk-keys">
              <StreamTable
                rows={shownKeys}
                columns={keyCols}
                rowKey={(r) => r.key}
                ariaLabel="Keys"
                selected={keyFocus}
                onSelect={(r) => onSelectKey(r.key)}
                onOpen={(r) => onSelectKey(r.key)}
                filterText={(r) => r.key}
                filterPlaceholder="Filter keys…"
                initialSort={{ key: 'key', dir: 'asc' }}
                loading={keysLoading}
                error={keysError}
                emptyTitle="No keys yet"
                emptyBody="Add a key to store a value in this bucket."
                emptyActionLabel="+ Add key"
                onEmptyAction={() => { aKey = ''; aValue = ''; aError = null; addOpen = true }}
                note={keysTruncated ? 'Showing the first 2,000 keys. Use the filter to find others.' : null}
              >
                {#snippet tools()}
                  {#if deletedCount}
                    <label class="nk-check"><input type="checkbox" bind:checked={showDeleted} /> Show deleted keys ({deletedCount})</label>
                  {/if}
                {/snippet}
                {#snippet cell(r, c)}
                  {#if c.key === 'key'}<span class="ds-name" class:nk-deleted={r.deleted}>{r.key}</span>
                  {:else if c.key === 'value'}
                    {#if r.deleted}<span class="nk-chg warn">{changeLabel(r.op)}</span>{:else}<span class="mono nk-val">{preview(r.value)}</span>{/if}
                  {:else if c.key === 'version'}<span class="ds-num">#{r.revision}</span>
                  {:else if c.key === 'updated'}<span class="nk-dim" title={whenExact(r.created)}>{when(r.created)}</span>
                  {/if}
                {/snippet}
              </StreamTable>
            </div>
          {:else}
            <!-- one key -->
            <div class="nk-facts-line">
              <span class="ds-chip">in {bucket.bucket}</span>
              {#if current}
                <span class="ds-chip" class:warn={current.marker} class:live={!current.marker}>{current.marker ? `${current.label} · version #${current.revision}` : `Version #${current.revision}`}</span>
                <span class="ds-chip" title={whenExact(current.created)}>Updated {when(current.created)}</span>
              {/if}
              {#if watching}<span class="ds-chip live">Watching for changes</span>{/if}
            </div>
            {#if historyError}
              <div class="nk-error" role="alert">Could not read this key: {historyError}</div>
            {:else if historyLoading && history.length === 0}
              <div class="ds-empty" aria-busy="true">Reading the key…</div>
            {:else if history.length === 0}
              <div class="ds-empty"><b>This key has no value</b>It was never written, or its history was cleared and the marker expired.</div>
            {:else}
              <label class="um-field nk-editor">
                <span>{current?.marker ? 'Value (the key is deleted — saving brings it back)' : 'Value'}</span>
                <textarea class="um-input mono nk-textarea" bind:value={draft} spellcheck="false" aria-label="Value"></textarea>
              </label>
              {#if saveError}<div class="nk-error" role="alert">{saveError}</div>{/if}
              <div class="nk-actions">
                <button type="button" class="cfm-btn primary" onclick={saveVersion} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save as new version'}</button>
                {#if dirty}<button type="button" class="cfm-btn" onclick={() => (draft = currentValue)}>Undo changes</button>{/if}
                <span class="nk-flex"></span>
                {#if current && !current.marker}
                  <button type="button" class="cfm-btn ds-danger-outline" onclick={askDeleteKey}>Delete key…</button>
                {/if}
                <button type="button" class="cfm-btn ds-danger-outline" onclick={askPurge}>Clear history…</button>
              </div>
              <div class="ds-section-title">Versions <HelpTip text={`The bucket keeps up to ${plural(Math.max(1, bucket.history), 'version')} of each key. Older ones are dropped as new changes arrive.`} /></div>
              <table class="ds-table nk-versions" aria-label="Versions">
                <thead><tr><th>Version</th><th>Change</th><th>When</th><th>Value</th><th></th></tr></thead>
                <tbody>
                  {#each versions as v (v.revision)}
                    <tr class:nk-current={v.current}>
                      <td class="ds-num">#{v.revision}{#if v.current} <span class="nk-cur">Current</span>{/if}</td>
                      <td><span class="nk-chg {v.tone}">{v.label}</span></td>
                      <td class="nk-dim" title={whenExact(v.created)}>{when(v.created)}</td>
                      <td class="mono nk-val">{v.marker ? '—' : preview(v.value, 60)}</td>
                      <td class="nk-r">
                        {#if !v.marker && !v.current}
                          <button type="button" class="nk-link" onclick={() => (draft = prettyValue(v.value))} title="Put this value in the editor; save it to make it the current version">Use this value</button>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              <AdvancedToggle label="Raw">
                <table class="ds-table nk-versions">
                  <thead><tr><th>Revision</th><th>Operation</th><th>Created (UTC)</th><th class="nk-r">Bytes</th></tr></thead>
                  <tbody>
                    {#each history as h (h.revision)}
                      <tr><td class="mono">{h.revision}</td><td class="mono">{h.operation.toUpperCase()}</td><td class="mono">{h.created}</td><td class="nk-r ds-num">{h.size}</td></tr>
                    {/each}
                  </tbody>
                </table>
              </AdvancedToggle>
            {/if}
          {/if}
        </div>
      {/if}
    {/snippet}
  </SplitDetail>
{/if}

{#if createOpen}
  <!-- form dialog: the backdrop does not close it (rule: forms close only by a button / Escape) -->
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !cBusy && (createOpen = false)}>
    <div class="um-dlg" role="dialog" aria-modal="true" aria-label="Create key-value bucket" tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon plain"><Icon name="database" size={18} /></span>
        <div class="um-dlg-title"><b>Create key-value bucket</b><span>Stores keys with their values, and can keep earlier versions of each key.</span></div>
      </div>
      <div class="um-dlg-body nk-form">
        <label class="um-field">
          <span>Name</span>
          <input class="um-input mono" class:invalid={!!cNameError} bind:value={cName} use:autofocus placeholder="e.g. config" spellcheck="false" aria-label="Bucket name" />
          {#if cNameError}<span class="um-field-err">{cNameError}</span>{:else}<span class="um-field-hint">Letters, digits, - and _.</span>{/if}
        </label>
        <label class="um-field">
          <span>Description <span class="nk-dim">(optional)</span></span>
          <input class="um-input" bind:value={cDesc} placeholder="What this bucket holds" aria-label="Description" />
        </label>
        <div class="um-row2">
          <label class="um-field">
            <span>Versions kept per key <HelpTip text="1 keeps only the current value. Up to 64 earlier values can be kept." /></span>
            <input class="um-input" type="number" min="1" max="64" bind:value={cHistory} aria-label="Versions kept per key" />
          </label>
          <label class="um-field">
            <span>Keys expire after</span>
            <select class="um-select" bind:value={cExpire} aria-label="Keys expire after">
              <option value="never">Never</option>
              <option value="1h">1 hour</option>
              <option value="1d">1 day</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
              <option value="custom">Custom…</option>
            </select>
            {#if cExpire === 'custom'}
              <input class="um-input" type="number" min="1" bind:value={cExpireMins} aria-label="Expire after minutes" />
              <span class="um-field-hint">Minutes</span>
            {/if}
          </label>
        </div>
        <div class="um-row2">
          <div class="um-field">
            <span>Storage</span>
            <div class="um-seg" role="group" aria-label="Storage">
              <span role="button" tabindex="0" aria-pressed={cStorage === 'file'} onclick={() => (cStorage = 'file')} onkeydown={(e) => e.key === 'Enter' && (cStorage = 'file')}>On disk</span>
              <span role="button" tabindex="0" aria-pressed={cStorage === 'memory'} onclick={() => (cStorage = 'memory')} onkeydown={(e) => e.key === 'Enter' && (cStorage = 'memory')}>In memory</span>
            </div>
            <span class="um-field-hint">{cStorage === 'memory' ? 'Faster, but lost when the server restarts.' : 'Survives server restarts.'}</span>
          </div>
          <label class="um-field">
            <span>Copies <HelpTip text="How many servers of a cluster keep the bucket. A single server can only keep 1." /></span>
            <select class="um-select" bind:value={cReplicas} aria-label="Copies">
              <option value={1}>1 copy</option>
              <option value={3}>3 copies</option>
              <option value={5}>5 copies</option>
            </select>
          </label>
        </div>
        <label class="um-field">
          <span>Largest total size <span class="nk-dim">(MB, optional)</span></span>
          <input class="um-input" type="number" min="1" bind:value={cMaxMb} placeholder="No limit" aria-label="Largest total size in MB" />
        </label>
        <p class="nk-summary">{cSummary}</p>
        {#if cError}<div class="nk-error" role="alert">{cError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="nk-flex"></span>
        <button type="button" class="cfm-btn" onclick={() => (createOpen = false)} disabled={cBusy}>Cancel</button>
        <button type="button" class="cfm-btn primary" onclick={createBucket} disabled={!cName.trim() || !!cNameError || cBusy}>{cBusy ? 'Creating…' : 'Create bucket'}</button>
      </div>
    </div>
  </div>
{/if}

{#if addOpen && bucket}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !aBusy && (addOpen = false)}>
    <div class="um-dlg" role="dialog" aria-modal="true" aria-label="Add key" tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon plain"><Icon name="key" size={18} /></span>
        <div class="um-dlg-title"><b>Add key</b><span class="mono">{bucket.bucket}</span></div>
      </div>
      <div class="um-dlg-body nk-form">
        <label class="um-field">
          <span>Key</span>
          <input class="um-input mono" class:invalid={!!aKeyError} bind:value={aKey} use:autofocus placeholder="e.g. feature.flags" spellcheck="false" aria-label="Key" />
          {#if aKeyError}<span class="um-field-err">{aKeyError}</span>{:else if aExists}<span class="um-field-hint">This key already exists — saving creates a new version of it.</span>{/if}
        </label>
        <label class="um-field">
          <span>Value</span>
          <textarea class="um-input mono nk-textarea sm" bind:value={aValue} spellcheck="false" aria-label="New value"></textarea>
        </label>
        {#if aError}<div class="nk-error" role="alert">{aError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="nk-flex"></span>
        <button type="button" class="cfm-btn" onclick={() => (addOpen = false)} disabled={aBusy}>Cancel</button>
        <button type="button" class="cfm-btn primary" onclick={addKey} disabled={!aKey.trim() || !!aKeyError || aBusy}>{aBusy ? 'Saving…' : aExists ? 'Save as new version' : 'Add key'}</button>
      </div>
    </div>
  </div>
{/if}

{#if confirm}
  <div class="um-backdrop" role="presentation" onkeydown={(e) => e.key === 'Escape' && !confirmBusy && (confirm = null)}>
    <div class="um-dlg sm" role="alertdialog" aria-modal="true" aria-label={confirm.title} tabindex="-1">
      <div class="um-dlg-head">
        <span class="um-dlg-icon danger"><Icon name="trash" size={18} /></span>
        <div class="um-dlg-title"><b>{confirm.title}</b><span class="mono">{confirm.kind === 'bucket' ? focus : keyFocus}</span></div>
      </div>
      <div class="um-dlg-body">
        <p class="nk-confirm">{confirm.body}</p>
        {#if confirmError}<div class="nk-error" role="alert">{confirmError}</div>{/if}
      </div>
      <div class="um-dlg-foot">
        <span class="nk-flex"></span>
        <button type="button" class="cfm-btn" use:autofocus onclick={() => (confirm = null)} disabled={confirmBusy}>Cancel</button>
        <button type="button" class="cfm-btn danger" onclick={runConfirm} disabled={confirmBusy}>{confirmBusy ? 'Working…' : confirm.button}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .nk-off {
    margin: var(--px-18);
  }
  .nk-tool {
    margin-left: auto;
  }
  .nk-deleted {
    color: var(--muted);
    text-decoration: line-through;
  }
  .nk-dim {
    color: var(--muted);
  }
  .nk-num {
    color: var(--tbl-cell);
  }
  .nk-val {
    color: var(--text2);
    font-size: var(--px-12);
  }
  .nk-detail {
    padding: var(--px-14) var(--px-18) var(--px-18);
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
    min-height: 0;
    flex: 1;
  }
  .nk-head {
    display: flex;
    align-items: center;
    gap: var(--px-10);
  }
  .nk-title {
    flex: 1;
    min-width: 0;
    font-size: var(--px-15);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nk-back,
  .nk-link {
    border: 0;
    background: transparent;
    padding: var(--px-2) var(--px-4);
    font-family: var(--font-main);
    font-size: var(--px-12_5);
    font-weight: 500;
    color: var(--primary);
    cursor: pointer;
    border-radius: var(--px-5);
  }
  .nk-link.ds-name {
    padding: 0;
    color: var(--text);
  }
  .nk-back:hover,
  .nk-link:hover {
    text-decoration: underline;
  }
  .nk-close {
    border: 0;
    background: transparent;
    font-size: var(--px-18);
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    padding: var(--px-2) var(--px-6);
    border-radius: var(--px-6);
  }
  .nk-close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .nk-desc {
    margin: 0;
    color: var(--text2);
    font-size: var(--px-12_5);
  }
  .nk-facts {
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--px-180), 1fr));
    gap: var(--px-10) var(--px-18);
  }
  .nk-facts dt {
    font-size: var(--px-11_5);
    color: var(--muted);
    font-weight: 500;
  }
  .nk-facts dd {
    margin: var(--px-2) 0 0;
    font-size: var(--px-13);
    color: var(--text);
    font-weight: 500;
  }
  .nk-facts-line,
  .nk-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-8);
  }
  .nk-flex {
    flex: 1;
  }
  .nk-watch {
    display: inline-flex;
    align-items: center;
    gap: var(--px-7);
  }
  .nk-watch.on {
    border-color: color-mix(in srgb, var(--sacc-green) 55%, var(--border2));
    color: var(--sacc-green);
    font-weight: 600;
  }
  .nk-dot {
    width: var(--px-8);
    height: var(--px-8);
    border-radius: 50%;
    background: var(--muted);
    opacity: 0.6;
  }
  .nk-dot.live {
    background: var(--sacc-green);
    opacity: 1;
    animation: nk-pulse 1.4s ease-in-out infinite;
  }
  @keyframes nk-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .nk-dot.live {
      animation: none;
    }
  }
  .nk-live {
    color: var(--sacc-green);
    font-size: var(--px-11);
    font-weight: 600;
    margin-left: var(--px-6);
  }
  .nk-note {
    font-size: var(--px-12);
    color: var(--sacc-amber);
  }
  .nk-feed {
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    background: var(--surface);
    padding: var(--px-8) var(--px-12);
  }
  .nk-feed ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: var(--px-180);
    overflow: auto;
  }
  .nk-feed li {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-4) 0;
    font-size: var(--px-12_5);
    border-top: var(--px-1) solid var(--border);
  }
  .nk-feed li:first-child {
    border-top: 0;
  }
  .nk-feed-empty {
    font-size: var(--px-12);
    color: var(--muted);
    padding: var(--px-4) 0;
  }
  .nk-chg {
    font-size: var(--px-11_5);
    font-weight: 600;
    padding: 0 var(--px-7);
    border-radius: var(--px-9);
  }
  .nk-chg.ok {
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--sacc-green) 12%, transparent);
  }
  .nk-chg.warn {
    color: var(--sacc-amber);
    background: color-mix(in srgb, var(--sacc-amber) 14%, transparent);
  }
  .nk-keys {
    flex: 1;
    min-height: var(--px-300);
    display: flex;
    flex-direction: column;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
    overflow: hidden;
    background: var(--surface);
  }
  .nk-check {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .nk-editor {
    gap: var(--px-6);
  }
  .nk-textarea {
    min-height: var(--px-160);
    resize: vertical;
    line-height: 1.5;
    font-size: var(--px-12_5);
  }
  .nk-textarea.sm {
    min-height: var(--px-100);
  }
  .nk-versions td,
  .nk-versions th {
    white-space: nowrap;
  }
  .nk-versions .nk-val {
    white-space: normal;
  }
  .nk-r {
    text-align: right;
  }
  .nk-current td {
    font-weight: 500;
  }
  .nk-cur {
    font-size: var(--px-11);
    font-weight: 600;
    color: var(--primary);
    margin-left: var(--px-4);
  }
  .nk-error {
    padding: var(--px-10) var(--px-12);
    border-radius: var(--px-8);
    background: var(--danger-soft);
    color: var(--danger-text);
    font-size: var(--px-12_5);
  }
  .nk-form {
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
  }
  .nk-summary {
    margin: 0;
    padding: var(--px-8) var(--px-10);
    border-radius: var(--px-8);
    background: var(--panel);
    color: var(--text2);
    font-size: var(--px-12);
  }
  .nk-confirm {
    margin: 0;
    line-height: 1.5;
    color: var(--text2);
  }
</style>
