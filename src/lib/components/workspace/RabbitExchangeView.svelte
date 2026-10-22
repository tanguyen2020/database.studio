<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  // RabbitMQ exchange tab: where messages published here go (bindings, add /
  // remove), a Publish form, and the exchange's details. One tab per (vhost, exchange).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import RabbitPublishForm from './RabbitPublishForm.svelte'
  import RabbitLivePanel from './RabbitLivePanel.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import { exchangeLabel, isBuiltinExchange } from '$lib/rabbitmq/format'
  import { describeArguments } from '$lib/stream/rabbitmq-arguments'
  import { plural } from '$lib/stream/humanize'
  import { openRabbitExchange, openRabbitQueue } from '$lib/stream/rabbitmq-nav'
  import AdvancedToggle from '$lib/components/stream/AdvancedToggle.svelte'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
    /** embedded in the cluster workspace: the exchange to show (overrides tab.state) */
    vhost?: string
    name?: string
    embedded?: boolean
    /** embedded: the exchange was deleted — the workspace closes the details */
    onDeleted?: () => void
    /** embedded: close the details pane */
    onClose?: () => void
  }
  let { tab, vhost: vhostProp, name: nameProp, embedded = false, onDeleted, onClose }: Props = $props()

  const connId = $derived(tab.connectionId ?? '')
  const vhost = $derived(vhostProp ?? (tab.state as { vhost?: string }).vhost ?? '/')
  const name = $derived(nameProp ?? (tab.state as { name?: string }).name ?? '')
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

  // Plain-language meaning of each exchange type (rule U1).
  const TYPE_HELP: Record<string, string> = {
    direct: 'Direct — delivers a message to the queues whose binding key equals its routing key.',
    topic: 'Topic — delivers by pattern: * matches one word, # matches zero or more.',
    fanout: 'Fanout — delivers every message to every bound queue; the routing key is ignored.',
    headers: 'Headers — delivers by message headers instead of the routing key.',
  }
  const argSentences = $derived(describeArguments(exchange?.arguments))

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
      if (embedded) onDeleted?.()
      else tabs.forceClose([tab.id])
    } catch (e) {
      toasts.error(String(e), 'rabbitmq')
    } finally {
      deleting = false
    }
  }
</script>

