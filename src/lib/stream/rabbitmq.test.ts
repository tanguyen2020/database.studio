import { describe, expect, it } from 'vitest'
import type { RabbitNode, RabbitOverview, RabbitQueue } from '$lib/ipc'
import {
  clientLabel,
  consumersOf,
  diskUsage,
  formatRate,
  isDeadLetterQueue,
  memoryUsage,
  nodeAlarms,
  prefetchText,
  queueAttention,
  rabbitStatus,
  uptimeText,
} from './rabbitmq-health'
import { createPreview, describeArguments, queueFeatures, queueTypeLabel, streamAge } from './rabbitmq-arguments'
import { formatBytes } from './humanize'

const q = (name: string, extra: Partial<RabbitQueue> = {}): RabbitQueue => ({
  name,
  vhost: '/',
  queue_type: 'classic',
  durable: true,
  auto_delete: false,
  exclusive: false,
  state: 'running',
  messages: 0,
  messages_ready: 0,
  messages_unacknowledged: 0,
  consumers: 0,
  memory: null,
  node: 'rabbit@a',
  policy: '',
  arguments: {},
  ...extra,
})

const node = (extra: Partial<RabbitNode> = {}): RabbitNode => ({
  name: 'rabbit@a',
  node_type: 'disc',
  running: true,
  mem_used: 200 * 1024 * 1024,
  mem_limit: 1024 * 1024 * 1024,
  mem_alarm: false,
  disk_free: 40 * 1024 ** 3,
  disk_free_limit: 50 * 1024 * 1024,
  disk_free_alarm: false,
  fd_used: 10,
  fd_total: 100,
  proc_used: 1,
  proc_total: 10,
  sockets_used: 1,
  sockets_total: 10,
  uptime_ms: 3_600_000,
  partitions: [],
  ...extra,
})

const overview = (extra: Partial<RabbitOverview> = {}): RabbitOverview => ({
  rabbitmq_version: '3.13.7',
  erlang_version: '26',
  cluster_name: 'c',
  node: 'rabbit@a',
  management_version: '3.13.7',
  messages: 0,
  messages_ready: 0,
  messages_unacknowledged: 0,
  queues: 0,
  exchanges: 0,
  connections: 0,
  channels: 0,
  consumers: 0,
  vhost: '/',
  exchange_types: [],
  ...extra,
})

describe('rabbitmq queues needing attention', () => {
  it('flags waiting messages without consumers, with the reason and an action', () => {
    const got = queueAttention([q('orders', { messages_ready: 2104, consumers: 0 }), q('ok', { messages_ready: 5, consumers: 2 })])
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ queue: 'orders', tone: 'warn', action: 'Open queue' })
    expect(got[0].reason).toBe('No consumers — 2,104 messages waiting.')
  })

  it('flags failed messages in a dead-letter queue (by name or by another queue routing into it)', () => {
    expect(isDeadLetterQueue({ name: 'orders.dlq' })).toBe(true)
    expect(isDeadLetterQueue({ name: 'payments-failed' })).toBe(true)
    expect(isDeadLetterQueue({ name: 'deadline.jobs' })).toBe(false)
    expect(isDeadLetterQueue({ name: 'retry' }, [{ name: 'orders', arguments: { 'x-dead-letter-routing-key': 'retry' } }])).toBe(true)
    const got = queueAttention([q('orders.dlq', { messages_ready: 3, consumers: 1 })])
    expect(got[0].reason).toBe('3 failed messages waiting in this dead-letter queue.')
  })

  it('flags many messages in progress per consumer as possibly stuck', () => {
    const got = queueAttention([q('pay', { messages_unacknowledged: 1240, consumers: 1 }), q('fine', { messages_unacknowledged: 40, consumers: 1 })])
    expect(got.map((a) => a.queue)).toEqual(['pay'])
    expect(got[0].reason).toContain('1,240 messages in progress for 1 consumer')
    expect(got[0].action).toBe('See consumers')
  })

  it('never flags a queue whose counts are unknown, and puts broken queues first', () => {
    expect(queueAttention([q('fresh', { messages_ready: null, consumers: null })])).toEqual([])
    const got = queueAttention([q('a', { messages_ready: 9, consumers: 0 }), q('down', { state: 'down' }), q('b', { messages_ready: 90, consumers: 0 })])
    expect(got.map((x) => x.queue)).toEqual(['down', 'b', 'a'])
    expect(got[0].tone).toBe('bad')
    expect(queueAttention([q('throttled', { state: 'flow' })])).toEqual([])
  })
})

