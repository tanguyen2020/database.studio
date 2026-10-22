// Demo/browser stand-in for the RabbitMQ commands (commands/rabbitmq.rs), used when
// the app runs outside Tauri (vite dev, Vitest, Playwright). STATEFUL on purpose:
// declare / publish / peek / consume / purge / bind / delete change what the next
// call returns, and publishing routes like the broker does (default exchange by
// queue name, direct by key, topic with * and #, fanout to everything) — so an e2e
// can tell a real action from a no-op.

import type {
  RabbitBinding,
  RabbitConnection,
  RabbitConsumer,
  RabbitExchange,
  RabbitNode,
  RabbitLiveBatch,
  RabbitLiveStatus,
  RabbitMessage,
  RabbitPermission,
  RabbitPolicy,
  RabbitQueue,
  RabbitTopicPermission,
  RabbitUser,
  RabbitVhost,
} from '$lib/ipc'

/** e2e seam: the demo RabbitMQ connection is listed only with `?rabbitmq=1`, so the
 *  connection list every other spec relies on is unchanged. */
/** e2e seam: `?rabbitNoRoot=1` = a broker deployed with another default vhost, so
 *  "/" does not exist (the case that used to show a bare "Not found"). */
function noRootVhost(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('rabbitNoRoot') === '1'
}

/** e2e seam: `?rabbitNoAdmin=1` = logged in with only the 'management' tag — the
 *  broker refuses user / permission lists with 401 "Not administrator user". */
function noAdmin(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('rabbitNoAdmin') === '1'
}
const NOT_ADMIN = "Not allowed — this needs a user with the 'administrator' tag (the connection's user is logged in, but does not have it)"

export function rabbitDemoEnabled(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('rabbitmq') === '1'
}

interface DemoQueue extends RabbitQueue {
  msgs: RabbitMessage[]
}

interface DemoBinding {
  vhost: string
  source: string
  queue: string
  key: string
}

const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

function msg(payload: string, routing_key: string, exchange = '', props: Record<string, unknown> = {}, encoding = 'string'): RabbitMessage {
  return {
    payload,
    payload_encoding: encoding,
    payload_bytes: encoding === 'base64' ? atob(payload).length : new TextEncoder().encode(payload).length,
    redelivered: false,
    exchange,
    routing_key,
    message_count: 0,
    properties: props,
  }
}

function queue(vhost: string, name: string, type: string, msgs: RabbitMessage[], extra: Partial<RabbitQueue> = {}): DemoQueue {
  return {
    name,
    vhost,
    queue_type: type,
    durable: true,
    auto_delete: false,
    exclusive: false,
    state: 'running',
    messages: msgs.length,
    messages_ready: msgs.length,
    messages_unacknowledged: 0,
    consumers: 0,
    memory: 14_336,
    node: 'rabbit@demo',
    policy: '',
    arguments: type === 'classic' ? {} : { 'x-queue-type': type },
    msgs,
    ...extra,
  }
}

function exchange(vhost: string, name: string, type: string): RabbitExchange {
  return { name, vhost, exchange_type: type, durable: true, auto_delete: false, internal: false, arguments: {} }
}

