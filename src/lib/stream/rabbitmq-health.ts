// RabbitMQ cluster health in plain language (SPEC-RABBITMQ-WORKSPACE.md §1, §3b).
// Derived ONLY from what the Management API returned — overview, queues, nodes,
// consumers. Nothing is invented: a value the broker did not report stays unknown.

import type { RabbitConsumer, RabbitNode, RabbitOverview, RabbitQueue } from '$lib/ipc'
import { compactCount, fullCount, percent, plural } from './humanize'

export type Tone = 'ok' | 'warn' | 'bad'

/** A queue that needs a look, with the reason in words and what to do about it. */
export interface QueueAttention {
  queue: string
  tone: Tone
  /** one sentence: why */
  reason: string
  /** short label of the suggested action */
  action: string
  /** sort weight inside a tone (bigger first) */
  weight: number
}

/** In-progress messages per consumer from which a queue is flagged as possibly stuck. */
export const IN_PROGRESS_PER_CONSUMER = 500

const DEAD_LETTER_NAME = /(^|[._-])(dlq|dlx|dead|deadletter|dead-letter|failed|parking|error|errors)([._-]|$)/i

/**
 * A queue that receives failed messages: its name says so (`orders.dlq`,
 * `payments.dead`, `x.failed`…) or another queue dead-letters into it by routing key.
 */
export function isDeadLetterQueue(q: Pick<RabbitQueue, 'name'>, all: Pick<RabbitQueue, 'name' | 'arguments'>[] = []): boolean {
  if (DEAD_LETTER_NAME.test(q.name)) return true
  return all.some((o) => o.name !== q.name && o.arguments?.['x-dead-letter-routing-key'] === q.name)
}

/**
 * Queues needing attention:
 * - dead-letter queue with messages waiting (failed messages piling up);
 * - messages waiting but no consumer to read them;
 * - many messages in progress for few consumers (consumers stuck or slow);
 * - queue not running (down, crashed, stopped).
 * Queues whose counts the broker did not report are never flagged.
 */
export function queueAttention(queues: RabbitQueue[]): QueueAttention[] {
  const out: QueueAttention[] = []
  for (const q of queues) {
    const ready = q.messages_ready
    const unacked = q.messages_unacknowledged
    const consumers = q.consumers
    // 'flow' = briefly throttled by credit flow, 'idle' = older brokers' quiet state — both fine
    if (q.state && q.state !== 'running' && q.state !== 'idle' && q.state !== 'flow') {
      out.push({ queue: q.name, tone: 'bad', reason: `The queue is ${q.state} — it does not accept or deliver messages right now.`, action: 'Open queue', weight: Number.MAX_SAFE_INTEGER })
      continue
    }
    if (ready == null || consumers == null) continue
    if (isDeadLetterQueue(q, queues) && ready > 0) {
      out.push({ queue: q.name, tone: 'warn', reason: `${plural(ready, 'failed message')} waiting in this dead-letter queue.`, action: 'Open queue', weight: ready })
      continue
    }
    if (consumers === 0 && ready > 0) {
      out.push({ queue: q.name, tone: 'warn', reason: `No consumers — ${plural(ready, 'message')} waiting.`, action: 'Open queue', weight: ready })
      continue
    }
    if (consumers > 0 && unacked != null && unacked / consumers >= IN_PROGRESS_PER_CONSUMER) {
      out.push({
        queue: q.name,
        tone: 'warn',
        reason: `${plural(unacked, 'message')} in progress for ${plural(consumers, 'consumer')} — the consumer${consumers === 1 ? ' may be' : 's may be'} stuck or slow.`,
        action: 'See consumers',
        weight: unacked,
      })
    }
  }
  const rank = (t: Tone) => (t === 'bad' ? 0 : t === 'warn' ? 1 : 2)
  return out.sort((a, b) => rank(a.tone) - rank(b.tone) || b.weight - a.weight || a.queue.localeCompare(b.queue))
}

/** Alarms raised by a node, in words. Above the memory limit / below the disk margin
 *  the broker pauses every publisher until it recovers. */
export function nodeAlarms(n: RabbitNode): string[] {
  const out: string[] = []
  if (!n.running) out.push(`${n.name} is not running`)
  if (n.mem_alarm) out.push(`${n.name} is above its memory limit`)
  if (n.disk_free_alarm) out.push(`${n.name} is below its disk safety margin`)
  if (n.partitions.length) out.push(`${n.name} cannot see ${n.partitions.join(', ')} (network partition)`)
  return out
}

export interface ClusterStatus {
  tone: Tone
  headline: string
  detail: string
  /** what the action button opens: a section id */
  actionSection?: string
  actionLabel?: string
}

