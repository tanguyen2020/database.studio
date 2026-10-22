import { describe, expect, it } from 'vitest'
import { compactCount, exactUtc, fullCount, humanDuration, percent, plural, relativeTime } from './humanize'
import { filterRows, isZeroText, moveSelection, nextSort, sortRows, virtualWindow } from './table'
import { kafkaHealth, topicRows } from './kafka-health'
import { niceMax, polylinePoints, pushSample } from './rates'
import type { KafkaCluster, KafkaTopic } from '$lib/ipc'

describe('humanize', () => {
  it('compacts counts and keeps small numbers exact', () => {
    expect(compactCount(0)).toBe('0')
    expect(compactCount(999)).toBe('999')
    expect(compactCount(12904)).toBe('12.9k')
    expect(compactCount(1530000)).toBe('1.5M')
    expect(compactCount(250_000)).toBe('250k')
    expect(compactCount(null)).toBe('—')
    expect(fullCount(18420933)).toBe('18,420,933')
    expect(plural(1, 'message')).toBe('1 message')
    expect(plural(3, 'message')).toBe('3 messages')
  })

  it('turns milliseconds into words', () => {
    expect(humanDuration(604_800_000)).toBe('7 days')
    expect(humanDuration(86_400_000)).toBe('1 day')
    expect(humanDuration(30 * 86_400_000)).toBe('30 days')
    expect(humanDuration(5_400_000)).toBe('1.5 hours')
    expect(humanDuration(30_000)).toBe('30 seconds')
    expect(humanDuration(-1)).toBe('Forever')
    expect(humanDuration(250)).toBe('250 ms')
  })

  it('formats relative and exact times', () => {
    const now = Date.UTC(2026, 9, 21, 8, 20, 0)
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 6 * 60_000, now)).toBe('6 min ago')
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 h ago')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2 days ago')
    expect(relativeTime(now + 5 * 60_000, now)).toBe('in 5 min')
    expect(exactUtc(Date.UTC(2026, 9, 21, 8, 14, 3, 211))).toBe('2026-10-21 08:14:03 UTC')
    expect(percent(71, 100)).toBe('71%')
    expect(percent(1, 0)).toBe('—')
  })
})

