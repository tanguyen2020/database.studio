import { describe, expect, it } from 'vitest'
import { fromDraft, readableValue, sourceLabel, toDraft, TOPIC_CONFIG_GROUPS, type ConfigField } from './kafka-config'
import { cleanHost, describePlan, groupRows, groupState, planReset } from './kafka-groups'
import type { KafkaPartition } from '$lib/ipc'

const field = (key: string): ConfigField => TOPIC_CONFIG_GROUPS.flatMap((g) => g.fields).find((f) => f.key === key)!

describe('topic settings in words', () => {
  it('reads stored values the way people say them', () => {
    expect(readableValue(field('retention.ms'), '604800000')).toBe('7 days')
    expect(readableValue(field('retention.ms'), '-1')).toBe('Forever')
    expect(readableValue(field('retention.bytes'), '-1')).toBe('No limit')
    expect(readableValue(field('retention.bytes'), '5368709120')).toBe('5 GB')
    expect(readableValue(field('cleanup.policy'), 'compact')).toBe('Keep latest value per key')
    expect(readableValue(field('min.insync.replicas'), '2')).toBe('2')
    expect(sourceLabel('topic')).toBe('Set on this topic')
    expect(sourceLabel('broker')).toBe('From the broker')
  })

  it('round-trips a value through the form', () => {
    const r = field('retention.ms')
    expect(toDraft(r, '604800000')).toEqual({ unlimited: false, amount: '7', unit: 'days' })
    expect(toDraft(r, '5400000')).toEqual({ unlimited: false, amount: '90', unit: 'minutes' })
    expect(fromDraft(r, { unlimited: false, amount: '3', unit: 'days' })).toEqual({ value: '259200000' })
    expect(fromDraft(r, { unlimited: true, amount: '', unit: 'days' })).toEqual({ value: '-1' })
    const b = field('retention.bytes')
    expect(toDraft(b, '5368709120')).toEqual({ unlimited: false, amount: '5', unit: 'GB' })
    expect(fromDraft(b, { unlimited: false, amount: '512', unit: 'MB' })).toEqual({ value: String(512 * 1024 ** 2) })
  })

  it('refuses values that are not a positive number, in words', () => {
    expect(fromDraft(field('retention.ms'), { unlimited: false, amount: 'abc', unit: 'days' })).toEqual({ error: '“Keep messages for” needs a number greater than 0.' })
    expect(fromDraft(field('min.insync.replicas'), { unlimited: false, amount: '1.5', unit: '' })).toEqual({ error: '“Copies that must confirm a write” needs a whole number.' })
    expect(fromDraft(field('cleanup.policy'), { unlimited: false, amount: 'nope', unit: '' })).toHaveProperty('error')
  })
})

describe('consumer groups', () => {
  it('names states in words', () => {
    expect(groupState('Stable')).toEqual({ label: 'Running', tone: 'ok' })
    expect(groupState('Empty').label).toBe('Stopped')
    expect(groupState('PreparingRebalance').label).toBe('Rebalancing')
    expect(cleanHost('/10.0.1.20')).toBe('10.0.1.20')
  })

  it('sums what a group has not read yet, and knows when it is unknown', () => {
    const rows = groupRows(
      [
        { name: 'a', state: 'Stable', protocol: 'range', members: [{ member_id: 'm', client_id: 'c', host: '/h' }], topics: ['t'] },
        { name: 'b', state: 'Empty', protocol: '', members: [], topics: [] },
      ],
      { a: [{ topic: 't', partition: 0, committed: 5, high: 15, lag: 10 }, { topic: 't', partition: 1, committed: 2, high: 3, lag: 1 }] },
    )
    expect(rows[0]).toMatchObject({ consumers: 1, behind: 11, topics: ['t'] })
    expect(rows[1].behind).toBeNull()
  })

  const parts: KafkaPartition[] = [
    { id: 0, leader: 1, replicas: [1], isr: [1], low: 100, high: 1000, lag: 0 },
    { id: 1, leader: 1, replicas: [1], isr: [1], low: 0, high: 500, lag: 0 },
  ]
  const lags = [
    { topic: 't', partition: 0, committed: 900, high: 1000, lag: 100 },
    { topic: 't', partition: 1, committed: 500, high: 500, lag: 0 },
  ]

  it('plans earliest / latest / shift positions inside the log', () => {
    expect(planReset('t', parts, lags, { kind: 'earliest' }).map((r) => [r.after, r.delta])).toEqual([[100, 800], [0, 500]])
    expect(planReset('t', parts, lags, { kind: 'latest' }).map((r) => [r.after, r.delta])).toEqual([[1000, -100], [500, 0]])
    // moving back further than the log holds stops at the oldest kept message
    expect(planReset('t', parts, lags, { kind: 'shift', by: -1000 }).map((r) => r.after)).toEqual([100, 0])
  })

  it('plans a point in time, using "latest" where nothing is that recent', () => {
    const at = new Map<number, number | null>([[0, 700], [1, null]])
    expect(planReset('t', parts, lags, { kind: 'time', ts: 1 }, at).map((r) => r.after)).toEqual([700, 500])
  })

  it('describes a plan in one sentence', () => {
    expect(describePlan(planReset('t', parts, lags, { kind: 'earliest' }))).toBe('2 partitions will move · 1,300 messages will be read again.')
    expect(describePlan(planReset('t', parts, lags, { kind: 'latest' }))).toBe('1 partition will move · 100 messages will be skipped.')
    expect(describePlan(planReset('t', [parts[1]], lags, { kind: 'latest' }))).toBe('Nothing changes — the group already reads from these positions.')
  })
})

describe('form drafts from number inputs', () => {
  it('accepts the number a bound number input hands back, and null when it is empty', () => {
    const f = TOPIC_CONFIG_GROUPS[0].fields[0]
    expect(fromDraft(f, { unlimited: false, amount: 3, unit: 'days' })).toEqual({ value: '259200000' })
    expect(fromDraft(f, { unlimited: false, amount: null, unit: 'days' })).toHaveProperty('error')
  })
})
