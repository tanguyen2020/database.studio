<script lang="ts">
  // Kafka Producer (Phase 4 · T5): topic + key + value + partition → Produce →
  // hiện partition/offset đã land + lịch sử message đã gửi (reuse).
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { TabState } from '$lib/types'
  import type { ProduceDraft } from '$lib/stream/kafka-produce'

  interface Props {
    tab: TabState
    /** inside the Kafka workspace's topic details: no title block of its own */
    embedded?: boolean
    /** "Copy to Produce": a message copied from the Messages screen */
    draft?: ProduceDraft | null
  }
  let { tab, embedded = false, draft = null }: Props = $props()

  // svelte-ignore state_referenced_locally
  let topic = $state((tab.state as { topic?: string }).topic ?? '')
  let key = $state('')
  let value = $state('')
  let partition = $state('') // '' = auto
  // a copied message fills the form once (later edits are the user's)
  // svelte-ignore state_referenced_locally
  if (draft) {
    key = draft.key
    value = draft.value
  }
  let sent = $state<{ topic: string; key: string; value: string; partition: number; offset: number }[]>([])

  async function produce() {
    if (!tab.connectionId || !topic.trim()) return
    const part = partition.trim() === '' ? null : parseInt(partition, 10)
    try {
      const res = await ipc.kafkaProduce(tab.connectionId, topic.trim(), key, value, Number.isNaN(part as number) ? null : part)
      toasts.success(`Produced → partition ${res.partition}, offset ${res.offset}`)
      sent = [{ topic: topic.trim(), key, value, partition: res.partition, offset: res.offset }, ...sent].slice(0, 50)
    } catch (e) {
      toasts.error(`Produce failed: ${e}`)
    }
  }

  const draftHeaderNote = (n: number) =>
    `${n === 1 ? 'Its header is' : `Its ${n} headers are`} not sent — Produce sends the key and value only.`

  function reuse(m: { key: string; value: string }) {
    key = m.key
    value = m.value
  }
</script>

<div class="ds-ws">
  {#if !embedded}
  <div class="ds-ws-head">
    <span class="ds-ws-icon" style="color:var(--sacc-purple);background:color-mix(in srgb, var(--sacc-purple) 13%, transparent)" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h12" /><path d="m12 6 6 6-6 6" /><path d="M20 5v14" /></svg>
    </span>
    <div class="ds-ws-titles">
      <span class="ds-ws-title">Kafka Producer</span>
      <span class="ds-ws-sub">Send a message to a topic</span>
    </div>
  </div>
  {/if}

  <div class="ds-body">
    {#if draft}
      <div class="kp-copied" data-produce-copied>
        <div>Copied from partition {draft.from.partition}, offset {draft.from.offset}. Edit it if needed, then Produce.</div>
        {#if draft.headers}<div>{draftHeaderNote(draft.headers)}</div>{/if}
        {#if draft.binary}<div><b>This value is binary.</b> It is sent as text, so the bytes will not match the original.</div>{/if}
      </div>
    {/if}
    <section class="ds-section" style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-12);padding:var(--px-16);box-shadow:var(--shadow-xs)">
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:var(--px-12)">
        <label class="kp-field">
          <span class="pl">Topic</span>
          <!-- in a topic's details the message goes to THAT topic: not editable there -->
          <input bind:value={topic} class="ds-control" style="width:100%" readonly={embedded} title={embedded ? 'Messages go to the topic these details are about' : undefined} />
        </label>
        <label class="kp-field">
          <span class="pl">Partition <span class="pl-hint">empty = auto</span></span>
          <input bind:value={partition} placeholder="auto" class="ds-control ds-num" style="width:100%" />
        </label>
        <label class="kp-field" style="grid-column:1/3">
          <span class="pl">Key <span class="pl-hint">optional</span></span>
          <input bind:value={key} class="ds-control mono" style="width:100%" />
        </label>
        <label class="kp-field" style="grid-column:1/3">
          <span class="pl">Value</span>
          <textarea bind:value class="ds-control mono" style="width:100%;height:auto;min-height:var(--px-140);padding:var(--px-8) var(--px-10);resize:vertical;line-height:1.5"></textarea>
        </label>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:var(--px-4)">
        <span onclick={produce} onkeydown={(e) => e.key === 'Enter' && produce()} role="button" tabindex="0" class="cfm-btn primary">Produce</span>
      </div>
    </section>

    {#if sent.length > 0}
      <section class="ds-section">
        <div class="ds-section-title">Sent <span class="ds-count">{sent.length}</span><span style="font-weight:400;color:var(--muted);font-size:var(--px-12)">click a row to reuse it</span></div>
        <table class="ds-table" style="font-size:var(--px-12)">
          <thead><tr>
            {#each ['Partition', 'Offset', 'Key', 'Value'] as h (h)}
              <th>{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each sent as m, i (i)}
              <tr onclick={() => reuse(m)} onkeydown={(e) => e.key === 'Enter' && reuse(m)} role="button" tabindex="0" style="cursor:pointer">
                <td class="ds-num" style="color:var(--muted);width:1%">{m.partition}</td>
                <td class="ds-num" style="color:var(--syntax-number);width:1%">{m.offset}</td>
                <td class="mono" style="color:var(--syntax-function)">{m.key}</td>
                <td class="mono" style="color:var(--syntax-string);max-width:var(--px-420);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{m.value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  </div>
</div>

<style>
  .kp-copied {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
    padding: var(--px-10) var(--px-12);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    background: var(--panel);
    color: var(--text2);
    font-size: var(--px-12_5);
    line-height: 1.5;
  }
  .kp-field {
    display: flex;
    flex-direction: column;
    gap: var(--px-6);
    min-width: 0;
  }
  .pl {
    font-size: var(--px-12);
    color: var(--text2);
    font-weight: 600;
  }
  .pl-hint {
    color: var(--muted);
    font-weight: 400;
    margin-left: var(--px-4);
  }
</style>
