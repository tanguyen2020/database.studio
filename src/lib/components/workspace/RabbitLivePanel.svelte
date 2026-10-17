<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  // Live listening for a RabbitMQ queue or exchange. Two modes:
  //   watch   — a temporary tap queue receives a COPY of what flows (the exchange's
  //             traffic, or whatever the queue's own bindings route); nothing is
  //             taken from the real queue.
  //   consume — takes messages off the queue as they arrive (ack): they are gone
  //             for every other consumer, so it asks first.
  // The backend task (commands/rabbitmq.rs) streams batches; this panel only
  // renders them. Stays mounted while its tab is open (the parent hides it), so
  // switching sections does not stop a session; closing the tab does.
  import { onDestroy } from 'svelte'
  import * as ipc from '$lib/ipc'
  import RabbitMessageDialog from './RabbitMessageDialog.svelte'
  import { exchangeLabel, formatPayloadBytes, payloadPreview, payloadText } from '$lib/rabbitmq/format'
  import PayloadPreview from '$lib/components/viewer/PayloadPreview.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'

  interface Props {
    connId: string
    vhost: string
    kind: 'queue' | 'exchange'
    name: string
    /** exchange type (exchange tab only) — decides whether routing keys are asked */
    exchangeType?: string
  }
  let { connId, vhost, kind, name, exchangeType = '' }: Props = $props()

  /** Rows kept on screen; older ones scroll off (the count keeps going). */
  const MAX_ROWS = 1000

  interface Row {
    seq: number
    at: string
    m: ipc.RabbitMessage
  }

  let mode = $state<ipc.RabbitLiveMode>('watch')
  let keysText = $state('')
  let running = $state(false)
  let starting = $state(false)
  let session = $state<string | null>(null)
  let info = $state<ipc.RabbitLiveInfo | null>(null)
  let received = $state(0)
  let rows = $state<Row[]>([])
  let status = $state<{ level: 'warn' | 'error'; text: string } | null>(null)
  let confirmConsume = $state(false)
  let viewing = $state<Row | null>(null)
  let unsubscribe: (() => void) | null = null
  let seq = 0

  const askKeys = $derived(kind === 'exchange' && (exchangeType === 'topic' || exchangeType === 'direct'))
  const blocked = $derived(
    kind === 'exchange' && name === ''
      ? 'The default exchange routes straight to a queue by name and cannot be watched — open the queue and watch or consume it there.'
      : null,
  )

  function newSession(): string {
    return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 24)
  }

  function stamp(): string {
    const d = new Date()
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  }

  function onBatch(b: ipc.RabbitLiveBatch) {
    received = b.received
    const at = stamp()
    const incoming = b.msgs.map((m) => ({ seq: ++seq, at, m })).reverse()
    rows = [...incoming, ...rows].slice(0, MAX_ROWS)
    // a consume session changes the queue's counts
    if (mode === 'consume') explorer.bumpRabbit(connId)
  }

  function onStatus(s: ipc.RabbitLiveStatus) {
    if (s.state === 'warn') {
      status = { level: 'warn', text: s.message }
      return
    }
    running = false
    if (s.state === 'error') status = { level: 'error', text: s.message }
    unsubscribe?.()
    unsubscribe = null
  }

  function requestStart() {
    if (mode === 'consume') confirmConsume = true
    else void start()
  }

  async function start() {
    if (running || starting || blocked) return
    confirmConsume = false
    starting = true
    status = null
    const id = newSession()
    // Listen BEFORE starting, so the first batch can never be missed.
    unsubscribe?.()
    unsubscribe = await ipc.onRabbitLive(id, onBatch, onStatus)
    try {
      const keys = keysText
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
      info = await ipc.rabbitLiveStart(connId, {
        session: id,
        mode,
        vhost,
        queue: kind === 'queue' ? name : undefined,
        exchange: kind === 'exchange' ? name : undefined,
        routing_keys: keys,
      })
      session = id
      running = true
      received = 0
      if (mode === 'consume') explorer.bumpRabbit(connId)
    } catch (e) {
      unsubscribe?.()
      unsubscribe = null
      status = { level: 'error', text: String(e) }
    } finally {
      starting = false
    }
  }

  async function stop() {
    if (!session) return
    const id = session
    running = false
    try {
      await ipc.rabbitLiveStop(id)
    } catch (e) {
      toasts.error(String(e), 'rabbitmq')
    }
    explorer.bumpRabbit(connId)
  }

  function clear() {
    rows = []
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Payload copied', 'rabbitmq')
  }

  onDestroy(() => {
    if (running && session) void ipc.rabbitLiveStop(session)
    unsubscribe?.()
  })

  const GRID_FONT = "font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1,'zero' 1"
