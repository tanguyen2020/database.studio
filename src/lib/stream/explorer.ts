// Streaming Explorer helpers — turn Kafka topics / NATS JetStream streams into
// the rows the Object Explorer renders. Pure → unit-testable (the component only
// does IPC + rendering).
import type { KafkaTopic, NatsJsStream } from '$lib/ipc'

export interface TopicRow {
  name: string
  internal: boolean
  partitions: number
  /** total messages across partitions (Σ high − low) */
  messages: number
  meta: string
}

/** Messages currently retained in a topic = Σ(high − low) over partitions. */
export function topicMessageCount(t: KafkaTopic): number {
  return t.partitions.reduce((sum, p) => sum + Math.max(0, p.high - p.low), 0)
}

/** Kafka topic rows: internal (`__…`) topics hidden unless asked, sorted by name. */
export function kafkaTopicRows(topics: KafkaTopic[], showInternal = false): TopicRow[] {
  return topics
    .filter((t) => showInternal || !t.internal)
    .map((t) => {
      const messages = topicMessageCount(t)
      const parts = t.partitions.length
      return {
        name: t.name,
        internal: t.internal,
        partitions: parts,
        messages,
        meta: `${parts} part · ${messages} msg`,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
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
