<script lang="ts">
  // One RabbitMQ message in full: payload (pretty JSON / text / base64) + its AMQP
  // properties. Shared by the queue tab's message list and the Live panel. Uses the
  // app-wide payload viewer (facts, Formatted ⇄ Raw, wrap, size, Copy feedback); the
  // backdrop does not close it (rule chung) — Close / Escape do.
  import PayloadDialog from '$lib/components/viewer/PayloadDialog.svelte'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { payloadText } from '$lib/rabbitmq/format'
  import type { RabbitMessage } from '$lib/ipc'

  interface Props {
    message: RabbitMessage
    title: string
    onClose: () => void
  }
  let { message, title, onClose }: Props = $props()

  const body = $derived(payloadText(message))
  const propsJson = $derived(Object.keys(message.properties ?? {}).length ? JSON.stringify(message.properties, null, 2) : '')
</script>

<PayloadDialog
  {title}
  ariaLabel="Message payload"
  system="rabbitmq"
  subtitle={`RabbitMQ message · ${message.exchange ? `exchange ${message.exchange}` : 'default exchange'}`}
  facts={[
    { label: 'Exchange', value: message.exchange || '(default)' },
    { label: 'Routing key', value: message.routing_key, mono: true },
    { label: 'Redelivered', value: message.redelivered ? 'Yes' : 'No' },
    { label: 'Size', value: `${message.payload_bytes.toLocaleString('en-US')} B` },
    { label: 'Left in queue', value: message.message_count.toLocaleString('en-US') },
  ]}
  text={body.text}
  note={body.binary ? 'Binary payload — shown as base64' : ''}
  {onClose}
>
  {#if propsJson}
    <div class="rm-props">
      <div class="rm-props-title">Properties</div>
      <div class="rm-props-box">
        <CodeView value={propsJson} language={DS_JSON} readOnly height="auto" maxHeight={180} minHeight={40} ariaLabel="Message properties" />
      </div>
    </div>
  {/if}
</PayloadDialog>

<style>
  .rm-props {
    margin: var(--px-14) var(--px-18) 0;
  }
  .rm-props-title {
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
    margin-bottom: var(--px-6);
  }
  .rm-props-box {
    display: flex;
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    overflow: hidden;
    background: var(--raised);
  }
</style>