function seed() {
  const created = [
    msg('{"order_id":1042,"customer":"Nguyễn Văn An","total":129.5,"items":[{"sku":"A-1","qty":2}]}', 'order.created.eu', 'orders', { content_type: 'application/json', delivery_mode: 2, headers: { source: 'checkout' } }),
    msg('{"order_id":1043,"customer":"Trần Thị Bình","total":42}', 'order.created.us', 'orders', { content_type: 'application/json', delivery_mode: 2 }),
    msg('plain text reminder', 'orders.created', '', { content_type: 'text/plain' }),
    msg(btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)), 'orders.created', '', { content_type: 'image/jpeg' }, 'base64'),
  ]
  return {
    vhosts: ['/', 'staging'],
    queues: [
      queue('/', 'orders.created', 'classic', created, {
        consumers: 1,
        // stream-workspace:rabbitmq — readable arguments (TTL, dead-letter, length cap)
        arguments: { 'x-message-ttl': 86_400_000, 'x-dead-letter-exchange': 'orders.dlx', 'x-max-length': 10_000, 'x-overflow': 'reject-publish' },
        publish_rate: 4.2,
        deliver_rate: 3.9,
        ack_rate: 3.8,
      }),
      // stream-workspace:rabbitmq — dead-lettered messages waiting (an "attention" case)
      queue('/', 'orders.dlq', 'quorum', [
        msg('{"order_id":990,"error":"payment declined"}', 'order.created.eu', 'orders.dlx', { content_type: 'application/json' }),
        msg('{"order_id":991,"error":"timeout"}', 'order.created.us', 'orders.dlx', { content_type: 'application/json' }),
      ], { arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': 5 } }),
      // stream-workspace:rabbitmq — many messages in progress for one consumer (stuck worker)
      queue('/', 'payments.process', 'quorum', [], {
        consumers: 1,
        messages_unacknowledged: 1_240,
        arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'payments.dlx', 'x-delivery-limit': 5 },
        publish_rate: 2.1,
        deliver_rate: 0,
        ack_rate: 0,
      }),
      queue('/', 'events.audit', 'stream', [msg(enc('{"event":"login"}'), 'events.audit', 'events', {}, 'base64')]),
      queue('/', 'billing.invoices', 'classic', [], { messages: null, messages_ready: null, messages_unacknowledged: null, consumers: null }),
      queue('staging', 'orders.created', 'classic', []),
    ] as DemoQueue[],
    exchanges: [
      exchange('/', '', 'direct'),
      exchange('/', 'amq.direct', 'direct'),
      exchange('/', 'amq.fanout', 'fanout'),
      exchange('/', 'amq.topic', 'topic'),
      exchange('/', 'orders', 'topic'),
      exchange('/', 'events', 'fanout'),
      exchange('staging', '', 'direct'),
      exchange('staging', 'amq.topic', 'topic'),
    ],
    bindings: [
      { vhost: '/', source: 'orders', queue: 'orders.created', key: 'order.created.*' },
      { vhost: '/', source: 'events', queue: 'events.audit', key: '' },
    ] as DemoBinding[],
  }
}

let state = seed()

// ---- access (users / permissions / policies / vhost descriptions) -------------------

function seedAccess() {
  return {
    users: [
      { name: 'studio', tags: ['administrator'], has_password: true },
      { name: 'app', tags: ['management'], has_password: true },
      { name: 'monitor', tags: ['monitoring'], has_password: true },
    ] as RabbitUser[],
    permissions: [
      { user: 'studio', vhost: '/', configure: '.*', write: '.*', read: '.*' },
      { user: 'studio', vhost: 'staging', configure: '.*', write: '.*', read: '.*' },
      { user: 'app', vhost: '/', configure: '^$', write: '.*', read: '.*' },
      { user: 'monitor', vhost: '/', configure: '^$', write: '^$', read: '.*' },
    ] as RabbitPermission[],
    topicPermissions: [{ user: 'app', vhost: '/', exchange: 'orders', write: '^order\\.', read: '.*' }] as RabbitTopicPermission[],
    policies: [
      { name: 'dlx-orders', vhost: '/', pattern: '^orders\\.', apply_to: 'queues', priority: 1, definition: { 'dead-letter-exchange': 'orders.dlx', 'max-length': 100000 } },
    ] as RabbitPolicy[],
    descriptions: { '/': 'Default virtual host', staging: 'Staging' } as Record<string, string>,
  }
}
let access = seedAccess()

// ---- stream-workspace:rabbitmq — nodes / client connections / consumers --------------
// Stateful: closing a connection removes it AND its consumers (the queue's consumer
// count follows), like on the broker.

/** e2e seam: `?rabbitNoMonitor=1` = the user lacks the 'monitoring' tag, so the
 *  broker refuses the node list (401 "Not monitor user"). */
function noMonitor(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('rabbitNoMonitor') === '1'
}
const NOT_MONITOR = "Not allowed — this needs a user with the 'monitoring' tag (the connection's user is logged in, but does not have it)"

