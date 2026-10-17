<script lang="ts">
  // Edit a Kafka topic's partition count. Kafka can only ADD partitions, so the
  // input never goes below the current count and the dialog says what changes:
  // keyed messages may map to a different partition from now on (per-key ordering
  // across the change is not guaranteed). Backdrop does not close it (rule chung).
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'

  interface Props {
    connId: string
    topic: string
    current: number
    onClose: () => void
    onDone: (total: number) => void
  }
  let { connId, topic, current, onClose, onDone }: Props = $props()

  // seeded once from the count the topic has when the dialog opens
  let wanted = $state(0)
  $effect.pre(() => {
    if (wanted === 0) wanted = current + 1
  })
  let busy = $state(false)
  let error = $state('')
  const problem = $derived(
    !Number.isInteger(wanted) || wanted < 1
      ? 'Enter a whole number of partitions.'
      : wanted < current
        ? `Kafka cannot reduce partitions — this topic has ${current}.`
        : wanted === current
          ? `The topic already has ${current} partition${current === 1 ? '' : 's'}.`
          : wanted > 10_000
            ? 'At most 10,000 partitions in one change.'
            : '',
  )
  const added = $derived(problem ? 0 : wanted - current)

  async function apply() {
    if (problem || busy) return
    busy = true
    error = ''
    try {
      await ipc.kafkaSetPartitions(connId, topic, wanted)
      toasts.success(`${topic}: ${current} → ${wanted} partitions`, 'kafka')
      onDone(wanted)
    } catch (e) {
      error = String(e)
    } finally {
      busy = false
    }
  }
  const focusInput = (node: HTMLInputElement) => {
    node.focus()
    node.select()
  }
</script>

<div role="presentation" class="kp-backdrop">
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Edit partitions"
    tabindex="-1"
    class="kp"
    onkeydown={(e) => {
      if (e.key === 'Escape' && !busy) onClose()
      if (e.key === 'Enter') apply()
    }}
  >
    <div class="kp-head">
      <div class="kp-title">Edit partitions</div>
      <div class="kp-sub" title={topic}>Topic <b>{topic}</b></div>
    </div>

    <div class="kp-body">
      <div class="kp-row">
        <div class="kp-now">
          <span class="kp-label">Now</span>
          <span class="kp-big ds-num">{current}</span>
        </div>
        <span class="kp-arrow" aria-hidden="true">→</span>
        <label class="kp-new">
          <span class="kp-label">New count</span>
          <input
            type="number"
            min={current + 1}
            max="10000"
            step="1"
            class="ds-control ds-num kp-input"
            aria-label="New partition count"
            bind:value={wanted}
            use:focusInput
          />
        </label>
        <div class="kp-quick" role="group" aria-label="Quick picks">
          {#each [['+1', current + 1], ['+2', current + 2], ['×2', current * 2]] as [label, n] (label)}
            <span role="button" tabindex="0" class="eg-btn" onclick={() => (wanted = n as number)} onkeydown={(e) => e.key === 'Enter' && (wanted = n as number)}>{label}</span>
          {/each}
        </div>
      </div>

      {#if problem}
        <div class="kp-msg warn" data-testid="partitions-problem">{problem}</div>
      {:else}
        <div class="kp-msg ok">Adds <b>{added}</b> partition{added === 1 ? '' : 's'} ({current} → {wanted}).</div>
      {/if}

      <ul class="kp-notes">
        <li>Kafka can only <b>add</b> partitions — this cannot be undone.</li>
        <li>Existing messages stay where they are; new partitions start empty.</li>
        <li>Producers that pick a partition by key may send a key to a different partition from now on, so ordering per key across the change is not guaranteed.</li>
      </ul>

      {#if error}
        <div class="kp-msg bad" role="alert">{error}</div>
      {/if}
    </div>

    <div class="kp-foot">
      <span role="button" tabindex="0" class="cfm-btn" onclick={() => !busy && onClose()} onkeydown={(e) => e.key === 'Enter' && !busy && onClose()}>Cancel</span>
      <span
        role="button"
        tabindex="0"
        class="cfm-btn primary"
        aria-disabled={!!problem || busy}
        onclick={apply}
        onkeydown={(e) => e.key === 'Enter' && apply()}
      >{busy ? 'Applying…' : 'Add partitions'}</span>
    </div>
  </div>
</div>

<style>
  .kp-backdrop {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--rgba-0-0-0-_5);
  }
  .kp {
    width: min(var(--px-520), 92vw);
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-14);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    outline: none;
  }
  .kp-head {
    padding: var(--px-16) var(--px-20) var(--px-12);
    border-bottom: var(--px-1) solid var(--border);
  }
  .kp-title {
    font-size: var(--px-16);
    font-weight: 650;
    color: var(--text);
  }
  .kp-sub {
    font-size: var(--px-12_5);
    color: var(--muted);
    margin-top: var(--px-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .kp-sub b {
    color: var(--text2);
  }
  .kp-body {
    padding: var(--px-16) var(--px-20);
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
  }
  .kp-row {
    display: flex;
    align-items: flex-end;
    gap: var(--px-14);
    flex-wrap: wrap;
  }
  .kp-now,
  .kp-new {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
  }
  .kp-label {
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
  }
  .kp-big {
    font-size: var(--px-24);
    font-weight: 650;
    color: var(--text);
    line-height: 1.2;
  }
  .kp-arrow {
    font-size: var(--px-18);
    color: var(--muted);
    padding-bottom: var(--px-4);
  }
  .kp-input {
    width: var(--px-110);
    font-size: var(--px-15) !important;
  }
  .kp-quick {
    display: flex;
    gap: var(--px-6);
    padding-bottom: var(--px-2);
  }
  .kp-msg {
    font-size: var(--px-12_5);
    border-radius: var(--px-8);
    padding: var(--px-8) var(--px-12);
  }
  .kp-msg.ok {
    color: var(--sacc-green);
    background: color-mix(in srgb, var(--sacc-green) 10%, transparent);
  }
  .kp-msg.warn {
    color: var(--sacc-amber);
    background: color-mix(in srgb, var(--sacc-amber) 12%, transparent);
  }
  .kp-msg.bad {
    color: var(--danger-text);
    background: var(--danger-soft);
    word-break: break-word;
  }
  .kp-notes {
    margin: 0;
    list-style: disc;
    padding-left: var(--px-18);
    font-size: var(--px-12);
    color: var(--muted);
    line-height: 1.55;
  }
  .kp-foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--px-8);
    padding: var(--px-12) var(--px-20);
    border-top: var(--px-1) solid var(--border);
    background: var(--panel);
  }
</style>
