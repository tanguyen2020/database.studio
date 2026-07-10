<script lang="ts">
  // Kafka Message Consumer (Phase 4 · T4) — port dòng 718-752: header (start pos +
  // partition + Consume/Pause/Stop/Clear + decode) + bảng message (partition/offset/
  // ts/key/value) + filter key regex / value text. Stream qua event "kafka-msg".
  import { onDestroy, onMount } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { toasts } from '$lib/stores/toast.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { highlightJson, jsonTokenColor } from '$lib/format/json'
  import { autofocus } from '$lib/actions/autofocus'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const topic = $derived((tab.state as { topic?: string }).topic ?? '')

  // Default to Earliest so opening a topic shows its existing messages (Latest
  // would only stream records produced after Consume, i.e. usually nothing).
  let from = $state<'earliest' | 'latest' | 'offset'>('earliest')
  let offset = $state(0)
  let partition = $state<string>('') // '' = all
  let consuming = $state(false)
  let paused = $state(false)
  let decode = $state<'utf8' | 'json' | 'raw'>('utf8')
  let keyFilter = $state('')
  let valFilter = $state('')
  const MAX = 500
  let messages = $state<ipc.KafkaMsg[]>([])
  // Incoming records are buffered and flushed on a throttled tick instead of a
  // reactive update per message — streaming hundreds of records one-at-a-time
  // (each doing `[msg, ...messages]` = an O(n) copy + re-render) is very slow.
  let pending: ipc.KafkaMsg[] = []
  let flushTimer: ReturnType<typeof setInterval> | null = null
  function flushPending() {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    // batch arrived oldest→newest; reverse so the newest sits at the top (matching
    // the previous per-message prepend), then keep only the most-recent MAX.
    messages = [...batch.reverse(), ...messages].slice(0, MAX)
  }
  let unlisten: (() => void) | null = null
  let unlistenStatus: (() => void) | null = null
  // Last librdkafka error/warning surfaced from the backend (connection refused,
  // fetch failure, unknown partition, …) so failures aren't silent.
  let statusMsg = $state('')
  let statusLevel = $state<'error' | 'warn' | ''>('')

  // Full local timestamp yyyy-MM-dd HH:mm:ss (parity with NatsSubjectMessages).
  function fmtTs(ms: number): string {
    if (!ms) return ''
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  // Row selection + hover (Result Grid / NatsSubjectMessages parity): a Kafka record
  // is keyed by partition:offset (no single sequence). Selected row uses the blue
  // --grid-select with white text so cells + action icons stay visible.
  let selKey = $state<string | null>(null)
  let hoverKey = $state<string | null>(null)
  const msgKey = (m: ipc.KafkaMsg) => `${m.partition}:${m.offset}`
  const rowBg = (k: string) => (selKey === k ? 'var(--grid-select)' : hoverKey === k ? 'var(--hover)' : 'transparent')
  const cellColor = (k: string, base: string) => (selKey === k ? 'var(--hex-fff)' : base)
  // Result Grid's typographic rule (rule chung): tabular figures.
  const GRID_FONT = "font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1,'zero' 1"

  // JSON viewer popup — pretty-prints the value (falls back to raw text when it
  // isn't valid JSON) so the full message is readable, not just the row preview.
  let viewState = $state<{ label: string; text: string; isJson: boolean } | null>(null)
  function viewJson(m: ipc.KafkaMsg) {
    let text = m.value
    let isJson = false
    try {
      text = JSON.stringify(JSON.parse(m.value), null, 2)
      isJson = true
    } catch {
      // not JSON — show the raw value
    }
    viewState = { label: `${topic} · p${m.partition}:${m.offset}`, text, isJson }
  }
  async function copyText(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Copied')
  }

  function decodeVal(v: string): string {
    if (decode === 'json') {
      try {
        return JSON.stringify(JSON.parse(v))
      } catch {
        return v
      }
    }
    return v
  }

  async function copyMsg(m: ipc.KafkaMsg) {
    await navigator.clipboard.writeText(decodeVal(m.value))
    toasts.success('Message copied')
  }
  // In-app confirm popup (window.confirm isn't reliable inside the Tauri webview).
  let confirmState = $state<{ title: string; body: string; run: () => void } | null>(null)
  function askConfirm(title: string, body: string, run: () => void) {
    confirmState = { title, body, run }
  }
  function runConfirm() {
    const c = confirmState
    confirmState = null
    c?.run()
  }

  // Clear ALL messages of the topic on Kafka (purge) — DeleteRecords truncates
  // every partition to its high watermark, keeping the topic itself. Confirm first;
  // on success clear the view and refresh the sidebar so counts update.
  function clearMessages() {
    askConfirm(
      'Clear messages',
      `Delete ALL messages of topic "${topic}" on Kafka? This truncates every partition to its high watermark. The topic is kept but this cannot be undone.`,
      async () => {
        if (!tab.connectionId) return
        try {
          await ipc.kafkaPurgeTopic(tab.connectionId, topic)
          messages = []
          pending = []
          toasts.success(`Cleared messages of ${topic}`, 'kafka')
          explorer.refreshStreaming(tab.connectionId)
        } catch (e) {
          toasts.error(`Clear failed: ${e}`, 'kafka')
        }
      },
    )
  }

  const filtered = $derived(
    messages.filter((m) => {
      if (valFilter && !m.value.toLowerCase().includes(valFilter.toLowerCase())) return false
      if (keyFilter) {
        try {
          if (!new RegExp(keyFilter).test(m.key)) return false
        } catch {
          return m.key.includes(keyFilter)
        }
      }
      return true
    }),
  )

  // When the sidebar purges this topic (Explorer → Clear messages), clear the view
  // here too so both stay in sync. Skip the initial run (tick starts undefined).
  let kafkaTickSeen = false
  $effect(() => {
    const tick = explorer.kafkaMsgTick[`${tab.connectionId}:${topic}`] ?? 0
    if (!kafkaTickSeen) {
      kafkaTickSeen = true
      return
    }
    void tick
    messages = []
    pending = []
  })

  onMount(async () => {
    if (!IS_TAURI) return
    const { listen } = await import('@tauri-apps/api/event')
    unlisten = await listen<ipc.KafkaMsg>('kafka-msg', (e) => {
      if (e.payload.conn_id !== tab.connectionId || paused) return
      pending.push(e.payload) // buffered; flushed on the tick below
    })
    flushTimer = setInterval(flushPending, 120)
    unlistenStatus = await listen<{ conn_id: string; level: 'error' | 'warn'; message: string }>(
      'kafka-status',
      (e) => {
        if (e.payload.conn_id !== tab.connectionId) return
        statusLevel = e.payload.level
        statusMsg = e.payload.message
      },
    )
    // Auto-start browsing from Earliest so clicking a topic shows its messages.
    if (tab.connectionId && !consuming) void toggle()
  })

  onDestroy(() => {
    if (flushTimer) clearInterval(flushTimer)
    unlisten?.()
    unlistenStatus?.()
    if (consuming && tab.connectionId) void ipc.kafkaStopConsume(tab.connectionId)
  })

  async function toggle() {
    if (!tab.connectionId) return
    if (consuming) {
      await ipc.kafkaStopConsume(tab.connectionId).catch(() => {})
      consuming = false
      return
    }
    const part = partition.trim() === '' ? null : parseInt(partition, 10)
    statusMsg = ''
    statusLevel = ''
    try {
      await ipc.kafkaConsume(tab.connectionId, topic, from, offset, Number.isNaN(part as number) ? null : part)
      consuming = true
      if (!IS_TAURI) toasts.show('Streaming only works in the Tauri app (not the browser demo)')
    } catch (e) {
      toasts.error(`Consume failed: ${e}`)
    }
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative">
  <!-- header -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:var(--hex-8b5cf6)"></span>
    <span class="mono" style="font-size:var(--px-13);font-weight:600">{topic}</span>
    <span style="font-size:var(--px-11);color:var(--text2)">From</span>
    <select bind:value={from} class="cm-mini">
      <option value="latest">Latest</option>
      <option value="earliest">Earliest</option>
      <option value="offset">Offset</option>
    </select>
    {#if from === 'offset'}
      <input type="number" bind:value={offset} class="cm-mini mono" style="width:var(--px-96)" />
    {/if}
    <span style="font-size:var(--px-11);color:var(--text2)">Partition</span>
    <input bind:value={partition} placeholder="all" class="cm-mini mono" style="width:var(--px-60)" />
    <span style="font-size:var(--px-11);color:var(--text2)">Decode</span>
    <select bind:value={decode} class="cm-mini">
      <option value="utf8">UTF-8</option>
      <option value="json">JSON</option>
      <option value="raw">Raw</option>
    </select>
    <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      <span style="font-size:var(--px-11);color:var(--muted)">{filtered.length}/{messages.length}</span>
      <span onclick={toggle} onkeydown={(e) => e.key === 'Enter' && toggle()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:{consuming ? 'var(--hex-8b5cf6)' : 'var(--panel)'};color:{consuming ? 'var(--hex-fff)' : 'var(--text)'};border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">{consuming ? 'Stop' : 'Consume'}</span>
      <span onclick={() => (paused = !paused)} onkeydown={(e) => e.key === 'Enter' && (paused = !paused)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">{paused ? 'Resume' : 'Pause'}</span>
      <span onclick={() => { messages = []; pending = [] }} onkeydown={(e) => e.key === 'Enter' && (messages = [], pending = [])} role="button" tabindex="0" title="Clear the view only (does not touch Kafka)" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">Clear</span>
      <span onclick={clearMessages} onkeydown={(e) => e.key === 'Enter' && clearMessages()} role="button" tabindex="0" title="Delete all messages of this topic on Kafka" style="font-size:var(--px-11_5);background:var(--panel);color:var(--error);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">Clear messages</span>
    </div>
  </div>

  <!-- filters -->
  <div style="flex:none;display:flex;gap:var(--px-8);padding:var(--px-6) var(--px-14)">
    <input bind:value={keyFilter} placeholder="filter key (regex)" class="cm-mini mono" style="flex:1" />
    <input bind:value={valFilter} placeholder="filter value (text)" class="cm-mini mono" style="flex:1" />
  </div>

  <!-- status / error line from librdkafka (so empty grid isn't a mystery) -->
  {#if statusMsg}
    <div
      style="flex:none;padding:var(--px-6) var(--px-14);font-size:var(--px-11_5);border-bottom:var(--px-1) solid var(--border);color:{statusLevel === 'error' ? 'var(--danger)' : 'var(--warn2)'};background:var(--surface)"
    >
      {statusLevel === 'error' ? '✕' : '⚠'} {statusMsg}
    </div>
  {/if}

  <!-- message table -->
  <div style="flex:1;overflow:auto;min-height:0">
    {#if messages.length === 0}
      <div style="padding:var(--px-16);text-align:center;font-size:var(--px-12);color:var(--muted)">
        {#if statusLevel === 'error'}
          Could not read messages — see the error above.
        {:else}
          {consuming ? 'Waiting for messages…' : 'Pick a start position then Consume.'}
        {/if}
      </div>
    {:else}
      <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12);{GRID_FONT}">
        <thead><tr>
          {#each ['Partition', 'Offset', 'Time', 'Key', 'Value', ''] as h (h)}
            <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-6) var(--px-12);text-align:left;color:var(--text2);font-weight:600;white-space:nowrap">{h}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each filtered as m, i (i)}
            {@const k = msgKey(m)}
            {@const sel = selKey === k}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
            <tr
              aria-selected={sel}
              onclick={() => (selKey = k)}
              onmouseenter={() => (hoverKey = k)}
              onmouseleave={() => (hoverKey === k ? (hoverKey = null) : null)}
              style="background:{rowBg(k)};cursor:default"
            >
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);color:{cellColor(k, 'var(--muted)')}">{m.partition}</td>
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);color:{cellColor(k, 'var(--hex-d19a66)')}">{m.offset}</td>
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);white-space:nowrap;font-weight:700;color:{cellColor(k, 'var(--warn2)')}">{fmtTs(m.timestamp)}</td>
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);color:{cellColor(k, 'var(--hex-61afef)')}">{m.key}</td>
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);color:{cellColor(k, 'var(--text)')};max-width:var(--px-420);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={decodeVal(m.value)}>{decodeVal(m.value)}</td>
              <!-- action icons recolour to white when selected so the blue highlight never hides them -->
              <td style="padding:var(--px-5) var(--px-8);border-bottom:var(--px-1) solid var(--border);white-space:nowrap">
                <span onclick={(e) => { e.stopPropagation(); viewJson(m) }} onkeydown={(e) => e.key === 'Enter' && viewJson(m)} role="button" tabindex="0" title="View value as JSON" style="cursor:pointer;color:{cellColor(k, 'var(--muted)')};margin-right:var(--px-6)">⛶</span>
                <span onclick={(e) => { e.stopPropagation(); copyMsg(m) }} onkeydown={(e) => e.key === 'Enter' && copyMsg(m)} role="button" tabindex="0" title="Copy message" style="cursor:pointer;color:{cellColor(k, 'var(--muted)')}">⧉</span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  {#if confirmState}
    <!-- backdrop click does NOT confirm/close (rule chung); use Cancel / Confirm / Escape -->
    <div
      role="presentation"
      style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:50"
    >
      <div
        role="dialog"
        aria-modal="true"
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => { if (e.key === 'Escape') confirmState = null; if (e.key === 'Enter') runConfirm() }}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);min-width:var(--px-320);max-width:var(--px-420);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">{confirmState.title}</div>
        <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">{confirmState.body}</div>
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span use:autofocus onclick={() => (confirmState = null)} onkeydown={(e) => e.key === 'Enter' && (confirmState = null)} role="button" tabindex="0" class="cm-mini" style="cursor:pointer">Cancel</span>
          <span onclick={runConfirm} onkeydown={(e) => e.key === 'Enter' && runConfirm()} role="button" tabindex="0" class="cm-mini danger" style="cursor:pointer">Confirm</span>
        </div>
      </div>
    </div>
  {/if}

  {#if viewState}
    <!-- backdrop click does NOT close (rule chung); use Close / Escape -->
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
          <span style="font-size:var(--px-14);font-weight:600;color:var(--text)">Message</span>
          <span class="mono" style="font-size:var(--px-11);color:var(--hex-c4b5fd)">{viewState.label}</span>
          {#if !viewState.isJson}<span style="font-size:var(--px-10_5);color:var(--muted)">(not JSON — raw value)</span>{/if}
          <span style="margin-left:auto;display:flex;gap:var(--px-8)">
            <span onclick={() => viewState && copyText(viewState.text)} onkeydown={(e) => e.key === 'Enter' && viewState && copyText(viewState.text)} role="button" tabindex="0" class="cm-mini" style="cursor:pointer">Copy</span>
            <span onclick={() => (viewState = null)} onkeydown={(e) => e.key === 'Enter' && (viewState = null)} role="button" tabindex="0" class="cm-mini" style="cursor:pointer">Close</span>
          </span>
        </div>
        <pre class="mono" style="flex:1;overflow:auto;margin:0;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-12);font-size:var(--px-12);line-height:1.5;color:var(--text);white-space:pre-wrap;word-break:break-word">{#if viewState.isJson}{#each highlightJson(viewState.text) as tok}<span style="color:{jsonTokenColor(tok.kind)}">{tok.text}</span>{/each}{:else}{viewState.text}{/if}</pre>
      </div>
    </div>
  {/if}
</div>

<style>
  .cm-mini {
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-4) var(--px-9);
    font-size: var(--px-12);
    color: var(--text);
    outline: none;
  }
  .cm-mini.danger {
    color: var(--hex-fff);
    background: var(--error);
    border-color: var(--error);
    font-weight: 600;
  }
</style>
