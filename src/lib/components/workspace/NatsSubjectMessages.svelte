<script lang="ts">
  // NATS JetStream subject messages — browse existing messages of a subject within
  // a stream (server-side filtered fetch), with Clear (purge subject) + Refresh.
  import * as ipc from '$lib/ipc'
  import { systemMeta } from '$lib/systems'
  import { toasts } from '$lib/stores/toast.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()
  const stream = $derived((tab.state as { stream?: string }).stream ?? '')
  const subject = $derived((tab.state as { subject?: string }).subject ?? '')
  const accent = $derived(systemMeta('nats').accent)

  let messages = $state<ipc.NatsJsMessage[]>([])
  let loading = $state(false)
  let loaded = $state(false)
  let error = $state('')

  async function load() {
    if (!tab.connectionId) return
    loading = true
    error = ''
    try {
      messages = await ipc.natsJsSubjectMessages(tab.connectionId, stream, subject, 200)
      loaded = true
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    if (!loaded && tab.connectionId) void load()
  })

  async function clearMessages() {
    if (!tab.connectionId) return
    if (!confirm(`Clear all messages of subject "${subject}"? This cannot be undone.`)) return
    try {
      await ipc.natsJsPurgeSubject(tab.connectionId, stream, subject)
      toasts.success(`Cleared messages of ${subject}`, 'nats')
      explorer.refreshStreaming(tab.connectionId)
      await load()
    } catch (e) {
      toasts.error(String(e), 'nats')
    }
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0">
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-12);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:{accent}"></span>
    <div style="display:flex;flex-direction:column;line-height:1.15">
      <span class="mono" style="font-size:var(--px-13);font-weight:600;color:var(--text)">{subject}</span>
      <span class="mono" style="font-size:var(--px-10);color:var(--muted)">stream {stream}</span>
    </div>
    <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      <span style="font-size:var(--px-11);color:var(--muted)">{messages.length} message(s)</span>
      <span onclick={load} onkeydown={(e) => e.key === 'Enter' && load()} role="button" tabindex="0" class="eg-btn">⟳ Refresh</span>
      <span onclick={clearMessages} onkeydown={(e) => e.key === 'Enter' && clearMessages()} role="button" tabindex="0" class="eg-btn" style="color:var(--error)">Clear messages</span>
    </div>
  </div>

  <div style="flex:1;overflow:auto;min-height:0">
    {#if loading}
      <div style="padding:var(--px-20);color:var(--muted);font-size:var(--px-12)">Loading…</div>
    {:else if error}
      <div style="padding:var(--px-20);color:var(--error);font-size:var(--px-12)">{error}</div>
    {:else if messages.length === 0}
      <div style="padding:var(--px-20);color:var(--muted);font-size:var(--px-12)">No messages retained for this subject.</div>
    {:else}
      <table style="border-collapse:collapse;width:100%;font-size:var(--px-12)">
        <thead><tr>
          {#each [['Seq', 'width:var(--px-90)'], ['Subject', 'width:var(--px-200)'], ['Time', 'width:var(--px-180)'], ['Payload', '']] as [h, extra] (h)}
            <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each messages as m (m.seq)}
            <tr>
              <td class="mono" style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:var(--muted)">{m.seq}</td>
              <td class="mono" style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:var(--syntax-type)">{m.subject}</td>
              <td class="mono" style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:var(--muted)">{m.time}</td>
              <td class="mono" style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:var(--text);white-space:pre-wrap;word-break:break-all">{m.payload}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
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
</style>
