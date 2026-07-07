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
  // Newest first: sort by timestamp desc, tie-break on sequence desc.
  const timeKey = (m: ipc.NatsJsMessage) => {
    const t = new Date(m.time).getTime()
    return Number.isNaN(t) ? m.seq : t
  }
  const sortedMessages = $derived([...messages].sort((a, b) => timeKey(b) - timeKey(a) || b.seq - a.seq))
  // Show the exact server-stored (UTC) clock, just prettified: "YYYY-MM-DD HH:mm:ss".
  const fmtTime = (t: string) => t.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, '')
  let loading = $state(false)
  let loaded = $state(false)
  let error = $state('')

  // In-app confirm popup (window.confirm isn't reliable inside the Tauri webview).
  let confirmState = $state<{ title: string; body: string; danger: boolean; run: () => void } | null>(null)
  function askConfirm(title: string, body: string, run: () => void) {
    confirmState = { title, body, danger: true, run }
  }

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

  async function copyMsg(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Message copied', 'nats')
  }
  // Delete a single JetStream message by sequence (real removal from the stream).
  function deleteMsg(seq: number) {
    askConfirm('Delete this message', `Delete message #${seq} from stream "${stream}"? This cannot be undone.`, async () => {
      if (!tab.connectionId) return
      try {
        await ipc.natsJsDeleteMessage(tab.connectionId, stream, seq)
        messages = messages.filter((m) => m.seq !== seq)
        toasts.success(`Deleted message #${seq}`, 'nats')
      } catch (e) {
        toasts.error(String(e), 'nats')
      }
    })
  }

  function clearMessages() {
    askConfirm('Clear messages', `Clear all messages of subject "${subject}"? This cannot be undone.`, async () => {
      if (!tab.connectionId) return
      try {
        await ipc.natsJsPurgeSubject(tab.connectionId, stream, subject)
        toasts.success(`Cleared messages of ${subject}`, 'nats')
        explorer.refreshStreaming(tab.connectionId)
        await load()
      } catch (e) {
        toasts.error(String(e), 'nats')
      }
    })
  }

  function runConfirm() {
    const c = confirmState
    confirmState = null
    c?.run()
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative">
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
          {#each [['Seq', 'width:var(--px-90)'], ['Time', 'width:var(--px-180)'], ['Payload', ''], ['', 'width:var(--px-70)']] as [h, extra] (h)}
            <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-12);text-align:left;color:var(--text2);font-weight:600;{extra}">{h}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each sortedMessages as m (m.seq)}
            <tr>
              <td class="mono" style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:var(--muted)">{m.seq}</td>
              <td class="mono" style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);font-weight:700;color:var(--warn2)">{fmtTime(m.time)}</td>
              <td class="mono" style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-12);color:var(--text);white-space:pre-wrap;word-break:break-all">{m.payload}</td>
              <td style="border-bottom:var(--px-1) solid var(--border);padding:var(--px-6) var(--px-8);white-space:nowrap">
                <span onclick={() => copyMsg(m.payload)} onkeydown={(e) => e.key === 'Enter' && copyMsg(m.payload)} role="button" tabindex="0" title="Copy message" style="cursor:pointer;color:var(--muted)">⧉</span>
                <span onclick={() => deleteMsg(m.seq)} onkeydown={(e) => e.key === 'Enter' && deleteMsg(m.seq)} role="button" tabindex="0" title="Delete this message (by sequence)" style="cursor:pointer;color:var(--error);font-size:var(--px-13);margin-left:var(--px-6)">×</span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>

  {#if confirmState}
    <div
      role="presentation"
      onclick={() => (confirmState = null)}
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
          <span onclick={() => (confirmState = null)} onkeydown={(e) => e.key === 'Enter' && (confirmState = null)} role="button" tabindex="0" class="eg-btn">Cancel</span>
          <span onclick={runConfirm} onkeydown={(e) => e.key === 'Enter' && runConfirm()} role="button" tabindex="0" class="eg-btn danger">Confirm</span>
        </div>
      </div>
    </div>
  {/if}
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
  .eg-btn.danger {
    color: var(--hex-fff);
    background: var(--error);
    border-color: var(--error);
  }
</style>
