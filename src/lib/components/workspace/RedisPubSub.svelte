<script lang="ts">
  // Redis Pub/Sub Monitor — port 1:1 từ Database Studio.dc.html dòng 825-856:
  // header (pattern input + Subscribe/Stop + Clear + count) · stream message
  // (ts · channel · payload) · footer publish (channel + message).
  // Message thật đến qua Tauri event "redis-pubsub" (backend task nền). Ngoài
  // Tauri (demo/browser) không có stream — form vẫn render.
  import { onDestroy, onMount } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { IS_TAURI } from '$lib/demo'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  let pattern = $state('orders.*')
  let subscribed = $state(false)
  let paused = $state(false)
  let messages = $state<{ ts: string; channel: string; payload: string }[]>([])
  let pubChannel = $state('')
  let pubMsg = $state('')
  let unlisten: (() => void) | null = null

  // glob chars → dùng PSUBSCRIBE (pattern), còn lại SUBSCRIBE (channel đúng tên)
  function isPattern(s: string): boolean {
    return /[*?[\]]/.test(s)
  }

  function now(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  }

  onMount(async () => {
    if (!IS_TAURI) return
    const { listen } = await import('@tauri-apps/api/event')
    unlisten = await listen<ipc.RedisPubSubMsg>('redis-pubsub', (e) => {
      if (e.payload.conn_id !== tab.connectionId || paused) return
      messages = [{ ts: now(), channel: e.payload.channel, payload: e.payload.payload }, ...messages].slice(0, 1000)
    })
  })

  onDestroy(() => {
    unlisten?.()
    if (subscribed && tab.connectionId) void ipc.redisUnsubscribe(tab.connectionId)
  })

  async function toggle() {
    if (!tab.connectionId) return
    if (subscribed) {
      await ipc.redisUnsubscribe(tab.connectionId).catch(() => {})
      subscribed = false
      return
    }
    const p = pattern.trim()
    if (!p) return
    const channels = isPattern(p) ? [] : [p]
    const patterns = isPattern(p) ? [p] : []
    try {
      await ipc.redisSubscribe(tab.connectionId, channels, patterns)
      subscribed = true
      if (!IS_TAURI) toasts.show('Streaming only works in the Tauri app (not the browser demo)')
    } catch (e) {
      toasts.error(`Subscribe failed: ${e}`)
    }
  }

  async function publish() {
    if (!tab.connectionId || !pubChannel.trim()) return
    try {
      const n = await ipc.redisPublish(tab.connectionId, pubChannel.trim(), pubMsg)
      toasts.success(`PUBLISH → ${n} subscriber`)
      pubMsg = ''
    } catch (e) {
      toasts.error(`Publish failed: ${e}`)
    }
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <!-- header — dòng 828-838 -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:#D82C20"></span>
    <span style="font-weight:700;font-size:var(--px-13)">Pub/Sub Monitor</span>
    <div style="display:flex;align-items:center;gap:var(--px-6);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-7);padding:var(--px-4) var(--px-9);width:var(--px-220)">
      <span style="color:var(--muted);font-size:var(--px-11)">pattern</span>
      <input bind:value={pattern} placeholder="orders.*" class="mono" style="border:none;background:transparent;color:var(--text);font-size:var(--px-12);outline:none;width:100%" />
    </div>
    <span onclick={toggle} onkeydown={(e) => e.key === 'Enter' && toggle()} role="button" tabindex="0" style="font-size:var(--px-11_5);background:{subscribed ? '#D82C20' : 'var(--panel)'};color:{subscribed ? 'var(--hex-fff)' : 'var(--text)'};border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer;font-weight:600">{subscribed ? 'Stop' : 'Subscribe'}</span>
    <span onclick={() => (paused = !paused)} onkeydown={(e) => e.key === 'Enter' && (paused = !paused)} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">{paused ? 'Resume' : 'Pause'}</span>
    <span onclick={() => (messages = [])} onkeydown={(e) => e.key === 'Enter' && (messages = [])} role="button" tabindex="0" style="font-size:var(--px-11_5);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-5) var(--px-12);cursor:pointer">Clear</span>
    <span style="margin-left:auto;font-size:var(--px-11);color:var(--muted)">{messages.length} msgs{subscribed ? ' · live' : ''}</span>
  </div>

  <!-- stream — dòng 839-847 -->
  <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-6) 0">
    {#if messages.length === 0}
      <div style="padding:var(--px-16) var(--px-16);text-align:center;font-size:var(--px-12);color:var(--muted)">
        {subscribed ? 'Waiting for messages…' : 'Enter a pattern then Subscribe for real-time messages.'}
      </div>
    {:else}
      {#each messages as m, i (i)}
        <div style="display:flex;gap:var(--px-12);padding:var(--px-6) var(--px-16);border-bottom:var(--px-1) solid var(--border);align-items:baseline">
          <span class="mono" style="flex:none;font-size:var(--px-10_5);color:var(--muted);width:var(--px-96)">{m.ts}</span>
          <span class="mono" style="flex:none;font-size:var(--px-11_5);color:#D82C20;font-weight:600;width:var(--px-150);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{m.channel}</span>
          <span class="mono" style="flex:1;min-width:0;font-size:var(--px-11_5);color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{m.payload}</span>
        </div>
      {/each}
    {/if}
  </div>

  <!-- publish — dòng 848-854 -->
  <div style="flex:none;border-top:var(--px-1) solid var(--border);background:var(--surface);padding:var(--px-10) var(--px-14);display:flex;gap:var(--px-8);align-items:center">
    <span style="font-size:var(--px-11);color:var(--muted);flex:none">Channel</span>
    <input bind:value={pubChannel} class="mono" style="flex:none;width:var(--px-170);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-9);font-size:var(--px-12);color:var(--text);outline:none" />
    <span style="font-size:var(--px-11);color:var(--muted);flex:none">Message</span>
    <input bind:value={pubMsg} onkeydown={(e) => e.key === 'Enter' && publish()} class="mono" style="flex:1;min-width:0;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-9);font-size:var(--px-12);color:var(--text);outline:none" />
    <span onclick={publish} onkeydown={(e) => e.key === 'Enter' && publish()} role="button" tabindex="0" style="flex:none;font-size:var(--px-11_5);background:#D82C20;color:var(--hex-fff);border-radius:var(--px-6);padding:var(--px-6) var(--px-14);cursor:pointer;font-weight:600">Publish</span>
  </div>
</div>