/** The one-sentence status at the top of Overview (rule U2). */
export function rabbitStatus(overview: RabbitOverview | null, nodes: RabbitNode[] | null, attention: QueueAttention[]): ClusterStatus {
  if (!overview) return { tone: 'warn', headline: 'Broker details are not available', detail: 'The management API did not return its overview.' }
  const alarms = (nodes ?? []).flatMap(nodeAlarms)
  const memOrDisk = (nodes ?? []).some((n) => n.mem_alarm || n.disk_free_alarm)
  if (alarms.length) {
    return {
      tone: 'bad',
      headline: memOrDisk ? 'Publishers are paused' : alarms.length === 1 ? alarms[0] : `${alarms.length} node problems`,
      detail: memOrDisk
        ? `${alarms[0]} — the broker blocks every publisher until it recovers. Free memory or disk space on the node.`
        : `${alarms.join('; ')}.`,
      actionSection: 'nodes',
      actionLabel: 'Show nodes',
    }
  }
  if (attention.length) {
    const first = attention[0]
    return {
      tone: attention.some((a) => a.tone === 'bad') ? 'bad' : 'warn',
      headline: attention.length === 1 ? `Queue ${first.queue} needs attention` : `${attention.length} queues need attention`,
      detail: attention.length === 1 ? first.reason : `${first.queue}: ${first.reason}`,
      actionSection: 'queues',
      actionLabel: 'Show queues',
    }
  }
  const waiting = overview.messages_ready
  return {
    tone: 'ok',
    headline: 'Everything looks healthy',
    detail:
      waiting > 0
        ? `${plural(waiting, 'message')} waiting, and every queue that has messages also has a consumer.`
        : 'No messages are waiting and no node has raised an alarm.',
  }
}

/** "12.4/s"; unknown → "—". */
export function formatRate(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return '—'
  if (r === 0) return '0/s'
  if (r < 10) return `${(Math.round(r * 10) / 10).toString()}/s`
  return `${compactCount(r)}/s`
}

export interface UsageView {
  /** "182 MB of 1.6 GB" */
  label: string
  /** 0..100 share used (memory) or remaining-above-margin (disk); null = unknown */
  pct: number | null
  tone: Tone
}

/**
 * Memory used against the limit: warn from 80 %, bad at the alarm.
 * `fmt` formats bytes (passed in so this stays free of formatting choices).
 */
export function memoryUsage(n: Pick<RabbitNode, 'mem_used' | 'mem_limit' | 'mem_alarm'>, fmt: (b: number) => string): UsageView {
  if (n.mem_used == null || n.mem_limit == null || n.mem_limit <= 0) return { label: 'Not reported', pct: null, tone: 'ok' }
  const pct = Math.min(100, (n.mem_used / n.mem_limit) * 100)
  return {
    label: `${fmt(n.mem_used)} of ${fmt(n.mem_limit)} (${percent(n.mem_used, n.mem_limit)})`,
    pct,
    tone: n.mem_alarm ? 'bad' : pct >= 80 ? 'warn' : 'ok',
  }
}

/** Free disk against the safety margin: warn when less than 2× the margin is left. */
export function diskUsage(n: Pick<RabbitNode, 'disk_free' | 'disk_free_limit' | 'disk_free_alarm'>, fmt: (b: number) => string): UsageView {
  if (n.disk_free == null || n.disk_free_limit == null) return { label: 'Not reported', pct: null, tone: 'ok' }
  const tone: Tone = n.disk_free_alarm ? 'bad' : n.disk_free < n.disk_free_limit * 2 ? 'warn' : 'ok'
  return { label: `${fmt(n.disk_free)} free · margin ${fmt(n.disk_free_limit)}`, pct: null, tone }
}

/** "4 days 3 hours" style uptime, coarse on purpose. */
export function uptimeText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const min = Math.floor(ms / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return `${d} day${d === 1 ? '' : 's'}${h ? ` ${h} h` : ''}`
  if (h > 0) return `${h} h${m ? ` ${m} min` : ''}`
  return `${m} min`
}

/** How a client application is named: its own label, else its library, else the host. */
export function clientLabel(c: { client_name: string; client_product: string; peer_host: string }): string {
  return c.client_name || c.client_product || c.peer_host || 'Unnamed client'
}

/** "Messages held at once" for a consumer (prefetch): 0 = no limit. */
export function prefetchText(n: number | null | undefined): string {
  if (n == null) return '—'
  return n === 0 ? 'No limit' : fullCount(n)
}

/** Consumers of one queue, each joined to its connection's application name. */
export function consumersOf<C extends { client_name: string; client_product: string; peer_host: string; name: string }>(
  queue: string,
  consumers: RabbitConsumer[],
  connections: C[],
): (RabbitConsumer & { app: string; host: string })[] {
  const byName = new Map(connections.map((c) => [c.name, c]))
  return consumers
    .filter((k) => k.queue === queue)
    .map((k) => {
      const c = byName.get(k.connection_name)
      return { ...k, app: c ? clientLabel(c) : k.peer_host || 'Unknown client', host: c?.peer_host || k.peer_host }
    })
}
