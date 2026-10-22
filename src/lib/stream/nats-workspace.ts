// stream-workspace:nats — plain-language wording for the NATS cluster workspace
// (SPEC-NATS-WORKSPACE.md §3b, SPEC-STREAM-SHELL.md §1b). Pure: unit-tested.
// Every helper says what a server value MEANS ("Keep messages for 7 days") and
// never invents a number the server did not report (rule 3).

import type { NatsAccount, NatsJsConsumer, NatsJsStreamFull, NatsKvEntry, NatsKvStatus } from '$lib/ipc'
import { formatBytes, fullCount, humanDuration, plural } from './humanize'

export type Tone = 'ok' | 'warn' | 'bad' | 'info'

/** Streams that only exist to back a key-value bucket (KV_) or an object store (OBJ_). */
export function isSystemStream(name: string): boolean {
  return name.startsWith('KV_') || name.startsWith('OBJ_')
}

/** "1.8 GB of 10 GB" — or "1.8 GB (no limit)" when the account has none. */
export function usedOf(used: number, limit: number | null | undefined): string {
  if (limit == null || limit <= 0) return `${formatBytes(used)} (no limit)`
  return `${formatBytes(used)} of ${formatBytes(limit)}`
}

/** Share of a limit as a tone: ≥ 90 % bad, ≥ 75 % warn, else ok; null when unlimited. */
export function usageTone(used: number, limit: number | null | undefined): 'ok' | 'warn' | 'bad' | null {
  if (limit == null || limit <= 0) return null
  const p = used / limit
  if (p >= 0.9) return 'bad'
  if (p >= 0.75) return 'warn'
  return 'ok'
}

export interface NatsStatus {
  tone: Tone
  headline: string
  detail?: string
}

/** The one-sentence status of the Overview (rule U2): is it fine, what needs attention. */
/**
 * `counts`: what the Streams / Key-value buckets sections show. JetStream counts every
 * key-value bucket as a stream of its own (KV_<bucket>), so the account's stream total
 * is larger than the Streams list — when the lists are known, say both numbers the way
 * the rest of the page does instead of a total that matches nothing on screen.
 */
export function natsStatus(
  account: NatsAccount | null,
  serverVersion: string | null,
  counts?: { streams: number; buckets: number } | null,
): NatsStatus | null {
  if (!account) return null
  const where = serverVersion ? `NATS ${serverVersion}` : 'The server'
  if (!account.enabled) {
    return {
      tone: 'warn',
      headline: 'Persistence (JetStream) is disabled for this account',
      detail: `${where} accepts messages, but streams and key-value buckets are not available. Enable JetStream on the server (start it with -js) or for this account to keep messages.`,
    }
  }
  const disk = usageTone(account.storage, account.max_storage)
  const mem = usageTone(account.memory, account.max_memory)
  const worst = [disk, mem].includes('bad') ? 'bad' : [disk, mem].includes('warn') ? 'warn' : 'ok'
  if (worst !== 'ok') {
    const which = (disk === worst ? 'Disk storage' : 'Memory storage')
    const used = disk === worst ? usedOf(account.storage, account.max_storage) : usedOf(account.memory, account.max_memory)
    return {
      tone: worst,
      headline: `${which} is ${worst === 'bad' ? 'almost full' : 'filling up'}: ${used} used`,
      detail: 'When the limit is reached, streams stop accepting new messages (or drop the oldest, depending on each stream). Clear old messages or raise the account limit.',
    }
  }
  return {
    tone: 'ok',
    headline: `${where} is running and persistence is on`,
    detail: `${counts ? `${plural(counts.streams, 'stream')} · ${plural(counts.buckets, 'key-value bucket')}` : plural(account.streams, 'stream')} · ${plural(account.consumers, 'consumer')} · ${usedOf(account.storage, account.max_storage)} stored on disk.`,
  }
}

/** "Keep messages for 7 days" / "Keep messages forever". */
export function keepFor(maxAgeMs: number | null | undefined): string {
  if (!maxAgeMs) return 'Forever'
  return humanDuration(maxAgeMs)
}

/** "Never" / "30 minutes" — when keys of a bucket expire. */
export function expireAfter(maxAgeMs: number | null | undefined): string {
  if (!maxAgeMs) return 'Never'
  return humanDuration(maxAgeMs)
}

/** "Stored on disk · 3 copies" / "Stored in memory · 1 copy". */
export function storedWords(storage: string | null | undefined, replicas: number | null | undefined): string {
  const where = (storage ?? '').toLowerCase() === 'memory' ? 'Stored in memory' : 'Stored on disk'
  const n = Math.max(1, replicas ?? 1)
  return `${where} · ${plural(n, 'copy', 'copies')}`
}

