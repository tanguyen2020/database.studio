<script lang="ts">
  // RabbitMQ browser embedded in the ObjectExplorer sidebar (same shape as the
  // Redis key browser): vhost selector + broker summary + ＋Queue / ＋Exchange, a
  // name filter, and two folders — Queues (message counts) and Exchanges (type).
  // Clicking a queue / exchange opens its tab (rabbit-queue / rabbit-exchange).
  // Everything is read through the Management HTTP API (commands/rabbitmq.rs).
  import { untrack } from 'svelte'
  import * as ipc from '$lib/ipc'
  import * as ContextMenu from '$lib/components/ui/context-menu'
  import RabbitCreateDialog from './RabbitCreateDialog.svelte'
  import { explorer } from '$lib/stores/explorer.svelte'
  import { tabs } from '$lib/stores/tabs.svelte'
  import { toasts } from '$lib/stores/toast.svelte'
  import {
    exchangeLabel,
    filterByName,
    isBuiltinExchange,
    queueMeta,
    queueTypeBadge,
    sortExchanges,
  } from '$lib/rabbitmq/format'

  interface Props {
    connId: string
    /** vhost of the connection profile ('' = '/') */
    defaultVhost?: string
    /** bumped by the sidebar header Refresh */
    refreshKey?: number
    /** called when a reload finished, so the header spinner spans the real work */
    onReloaded?: () => void
  }
  let { connId, defaultVhost = '', refreshKey = 0, onReloaded }: Props = $props()

  let vhost = $state('/')
  let vhosts = $state<string[]>([])
  let overview = $state<ipc.RabbitOverview | null>(null)
  let queues = $state<ipc.RabbitQueue[]>([])
  let exchanges = $state<ipc.RabbitExchange[]>([])
  let filter = $state('')
  let loading = $state(false)
  let error = $state<string | null>(null)
  let queuesError = $state<string | null>(null)
  let exchangesError = $state<string | null>(null)
  /** said once when the configured vhost did not exist and another was picked */
  let vhostNote = $state<string | null>(null)
  let openQueues = $state(true)
  let openExchanges = $state(true)

  const qRows = $derived(filterByName(queues, filter, (q) => q.name))
  const xRows = $derived(filterByName(sortExchanges(exchanges), filter, (x) => exchangeLabel(x.name)))

  // Highlight the queue / exchange whose tab is active (this connection + vhost).
  const active = $derived.by(() => {
    const t = tabs.active
    if (!t || t.connectionId !== connId) return null
    if (t.contentType !== 'rabbit-queue' && t.contentType !== 'rabbit-exchange') return null
    const s = t.state as { vhost?: string; name?: string }
    return s.vhost === vhost ? { kind: t.contentType, name: s.name ?? '' } : null
  })

  // A new load supersedes the previous one (switching vhost twice quickly must not
  // let the slower, older answer overwrite the newer one).
  let gen = 0
  async function load() {
    const mine = ++gen
    loading = true
    error = null
    try {
      // 1) where are we: broker summary (carries the vhost the connection really
      //    opened on) + the vhosts that exist.
      const [ov, vs] = await Promise.all([ipc.rabbitOverview(connId), ipc.rabbitVhosts(connId)])
      if (mine !== gen) return
      overview = ov
      vhosts = vs
      // An empty Virtual host field means "/", but a broker deployed with another
      // default vhost has no "/": follow the vhost the backend resolved instead of
      // querying one that does not exist (that was a bare "Not found" + empty tree).
      if (vs.length && !vs.includes(vhost)) {
        const next = vs.includes(ov.vhost) ? ov.vhost : vs[0]
        vhostNote = `Virtual host '${vhost}' does not exist on this broker — showing '${next}'.`
        vhost = next
      }
      // 2) the two folders, independently: one refusal must not blank the other.
      const [qs, xs] = await Promise.allSettled([ipc.rabbitQueues(connId, vhost), ipc.rabbitExchanges(connId, vhost)])
      if (mine !== gen) return
      queues = qs.status === 'fulfilled' ? qs.value : []
      exchanges = xs.status === 'fulfilled' ? xs.value : []
      queuesError = qs.status === 'rejected' ? String(qs.reason) : null
      exchangesError = xs.status === 'rejected' ? String(xs.reason) : null
    } catch (e) {
      if (mine === gen) error = String(e)
    } finally {
      if (mine === gen) {
        loading = false
        onReloaded?.()
      }
    }
  }

  // Header Refresh (refreshKey) + another component's bump (tick): last values seen,
  // re-seeded on a connection switch so the switch does not count as a refresh.
  let seen = { key: 0, tick: 0 }

  // Connection switch → start on the profile's vhost.
  $effect(() => {
    void connId
    untrack(() => {
      seen = { key: refreshKey, tick: explorer.rabbitTick[connId] ?? 0 }
      vhost = defaultVhost.trim() || '/'
      queues = []
      exchanges = []
      overview = null
      vhostNote = null
      queuesError = null
      exchangesError = null
      void load()
    })
  })

  // Header Refresh (refreshKey) + another component's bump (tick) → reload in place.
  $effect(() => {
    const key = refreshKey
    const tick = explorer.rabbitTick[connId] ?? 0
    untrack(() => {
      if (key === seen.key && tick === seen.tick) return
      seen = { key, tick }
      void load()
    })
  })

  function switchVhost(e: Event) {
    vhost = (e.currentTarget as HTMLSelectElement).value
    vhostNote = null
    void load()
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    toasts.success('Copied', 'rabbitmq')
  }

  // ---- confirm (purge / delete) — backdrop never closes (rule chung) ----------
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

  function purgeQueue(name: string) {
    askConfirm('Purge queue', `Remove every ready message from "${name}"? Unacknowledged messages stay with their consumers. This cannot be undone.`, 'Purge', async () => {
      await ipc.rabbitPurgeQueue(connId, vhost, name)
      toasts.success(`Purged ${name}`, 'rabbitmq')
      explorer.bumpRabbit(connId)
    })
  }

  function deleteQueue(name: string) {
    askConfirm('Delete queue', `Delete queue "${name}" and every message in it? Its bindings go with it. This cannot be undone.`, 'Delete', async () => {
      await ipc.rabbitDeleteQueue(connId, vhost, name)
      toasts.success(`Deleted queue ${name}`, 'rabbitmq')
      explorer.bumpRabbit(connId)
    })
  }

  function deleteExchange(name: string) {
    askConfirm('Delete exchange', `Delete exchange "${name}"? Every binding from it is removed. This cannot be undone.`, 'Delete', async () => {
      await ipc.rabbitDeleteExchange(connId, vhost, name)
      toasts.success(`Deleted exchange ${name}`, 'rabbitmq')
      explorer.bumpRabbit(connId)
    })
  }

  // ---- create queue / exchange (RabbitMQ-style form: RabbitCreateDialog) ----------
  let createKind = $state<'queue' | 'exchange' | null>(null)

  function openCreate(kind: 'queue' | 'exchange') {
    createKind = kind
  }

  async function created(kind: 'queue' | 'exchange', v: string, name: string) {
    createKind = null
    toasts.success(`Created ${kind} ${name}`, 'rabbitmq')
    if (v !== vhost) {
      vhost = v // follow it into the vhost it was created in
      vhostNote = null
    }
    await load()
    if (kind === 'queue') tabs.openRabbitQueue(connId, v, name)
    else tabs.openRabbitExchange(connId, v, name)
  }

  const TYPE_COLOR: Record<string, string> = {
    C: 'var(--sacc-orange)',
    Q: 'var(--sacc-purple)',
    S: 'var(--sacc-cyan)',
  }