describe('table helpers', () => {
  const rows = [
    { name: 'payments', lag: 120 },
    { name: 'orders', lag: null },
    { name: 'audit', lag: 0 },
    { name: 'Payouts', lag: 900 },
  ]
  const value = (r: (typeof rows)[number], key: string) => (key === 'lag' ? r.lag : r.name)

  it('filters case-insensitively and returns the same array for an empty query', () => {
    expect(filterRows(rows, '', (r) => r.name)).toBe(rows)
    expect(filterRows(rows, 'PAY', (r) => r.name).map((r) => r.name)).toEqual(['payments', 'Payouts'])
  })

  it('sorts numbers numerically and keeps unknown values at the bottom both ways', () => {
    expect(sortRows(rows, { key: 'lag', dir: 'asc' }, value).map((r) => r.name)).toEqual(['audit', 'payments', 'Payouts', 'orders'])
    expect(sortRows(rows, { key: 'lag', dir: 'desc' }, value).map((r) => r.name)).toEqual(['Payouts', 'payments', 'audit', 'orders'])
    expect(sortRows(rows, { key: 'name', dir: 'asc' }, value).map((r) => r.name)).toEqual(['audit', 'orders', 'payments', 'Payouts'])
    expect(sortRows(rows, null, value)).toBe(rows)
  })

  it('toggles sort direction on the same column', () => {
    expect(nextSort(null, 'lag')).toEqual({ key: 'lag', dir: 'asc' })
    expect(nextSort({ key: 'lag', dir: 'asc' }, 'lag')).toEqual({ key: 'lag', dir: 'desc' })
    expect(nextSort({ key: 'lag', dir: 'desc' }, 'name', 'desc')).toEqual({ key: 'name', dir: 'desc' })
  })

  it('computes the virtual window with overscan and padding', () => {
    const w = virtualWindow(5000, 32, 3200, 640, 5)
    expect(w.start).toBe(95)
    expect(w.end).toBe(126)
    expect(w.padTop).toBe(95 * 32)
    expect(w.padBottom).toBe((5000 - 126) * 32)
    expect(virtualWindow(0, 32, 0, 640)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
    const end = virtualWindow(10, 32, 10_000, 640)
    expect(end.end).toBe(10)
  })

  it('moves the keyboard selection within bounds', () => {
    expect(moveSelection(-1, 1, 3)).toBe(0)
    expect(moveSelection(-1, -1, 3)).toBe(2)
    expect(moveSelection(2, 1, 3)).toBe(2)
    expect(moveSelection(0, -1, 3)).toBe(0)
    expect(moveSelection(0, 1, 0)).toBe(-1)
  })
})

describe('kafka health', () => {
  const cluster: KafkaCluster = {
    brokers: [
      { id: 1, host: 'k1', port: 9092 },
      { id: 2, host: 'k2', port: 9092 },
      { id: 3, host: 'k3', port: 9092 },
    ],
    controller_id: 1,
    topic_count: 2,
    partition_count: 4,
  }
  const healthy: KafkaTopic[] = [
    { name: 'orders', internal: false, partitions: [
      { id: 0, leader: 1, replicas: [1, 2, 3], isr: [1, 2, 3], low: 0, high: 100, lag: 100 },
      { id: 1, leader: 2, replicas: [2, 3, 1], isr: [2, 3, 1], low: 10, high: 60, lag: 50 },
    ] },
    { name: '__consumer_offsets', internal: true, partitions: [{ id: 0, leader: 3, replicas: [3], isr: [3], low: 0, high: 9, lag: 9 }] },
  ]

  it('reports a healthy cluster and per-broker counts', () => {
    const h = kafkaHealth(cluster, healthy)
    expect(h.tone).toBe('ok')
    expect(h.headline).toBe('Everything looks healthy')
    expect(h.topicCount).toBe(1) // internal topics are not "your" topics
    expect(h.partitionCount).toBe(3)
    expect(h.messages).toBe(150)
    expect(h.brokers.map((b) => [b.id, b.leads, b.holds, b.behind, b.isController])).toEqual([
      [1, 1, 2, 0, true],
      [2, 1, 2, 0, false],
      [3, 1, 3, 0, false],
    ])
  })

  it('names partitions with missing copies and the broker that is behind', () => {
    const t = structuredClone(healthy)
    t[0].partitions[1].isr = [2, 1]
    const h = kafkaHealth(cluster, t)
    expect(h.tone).toBe('warn')
    expect(h.missingCopies).toEqual([{ topic: 'orders', partition: 1 }])
    expect(h.headline).toBe('1 partition of orders has fewer copies than configured')
    expect(h.brokers.find((b) => b.id === 3)?.behind).toBe(1)
  })

  it('treats a partition without a leader as unavailable, worse than missing copies', () => {
    const t = structuredClone(healthy)
    t[0].partitions[0].leader = -1
    t[0].partitions[1].isr = [2]
    const h = kafkaHealth(cluster, t)
    expect(h.tone).toBe('bad')
    expect(h.unavailable).toEqual([{ topic: 'orders', partition: 0 }])
    expect(h.headline).toBe('1 partition is unavailable')
  })

  it('does not invent a message count when offsets are unknown', () => {
    const t = structuredClone(healthy)
    t[0].offsets_known = false
    expect(kafkaHealth(cluster, t).messages).toBeNull()
    expect(topicRows(t)[0].messages).toBeNull()
  })

  it('summarises topics for the table', () => {
    const t = structuredClone(healthy)
    t[0].partitions[1].isr = [2]
    expect(topicRows(t)[0]).toMatchObject({ name: 'orders', partitions: 2, copies: 3, upToDate: 1, messages: 150 })
  })
})

describe('rates', () => {
  it('keeps a rolling window and scales a polyline', () => {
    let s = pushSample([], { t: 0, v: 10 }, 60_000)
    s = pushSample(s, { t: 30_000, v: 20 }, 60_000)
    s = pushSample(s, { t: 70_000, v: 40 }, 60_000)
    expect(s.map((p) => p.t)).toEqual([30_000, 70_000])
    expect(niceMax(s)).toBe(50)
    expect(niceMax([])).toBe(1)
    expect(polylinePoints(s, 600, 100, 50, 70_000, 60_000)).toBe('200,60 600,20')
  })
})

describe('isZeroText', () => {
  it('recognises a cell that shows only a zero', () => {
    for (const t of ['0', ' 0 ', '0 B', '0.0 MB', '0/s', '0.0/s', '0%']) expect(isZeroText(t), t).toBe(true)
  })
  it('leaves real values and other text alone', () => {
    for (const t of ['10', '1', '0.5', '15.2K', '100 B', '1/s', '—', '?', 'None', '', '0x1f']) expect(isZeroText(t), t).toBe(false)
  })
})
