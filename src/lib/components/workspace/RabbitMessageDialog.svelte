<script lang="ts">
  // One RabbitMQ message in full: payload (pretty JSON / text / base64) + its AMQP
  // properties. Shared by the queue tab's message list and the Live panel. Renders
  // as an overlay over the nearest positioned ancestor (the tab), like the other
  // payload viewers; the backdrop does not close it (rule chung) — Close / Escape do.
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { payloadView } from '$lib/rabbitmq/format'
  import { toasts } from '$lib/stores/toast.svelte'
  import type { RabbitMessage } from '$lib/ipc'

  interface Props {
    message: RabbitMessage
    title: string
    onClose: () => void
  }
  let { message, title, onClose }: Props = $props()

  const view = $derived(payloadView(message))

  async function copy() {
    await navigator.clipboard.writeText(view.text)
    toasts.success('Payload copied', 'rabbitmq')
  }
</script>

<div role="presentation" style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:50;padding:var(--px-20)">
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Message payload"
    onkeydown={(e) => e.key === 'Escape' && onClose()}
    tabindex="-1"
    style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-720), 100%);max-height:100%;display:flex;flex-direction:column;box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
  >
    <div style="display:flex;align-items:center;gap:var(--px-8);margin-bottom:var(--px-10);flex-wrap:wrap">
      <span style="font-size:var(--px-14);font-weight:600;color:var(--text)">{title}</span>
      <span class="mono" style="font-size:var(--px-11);color:var(--tbl-subject)">{message.routing_key}</span>
      {#if view.binary}<span style="font-size:var(--px-10_5);color:var(--muted)">(binary — shown as base64)</span>
      {:else if !view.isJson}<span style="font-size:var(--px-10_5);color:var(--muted)">(not JSON — raw payload)</span>{/if}
      <span style="margin-left:auto;display:flex;gap:var(--px-8)">
        <span onclick={copy} onkeydown={(e) => e.key === 'Enter' && copy()} role="button" tabindex="0" class="pv-btn primary">Copy</span>
        <span onclick={onClose} onkeydown={(e) => e.key === 'Enter' && onClose()} role="button" tabindex="0" class="pv-btn">Close</span>
      </span>
    </div>
    <div style="flex:1;min-height:0;display:flex">
      <CodeView value={view.text} language={view.isJson ? DS_JSON : 'plaintext'} readOnly height="auto" maxHeight={420} minHeight={120} ariaLabel="Payload" />
    </div>
    <div style="margin-top:var(--px-10);font-size:var(--px-11_5);font-weight:600;color:var(--text2)">Properties</div>
    <div style="margin-top:var(--px-6);display:flex">
      <CodeView value={JSON.stringify(message.properties, null, 2)} language={DS_JSON} readOnly height="auto" maxHeight={180} minHeight={40} ariaLabel="Message properties" />
    </div>
  </div>
</div>
