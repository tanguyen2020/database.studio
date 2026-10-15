// "Add a new queue" / "Add a new exchange" arguments, as the RabbitMQ management
// UI offers them: typed key = value rows plus quick "Add" links per queue type.
// Pure — shared by the create dialog and its unit tests.

export type ArgType = 'string' | 'number' | 'boolean' | 'list'

export interface ArgRow {
  key: string
  value: string
  type: ArgType
}

export interface ArgHelper {
  /** link text, as in the management UI */
  label: string
  key: string
  type: ArgType
  hint: string
}

const H = {
  autoExpire: { label: 'Auto expire', key: 'x-expires', type: 'number', hint: 'How long a queue can be unused for before it is automatically deleted (milliseconds).' },
  messageTtl: { label: 'Message TTL', key: 'x-message-ttl', type: 'number', hint: 'How long a message published to a queue can live before it is discarded (milliseconds).' },
  overflow: { label: 'Overflow behaviour', key: 'x-overflow', type: 'string', hint: 'What happens when the queue is full: drop-head, reject-publish or reject-publish-dlx.' },
  singleActive: { label: 'Single active consumer', key: 'x-single-active-consumer', type: 'boolean', hint: 'Only one consumer at a time consumes from the queue; the others take over if it goes away.' },
  dlx: { label: 'Dead letter exchange', key: 'x-dead-letter-exchange', type: 'string', hint: 'Exchange to which rejected or expired messages are republished.' },
  dlrk: { label: 'Dead letter routing key', key: 'x-dead-letter-routing-key', type: 'string', hint: 'Replacement routing key used when a message is dead-lettered (the original one is kept otherwise).' },
  maxLength: { label: 'Max length', key: 'x-max-length', type: 'number', hint: 'How many (ready) messages the queue can hold before it starts to drop them from its head.' },
  maxLengthBytes: { label: 'Max length bytes', key: 'x-max-length-bytes', type: 'number', hint: 'Total body size of ready messages the queue can hold before it starts to drop them from its head.' },
  maxPriority: { label: 'Maximum priority', key: 'x-max-priority', type: 'number', hint: 'Maximum number of priority levels for the queue to support (1–255).' },
  version: { label: 'Version', key: 'x-queue-version', type: 'number', hint: 'Classic queue storage version: 1 or 2.' },
  leaderLocator: { label: 'Leader locator', key: 'x-queue-leader-locator', type: 'string', hint: 'Where the queue leader is placed when declared: client-local or balanced.' },
  deliveryLimit: { label: 'Delivery limit', key: 'x-delivery-limit', type: 'number', hint: 'Number of allowed unsuccessful delivery attempts before the message is dropped or dead-lettered.' },
  initialGroup: { label: 'Initial cluster size', key: 'x-quorum-initial-group-size', type: 'number', hint: 'Initial number of replicas (cluster members) for the queue.' },
  targetGroup: { label: 'Target cluster size', key: 'x-quorum-target-group-size', type: 'number', hint: 'Number of replicas the queue should keep growing back to.' },
  dlStrategy: { label: 'Dead letter strategy', key: 'x-dead-letter-strategy', type: 'string', hint: 'at-most-once (default) or at-least-once (needs overflow reject-publish).' },
  maxAge: { label: 'Max time retention', key: 'x-max-age', type: 'string', hint: 'How long a stream keeps messages, e.g. 7D, 12h, 30m (Y M D h m s).' },
  segment: { label: 'Max segment size in bytes', key: 'x-stream-max-segment-size-bytes', type: 'number', hint: 'Size of a stream segment file on disk.' },
  filterSize: { label: 'Filter size (bytes)', key: 'x-stream-filter-size-bytes', type: 'number', hint: 'Size of the Bloom filter used for stream filtering (16–255).' },
  alternateExchange: { label: 'Alternate exchange', key: 'alternate-exchange', type: 'string', hint: 'Messages this exchange cannot route are sent to this exchange instead.' },
} satisfies Record<string, ArgHelper>

/** Queue types the form offers ('' = "Default for virtual host"). */
export const QUEUE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Default for virtual host' },
  { value: 'classic', label: 'Classic' },
  { value: 'quorum', label: 'Quorum' },
  { value: 'stream', label: 'Stream' },
]

