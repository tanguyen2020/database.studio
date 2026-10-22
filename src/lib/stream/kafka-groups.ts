// Consumer groups in plain language + the "change read position" plan
// (SPEC-KAFKA-WORKSPACE.md §1, §3b). The plan is computed and previewed BEFORE
// anything is applied, and applied exactly as previewed (explicit positions).

import type { KafkaGroup, KafkaLag, KafkaPartition } from '$lib/ipc'

export type StateTone = 'ok' | 'warn' | 'bad' | 'quiet'

export function groupState(state: string): { label: string; tone: StateTone } {
  switch (state) {
    case 'Stable':
      return { label: 'Running', tone: 'ok' }
    case 'Empty':
      return { label: 'Stopped', tone: 'quiet' }
    case 'PreparingRebalance':
    case 'CompletingRebalance':
      return { label: 'Rebalancing', tone: 'warn' }
    case 'Dead':
      return { label: 'Deleted', tone: 'bad' }
    default:
      return { label: state || 'Unknown', tone: 'quiet' }
  }
}

/** "/10.0.1.20" → "10.0.1.20" (Kafka prefixes client hosts with a slash). */
export const cleanHost = (host: string) => host.replace(/^\//, '')

export interface GroupRow {
  name: string
  state: string
  consumers: number
  topics: string[]
  /** messages not read yet across everything it committed; null = not loaded/unknown */
  behind: number | null
}

export function groupRows(groups: KafkaGroup[], lags: Record<string, KafkaLag[] | null | undefined>): GroupRow[] {
  return groups.map((g) => {
    const lag = lags[g.name]
    const committedTopics = lag ? [...new Set(lag.map((l) => l.topic))] : []
    return {
      name: g.name,
      state: g.state,
      consumers: g.members.length,
      topics: g.topics?.length ? g.topics : committedTopics,
      behind: lag ? lag.reduce((s, l) => s + Math.max(0, l.lag), 0) : null,
    }
  })
}

export type Target =
  | { kind: 'earliest' }
  | { kind: 'latest' }
  | { kind: 'time'; ts: number }
  | { kind: 'shift'; by: number }

export interface PlanRow {
  partition: number
  before: number | null
  after: number
  /** messages that will be read again (> 0) or skipped (< 0) */
  delta: number | null
  latest: number
}

/**
 * New read position per partition of `topic`, clamped to what the log still holds.
 * `timeOffsets` (partition → position | null = nothing that recent) is required for
 * the 'time' target; a partition without a committed position starts from `before`
 * = null and gets an absolute target only.
 */
export function planReset(
  topic: string,
  partitions: KafkaPartition[],
  lags: KafkaLag[],
  target: Target,
  timeOffsets?: Map<number, number | null>,
): PlanRow[] {
  return partitions.map((p) => {
    const committed = lags.find((l) => l.topic === topic && l.partition === p.id)?.committed ?? null
    let after: number
    switch (target.kind) {
      case 'earliest':
        after = p.low
        break
      case 'latest':
        after = p.high
        break
      case 'time': {
        const off = timeOffsets?.get(p.id)
        after = off == null ? p.high : off
        break
      }
      case 'shift':
        after = (committed ?? p.high) + target.by
        break
    }
    after = Math.min(p.high, Math.max(p.low, after))
    return { partition: p.id, before: committed, after, delta: committed == null ? null : committed - after, latest: p.high }
  })
}

/** One sentence describing a plan: what moves and how many messages it re-reads or skips. */
export function describePlan(rows: PlanRow[]): string {
  const moved = rows.filter((r) => r.before == null || r.before !== r.after)
  if (moved.length === 0) return 'Nothing changes — the group already reads from these positions.'
  const reread = moved.reduce((s, r) => s + Math.max(0, r.delta ?? 0), 0)
  const skipped = moved.reduce((s, r) => s + Math.max(0, -(r.delta ?? 0)), 0)
  const parts: string[] = [`${moved.length} partition${moved.length === 1 ? '' : 's'} will move`]
  if (reread) parts.push(`${reread.toLocaleString('en-US')} message${reread === 1 ? '' : 's'} will be read again`)
  if (skipped) parts.push(`${skipped.toLocaleString('en-US')} message${skipped === 1 ? '' : 's'} will be skipped`)
  return parts.join(' · ') + '.'
}