describe('rabbitmq status sentence', () => {
  it('says healthy in words when nothing needs attention', () => {
    const s = rabbitStatus(overview({ messages_ready: 12 }), [node()], [])
    expect(s.tone).toBe('ok')
    expect(s.headline).toBe('Everything looks healthy')
    expect(s.detail).toContain('12 messages waiting')
  })

  it('puts a paused broker (memory / disk alarm) above queue problems', () => {
    const att = queueAttention([q('orders', { messages_ready: 5 })])
    const s = rabbitStatus(overview(), [node({ disk_free_alarm: true })], att)
    expect(s.tone).toBe('bad')
    expect(s.headline).toBe('Publishers are paused')
    expect(s.detail).toContain('below its disk safety margin')
    expect(s.actionSection).toBe('nodes')
    expect(nodeAlarms(node({ partitions: ['rabbit@b'], running: false }))).toEqual(['rabbit@a is not running', 'rabbit@a cannot see rabbit@b (network partition)'])
  })

  it('names the queue when exactly one needs attention', () => {
    const s = rabbitStatus(overview(), [node()], queueAttention([q('orders', { messages_ready: 5 })]))
    expect(s.headline).toBe('Queue orders needs attention')
    expect(s.actionSection).toBe('queues')
    expect(rabbitStatus(null, null, []).tone).toBe('warn')
  })
})

describe('rabbitmq values in words', () => {
  it('formats rates, uptime, prefetch and client names', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(0)).toBe('0/s')
    expect(formatRate(4.27)).toBe('4.3/s')
    expect(formatRate(12904)).toBe('12.9k/s')
    expect(uptimeText(4 * 86_400_000 + 3 * 3_600_000)).toBe('4 days 3 h')
    expect(uptimeText(90 * 60_000)).toBe('1 h 30 min')
    expect(uptimeText(null)).toBe('—')
    expect(prefetchText(0)).toBe('No limit')
    expect(prefetchText(10)).toBe('10')
    expect(clientLabel({ client_name: '', client_product: 'pika', peer_host: '10.0.0.1' })).toBe('pika')
    expect(clientLabel({ client_name: '', client_product: '', peer_host: '' })).toBe('Unnamed client')
  })

  it('shows memory against its limit and the disk against its margin', () => {
    const m = memoryUsage(node({ mem_used: 900, mem_limit: 1000 }), formatBytes)
    expect(m.tone).toBe('warn')
    expect(m.label).toBe('900 B of 1000 B (90%)')
    expect(memoryUsage(node({ mem_alarm: true }), formatBytes).tone).toBe('bad')
    expect(memoryUsage(node({ mem_used: null }), formatBytes)).toMatchObject({ label: 'Not reported', pct: null })
    expect(diskUsage(node({ disk_free: 60, disk_free_limit: 50 }), formatBytes).tone).toBe('warn')
    expect(diskUsage(node(), formatBytes).label).toBe('40 GB free · margin 50 MB')
  })

  it('joins consumers to the application that owns the connection', () => {
    const got = consumersOf(
      'orders',
      [
        { queue: 'orders', vhost: '/', consumer_tag: 't1', prefetch_count: 10, ack_required: true, exclusive: false, active: true, activity_status: 'up', channel_name: 'c (1)', channel_number: 1, connection_name: 'c', peer_host: '10.0.0.5', user: 'app' },
        { queue: 'other', vhost: '/', consumer_tag: 't2', prefetch_count: 1, ack_required: true, exclusive: false, active: true, activity_status: 'up', channel_name: 'd (1)', channel_number: 1, connection_name: 'd', peer_host: '', user: 'app' },
      ],
      [{ name: 'c', client_name: 'orders-api', client_product: 'RabbitMQ', peer_host: '10.0.0.5' }],
    )
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ app: 'orders-api', host: '10.0.0.5', consumer_tag: 't1' })
  })
})