/** Quick "Add" links per queue type (same sets as the management UI). */
export function queueArgHelpers(queueType: string): ArgHelper[] {
  if (queueType === 'quorum') {
    return [H.autoExpire, H.messageTtl, H.overflow, H.singleActive, H.dlx, H.dlrk, H.maxLength, H.maxLengthBytes, H.deliveryLimit, H.initialGroup, H.targetGroup, H.dlStrategy, H.leaderLocator]
  }
  if (queueType === 'stream') return [H.maxLengthBytes, H.maxAge, H.segment, H.filterSize, H.initialGroup, H.leaderLocator]
  return [H.autoExpire, H.messageTtl, H.overflow, H.singleActive, H.dlx, H.dlrk, H.maxLength, H.maxLengthBytes, H.maxPriority, H.version, H.leaderLocator]
}

export const EXCHANGE_ARG_HELPERS: ArgHelper[] = [H.alternateExchange]

/** Quorum and stream queues are always durable and never auto-delete — the UI hides both rows. */
export function hasDurabilityChoice(queueType: string): boolean {
  return queueType !== 'quorum' && queueType !== 'stream'
}

export const emptyRow = (): ArgRow => ({ key: '', value: '', type: 'string' })

/** Keep exactly one blank row at the end (the UI adds a new row as you type). */
export function withTrailingEmpty(rows: ArgRow[]): ArgRow[] {
  const isBlank = (r: ArgRow) => !r.key.trim() && !r.value.trim()
  const out = [...rows]
  while (out.length > 1 && isBlank(out[out.length - 1]) && isBlank(out[out.length - 2])) out.pop()
  if (!out.length || !isBlank(out[out.length - 1])) out.push(emptyRow())
  return out
}

/** Apply a quick-add link: reuse the key's row when present, else fill the first blank row. */
export function addHelper(rows: ArgRow[], h: ArgHelper): ArgRow[] {
  if (rows.some((r) => r.key.trim() === h.key)) return rows
  const out = [...rows]
  const blank = out.findIndex((r) => !r.key.trim() && !r.value.trim())
  const row: ArgRow = { key: h.key, value: h.type === 'boolean' ? 'true' : '', type: h.type }
  if (blank >= 0) out[blank] = row
  else out.push(row)
  return withTrailingEmpty(out)
}

export type ParsedArgs = { ok: true; args: Record<string, unknown> } | { ok: false; error: string }

/** Rows → typed arguments object, or the first problem in plain words. */
export function parseArgs(rows: ArgRow[]): ParsedArgs {
  const args: Record<string, unknown> = {}
  for (const r of rows) {
    const key = r.key.trim()
    const raw = r.value.trim()
    if (!key && !raw) continue
    if (!key) return { ok: false, error: `The argument with value "${raw}" needs a name` }
    if (key in args) return { ok: false, error: `Argument ${key} is given twice` }
    switch (r.type) {
      case 'number': {
        const n = Number(raw)
        if (raw === '' || !Number.isFinite(n)) return { ok: false, error: `${key} must be a number` }
        args[key] = n
        break
      }
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') return { ok: false, error: `${key} must be true or false` }
        args[key] = raw === 'true'
        break
      case 'list':
        args[key] = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        break
      default:
        args[key] = r.value
    }
  }
  return { ok: true, args }
}

// ---- optional bindings in "Add a new queue" -------------------------------------------

export interface BindRow {
  /** source exchange ('' = not chosen yet) */
  exchange: string
  routingKey: string
}

/** Whether the exchange type looks at the routing key at all. */
export function usesRoutingKey(exchangeType: string): boolean {
  return exchangeType !== 'fanout' && exchangeType !== 'headers'
}

/** One-line guide shown under a binding row, per exchange type. */
export function routingKeyHint(exchangeType: string): string {
  if (exchangeType === 'topic') return 'topic: words separated by dots — * matches one word, # matches zero or more (e.g. order.*.eu, audit.#)'
  if (exchangeType === 'direct') return 'direct: the message routing key must match exactly'
  if (exchangeType === 'fanout') return 'fanout: every message is delivered — the routing key is ignored'
  if (exchangeType === 'headers') return 'headers: matching is on message headers — the routing key is ignored'
  return ''
}

/** Rows → the bindings to create: rows without an exchange are skipped, the key is
 *  dropped where the exchange type ignores it, exact duplicates collapse. */
export function planBindings(rows: BindRow[], typeOf: (exchange: string) => string | undefined): { exchange: string; routingKey: string }[] {
  const out: { exchange: string; routingKey: string }[] = []
  for (const r of rows) {
    if (!r.exchange) continue
    const key = usesRoutingKey(typeOf(r.exchange) ?? 'direct') ? r.routingKey.trim() : ''
    if (!out.some((b) => b.exchange === r.exchange && b.routingKey === key)) out.push({ exchange: r.exchange, routingKey: key })
  }
  return out
}
