<script lang="ts">
  // Publish a message through the Management API (`POST /exchanges/{vhost}/{x}/publish`).
  // Shared by the queue tab (default exchange, routing key = queue name) and the
  // exchange tab (exchange fixed). The broker answers whether the message was
  // ROUTED — an unroutable publish is silently dropped by RabbitMQ, so say so.
  import * as ipc from '$lib/ipc'
  import { toasts } from '$lib/stores/toast.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { buildProperties, exchangeLabel } from '$lib/rabbitmq/format'

  interface Props {
    connId: string
    vhost: string
    /** initial exchange ('' = default) */
    exchange: string
    /** initial routing key */
    routingKey: string
    /** exchanges to offer; when omitted the exchange is fixed */
    exchanges?: string[]
    onPublished?: () => void
  }
  let { connId, vhost, exchange, routingKey, exchanges, onPublished }: Props = $props()

  // svelte-ignore state_referenced_locally — seeded once from the props; the user edits them
  let target = $state(exchange)
  // svelte-ignore state_referenced_locally
  let key = $state(routingKey)
  let payload = $state('{\n  "hello": "world"\n}')
  let contentType = $state('application/json')
  let persistent = $state(true)
  let headers = $state('')
  let busy = $state(false)
  let last = $state<{ routed: boolean; at: string } | null>(null)
  let formError = $state<string | null>(null)

  async function publish() {
    if (busy) return
    formError = null
    let props: Record<string, unknown>
    try {
      props = buildProperties({ contentType, persistent, headers })
    } catch (e) {
      formError = (e as Error).message
      return
    }
    busy = true
    try {
      const r = await ipc.rabbitPublish(connId, vhost, target, key, payload, props)
      last = { routed: r.routed, at: new Date().toLocaleTimeString() }
      if (r.routed) toasts.success(`Published to ${exchangeLabel(target)} · ${key || '(no key)'}`, 'rabbitmq')
      else toasts.error('Published, but NOT routed — no queue is bound for this routing key, so RabbitMQ dropped it', 'rabbitmq')
      explorer.bumpRabbit(connId)
      onPublished?.()
    } catch (e) {
      formError = String(e)
    } finally {
      busy = false
    }
  }
</script>

<div style="display:flex;flex-direction:column;gap:var(--px-10);max-width:var(--px-720)">
  <div style="display:flex;gap:var(--px-10);flex-wrap:wrap">
    <label class="pf-field" style="flex:1 1 var(--px-200)">
      <span>Exchange</span>
      {#if exchanges}
        <select bind:value={target} aria-label="Exchange">
          {#each exchanges as x (x)}<option value={x}>{exchangeLabel(x)}</option>{/each}
        </select>
      {:else}
        <input class="mono" value={exchangeLabel(target)} disabled aria-label="Exchange" />
      {/if}
    </label>
    <label class="pf-field" style="flex:1 1 var(--px-200)">
      <span>Routing key</span>
      <input class="mono" bind:value={key} spellcheck="false" aria-label="Routing key" placeholder="orders.created" />
    </label>
  </div>
  <label class="pf-field">
    <span>Payload</span>
    <textarea class="mono" bind:value={payload} rows="8" spellcheck="false" aria-label="Payload"></textarea>
  </label>
  <div style="display:flex;gap:var(--px-10);flex-wrap:wrap;align-items:flex-end">
    <label class="pf-field" style="flex:0 1 var(--px-200)">
      <span>Content type</span>
      <select bind:value={contentType} aria-label="Content type">
        <option value="application/json">application/json</option>
        <option value="text/plain">text/plain</option>
        <option value="">(none)</option>
      </select>
    </label>
    <label style="font-size:var(--px-12);color:var(--text2);display:flex;align-items:center;gap:var(--px-6);padding-bottom:var(--px-6)">
      <input type="checkbox" bind:checked={persistent} /> Persistent (delivery mode 2)
    </label>
  </div>
  <label class="pf-field">
    <span>Headers <span style="color:var(--muted);font-weight:400">— optional JSON object</span></span>
    <textarea class="mono" bind:value={headers} rows="2" spellcheck="false" aria-label="Headers" placeholder={'{"source": "studio"}'}></textarea>
  </label>
  {#if formError}
    <div role="alert" style="font-size:var(--px-11_5);color:var(--error)">{formError}</div>
  {/if}
  <div style="display:flex;align-items:center;gap:var(--px-10)">
    <span onclick={publish} onkeydown={(e) => e.key === 'Enter' && publish()} role="button" tabindex="0" class="cfm-btn primary" aria-busy={busy} style={busy ? 'opacity:.6;pointer-events:none' : ''}>{busy ? 'Publishing…' : 'Publish message'}</span>
    {#if last}
      <span data-testid="publish-result" style="font-size:var(--px-11_5);color:{last.routed ? 'var(--sacc-green)' : 'var(--error)'}">
        {last.routed ? `✓ Routed · ${last.at}` : `✕ Not routed — no binding matched · ${last.at}`}
      </span>
    {/if}
  </div>
</div>

<style>
  .pf-field {
    display: flex;
    flex-direction: column;
    gap: var(--px-6);
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
    min-width: 0;
  }
  .pf-field input,
  .pf-field select,
  .pf-field textarea {
    font-family: var(--font-main);
    font-size: var(--px-12_5);
    font-weight: 400;
    min-height: var(--px-30);
    box-sizing: border-box;
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-8);
    padding: var(--px-6) var(--px-10);
    color: var(--text);
    outline: none;
    resize: vertical;
  }
  /* routing key, payload and headers are raw content */
  .pf-field :global(.mono) {
    font-family: var(--font-mono);
    font-size: var(--px-12);
  }
  .pf-field input:focus,
  .pf-field select:focus,
  .pf-field textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 var(--px-3) var(--ring-soft);
  }
  .pf-field input:disabled {
    color: var(--text2);
  }
</style>
