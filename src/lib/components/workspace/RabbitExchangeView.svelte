<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  import SystemIcon from '$lib/components/SystemIcon.svelte'
  // RabbitMQ exchange tab: where messages published here go (bindings, add /
  // remove), a Publish form, and the exchange's details. One tab per (vhost, exchange).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import RabbitPublishForm from './RabbitPublishForm.svelte'
  import RabbitLivePanel from './RabbitLivePanel.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { systemMeta } from '$lib/systems'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { exchangeLabel, isBuiltinExchange } from '$lib/rabbitmq/format'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const connId = $derived(tab.connectionId ?? '')
  const vhost = $derived((tab.state as { vhost?: string }).vhost ?? '/')
  const name = $derived((tab.state as { name?: string }).name ?? '')
  const accent = systemMeta('rabbitmq').accent
  const builtin = $derived(isBuiltinExchange(name))

  type Section = 'bindings' | 'live' | 'publish' | 'details'
  let section = $state<Section>('bindings')

  let exchange = $state<ipc.RabbitExchange | null>(null)
  let bindings = $state<ipc.RabbitBinding[]>([])
  let queues = $state<ipc.RabbitQueue[]>([])
  let loadError = $state<string | null>(null)
  let gone = $state(false)
  let loading = $state(false)

  async function loadInfo() {
    if (!connId) return
    loading = true
    try {
      const [xs, b, qs] = await Promise.all([
        ipc.rabbitExchanges(connId, vhost),
        ipc.rabbitExchangeBindings(connId, vhost, name),
        ipc.rabbitQueues(connId, vhost),
      ])
      exchange = xs.find((x) => x.name === name) ?? null
      gone = !exchange
      bindings = b
      queues = qs
      // pre-select a real option so the picker never shows blank
      if (!qs.some((q) => q.name === bindQueue)) bindQueue = qs[0]?.name ?? ''
      loadError = null
    } catch (e) {
      loadError = String(e)
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void connId
    void vhost
    void name
    untrack(() => void loadInfo())
  })

  let seenTick = untrack(() => explorer.rabbitTick[connId] ?? 0)
  $effect(() => {
    const tick = explorer.rabbitTick[connId] ?? 0
    untrack(() => {
      if (tick === seenTick) return
      seenTick = tick
      void loadInfo()
    })
  })

  // ---- bindings ------------------------------------------------------------------
  let bindQueue = $state('')
  let bindKey = $state('')
  let binding = $state(false)

  async function bind() {
    const q = bindQueue || queues[0]?.name
    if (!q || binding) return
    binding = true
    try {
      await ipc.rabbitBindQueue(connId, vhost, name, q, bindKey)
      toasts.success(`Bound ${name} → ${q} (${bindKey || 'no key'})`, 'rabbitmq')
      bindKey = ''
      await loadInfo()
    } catch (e) {
      toasts.error(String(e), 'rabbitmq')
    } finally {
      binding = false
    }
  }

  async function unbind(b: ipc.RabbitBinding) {
    try {
      await ipc.rabbitUnbindQueue(connId, vhost, name, b.destination, b.properties_key)
      toasts.success('Binding removed', 'rabbitmq')
      await loadInfo()
    } catch (e) {
      toasts.error(String(e), 'rabbitmq')
    }
  }

  // ---- delete ----------------------------------------------------------------------
  let confirmDelete = $state(false)
  let deleting = $state(false)
  async function doDelete() {
    if (deleting) return
    deleting = true
    try {
      await ipc.rabbitDeleteExchange(connId, vhost, name)
      toasts.success(`Deleted exchange ${name}`, 'rabbitmq')
      explorer.bumpRabbit(connId)
      confirmDelete = false
      tabs.forceClose([tab.id])
    } catch (e) {
      toasts.error(String(e), 'rabbitmq')
    } finally {
      deleting = false
    }
  }
</script>

