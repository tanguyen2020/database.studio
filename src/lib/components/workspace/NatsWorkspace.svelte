<script lang="ts">
  // NATS Core workspace — port 1:1 từ Database Studio.dc.html dòng 767-789:
  // header (Subscribe subject + live toggle + Publish/Request) · message stream
  // (ts · subject · payload) · footer publish/request. Message real-time qua Tauri
  // event "nats-msg" (task nền). Ngoài Tauri (demo) form render, stream chỉ chạy thật.
  import { onDestroy, onMount } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  let info = $state<ipc.NatsInfo | null>(null)
  let subject = $state('orders.>')
  let subscribed = $state(false)
  let paused = $state(false)
  let messages = $state<{ ts: string; subject: string; payload: string }[]>([])
  let unlisten: (() => void) | null = null

  // publish + request
  let pubSubject = $state('')
  let pubMsg = $state('')
  let reqSubject = $state('')
  let reqMsg = $state('')
  let reqReply = $state<string | null>(null)

  // panel: '' = monitor (subscribe), 'js' = JetStream, 'kv' = KV, 'obj' = Object
  let panel = $state<'' | 'js' | 'kv' | 'obj'>('')
  // JetStream button ref — focused on mount (task: double-click NATS connection).
  let jsBtn = $state<HTMLElement | null>(null)
  function captureJs(node: HTMLElement, isJs: boolean) {
    if (isJs) jsBtn = node
  }
  const jsMode = $derived(panel === 'js')
  let jsStreams = $state<ipc.NatsJsStream[]>([])
  let jsSel = $state<string | null>(null)
  let jsConsumers = $state<ipc.NatsJsConsumer[]>([])
  let peekSeq = $state(1)
  let peekResult = $state<ipc.NatsJsMessage | null>(null)
  let jsError = $state<string | null>(null)

  // KV Store (T9)
  let kvBuckets = $state<string[]>([])
  let kvSel = $state<string | null>(null)
  let kvKeys = $state<string[]>([])
  let kvValue = $state<{ key: string; value: string } | null>(null)
  // Object Store (T9)
  let objBuckets = $state<string[]>([])
  let objSel = $state<string | null>(null)
  let objList = $state<ipc.NatsObjInfo[]>([])

  function now(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  onMount(async () => {
    // Open the JetStream panel (and focus its button) when the NATS tab opens
    // via double-click on the connection, so streams show immediately.
    void setPanel('js')
    requestAnimationFrame(() => jsBtn?.focus())
    if (!tab.connectionId) return
    info = await ipc.natsInfo(tab.connectionId).catch(() => null)
    if (!IS_TAURI) return
    const { listen } = await import('@tauri-apps/api/event')
    unlisten = await listen<ipc.NatsMsg>('nats-msg', (e) => {
      if (e.payload.conn_id !== tab.connectionId || paused) return
      messages = [{ ts: now(), subject: e.payload.subject, payload: e.payload.payload }, ...messages].slice(0, 1000)
    })
  })

  onDestroy(() => {
    unlisten?.()
    if (subscribed && tab.connectionId) void ipc.natsUnsubscribe(tab.connectionId)
  })

  async function toggle() {
    if (!tab.connectionId) return
    if (subscribed) {
      await ipc.natsUnsubscribe(tab.connectionId).catch(() => {})
      subscribed = false
      return
    }
    if (!subject.trim()) return
    try {
      await ipc.natsSubscribe(tab.connectionId, subject.trim())
      subscribed = true
      if (!IS_TAURI) toasts.show('Streaming only works in the Tauri app (not the browser demo)')
    } catch (e) {
      toasts.error(`Subscribe failed: ${e}`)
    }
  }

  async function publish() {
    if (!tab.connectionId || !pubSubject.trim()) return
    try {
      await ipc.natsPublish(tab.connectionId, pubSubject.trim(), pubMsg)
      toasts.success(`Published → ${pubSubject.trim()}`)
      pubMsg = ''
    } catch (e) {
      toasts.error(`Publish failed: ${e}`)
    }
  }

  async function request() {
    if (!tab.connectionId || !reqSubject.trim()) return
    reqReply = null
    try {
      reqReply = await ipc.natsRequest(tab.connectionId, reqSubject.trim(), reqMsg, 3000)
    } catch (e) {
      reqReply = null
      toasts.error(`Request failed: ${e}`)
    }
  }

  async function setPanel(p: '' | 'js' | 'kv' | 'obj') {
    panel = panel === p ? '' : p
    if (panel === 'js' && jsStreams.length === 0) await loadStreams()
    if (panel === 'kv') await loadKv()
    if (panel === 'obj') await loadObj()
  }

  // ---- KV Store (T9) ----
  async function loadKv() {
    if (!tab.connectionId) return
    kvBuckets = await ipc.natsKvBuckets(tab.connectionId).catch(() => [])
  }
  async function selKvBucket(b: string) {
    if (!tab.connectionId) return
    kvSel = b
    kvValue = null
    kvKeys = await ipc.natsKvKeys(tab.connectionId, b).catch(() => [])
  }
  async function kvGet(key: string) {
    if (!tab.connectionId || !kvSel) return
    const v = await ipc.natsKvGet(tab.connectionId, kvSel, key).catch(() => null)
    kvValue = { key, value: v ?? '(null)' }
  }
  async function kvPutNew() {
    if (!tab.connectionId || !kvSel) return
    const key = window.prompt('Key:')
    if (!key) return
    const value = window.prompt(`Value cho "${key}":`) ?? ''
    try {
      await ipc.natsKvPut(tab.connectionId, kvSel, key, value)
      toasts.success(`PUT ${key}`)
      await selKvBucket(kvSel)
    } catch (e) {
      toasts.error(`KV put failed: ${e}`)
    }
  }
  async function kvDelKey(key: string) {
    if (!tab.connectionId || !kvSel) return
    await ipc.natsKvDelete(tab.connectionId, kvSel, key).catch((e) => toasts.error(`${e}`))
    await selKvBucket(kvSel)
  }
  async function kvNewBucket() {
    if (!tab.connectionId) return
    const b = window.prompt('KV bucket name:')
    if (!b) return
    await ipc.natsKvCreate(tab.connectionId, b).then(() => loadKv()).catch((e) => toasts.error(`${e}`))
  }

  // ---- Object Store (T9) ----
  async function loadObj() {
    if (!tab.connectionId) return
    objBuckets = await ipc.natsObjBuckets(tab.connectionId).catch(() => [])
  }
  async function selObjBucket(b: string) {
    if (!tab.connectionId) return
    objSel = b
    objList = await ipc.natsObjList(tab.connectionId, b).catch(() => [])
  }
  async function objNewBucket() {
    if (!tab.connectionId) return
    const b = window.prompt('Object bucket name:')
    if (!b) return
    await ipc.natsObjCreate(tab.connectionId, b).then(() => loadObj()).catch((e) => toasts.error(`${e}`))
  }
  async function objUpload() {
    if (!tab.connectionId || !objSel) return
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({ multiple: false })
    if (typeof path !== 'string') return
    const name = path.split(/[\\/]/).pop() ?? 'object'
    try {
      await ipc.natsObjPutFile(tab.connectionId, objSel, name, path)
      toasts.success(`Uploaded ${name}`)
      await selObjBucket(objSel)
    } catch (e) {
      toasts.error(`Upload failed: ${e}`)
    }
  }
  async function objDownload(name: string) {
    if (!tab.connectionId || !objSel) return
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: name })
    if (typeof path !== 'string') return
    await ipc.natsObjGetFile(tab.connectionId, objSel, name, path).then(() => toasts.success('Downloaded')).catch((e) => toasts.error(`${e}`))
  }
  async function objDel(name: string) {
    if (!tab.connectionId || !objSel) return
    await ipc.natsObjDelete(tab.connectionId, objSel, name).catch((e) => toasts.error(`${e}`))
    await selObjBucket(objSel)
  }

  async function loadStreams() {
    if (!tab.connectionId) return
    jsError = null
    try {
      jsStreams = await ipc.natsJsStreams(tab.connectionId)
    } catch (e) {
      jsError = String(e)
    }
  }

  async function selectStream(name: string) {
    if (!tab.connectionId) return
    jsSel = name
    peekResult = null
    try {
      jsConsumers = await ipc.natsJsConsumers(tab.connectionId, name)
    } catch (e) {
      jsError = String(e)
    }
  }

  /** The consumer name is what you paste into a CLI next — one click copies it. */
  async function copyConsumer(name: string) {
    await navigator.clipboard.writeText(name)
    toasts.success('Copied ' + name, 'nats')
  }

  async function peek() {
    if (!tab.connectionId || !jsSel) return
    try {
      peekResult = await ipc.natsJsPeek(tab.connectionId, jsSel, peekSeq)
    } catch (e) {
      toasts.error(`Peek failed: ${e}`)
    }
  }