/** "No limit" for -1 / 0, otherwise "100,000 messages" / "10 GB". */
export function limitWords(v: number | null | undefined, unit: 'messages' | 'bytes' | 'versions'): string {
  if (v == null || v <= 0) return 'No limit'
  if (unit === 'bytes') return formatBytes(v)
  if (unit === 'versions') return plural(v, 'version')
  return plural(v, 'message')
}

/** Retention policy of a stream in words. */
export function retentionWords(retention: string | null | undefined): { label: string; help: string } {
  const r = (retention ?? '').toLowerCase()
  if (r.includes('work')) return { label: 'Until a worker processes them', help: 'Work queue: each message is removed once one consumer acknowledges it.' }
  if (r.includes('interest')) return { label: 'While a consumer still needs them', help: 'Interest: a message is removed once every consumer has acknowledged it.' }
  return { label: 'Until a limit is reached', help: 'Limits: messages stay until the age, count or size limit pushes the oldest out.' }
}

/** What happens when a limit is hit. */
export function discardWords(discard: string | null | undefined): string {
  return (discard ?? '').toLowerCase() === 'new' ? 'Refuse new messages' : 'Drop the oldest messages'
}

/** Consumer delivery start in words. */
export function deliverWords(policy: string | null | undefined): string {
  const p = (policy ?? '').toLowerCase()
  if (p.startsWith('new')) return 'Only new messages'
  if (p.startsWith('last')) return p.includes('subject') ? 'Latest message of each subject' : 'From the latest message'
  if (p.includes('sequence')) return 'From a chosen position'
  if (p.includes('time')) return 'From a chosen time'
  return 'All messages'
}

/** Consumer acknowledgement mode in words. */
export function ackWords(policy: string | null | undefined): string {
  const p = (policy ?? '').toLowerCase()
  if (p === 'none') return 'No acknowledgement'
  if (p === 'all') return 'Acknowledges in batches'
  return 'Acknowledges each message'
}

/** Rows for the Streams table: the user's streams, with KV/OBJ backing streams flagged. */
export interface StreamRow {
  name: string
  subjects: string[]
  messages: number
  bytes: number
  consumers: number
  keepFor: string
  storage: string
  system: boolean
  stream: NatsJsStreamFull
}
export function streamRows(streams: NatsJsStreamFull[]): StreamRow[] {
  return streams.map((s) => ({
    name: s.name,
    subjects: [...new Set(s.subjects)].sort(),
    messages: s.messages,
    bytes: s.bytes,
    consumers: s.consumers,
    keepFor: keepFor(s.max_age_ms),
    storage: storedWords(s.storage, s.replicas),
    system: isSystemStream(s.name),
    stream: s,
  }))
}

/** Config of a stream as label/value pairs (raw config sits behind Advanced). */
export function streamConfigWords(s: NatsJsStreamFull): { label: string; value: string; help?: string }[] {
  const ret = retentionWords(s.retention)
  const out: { label: string; value: string; help?: string }[] = [
    { label: 'Keeps messages', value: ret.label, help: ret.help },
    { label: 'Keep messages for', value: keepFor(s.max_age_ms) },
    { label: 'Most messages kept', value: limitWords(s.max_msgs, 'messages') },
    { label: 'Largest total size', value: limitWords(s.max_bytes, 'bytes') },
    { label: 'Messages kept per subject', value: limitWords(s.max_msgs_per_subject, 'messages') },
    { label: 'Largest single message', value: limitWords(s.max_msg_size, 'bytes') },
    { label: 'When a limit is reached', value: discardWords(s.discard) },
    { label: 'Storage', value: storedWords(s.storage, s.replicas), help: 'Copies are kept on different servers of a cluster.' },
  ]
  if (s.duplicate_window_ms) out.push({ label: 'Ignores duplicates sent within', value: humanDuration(s.duplicate_window_ms), help: 'Messages with the same Nats-Msg-Id inside this window are stored once.' })
  if (s.sealed) out.push({ label: 'Sealed', value: 'Read-only: no messages can be added or removed' })
  return out
}

/** Consumer row for a stream's Consumers tab. */
export interface ConsumerRow {
  name: string
  reads: string
  deliver: string
  ack: string
  waiting: number
  unacked: number
}
export function consumerRows(list: NatsJsConsumer[]): ConsumerRow[] {
  return list.map((c) => {
    const filters = c.filter_subjects?.length ? c.filter_subjects : c.filter_subject ? [c.filter_subject] : []
    return {
      name: c.name,
      reads: filters.length ? filters.join(', ') : 'Every subject',
      deliver: deliverWords(c.deliver_policy),
      ack: ackWords(c.ack_policy),
      waiting: c.num_pending,
      unacked: c.num_ack_pending,
    }
  })
}

// ---- key-value buckets ----

