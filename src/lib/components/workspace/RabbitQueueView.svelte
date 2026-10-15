<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  // RabbitMQ queue tab: live stats + Messages (peek with requeue, or consume) +
  // Bindings (add / remove) + Publish + Details. One tab per (vhost, queue).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import RabbitPublishForm from './RabbitPublishForm.svelte'
  import RabbitLivePanel from './RabbitLivePanel.svelte'
  import RabbitMessageDialog from './RabbitMessageDialog.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { systemMeta } from '$lib/systems'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import {
    exchangeLabel,
    formatPayloadBytes,
    payloadPreview,
    sortExchanges,
  } from '$lib/rabbitmq/format'
  import type { TabState } from '$lib/types'

  interface Props {
    tab: TabState
  }
  let { tab }: Props = $props()

  const connId = $derived(tab.connectionId ?? '')
  const vhost = $derived((tab.state as { vhost?: string }).vhost ?? '/')
  const name = $derived((tab.state as { name?: string }).name ?? '')
  const accent = systemMeta('rabbitmq').accent

  type Section = 'messages' | 'live' | 'bindings' | 'publish' | 'details'
  let section = $state<Section>('messages')

  let queue = $state<ipc.RabbitQueue | null>(null)
  let bindings = $state<ipc.RabbitBinding[]>([])
  let exchanges = $state<ipc.RabbitExchange[]>([])
  let loadError = $state<string | null>(null)
  let gone = $state(false)
  let loading = $state(false)

  async function loadInfo() {
    if (!connId || !name) return
    loading = true
    try {
      const [q, b, xs] = await Promise.all([
        ipc.rabbitQueue(connId, vhost, name),
        ipc.rabbitQueueBindings(connId, vhost, name),
        ipc.rabbitExchanges(connId, vhost),
      ])
      queue = q
      bindings = b
      exchanges = xs
      // pre-select a real option so the picker never shows blank
      const names = xs.map((x) => x.name).filter((n) => n !== '')
      if (!names.includes(bindExchange)) bindExchange = names.find((n) => !n.startsWith('amq.')) ?? names[0] ?? ''
      loadError = null
      gone = false
    } catch (e) {
      const msg = String(e)
      // Deleted elsewhere (another tab, another tool): say so instead of a raw 404.
      if (msg.includes('Not found')) gone = true
      loadError = msg
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

  // Reload when another component changed this broker (publish / purge / delete).
  let seenTick = untrack(() => explorer.rabbitTick[connId] ?? 0)
  $effect(() => {
    const tick = explorer.rabbitTick[connId] ?? 0
    untrack(() => {
      if (tick === seenTick) return
      seenTick = tick
      void loadInfo()
    })
  })

  // ---- messages --------------------------------------------------------------
  let count = $state(20)
  let mode = $state<ipc.RabbitGetMode>('requeue')
  let messages = $state<ipc.RabbitMessage[]>([])
  let fetched = $state(false)
  let fetching = $state(false)
  let selIdx = $state<number | null>(null)

  async function fetchMessages() {
    if (fetching) return
    fetching = true
    try {
      const n = Math.max(1, Math.min(1000, Math.floor(Number(count) || 20)))
      messages = await ipc.rabbitGetMessages(connId, vhost, name, n, mode)
      fetched = true
      selIdx = null
      if (mode !== 'requeue') {
        toasts.success(`${messages.length} message(s) ${mode === 'ack' ? 'consumed' : 'rejected'} — removed from ${name}`, 'rabbitmq')
        explorer.bumpRabbit(connId)
      }
      await loadInfo()
    } catch (e) {
      toasts.error(String(e), 'rabbitmq')
    } finally {
      fetching = false
    }
  }

  function getMessages() {
    if (mode === 'requeue') return void fetchMessages()
    askConfirm(
      mode === 'ack' ? 'Consume messages' : 'Reject messages',
      `Take up to ${count} message(s) from "${name}" and ${mode === 'ack' ? 'acknowledge' : 'reject'} them? They are REMOVED from the queue. Use Peek to look without removing.`,
      mode === 'ack' ? 'Consume' : 'Reject',
      fetchMessages,
    )
  }

  async function copy(text: string, what = 'Copied') {
    await navigator.clipboard.writeText(text)
    toasts.success(what, 'rabbitmq')
  }

  let viewState = $state<{ index: number; m: ipc.RabbitMessage } | null>(null)
  function view(m: ipc.RabbitMessage, index: number) {
    viewState = { index, m }
  }

  const cellColor = (i: number, base: string) => (selIdx === i ? 'var(--hex-fff)' : base)
  const GRID_FONT = "font-variant-numeric:tabular-nums;font-feature-settings:'tnum' 1,'zero' 1"

  // ---- bindings --------------------------------------------------------------
  const bindable = $derived(sortExchanges(exchanges).filter((x) => x.name !== '').map((x) => x.name))
  let bindExchange = $state('')
  let bindKey = $state('')
  let binding = $state(false)

  async function bind() {
    const x = bindExchange || bindable[0]
    if (!x || binding) return
    binding = true
    try {
      await ipc.rabbitBindQueue(connId, vhost, x, name, bindKey)
      toasts.success(`Bound ${name} ← ${x} (${bindKey || 'no key'})`, 'rabbitmq')
      bindKey = ''
      await loadInfo()
    } catch (e) {
      toasts.error(String(e), 'rabbitmq')
    } finally {
      binding = false
    }
  }

  function unbind(b: ipc.RabbitBinding) {
    askConfirm('Remove binding', `Unbind "${name}" from exchange "${b.source}" (routing key "${b.routing_key}")?`, 'Unbind', async () => {
      await ipc.rabbitUnbindQueue(connId, vhost, b.source, name, b.properties_key)
      toasts.success('Binding removed', 'rabbitmq')
      await loadInfo()
    })
  }

  // ---- purge / delete ----------------------------------------------------------
  function purge() {
    askConfirm('Purge queue', `Remove every ready message from "${name}"? Unacknowledged messages stay with their consumers. This cannot be undone.`, 'Purge', async () => {
      await ipc.rabbitPurgeQueue(connId, vhost, name)
      toasts.success(`Purged ${name}`, 'rabbitmq')
      messages = []
      fetched = false
      explorer.bumpRabbit(connId)
      await loadInfo()
    })
  }

  function deleteQueue() {
    askConfirm('Delete queue', `Delete queue "${name}" and every message in it? Its bindings go with it. This cannot be undone.`, 'Delete', async () => {
      await ipc.rabbitDeleteQueue(connId, vhost, name)
      toasts.success(`Deleted queue ${name}`, 'rabbitmq')
      explorer.bumpRabbit(connId)
      tabs.forceClose([tab.id])
    })
  }

  // ---- confirm (backdrop never closes — rule chung) ------------------------------
  let confirmState = $state<{ title: string; body: string; action: string; run: () => Promise<void> } | null>(null)
  let confirmBusy = $state(false)
  function askConfirm(title: string, body: string, action: string, run: () => Promise<void>) {
    confirmState = { title, body, action, run }
  }
  async function runConfirm() {
    if (!confirmState || confirmBusy) return
    confirmBusy = true
    try {
      await confirmState.run()
      confirmState = null
    } catch (e) {
      toasts.error(String(e), 'rabbitmq')
    } finally {
      confirmBusy = false
    }
  }

  const fmt = (n: number | null | undefined) => (n == null ? '?' : n.toLocaleString('en-US'))
</script>

<div style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative">
  <!-- header -->
  <div style="flex:none;display:flex;align-items:center;gap:var(--px-12);padding:var(--px-9) var(--px-14);border-bottom:var(--px-1) solid var(--border);background:var(--surface)">
    <span style="width:var(--px-3);height:var(--px-20);border-radius:var(--px-2);background:{accent}"></span>
    <div style="display:flex;flex-direction:column;line-height:1.15;min-width:0">
      <span class="mono" style="font-size:var(--px-13);font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={name}>{name}</span>
      <span class="mono" style="font-size:var(--px-10);color:var(--muted)">
        queue · vhost <span style="color:var(--text2)">{vhost}</span>{#if queue}{' · '}{queue.queue_type}{queue.durable ? ' · durable' : ''}{queue.auto_delete ? ' · auto-delete' : ''}{queue.exclusive ? ' · exclusive' : ''}{/if}
      </span>
    </div>
    <div style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      <span onclick={() => loadInfo()} onkeydown={(e) => e.key === 'Enter' && loadInfo()} role="button" tabindex="0" class="pv-btn" aria-busy={loading}><Icon name="refresh" size={12} /> Refresh</span>
      <span onclick={purge} onkeydown={(e) => e.key === 'Enter' && purge()} role="button" tabindex="0" class="pv-btn" style="color:var(--error)">Purge</span>
      <span onclick={deleteQueue} onkeydown={(e) => e.key === 'Enter' && deleteQueue()} role="button" tabindex="0" class="pv-btn" style="color:var(--error)">Delete queue</span>
    </div>
  </div>

  {#if gone}
    <div style="padding:var(--px-24);font-size:var(--px-13);color:var(--text2)">
      Queue <span class="mono" style="color:var(--text)">{name}</span> no longer exists in vhost <span class="mono">{vhost}</span> — it was deleted or expired.
    </div>
  {:else}
    {#if loadError}
      <div role="alert" style="padding:var(--px-8) var(--px-14);font-size:var(--px-11_5);color:var(--error);border-bottom:var(--px-1) solid var(--border)">{loadError}</div>
    {/if}
    <!-- stats -->
    <div style="flex:none;display:flex;gap:var(--px-10);padding:var(--px-10) var(--px-14);border-bottom:var(--px-1) solid var(--border);flex-wrap:wrap">
      {#each [['Ready', queue?.messages_ready], ['Unacked', queue?.messages_unacknowledged], ['Total', queue?.messages], ['Consumers', queue?.consumers]] as [label, value] (label)}
        <div class="rq-stat" data-stat={label}>
          <span class="rq-stat-label">{label}</span>
          <span class="mono rq-stat-value" style={label === 'Unacked' && Number(value) > 0 ? 'color:var(--tbl-alert)' : ''}>{fmt(value as number | null | undefined)}</span>
        </div>
      {/each}
      <div class="rq-stat">
        <span class="rq-stat-label">State</span>
        <span class="mono rq-stat-value" style="font-size:var(--px-12);color:{queue?.state === 'running' ? 'var(--sacc-green)' : 'var(--text2)'}">{queue?.state || '—'}</span>
      </div>
    </div>

    <!-- section switcher -->
    <div role="tablist" aria-label="Queue sections" style="flex:none;display:flex;gap:var(--px-4);padding:var(--px-6) var(--px-14) 0;border-bottom:var(--px-1) solid var(--border)">
      {#each [['messages', 'Messages'], ['live', 'Live'], ['bindings', `Bindings (${bindings.length})`], ['publish', 'Publish'], ['details', 'Details']] as [key, label] (key)}
        <span
          role="tab"
          tabindex="0"
          aria-selected={section === key}
          class="rq-tab"
          class:on={section === key}
          onclick={() => (section = key as Section)}
          onkeydown={(e) => e.key === 'Enter' && (section = key as Section)}
        >{label}</span>
      {/each}
    </div>

    <div style="flex:1;overflow:auto;min-height:0;padding:var(--px-12) var(--px-14)">
      {#if section === 'messages'}
        <div style="display:flex;align-items:center;gap:var(--px-10);flex-wrap:wrap;margin-bottom:var(--px-10)">
          <label style="font-size:var(--px-12);color:var(--text2);display:flex;align-items:center;gap:var(--px-6)">
            Count <input class="mono rq-input" type="number" min="1" max="1000" bind:value={count} aria-label="Message count" style="width:var(--px-80)" />
          </label>
          <select class="rq-input" bind:value={mode} aria-label="Get mode">
            <option value="requeue">Peek — messages stay in the queue (requeue)</option>
            <option value="ack">Consume — acknowledge and remove</option>
            <option value="reject">Reject — remove without requeue</option>
          </select>
          <span onclick={getMessages} onkeydown={(e) => e.key === 'Enter' && getMessages()} role="button" tabindex="0" class="pv-btn primary" aria-busy={fetching} style={fetching ? 'opacity:.6;pointer-events:none' : ''}>{fetching ? 'Getting…' : 'Get messages'}</span>
          {#if mode === 'requeue'}
            <span style="font-size:var(--px-11);color:var(--muted)">Peeked messages go back to the queue, marked redelivered.</span>
          {:else}
            <span style="font-size:var(--px-11);color:var(--error)">Messages fetched in this mode are removed from the queue.</span>
          {/if}
        </div>
        {#if !fetched}
          <div style="font-size:var(--px-12);color:var(--muted);padding:var(--px-12) 0">Press <b>Get messages</b> to read from <span class="mono">{name}</span>.</div>
        {:else if messages.length === 0}
          <div style="font-size:var(--px-12);color:var(--muted);padding:var(--px-12) 0">The queue has no ready messages.</div>
        {:else}
          <table class="mono" style="border-collapse:collapse;width:100%;font-size:var(--px-12);table-layout:fixed;{GRID_FONT}">
            <thead><tr>
              {#each [['#', 'width:var(--px-40)'], ['Routing key', 'width:var(--px-180)'], ['Exchange', 'width:var(--px-140)'], ['Redelivered', 'width:var(--px-90)'], ['Size', 'width:var(--px-80)'], ['Payload', ''], ['', 'width:var(--px-60)']] as [h, extra] (h || 'actions')}
                <th style="position:sticky;top:0;background:var(--header);border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-10);text-align:left;color:var(--tbl-head);font-weight:600;{extra}">{h}</th>
              {/each}
            </tr></thead>
            <tbody>
              {#each messages as m, i (i)}
                <tr class="rq-row" class:sel={selIdx === i} aria-selected={selIdx === i} onclick={() => (selIdx = i)}>
                  <td style="color:{cellColor(i, 'var(--muted)')}">{i + 1}</td>
                  <td style="color:{cellColor(i, 'var(--tbl-subject)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={m.routing_key}>{m.routing_key || '—'}</td>
                  <td style="color:{cellColor(i, 'var(--tbl-meta)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{exchangeLabel(m.exchange)}</td>
                  <td style="color:{cellColor(i, m.redelivered ? 'var(--sacc-amber)' : 'var(--tbl-quiet)')}">{m.redelivered ? 'yes' : 'no'}</td>
                  <td style="color:{cellColor(i, 'var(--syntax-number)')}">{formatPayloadBytes(m.payload_bytes)}</td>
                  <td style="color:{cellColor(i, 'var(--syntax-string)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={m.payload}>{payloadPreview(m)}</td>
                  <td style="white-space:nowrap">
                    <span onclick={(e) => { e.stopPropagation(); view(m, i) }} onkeydown={(e) => e.key === 'Enter' && view(m, i)} role="button" tabindex="0" title="View payload" style="cursor:pointer;color:{cellColor(i, 'var(--muted)')};margin-right:var(--px-8)">⛶</span>
                    <span onclick={(e) => { e.stopPropagation(); copy(m.payload, 'Payload copied') }} onkeydown={(e) => e.key === 'Enter' && copy(m.payload, 'Payload copied')} role="button" tabindex="0" title="Copy payload" style="cursor:pointer;color:{cellColor(i, 'var(--muted)')}">⧉</span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {:else if section === 'bindings'}
        <table class="mono" style="border-collapse:collapse;width:100%;max-width:var(--px-720);font-size:var(--px-12)">
          <thead><tr>
            {#each ['From exchange', 'Routing key', ''] as h (h || 'x')}
              <th style="border-bottom:var(--px-1) solid var(--border2);padding:var(--px-7) var(--px-10);text-align:left;color:var(--tbl-head);font-weight:600">{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each bindings as b (b.source + '|' + b.properties_key)}
              <tr class="rq-row">
                <td style="color:var(--tbl-link)">{exchangeLabel(b.source)}</td>
                <td style="color:var(--tbl-subject)">{b.routing_key || '—'}</td>
                <td style="text-align:right">
                  <!-- the implicit default-exchange binding cannot be removed -->
                  {#if b.source !== ''}
                    <span onclick={() => unbind(b)} onkeydown={(e) => e.key === 'Enter' && unbind(b)} role="button" tabindex="0" title="Remove binding" style="cursor:pointer;color:var(--error)">Unbind</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div style="margin-top:var(--px-14);display:flex;gap:var(--px-8);align-items:flex-end;flex-wrap:wrap">
          <label style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-11_5);color:var(--text2);font-weight:600">
            Bind from exchange
            <select class="rq-input" bind:value={bindExchange} aria-label="Bind from exchange">
              {#each bindable as x (x)}<option value={x}>{x}</option>{/each}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-11_5);color:var(--text2);font-weight:600">
            Routing key
            <input class="mono rq-input" bind:value={bindKey} placeholder="orders.*" aria-label="Binding routing key" spellcheck="false" />
          </label>
          <span onclick={bind} onkeydown={(e) => e.key === 'Enter' && bind()} role="button" tabindex="0" class="pv-btn primary" style={binding || !bindable.length ? 'opacity:.6;pointer-events:none' : ''}>Bind</span>
        </div>
        <div style="margin-top:var(--px-8);font-size:var(--px-11);color:var(--muted)">Every queue is also bound to the default exchange by its own name.</div>
      {:else if section === 'publish'}
        <RabbitPublishForm
          {connId}
          {vhost}
          exchange=""
          routingKey={name}
          exchanges={sortExchanges(exchanges).map((x) => x.name)}
          onPublished={() => void loadInfo()}
        />
      {:else if section === 'details'}
        <dl class="rq-dl">
          {#each [['Type', queue?.queue_type], ['Durable', queue ? String(queue.durable) : ''], ['Auto-delete', queue ? String(queue.auto_delete) : ''], ['Exclusive', queue ? String(queue.exclusive) : ''], ['Node', queue?.node], ['Policy', queue?.policy || '—'], ['Memory', queue?.memory != null ? formatPayloadBytes(queue.memory) : '—']] as [k, v] (k)}
            <dt>{k}</dt><dd class="mono">{v || '—'}</dd>
          {/each}
        </dl>
        <div style="margin-top:var(--px-12);font-size:var(--px-11_5);font-weight:600;color:var(--text2)">Arguments</div>
        <div style="margin-top:var(--px-6);display:flex">
          <CodeView value={JSON.stringify(queue?.arguments ?? {}, null, 2)} language={DS_JSON} readOnly height="auto" maxHeight={320} minHeight={60} ariaLabel="Queue arguments" />
        </div>
      {/if}
      <!-- Live stays mounted while the tab is open: switching sections must not stop
           a listening session (closing the tab does). -->
      <div style="display:{section === 'live' ? 'block' : 'none'}">
        <RabbitLivePanel {connId} {vhost} kind="queue" {name} />
      </div>
    </div>
  {/if}

  {#if viewState}
    <RabbitMessageDialog message={viewState.m} title="Message #{viewState.index + 1}" onClose={() => (viewState = null)} />
  {/if}

  {#if confirmState}
    <div role="presentation" style="position:absolute;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={confirmState.title}
        onkeydown={(e) => e.key === 'Escape' && (confirmState = null)}
        tabindex="-1"
        style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-460), 92%);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
      >
        <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">{confirmState.title}</div>
        <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">{confirmState.body}</div>
        <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
          <span onclick={() => (confirmState = null)} onkeydown={(e) => e.key === 'Enter' && (confirmState = null)} role="button" tabindex="0" class="pv-btn">Cancel</span>
          <span onclick={runConfirm} onkeydown={(e) => e.key === 'Enter' && runConfirm()} role="button" tabindex="0" class="pv-btn primary" style="background:var(--error);border-color:var(--error);{confirmBusy ? 'opacity:.6;pointer-events:none' : ''}">{confirmState.action}</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .rq-stat {
    display: flex;
    flex-direction: column;
    gap: var(--px-2);
    min-width: var(--px-90);
    padding: var(--px-6) var(--px-12);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-8);
    background: var(--panel);
  }
  .rq-stat-label {
    font-size: var(--px-10_5);
    color: var(--tbl-meta);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .rq-stat-value {
    font-size: var(--px-16);
    font-weight: 700;
    color: var(--syntax-number);
    font-variant-numeric: tabular-nums;
  }
  .rq-tab {
    font-size: var(--px-12);
    color: var(--text2);
    padding: var(--px-6) var(--px-12);
    border-bottom: var(--px-2) solid transparent;
    cursor: pointer;
  }
  .rq-tab.on {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--primary);
  }
  .rq-input {
    font-size: var(--px-12);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-8);
    color: var(--text);
    outline: none;
  }
  .rq-row td {
    border-bottom: var(--px-1) solid var(--border);
    padding: var(--px-6) var(--px-10);
  }
  .rq-row:nth-child(even) {
    background: var(--tbl-zebra);
  }
  .rq-row:hover:not(.sel) {
    background: var(--tbl-hover);
    cursor: default;
  }
  .rq-row.sel {
    background: var(--grid-select);
  }
  .rq-dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--px-6) var(--px-16);
    font-size: var(--px-12);
    margin: 0;
  }
  .rq-dl dt {
    color: var(--tbl-meta);
  }
  .rq-dl dd {
    margin: 0;
    color: var(--text);
  }
</style>
