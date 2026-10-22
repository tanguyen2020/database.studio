// Kafka cluster health, derived only from metadata the app already reads
// (`kafka_cluster` + `kafka_topics`) — no new backend call and no invented numbers.
// Used by the Kafka workspace Overview / Brokers sections (SPEC-KAFKA-WORKSPACE.md).

import type { KafkaCluster, KafkaTopic } from '$lib/ipc'

export interface PartitionRef {
  topic: string
  partition: number
}

export interface BrokerStats {
  id: number
  host: string
  port: number
  isController: boolean
  /** partitions this broker leads */
  leads: number
  /** partition copies stored on this broker */
  holds: number
  /** copies on this broker that are not up to date (in replicas, not in ISR) */
  behind: number
}

export interface KafkaHealth {
  brokers: BrokerStats[]
  topicCount: number
  partitionCount: number
  /** partitions with fewer up-to-date copies than configured */
  missingCopies: PartitionRef[]
  /** partitions no broker is serving (no leader) */
  unavailable: PartitionRef[]
  /** total messages kept across user topics; null when any topic's offsets are unknown */
  messages: number | null
  tone: 'ok' | 'warn' | 'bad'
  /** one plain-language line for the top of the Overview (rule U2) */
  headline: string
  detail: string
}

const userTopics = (topics: KafkaTopic[]) => topics.filter((t) => !t.internal)

export function kafkaHealth(cluster: KafkaCluster | null, topics: KafkaTopic[]): KafkaHealth {
  const brokers = new Map<number, BrokerStats>()
  for (const b of cluster?.brokers ?? []) {
    brokers.set(b.id, { id: b.id, host: b.host, port: b.port, isController: b.id === cluster?.controller_id, leads: 0, holds: 0, behind: 0 })
  }
  const missingCopies: PartitionRef[] = []
  const unavailable: PartitionRef[] = []
  let partitionCount = 0
  let messages: number | null = 0

  for (const t of topics) {
    for (const p of t.partitions) {
      partitionCount++
      if (p.leader < 0) unavailable.push({ topic: t.name, partition: p.id })
      else if (p.isr.length < p.replicas.length) missingCopies.push({ topic: t.name, partition: p.id })
      const leader = brokers.get(p.leader)
      if (leader) leader.leads++
      for (const r of p.replicas) {
        const b = brokers.get(r)
        if (!b) continue
        b.holds++
        if (!p.isr.includes(r)) b.behind++
      }
    }
  }
  for (const t of userTopics(topics)) {
    if (t.offsets_known === false) {
      messages = null
      break
    }
    messages! += t.partitions.reduce((s, p) => s + Math.max(0, p.high - p.low), 0)
  }

  let tone: KafkaHealth['tone'] = 'ok'
  let headline = 'Everything looks healthy'
  let detail = 'All partitions have a leader and every copy is up to date.'
  if (unavailable.length > 0) {
    tone = 'bad'
    const topicsHit = new Set(unavailable.map((u) => u.topic))
    headline = `${unavailable.length} partition${unavailable.length === 1 ? ' is' : 's are'} unavailable`
    detail = `No broker is serving ${[...topicsHit].slice(0, 3).join(', ')}${topicsHit.size > 3 ? '…' : ''} — reads and writes to ${unavailable.length === 1 ? 'it' : 'them'} fail until a broker takes over.`
  } else if (missingCopies.length > 0) {
    tone = 'warn'
    const topicsHit = [...new Set(missingCopies.map((m) => m.topic))]
    const where = topicsHit.length === 1 ? ` of ${topicsHit[0]}` : ` in ${topicsHit.length} topics`
    headline = `${missingCopies.length} partition${missingCopies.length === 1 ? '' : 's'}${where} ${missingCopies.length === 1 ? 'has' : 'have'} fewer copies than configured`
    detail = 'Their data is less protected until the lagging broker catches up. Everything else is healthy.'
  }
  if (!cluster) {
    tone = 'warn'
    headline = 'Cluster details are not available'
    detail = 'The broker did not return its metadata.'
  }

  return {
    brokers: [...brokers.values()].sort((a, b) => a.id - b.id),
    topicCount: userTopics(topics).length,
    partitionCount,
    missingCopies,
    unavailable,
    messages,
    tone,
    headline,
    detail,
  }
}

/** Topic-level summary for the Topics table. */
export interface TopicRow {
  name: string
  internal: boolean
  partitions: number
  /** configured copies (largest replica set among its partitions) */
  copies: number
  /** partitions whose copies are all up to date */
  upToDate: number
  /** messages kept now; null = unknown (offsets could not be read) */
  messages: number | null
  offsetsError: string | null
}

export function topicRows(topics: KafkaTopic[]): TopicRow[] {
  return topics.map((t) => ({
    name: t.name,
    internal: t.internal,
    partitions: t.partitions.length,
    copies: t.partitions.reduce((m, p) => Math.max(m, p.replicas.length), 0),
    upToDate: t.partitions.filter((p) => p.leader >= 0 && p.isr.length >= p.replicas.length).length,
    messages: t.offsets_known === false ? null : t.partitions.reduce((s, p) => s + Math.max(0, p.high - p.low), 0),
    offsetsError: t.offsets_error ?? null,
  }))
}
