<script lang="ts">
  // NATS "Add stream" dialog. Creates a JetStream stream with a name and one or
  // more subjects (one per line, or comma-separated). Opens focused on the name
  // field. Backdrop click does NOT close (avoid losing input) — use Cancel/Escape.
  import * as ipc from '$lib/ipc'
  import { natsCreateStream } from '$lib/stores/natsCreateStream.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'

  // Svelte 5 quirk: gate on a local $state mirror of the singleton store flag so the
  // dialog reliably opens when toggled from another component.
  let dlgOpen = $state(false)
  let name = $state('')
  let subjectsText = $state('')
  let busy = $state(false)
  let wasOpen = false

  $effect(() => {
    dlgOpen = natsCreateStream.open
    // (re)seed fields on the open transition
    if (natsCreateStream.open && !wasOpen) {
      name = ''
      subjectsText = ''
      busy = false
    }
    wasOpen = natsCreateStream.open
  })

  function parseSubjects(raw: string): string[] {
    return raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  async function create() {
    const nm = name.trim()
    if (!nm) {
      toasts.error('Stream name is required', 'nats')
      return
    }
    const subjects = parseSubjects(subjectsText)
    if (subjects.length === 0) {
      toasts.error('At least one subject is required', 'nats')
      return
    }
    busy = true
    try {
      await ipc.natsJsCreateStream(natsCreateStream.connId, nm, subjects)
      toasts.success(`Created stream ${nm}`, 'nats')
      await explorer.loadStreaming(natsCreateStream.connId, 'nats', true)
      natsCreateStream.close()
    } catch (e) {
      toasts.error(String(e), 'nats')
    } finally {
      busy = false
    }
  }
</script>

{#if dlgOpen}
  <!-- backdrop click does NOT close (avoid losing input); use Cancel / Escape -->
  <div
    onkeydown={(e) => e.key === 'Escape' && natsCreateStream.close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:90"
  >
    <div
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-520), 94vw);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);display:flex;flex-direction:column;gap:var(--px-10)"
    >
      <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">Add stream</div>

      <label style="display:flex;flex-direction:column;gap:var(--px-4)">
        <span style="font-size:var(--px-11_5);color:var(--text2)">Name</span>
        <input
          bind:value={name}
          use:autofocus
          placeholder="e.g. ORDERS"
          class="mono"
          style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-10);font-size:var(--px-12_5);color:var(--warn2);outline:none"
        />
      </label>

      <label style="display:flex;flex-direction:column;gap:var(--px-4)">
        <span style="font-size:var(--px-11_5);color:var(--text2)">Subjects</span>
        <textarea
          bind:value={subjectsText}
          placeholder={'orders.>\norders.eu\norders.us'}
          class="mono"
          style="min-height:var(--px-140);resize:vertical;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-10);font-size:var(--px-12_5);color:var(--text);outline:none"
        ></textarea>
        <span style="font-size:var(--px-10_5);color:var(--muted)">One subject per line (or comma-separated). Wildcards allowed (e.g. orders.&gt;).</span>
      </label>

      <div style="display:flex;gap:var(--px-8);justify-content:flex-end;margin-top:var(--px-4)">
        <span onclick={() => natsCreateStream.close()} onkeydown={(e) => e.key === 'Enter' && natsCreateStream.close()} role="button" tabindex="0" class="na-btn">Cancel</span>
        <span onclick={create} onkeydown={(e) => e.key === 'Enter' && create()} role="button" tabindex="0" class="na-btn primary" style={busy ? 'opacity:.6;pointer-events:none' : ''}>Create</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .na-btn {
    font-size: var(--px-12);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-14);
    cursor: pointer;
  }
  .na-btn:hover {
    background: var(--hover);
  }
  .na-btn.primary {
    color: var(--hex-fff);
    background: var(--primary);
    border-color: var(--primary);
    font-weight: 600;
  }
</style>
