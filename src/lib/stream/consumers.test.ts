import { describe, expect, it } from 'vitest'
import {
  inView,
  kafkaConsumersFor,
  kafkaMessageState,
  kafkaTopicGroups,
  natsConsumersFor,
  natsMessageState,
  natsSubjectConsumers,
  natsSubjectMatches,
} from './consumers'

const lag = (topic: string, partition: number, committed: number, high: number) => ({ topic, partition, committed, high, lag: high - committed })

describe('kafkaConsumersFor', () => {
  const groups = [
    { name: 'billing', state: 'Stable', lag: [lag('payments', 0, 15_100, 15_200), lag('payments', 1, 50, 60)] },
    { name: 'audit', state: 'Empty', lag: [lag('payments', 0, 15_400, 15_400)] },
    { name: 'search', state: 'Stable', lag: [lag('orders', 0, 10, 10)] }, // another topic
    { name: 'late', state: 'Stable', lag: [lag('payments', 2, 5, 9)] }, // other partition only
  ]

  it('lists only the groups that read the topic', () => {
    const names = kafkaConsumersFor('payments', 0, 15_150, groups).map((c) => c.name)
    expect(names).toContain('billing')
    expect(names).toContain('audit')
    expect(names).toContain('late')
    expect(names).not.toContain('search')
  })

  it('processed when offset < committed (committed = next to read), else pending', () => {
    const c = kafkaConsumersFor('payments', 0, 15_150, groups)
    expect(c.find((x) => x.name === 'billing')).toMatchObject({ state: 'pending', detail: '51 behind this message · committed 15,100' })
    expect(c.find((x) => x.name === 'audit')).toMatchObject({ state: 'processed', detail: 'committed 15,400 · lag 0' })
    // the offset right before the committed one is processed; the committed one is not
    expect(kafkaConsumersFor('payments', 0, 15_099, groups).find((x) => x.name === 'billing')!.state).toBe('processed')
    expect(kafkaConsumersFor('payments', 0, 15_100, groups).find((x) => x.name === 'billing')!.state).toBe('pending')
  })

  it('a group reading the topic but without a commit on this partition is unknown, and problems sort first', () => {
    const c = kafkaConsumersFor('payments', 0, 15_150, groups)
    expect(c.find((x) => x.name === 'late')).toMatchObject({ state: 'unknown' })
    expect(c.map((x) => x.state)).toEqual(['pending', 'unknown', 'processed'])
  })
})

describe('natsSubjectMatches', () => {
  it('follows NATS wildcards', () => {
    expect(natsSubjectMatches('orders.eu', 'orders.eu')).toBe(true)
    expect(natsSubjectMatches('orders.*', 'orders.eu')).toBe(true)
    expect(natsSubjectMatches('orders.*', 'orders.eu.1')).toBe(false)
    expect(natsSubjectMatches('orders.>', 'orders.eu.1')).toBe(true)
    expect(natsSubjectMatches('orders.>', 'orders')).toBe(false)
    expect(natsSubjectMatches('', 'anything')).toBe(true)
    expect(natsSubjectMatches('orders.us', 'orders.eu')).toBe(false)
  })
})