function seedWorkspace() {
  const now = Date.now()
  const conn = (name: string, app: string, user: string, host: string, platform: string, channels: number, ssl: boolean, agoMin: number): RabbitConnection => ({
    name,
    user,
    vhost: '/',
    node: 'rabbit@demo',
    peer_host: host,
    peer_port: Number(name.split(':')[1]?.split(' ')[0] ?? 0),
    client_name: app,
    client_product: platform === 'Java' ? 'RabbitMQ' : 'pika',
    client_version: platform === 'Java' ? '5.20.0' : '1.3.2',
    client_platform: platform,
    protocol: 'AMQP 0-9-1',
    state: 'running',
    channels,
    ssl,
    recv_bytes: 1_843_200,
    send_bytes: 4_210_688,
    recv_rate: 1_250,
    send_rate: 3_480,
    connected_at: now - agoMin * 60_000,
  })
  const connections: RabbitConnection[] = [
    conn('10.0.4.21:51234 -> 10.0.9.4:5672', 'orders-api', 'app', '10.0.4.21', 'Java', 2, true, 182),
    conn('10.0.4.37:40112 -> 10.0.9.4:5672', 'billing-worker', 'app', '10.0.4.37', 'Python', 1, false, 47),
    conn('10.0.7.5:39001 -> 10.0.9.4:5672', '', 'monitor', '10.0.7.5', 'Python', 1, false, 6),
  ]
  const consumers: RabbitConsumer[] = [
    {
      queue: 'orders.created',
      vhost: '/',
      consumer_tag: 'amq.ctag-Xb3k9Q1',
      prefetch_count: 10,
      ack_required: true,
      exclusive: false,
      active: true,
      activity_status: 'up',
      channel_name: '10.0.4.21:51234 -> 10.0.9.4:5672 (1)',
      channel_number: 1,
      connection_name: connections[0].name,
      peer_host: '10.0.4.21',
      user: 'app',
    },
    {
      queue: 'payments.process',
      vhost: '/',
      consumer_tag: 'billing-worker-1',
      prefetch_count: 0,
      ack_required: true,
      exclusive: false,
      active: true,
      activity_status: 'up',
      channel_name: '10.0.4.37:40112 -> 10.0.9.4:5672 (1)',
      channel_number: 1,
      connection_name: connections[1].name,
      peer_host: '10.0.4.37',
      user: 'app',
    },
  ]
  return { connections, consumers, publishes: [] as number[] }
}
let ws = seedWorkspace()

/** Demo rates: a steady background flow plus whatever was published in the last 10 s. */
function demoRates() {
  const now = Date.now()
  ws.publishes = ws.publishes.filter((t) => now - t < 10_000)
  const extra = ws.publishes.length / 10
  const wave = Math.round((Math.sin(now / 20_000) + 1) * 15) / 10
  return { publish_rate: 8.5 + wave + extra, deliver_rate: 7.9 + wave, ack_rate: 7.6 + wave }
}

// ---- live sessions (watch = copy · consume = take) --------------------------------------

interface DemoLive {
  mode: 'watch' | 'consume'
  vhost: string
  /** consume: the queue read */
  queue: string
  /** watch: what the tap is bound with */
  bindings: { exchange: string; key: string }[]
  received: number
  backlog: RabbitMessage[]
}
const live = new Map<string, DemoLive>()
/** Listeners by session id — registered BEFORE the session starts (the panel
 *  subscribes first so it can never miss the first batch). */
const subs = new Map<string, { onBatch: (b: RabbitLiveBatch) => void; onStatus: (s: RabbitLiveStatus) => void }>()

/** Listener side of a demo live session (what onRabbitLive uses outside Tauri). */
export function rabbitDemoSubscribe(
  session: string,
  onBatch: (b: RabbitLiveBatch) => void,
  onStatus: (s: RabbitLiveStatus) => void,
): () => void {
  subs.set(session, { onBatch, onStatus })
  const s = live.get(session)
  if (s?.backlog.length) deliver(session, s, s.backlog.splice(0))
  return () => {
    subs.delete(session)
  }
}

