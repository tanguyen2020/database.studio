<script lang="ts">
  // Kafka Producer (Phase 4 · T5): topic + key + value + partition → Produce →
  // hiện partition/offset đã land + lịch sử message đã gửi (reuse).
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  // svelte-ignore state_referenced_locally
  let topic = $state((tab.state as { topic?: string }).topic ?? '')
  let key = $state('')
  let value = $state('')
  let partition = $state('') // '' = auto
  let sent = $state<{ topic: string; key: string; value: string; partition: number; offset: number }[]>([])

  async function produce() {
    if (!tab.connectionId || !topic.trim()) return
    const part = partition.trim() === '' ? null : parseInt(partition, 10)
    try {
      const res = await ipc.kafkaProduce(tab.connectionId, topic.trim(), key, value, Number.isNaN(part as number) ? null : part)
      toasts.success(`Produced → partition ${res.partition}, offset ${res.offset}`)
      sent = [{ topic: topic.trim(), key, value, partition: res.partition, offset: res.offset }, ...sent].slice(0, 50)
    } catch (e) {
      toasts.error(`Produce thất bại: ${e}`)
    }
  }

  function reuse(m: { key: string; value: string }) {
    key = m.key
    value = m.value
  }
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0;padding:var(--px-14);gap:var(--px-10);overflow:auto">
  <div style="display:flex;align-items:center;gap:var(--px-10)">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:#8B5CF6"></span>
    <span style="font-weight:700;font-size:var(--px-13)">Kafka Producer</span>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--px-10)">
    <div>
      <div class="pl">Topic</div>
      <input bind:value={topic} class="pi mono" />
    </div>
    <div>
      <div class="pl">Partition <span style="color:var(--muted);font-weight:400">(trống = auto)</span></div>
      <input bind:value={partition} placeholder="auto" class="pi mono" />
    </div>
    <div style="grid-column:1/3">
      <div class="pl">Key <span style="color:var(--muted);font-weight:400">(optional)</span></div>
      <input bind:value={key} class="pi mono" />
    </div>
    <div style="grid-column:1/3">
      <div class="pl">Value</div>
      <textarea bind:value class="pi mono" style="min-height:var(--px-120);resize:vertical"></textarea>
    </div>
  </div>

  <div style="display:flex;justify-content:flex-end">
    <span onclick={produce} onkeydown={(e) => e.key === 'Enter' && produce()} role="button" tabindex="0" style="font-size:var(--px-12);background:#8B5CF6;color:var(--hex-fff);border-radius:var(--px-7);padding:var(--px-7) var(--px-18);cursor:pointer;font-weight:600">Produce</span>
  </div>

  {#if sent.length > 0}
    <div class="pl" style="margin-top:var(--px-8)">Đã gửi (click để dùng lại)</div>
    <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-11_5)">
      <thead><tr>
        {#each ['Partition', 'Offset', 'Key', 'Value'] as h (h)}
          <th style="text-align:left;padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border2);color:var(--text2);font-weight:600">{h}</th>
        {/each}
      </tr></thead>
      <tbody>
        {#each sent as m, i (i)}
          <tr onclick={() => reuse(m)} onkeydown={(e) => e.key === 'Enter' && reuse(m)} role="button" tabindex="0" style="cursor:pointer">
            <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:var(--muted)">{m.partition}</td>
            <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:#d19a66">{m.offset}</td>
            <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:#61afef">{m.key}</td>
            <td style="padding:var(--px-5) var(--px-10);border-bottom:var(--px-1) solid var(--border);color:#98c379;max-width:var(--px-420);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{m.value}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .pl {
    font-size: var(--px-11);
    color: var(--muted);
    margin-bottom: var(--px-4);
    font-weight: 600;
  }
  .pi {
    width: 100%;
    box-sizing: border-box;
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    padding: var(--px-8) var(--px-10);
    font-size: var(--px-12_5);
    color: var(--text);
    outline: none;
  }
</style>
