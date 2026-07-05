<script lang="ts">
  // Kafka Message Consumer (Phase 4 · T4) — port dòng 718-752: header (start pos +
  // partition + Consume/Pause/Stop/Clear + decode) + bảng message (partition/offset/
  // ts/key/value) + filter key regex / value text. Stream qua event "kafka-msg".
  import { onDestroy, onMount } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const topic = $derived((tab.state as { topic?: string }).topic ?? '')

  let from = $state<'earliest' | 'latest' | 'offset'>('latest')
  let offset = $state(0)
  let partition = $state<string>('') // '' = all
  let consuming = $state(false)
  let paused = $state(false)
  let decode = $state<'utf8' | 'json' | 'raw'>('utf8')
  let keyFilter = $state('')
  let valFilter = $state('')
  const MAX = 500
  let messages = $state<ipc.KafkaMsg[]>([])
  let unlisten: (() => void) | null = null

  function fmtTs(ms: number): string {
    if (!ms) return ''
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
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

  onMount(async () => {
    if (!IS_TAURI) return
    const { listen } = await import('@tauri-apps/api/event')
    unlisten = await listen<ipc.KafkaMsg>('kafka-msg', (e) => {
      if (e.payload.conn_id !== tab.connectionId || paused) return
      messages = [e.payload, ...messages].slice(0, MAX)
    })
  })

  onDestroy(() => {
    unlisten?.()
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
    try {
      await ipc.kafkaConsume(tab.connectionId, topic, from, offset, Number.isNaN(part as number) ? null : part)
      consuming = true
      if (!IS_TAURI) toasts.show('Streaming only works in the Tauri app (not the browser demo)')
    } catch (e) {
      toasts.error(`Consume failed: ${e}`)
    }
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- header -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:#8B5CF6"></span>
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
      <span onclick={toggle} onkeydown={(e) => e.key === 'Enter' && toggle()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:{consuming ? '#8B5CF6' : 'var(--panel)'};color:{consuming ? 'var(--hex-fff)' : 'var(--text)'};border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">{consuming ? 'Stop' : 'Consume'}</span>
      <span onclick={() => (paused = !paused)} onkeydown={(e) => e.key === 'Enter' && (paused = !paused)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">{paused ? 'Resume' : 'Pause'}</span>
      <span onclick={() => (messages = [])} onkeydown={(e) => e.key === 'Enter' && (messages = [])} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">Clear</span>
    </div>
  </div>

  <!-- filters -->
  <div style="flex:none;display:flex;gap:var(--px-8);padding:var(--px-6) var(--px-14)">
    <input bind:value={keyFilter} placeholder="filter key (regex)" class="cm-mini mono" style="flex:1" />
    <input bind:value={valFilter} placeholder="filter value (text)" class="cm-mini mono" style="flex:1" />
  </div>

  <!-- message table -->
  <div style="flex:1;overflow:auto;min-height:0">
    {#if messages.length === 0}
      <div style="padding:var(--px-16);text-align:center;font-size:var(--px-12);color:var(--muted)">
        {consuming ? 'Waiting for messages…' : 'Pick a start position then Consume.'}
      </div>
    {:else}
      <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12)">
        <thead><tr>
          {#each ['Partition', 'Offset', 'Time', 'Key', 'Value'] as h (h)}
            <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-6) var(--px-12);text-align:left;color:var(--text2);font-weight:600;white-space:nowrap">{h}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each filtered as m, i (i)}
            <tr>
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{m.partition}</td>
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);color:#d19a66">{m.offset}</td>
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{fmtTs(m.timestamp)}</td>
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);color:#61afef">{m.key}</td>
              <td style="padding:var(--px-5) var(--px-12);border-bottom:var(--px-1) solid var(--border);color:#98c379;max-width:var(--px-420);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{decodeVal(m.value)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
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
</style>
