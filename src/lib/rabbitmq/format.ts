// RabbitMQ helpers shared by the explorer tree and the queue / exchange tabs.
// Pure (no IPC, no DOM) so they are unit-tested on their own.

import type { RabbitExchange, RabbitMessage, RabbitQueue } from '$lib/ipc'

/** The nameless default exchange as people know it from the management UI. */
export const DEFAULT_EXCHANGE_LABEL = '(AMQP default)'

export const EXCHANGE_TYPES = ['direct', 'fanout', 'topic', 'headers'] as const
export const QUEUE_TYPES = ['classic', 'quorum', 'stream'] as const

export function exchangeLabel(name: string): string {
  return name === '' ? DEFAULT_EXCHANGE_LABEL : name
}

/** The default exchange and every `amq.*` exchange are created by the broker and
 *  cannot be deleted (the API refuses with 403). */
export function isBuiltinExchange(name: string): boolean {
  return name === '' || name.startsWith('amq.')
}

/** One-letter badge per queue type: Classic / Quorum / Stream. */
export function queueTypeBadge(type: string): string {
  if (type === 'quorum') return 'Q'
  if (type === 'stream') return 'S'
  return 'C'
}

/** Meta shown next to a queue in the tree. `null` counts mean the broker has not
 *  reported stats yet — say "?" rather than invent a 0. */
export function queueMeta(q: Pick<RabbitQueue, 'messages' | 'consumers'>): string {
  const msgs = q.messages == null ? '?' : q.messages.toLocaleString('en-US')
  const parts = [`${msgs} msg`]
  if (q.consumers) parts.push(`${q.consumers} cons`)
  return parts.join(' · ')
}

/** Case-insensitive substring filter on names (empty query keeps everything). */
export function filterByName<T>(items: T[], query: string, name: (t: T) => string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((t) => name(t).toLowerCase().includes(q))
}

export function sortExchanges(list: RabbitExchange[]): RabbitExchange[] {
  // default exchange first, then user exchanges, then the amq.* built-ins
  const rank = (e: RabbitExchange) => (e.name === '' ? 0 : e.name.startsWith('amq.') ? 2 : 1)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** Decode a base64 payload to text when it is valid UTF-8; otherwise null. */
function decodeBase64Utf8(b64: string): string | null {
  try {
    const bin = atob(b64)
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export interface PayloadView {
  /** text to show (pretty JSON when it parses) */
  text: string
  isJson: boolean
  /** true when the broker sent base64 and it is not readable text */
  binary: boolean
}

/** What the payload viewer shows for a message: JSON pretty-printed, text as-is,
 *  binary as its base64 (the management API sends non-UTF-8 bodies base64). */
export function payloadView(m: Pick<RabbitMessage, 'payload' | 'payload_encoding'>): PayloadView {
  let text = m.payload
  if (m.payload_encoding === 'base64') {
    const decoded = decodeBase64Utf8(m.payload)
    if (decoded == null) return { text: m.payload, isJson: false, binary: true }
    text = decoded
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      return { text: JSON.stringify(parsed, null, 2), isJson: true, binary: false }
    }
  } catch {
    // not JSON — show the text as it is
  }
  return { text, isJson: false, binary: false }
}

/** Single-line preview for the grid. */
export function payloadPreview(m: Pick<RabbitMessage, 'payload' | 'payload_encoding'>, max = 160): string {
  const v = payloadView(m)
  if (v.binary) return `(binary · base64) ${m.payload.slice(0, max)}`
  const flat = v.isJson ? JSON.stringify(JSON.parse(v.text)) : v.text.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export interface PublishInput {
  contentType: string
  persistent: boolean
  /** JSON object text; empty = no headers */
  headers: string
}

/** AMQP basic properties for the publish API. Throws a readable error when the
 *  headers are not a JSON object (instead of sending something the broker rejects). */
export function buildProperties(input: PublishInput): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  if (input.contentType.trim()) props.content_type = input.contentType.trim()
  props.delivery_mode = input.persistent ? 2 : 1
  const h = input.headers.trim()
  if (h) {
    let parsed: unknown
    try {
      parsed = JSON.parse(h)
    } catch (e) {
      throw new Error(`Headers must be a JSON object — ${(e as Error).message}`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Headers must be a JSON object, e.g. {"source": "studio"}')
    }
    props.headers = parsed
  }
  return props
}

/** Human size of a payload. */
export function formatPayloadBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
