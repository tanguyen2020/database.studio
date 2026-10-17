// Which consumers read the message you are looking at — and have they processed it?
// Pure → unit-testable; the message viewers only fetch the inputs and render this.
//
// Kafka: a consumer group "reads" a topic when it has a committed offset on it. For
// the message's partition, the committed offset is the NEXT offset the group will
// read, so the message is processed when offset < committed.
// NATS JetStream: a consumer reads a subject when one of its filters matches (no
// filter = the whole stream). Its ack floor is the highest stream sequence acked
// contiguously; "delivered" is the highest handed out.
import type { KafkaLag } from '$lib/ipc'

export type ConsumerState = 'processed' | 'in-flight' | 'pending' | 'unknown'

export interface MessageConsumer {
  name: string
  state: ConsumerState
  /** one short line: "committed 15,400 · lag 0", "acked up to #900"… */
  detail: string
}

const n = (v: number) => v.toLocaleString('en-US')

export interface KafkaGroupLag {
  name: string
  state: string
  lag: KafkaLag[]
}

/** Consumer groups of a Kafka topic, and where each stands on one message. */
export function kafkaConsumersFor(topic: string, partition: number, offset: number, groups: KafkaGroupLag[]): MessageConsumer[] {
  const out: MessageConsumer[] = []
  for (const g of groups) {
    const rows = g.lag.filter((l) => l.topic === topic)
    if (!rows.length) continue // this group does not read the topic
    const row = rows.find((l) => l.partition === partition)
    if (!row || row.committed < 0) {
      out.push({ name: g.name, state: 'unknown', detail: `no committed offset on partition ${partition}` })
      continue
    }
    const done = offset < row.committed
    out.push({
      name: g.name,
      state: done ? 'processed' : 'pending',
      detail: done
        ? `committed ${n(row.committed)} · lag ${n(row.lag)}`
        : `${n(offset - row.committed + 1)} behind this message · committed ${n(row.committed)}`,
    })
  }
  return sortConsumers(out)
}

/** NATS subject-filter match: `*` = one token, `>` = one or more trailing tokens. */
export function natsSubjectMatches(filter: string, subject: string): boolean {
  if (!filter) return true
  const f = filter.split('.')
  const s = subject.split('.')
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '>') return s.length > i
    if (i >= s.length) return false
    if (f[i] !== '*' && f[i] !== s[i]) return false
  }
  return f.length === s.length
}

export interface NatsConsumerPos {
  name: string
  filter_subject: string
  filter_subjects?: string[]
  ack_policy: string
  ack_floor_stream_seq?: number
  delivered_stream_seq?: number
}

/** JetStream consumers whose filter covers the subject, and where each stands on `seq`. */
export function natsConsumersFor(subject: string, seq: number, consumers: NatsConsumerPos[]): MessageConsumer[] {
  const out: MessageConsumer[] = []
  for (const c of consumers) {
    const filters = c.filter_subjects?.length ? c.filter_subjects : c.filter_subject ? [c.filter_subject] : []
    if (filters.length && !filters.some((f) => natsSubjectMatches(f, subject))) continue
    const ack = c.ack_floor_stream_seq
    const delivered = c.delivered_stream_seq
    if (ack === undefined || delivered === undefined) {
      out.push({ name: c.name, state: 'unknown', detail: 'position not reported' })
    } else if (seq <= ack) {
      out.push({ name: c.name, state: 'processed', detail: c.ack_policy === 'None' ? `delivered (no acks) up to #${n(delivered)}` : `acked up to #${n(ack)}` })
    } else if (seq <= delivered) {
      out.push({ name: c.name, state: 'in-flight', detail: `delivered, waiting for ack · acked up to #${n(ack)}` })
    } else {
      out.push({ name: c.name, state: 'pending', detail: `not delivered yet · delivered up to #${n(delivered)}` })
    }
  }
  return sortConsumers(out)
}

const ORDER: Record<ConsumerState, number> = { pending: 0, 'in-flight': 1, unknown: 2, processed: 3 }
/** Problems first (pending / in flight), then by name. */
function sortConsumers(list: MessageConsumer[]): MessageConsumer[] {
  return list.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name))
}

// ---- the topic / subject tab: pick a consumer, see each message through its eyes

/** What the two view buttons show: what the consumer has processed, or what it
 *  has not processed yet (pending + in flight). `all` = no filter. */
export type ConsumerView = 'all' | 'processed' | 'unprocessed'

export function inView(state: ConsumerState | 'n/a', view: ConsumerView): boolean {
  if (view === 'all') return true
  if (view === 'processed') return state === 'processed'
  return state === 'pending' || state === 'in-flight'
}

export interface TopicGroup {
  name: string
  state: string
  /** messages still to read on this topic (Σ lag over its partitions) */
  lag: number
  /** partitions of this topic the group has committed on */
  partitions: number
}

/** The consumer groups that read `topic`, with their backlog on it — most behind first. */
export function kafkaTopicGroups(topic: string, groups: KafkaGroupLag[]): TopicGroup[] {
  return groups
    .map((g) => {
      const rows = g.lag.filter((l) => l.topic === topic)
      return { name: g.name, state: g.state, lag: rows.reduce((n, l) => n + Math.max(0, l.lag), 0), partitions: rows.length }
    })
    .filter((g) => g.partitions > 0)
    .sort((a, b) => b.lag - a.lag || a.name.localeCompare(b.name))
}

/** Where one group stands on one message. */
export function kafkaMessageState(group: KafkaGroupLag, topic: string, partition: number, offset: number): ConsumerState {
  const row = group.lag.find((l) => l.topic === topic && l.partition === partition)
  if (!row || row.committed < 0) return 'unknown'
  return offset < row.committed ? 'processed' : 'pending'
}

/** Consumers of a stream that read (some of) a tab's subject — the subject may be a
 *  wildcard (`orders.>`), so a filter counts when either side covers the other. */
export function natsSubjectConsumers<T extends NatsConsumerPos>(subject: string, consumers: T[]): T[] {
  return consumers.filter((c) => {
    const filters = c.filter_subjects?.length ? c.filter_subjects : c.filter_subject ? [c.filter_subject] : []
    return !filters.length || filters.some((f) => f === subject || natsSubjectMatches(f, subject) || natsSubjectMatches(subject, f))
  })
}

/** Where one consumer stands on one message; `n/a` when its filter skips the subject. */
export function natsMessageState(c: NatsConsumerPos, subject: string, seq: number): ConsumerState | 'n/a' {
  const hit = natsConsumersFor(subject, seq, [c])[0]
  return hit ? hit.state : 'n/a'
}
