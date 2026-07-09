<script lang="ts">
  // Kafka "Add topic" dialog. Creates a topic with a name + partition count +
  // replication factor. Opens focused on the name field. Backdrop click does NOT
  // close (avoid losing input) — use Cancel / Escape.
  import * as ipc from '$lib/ipc'
  import { kafkaTopicWizard } from '$lib/stores/kafkaTopic.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'

  // Svelte 5 quirk: gate on a local $state mirror of the singleton store flag so the
  // dialog reliably opens when toggled from another component.
  let dlgOpen = $state(false)
  let name = $state('')
  let partitions = $state(3)
  let replication = $state(1)
  let busy = $state(false)
  let wasOpen = false

  $effect(() => {
    dlgOpen = kafkaTopicWizard.open
    // (re)seed fields on the open transition
    if (kafkaTopicWizard.open && !wasOpen) {
      name = ''
      partitions = 3
      replication = 1
      busy = false
    }
    wasOpen = kafkaTopicWizard.open
  })

  async function create() {
    const nm = name.trim()
    if (!nm) {
      toasts.error('Topic name is required', 'kafka')
      return
    }
    busy = true
    try {
      await ipc.kafkaCreateTopic(kafkaTopicWizard.connId, nm, Math.max(1, partitions), Math.max(1, replication))
      toasts.success(`Created topic ${nm}`, 'kafka')
      await explorer.loadStreaming(kafkaTopicWizard.connId, 'kafka', true)
      kafkaTopicWizard.close()
    } catch (e) {
      toasts.error(String(e), 'kafka')
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing input); use Cancel / Escape -->
  <div
    onkeydown={(e) => e.key === 'Escape' && kafkaTopicWizard.close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:90"
  >
    <div
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-460), 94vw);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);display:flex;flex-direction:column;gap:var(--px-10)"
    >
      <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">Add topic</div>

      <label style="display:flex;flex-direction:column;gap:var(--px-4)">
        <span style="font-size:var(--px-11_5);color:var(--text2)">Name</span>
        <input
          bind:value={name}
          use:autofocus
          placeholder="e.g. orders.events"
          class="mono"
          style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-10);font-size:var(--px-12_5);color:var(--warn2);outline:none"
        />
      </label>

      <div style="display:flex;gap:var(--px-10)">
        <label style="display:flex;flex-direction:column;gap:var(--px-4);flex:1">
          <span style="font-size:var(--px-11_5);color:var(--text2)">Partitions</span>
          <input
            type="number"
            min="1"
            bind:value={partitions}
            class="mono"
            style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-10);font-size:var(--px-12_5);color:var(--text);outline:none"
          />
        </label>
        <label style="display:flex;flex-direction:column;gap:var(--px-4);flex:1">
          <span style="font-size:var(--px-11_5);color:var(--text2)">Replication factor</span>
          <input
            type="number"
            min="1"
            bind:value={replication}
            class="mono"
            style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-10);font-size:var(--px-12_5);color:var(--text);outline:none"
          />
        </label>
      </div>

      <div style="display:flex;gap:var(--px-8);justify-content:flex-end;margin-top:var(--px-4)">
        <span onclick={() => kafkaTopicWizard.close()} onkeydown={(e) => e.key === 'Enter' && kafkaTopicWizard.close()} role="button" tabindex="0" class="kt-btn">Cancel</span>
        <span onclick={create} onkeydown={(e) => e.key === 'Enter' && create()} role="button" tabindex="0" class="kt-btn primary" style={busy ? 'opacity:.6;pointer-events:none' : ''}>Create</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .kt-btn {
    font-size: var(--px-12);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-14);
    cursor: pointer;
  }
  .kt-btn:hover {
    background: var(--hover);
  }
  .kt-btn.primary {
    color: var(--hex-fff);
    background: var(--primary);
    border-color: var(--primary);
    font-weight: 600;
  }
</style>