describe('natsConsumersFor', () => {
  const cons = [
    { name: 'eu-worker', filter_subject: 'orders.eu', ack_policy: 'Explicit', ack_floor_stream_seq: 900, delivered_stream_seq: 960 },
    { name: 'all', filter_subject: '', ack_policy: 'Explicit', ack_floor_stream_seq: 1000, delivered_stream_seq: 1000 },
    { name: 'us-only', filter_subject: 'orders.us', ack_policy: 'Explicit', ack_floor_stream_seq: 0, delivered_stream_seq: 0 },
    { name: 'old-server', filter_subject: 'orders.>', ack_policy: 'Explicit' },
  ]

  it('only consumers whose filter covers the subject', () => {
    const names = natsConsumersFor('orders.eu', 950, cons).map((c) => c.name)
    expect(names.sort()).toEqual(['all', 'eu-worker', 'old-server'])
  })

  it('processed ≤ ack floor, in flight ≤ delivered, pending beyond', () => {
    const at = (seq: number) => natsConsumersFor('orders.eu', seq, cons).find((c) => c.name === 'eu-worker')!.state
    expect(at(900)).toBe('processed')
    expect(at(950)).toBe('in-flight')
    expect(at(980)).toBe('pending')
    expect(natsConsumersFor('orders.eu', 950, cons).find((c) => c.name === 'old-server')!.state).toBe('unknown')
  })

  it('a filter list wins over the single filter', () => {
    const c = [{ name: 'multi', filter_subject: '', filter_subjects: ['a.x', 'b.>'], ack_policy: 'Explicit', ack_floor_stream_seq: 5, delivered_stream_seq: 5 }]
    expect(natsConsumersFor('b.1', 3, c)).toHaveLength(1)
    expect(natsConsumersFor('c.1', 3, c)).toHaveLength(0)
  })
})


describe('consumer view (tab)', () => {
  const groups = [
    { name: 'billing', state: 'Stable', lag: [lag('payments', 0, 100, 150), lag('payments', 1, 10, 10)] },
    { name: 'audit', state: 'Empty', lag: [lag('payments', 0, 150, 150)] },
    { name: 'search', state: 'Stable', lag: [lag('orders', 0, 1, 1)] },
  ]

  it('lists the groups of the topic with their backlog, most behind first', () => {
    expect(kafkaTopicGroups('payments', groups)).toEqual([
      { name: 'billing', state: 'Stable', lag: 50, partitions: 2 },
      { name: 'audit', state: 'Empty', lag: 0, partitions: 1 },
    ])
  })

  it('a message is processed by a group when its offset is below the commit', () => {
    expect(kafkaMessageState(groups[0], 'payments', 0, 99)).toBe('processed')
    expect(kafkaMessageState(groups[0], 'payments', 0, 100)).toBe('pending')
    expect(kafkaMessageState(groups[1], 'payments', 1, 5)).toBe('unknown') // no commit on p1
  })

  it('the two view buttons split processed from not processed (pending + in flight)', () => {
    expect(inView('processed', 'processed')).toBe(true)
    expect(inView('pending', 'processed')).toBe(false)
    expect(inView('pending', 'unprocessed')).toBe(true)
    expect(inView('in-flight', 'unprocessed')).toBe(true)
    expect(inView('unknown', 'unprocessed')).toBe(false)
    expect(inView('n/a', 'processed')).toBe(false)
    expect(inView('n/a', 'all')).toBe(true)
  })

  it('nats: consumers whose filter overlaps a (wildcard) tab subject', () => {
    const cons = [
      { name: 'eu', filter_subject: 'orders.eu', ack_policy: 'Explicit', ack_floor_stream_seq: 5, delivered_stream_seq: 8 },
      { name: 'all', filter_subject: '', ack_policy: 'Explicit', ack_floor_stream_seq: 9, delivered_stream_seq: 9 },
      { name: 'other', filter_subject: 'billing.>', ack_policy: 'Explicit', ack_floor_stream_seq: 0, delivered_stream_seq: 0 },
    ]
    expect(natsSubjectConsumers('orders.>', cons).map((c) => c.name)).toEqual(['eu', 'all'])
    expect(natsSubjectConsumers('orders.eu', cons).map((c) => c.name)).toEqual(['eu', 'all'])
    // per message: a filter that skips the message's subject is n/a, not "pending"
    expect(natsMessageState(cons[0], 'orders.us', 3)).toBe('n/a')
    expect(natsMessageState(cons[0], 'orders.eu', 3)).toBe('processed')
    expect(natsMessageState(cons[0], 'orders.eu', 7)).toBe('in-flight')
    expect(natsMessageState(cons[0], 'orders.eu', 9)).toBe('pending')
  })
})