</script>

<div style="display:flex;flex-direction:column;gap:var(--px-10);min-height:0">
  <div style="display:flex;align-items:center;gap:var(--px-10);flex-wrap:wrap">
    {#if kind === 'queue'}
      <select class="ds-control lv-input" bind:value={mode} disabled={running || starting} aria-label="Live mode">
        <option value="watch">Watch — copy messages, take nothing</option>
        <option value="consume">Consume — take messages off the queue</option>
      </select>
    {:else}
      <span style="font-size:var(--px-12);color:var(--text2)">Watch everything this exchange routes</span>
    {/if}
    {#if askKeys}
      <input
        class="ds-control mono lv-input"
        bind:value={keysText}
        disabled={running || starting}
        placeholder={exchangeType === 'topic' ? '# (everything) — or order.*, audit.#' : 'routing key(s), comma-separated'}
        aria-label="Routing keys to watch"
        spellcheck="false"
        style="width:var(--px-300)"
      />
    {/if}
    {#if running}
      <span onclick={stop} onkeydown={(e) => e.key === 'Enter' && stop()} role="button" tabindex="0" class="cfm-btn ds-danger-outline">■ Stop</span>
    {:else}
      <span
        onclick={requestStart}
        onkeydown={(e) => e.key === 'Enter' && requestStart()}
        role="button"
        tabindex="0"
        aria-disabled={!!blocked}
        class="cfm-btn primary"
        style={starting || blocked ? 'opacity:.6;pointer-events:none' : ''}
      >{starting ? 'Starting…' : '▶ Start listening'}</span>
    {/if}
    <span data-testid="live-state" aria-live="polite" style="font-size:var(--px-11_5);color:{running ? 'var(--sacc-green)' : 'var(--muted)'}">
      {#if running}<span class="lv-dot" aria-hidden="true"></span> Listening · {received.toLocaleString('en-US')} received
      {:else if received}Stopped · {received.toLocaleString('en-US')} received
      {:else}Not listening{/if}
    </span>
    {#if rows.length}
      <span onclick={clear} onkeydown={(e) => e.key === 'Enter' && clear()} role="button" tabindex="0" class="pv-btn" style="margin-left:auto">Clear view</span>
    {/if}
  </div>

  <div style="font-size:var(--px-11_5);color:var(--muted);line-height:1.45">
    {#if blocked}
      {blocked}
    {:else if mode === 'consume'}
      Takes each message off <span class="mono" style="color:var(--text2)">{name}</span> as it arrives and acknowledges it — other consumers will not get it.
    {:else if kind === 'queue'}
      A temporary queue receives a copy of everything this queue's bindings route; nothing is taken from <span class="mono" style="color:var(--text2)">{name}</span>. Messages published straight to the queue by name (default exchange) cannot be copied.
    {:else}
      A temporary queue bound to <span class="mono" style="color:var(--text2)">{exchangeLabel(name)}</span> receives a copy of what it routes; no existing queue is affected. It is removed when you stop (and expires on the broker if the app closes).
    {/if}
  </div>

  {#if running && info?.tap_queue}
    <div data-testid="live-bindings" style="font-size:var(--px-11);color:var(--text2)">
      tap <span class="mono">{info.tap_queue}</span> ←
      {#each info.bindings as b, i (i)}<span class="mono lv-chip">{exchangeLabel(b.source)}{b.routing_key ? ` · ${b.routing_key}` : ''}</span>{/each}
    </div>
  {/if}

  {#if status}
    <div role="alert" style="font-size:var(--px-11_5);color:{status.level === 'error' ? 'var(--error)' : 'var(--sacc-amber)'}">{status.text}</div>
  {/if}

  {#if rows.length === 0}
    <div class="ds-empty">
      {running ? 'Waiting for messages…' : 'Start listening to see messages as they arrive.'}
    </div>
  {:else}
    {#if received > rows.length}
      <div style="font-size:var(--px-11);color:var(--muted)">Showing the newest {rows.length.toLocaleString('en-US')} of {received.toLocaleString('en-US')}.</div>
    {/if}
    <table class="ds-table" data-testid="live-rows" style="font-size:var(--px-12_5);table-layout:fixed;">
      <thead><tr>
        {#each [['Received', 'width:var(--px-100)'], ['Routing key', 'width:var(--px-180)'], ['Exchange', 'width:var(--px-140)'], ['Size', 'width:var(--px-80)'], ['Payload', ''], ['', 'width:var(--px-60)']] as [h, extra] (h || 'actions')}
          <th style={extra}>{h}</th>
        {/each}
      </tr></thead>
      <tbody>
        {#each rows as r (r.seq)}
          <tr class="lv-row">
            <td class="ds-time" style="color:var(--tbl-meta)">{r.at}</td>
            <td class="mono" style="font-size:var(--px-12);color:var(--tbl-subject);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={r.m.routing_key}>{r.m.routing_key || '—'}</td>
            <td style="color:var(--tbl-meta);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{exchangeLabel(r.m.exchange)}</td>
            <td class="ds-num" style="color:var(--syntax-number)">{formatPayloadBytes(r.m.payload_bytes)}</td>
            <td style="max-width:var(--px-560)">{#if payloadText(r.m).binary}<span class="mono" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--px-12);color:var(--muted)" title={r.m.payload}>{payloadPreview(r.m)}</span>{:else}<PayloadPreview text={payloadText(r.m).text} />{/if}</td>
            <td style="white-space:nowrap">
              <span onclick={() => (viewing = r)} onkeydown={(e) => e.key === 'Enter' && (viewing = r)} role="button" tabindex="0" title="View payload" class="ds-act" style="color:var(--muted)"><Icon name="expand" size={13} /></span>
              <span onclick={() => copy(r.m.payload)} onkeydown={(e) => e.key === 'Enter' && copy(r.m.payload)} role="button" tabindex="0" title="Copy payload" class="ds-act" style="color:var(--muted)"><Icon name="copy" size={13} /></span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

{#if viewing}
  <RabbitMessageDialog message={viewing.m} title="Received {viewing.at}" onClose={() => (viewing = null)} />
{/if}

{#if confirmConsume}
  <div role="presentation" style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60">
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Consume messages live"
      onkeydown={(e) => e.key === 'Escape' && (confirmConsume = false)}
      tabindex="-1"
      style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-460), 92%);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
    >
      <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">Consume messages live</div>
      <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">
        Every message already in <span class="mono" style="color:var(--text)">{name}</span>, and every one that arrives while listening, is taken and acknowledged — it is <b>removed</b> and other consumers will not get it. Use Watch to look without taking.
      </div>
      <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
        <span onclick={() => (confirmConsume = false)} onkeydown={(e) => e.key === 'Enter' && (confirmConsume = false)} role="button" tabindex="0" class="pv-btn">Cancel</span>
        <span onclick={start} onkeydown={(e) => e.key === 'Enter' && start()} role="button" tabindex="0" class="pv-btn danger">Consume</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .lv-row td {
    padding: var(--px-8) var(--px-12);
  }
  .lv-row:hover {
    background: var(--tbl-hover);
  }
  .lv-chip {
    display: inline-block;
    margin-left: var(--px-6);
    padding: 0 var(--px-6);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-5);
    color: var(--tbl-subject);
  }
  .lv-dot {
    display: inline-block;
    width: var(--px-7);
    height: var(--px-7);
    border-radius: 50%;
    background: var(--sacc-green);
    animation: lv-pulse 1.2s ease-in-out infinite;
  }
  @keyframes lv-pulse {
    50% {
      opacity: 0.3;
    }
  }
</style>