function deliver(session: string, s: DemoLive, msgs: RabbitMessage[]) {
  if (!msgs.length) return
  const sub = subs.get(session)
  if (!sub) {
    s.backlog.push(...msgs)
    return
  }
  s.received += msgs.length
  const batch = { session, msgs, received: s.received }
  setTimeout(() => sub.onBatch(batch), 0)
}

function exchangeType(vhost: string, name: string): string | undefined {
  return state.exchanges.find((e) => e.vhost === vhost && e.name === name)?.exchange_type
}

function bindingMatches(type: string | undefined, bindingKey: string, routingKey: string): boolean {
  if (type === 'fanout' || type === 'headers') return true
  if (type === 'topic') return topicMatches(bindingKey, routingKey)
  return bindingKey === routingKey
}

/** Test hook: start from the seed again. */
export function resetRabbitDemo() {
  state = seed()
  access = seedAccess()
  ws = seedWorkspace() // stream-workspace:rabbitmq
  live.clear()
  subs.clear()
}

/** AMQP topic match: `*` = exactly one word, `#` = zero or more words. */
export function topicMatches(pattern: string, key: string): boolean {
  const p = pattern.split('.')
  const k = key.split('.')
  const go = (i: number, j: number): boolean => {
    if (i === p.length) return j === k.length
    if (p[i] === '#') return go(i + 1, j) || (j < k.length && go(i, j + 1))
    if (j === k.length) return false
    return (p[i] === '*' || p[i] === k[j]) && go(i + 1, j + 1)
  }
  return go(0, 0)
}

function findQueue(vhost: string, name: string): DemoQueue | undefined {
  return state.queues.find((q) => q.vhost === vhost && q.name === name)
}

function view(q: DemoQueue): RabbitQueue {
  // keep the reported counts in step with the stored messages (a null count stays
  // null: that queue models a broker that has not reported stats yet)
  const { msgs, ...rest } = q
  if (rest.messages === null) return rest
  // stream-workspace:rabbitmq — total = waiting + in progress; consumers follow the
  // demo consumer list (closing a connection drops its consumers)
  const consumers = ws.consumers.filter((c) => c.vhost === q.vhost && c.queue === q.name).length
  const unacked = consumers ? (rest.messages_unacknowledged ?? 0) : 0
  return { ...rest, consumers, messages_unacknowledged: unacked, messages: msgs.length + unacked, messages_ready: msgs.length }
}

function bindingsOf(vhost: string): RabbitBinding[] {
  const implicit = state.queues
    .filter((q) => q.vhost === vhost)
    .map((q) => ({ source: '', destination: q.name, destination_type: 'queue', routing_key: q.name, properties_key: q.name, arguments: {} }))
  const explicit = state.bindings
    .filter((b) => b.vhost === vhost)
    .map((b) => ({ source: b.source, destination: b.queue, destination_type: 'queue', routing_key: b.key, properties_key: b.key || '~', arguments: {} }))
  return [...implicit, ...explicit]
}

function route(vhost: string, ex: string, key: string): DemoQueue[] {
  if (ex === '') {
    const q = findQueue(vhost, key)
    return q ? [q] : []
  }
  const x = state.exchanges.find((e) => e.vhost === vhost && e.name === ex)
  if (!x) throw new Error(`Not found — no exchange '${ex}' in vhost '${vhost}'`)
  const hits = state.bindings.filter((b) => {
    if (b.vhost !== vhost || b.source !== ex) return false
    if (x.exchange_type === 'fanout') return true
    if (x.exchange_type === 'topic') return topicMatches(b.key, key)
    return b.key === key
  })
  return hits.map((b) => findQueue(vhost, b.queue)).filter((q): q is DemoQueue => !!q)
}

const S = (v: unknown) => String(v ?? '')

