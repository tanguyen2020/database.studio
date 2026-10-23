<script lang="ts">
  // NATS workspace › Publish & subscribe: listen to a subject live (one core
  // subscription per connection, like the backend), and send a message or a request.
  // The section stays mounted while you look at other sections, so listening goes on;
  // closing the tab stops it.
  import { onDestroy, onMount } from 'svelte'
  import * as ipc from '$lib/ipc'
  import Icon from '$lib/components/Icon.svelte'
  import PayloadPreview from '$lib/components/viewer/PayloadPreview.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { exactUtc } from '$lib/stream/humanize'
  import { publishProblem, subjectProblem } from '$lib/stream/nats-match'

  let { connId }: { connId: string } = $props()

  const MAX = 1000
  interface Received {
    id: number
    at: number
    subject: string
    reply: string
    payload: string
  }

  // ---- listen ----
  let listenSubject = $state('>')
  let listening = $state<string | null>(null) // the subject actually subscribed to
  let paused = $state(false)
  let busy = $state(false)
  let listenError = $state<string | null>(null)
  let received = $state<Received[]>([])
  let total = $state(0)
  let nextId = 0
  let off: (() => void) | null = null
  const listenHint = $derived(subjectProblem(listenSubject))

  onMount(async () => {
    off = await ipc.onNatsMsg(connId, (m) => {
      if (paused || !listening) return
      total++
      received = [{ id: nextId++, at: Date.now(), subject: m.subject, reply: m.reply, payload: m.payload }, ...received].slice(0, MAX)
    })
  })
  onDestroy(() => {
    off?.()
    if (listening) void ipc.natsUnsubscribe(connId).catch(() => {})
  })

  async function startListening() {
    if (listenHint || busy) return
    busy = true
    listenError = null
    try {
      // one subscription per connection: switching subject replaces the old one
      if (listening) await ipc.natsUnsubscribe(connId).catch(() => {})
      await ipc.natsSubscribe(connId, listenSubject.trim())
      listening = listenSubject.trim()
      paused = false
    } catch (e) {
      listening = null
      listenError = `Could not listen on ${listenSubject.trim()}: ${e}`
    } finally {
      busy = false
    }
  }
  async function stopListening() {
    if (!listening || busy) return
    busy = true
    try {
      await ipc.natsUnsubscribe(connId)
    } catch (e) {
      toasts.error(`Could not stop listening: ${e}`)
    } finally {
      listening = null
      paused = false
      busy = false
    }
  }
  function clearReceived() {
    received = []
    total = 0
  }
  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Copied', 'nats')
  }
  function clock(t: number): string {
    const d = new Date(t)
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  }

  // ---- send ----
  let mode = $state<'publish' | 'request'>('publish')
  let sendSubject = $state('')
  let sendPayload = $state('')
  let timeoutMs = $state(3000)
  let sending = $state(false)
  let sendError = $state<string | null>(null)
  let reply = $state<{ subject: string; text: string; ms: number } | null>(null)
  let lastSent = $state<string | null>(null)
  const sendHint = $derived(publishProblem(sendSubject))

  async function send() {
    if (sendHint || sending) return
    sending = true
    sendError = null
    reply = null
    lastSent = null
    const subject = sendSubject.trim()
    const started = performance.now()
    try {
      if (mode === 'publish') {
        await ipc.natsPublish(connId, subject, sendPayload)
        lastSent = subject
      } else {
        const text = await ipc.natsRequest(connId, subject, sendPayload, timeoutMs)
        reply = { subject, text, ms: Math.round(performance.now() - started) }
      }
    } catch (e) {
      const msg = String(e)
      sendError = mode === 'request' && /timed? ?out|no responders/i.test(msg)
        ? `No reply on ${subject} within ${timeoutMs / 1000}s — is a service listening on it? (${msg})`
        : `${mode === 'publish' ? 'Publish' : 'Request'} failed: ${msg}`
    } finally {
      sending = false
    }
  }
</script>

