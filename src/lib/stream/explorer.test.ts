import { describe, expect, it } from 'vitest'
import {
  kafkaTopicRows,
  natsStreamRows,
  topicMessageCount,
  filterStreamRows,
  filterTopicRows,
  consumerEmptyText,
} from './explorer'
import type { KafkaTopic, NatsJsStream } from '$lib/ipc'

const topic = (name: string, internal: boolean, parts: [number, number][]): KafkaTopic => ({
  name,
  internal,
  partitions: parts.map(([low, high], id) => ({ id, leader: 0, replicas: [0], isr: [0], low, high, lag: high - low })),
})

describe('topicMessageCount', () => {
  it('sums high − low across partitions, floors at 0', () => {
    expect(topicMessageCount(topic('t', false, [[0, 10], [5, 8]]))).toBe(13)
    expect(topicMessageCount(topic('t', false, [[10, 10]]))).toBe(0)
  })
})

describe('kafkaTopicRows', () => {
  it('hides internal topics by default, sorts by name, computes meta', () => {
    const rows = kafkaTopicRows([
      topic('orders', false, [[0, 100], [0, 20]]),
      topic('__consumer_offsets', true, [[0, 5]]),
      topic('audit', false, [[0, 3]]),
    ])
    expect(rows.map((r) => r.name)).toEqual(['audit', 'orders'])
    const orders = rows.find((r) => r.name === 'orders')!
    expect(orders.partitions).toBe(2)
    expect(orders.messages).toBe(120)
    expect(orders.meta).toBe('2 part · 120 msg')
  })
  it('showInternal keeps __ topics', () => {
    const rows = kafkaTopicRows([topic('__consumer_offsets', true, [[0, 5]])], true)
    expect(rows).toHaveLength(1)
  })
})

describe('filterTopicRows', () => {
  const rows = kafkaTopicRows([
    topic('orders', false, [[0, 100]]),
    topic('order_events', false, [[0, 5]]),
    topic('audit', false, [[0, 3]]),
  ])

  it('blank query returns rows unchanged', () => {
    expect(filterTopicRows('', rows)).toBe(rows)
    expect(filterTopicRows('   ', rows)).toBe(rows)
  })

  it('matches topic names case-insensitively (substring)', () => {
    expect(filterTopicRows('ORDER', rows).map((t) => t.name)).toEqual(['order_events', 'orders'])
    expect(filterTopicRows('audit', rows).map((t) => t.name)).toEqual(['audit'])
  })

  it('drops topics with no name match', () => {
    expect(filterTopicRows('nomatch', rows)).toEqual([])
  })
})

describe('natsStreamRows', () => {
  const stream = (name: string, subjects: string[], messages: number): NatsJsStream => ({
    name,
    subjects,
    retention: 'Limits',
    storage: 'File',
    messages,
    bytes: 0,
    consumers: 0,
  })

  it('lists each stream with deduped sorted subjects + meta', () => {
    const rows = natsStreamRows([
      stream('ORDERS', ['orders.eu', 'orders.us', 'orders.eu'], 42),
      stream('AUDIT', ['audit.>'], 3),
    ])
    expect(rows.map((r) => r.name)).toEqual(['AUDIT', 'ORDERS'])
    const orders = rows.find((r) => r.name === 'ORDERS')!
    expect(orders.subjects.map((s) => s.subject)).toEqual(['orders.eu', 'orders.us'])
    expect(orders.meta).toBe('2 subj · 42 msg')
  })
})

describe('filterStreamRows', () => {
  const rows = natsStreamRows([
    { name: 'ORDERS', subjects: ['orders.eu', 'orders.us'], retention: 'Limits', storage: 'File', messages: 42, bytes: 0, consumers: 0 },
    { name: 'AUDIT', subjects: ['audit.login', 'audit.logout'], retention: 'Limits', storage: 'File', messages: 3, bytes: 0, consumers: 0 },
  ])

  it('blank query returns rows unchanged', () => {
    expect(filterStreamRows('', rows)).toBe(rows)
    expect(filterStreamRows('   ', rows)).toBe(rows)
  })

  it('matches by stream name (keeps all subjects), case-insensitive', () => {
    const out = filterStreamRows('order', rows)
    expect(out.map((s) => s.name)).toEqual(['ORDERS'])
    expect(out[0].subjects.map((s) => s.subject)).toEqual(['orders.eu', 'orders.us'])
  })

  it('does not match on subject names', () => {
    expect(filterStreamRows('logout', rows)).toEqual([])
  })

  it('drops streams with no name match', () => {
    expect(filterStreamRows('nomatch', rows)).toEqual([])
  })
})

describe('consumerEmptyText', () => {
  const base = { loading: false, tailing: false, atEnd: false, receivedAny: false, hasError: false, retained: 0 }

  it('says the topic is empty only when the broker watermarks agree it is', () => {
    expect(consumerEmptyText({ ...base, atEnd: true })).toBe('This topic has no messages.')
  })

  it('NEVER claims "no messages" while the broker still reports retained records', () => {
    // reading nothing ≠ empty: the browsed window may hold no readable record
    // (compaction / transaction control records) on a topic that is still full
    const out = consumerEmptyText({ ...base, atEnd: true, retained: 12345 })
    expect(out).not.toContain('no messages')
    expect(out).toContain('12,345')
    expect(out).toContain('Older')
  })

  it('does not claim "no messages" when the retained count is unknown (−1)', () => {
    expect(consumerEmptyText({ ...base, atEnd: true, retained: -1 })).toBe(
      'No messages to show — reached the end of the topic.',
    )
  })

  it('keeps waiting while a live tail has not reached the end yet', () => {
    expect(consumerEmptyText({ ...base, tailing: true })).toBe('Waiting for messages…')
  })

  it('distinguishes "read it all, view cleared" from an empty topic', () => {
    expect(consumerEmptyText({ ...base, atEnd: true, receivedAny: true, retained: 50 })).toBe(
      'No messages to show — reached the end of the topic.',
    )
  })

  it('says it is still reading while a page fetch is in flight', () => {
    expect(consumerEmptyText({ ...base, loading: true, atEnd: true })).toBe('Reading messages…')
  })

  it('an error wins over every other state', () => {
    expect(
      consumerEmptyText({ ...base, atEnd: true, hasError: true, retained: 7 }),
    ).toBe(
      'Could not read messages — see the error above.',
    )
  })
})

describe('kafkaTopicRows — unknown offsets', () => {
  const t = (over: Partial<KafkaTopic>): KafkaTopic => ({
    name: 'onesis-class-student-enrollment',
    internal: false,
    partitions: [{ id: 0, leader: 1, replicas: [1], isr: [1], low: 0, high: 0, lag: 0 }],
    ...over,
  })

  it('shows "? msg" (never "0 msg") when the broker did not report offsets', () => {
    const [row] = kafkaTopicRows([t({ offsets_known: false, offsets_error: 'Broker: Not available' })])
    expect(row.meta).toBe('1 part · ? msg')
    expect(row.meta).not.toContain('0 msg')
    expect(row.messages).toBe(-1)
    expect(row.offsetsError).toBe('Broker: Not available')
  })

  it('still says 0 msg for a topic the broker confirms is empty', () => {
    const [row] = kafkaTopicRows([t({ offsets_known: true })])
    expect(row.meta).toBe('1 part · 0 msg')
    expect(row.offsetsError).toBeUndefined()
  })

  it('falls back to a readable reason when the broker gave none', () => {
    const [row] = kafkaTopicRows([t({ offsets_known: false })])
    expect(row.offsetsError).toBe('the broker did not report offsets')
  })
})