</script>

<div style="display:flex;flex-direction:column;min-height:0">
  <!-- sticky header: vhost + broker summary + actions + filter -->
  <div style="position:sticky;top:0;z-index:2;background:var(--surface);flex:none;padding:var(--px-8) var(--px-8) var(--px-6);border-bottom:var(--px-1) solid var(--border);display:flex;align-items:center;gap:var(--px-8);flex-wrap:wrap">
    <span style="font-size:var(--px-12);color:var(--text2)">vhost</span>
    <select value={vhost} onchange={switchVhost} disabled={loading} class="mono" title="Virtual host" aria-label="RabbitMQ virtual host" style="font-size:var(--px-11);background:var(--panel);border:var(--px-1) solid var(--border);border-radius:var(--px-6);padding:var(--px-3) var(--px-6);color:var(--text);cursor:pointer;outline:none;max-width:var(--px-140){loading ? ';opacity:.6' : ''}">
      {#each vhosts.length ? vhosts : [vhost] as v (v)}<option value={v}>{v}</option>{/each}
    </select>
    {#if loading}
      <span class="mono" aria-live="polite" style="font-size:var(--px-10_5);color:var(--primary);display:inline-flex;align-items:center;gap:var(--px-4)">
        <span class="rb-spin" aria-hidden="true">⟳</span> Loading…
      </span>
    {:else if overview}
      <span class="mono" data-testid="rabbit-summary" style="font-size:var(--px-10_5);color:var(--muted)" title="Broker totals across every vhost · Erlang {overview.erlang_version}">
        RabbitMQ {overview.rabbitmq_version} · {overview.messages.toLocaleString('en-US')} msg
      </span>
    {/if}
    <span style="margin-left:auto;display:flex;gap:var(--px-8);align-items:center">
      <span onclick={() => openCreate('queue')} onkeydown={(e) => e.key === 'Enter' && openCreate('queue')} role="button" tabindex="0" title="Declare a new queue" style="font-size:var(--px-10_5);color:var(--primary);cursor:pointer">＋ Queue</span>
      <span onclick={() => openCreate('exchange')} onkeydown={(e) => e.key === 'Enter' && openCreate('exchange')} role="button" tabindex="0" title="Declare a new exchange" style="font-size:var(--px-10_5);color:var(--primary);cursor:pointer">＋ Exchange</span>
      <span onclick={() => tabs.openUserManager(connId)} onkeydown={(e) => e.key === 'Enter' && tabs.openUserManager(connId)} role="button" tabindex="0" title="Users, permissions, policies and virtual hosts" style="font-size:var(--px-10_5);color:var(--primary);cursor:pointer">Users ▸</span>
    </span>
    <input
      bind:value={filter}
      placeholder="Filter queues & exchanges…"
      aria-label="Filter queues and exchanges"
      class="mono"
      spellcheck="false"
      style="width:100%;background:var(--raised);border:var(--px-1) solid var(--border2);border-radius:var(--px-6);padding:var(--px-5) var(--px-8);font-size:var(--px-11_5);color:var(--text);outline:none"
    />
  </div>

  {#if vhostNote}
    <div data-testid="rabbit-vhost-note" role="note" style="padding:var(--px-6) var(--px-10);font-size:var(--px-11);color:var(--sacc-amber);border-bottom:var(--px-1) solid var(--border)">
      {vhostNote} Set <b>Virtual host</b> in the connection to choose another.
    </div>
  {/if}
  <div aria-busy={loading} style="min-height:0;{loading && (queues.length || exchanges.length) ? 'opacity:.5' : ''}">
    {#if error}
      <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--error)">{error}</div>
    {:else if loading && !queues.length && !exchanges.length}
      <div style="padding:var(--px-10);font-size:var(--px-11_5);color:var(--muted)">Loading queues and exchanges…</div>
    {:else}
      <!-- Queues -->
      <div
        class="rb-row rb-head"
        onclick={() => (openQueues = !openQueues)}
        onkeydown={(e) => e.key === 'Enter' && (openQueues = !openQueues)}
        role="treeitem"
        aria-selected="false"
        aria-expanded={openQueues}
        tabindex="0"
      >
        <span class="mono rb-chev">{openQueues ? '▾' : '▸'}</span>
        <span style="font-size:var(--px-12);font-weight:700;color:var(--text)">Queues</span>
        <span class="mono rb-meta">{qRows.length}{filter.trim() ? ` of ${queues.length}` : ''}</span>
      </div>
      {#if openQueues}
        {#if queuesError}
          <div class="rb-empty" role="alert" style="color:var(--error)">{queuesError}</div>
        {:else if qRows.length === 0}
          <div class="rb-empty">{filter.trim() ? 'No queues match the filter' : 'No queues in this vhost'}</div>
        {/if}
        {#each qRows as q (q.name)}
          {@const badge = queueTypeBadge(q.queue_type)}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <div
                class="rb-row"
                class:sel={active?.kind === 'rabbit-queue' && active.name === q.name}
                onclick={() => tabs.openRabbitQueue(connId, vhost, q.name)}
                onkeydown={(e) => e.key === 'Enter' && tabs.openRabbitQueue(connId, vhost, q.name)}
                role="treeitem"
                aria-selected={active?.kind === 'rabbit-queue' && active.name === q.name}
                tabindex="0"
                title="{q.name} · {q.queue_type}{q.durable ? ' · durable' : ''}{q.state ? ` · ${q.state}` : ''}"
                style="padding-left:calc(var(--px-8) + var(--px-14))"
              >
                <span class="mono rb-badge" style="color:{TYPE_COLOR[badge]};border-color:{TYPE_COLOR[badge]}" title="{q.queue_type} queue">{badge}</span>
                <span class="mono rb-name">{q.name}</span>
                <span class="mono rb-meta" style={q.messages ? 'color:var(--sacc-amber)' : ''}>{queueMeta(q)}</span>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content class="w-52">
              <ContextMenu.Item onclick={() => tabs.openRabbitQueue(connId, vhost, q.name)}>Open queue</ContextMenu.Item>
              <ContextMenu.Item onclick={() => copy(q.name)}>Copy Name</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => purgeQueue(q.name)}>Purge messages…</ContextMenu.Item>
              <ContextMenu.Item variant="destructive" onclick={() => deleteQueue(q.name)}>Delete queue…</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => load()}>Refresh</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      {/if}

      <!-- Exchanges -->
      <div
        class="rb-row rb-head"
        onclick={() => (openExchanges = !openExchanges)}
        onkeydown={(e) => e.key === 'Enter' && (openExchanges = !openExchanges)}
        role="treeitem"
        aria-selected="false"
        aria-expanded={openExchanges}
        tabindex="0"
      >
        <span class="mono rb-chev">{openExchanges ? '▾' : '▸'}</span>
        <span style="font-size:var(--px-12);font-weight:700;color:var(--text)">Exchanges</span>
        <span class="mono rb-meta">{xRows.length}{filter.trim() ? ` of ${exchanges.length}` : ''}</span>
      </div>
      {#if openExchanges}
        {#if exchangesError}
          <div class="rb-empty" role="alert" style="color:var(--error)">{exchangesError}</div>
        {:else if xRows.length === 0}
          <div class="rb-empty">{filter.trim() ? 'No exchanges match the filter' : 'No exchanges'}</div>
        {/if}
        {#each xRows as x (x.name)}
          <ContextMenu.Root>
            <ContextMenu.Trigger>
              <div
                class="rb-row"
                class:sel={active?.kind === 'rabbit-exchange' && active.name === x.name}
                onclick={() => tabs.openRabbitExchange(connId, vhost, x.name)}
                onkeydown={(e) => e.key === 'Enter' && tabs.openRabbitExchange(connId, vhost, x.name)}
                role="treeitem"
                aria-selected={active?.kind === 'rabbit-exchange' && active.name === x.name}
                tabindex="0"
                title="{exchangeLabel(x.name)} · {x.exchange_type}{x.internal ? ' · internal' : ''}"
                style="padding-left:calc(var(--px-8) + var(--px-14))"
              >
                <span class="mono rb-badge" style="color:var(--sacc-blue);border-color:var(--sacc-blue)" title="exchange">X</span>
                <span class="mono rb-name" style={isBuiltinExchange(x.name) ? 'color:var(--text2)' : ''}>{exchangeLabel(x.name)}</span>
                <span class="mono rb-meta">{x.exchange_type}</span>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content class="w-52">
              <ContextMenu.Item onclick={() => tabs.openRabbitExchange(connId, vhost, x.name)}>Open exchange</ContextMenu.Item>
              <ContextMenu.Item onclick={() => copy(x.name)}>Copy Name</ContextMenu.Item>
              {#if !isBuiltinExchange(x.name)}
                <ContextMenu.Separator />
                <ContextMenu.Item variant="destructive" onclick={() => deleteExchange(x.name)}>Delete exchange…</ContextMenu.Item>
              {/if}
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => load()}>Refresh</ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      {/if}
    {/if}
  </div>
</div>

{#if confirmState}
  <div role="presentation" style="position:fixed;inset:0;background:var(--rgba-0-0-0-_5);display:flex;align-items:center;justify-content:center;z-index:92">
    <div
      role="dialog"
      aria-modal="true"
      aria-label={confirmState.title}
      onkeydown={(e) => e.key === 'Escape' && (confirmState = null)}
      tabindex="-1"
      style="background:var(--surface);border:var(--px-1) solid var(--border2);border-radius:var(--px-14);padding:var(--px-18);width:min(var(--px-460), 92vw);box-shadow:0 var(--px-24) var(--px-60) var(--rgba-0-0-0-_55)"
    >
      <div style="font-size:var(--px-14);font-weight:600;color:var(--text);margin-bottom:var(--px-8)">{confirmState.title}</div>
      <div style="font-size:var(--px-12_5);color:var(--text2);line-height:1.45;margin-bottom:var(--px-16)">{confirmState.body}</div>
      <div style="display:flex;gap:var(--px-8);justify-content:flex-end">
        <span onclick={() => (confirmState = null)} onkeydown={(e) => e.key === 'Enter' && (confirmState = null)} role="button" tabindex="0" class="eg-btn">Cancel</span>
        <span onclick={runConfirm} onkeydown={(e) => e.key === 'Enter' && runConfirm()} role="button" tabindex="0" class="eg-btn danger" style={confirmBusy ? 'opacity:.6;pointer-events:none' : ''}>{confirmState.action}</span>
      </div>
    </div>
  </div>
{/if}

{#if createKind}
  {@const kind = createKind}
  <RabbitCreateDialog
    {connId}
    {kind}
    {vhosts}
    initialVhost={vhost}
    exchangeTypes={overview?.exchange_types?.length ? overview.exchange_types : ['direct', 'fanout', 'headers', 'topic']}
    onClose={() => (createKind = null)}
    onCreated={(v, n) => created(kind, v, n)}
  />
{/if}

<style>
  .rb-row {
    display: flex;
    align-items: center;
    gap: var(--px-8);
    padding: var(--px-5) var(--px-8);
    border-radius: var(--px-6);
    cursor: pointer;
    min-width: 0;
  }
  .rb-row:hover:not(.sel) {
    background: color-mix(in srgb, var(--primary) 10%, transparent);
  }
  .rb-row.sel {
    background: color-mix(in srgb, var(--primary) 26%, transparent);
  }
  .rb-head {
    margin-top: var(--px-2);
  }
  .rb-chev {
    flex: none;
    width: var(--px-10);
    text-align: center;
    font-size: var(--px-9);
    color: var(--muted);
  }
  .rb-badge {
    flex: none;
    font-size: var(--px-9);
    font-weight: 700;
    border: var(--px-1) solid;
    border-radius: var(--px-3);
    padding: 0 var(--px-4);
  }
  .rb-name {
    font-size: var(--px-12);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1 1 auto;
  }
  .rb-meta {
    margin-left: auto;
    flex: 0 100 auto;
    font-size: var(--px-10);
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rb-empty {
    padding: var(--px-4) var(--px-12);
    padding-left: calc(var(--px-8) + var(--px-14) * 2);
    font-size: var(--px-11);
    color: var(--muted);
  }
  .rb-spin {
    display: inline-block;
    animation: rb-spin 900ms linear infinite;
  }
  @keyframes rb-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .eg-btn {
    font-size: var(--px-12);
    color: var(--text2);
    background: var(--panel);
    border: var(--px-1) solid var(--border);
    border-radius: var(--px-6);
    padding: var(--px-5) var(--px-14);
    cursor: pointer;
  }
  .eg-btn:hover {
    background: var(--hover);
  }
  .eg-btn.danger {
    color: var(--hex-fff);
    background: var(--error);
    border-color: var(--error);
    font-weight: 600;
  }
</style>
