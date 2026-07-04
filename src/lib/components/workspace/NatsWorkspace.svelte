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

  function now(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  onMount(async () => {
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
      if (!IS_TAURI) toasts.show('Stream chỉ hoạt động trong app Tauri (không phải browser demo)')
    } catch (e) {
      toasts.error(`Subscribe thất bại: ${e}`)
    }
  }

  async function publish() {
    if (!tab.connectionId || !pubSubject.trim()) return
    try {
      await ipc.natsPublish(tab.connectionId, pubSubject.trim(), pubMsg)
      toasts.success(`Đã publish → ${pubSubject.trim()}`)
      pubMsg = ''
    } catch (e) {
      toasts.error(`Publish thất bại: ${e}`)
    }
  }

  async function request() {
    if (!tab.connectionId || !reqSubject.trim()) return
    reqReply = null
    try {
      reqReply = await ipc.natsRequest(tab.connectionId, reqSubject.trim(), reqMsg, 3000)
    } catch (e) {
      reqReply = null
      toasts.error(`Request thất bại: ${e}`)
    }
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- header — dòng 770-781 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface);flex-wrap:wrap">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:#27AE60"></span>
    <span style="font-size:var(--px-12);color:var(--text2)">Subscribe</span>
    <input bind:value={subject} class="mono" style="font-size:var(--px-13);font-weight:600;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-4) var(--px-12);color:var(--text);outline:none;min-width:var(--px-150)" />
    <span style="display:flex;align-items:center;gap:var(--px-6);font-size:var(--px-11_5);color:{subscribed ? '#27AE60' : 'var(--muted)'};font-weight:600"><span style="width:var(--px-7);height:var(--px-7);border-radius:50%;background:{subscribed ? '#27AE60' : 'var(--border2)'}"></span>{subscribed ? 'LIVE' : 'idle'}</span>
    <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      {#if info}<span class="mono" style="font-size:var(--px-10_5);color:var(--muted)">NATS {info.version} · {info.server_name}</span>{/if}
      <span onclick={toggle} onkeydown={(e) => e.key === 'Enter' && toggle()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:{subscribed ? '#27AE60' : 'var(--panel)'};color:{subscribed ? 'var(--hex-fff)' : 'var(--text)'};border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">{subscribed ? 'Stop' : 'Subscribe'}</span>
      <span onclick={() => (paused = !paused)} onkeydown={(e) => e.key === 'Enter' && (paused = !paused)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">{paused ? 'Resume' : 'Pause'}</span>
      <span onclick={() => (messages = [])} onkeydown={(e) => e.key === 'Enter' && (messages = [])} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">Clear</span>
    </div>
  </div>

  <!-- message stream — dòng 782-789 -->
  <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-8) 0">
    {#if messages.length === 0}
      <div style="padding:var(--px-16);text-align:center;font-size:var(--px-12);color:var(--muted)">
        {subscribed ? 'Đang chờ message…' : 'Nhập subject (vd orders.>) rồi Subscribe.'}
      </div>
    {:else}
      {#each messages as m, i (i)}
        <div style="display:flex;gap:var(--px-12);padding:var(--px-7) var(--px-16);border-bottom:var(--px-1) solid var(--border);align-items:baseline">
          <span class="mono" style="flex:none;font-size:var(--px-10_5);color:var(--muted);width:var(--px-84)">{m.ts}</span>
          <span class="mono" style="flex:none;font-size:var(--px-11_5);color:#27AE60;font-weight:600;width:var(--px-150);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{m.subject}</span>
          <span class="mono" style="flex:1;min-width:0;font-size:var(--px-11_5);color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{m.payload}</span>
        </div>
      {/each}
    {/if}
  </div>

  <!-- publish + request/reply -->
  <div style="flex:none;border-top:var(--px-1) solid var(--border);background:var(--surface);padding:var(--px-10) var(--px-14);display:flex;flex-direction:column;gap:var(--px-8)">
    <div style="display:flex;gap:var(--px-8);align-items:center">
      <span style="font-size:var(--px-11);color:var(--muted);flex:none;width:var(--px-60)">Publish</span>
      <input bind:value={pubSubject} placeholder="subject" class="mono" style="flex:none;width:var(--px-170);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-9);font-size:var(--px-12);color:var(--text);outline:none" />
      <input bind:value={pubMsg} onkeydown={(e) => e.key === 'Enter' && publish()} placeholder="payload" class="mono" style="flex:1;min-width:0;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-9);font-size:var(--px-12);color:var(--text);outline:none" />
      <span onclick={publish} onkeydown={(e) => e.key === 'Enter' && publish()} role="button" tabindex="0" style="flex:none;font-size:var(--px-11_5);background:#27AE60;color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600">Publish</span>
    </div>
    <div style="display:flex;gap:var(--px-8);align-items:center">
      <span style="font-size:var(--px-11);color:var(--muted);flex:none;width:var(--px-60)">Request</span>
      <input bind:value={reqSubject} placeholder="subject" class="mono" style="flex:none;width:var(--px-170);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-9);font-size:var(--px-12);color:var(--text);outline:none" />
      <input bind:value={reqMsg} onkeydown={(e) => e.key === 'Enter' && request()} placeholder="payload" class="mono" style="flex:1;min-width:0;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-9);font-size:var(--px-12);color:var(--text);outline:none" />
      <span onclick={request} onkeydown={(e) => e.key === 'Enter' && request()} role="button" tabindex="0" style="flex:none;font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600">Request ▸</span>
    </div>
    {#if reqReply != null}
      <div class="mono" style="font-size:var(--px-11_5);color:var(--text2);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-9);white-space:pre-wrap;word-break:break-word">↩ {reqReply}</div>
    {/if}
  </div>
</div>