/** "Updated" · "Deleted" · "Cleared" for a version marker (§3b). */
export function changeLabel(op: string): string {
  if (op === 'delete') return 'Deleted'
  if (op === 'purge') return 'Cleared'
  return 'Updated'
}

export function changeTone(op: string): Tone {
  return op === 'put' ? 'ok' : 'warn'
}

export interface BucketRow {
  bucket: string
  keys: number
  history: number
  expire: string
  storage: string
  bytes: number
  status: NatsKvStatus
}
export function bucketRows(list: NatsKvStatus[]): BucketRow[] {
  return list.map((b) => ({
    bucket: b.bucket,
    keys: b.keys,
    history: b.history,
    expire: expireAfter(b.max_age_ms),
    storage: storedWords(b.storage, b.replicas),
    bytes: b.bytes,
    status: b,
  }))
}

/** Bucket settings as words for the bucket header. */
export function bucketWords(b: NatsKvStatus): { label: string; value: string; help?: string }[] {
  return [
    { label: 'Versions kept', value: plural(Math.max(1, b.history), 'version'), help: 'How many earlier values the bucket keeps for each key.' },
    { label: 'Keys expire after', value: expireAfter(b.max_age_ms) },
    { label: 'Storage', value: storedWords(b.storage, b.replicas) },
    { label: 'Size', value: b.max_bytes ? usedOf(b.bytes, b.max_bytes) : formatBytes(b.bytes) },
    { label: 'Largest value', value: limitWords(b.max_value_size, 'bytes') },
  ]
}

export interface KeyRow {
  key: string
  value: string
  revision: number
  created: string
  deleted: boolean
  op: string
}
/** Latest entry per key → table rows; deleted keys are flagged, not dropped. */
export function keyRows(entries: NatsKvEntry[]): KeyRow[] {
  return entries.map((e) => ({
    key: e.key,
    value: e.value,
    revision: e.revision,
    created: e.created,
    deleted: e.operation !== 'put',
    op: e.operation,
  }))
}

/** Apply a live change to the key rows (watch): replace, add, keep sorted. */
export function applyChange(rows: KeyRow[], e: NatsKvEntry): KeyRow[] {
  const next: KeyRow = { key: e.key, value: e.value, revision: e.revision, created: e.created, deleted: e.operation !== 'put', op: e.operation }
  const i = rows.findIndex((r) => r.key === e.key)
  if (i >= 0) {
    if (rows[i].revision > e.revision) return rows // an older event arrived late
    const out = [...rows]
    out[i] = next
    return out
  }
  return [...rows, next].sort((a, b) => a.key.localeCompare(b.key))
}

export interface HistoryRow {
  revision: number
  label: string
  tone: Tone
  value: string
  created: string
  current: boolean
  marker: boolean
}
/** Versions of a key, newest first; the newest one is "Current". */
export function historyRows(entries: NatsKvEntry[]): HistoryRow[] {
  const sorted = [...entries].sort((a, b) => b.revision - a.revision)
  return sorted.map((e, i) => ({
    revision: e.revision,
    label: changeLabel(e.operation),
    tone: changeTone(e.operation),
    value: e.value,
    created: e.created,
    current: i === 0,
    marker: e.operation !== 'put',
  }))
}

/** One-line preview of a value for tables. */
export function preview(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Pretty-print a JSON value for the editor; any other text stays as it is. */
export function prettyValue(value: string): string {
  const t = value.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return value
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return value
  }
}

/** Valid NATS KV key: tokens of [A-Za-z0-9-_=/.] — no spaces, no leading/trailing dot. */
export function validKey(key: string): string | null {
  if (!key) return 'Enter a key.'
  if (/\s/.test(key)) return 'A key cannot contain spaces.'
  if (key.startsWith('.') || key.endsWith('.')) return 'A key cannot start or end with a dot.'
  if (!/^[-/_=.a-zA-Z0-9]+$/.test(key)) return 'Use letters, digits and - _ = / . only.'
  return null
}

/** Valid bucket name: letters, digits, - and _. */
export function validBucket(name: string): string | null {
  if (!name) return 'Enter a bucket name.'
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return 'Use letters, digits, - and _ only.'
  return null
}

/** Consequence sentence for deleting a bucket (rule U8). */
export function deleteBucketText(b: NatsKvStatus): string {
  return `This deletes ${plural(b.keys, 'key')} and ${plural(b.values, 'stored value')} (earlier versions included) from ${b.bucket}. Applications reading this bucket will get errors. This cannot be undone.`
}

/** Consequence sentence for clearing a key's history. */
export function purgeKeyText(key: string, versions: number): string {
  return `This removes ${key} and ${versions === 1 ? 'its stored version' : `all ${fullCount(versions)} stored versions`}. Only a "Cleared" marker remains. This cannot be undone.`
}

