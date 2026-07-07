import { describe, expect, it } from 'vitest'
import { kafkaTopicRows, natsStreamRows, topicMessageCount } from './explorer'
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