<div class="ds-ws" class:rx-embedded={embedded} data-rabbit-exchange={exchangeLabel(name)}>
  <div class="rx-ehead">
    <div class="rx-etitle">
      <span class="rx-ename mono" title={exchangeLabel(name)}>{exchangeLabel(name)}</span>
      {#if onClose}<button type="button" class="rx-close" onclick={onClose} aria-label="Close details" title="Close details">×</button>{/if}
    </div>
    <div class="rx-chips">
      {#if exchange}
        <span class="ds-chip" title={TYPE_HELP[exchange.exchange_type] ?? 'A plugin exchange type.'}>{exchange.exchange_type} exchange</span>
        <span class="ds-chip" title={exchange.durable ? 'Survives a broker restart.' : 'Lost when the broker restarts.'}>{exchange.durable ? 'Durable' : 'Temporary'}</span>
        {#if exchange.auto_delete}<span class="ds-chip" title="Deleted when its last binding is removed.">Auto-delete</span>{/if}
        {#if exchange.internal}<span class="ds-chip" title="Clients cannot publish to it directly; only other exchanges can.">Internal</span>{/if}
        {#if builtin}<span class="ds-chip" title="Created by the broker; it cannot be deleted.">Built-in</span>{/if}
      {/if}
    </div>
    <div class="rx-eactions">
      <button type="button" class="cfm-btn" onclick={() => loadInfo()} aria-busy={loading}><Icon name="refresh" size={12} /> Refresh</button>
      {#if !builtin}<button type="button" class="cfm-btn ds-danger-outline" onclick={() => (confirmDelete = true)}>Delete exchange…</button>{/if}
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
                        <span onclick={() => openRabbitQueue(connId, vhost, b.destination)} onkeydown={(e) => e.key === 'Enter' && openRabbitQueue(connId, vhost, b.destination)} role="button" tabindex="0" class="rx-link">{b.destination}</span>
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
        <div class="ds-section-title">How this exchange routes</div>
        <ul class="rx-sentences" data-testid="exchange-rules">
          {#if exchange}<li>{TYPE_HELP[exchange.exchange_type] ?? `Routes by the rules of the ${exchange.exchange_type} plugin.`}</li>{/if}
          {#each argSentences as s (s.key)}
            <li title={s.key}>{s.text}{#if s.exchange != null}{' '}{#if embedded && s.exchange !== ''}<button type="button" class="rx-btnlink mono" onclick={() => openRabbitExchange(connId, vhost, s.exchange ?? '')}>{s.exchange}</button>{:else}<span class="mono">{exchangeLabel(s.exchange)}</span>{/if}{/if}</li>
          {/each}
          {#if exchange?.internal}<li>Internal — clients cannot publish to it directly; only other exchanges can.</li>{/if}
          {#if builtin}<li>Built-in — created by the broker; it cannot be deleted.</li>{/if}
        </ul>
        <AdvancedToggle label="Advanced — raw settings">
          <dl class="rx-dl">
            {#each [['Type', exchange?.exchange_type], ['Durable', exchange ? String(exchange.durable) : ''], ['Auto-delete', exchange ? String(exchange.auto_delete) : ''], ['Internal', exchange ? String(exchange.internal) : ''], ['Built-in', builtin ? 'yes' : 'no']] as [k, v] (k)}
              <dt>{k}</dt><dd>{v || '—'}</dd>
            {/each}
          </dl>
          <div style="margin-top:var(--px-12);font-size:var(--px-11_5);font-weight:600;color:var(--text2)">Arguments</div>
          <div style="margin-top:var(--px-6);display:flex">
            <CodeView value={JSON.stringify(exchange?.arguments ?? {}, null, 2)} language={DS_JSON} readOnly height="auto" maxHeight={320} minHeight={60} ariaLabel="Exchange arguments" />
          </div>
        </AdvancedToggle>
      {/if}
      <!-- mounted for the life of the tab so switching sections keeps listening -->
      <div style="display:{section === 'live' ? 'block' : 'none'}">
        <RabbitLivePanel {connId} {vhost} kind="exchange" {name} exchangeType={exchange?.exchange_type ?? ''} />
      </div>
    </div>
  {/if}

  {#if confirmDelete}
    <div role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Delete exchange"
        onkeydown={(e) => e.key === 'Escape' && (confirmDelete = false)}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-460), 92%);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">Delete exchange</div>
        <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">Delete exchange <span class="mono" style="color:var(--text)">{name}</span>? {bindings.length ? `Its ${plural(bindings.length, 'binding')} ${bindings.length === 1 ? 'is' : 'are'} removed, so messages published to it stop reaching those queues.` : 'It has no bindings.'} Applications that still publish to it get an error. This cannot be undone.</div>
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span onclick={() => (confirmDelete = false)} onkeydown={(e) => e.key === 'Enter' && (confirmDelete = false)} role="button" tabindex="0" class="pv-btn">Cancel</span>
          <span onclick={doDelete} onkeydown={(e) => e.key === 'Enter' && doDelete()} role="button" tabindex="0" class="pv-btn danger" style="{deleting ? 'opacity:.6;pointer-events:none' : ''}">Delete exchange</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .rx-embedded {
    flex: 1;
    min-height: 0;
    background: var(--panel);
  }
  .rx-ehead {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--px-8);
    padding: var(--px-14) var(--px-18) var(--px-10);
    background: var(--surface);
    border-bottom: var(--px-1) solid var(--border);
  }
  .rx-etitle {
    display: flex;
    align-items: center;
    gap: var(--px-10);
  }
  .rx-ename {
    flex: 1;
    min-width: 0;
    font-size: var(--px-15);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rx-close {
    border: 0;
    background: transparent;
    font-size: var(--px-18);
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    padding: var(--px-2) var(--px-6);
    border-radius: var(--px-6);
  }
  .rx-close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .rx-chips,
  .rx-eactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-6);
  }
  .rx-eactions :global(.cfm-btn) {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  .rx-sentences {
    margin: 0 0 var(--px-12);
    padding: var(--px-12) var(--px-16) var(--px-12) var(--px-34);
    display: flex;
    flex-direction: column;
    gap: var(--px-6);
    font-size: var(--px-13);
    line-height: 1.45;
    color: var(--text);
    background: var(--surface);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    max-width: var(--px-720);
  }
  .rx-btnlink {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--tbl-link);
    font-weight: 600;
    cursor: pointer;
  }
  .rx-btnlink:hover {
    text-decoration: underline;
  }
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