<div class="nm" data-nats-messaging>
  <section class="nm-card nm-listen" aria-label="Listen">
    <div class="nm-head">
      <span class="nm-title">Listen</span>
      {#if listening}
        <span class="nm-state" class:paused data-state={paused ? 'paused' : 'listening'}>
          <span class="nm-dot" aria-hidden="true"></span>{paused ? 'Paused on' : 'Listening on'} <span class="mono">{listening}</span>
        </span>
      {:else}
        <span class="nm-state off" data-state="off">Not listening</span>
      {/if}
      <span class="nm-flex"></span>
      {#if received.length}
        <span class="nm-meta">{total.toLocaleString('en-US')} received{total > MAX ? ` · showing the newest ${MAX.toLocaleString('en-US')}` : ''}</span>
      {/if}
    </div>
    <div class="nm-bar">
      <label class="ds-search nm-subject">
        <Icon name="search" size={13} />
        <input
          bind:value={listenSubject}
          class="mono"
          placeholder="orders.> or orders.*.paid"
          aria-label="Subject to listen on"
          spellcheck="false"
          onkeydown={(e) => e.key === 'Enter' && startListening()}
        />
      </label>
      {#if listening && listening === listenSubject.trim()}
        <button type="button" class="cfm-btn" onclick={stopListening} disabled={busy}>Stop</button>
        <button type="button" class="cfm-btn" onclick={() => (paused = !paused)}>{paused ? 'Resume' : 'Pause'}</button>
      {:else}
        <button type="button" class="cfm-btn primary" onclick={startListening} disabled={!!listenHint || busy} title={listenHint ?? (listening ? `Listen on ${listenSubject.trim()} instead of ${listening}` : 'Show every message published on this subject from now on')}>{listening ? 'Switch' : 'Listen'}</button>
      {/if}
      <button type="button" class="cfm-btn" onclick={clearReceived} disabled={!received.length} title="Clear the messages shown here (nothing is deleted on the server)">Clear</button>
    </div>
    <div class="nm-help">
      {#if listenHint && listenSubject.trim()}<span class="nm-warn">{listenHint}</span>{:else}* matches one part, &gt; matches the rest — e.g. <span class="mono">orders.&gt;</span> shows every order event. Only messages published from now on appear.{/if}
    </div>
    {#if listenError}<div class="nm-error" role="alert">{listenError}</div>{/if}

    <div class="nm-list">
      {#if received.length === 0}
        <div class="ds-empty">
          {#if listening}<b>Waiting for messages</b>Nothing has been published on <span class="mono">{listening}</span> since you started listening.{:else}<b>Not listening yet</b>Type a subject above and press Listen to watch messages as they are published.{/if}
        </div>
      {:else}
        <table class="nm-table" aria-label="Received messages">
          <colgroup><col style="width:var(--px-110)" /><col style="width:32%" /><col /><col style="width:var(--px-48)" /></colgroup>
          <thead><tr><th>Time</th><th>Subject</th><th>Payload</th><th></th></tr></thead>
          <tbody>
            {#each received as m (m.id)}
              <tr>
                <td class="nm-time" title={exactUtc(m.at)}>{clock(m.at)}</td>
                <td class="mono nm-subj" title={m.reply ? `${m.subject} · reply to ${m.reply}` : m.subject}>{m.subject}</td>
                <td class="nm-payload"><PayloadPreview text={m.payload} /></td>
                <td class="nm-acts"><button type="button" class="nm-icon" onclick={() => copy(m.payload)} title="Copy payload" aria-label="Copy payload"><Icon name="copy" size={13} /></button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </section>

  <section class="nm-card nm-send" aria-label="Send">
    <div class="nm-head">
      <span class="nm-title">Send</span>
      <span class="nm-flex"></span>
      <div class="ds-seg" role="group" aria-label="Send as">
        <button type="button" aria-pressed={mode === 'publish'} onclick={() => (mode = 'publish')}>Publish</button>
        <button type="button" aria-pressed={mode === 'request'} onclick={() => (mode = 'request')}>Request</button>
      </div>
    </div>
    <p class="nm-explain">
      {#if mode === 'publish'}Sends the message to everyone listening on the subject. Nothing comes back.{:else}Sends the message and waits for one reply from a service listening on the subject.{/if}
    </p>
    <label class="nm-field">
      <span>Subject</span>
      <input bind:value={sendSubject} class="ds-control mono" placeholder="orders.eu" aria-label="Subject to send to" spellcheck="false" />
    </label>
    {#if sendSubject.trim() && sendHint}<div class="nm-warn">{sendHint}</div>{/if}
    <label class="nm-field nm-grow">
      <span>Payload</span>
      <textarea bind:value={sendPayload} class="ds-control mono" rows="6" placeholder={'{"id": 1}'} aria-label="Payload" spellcheck="false" onkeydown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && send()}></textarea>
    </label>
    {#if mode === 'request'}
      <label class="nm-field nm-inline">
        <span>Wait for a reply up to</span>
        <select class="ds-control" bind:value={timeoutMs} aria-label="Reply timeout">
          {#each [1000, 3000, 5000, 10000, 30000] as ms (ms)}<option value={ms}>{ms / 1000} s</option>{/each}
        </select>
      </label>
    {/if}
    <div class="nm-actions">
      <span class="nm-meta">Ctrl+Enter</span>
      <button type="button" class="cfm-btn primary" onclick={send} disabled={!!sendHint || sending}>{sending ? (mode === 'publish' ? 'Publishing…' : 'Waiting for reply…') : mode === 'publish' ? 'Publish' : 'Send request'}</button>
    </div>
    {#if sendError}<div class="nm-error" role="alert">{sendError}</div>{/if}
    {#if lastSent}<div class="nm-ok" role="status">Published to <span class="mono">{lastSent}</span></div>{/if}
    {#if reply}
      <div class="nm-reply" role="status" aria-label="Reply">
        <div class="nm-reply-head">Reply from <span class="mono">{reply.subject}</span> · {reply.ms} ms
          <button type="button" class="nm-icon" onclick={() => reply && copy(reply.text)} title="Copy reply" aria-label="Copy reply"><Icon name="copy" size={13} /></button>
        </div>
        <pre class="mono">{reply.text}</pre>
      </div>
    {/if}
  </section>
</div>

<style>
  .nm {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(calc(var(--px-140) * 2), var(--px-340));
    gap: var(--px-14);
    padding: var(--px-14);
    background: var(--bg);
  }
  .nm-card {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--px-10);
    padding: var(--px-14);
    background: var(--surface);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-10);
  }
  .nm-head {
    display: flex;
    align-items: center;
    gap: var(--px-10);
    min-height: var(--px-28);
  }
  .nm-title {
    font-size: var(--px-14);
    font-weight: 600;
    color: var(--text);
  }
  .nm-flex {
    flex: 1;
  }
  .nm-state {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .nm-state.off {
    color: var(--muted);
  }
  .nm-dot {
    width: var(--px-7);
    height: var(--px-7);
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 0 var(--px-3) color-mix(in srgb, var(--success) 22%, transparent);
  }
  .nm-state.paused .nm-dot {
    background: var(--warn);
    box-shadow: none;
  }
  .nm-meta {
    font-size: var(--px-11_5);
    color: var(--muted);
  }
  .nm-bar {
    display: flex;
    align-items: center;
    gap: var(--px-8);
  }
  .nm-subject {
    flex: 1;
    display: flex;
  }
  .nm-help {
    font-size: var(--px-11_5);
    color: var(--muted);
  }
  .nm-warn {
    font-size: var(--px-12);
    color: var(--sacc-amber);
  }
  .nm-error {
    font-size: var(--px-12);
    color: var(--danger-text);
    background: color-mix(in srgb, var(--error) 8%, transparent);
    border: var(--px-1) solid color-mix(in srgb, var(--error) 30%, transparent);
    border-radius: var(--px-8);
    padding: var(--px-8) var(--px-10);
  }
  .nm-ok {
    font-size: var(--px-12);
    color: var(--text2);
  }
  .nm-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
  }
  .nm-table {
    width: 100%;
    table-layout: fixed;
    border-collapse: separate;
    border-spacing: 0;
    font-size: var(--px-12_5);
  }
  .nm-table th {
    position: sticky;
    top: 0;
    background: var(--header);
    color: var(--tbl-th);
    font-size: var(--px-12);
    font-weight: 600;
    text-align: left;
    padding: var(--px-6) var(--px-12);
    border-bottom: var(--px-1) solid var(--border2);
  }
  .nm-table td {
    padding: var(--px-6) var(--px-12);
    border-bottom: var(--px-1) solid var(--border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--tbl-cell);
  }
  .nm-table tbody tr:hover {
    background: var(--row-hover);
    box-shadow: var(--row-hover-shadow);
  }
  .nm-table td.nm-acts {
    overflow: visible;
    text-overflow: clip;
    padding: var(--px-4) var(--px-8);
  }
  .nm-time {
    font-variant-numeric: tabular-nums;
  }
  .nm-subj {
    color: var(--tbl-child);
    font-size: var(--px-12);
  }
  .nm-icon {
    border: 0;
    background: transparent;
    color: var(--muted);
    display: inline-flex;
    padding: var(--px-3);
    border-radius: var(--px-4);
    cursor: pointer;
  }
  .nm-icon:hover {
    background: var(--hover);
    color: var(--text);
  }
  .nm-explain {
    margin: 0;
    font-size: var(--px-12);
    color: var(--text2);
  }
  .nm-field {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .nm-field textarea {
    resize: vertical;
    min-height: var(--px-110);
  }
  .nm-inline {
    flex-direction: row;
    align-items: center;
    gap: var(--px-8);
  }
  .nm-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--px-10);
  }
  .nm-reply {
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    background: var(--panel);
    padding: var(--px-8) var(--px-10);
    display: flex;
    flex-direction: column;
    gap: var(--px-6);
    min-height: 0;
  }
  .nm-reply-head {
    display: flex;
    align-items: center;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--text2);
  }
  /* the shared segmented control, for real <button>s */
  .ds-seg > button {
    display: inline-flex;
    align-items: center;
    height: var(--px-26);
    padding: 0 var(--px-11);
    border: 0;
    border-radius: var(--px-6);
    background: transparent;
    font-family: var(--font-main);
    font-size: var(--px-12_5);
    font-weight: 500;
    color: var(--text2);
    cursor: pointer;
  }
  .ds-seg > button:hover {
    color: var(--text);
    background: var(--surface);
  }
  .ds-seg > button[aria-pressed='true'] {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
    box-shadow: var(--shadow-xs);
  }
  .nm-reply pre {
    margin: 0;
    font-size: var(--px-12);
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: var(--px-200);
    overflow: auto;
  }
</style>