<div class="ds-ws">
  <div class="ds-ws-head">
    <span class="ds-ws-icon" style="background:color-mix(in srgb, {accent} 12%, transparent)" aria-hidden="true"><SystemIcon system="rabbitmq" size={20} /></span>
    <div class="ds-ws-titles">
      <span class="ds-ws-title">{exchangeLabel(name)}</span>
      <span class="ds-ws-sub">
        exchange · vhost <span style="color:var(--text2)">{vhost}</span>{#if exchange}{' · '}{exchange.exchange_type}{exchange.durable ? ' · durable' : ''}{exchange.internal ? ' · internal' : ''}{/if}
      </span>
    </div>
    <div class="ds-ws-actions">
      <span onclick={() => loadInfo()} onkeydown={(e) => e.key === 'Enter' && loadInfo()} role="button" tabindex="0" class="cfm-btn" aria-busy={loading}><Icon name="refresh" size={12} /> Refresh</span>
      {#if !builtin}
        <span onclick={() => (confirmDelete = true)} onkeydown={(e) => e.key === 'Enter' && (confirmDelete = true)} role="button" tabindex="0" class="cfm-btn ds-danger-outline">Delete exchange</span>
      {/if}
    </div>
  </div>

  {#if gone && !loading}
    <div style="padding:var(--px-24);font-size:var(--px-13);color:var(--text2)">
      Exchange <span class="mono" style="color:var(--text)">{name}</span> no longer exists in vhost <span class="mono">{vhost}</span>.
    </div>
  {:else}
    {#if loadError}
      <div role="alert" style="padding:var(--px-8) var(--px-14);font-size:var(--px-11_5);color:var(--error);border-bottom:var(--px-1) solid var(--border)">{loadError}</div>
    {/if}
    <div role="tablist" aria-label="Exchange sections" style="flex:none;display:flex;gap:var(--px-4);padding:0 var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
      {#each [['bindings', `Bindings (${bindings.length})`], ['live', 'Live'], ['publish', 'Publish'], ['details', 'Details']] as [key, label] (key)}
        <span role="tab" tabindex="0" aria-selected={section === key} class="rx-tab" class:on={section === key} onclick={() => (section = key as Section)} onkeydown={(e) => e.key === 'Enter' && (section = key as Section)}>{label}</span>
      {/each}
    </div>

    <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-14) var(--px-18)">
      {#if section === 'bindings'}
        {#if name === ''}
          <div style="font-size:var(--px-12);color:var(--text2);line-height:1.5;max-width:var(--px-720)">
            The default exchange routes a message to the queue whose name equals its routing key. It has no explicit bindings — use <b>Publish</b> with a queue name as the routing key.
          </div>
        {:else}
          {#if bindings.length === 0}
            <div class="ds-empty" style="margin-bottom:var(--px-10)"><b>No bindings</b>Nothing is bound to this exchange — messages published here are dropped.</div>
          {:else}
            <table class="ds-table" style="max-width:var(--px-720);font-size:var(--px-12_5);">
              <thead><tr>
                {#each ['To', 'Type', 'Routing key', ''] as h (h || 'x')}
                  <th>{h}</th>
                {/each}
              </tr></thead>
              <tbody>
                {#each bindings as b (b.destination + '|' + b.properties_key)}
                  <tr class="rx-row">
                    <td>
                      {#if b.destination_type === 'queue'}
                        <span onclick={() => tabs.openRabbitQueue(connId, vhost, b.destination)} onkeydown={(e) => e.key === 'Enter' && tabs.openRabbitQueue(connId, vhost, b.destination)} role="button" tabindex="0" class="rx-link">{b.destination}</span>
                      {:else}
                        <span style="color:var(--tbl-link)">{b.destination}</span>
                      {/if}
                    </td>
                    <td style="color:var(--tbl-meta)">{b.destination_type}</td>
                    <td class="mono" style="font-size:var(--px-12);color:var(--tbl-subject)">{b.routing_key || '—'}</td>
                    <td style="text-align:right">
                      {#if b.destination_type === 'queue'}
                        <span onclick={() => unbind(b)} onkeydown={(e) => e.key === 'Enter' && unbind(b)} role="button" tabindex="0" title="Remove binding" class="eg-btn ds-danger-outline">Unbind</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
          <div style="margin-top:var(--px-14);display:flex;gap:var(--px-8);align-items:flex-end;flex-wrap:wrap">
            <label class="rx-field">
              Bind to queue
              <select class="ds-control rx-input" bind:value={bindQueue} aria-label="Bind to queue">
                {#each queues as q (q.name)}<option value={q.name}>{q.name}</option>{/each}
              </select>
            </label>
            <label class="rx-field">
              Routing key
              <input class="ds-control mono rx-input" bind:value={bindKey} placeholder={exchange?.exchange_type === 'topic' ? 'orders.*.eu' : 'orders'} aria-label="Binding routing key" spellcheck="false" />
            </label>
            <span onclick={bind} onkeydown={(e) => e.key === 'Enter' && bind()} role="button" tabindex="0" class="pv-btn primary" style={binding || !queues.length ? 'opacity:.6;pointer-events:none' : ''}>Bind</span>
          </div>
        {/if}
      {:else if section === 'publish'}
        <RabbitPublishForm {connId} {vhost} exchange={name} routingKey="" onPublished={() => void loadInfo()} />
      {:else if section === 'details'}
        <dl class="rx-dl">
          {#each [['Type', exchange?.exchange_type], ['Durable', exchange ? String(exchange.durable) : ''], ['Auto-delete', exchange ? String(exchange.auto_delete) : ''], ['Internal', exchange ? String(exchange.internal) : ''], ['Built-in', builtin ? 'yes' : 'no']] as [k, v] (k)}
            <dt>{k}</dt><dd>{v || '—'}</dd>
          {/each}
        </dl>
        <div style="margin-top:var(--px-12);font-size:var(--px-11_5);font-weight:600;color:var(--text2)">Arguments</div>
        <div style="margin-top:var(--px-6);display:flex">
          <CodeView value={JSON.stringify(exchange?.arguments ?? {}, null, 2)} language={DS_JSON} readOnly height="auto" maxHeight={320} minHeight={60} ariaLabel="Exchange arguments" />
        </div>
      {/if}
      <!-- mounted for the life of the tab so switching sections keeps listening -->
      <div style="display:{section === 'live' ? 'block' : 'none'}">
        <RabbitLivePanel {connId} {vhost} kind="exchange" {name} exchangeType={exchange?.exchange_type ?? ''} />
      </div>
    </div>
  {/if}

  {#if confirmDelete}
    <div role="presentation" style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Delete exchange"
        onkeydown={(e) => e.key === 'Escape' && (confirmDelete = false)}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-460), 92%);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">Delete exchange</div>
        <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">Delete exchange <span class="mono" style="color:var(--text)">{name}</span>? Every binding from it is removed. This cannot be undone.</div>
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span onclick={() => (confirmDelete = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDelete = false)} role="button" tabindex="0" class="pv-btn">Cancel</span>
          <span onclick={doDelete} onkeydown={(e) => e.key === 'Enter' && doDelete()} role="button" tabindex="0" class="pv-btn danger" style="{deleting ? 'opacity:.6;pointer-events:none' : ''}">Delete</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .rx-tab {
    font-size: var(--px-13);
    font-weight: 500;
    color: var(--text2);
    padding: var(--px-10) var(--px-10);
    border-bottom: var(--px-2) solid transparent;
    margin-bottom: calc(-1 * var(--px-1));
    cursor: pointer;
  }
  .rx-tab:hover {
    color: var(--text);
  }
  .rx-tab.on {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--primary);
  }
  .rx-row td {
    padding: var(--px-8) var(--px-12);
  }
  .rx-row:hover {
    background: var(--tbl-hover);
  }
  .rx-link {
    color: var(--tbl-link);
    font-weight: 600;
    cursor: pointer;
  }
  .rx-link:hover {
    text-decoration: underline;
  }
  .rx-field {
    display: flex;
    flex-direction: column;
    gap: var(--px-6);
    font-size: var(--px-12);
    color: var(--text2);
    font-weight: 600;
  }
  .rx-dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--px-8) var(--px-20);
    font-size: var(--px-13);
    margin: 0;
    padding: var(--px-14) var(--px-16);
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    box-shadow: var(--shadow-xs);
    max-width: var(--px-720);
  }
  .rx-dl dt {
    color: var(--tbl-meta);
  }
  .rx-dl dd {
    margin: 0;
    color: var(--text);
  }
</style>