describe('rabbitmq arguments as sentences', () => {
  it('turns the common x-arguments into plain language', () => {
    const s = describeArguments({
      'x-queue-type': 'quorum',
      'x-message-ttl': 86_400_000,
      'x-dead-letter-exchange': 'payments.dlx',
      'x-delivery-limit': 5,
      'x-max-length': 10000,
      'x-overflow': 'reject-publish',
    })
    const text = s.map((x) => x.text)
    expect(text).toContain('Messages expire after 1 day')
    expect(text).toContain('Max 5 delivery attempts, then the message counts as failed')
    expect(text).toContain('Keeps at most 10,000 messages — when full, new messages are refused')
    expect(s.find((x) => x.key === 'x-dead-letter-exchange')).toMatchObject({ text: 'Failed messages go to', exchange: 'payments.dlx' })
    // the queue type is shown as a chip, not repeated here; x-overflow folds into x-max-length
    expect(s.map((x) => x.key)).not.toContain('x-queue-type')
    expect(s.map((x) => x.key)).not.toContain('x-overflow')
  })

  it('handles streams, dead-lettering straight to a queue, and unknown keys', () => {
    expect(streamAge('7D')).toBe('7 days')
    expect(streamAge('1h')).toBe('1 hour')
    expect(streamAge('soon')).toBeNull()
    expect(describeArguments({ 'x-max-age': '7D' })[0].text).toBe('Keeps messages for 7 days')
    const dl = describeArguments({ 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'orders.dlq' })
    expect(dl).toEqual([{ key: 'x-dead-letter-exchange', text: 'Failed messages go to queue', queue: 'orders.dlq' }])
    expect(describeArguments({ 'x-custom': [1, 2] })[0].text).toBe('Custom setting x-custom = [1,2]')
    expect(describeArguments({ 'x-max-length': 5 })[0].text).toBe('Keeps at most 5 messages — when full, the oldest messages are dropped')
    expect(describeArguments(null)).toEqual([])
  })

  it('previews what the create form will make, in sentences', () => {
    const q = createPreview({
      kind: 'queue',
      vhost: '/',
      name: 'payments.q',
      queueType: 'quorum',
      durable: false, // ignored: quorum queues are always durable
      autoDelete: true,
      args: { 'x-delivery-limit': 5 },
      binds: [{ exchange: 'orders', routingKey: 'order.#' }],
    })
    expect(q).toEqual([
      'A durable quorum queue “payments.q” in virtual host /.',
      'Max 5 delivery attempts, then the message counts as failed.',
      'Receives messages from orders whose routing key matches “order.#”.',
    ])
    expect(createPreview({ kind: 'queue', vhost: 'v', name: 't', queueType: '', durable: false, autoDelete: true, args: {} })).toEqual([
      'A temporary default-type queue “t” in virtual host v.',
      'It deletes itself once its last consumer disconnects.',
      'Messages reach it only when published to it by name (no bindings).',
    ])
    const x = createPreview({ kind: 'exchange', vhost: '/', name: 'with.ae', exchangeType: 'topic', durable: true, autoDelete: false, internal: true, args: { 'alternate-exchange': 'events' } })
    expect(x).toContain('Internal: clients cannot publish to it directly.')
    expect(x).toContain('Messages no binding matches go to events.')
    expect(createPreview({ kind: 'exchange', vhost: '/', name: '  ', durable: true, autoDelete: false, args: {} })).toEqual([])
  })

  it('names queue features and types in full words', () => {
    expect(queueFeatures({ durable: true, auto_delete: true, exclusive: false }).map((f) => f.label)).toEqual(['Durable', 'Auto-delete'])
    expect(queueFeatures({ durable: false, auto_delete: false, exclusive: true }).map((f) => f.label)).toEqual(['Temporary', 'Exclusive'])
    expect(queueTypeLabel('quorum')).toBe('Quorum')
    expect(queueTypeLabel('')).toBe('Classic')
  })
})
