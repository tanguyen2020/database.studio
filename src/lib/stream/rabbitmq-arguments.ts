// Queue / exchange arguments as sentences a person can read (rule U3,
// SPEC-RABBITMQ-WORKSPACE.md §3b). The raw `x-*` table stays available behind
// "Advanced"; this is the default view.

import { formatBytes, fullCount, humanDuration } from './humanize'

export interface ArgumentSentence {
  /** the raw argument name, shown only under Advanced / as a tooltip */
  key: string
  text: string
  /** an exchange the sentence links to (dead-letter / alternate exchange) */
  exchange?: string
  /** a queue the sentence links to (dead-letter routing straight to a queue) */
  queue?: string
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Stream retention ("7D", "12h", "30m", "90s", "1Y") → words. */
export function streamAge(v: string): string | null {
  const m = /^(\d+)\s*([YMDhms])$/.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit: Record<string, [string, string]> = {
    Y: ['year', 'years'],
    M: ['month', 'months'],
    D: ['day', 'days'],
    h: ['hour', 'hours'],
    m: ['minute', 'minutes'],
    s: ['second', 'seconds'],
  }
  const [one, many] = unit[m[2]]
  return `${n} ${n === 1 ? one : many}`
}

const OVERFLOW: Record<string, string> = {
  'drop-head': 'the oldest messages are dropped to make room',
  'reject-publish': 'new messages are refused',
  'reject-publish-dlx': 'new messages are refused and sent to the dead-letter exchange',
}

const SKIP = new Set(['x-queue-type'])

/**
 * One sentence per argument. Known `x-*` keys get a plain explanation; anything
 * else is listed as a custom setting with its value (never hidden).
 */
export function describeArguments(args: Record<string, unknown> | null | undefined): ArgumentSentence[] {
  if (!args) return []
  const out: ArgumentSentence[] = []
  const overflow = typeof args['x-overflow'] === 'string' ? OVERFLOW[args['x-overflow'] as string] : undefined
  for (const [key, value] of Object.entries(args)) {
    if (SKIP.has(key)) continue
    const n = num(value)
    switch (key) {
      case 'x-message-ttl':
        out.push({ key, text: n == null ? `Messages expire after ${String(value)}` : `Messages expire after ${humanDuration(n)}` })
        break
      case 'x-expires':
        out.push({ key, text: n == null ? `The queue is deleted when unused for ${String(value)}` : `The queue is deleted when unused for ${humanDuration(n)}` })
        break
      case 'x-dead-letter-exchange': {
        const ex = String(value ?? '')
        const rk = args['x-dead-letter-routing-key']
        if (ex === '' && typeof rk === 'string') out.push({ key, text: 'Failed messages go to queue', queue: rk })
        else out.push({ key, text: 'Failed messages go to', exchange: ex })
        break
      }
      case 'x-dead-letter-routing-key':
        if (args['x-dead-letter-exchange'] === '') break // already said as "go to queue …"
        out.push({ key, text: `Failed messages keep the routing key “${String(value)}”` })
        break
      case 'x-delivery-limit':
        out.push({ key, text: n == null ? `Delivery limit: ${String(value)}` : `Max ${fullCount(n)} delivery attempt${n === 1 ? '' : 's'}, then the message counts as failed` })
        break
      case 'x-max-length':
        out.push({ key, text: `Keeps at most ${n == null ? String(value) : fullCount(n)} message${n === 1 ? '' : 's'}${overflow ? ` — when full, ${overflow}` : ' — when full, the oldest messages are dropped'}` })
        break
      case 'x-max-length-bytes':
        out.push({ key, text: `Keeps at most ${n == null ? String(value) : formatBytes(n)} of messages${overflow ? ` — when full, ${overflow}` : ''}` })
        break
      case 'x-overflow':
        if (!('x-max-length' in args) && !('x-max-length-bytes' in args)) {
          out.push({ key, text: `When a length limit is reached, ${OVERFLOW[String(value)] ?? String(value)}` })
        }
        break
      case 'x-max-priority':
        out.push({ key, text: `Supports message priorities 0–${n == null ? String(value) : n}` })
        break
      case 'x-single-active-consumer':
        out.push({ key, text: value === true || value === 'true' ? 'Only one consumer receives messages at a time (the others wait as backups)' : 'Every consumer receives messages' })
        break
      case 'x-queue-mode':
        out.push({ key, text: value === 'lazy' ? 'Keeps messages on disk instead of in memory' : `Queue mode: ${String(value)}` })
        break
      case 'x-queue-version':
        out.push({ key, text: `Storage format version ${String(value)}` })
        break
      case 'x-max-age': {
        const age = typeof value === 'string' ? streamAge(value) : null
        out.push({ key, text: `Keeps messages for ${age ?? String(value)}` })
        break
      }
      case 'x-stream-max-segment-size-bytes':
        out.push({ key, text: `Stored in files of up to ${n == null ? String(value) : formatBytes(n)}` })
        break
      case 'x-initial-cluster-size':
      case 'x-quorum-initial-group-size':
        out.push({ key, text: `Starts with ${n == null ? String(value) : fullCount(n)} cop${n === 1 ? 'y' : 'ies'} across nodes` })
        break
      case 'x-queue-leader-locator':
        out.push({ key, text: `New leader placed on ${value === 'balanced' ? 'the least busy node' : 'the node the client is connected to'}` })
        break
      case 'x-dead-letter-strategy':
        out.push({ key, text: value === 'at-least-once' ? 'Failed messages are dead-lettered safely (never lost on the way)' : 'Failed messages are dead-lettered at most once' })
        break
      case 'alternate-exchange':
        out.push({ key, text: 'Messages no binding matches go to', exchange: String(value ?? '') })
        break
      default:
        out.push({ key, text: `Custom setting ${key} = ${typeof value === 'string' ? value : JSON.stringify(value)}` })
    }
  }
  return out
}

/** Plain-language feature chips for a queue (rule U1: a full word + one sentence). */
export function queueFeatures(q: { durable: boolean; auto_delete: boolean; exclusive: boolean }): { label: string; help: string }[] {
  const out: { label: string; help: string }[] = []
  if (q.durable) out.push({ label: 'Durable', help: 'Survives a broker restart.' })
  else out.push({ label: 'Temporary', help: 'Lost when the broker restarts.' })
  if (q.auto_delete) out.push({ label: 'Auto-delete', help: 'Deleted when its last consumer disconnects.' })
  if (q.exclusive) out.push({ label: 'Exclusive', help: 'Only the connection that created it can use it; deleted when that connection closes.' })
  return out
}

/** What each queue type means, in one sentence. */
export function queueTypeHelp(type: string): string {
  if (type === 'quorum') return 'Quorum queue — copied to several nodes, safe if one node fails.'
  if (type === 'stream') return 'Stream — an append-only log; consumers can re-read from any point.'
  return 'Classic queue — stored on one node.'
}

export interface CreatePreviewInput {
  kind: 'queue' | 'exchange'
  vhost: string
  name: string
  /** queue: '' = the vhost's default type */
  queueType?: string
  exchangeType?: string
  durable: boolean
  autoDelete: boolean
  internal?: boolean
  args: Record<string, unknown>
  binds?: { exchange: string; routingKey: string }[]
}

/**
 * "What will be created", in sentences, shown in the create form before Add (rule U9):
 * the object and where, how it survives restarts, every argument in words, and the
 * bindings that will route messages into it.
 */
export function createPreview(p: CreatePreviewInput): string[] {
  const name = p.name.trim()
  if (!name) return []
  const out: string[] = []
  if (p.kind === 'queue') {
    const replicated = p.queueType === 'quorum' || p.queueType === 'stream'
    const type = p.queueType ? queueTypeLabel(p.queueType).toLowerCase() : 'default-type'
    const life = replicated ? 'durable' : p.durable ? 'durable' : 'temporary'
    out.push(`A ${life} ${type} ${p.queueType === 'stream' ? 'stream' : 'queue'} “${name}” in virtual host ${p.vhost}.`)
    if (!replicated && p.autoDelete) out.push('It deletes itself once its last consumer disconnects.')
    for (const s of describeArguments(p.args)) out.push(sentenceText(s))
    const binds = p.binds ?? []
    if (binds.length === 0) out.push('Messages reach it only when published to it by name (no bindings).')
    for (const b of binds) out.push(b.routingKey ? `Receives messages from ${b.exchange} whose routing key matches “${b.routingKey}”.` : `Receives every message routed by ${b.exchange}.`)
  } else {
    out.push(`A ${p.durable ? 'durable' : 'temporary'} ${p.exchangeType ?? 'direct'} exchange “${name}” in virtual host ${p.vhost}.`)
    if (p.autoDelete) out.push('It deletes itself once its last binding is removed.')
    if (p.internal) out.push('Internal: clients cannot publish to it directly.')
    for (const s of describeArguments(p.args)) out.push(sentenceText(s))
    out.push('It routes nothing until a queue is bound to it.')
  }
  return out
}

function sentenceText(s: ArgumentSentence): string {
  if (s.exchange != null) return `${s.text} ${s.exchange || '(AMQP default)'}.`
  if (s.queue != null) return `${s.text} ${s.queue}.`
  return `${s.text}.`
}

export function queueTypeLabel(type: string): string {
  if (type === 'quorum') return 'Quorum'
  if (type === 'stream') return 'Stream'
  return 'Classic'
}