</script>

<div class="ds-ws">
  <!-- header: the server, then which part of it you are looking at -->
  <div class="ds-ws-head">
    <span class="ds-ws-icon" style="background:color-mix(in srgb, var(--sacc-green) 12%, transparent)" aria-hidden="true">
      <img src="/assets/db-nats.svg" width="20" height="20" alt="" style="display:block" />
    </span>
    <div class="ds-ws-titles">
      <span class="ds-ws-title">{panel === 'js' ? 'JetStream' : panel === 'kv' ? 'Key-Value store' : panel === 'obj' ? 'Object store' : 'Core messaging'}</span>
      <span class="ds-ws-sub">{#if info}NATS {info.version} · {info.server_name}{:else}NATS{/if}</span>
    </div>
    <div class="ds-ws-actions">
      <div class="ds-seg" role="group" aria-label="View">
        {#each [['js', 'JetStream'], ['kv', 'KV'], ['obj', 'Object']] as [p, label] (p)}
          <span use:captureJs={p === 'js'} onclick={() => setPanel(p as '' | 'js' | 'kv' | 'obj')} onkeydown={(e) => e.key === 'Enter' && setPanel(p as '' | 'js' | 'kv' | 'obj')} role="button" tabindex="0" aria-pressed={panel === p}>{label}</span>
        {/each}
      </div>
    </div>
  </div>

  <!-- live subscription: subject + state + controls -->
  <div class="ds-toolbar">
    <label class="ds-field">Subject
      <input bind:value={subject} class="ds-control mono" style="min-width:var(--px-200)" aria-label="Subscribe subject" />
    </label>
    <span class="ds-chip" class:live={subscribed && !paused} class:warn={subscribed && paused}>{subscribed ? (paused ? 'Paused' : 'LIVE') : 'idle'}</span>
    <span style="margin-left:auto;display:flex;gap:var(--px-8)">
      <span onclick={toggle} onkeydown={(e) => e.key === 'Enter' && toggle()} role="button" tabindex="0" class="cfm-btn" class:primary={!subscribed} title={subscribed ? 'Stop listening' : 'Listen to messages on this subject'}>{subscribed ? 'Stop' : 'Subscribe'}</span>
      <span onclick={() => (paused = !paused)} onkeydown={(e) => e.key === 'Enter' && (paused = !paused)} role="button" tabindex="0" class="cfm-btn">{paused ? 'Resume' : 'Pause'}</span>
      <span onclick={() => (messages = [])} onkeydown={(e) => e.key === 'Enter' && (messages = [])} role="button" tabindex="0" class="cfm-btn" title="Clear the message view">Clear</span>
    </span>
  </div>

  {#if jsMode}
    <!-- JetStream panel (T10): streams → consumers + peek by seq -->
    <div class="ds-body">
      {#if jsError}
        <div class="ds-chip bad" style="height:auto;padding:var(--px-8) var(--px-12);border-radius:var(--px-8);white-space:normal">{jsError}</div>
      {/if}
      <section class="ds-section">
        <div class="ds-section-title">Streams <span class="ds-count">{jsStreams.length}</span></div>
        <table class="ds-table">
          <thead><tr>
            {#each ['Stream', 'Subjects', 'Retention', 'Storage', 'Messages', 'Consumers'] as h (h)}
              <th>{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each jsStreams as s (s.name)}
              <tr class="js-row" class:sel={jsSel === s.name} onclick={() => selectStream(s.name)} onkeydown={(e) => e.key === 'Enter' && selectStream(s.name)} role="button" tabindex="0" style="cursor:pointer">
                <td style="color:var(--sacc-green);font-weight:600">{s.name}</td>
                <td class="mono" style="color:var(--tbl-subject);font-size:var(--px-12)">{s.subjects.join(', ')}</td>
                <td style="color:var(--text2)">{s.retention}</td>
                <td style="color:var(--text2)">{s.storage}</td>
                <td style="color:var(--syntax-number);font-variant-numeric:tabular-nums">{s.messages.toLocaleString()}</td>
                <td style="color:var(--syntax-number);font-variant-numeric:tabular-nums">{s.consumers}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>

      {#if jsSel}
        <section class="ds-section">
          <div class="ds-section-title">Consumers <span style="color:var(--muted);font-weight:500">of {jsSel}</span> <span class="ds-count">{jsConsumers.length}</span></div>
          <table class="ds-table">
            <thead><tr>
              {#each ['Consumer', 'Deliver', 'Ack', 'Filter', 'Pending'] as h (h)}
                <th>{h}</th>
              {/each}
            </tr></thead>
            <tbody>
              {#each jsConsumers as c (c.name)}
                {@const pending = Number(c.num_pending ?? 0)}
                <tr class="js-row">
                  <!-- the identifier stays a link: hover underlines, focus is visible,
                       and clicking copies the name (what you do with it next) -->
                  <td>
                    <span
                      class="tbl-link"
                      onclick={() => copyConsumer(c.name)}
                      onkeydown={(e) => e.key === 'Enter' && copyConsumer(c.name)}
                      role="button"
                      tabindex="0"
                      title="Copy consumer name"
                    >{c.name}</span>
                  </td>
                  <!-- enum/meta columns: grey, so they do not compete with the data -->
                  <td style="color:var(--tbl-meta)">{c.deliver_policy}</td>
                  <td style="color:var(--tbl-meta)">{c.ack_policy}</td>
                  <!-- subject value: warm monospace tone; "—" stays quiet -->
                  <td class="mono" style="font-size:var(--px-12);color:{c.filter_subject ? 'var(--tbl-subject)' : 'var(--tbl-quiet)'}">{c.filter_subject || '—'}</td>
                  <!-- pending MEANS something: 0 is quiet, a backlog is not -->
                  <td
                    style="font-variant-numeric:tabular-nums;color:{pending > 0 ? 'var(--tbl-alert)' : 'var(--tbl-quiet)'};font-weight:{pending > 0 ? 600 : 400}"
                    title={pending > 0 ? pending + ' message(s) waiting to be acked' : 'nothing pending'}
                  >{c.num_pending}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>

        <section class="ds-section">
          <div class="ds-section-title">Peek a message</div>
          <div style="display:flex;align-items:center;gap:var(--px-8)">
            <label class="ds-field">Sequence
              <input type="number" bind:value={peekSeq} class="ds-control ds-num" style="width:var(--px-110)" aria-label="Peek seq" />
            </label>
            <span onclick={peek} onkeydown={(e) => e.key === 'Enter' && peek()} role="button" tabindex="0" class="cfm-btn">Peek</span>
          </div>
          {#if peekResult}
            <div style="font-size:var(--px-12);background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-10);padding:var(--px-10) var(--px-12)">
              <div style="color:var(--muted)">#{peekResult.seq} · <span class="mono" style="color:var(--tbl-subject);font-weight:600">{peekResult.subject}</span> · {peekResult.time}</div>
              <div class="mono" style="color:var(--text2);white-space:pre-wrap;word-break:break-word;margin-top:var(--px-6)">{peekResult.payload}</div>
            </div>
          {/if}
        </section>
      {/if}
    </div>
  {:else if panel === 'kv'}
    <!-- KV Store (T9) -->
    <div style="flex:1;display:flex;min-height:0">
      <div class="nw-side">
        <div class="nw-side-head"><span>Buckets</span><span onclick={kvNewBucket} onkeydown={(e) => e.key === 'Enter' && kvNewBucket()} role="button" tabindex="0" class="nw-add" title="New bucket">＋</span></div>
        {#each kvBuckets as b (b)}
          <div onclick={() => selKvBucket(b)} onkeydown={(e) => e.key === 'Enter' && selKvBucket(b)} role="button" tabindex="0" class="nw-item" class:on={kvSel === b}>{b}</div>
        {/each}
      </div>
      <div class="ds-body">
        {#if kvSel}
          <div class="ds-section-title">{kvSel} <span class="ds-count">{kvKeys.length}</span><span onclick={kvPutNew} onkeydown={(e) => e.key === 'Enter' && kvPutNew()} role="button" tabindex="0" class="cfm-btn" style="margin-left:auto">＋ Key</span></div>
          <table class="ds-table">
            <thead><tr><th>Key</th><th style="width:1%"></th></tr></thead>
            <tbody>
              {#each kvKeys as k (k)}
                <tr>
                  <td class="mono" style="font-size:var(--px-12)"><span onclick={() => kvGet(k)} onkeydown={(e) => e.key === 'Enter' && kvGet(k)} role="button" tabindex="0" style="cursor:pointer;color:var(--text)">{k}</span></td>
                  <td><span onclick={() => kvDelKey(k)} onkeydown={(e) => e.key === 'Enter' && kvDelKey(k)} role="button" tabindex="0" class="ds-act" title="Delete key">×</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if kvValue}
            <pre class="selectable mono" style="margin:0;background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-10);padding:var(--px-10) var(--px-12);font-size:var(--px-12);white-space:pre-wrap;word-break:break-word">{kvValue.key} = {kvValue.value}</pre>
          {/if}
        {:else}
          <div class="ds-empty"><b>Pick a bucket</b>Select a bucket on the left to see its keys.</div>
        {/if}
      </div>
    </div>
  {:else if panel === 'obj'}
    <!-- Object Store (T9) -->
    <div style="flex:1;display:flex;min-height:0">
      <div class="nw-side">
        <div class="nw-side-head"><span>Buckets</span><span onclick={objNewBucket} onkeydown={(e) => e.key === 'Enter' && objNewBucket()} role="button" tabindex="0" class="nw-add" title="New bucket">＋</span></div>
        {#each objBuckets as b (b)}
          <div onclick={() => selObjBucket(b)} onkeydown={(e) => e.key === 'Enter' && selObjBucket(b)} role="button" tabindex="0" class="nw-item" class:on={objSel === b}>{b}</div>
        {/each}
      </div>
      <div class="ds-body">
        {#if objSel}
          <div class="ds-section-title">{objSel} <span class="ds-count">{objList.length}</span><span onclick={objUpload} onkeydown={(e) => e.key === 'Enter' && objUpload()} role="button" tabindex="0" class="cfm-btn" style="margin-left:auto">⬆ Upload</span></div>
          <table class="ds-table">
            <thead><tr>{#each ['Name', 'Size', 'Chunks', ''] as h (h)}<th>{h}</th>{/each}</tr></thead>
            <tbody>
              {#each objList as o (o.name)}
                <tr>
                  <td style="color:var(--text)">{o.name}</td>
                  <td style="color:var(--text2);font-variant-numeric:tabular-nums">{o.size.toLocaleString()} B</td>
                  <td style="color:var(--text2);font-variant-numeric:tabular-nums">{o.chunks}</td>
                  <td style="white-space:nowrap;width:1%"><span onclick={() => objDownload(o.name)} onkeydown={(e) => e.key === 'Enter' && objDownload(o.name)} role="button" tabindex="0" class="ds-act" title="Download">⬇</span><span onclick={() => objDel(o.name)} onkeydown={(e) => e.key === 'Enter' && objDel(o.name)} role="button" tabindex="0" class="ds-act" title="Delete object">×</span></td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <div class="ds-empty"><b>Pick a bucket</b>Select a bucket on the left to see its objects.</div>
        {/if}
      </div>
    </div>
  {:else}
  <!-- message stream — dòng 782-789 -->
  <div style="flex:1;overflow:auto;min-height:0;background:var(--surface)">
    {#if messages.length === 0}
      <div class="ds-empty">
        {subscribed ? 'Waiting for messages…' : 'Enter a subject (e.g. orders.>) then Subscribe.'}
      </div>
    {:else}
      {#each messages as m, i (i)}
        <div class="nw-msg">
          <span class="ds-time" style="flex:none;font-size:var(--px-12);color:var(--muted);width:var(--px-84)">{m.ts}</span>
          <span class="mono" style="flex:none;font-size:var(--px-12);color:var(--tbl-subject);font-weight:500;width:var(--px-150);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{m.subject}</span>
          <span class="mono" style="flex:1;min-width:0;font-size:var(--px-12);color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{m.payload}</span>
        </div>
      {/each}
    {/if}
  </div>
  {/if}

  <!-- publish + request/reply -->
  {#if panel === ''}
  <div class="nw-compose">
    <div class="nw-compose-row">
      <span class="nw-compose-label">Publish</span>
      <input bind:value={pubSubject} placeholder="subject" class="ds-control mono" style="flex:none;width:var(--px-200)" />
      <input bind:value={pubMsg} onkeydown={(e) => e.key === 'Enter' && publish()} placeholder="payload" class="ds-control mono" style="flex:1;min-width:0" />
      <span onclick={publish} onkeydown={(e) => e.key === 'Enter' && publish()} role="button" tabindex="0" class="cfm-btn primary" style="flex:none">Publish</span>
    </div>
    <div class="nw-compose-row">
      <span class="nw-compose-label">Request</span>
      <input bind:value={reqSubject} placeholder="subject" class="ds-control mono" style="flex:none;width:var(--px-200)" />
      <input bind:value={reqMsg} onkeydown={(e) => e.key === 'Enter' && request()} placeholder="payload" class="ds-control mono" style="flex:1;min-width:0" />
      <span onclick={request} onkeydown={(e) => e.key === 'Enter' && request()} role="button" tabindex="0" class="cfm-btn" style="flex:none">Request ▸</span>
    </div>
    {#if reqReply != null}
      <div class="mono" style="font-size:var(--px-12);color:var(--text2);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-8) var(--px-10);white-space:pre-wrap;word-break:break-word">↩ {reqReply}</div>
    {/if}
  </div>
  {/if}
</div>

<style>
  /* the identifier reads as a link: colour + underline on hover, visible focus */
  .tbl-link {
    color: var(--tbl-link);
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    border-radius: var(--px-3);
  }
  .tbl-link:hover {
    text-decoration: underline;
  }
  .tbl-link:focus-visible {
    outline: var(--px-2) solid var(--tbl-link);
    outline-offset: var(--px-1);
  }
  .js-row:hover {
    background: var(--tbl-hover);
  }
  .js-row.sel {
    background: color-mix(in srgb, var(--primary) 12%, var(--surface));
    box-shadow: inset var(--px-3) 0 0 var(--primary);
  }
  .nw-side {
    width: var(--px-220);
    flex: none;
    border-right: var(--px-1) solid var(--border);
    overflow: auto;
    padding: var(--px-10) var(--px-8);
    background: var(--surface);
  }
  .nw-side-head {
    display: flex;
    align-items: center;
    padding: var(--px-2) var(--px-8) var(--px-8);
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
  }
  .nw-add {
    margin-left: auto;
    width: var(--px-22);
    height: var(--px-22);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--px-6);
    color: var(--primary);
    cursor: pointer;
    font-size: var(--px-13);
  }
  .nw-add:hover {
    background: color-mix(in srgb, var(--primary) 10%, transparent);
  }
  .nw-item {
    padding: var(--px-6) var(--px-10);
    border-radius: var(--px-6);
    cursor: pointer;
    font-size: var(--px-13);
    color: var(--text);
  }
  .nw-item:hover {
    background: var(--hover);
  }
  .nw-item.on {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    color: var(--primary);
    font-weight: 600;
  }
  .nw-msg {
    display: flex;
    gap: var(--px-12);
    padding: var(--px-8) var(--px-18);
    border-bottom: var(--px-1) solid var(--border);
    align-items: baseline;
  }
  .nw-msg:nth-child(even) {
    background: var(--grid-zebra);
  }
  .nw-compose {
    flex: none;
    border-top: var(--px-1) solid var(--border);
    background: var(--surface);
    padding: var(--px-12) var(--px-18);
    display: flex;
    flex-direction: column;
    gap: var(--px-8);
  }
  .nw-compose-row {
    display: flex;
    gap: var(--px-8);
    align-items: center;
  }
  .nw-compose-label {
    flex: none;
    width: var(--px-64);
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
  }
</style>
