<script lang="ts">
  // NATS Add subject / Add message dialog. Publishes a JetStream message (subject +
  // payload) to the stream; for a brand-new subject the backend adds it to the stream
  // config first. Time defaults to the local (localized) now — informational only, as
  // NATS timestamps the message on the server at publish time.
  import * as ipc from '$lib/ipc'
  import { natsAddWizard } from '$lib/stores/natsAdd.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { autofocus } from '$lib/actions/autofocus'

  // Svelte 5 quirk: gate on a local $state mirror of the singleton store flag so the
  // dialog reliably opens when toggled from another component.
  let dlgOpen = $state(false)
  let subject = $state('')
  let payload = $state('')
  let localTime = $state('')
  let busy = $state(false)
  let wasOpen = false

  function localNow(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  $effect(() => {
    dlgOpen = natsAddWizard.open
    // (re)seed fields on the open transition
    if (natsAddWizard.open && !wasOpen) {
      subject = natsAddWizard.subject
      payload = ''
      localTime = localNow()
      busy = false
    }
    wasOpen = natsAddWizard.open
  })

  async function publish() {
    const subj = subject.trim()
    if (!subj) {
      toasts.error('Subject is required', 'nats')
      return
    }
    busy = true
    try {
      await ipc.natsJsAddSubject(natsAddWizard.connId, natsAddWizard.stream, subj, payload)
      toasts.success(`Published to ${subj}`, 'nats')
      explorer.refreshStreaming(natsAddWizard.connId)
      // refresh the open subject-messages tab so the new message shows
      explorer.bumpNatsSubject(natsAddWizard.connId, natsAddWizard.stream, subj)
      natsAddWizard.close()
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
    onkeydown={(e) => e.key === 'Escape' && natsAddWizard.close()}
    role="presentation"
    style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:90"
  >
    <div
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-520), 94vw);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55);display:flex;flex-direction:column;gap:var(--px-10)"
    >
      <div style="font-size:var(--px-14);font-weight:600;color:var(--text)">
        {natsAddWizard.newSubject ? 'Add subject' : 'Add message'}
        <span class="mono" style="font-size:var(--px-11);font-weight:400;color:var(--success);margin-left:var(--px-6)">stream {natsAddWizard.stream}</span>
      </div>

      <label style="display:flex;flex-direction:column;gap:var(--px-4)">
        <span style="font-size:var(--px-11_5);color:var(--text2)">Subject</span>
        <input
          bind:value={subject}
          use:autofocus
          placeholder="e.g. orders.eu"
          class="mono"
          style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-10);font-size:var(--px-12_5);color:var(--warn2);outline:none"
        />
      </label>

      <label style="display:flex;flex-direction:column;gap:var(--px-4)">
        <span style="font-size:var(--px-11_5);color:var(--syntax-string)">Payload</span>
        <textarea
          bind:value={payload}
          placeholder={'{"id":1001,"total":42.5}'}
          class="mono"
          style="min-height:var(--px-140);resize:vertical;background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-8);padding:var(--px-10);font-size:var(--px-12_5);color:var(--text);outline:none"
        ></textarea>
      </label>

      <label style="display:flex;flex-direction:column;gap:var(--px-4)">
        <span style="font-size:var(--px-11_5);color:var(--text2)">Time (local)</span>
        <input
          bind:value={localTime}
          disabled
          class="mono"
          style="background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-6) var(--px-10);font-size:var(--px-12_5);color:var(--muted);outline:none"
        />
        <span style="font-size:var(--px-10_5);color:var(--muted)">NATS sets the actual publish time on the server; this local time is for reference.</span>
      </label>

      <div style="display:flex;gap:var(--px-8);justify-content:flex-end;margin-top:var(--px-4)">
        <span onclick={() => natsAddWizard.close()} onkeydown={(e) => e.key === 'Enter' && natsAddWizard.close()} role="button" tabindex="0" class="na-btn">Cancel</span>
        <span onclick={publish} onkeydown={(e) => e.key === 'Enter' && publish()} role="button" tabindex="0" class="na-btn primary" style={busy ? 'opacity:.6;pointer-events:none' : ''}>Publish</span>
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
