<script lang="ts">
  import Icon from '$lib/components/Icon.svelte'
  import PayloadPreview from '$lib/components/viewer/PayloadPreview.svelte'
  // RabbitMQ queue: counts in plain words + Messages (peek with requeue, or consume) +
  // Consumers (who reads it) + Bindings (add / remove) + Publish + Live + Details
  // (arguments as sentences, raw x-arguments under Advanced).
  // Used two ways: embedded in the cluster workspace's Queues details (stream-workspace,
  // SPEC-RABBITMQ-WORKSPACE.md) and, for tabs restored from older sessions, as its own tab.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import CodeView from '$lib/components/editor/CodeView.svelte'
  import RabbitPublishForm from './RabbitPublishForm.svelte'
  import RabbitLivePanel from './RabbitLivePanel.svelte'
  import RabbitMessageDialog from './RabbitMessageDialog.svelte'
  import HelpTip from '$lib/components/stream/HelpTip.svelte'
  import AdvancedToggle from '$lib/components/stream/AdvancedToggle.svelte'
  import { DS_JSON } from '$lib/editor/monarch'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import {
    exchangeLabel,
    formatPayloadBytes,
    payloadPreview,
    payloadText,
    sortExchanges,
  } from '$lib/rabbitmq/format'
  import { describeArguments, queueFeatures, queueTypeHelp, queueTypeLabel } from '$lib/stream/rabbitmq-arguments'
  import { consumersOf, formatRate, prefetchText } from '$lib/stream/rabbitmq-health'
  import { plural } from '$lib/stream/humanize'
  import { openRabbitExchange, openRabbitQueue } from '$lib/stream/rabbitmq-nav'
  import type { TabState } from '$lib/types'

  type Section = 'messages' | 'consumers' | 'live' | 'bindings' | 'publish' | 'details'

  interface Props {
    tab: TabState
    /** embedded in the cluster workspace: the queue to show (overrides tab.state) */
    vhost?: string
    name?: string
    embedded?: boolean
    /** sub-tab to start on (e.g. 'consumers' from "See consumers") */
    initialSection?: string
    /** embedded: the queue was deleted — the workspace closes the details */
    onDeleted?: () => void
    /** embedded: close the details pane */
    onClose?: () => void
  }
  let { tab, vhost: vhostProp, name: nameProp, embedded = false, initialSection, onDeleted, onClose }: Props = $props()

  const connId = $derived(tab.connectionId ?? '')
  const vhost = $derived(vhostProp ?? (tab.state as { vhost?: string }).vhost ?? '/')
  const name = $derived(nameProp ?? (tab.state as { name?: string }).name ?? '')

  const SECTIONS: Section[] = ['messages', 'consumers', 'live', 'bindings', 'publish', 'details']
  let section = $state<Section>(untrack(() => (SECTIONS.includes(initialSection as Section) ? (initialSection as Section) : 'messages')))

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
    if (section === 'consumers') void loadConsumers()
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

  // ---- consumers (who reads this queue) ----------------------------------------
  let consumers = $state<(ipc.RabbitConsumer & { app: string; host: string })[]>([])
  let consumersError = $state<string | null>(null)
  let consumersLoaded = $state(false)
  let loadingConsumers = $state(false)

  async function loadConsumers() {
    if (!connId || !name || loadingConsumers) return
    loadingConsumers = true
    try {
      // the application name lives on the connection; a user that may not list
      // connections still sees the consumers (with their machine only)
      const [ks, cs] = await Promise.allSettled([ipc.rabbitConsumers(connId, vhost), ipc.rabbitConnections(connId)])
      if (ks.status === 'rejected') throw ks.reason
      consumers = consumersOf(name, ks.value, cs.status === 'fulfilled' ? cs.value : [])
      consumersError = null
    } catch (e) {
      consumersError = String(e)
    } finally {
      consumersLoaded = true
      loadingConsumers = false
    }
  }

  $effect(() => {
    if (section !== 'consumers') return
    untrack(() => {
      if (!consumersLoaded) void loadConsumers()
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
    askConfirm('Remove binding', `Unbind "${name}" from exchange "${b.source}" (routing key "${b.routing_key}")? Messages that only this binding routed here will no longer arrive.`, 'Unbind', async () => {
      await ipc.rabbitUnbindQueue(connId, vhost, b.source, name, b.properties_key)
      toasts.success('Binding removed', 'rabbitmq')
      await loadInfo()
    })
  }

  function openExchange(x: string) {
    if (embedded) openRabbitExchange(connId, vhost, x)
  }

  // ---- purge / delete ----------------------------------------------------------
  // The dialogs state the consequence with the real number (rule U8).
  const waiting = $derived(queue?.messages_ready ?? null)
  function purge() {
    const n = waiting
    const what = n == null ? 'every waiting message' : plural(n, 'waiting message')
    askConfirm(
      'Purge queue',
      `Remove ${what} from "${name}"? Messages in progress stay with their consumers. This cannot be undone.`,
      n == null ? 'Purge' : `Purge ${plural(n, 'message')}`,
      async () => {
        await ipc.rabbitPurgeQueue(connId, vhost, name)
        toasts.success(`Purged ${name}`, 'rabbitmq')
        messages = []
        fetched = false
        explorer.bumpRabbit(connId)
        await loadInfo()
      },
    )
  }

  function deleteQueue() {
    const total = queue?.messages
    const lost = total == null ? 'every message in it' : total === 0 ? 'it (it is empty)' : plural(total, 'message')
    askConfirm(
      'Delete queue',
      `Delete queue "${name}" and ${total == null || total === 0 ? lost : `the ${lost} in it`}? Its ${plural(Math.max(0, bindings.filter((b) => b.source !== '').length), 'binding')} go with it. This cannot be undone.`,
      'Delete queue',
      async () => {
        await ipc.rabbitDeleteQueue(connId, vhost, name)
        toasts.success(`Deleted queue ${name}`, 'rabbitmq')
        explorer.bumpRabbit(connId)
        if (embedded) onDeleted?.()
        else tabs.forceClose([tab.id])
      },
    )
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
  const sentences = $derived(describeArguments(queue?.arguments))
  const features = $derived(queue ? queueFeatures(queue) : [])

  // Plain-language counters (rule U1); data-stat keeps the API name for tests/tools.
  const STATS = [
    { id: 'Ready', label: 'Waiting', help: 'Messages no consumer has picked up yet.' },
    { id: 'Unacked', label: 'In progress', help: 'Delivered to a consumer, not confirmed yet.' },
    { id: 'Total', label: 'Total', help: 'Waiting + in progress.' },
    { id: 'Consumers', label: 'Consumers', help: 'Applications reading from this queue right now.' },
  ] as const
  const statValue = (id: string) =>
    id === 'Ready' ? queue?.messages_ready : id === 'Unacked' ? queue?.messages_unacknowledged : id === 'Total' ? queue?.messages : queue?.consumers
</script>

<div class="ds-ws" class:rq-embedded={embedded} data-rabbit-queue={name}>
  <!-- header -->
  <div class="rq-ehead">
    <div class="rq-etitle">
      <span class="rq-ename mono" title={name}>{name}</span>
      {#if onClose}<button type="button" class="rq-close" onclick={onClose} aria-label="Close details" title="Close details">×</button>{/if}
    </div>
    <div class="rq-chips">
      {#if queue}
        <span class="ds-chip" title={queueTypeHelp(queue.queue_type)}>{queueTypeLabel(queue.queue_type)} queue</span>
        {#each features as f (f.label)}<span class="ds-chip" title={f.help}>{f.label}</span>{/each}
        {#if queue.policy}<span class="ds-chip" title="A policy sets extra rules on this queue">Policy {queue.policy}</span>{/if}
        {#if queue.publish_rate != null}<span class="ds-chip" title="Messages per second coming in · delivered">In {formatRate(queue.publish_rate)} · Out {formatRate(queue.deliver_rate)}</span>{/if}
      {/if}
    </div>
    <div class="rq-eactions">
      <button type="button" class="cfm-btn" onclick={() => loadInfo()} aria-busy={loading}><Icon name="refresh" size={12} /> Refresh</button>
      <button type="button" class="cfm-btn ds-danger-outline" onclick={purge}>Purge…</button>
      <button type="button" class="cfm-btn ds-danger-outline" onclick={deleteQueue}>Delete queue…</button>
    </div>
  </div>

  {#if gone}
    <div class="ds-empty" style="padding:var(--px-24)">
      <b>This queue no longer exists</b>
      <span>Queue <span class="mono">{name}</span> is not in vhost <span class="mono">{vhost}</span> any more — it was deleted or expired.</span>
    </div>
  {:else}
    {#if loadError}
      <div role="alert" style="padding:var(--px-8) var(--px-14);font-size:var(--px-11_5);color:var(--error);border-bottom:var(--px-1) solid var(--border)">{loadError}</div>
    {/if}
    <!-- stats -->
    <div class="rq-stats">
      {#each STATS as s (s.id)}
        {@const value = statValue(s.id)}
        <div class="rq-stat" data-stat={s.id} title={s.help}>
          <span class="rq-stat-label">{s.label} <HelpTip text={s.help} size={11} /></span>
          <span class="ds-num rq-stat-value" style={s.id === 'Unacked' && Number(value) > 0 ? 'color:var(--sacc-amber)' : ''}>{fmt(value)}</span>
        </div>
      {/each}
      <div class="rq-stat" data-stat="State">
        <span class="rq-stat-label">State</span>
        <span class="rq-stat-value" style="font-size:var(--px-13);color:{queue?.state === 'running' ? 'var(--sacc-green)' : 'var(--text2)'}">{queue?.state ? queue.state[0].toUpperCase() + queue.state.slice(1) : '—'}</span>
      </div>
    </div>

    <!-- section switcher -->
    <div role="tablist" aria-label="Queue sections" class="rq-tabs">
      {#each [['messages', 'Messages'], ['consumers', `Consumers${queue?.consumers != null ? ` (${queue.consumers})` : ''}`], ['live', 'Live'], ['bindings', `Bindings (${bindings.length})`], ['publish', 'Publish'], ['details', 'Details']] as [key, label] (key)}
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

    <div class="rq-body">
      {#if section === 'messages'}
        <div style="display:flex;align-items:center;gap:var(--px-10);flex-wrap:wrap;margin-bottom:var(--px-10)">
          <label style="font-size:var(--px-12);color:var(--text2);display:flex;align-items:center;gap:var(--px-6)">
            Count <input class="ds-control mono rq-input" type="number" min="1" max="1000" bind:value={count} aria-label="Message count" style="width:var(--px-80)" />
          </label>
          <select class="ds-control rq-input" bind:value={mode} aria-label="Get mode">
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
          <div class="ds-empty">Press <b style="display:inline;font-size:inherit">Get messages</b> to read from <span class="mono">{name}</span>.</div>
        {:else if messages.length === 0}
          <div class="ds-empty"><b>Nothing waiting</b>The queue has no waiting messages.</div>
        {:else}
          <table class="ds-table" style="font-size:var(--px-12_5);table-layout:fixed;">
            <thead><tr>
              {#each [['#', 'width:var(--px-40)'], ['Routing key', 'width:var(--px-180)'], ['Exchange', 'width:var(--px-140)'], ['Redelivered', 'width:var(--px-90)'], ['Size', 'width:var(--px-80)'], ['Payload', ''], ['', 'width:var(--px-60)']] as [h, extra] (h || 'actions')}
                <th style={extra}>{h}</th>
              {/each}
            </tr></thead>
            <tbody>
              {#each messages as m, i (i)}
                <tr class="rq-row" class:sel={selIdx === i} aria-selected={selIdx === i} onclick={() => (selIdx = i)}>
                  <td class="ds-num" style="color:{cellColor(i, 'var(--muted)')}">{i + 1}</td>
                  <td class="mono" style="font-size:var(--px-12);color:{cellColor(i, 'var(--tbl-subject)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={m.routing_key}>{m.routing_key || '—'}</td>
                  <td style="color:{cellColor(i, 'var(--tbl-meta)')};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{exchangeLabel(m.exchange)}</td>
                  <td style="color:{cellColor(i, m.redelivered ? 'var(--sacc-amber)' : 'var(--tbl-quiet)')}">{m.redelivered ? 'yes' : 'no'}</td>
                  <td class="ds-num" style="color:{cellColor(i, 'var(--syntax-number)')}">{formatPayloadBytes(m.payload_bytes)}</td>
                  <td style="max-width:var(--px-560)">{#if payloadText(m).binary}<span class="mono" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--px-12);color:var(--muted)" title={m.payload}>{payloadPreview(m)}</span>{:else}<PayloadPreview text={payloadText(m).text} inverted={selIdx === i} />{/if}</td>
                  <td style="white-space:nowrap">
                    <span onclick={(e) => { e.stopPropagation(); view(m, i) }} onkeydown={(e) => e.key === 'Enter' && view(m, i)} role="button" tabindex="0" title="View payload" class="ds-act" style="color:{cellColor(i, 'var(--muted)')}"><Icon name="expand" size={13} /></span>
                    <span onclick={(e) => { e.stopPropagation(); copy(m.payload, 'Payload copied') }} onkeydown={(e) => e.key === 'Enter' && copy(m.payload, 'Payload copied')} role="button" tabindex="0" title="Copy payload" class="ds-act" style="color:{cellColor(i, 'var(--muted)')}"><Icon name="copy" size={13} /></span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {:else if section === 'consumers'}
        <div class="rq-consumers" data-testid="queue-consumers">
          {#if consumersError}
            <div class="ds-empty" role="alert"><b>Could not read the consumers</b>{consumersError}</div>
          {:else if !consumersLoaded}
            <div class="ds-empty" aria-busy="true">Reading consumers…</div>
          {:else if consumers.length === 0}
            <div class="ds-empty">
              <b>No consumer is reading this queue</b>
              {#if (queue?.messages_ready ?? 0) > 0}{plural(queue?.messages_ready ?? 0, 'message')} wait until an application subscribes to <span class="mono">{name}</span>.{:else}An application appears here as soon as it subscribes to <span class="mono">{name}</span>.{/if}
            </div>
          {:else}
            <table class="ds-table rq-ctable">
              <thead>
                <tr>
                  <th>Application</th>
                  <th>Machine</th>
                  <th class="r">Messages held at once <HelpTip text="How many messages the consumer may hold before confirming them (prefetch)." size={11} /></th>
                  <th>Confirms</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {#each consumers as k (k.consumer_tag + k.channel_name)}
                  <tr class="rq-row">
                    <td><span class="rq-strong">{k.app}</span></td>
                    <td class="mono rq-dim">{k.host || '—'}</td>
                    <td class="r ds-num">{prefetchText(k.prefetch_count)}</td>
                    <td>{k.ack_required ? 'Confirms each message' : 'Auto (no confirmation)'}</td>
                    <td>{#if k.active}<span class="rq-ok">Receiving</span>{:else}<span class="rq-warn" title="Single active consumer: this one waits as a backup">Standby</span>{/if}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <AdvancedToggle>
              <table class="ds-table rq-ctable">
                <thead><tr><th>Consumer tag</th><th>Channel</th><th>User</th><th>Exclusive</th></tr></thead>
                <tbody>
                  {#each consumers as k (k.consumer_tag + k.channel_name)}
                    <tr><td class="mono">{k.consumer_tag}</td><td class="mono">{k.channel_name}</td><td>{k.user}</td><td>{k.exclusive ? 'yes' : 'no'}</td></tr>
                  {/each}
                </tbody>
              </table>
            </AdvancedToggle>
          {/if}
          <div class="rq-foot"><button type="button" class="cfm-btn" onclick={() => { consumersLoaded = false; void loadConsumers() }} disabled={loadingConsumers}><Icon name="refresh" size={12} /> {loadingConsumers ? 'Reading…' : 'Refresh consumers'}</button></div>
        </div>
      {:else if section === 'bindings'}
        <p class="rq-hint">Bindings decide which messages reach this queue: an exchange forwards a message here when its routing key matches.</p>
        <table class="ds-table" style="max-width:var(--px-720);font-size:var(--px-12_5);">
          <thead><tr>
            {#each ['From exchange', 'Routing key', ''] as h (h || 'x')}
              <th>{h}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each bindings as b (b.source + '|' + b.properties_key)}
              <tr class="rq-row">
                <td>
                  {#if embedded && b.source !== ''}
                    <button type="button" class="rq-link" onclick={() => openExchange(b.source)}>{exchangeLabel(b.source)}</button>
                  {:else}
                    <span style="color:var(--tbl-link)">{exchangeLabel(b.source)}</span>
                  {/if}
                </td>
                <td class="mono" style="font-size:var(--px-12);color:var(--tbl-subject)">{b.routing_key || '—'}</td>
                <td style="text-align:right">
                  <!-- the implicit default-exchange binding cannot be removed -->
                  {#if b.source !== ''}
                    <span onclick={() => unbind(b)} onkeydown={(e) => e.key === 'Enter' && unbind(b)} role="button" tabindex="0" title="Remove binding" class="eg-btn ds-danger-outline">Unbind</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div style="margin-top:var(--px-14);display:flex;gap:var(--px-8);align-items:flex-end;flex-wrap:wrap">
          <label style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-11_5);color:var(--text2);font-weight:600">
            Bind from exchange
            <select class="ds-control rq-input" bind:value={bindExchange} aria-label="Bind from exchange">
              {#each bindable as x (x)}<option value={x}>{x}</option>{/each}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:var(--px-4);font-size:var(--px-11_5);color:var(--text2);font-weight:600">
            Routing key
            <input class="ds-control mono rq-input" bind:value={bindKey} placeholder="orders.*" aria-label="Binding routing key" spellcheck="false" />
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
        <div class="rq-details">
          <div class="ds-section-title">How this queue behaves</div>
          <ul class="rq-sentences" data-testid="queue-rules">
            {#if queue}
              <li>{queueTypeHelp(queue.queue_type)}</li>
              {#each features as f (f.label)}<li><b>{f.label}</b> — {f.help}</li>{/each}
            {/if}
            {#each sentences as s (s.key)}
              <li title={s.key}>
                {s.text}{#if s.exchange != null}{' '}{#if embedded && s.exchange !== ''}<button type="button" class="rq-link mono" onclick={() => openExchange(s.exchange ?? '')}>{s.exchange}</button>{:else}<span class="mono">{s.exchange || exchangeLabel('')}</span>{/if}{/if}{#if s.queue != null}{' '}{#if embedded}<button type="button" class="rq-link mono" onclick={() => openRabbitQueue(connId, vhost, s.queue ?? '')}>{s.queue}</button>{:else}<span class="mono">{s.queue}</span>{/if}{/if}
              </li>
            {/each}
            {#if queue && !sentences.length}<li class="rq-dim">No extra rules — messages stay until a consumer takes them.</li>{/if}
            {#if queue?.policy}<li>Policy <b class="mono">{queue.policy}</b> also applies (see Users &amp; access › Policies).</li>{/if}
          </ul>
          <dl class="rq-dl">
            {#each [['Stored on node', queue?.node], ['Memory used', queue?.memory != null ? formatPayloadBytes(queue.memory) : '—'], ['Incoming', formatRate(queue?.publish_rate)], ['Delivered', formatRate(queue?.deliver_rate)], ['Confirmed', formatRate(queue?.ack_rate)]] as [k, v] (k)}
              <dt>{k}</dt><dd>{v || '—'}</dd>
            {/each}
          </dl>
          <AdvancedToggle label="Advanced — raw arguments">
            <dl class="rq-dl" style="margin-bottom:var(--px-8)">
              {#each [['Type', queue?.queue_type], ['Durable', queue ? String(queue.durable) : ''], ['Auto-delete', queue ? String(queue.auto_delete) : ''], ['Exclusive', queue ? String(queue.exclusive) : ''], ['Policy', queue?.policy || '—']] as [k, v] (k)}
                <dt>{k}</dt><dd class="mono">{v || '—'}</dd>
              {/each}
            </dl>
            <div style="display:flex">
              <CodeView value={JSON.stringify(queue?.arguments ?? {}, null, 2)} language={DS_JSON} readOnly height="auto" maxHeight={320} minHeight={60} ariaLabel="Queue arguments" />
            </div>
          </AdvancedToggle>
        </div>
      {/if}
      <!-- Live stays mounted while the queue is open: switching sections must not stop
           a listening session (closing the queue does). -->
      <div style="display:{section === 'live' ? 'block' : 'none'}">
        <RabbitLivePanel {connId} {vhost} kind="queue" {name} />
      </div>
    </div>
  {/if}

  {#if viewState}
    <RabbitMessageDialog message={viewState.m} title="Message #{viewState.index + 1}" onClose={() => (viewState = null)} />
  {/if}

  {#if confirmState}
    <div role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:60">
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
          <span onclick={runConfirm} onkeydown={(e) => e.key === 'Enter' && runConfirm()} role="button" tabindex="0" class="pv-btn danger" style="{confirmBusy ? 'opacity:.6;pointer-events:none' : ''}">{confirmState.action}</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .rq-embedded {
    flex: 1;
    min-height: 0;
    background: var(--panel);
  }
  .rq-ehead {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--px-8);
    padding: var(--px-14) var(--px-18) var(--px-10);
    background: var(--surface);
    border-bottom: var(--px-1) solid var(--border);
  }
  .rq-etitle {
    display: flex;
    align-items: center;
    gap: var(--px-10);
  }
  .rq-ename {
    flex: 1;
    min-width: 0;
    font-size: var(--px-15);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rq-close {
    border: 0;
    background: transparent;
    font-size: var(--px-18);
    line-height: 1;
    color: var(--muted);
    cursor: pointer;
    padding: var(--px-2) var(--px-6);
    border-radius: var(--px-6);
  }
  .rq-close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .rq-chips,
  .rq-eactions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--px-6);
  }
  .rq-eactions :global(.cfm-btn) {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  .rq-stats {
    flex: none;
    display: flex;
    gap: var(--px-10);
    padding: var(--px-12) var(--px-18);
    border-bottom: var(--px-1) solid var(--border);
    flex-wrap: wrap;
    background: var(--surface);
  }
  .rq-tabs {
    flex: none;
    display: flex;
    gap: var(--px-4);
    padding: 0 var(--px-14);
    border-bottom: var(--px-1) solid var(--border);
    background: var(--surface);
    overflow-x: auto;
  }
  .rq-body {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: var(--px-14) var(--px-18);
  }
  /* summary cards: a label, then the number large and readable */
  .rq-stat {
    display: flex;
    flex-direction: column;
    gap: var(--px-4);
    min-width: var(--px-110);
    padding: var(--px-10) var(--px-14);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    background: var(--raised);
    box-shadow: var(--shadow-xs);
  }
  .rq-stat-label {
    display: inline-flex;
    align-items: center;
    gap: var(--px-4);
    font-size: var(--px-12);
    color: var(--text2);
    font-weight: 500;
  }
  .rq-stat-value {
    font-size: var(--px-20);
    font-weight: 650;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
  }
  .rq-tab {
    font-size: var(--px-13);
    font-weight: 500;
    color: var(--text2);
    padding: var(--px-10) var(--px-10);
    border-bottom: var(--px-2) solid transparent;
    margin-bottom: calc(-1 * var(--px-1));
    cursor: pointer;
    white-space: nowrap;
  }
  .rq-tab:hover {
    color: var(--text);
  }
  .rq-tab.on {
    color: var(--text);
    font-weight: 600;
    border-bottom-color: var(--primary);
  }
  .rq-row td {
    padding: var(--px-8) var(--px-12);
  }
  .rq-row:hover:not(.sel) {
    background: var(--tbl-hover);
    cursor: default;
  }
  .rq-row.sel {
    background: var(--grid-select);
  }
  .rq-hint {
    margin: 0 0 var(--px-10);
    font-size: var(--px-12);
    color: var(--text2);
  }
  .rq-link {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--tbl-link);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .rq-link:hover {
    text-decoration: underline;
  }
  .rq-strong {
    font-weight: 600;
    color: var(--text);
  }
  .rq-dim {
    color: var(--muted);
  }
  .rq-ok {
    color: var(--sacc-green);
    font-weight: 600;
  }
  .rq-warn {
    color: var(--sacc-amber);
    font-weight: 600;
  }
  .rq-ctable {
    font-size: var(--px-12_5);
    margin-bottom: var(--px-10);
  }
  .rq-ctable .r {
    text-align: right;
  }
  .rq-foot {
    margin-top: var(--px-10);
  }
  .rq-foot :global(.cfm-btn) {
    display: inline-flex;
    align-items: center;
    gap: var(--px-6);
  }
  .rq-details {
    display: flex;
    flex-direction: column;
    gap: var(--px-12);
    max-width: var(--px-720);
  }
  .rq-sentences {
    margin: 0;
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
  }
  .rq-dl {
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
  }
  .rq-dl dt {
    color: var(--tbl-meta);
  }
  .rq-dl dd {
    margin: 0;
    color: var(--text);
  }
</style>
