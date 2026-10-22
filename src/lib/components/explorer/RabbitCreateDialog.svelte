<script lang="ts">
  // "Add a new queue" / "Add a new exchange" — laid out like the RabbitMQ
  // management UI: labelled rows (Virtual host, Type, Name, Durability, Auto
  // delete, Internal), typed "key = value [type]" argument rows and the quick
  // "Add" links for the arguments that apply to the chosen queue type.
  // The backdrop never closes it (rule chung); Escape / Cancel do.
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import { autofocus } from '$lib/actions/autofocus'
  import { toasts } from '$lib/stores/toast.svelte'
  import {
    EXCHANGE_ARG_HELPERS,
    QUEUE_TYPE_OPTIONS,
    addHelper,
    planBindings,
    routingKeyHint,
    usesRoutingKey,
    type BindRow,
    hasDurabilityChoice,
    parseArgs,
    queueArgHelpers,
    withTrailingEmpty,
    type ArgRow,
  } from '$lib/rabbitmq/arguments'
  import { createPreview } from '$lib/stream/rabbitmq-arguments'

  interface Props {
    connId: string
    kind: 'queue' | 'exchange'
    vhosts: string[]
    initialVhost: string
    exchangeTypes: string[]
    onClose: () => void
    onCreated: (vhost: string, name: string) => void
  }
  let { connId, kind, vhosts, initialVhost, exchangeTypes, onClose, onCreated }: Props = $props()

  // svelte-ignore state_referenced_locally — seeded once when the dialog opens
  let vhost = $state(initialVhost)
  let name = $state('')
  let queueType = $state('')
  let exchangeType = $state('direct')
  let durable = $state('true')
  let autoDelete = $state('false')
  let internal = $state('false')
  let rows = $state<ArgRow[]>(withTrailingEmpty([]))
  let busy = $state(false)
  let serverError = $state<string | null>(null)
  let existing = $state<string[]>([])
  // Optional bindings (queue form only): created right after the queue, so the new
  // queue starts receiving from the exchange(s) without a second step.
  let binds = $state<BindRow[]>([])
  let bindSources = $state<ipc.RabbitExchange[]>([])
  const typeOf = (x: string) => bindSources.find((e) => e.name === x)?.exchange_type
  const bindPlan = $derived(planBindings(binds, typeOf))

  const title = $derived(kind === 'queue' ? 'Add a new queue' : 'Add a new exchange')
  const helpers = $derived(kind === 'queue' ? queueArgHelpers(queueType) : EXCHANGE_ARG_HELPERS)
  const showDurability = $derived(kind === 'exchange' || hasDurabilityChoice(queueType))
  const parsed = $derived(parseArgs(rows))
  // the default exchange's name is '' — an empty field is "not filled in", not "taken"
  const taken = $derived(!!name.trim() && existing.includes(name.trim()))
  const canAdd = $derived(!!name.trim() && !taken && parsed.ok && !busy)
  // stream-workspace:rabbitmq — what Add will make, in sentences (rule U9)
  const preview = $derived(
    parsed.ok
      ? createPreview({
          kind,
          vhost,
          name,
          queueType,
          exchangeType,
          durable: durable === 'true',
          autoDelete: autoDelete === 'true',
          internal: internal === 'true',
          args: parsed.args,
          binds: bindPlan,
        })
      : [],
  )

  // Names already in the chosen vhost — declaring an existing one is silently a
  // no-op on the broker (or an "inequivalent arg" error), so say it up front.
  $effect(() => {
    const v = vhost
    untrack(async () => {
      try {
        if (kind === 'queue') {
          const [qs, xs] = await Promise.all([ipc.rabbitQueues(connId, v), ipc.rabbitExchanges(connId, v)])
          existing = qs.map((q) => q.name)
          // the default exchange binds every queue by name already and cannot be bound to
          bindSources = xs.filter((x) => x.name !== '')
          // an exchange picked in another vhost does not exist here
          binds = binds.map((b) => (bindSources.some((x) => x.name === b.exchange) ? b : { ...b, exchange: '' }))
        } else {
          existing = (await ipc.rabbitExchanges(connId, v)).map((x) => x.name)
        }
      } catch {
        existing = []
      }
    })
  })

  function setRow(i: number, patch: Partial<ArgRow>) {
    const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r))
    rows = withTrailingEmpty(next)
  }

  function removeRow(i: number) {
    rows = withTrailingEmpty(rows.filter((_, j) => j !== i))
  }

  async function add() {
    if (!canAdd || !parsed.ok) return
    busy = true
    serverError = null
    const n = name.trim()
    try {
      if (kind === 'queue') {
        const replicated = !hasDurabilityChoice(queueType)
        await ipc.rabbitDeclareQueue(connId, vhost, n, queueType, replicated ? true : durable === 'true', replicated ? false : autoDelete === 'true', parsed.args)
        // the queue exists now: a failed binding is reported, not a reason to undo it
        const failed: string[] = []
        for (const b of bindPlan) {
          try {
            await ipc.rabbitBindQueue(connId, vhost, b.exchange, n, b.routingKey)
          } catch (e) {
            failed.push(`${b.exchange} (${b.routingKey || 'no key'}): ${e}`)
          }
        }
        if (failed.length) toasts.error(`Queue ${n} created, but binding failed — ${failed.join('; ')}`, 'rabbitmq')
      } else {
        await ipc.rabbitDeclareExchange(connId, vhost, n, exchangeType, durable === 'true', autoDelete === 'true', internal === 'true', parsed.args)
      }
      onCreated(vhost, n)
    } catch (e) {
      serverError = String(e) // keep the form: fix and add again
    } finally {
      busy = false
    }
  }