/** Returns the command's result; throws like the backend would on a bad request. */
export function rabbitDemo(cmd: string, args: Record<string, unknown> = {}): unknown {
  const vhost = S(args.vhost) || '/'
  switch (cmd) {
    case 'rabbit_overview': {
      const all = state.queues.reduce((n, q) => n + q.msgs.length, 0)
      // stream-workspace:rabbitmq — totals follow the stateful connections / consumers
      const unacked = state.queues.map(view).reduce((n, q) => n + (q.messages_unacknowledged ?? 0), 0)
      return {
        rabbitmq_version: '3.13.7',
        erlang_version: '26.2.5',
        cluster_name: 'rabbit@demo',
        node: 'rabbit@demo',
        management_version: '3.13.7',
        messages: all + unacked,
        messages_ready: all,
        messages_unacknowledged: unacked,
        queues: state.queues.length,
        exchanges: state.exchanges.length,
        connections: ws.connections.length,
        channels: ws.connections.reduce((n, c) => n + (c.channels ?? 0), 0),
        consumers: ws.consumers.length,
        ...demoRates(),
        // the backend reports the vhost it actually opened on (see resolve_vhost)
        vhost: noRootVhost() ? 'staging' : '/',
        exchange_types: ['direct', 'fanout', 'headers', 'topic', 'x-delayed-message'],
      }
    }
    case 'rabbit_vhosts':
      return noRootVhost() ? state.vhosts.filter((v) => v !== '/') : [...state.vhosts]
    case 'rabbit_queues':
      if (noRootVhost() && vhost === '/') throw new Error("Virtual host '/' was not found on this broker (or this user has no access to it).")
      return state.queues.filter((q) => q.vhost === vhost).map(view).sort((a, b) => a.name.localeCompare(b.name))
    case 'rabbit_queue': {
      const q = findQueue(vhost, S(args.queue))
      if (!q) throw new Error(`Not found — no queue '${S(args.queue)}' in vhost '${vhost}'`)
      return view(q)
    }
    case 'rabbit_exchanges':
      if (noRootVhost() && vhost === '/') throw new Error("Virtual host '/' was not found on this broker (or this user has no access to it).")
      return state.exchanges.filter((e) => e.vhost === vhost)
    case 'rabbit_queue_bindings':
      return bindingsOf(vhost).filter((b) => b.destination === S(args.queue))
    case 'rabbit_exchange_bindings':
      return S(args.exchange) === '' ? [] : bindingsOf(vhost).filter((b) => b.source === S(args.exchange))
    case 'rabbit_get_messages': {
      const q = findQueue(vhost, S(args.queue))
      if (!q) throw new Error(`Not found — no queue '${S(args.queue)}'`)
      const n = Math.max(1, Number(args.count ?? 1))
      const taken = q.msgs.slice(0, n).map((m, i) => ({ ...m, message_count: q.msgs.length - i - 1 }))
      if (args.mode === 'requeue') {
        // requeued messages come back marked redelivered, as on the broker
        q.msgs = q.msgs.map((m, i) => (i < n ? { ...m, redelivered: true } : m))
      } else {
        q.msgs = q.msgs.slice(n)
      }
      return taken
    }
    case 'rabbit_publish': {
      const ex = S(args.exchange)
      const key = S(args.routingKey)
      const targets = route(vhost, ex, key)
      ws.publishes.push(Date.now()) // stream-workspace:rabbitmq — feeds the demo rate
      const make = () => msg(S(args.payload), key, ex, (args.properties as Record<string, unknown>) ?? {}, S(args.payloadEncoding) || 'string')
      for (const q of targets) {
        // a running consume session takes the message the moment it lands
        const taker = [...live.entries()].find(([, s]) => s.mode === 'consume' && s.vhost === vhost && s.queue === q.name)
        if (taker) deliver(taker[0], taker[1], [make()])
        else q.msgs.push(make())
      }
      // every watch whose tap binding matches gets its own copy
      for (const [id, s] of live) {
        if (s.mode !== 'watch' || s.vhost !== vhost || ex === '') continue
        const t = exchangeType(vhost, ex)
        if (s.bindings.some((b) => b.exchange === ex && bindingMatches(t, b.key, key))) deliver(id, s, [make()])
      }
      if (ex !== '' && [...live.values()].some((s) => s.mode === 'watch' && s.vhost === vhost && s.bindings.some((b) => b.exchange === ex && bindingMatches(exchangeType(vhost, ex), b.key, key)))) {
        return { routed: true }
      }
      return { routed: targets.length > 0 }
    }
    case 'rabbit_purge_queue': {
      const q = findQueue(vhost, S(args.queue))
      if (q) q.msgs = []
      return null
    }
    case 'rabbit_delete_queue':
      state.queues = state.queues.filter((q) => !(q.vhost === vhost && q.name === S(args.queue)))
      state.bindings = state.bindings.filter((b) => !(b.vhost === vhost && b.queue === S(args.queue)))
      return null
    case 'rabbit_delete_exchange': {
      const name = S(args.exchange)
      if (name === '' || name.startsWith('amq.')) throw new Error('Built-in exchanges (the default exchange and amq.*) cannot be deleted')
      state.exchanges = state.exchanges.filter((e) => !(e.vhost === vhost && e.name === name))
      state.bindings = state.bindings.filter((b) => !(b.vhost === vhost && b.source === name))
      return null
    }
    case 'rabbit_declare_queue': {
      const name = S(args.name)
      if (!findQueue(vhost, name)) {
        const qt = S(args.queueType) || 'classic'
        const extra = (args.arguments ?? {}) as Record<string, unknown>
        const q = queue(vhost, name, qt, [], { durable: !!args.durable, auto_delete: !!args.autoDelete })
        // like the backend: an explicit type travels as x-queue-type next to the form's arguments
        q.arguments = { ...extra, ...(S(args.queueType) ? { 'x-queue-type': qt } : {}) }
        state.queues.push(q)
      }
      return null
    }
    case 'rabbit_declare_exchange': {
      const name = S(args.name)
      if (!state.exchanges.some((e) => e.vhost === vhost && e.name === name)) {
        state.exchanges.push({ ...exchange(vhost, name, S(args.exchangeType) || 'direct'), durable: !!args.durable, auto_delete: !!args.autoDelete, internal: !!args.internal, arguments: (args.arguments ?? {}) as Record<string, unknown> })
      }
      return null
    }
    case 'rabbit_bind_queue':
      state.bindings.push({ vhost, source: S(args.exchange), queue: S(args.queue), key: S(args.routingKey) })
      return null
    case 'rabbit_unbind_queue':
      state.bindings = state.bindings.filter(
        (b) => !(b.vhost === vhost && b.source === S(args.exchange) && b.queue === S(args.queue) && (b.key || '~') === S(args.propertiesKey)),
      )
      return null
    case 'rabbit_live_start': {
      const r = (args.request ?? {}) as { session: string; mode: 'watch' | 'consume'; vhost: string; queue?: string; exchange?: string; routing_keys?: string[] }
      const vh = r.vhost || '/'
      const stopOld = live.get(r.session)
      if (stopOld) live.delete(r.session)
      if (r.mode === 'consume') {
        const q = findQueue(vh, r.queue ?? '')
        if (!q) throw new Error(`Not found — no queue '${r.queue}' in vhost '${vh}'`)
        const s: DemoLive = { mode: 'consume', vhost: vh, queue: q.name, bindings: [], received: 0, backlog: [] }
        live.set(r.session, s)
        deliver(r.session, s, q.msgs.splice(0)) // what is already waiting arrives first
        return { session: r.session, mode: 'consume', source: q.name, tap_queue: null, bindings: [] }
      }
      let bindings: { exchange: string; key: string }[]
      if (r.queue) {
        bindings = state.bindings.filter((b) => b.vhost === vh && b.queue === r.queue).map((b) => ({ exchange: b.source, key: b.key }))
        if (!bindings.length) {
          throw new Error('This queue is only reached through the default exchange (published to by name), which cannot be watched — use Consume, or bind the queue to an exchange')
        }
      } else {
        const ex = r.exchange ?? ''
        if (!ex) throw new Error('The default exchange cannot be watched — open the queue and watch it instead')
        const t = exchangeType(vh, ex)
        if (!t) throw new Error(`Not found — no exchange '${ex}' in vhost '${vh}'`)
        const keys = (r.routing_keys ?? []).map((k) => k.trim()).filter(Boolean)
        if (t === 'fanout' || t === 'headers') bindings = [{ exchange: ex, key: '' }]
        else if (t === 'topic') bindings = (keys.length ? keys : ['#']).map((k) => ({ exchange: ex, key: k }))
        else if (!keys.length) throw new Error('A direct exchange has no wildcard — give the routing key(s) to watch')
        else bindings = keys.map((k) => ({ exchange: ex, key: k }))
      }
      const tap = `dbstudio.tap.${r.session.replace(/[^\w-]/g, '').slice(0, 48)}`
      live.set(r.session, { mode: 'watch', vhost: vh, queue: tap, bindings, received: 0, backlog: [] })
      return {
        session: r.session,
        mode: 'watch',
        source: tap,
        tap_queue: tap,
        bindings: bindings.map((b) => ({ source: b.exchange, destination: tap, destination_type: 'queue', routing_key: b.key, properties_key: b.key, arguments: {} })),
      }
    }
    case 'rabbit_live_stop': {
      const id = S(args.session)
      const s = live.get(id)
      live.delete(id)
      const sub = subs.get(id)
      if (s && sub) {
        const st: RabbitLiveStatus = { session: id, state: 'stopped', message: `${s.received} message(s) received` }
        setTimeout(() => sub.onStatus(st), 0)
      }
      return null
    }
    case 'rabbit_whoami':
      return noAdmin() ? { name: 'studio', tags: ['management'] } : { name: 'studio', tags: ['administrator'] }
    case 'rabbit_vhost_list':
      return state.vhosts.map(
        (name): RabbitVhost => ({
          name,
          description: access.descriptions[name] ?? '',
          messages: state.queues.filter((q) => q.vhost === name).reduce((n, q) => n + q.msgs.length, 0),
        }),
      )
    case 'rabbit_create_vhost': {
      const name = S(args.name)
      if (!state.vhosts.includes(name)) state.vhosts.push(name)
      access.descriptions[name] = S(args.description)
      return null
    }
    case 'rabbit_delete_vhost': {
      const name = S(args.name)
      if (name === '/') throw new Error('Cannot delete the virtual host this connection is opened on')
      state.vhosts = state.vhosts.filter((v) => v !== name)
      access.permissions = access.permissions.filter((p) => p.vhost !== name)
      access.policies = access.policies.filter((p) => p.vhost !== name)
      return null
    }
    case 'rabbit_users':
      if (noAdmin()) throw new Error(NOT_ADMIN)
      return access.users.map((u) => ({ ...u, tags: [...u.tags] })).sort((a, b) => a.name.localeCompare(b.name))
    case 'rabbit_create_user': {
      const name = S(args.name)
      if (!name.trim()) throw new Error('User name is required')
      access.users = access.users.filter((u) => u.name !== name)
      access.users.push({ name, tags: [...((args.tags as string[]) ?? [])], has_password: S(args.password) !== '' })
      return null
    }
    case 'rabbit_set_user_password': {
      const u = access.users.find((x) => x.name === S(args.name))
      if (!u) throw new Error(`Not found — no user '${S(args.name)}'`)
      u.has_password = S(args.password) !== ''
      return null
    }
    case 'rabbit_set_user_tags': {
      const u = access.users.find((x) => x.name === S(args.name))
      if (!u) throw new Error(`Not found — no user '${S(args.name)}'`)
      u.tags = [...new Set(((args.tags as string[]) ?? []).map((t) => t.trim()).filter(Boolean))]
      return null
    }
    case 'rabbit_delete_user': {
      const name = S(args.name)
      if (name === 'studio') throw new Error('Cannot delete the user this connection is logged in as')
      access.users = access.users.filter((u) => u.name !== name)
      access.permissions = access.permissions.filter((p) => p.user !== name)
      access.topicPermissions = access.topicPermissions.filter((p) => p.user !== name)
      return null
    }
    case 'rabbit_permissions':
      if (noAdmin()) throw new Error(NOT_ADMIN)
      return access.permissions.map((p) => ({ ...p }))
    case 'rabbit_set_permission': {
      const p = { user: S(args.user), vhost, configure: S(args.configure), write: S(args.write), read: S(args.read) }
      access.permissions = access.permissions.filter((x) => !(x.user === p.user && x.vhost === p.vhost))
      access.permissions.push(p)
      return null
    }
    case 'rabbit_delete_permission':
      access.permissions = access.permissions.filter((x) => !(x.user === S(args.user) && x.vhost === vhost))
      return null
    case 'rabbit_topic_permissions':
      if (noAdmin()) throw new Error(NOT_ADMIN)
      return access.topicPermissions.map((p) => ({ ...p }))
    case 'rabbit_set_topic_permission': {
      const p = { user: S(args.user), vhost, exchange: S(args.exchange), write: S(args.write), read: S(args.read) }
      access.topicPermissions = access.topicPermissions.filter((x) => !(x.user === p.user && x.vhost === p.vhost && x.exchange === p.exchange))
      access.topicPermissions.push(p)
      return null
    }
    case 'rabbit_delete_topic_permissions':
      access.topicPermissions = access.topicPermissions.filter((x) => !(x.user === S(args.user) && x.vhost === vhost))
      return null
    case 'rabbit_policies':
      return access.policies.filter((p) => p.vhost === vhost).map((p) => ({ ...p }))
    case 'rabbit_set_policy': {
      const def = (args.definition ?? {}) as Record<string, unknown>
      if (!Object.keys(def).length) throw new Error('A policy needs a definition with at least one key, e.g. {"max-length": 10000}')
      const p: RabbitPolicy = { name: S(args.name), vhost, pattern: S(args.pattern), apply_to: S(args.applyTo) || 'all', priority: Number(args.priority ?? 0), definition: def }
      access.policies = access.policies.filter((x) => !(x.name === p.name && x.vhost === vhost))
      access.policies.push(p)
      return null
    }
    case 'rabbit_delete_policy':
      access.policies = access.policies.filter((x) => !(x.name === S(args.name) && x.vhost === vhost))
      return null
    // ---- stream-workspace:rabbitmq — nodes / connections / consumers -------------------
    case 'rabbit_nodes': {
      if (noMonitor()) throw new Error(NOT_MONITOR)
      const node: RabbitNode = {
        name: 'rabbit@demo',
        node_type: 'disc',
        running: true,
        mem_used: 191_889_408,
        mem_limit: 1_717_986_918,
        mem_alarm: false,
        disk_free: 44_023_414_784,
        disk_free_limit: 50_000_000,
        disk_free_alarm: false,
        fd_used: 64,
        fd_total: 1_048_576,
        proc_used: 512,
        proc_total: 1_048_576,
        sockets_used: ws.connections.length,
        sockets_total: 943_629,
        uptime_ms: 4 * 86_400_000 + 3 * 3_600_000,
        partitions: [],
      }
      return [node]
    }
    case 'rabbit_connections':
      return ws.connections.map((c) => ({ ...c }))
    case 'rabbit_close_connection': {
      const name = S(args.name)
      if (!ws.connections.some((c) => c.name === name)) throw new Error(`Not found — the connection '${name}' is already closed`)
      ws.connections = ws.connections.filter((c) => c.name !== name)
      ws.consumers = ws.consumers.filter((c) => c.connection_name !== name)
      return null
    }
    case 'rabbit_consumers':
      if (noRootVhost() && vhost === '/') throw new Error("Virtual host '/' was not found on this broker (or this user has no access to it).")
      return ws.consumers.filter((c) => c.vhost === vhost).map((c) => ({ ...c }))
    default:
      throw new Error(`demo: unknown RabbitMQ command ${cmd}`)
  }
}
