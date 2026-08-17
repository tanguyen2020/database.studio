// Streaming Explorer helpers — turn Kafka topics / NATS JetStream streams into
// the rows the Object Explorer renders. Pure → unit-testable (the component only
// does IPC + rendering).
import type { KafkaTopic, NatsJsStream } from '$lib/ipc'

export interface TopicRow {
  name: string
  internal: boolean
  partitions: number
  /** total messages across partitions (Σ high − low); −1 when the offsets are unknown */
  messages: number
  meta: string
  /** why the broker did not report offsets — shown as a tooltip on "? msg" */
  offsetsError?: string
}

/** Messages currently retained in a topic = Σ(high − low) over partitions. */
export function topicMessageCount(t: KafkaTopic): number {
  return t.partitions.reduce((sum, p) => sum + Math.max(0, p.high - p.low), 0)
}

/**
 * Kafka topic rows: internal (`__…`) topics hidden unless asked, sorted by name.
 *
 * A topic whose offsets the broker did not report (`offsets_known === false`) shows
 * "? msg", never "0 msg" — claiming zero for a topic that is actually full is worse
 * than admitting the count is unknown.
 */
export function kafkaTopicRows(topics: KafkaTopic[], showInternal = false): TopicRow[] {
  return topics
    .filter((t) => showInternal || !t.internal)
    .map((t) => {
      const known = t.offsets_known !== false // older payloads had no flag → assume known
      const messages = known ? topicMessageCount(t) : -1
      const parts = t.partitions.length
      return {
        name: t.name,
        internal: t.internal,
        partitions: parts,
        messages,
        meta: `${parts} part · ${known ? messages : '?'} msg`,
        offsetsError: known ? undefined : (t.offsets_error ?? 'the broker did not report offsets'),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Filter Kafka topic rows by name (case-insensitive substring). A blank query
 * returns the rows unchanged.
 */
export function filterTopicRows(query: string, rows: TopicRow[]): TopicRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return rows
  return rows.filter((t) => t.name.toLowerCase().includes(q))
}

export interface ConsumerEmptyState {
  /** a bounded page read is in flight */
  loading: boolean
  /** live tail is running (Consume pressed) */
  tailing: boolean
  /** the read finished: a page came back, or every partition reported end-of-log */
  atEnd: boolean
  /** at least one record arrived since this browse started */
  receivedAny: boolean
  /** librdkafka surfaced an error for this browse */
  hasError: boolean
  /**
   * Σ(high − low) over the browsed partitions, straight from the broker's watermarks
   * (`kafka-eof` payload). This — NOT "we received nothing" — is what decides whether
   * the topic is really empty. Negative = unknown (never claim empty then).
   */
  retained: number
}

/**
 * What the consumer grid says when it has no rows. Kafka can't tell "empty topic"
 * from "still fetching" by silence alone — only PartitionEOF does, so an empty grid
 * used to claim "Waiting for messages…" forever on a topic that simply has none.
 *
 * Reading nothing is NOT proof the topic is empty: the window being browsed may hold
 * no readable record (log compaction, transaction control records) while the topic is
 * still full. Only the watermark count may claim "no messages".
 */
export function consumerEmptyText(s: ConsumerEmptyState): string {
  if (s.hasError) return 'Could not read messages — see the error above.'
  if (s.loading) return 'Reading messages…'
  if (!s.atEnd) return s.tailing ? 'Waiting for messages…' : 'Reading messages…'
  // only an explicit zero from the broker proves "empty"; negative means unknown
  if (s.retained === 0) return 'This topic has no messages.'
  if (s.receivedAny || s.retained < 0) return 'No messages to show — reached the end of the topic.'
  // the broker says the topic holds records, but none landed in the window that was read
  const n = s.retained.toLocaleString()
  return `No messages in the page read — this topic holds ${n}. Use “Older” to page back.`
}

export interface SubjectRow {
  subject: string
}

export interface StreamRow {
  name: string
  subjects: SubjectRow[]
  messages: number
  meta: string
}

/**
 * Filter NATS stream rows by stream name only (case-insensitive substring); a
 * matching stream keeps all its subjects. A blank query returns the rows as-is.
 */
export function filterStreamRows(query: string, rows: StreamRow[]): StreamRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return rows
  return rows.filter((s) => s.name.toLowerCase().includes(q))
}

/** NATS JetStream rows: stream → its configured subjects (deduped, sorted). */
export function natsStreamRows(streams: NatsJsStream[]): StreamRow[] {
  return streams
    .map((s) => {
      const subjects = [...new Set(s.subjects)].sort().map((subject) => ({ subject }))
      return {
        name: s.name,
        subjects,
        messages: s.messages,
        meta: `${subjects.length} subj · ${s.messages} msg`,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