</script>

<div role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:92">
  <div
    role="dialog"
    aria-modal="true"
    aria-label={title}
    onkeydown={(e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') add()
    }}
    tabindex="-1"
    style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-720), 94vw);max-height:92vh;overflow:auto;box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
  >
    <div style="font-size:var(--px-14);font-weight:700;color:var(--text);margin-bottom:var(--px-14)">{title}</div>

    <div class="rc-form">
      <label class="rc-label" for="rc-vhost">Virtual host:</label>
      <select id="rc-vhost" class="rc-input" bind:value={vhost} aria-label="Virtual host">
        {#each vhosts.length ? vhosts : [vhost] as v (v)}<option value={v}>{v}</option>{/each}
      </select>

      {#if kind === 'queue'}
        <label class="rc-label" for="rc-qtype">Type:</label>
        <select id="rc-qtype" class="rc-input" bind:value={queueType} aria-label="Type">
          {#each QUEUE_TYPE_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
        </select>
      {/if}

      <label class="rc-label" for="rc-name">Name:</label>
      <div>
        <div style="display:flex;align-items:center">
          <input id="rc-name" class="rc-input mono" style="flex:1;min-width:0" bind:value={name} use:autofocus spellcheck="false" aria-label="Name" />
          <span class="rc-req" aria-hidden="true">*</span>
        </div>
        {#if taken}<div class="rc-err">{kind === 'exchange' ? 'An exchange' : 'A queue'} named "{name.trim()}" already exists in {vhost}.</div>{/if}
      </div>

      {#if kind === 'exchange'}
        <label class="rc-label" for="rc-xtype">Type:</label>
        <select id="rc-xtype" class="rc-input" bind:value={exchangeType} aria-label="Type">
          {#each exchangeTypes as t (t)}<option value={t}>{t}</option>{/each}
        </select>
      {/if}

      {#if showDurability}
        <label class="rc-label" for="rc-dur">Durability:</label>
        <select id="rc-dur" class="rc-input" bind:value={durable} aria-label="Durability">
          <option value="true">Durable</option>
          <option value="false">Transient</option>
        </select>

        <label class="rc-label" for="rc-ad">Auto delete: <span class="rc-help" title={kind === 'queue' ? 'If yes, the queue will delete itself after at least one consumer has connected, and then all consumers have disconnected.' : 'If yes, the exchange will delete itself after at least one queue or exchange has been bound to this one, and then all queues or exchanges have been unbound.'}>?</span></label>
        <select id="rc-ad" class="rc-input" bind:value={autoDelete} aria-label="Auto delete">
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      {:else}
        <span class="rc-label">Durability:</span>
        <span class="rc-note">{queueType === 'stream' ? 'Streams' : 'Quorum queues'} are always durable and never auto-delete.</span>
      {/if}

      {#if kind === 'exchange'}
        <label class="rc-label" for="rc-int">Internal: <span class="rc-help" title="If yes, clients cannot publish to this exchange directly. It can only be used with exchange to exchange bindings.">?</span></label>
        <select id="rc-int" class="rc-input" bind:value={internal} aria-label="Internal">
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      {/if}

      <span class="rc-label">Arguments:</span>
      <div style="display:flex;flex-direction:column;gap:var(--px-5)" aria-label="Arguments">
        {#each rows as r, i (i)}
          <div style="display:flex;gap:var(--px-6);align-items:center" data-testid="arg-row">
            <input class="rc-input mono" style="flex:1 1 0;min-width:0" value={r.key} oninput={(e) => setRow(i, { key: e.currentTarget.value })} aria-label="Argument {i + 1} name" spellcheck="false" />
            <span style="color:var(--muted)">=</span>
            {#if r.type === 'boolean'}
              <select class="rc-input" style="flex:1 1 0;min-width:0" value={r.value} onchange={(e) => setRow(i, { value: e.currentTarget.value })} aria-label="Argument {i + 1} value">
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            {:else}
              <input class="rc-input mono" style="flex:1 1 0;min-width:0" value={r.value} oninput={(e) => setRow(i, { value: e.currentTarget.value })} aria-label="Argument {i + 1} value" spellcheck="false" placeholder={r.type === 'list' ? 'a, b, c' : ''} />
            {/if}
            <select
              class="rc-input"
              value={r.type}
              onchange={(e) => {
                const t = e.currentTarget.value as ArgRow['type']
                setRow(i, { type: t, value: t === 'boolean' && r.value !== 'false' ? 'true' : r.value })
              }}
              aria-label="Argument {i + 1} type"
            >
              <option value="string">String</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="list">List</option>
            </select>
            {#if r.key || r.value}
              <span onclick={() => removeRow(i)} onkeydown={(e) => e.key === 'Enter' && removeRow(i)} role="button" tabindex="0" title="Remove argument" style="cursor:pointer;color:var(--muted)">×</span>
            {:else}
              <span style="width:var(--px-10)"></span>
            {/if}
          </div>
        {/each}
        <div class="rc-helpers" data-testid="arg-helpers">
          <span style="color:var(--text2);font-weight:600">Add</span>
          {#each helpers as h, i (h.key)}
            {#if i > 0}<span style="color:var(--muted)">|</span>{/if}
            <span class="rc-link" onclick={() => (rows = addHelper(rows, h))} onkeydown={(e) => e.key === 'Enter' && (rows = addHelper(rows, h))} role="button" tabindex="0">{h.label}</span>
            <span class="rc-help" title="{h.key} — {h.hint}">?</span>
          {/each}
        </div>
        {#if !parsed.ok}<div class="rc-err" role="alert">{parsed.error}</div>{/if}
      </div>

      {#if kind === 'queue'}
        <span class="rc-label">Bindings: <span class="rc-help" title="Optional. Bind the new queue to existing exchanges right away. The routing key decides which messages the exchange routes here. Every queue is also bound to the default exchange by its own name.">?</span></span>
        <div style="display:flex;flex-direction:column;gap:var(--px-5)" aria-label="Bindings">
          {#each binds as b, i (i)}
            {@const t = typeOf(b.exchange) ?? ''}
            <div style="display:flex;gap:var(--px-6);align-items:center" data-testid="bind-row">
              <span class="rc-note" style="white-space:nowrap">From exchange</span>
              <select class="rc-input" style="flex:1 1 0;min-width:0" value={b.exchange} onchange={(e) => (binds[i] = { ...b, exchange: e.currentTarget.value })} aria-label="Binding {i + 1} exchange">
                <option value="">— choose —</option>
                {#each bindSources as x (x.name)}<option value={x.name}>{x.name} ({x.exchange_type})</option>{/each}
              </select>
              <span class="rc-note" style="white-space:nowrap">Routing key</span>
              <input
                class="rc-input mono"
                style="flex:1 1 0;min-width:0"
                value={b.routingKey}
                oninput={(e) => (binds[i] = { ...b, routingKey: e.currentTarget.value })}
                disabled={!!b.exchange && !usesRoutingKey(t)}
                placeholder={t === 'topic' ? 'order.*.eu' : t === 'direct' ? 'exact key' : ''}
                aria-label="Binding {i + 1} routing key"
                spellcheck="false"
              />
              <span onclick={() => (binds = binds.filter((_, j) => j !== i))} onkeydown={(e) => e.key === 'Enter' && (binds = binds.filter((_, j) => j !== i))} role="button" tabindex="0" title="Remove binding" style="cursor:pointer;color:var(--muted)">×</span>
            </div>
            {#if t}<div class="rc-note" style="padding-left:var(--px-4)" data-testid="bind-hint">{routingKeyHint(t)}</div>{/if}
          {/each}
          <div class="rc-helpers">
            {#if bindSources.length}
              <span class="rc-link" onclick={() => (binds = [...binds, { exchange: '', routingKey: '' }])} onkeydown={(e) => e.key === 'Enter' && (binds = [...binds, { exchange: '', routingKey: '' }])} role="button" tabindex="0">＋ Add binding</span>
              {#if !binds.length}<span class="rc-note">optional — without one, the queue only receives messages published to it by name</span>{/if}
            {:else}
              <span class="rc-note">No exchanges in {vhost} to bind to — messages can still be published to the queue by name.</span>
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if preview.length}
      <div class="rc-preview" data-testid="create-preview" aria-label="What will be created">
        <div class="rc-preview-title">What will be created</div>
        <ul>
          {#each preview as line, i (i)}<li>{line}</li>{/each}
        </ul>
      </div>
    {/if}

    {#if serverError}<div class="rc-err" role="alert" style="margin-top:var(--px-10)">{serverError}</div>{/if}

    <div style="display:flex;gap:var(--px-8);justify-content:flex-end;margin-top:var(--px-16)">
      <span onclick={onClose} onkeydown={(e) => e.key === 'Enter' && onClose()} role="button" tabindex="0" class="pv-btn">Cancel</span>
      <span onclick={add} onkeydown={(e) => e.key === 'Enter' && add()} role="button" tabindex="0" aria-disabled={!canAdd} class="pv-btn primary" style={canAdd ? '' : 'opacity:.5;pointer-events:none'}>{busy ? 'Adding…' : kind === 'queue' ? 'Add queue' : 'Add exchange'}</span>
    </div>
  </div>
</div>

<style>
  .rc-preview {
    margin-top: var(--px-14);
    padding: var(--px-10) var(--px-14);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-10);
    background: var(--panel);
  }
  .rc-preview-title {
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
    margin-bottom: var(--px-4);
  }
  .rc-preview ul {
    margin: 0;
    padding-left: var(--px-18);
    display: flex;
    flex-direction: column;
    gap: var(--px-3);
    font-size: var(--px-12_5);
    color: var(--text);
    line-height: 1.45;
  }
  .rc-form {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--px-10) var(--px-14);
    align-items: center;
  }
  .rc-label {
    font-size: var(--px-12);
    font-weight: 600;
    color: var(--text2);
    text-align: right;
    align-self: start;
    padding-top: var(--px-6);
    white-space: nowrap;
  }
  .rc-input {
    font-size: var(--px-12);
    background: var(--raised);
    border: var(--px-1) solid var(--border2);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-8);
    color: var(--text);
    outline: none;
  }
  select.rc-input {
    justify-self: start;
    min-width: var(--px-200);
  }
  .rc-req {
    color: var(--error);
    margin-left: var(--px-4);
  }
  .rc-help {
    display: inline-block;
    font-size: var(--px-10);
    font-weight: 700;
    color: var(--primary);
    border: var(--px-1) solid var(--primary);
    border-radius: 50%;
    width: var(--px-14);
    height: var(--px-14);
    line-height: var(--px-12);
    text-align: center;
    cursor: help;
  }
  .rc-note {
    font-size: var(--px-11_5);
    color: var(--muted);
  }
  .rc-helpers {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--px-4) var(--px-6);
    font-size: var(--px-11_5);
    margin-top: var(--px-2);
  }
  .rc-link {
    color: var(--tbl-link);
    cursor: pointer;
  }
  .rc-link:hover {
    text-decoration: underline;
  }
  .rc-err {
    font-size: var(--px-11_5);
    color: var(--error);
    margin-top: var(--px-4);
  }
</style>
