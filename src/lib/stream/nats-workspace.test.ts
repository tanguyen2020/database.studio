import { beforeEach, describe, expect, it } from 'vitest'
import type { NatsAccount, NatsJsStreamFull, NatsKvEntry, NatsKvStatus } from '$lib/ipc'
import {
  ackWords,
  applyChange,
  bucketRows,
  bucketWords,
  changeLabel,
  consumerRows,
  deleteBucketText,
  deliverWords,
  discardWords,
  expireAfter,
  historyRows,
  isSystemStream,
  keepFor,
  keyRows,
  limitWords,
  natsStatus,
  prettyValue,
  preview,
  purgeKeyText,
  retentionWords,
  storedWords,
  streamConfigWords,
  streamRows,
  usageTone,
  usedOf,
  validBucket,
  validKey,
} from './nats-workspace'
import { natsDemoAccount, natsKvDemo, natsKvDemoReset, natsKvDemoSubscribe } from './nats-kv-demo'

const GB = 1024 ** 3
const account = (over: Partial<NatsAccount> = {}): NatsAccount => ({
  enabled: true,
  reason: null,
  memory: 0,
  storage: 1.8 * GB,
  streams: 4,
  consumers: 6,
  max_memory: null,
  max_storage: 10 * GB,
  max_streams: null,
  max_consumers: null,
  domain: null,
  api_total: 0,
  api_errors: 0,
  ...over,
})

describe('NATS overview wording', () => {
  it('states persistence on with storage used of the limit', () => {
    const s = natsStatus(account(), '2.10.14')!
    expect(s.tone).toBe('ok')
    expect(s.headline).toBe('NATS 2.10.14 is running and persistence is on')
    expect(s.detail).toContain('4 streams')
    expect(s.detail).toContain('6 consumers')
    expect(s.detail).toContain('1.8 GB of 10 GB')
    // with the on-screen lists known, the totals match the Streams + buckets sections
    // (the account counts each bucket as one more stream)
    const both = natsStatus(account(), '2.10.14', { streams: 2, buckets: 2 })!
    expect(both.detail).toContain('2 streams · 2 key-value buckets · 6 consumers')
    expect(both.detail).not.toContain('4 streams')
  })

  it('says what to do when JetStream is off', () => {
    const s = natsStatus(account({ enabled: false, reason: 'jetstream not enabled' }), null)!
    expect(s.tone).toBe('warn')
    expect(s.headline).toMatch(/Persistence \(JetStream\) is disabled/)
    expect(s.detail).toMatch(/-js/)
  })

  it('warns as storage fills up and is red when almost full', () => {
    expect(natsStatus(account({ storage: 8 * GB }), null)!.tone).toBe('warn')
    const full = natsStatus(account({ storage: 9.5 * GB }), null)!
    expect(full.tone).toBe('bad')
    expect(full.headline).toMatch(/Disk storage is almost full/)
    expect(usageTone(1, null)).toBeNull()
    expect(usedOf(1024, null)).toBe('1 KB (no limit)')
  })
})

describe('stream wording', () => {
  const stream: NatsJsStreamFull = {
    name: 'ORDERS',
    subjects: ['orders.us', 'orders.eu', 'orders.eu'],
    retention: 'WorkQueue',
    storage: 'Memory',
    messages: 1240,
    bytes: 98304,
    consumers: 2,
    max_age_ms: 7 * 86_400_000,
    max_msgs: -1,
    max_bytes: 10 * GB,
    max_msgs_per_subject: -1,
    max_msg_size: -1,
    replicas: 3,
    discard: 'new',
    duplicate_window_ms: 120_000,
  }

  it('reads limits and storage in words', () => {
    expect(keepFor(0)).toBe('Forever')
    expect(keepFor(7 * 86_400_000)).toBe('7 days')
    expect(storedWords('Memory', 3)).toBe('Stored in memory · 3 copies')
    expect(storedWords('file', 1)).toBe('Stored on disk · 1 copy')
    expect(limitWords(-1, 'messages')).toBe('No limit')
    expect(limitWords(100_000, 'messages')).toBe('100,000 messages')
    expect(limitWords(10 * GB, 'bytes')).toBe('10 GB')
    expect(retentionWords('WorkQueue').label).toBe('Until a worker processes them')
    expect(retentionWords('Limits').label).toBe('Until a limit is reached')
    expect(discardWords('new')).toBe('Refuse new messages')
    expect(discardWords('old')).toBe('Drop the oldest messages')
  })

  it('builds rows with deduped subjects and flags KV/OBJ backing streams', () => {
    const [r] = streamRows([stream])
    expect(r.subjects).toEqual(['orders.eu', 'orders.us'])
    expect(r.keepFor).toBe('7 days')
    expect(r.system).toBe(false)
    expect(isSystemStream('KV_config')).toBe(true)
    expect(isSystemStream('OBJ_uploads')).toBe(true)
  })

  it('lists config in words, with no raw keys', () => {
    const words = streamConfigWords(stream)
    const byLabel = Object.fromEntries(words.map((w) => [w.label, w.value]))
    expect(byLabel['Keep messages for']).toBe('7 days')
    expect(byLabel['Most messages kept']).toBe('No limit')
    expect(byLabel['When a limit is reached']).toBe('Refuse new messages')
    expect(byLabel['Ignores duplicates sent within']).toBe('2 minutes')
    expect(words.every((w) => !/max_|retention|_ms/.test(w.label))).toBe(true)
  })

  it('describes consumers', () => {
    const [c] = consumerRows([{ name: 'audit', deliver_policy: 'New', ack_policy: 'None', filter_subject: '', num_pending: 3, num_ack_pending: 1 }])
    expect(c.reads).toBe('Every subject')
    expect(c.deliver).toBe('Only new messages')
    expect(c.ack).toBe('No acknowledgement')
    expect(deliverWords('All')).toBe('All messages')
    expect(deliverWords('LastPerSubject')).toBe('Latest message of each subject')
    expect(ackWords('Explicit')).toBe('Acknowledges each message')
  })
})

describe('key-value wording + history mapping', () => {
  const status: NatsKvStatus = {
    bucket: 'config',
    description: null,
    keys: 5,
    values: 9,
    history: 10,
    max_age_ms: 30 * 60_000,
    bytes: 2048,
    max_bytes: null,
    max_value_size: null,
    storage: 'memory',
    replicas: 3,
    created: '',
    last_time: '',
  }
  const e = (revision: number, operation: string, value = ''): NatsKvEntry => ({ key: 'feature.flags', value, revision, created: `2026-10-21T08:0${revision}:00Z`, operation, size: value.length })

  it('labels markers Updated · Deleted · Cleared', () => {
    expect(changeLabel('put')).toBe('Updated')
    expect(changeLabel('delete')).toBe('Deleted')
    expect(changeLabel('purge')).toBe('Cleared')
  })

  it('orders history newest first and marks the current version', () => {
    const h = historyRows([e(1, 'put', 'a'), e(3, 'delete'), e(2, 'put', 'b')])
    expect(h.map((x) => x.revision)).toEqual([3, 2, 1])
    expect(h[0]).toMatchObject({ current: true, marker: true, label: 'Deleted', tone: 'warn' })
    expect(h[1]).toMatchObject({ current: false, marker: false, label: 'Updated', tone: 'ok' })
  })

  it('describes bucket settings in words', () => {
    const [r] = bucketRows([status])
    expect(r.expire).toBe('30 minutes')
    expect(r.storage).toBe('Stored in memory · 3 copies')
    const w = Object.fromEntries(bucketWords(status).map((x) => [x.label, x.value]))
    expect(w['Versions kept']).toBe('10 versions')
    expect(w['Keys expire after']).toBe('30 minutes')
    expect(expireAfter(0)).toBe('Never')
    expect(deleteBucketText(status)).toBe('This deletes 5 keys and 9 stored values (earlier versions included) from config. Applications reading this bucket will get errors. This cannot be undone.')
    expect(purgeKeyText('a', 3)).toMatch(/all 3 stored versions/)
    expect(purgeKeyText('a', 1)).toMatch(/its stored version/)
  })

  it('applies live changes to key rows in order, ignoring late older events', () => {
    let rows = keyRows([e(2, 'put', 'x')])
    rows = applyChange(rows, { ...e(4, 'put', 'y'), key: 'alpha' })
    expect(rows.map((r) => r.key)).toEqual(['alpha', 'feature.flags'])
    rows = applyChange(rows, e(5, 'delete'))
    expect(rows[1]).toMatchObject({ revision: 5, deleted: true })
    rows = applyChange(rows, e(3, 'put', 'late'))
    expect(rows[1].revision).toBe(5)
  })

  it('validates names and formats values', () => {
    expect(validKey('feature.flags')).toBeNull()
    expect(validKey('bad key')).toMatch(/spaces/)
    expect(validKey('.x')).toMatch(/dot/)
    expect(validBucket('config')).toBeNull()
    expect(validBucket('a.b')).toMatch(/letters/)
    expect(preview('{\n "a": 1\n}')).toBe('{ "a": 1 }')
    expect(preview('x'.repeat(100), 10)).toHaveLength(10)
    expect(prettyValue('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyValue('plain')).toBe('plain')
  })
})

describe('demo key-value store behaves like the server', () => {
  beforeEach(() => natsKvDemoReset())

  it('every put is a new version; delete leaves a marker; history is capped', () => {
    natsKvDemo('nats_kv_create_bucket', { config: { bucket: 'b', history: 2, max_age_secs: 0, storage: 'file', max_bytes: 0, replicas: 1 } })
    const r1 = natsKvDemo('nats_kv_put_version', { bucket: 'b', key: 'k', value: '1' }) as number
    const r2 = natsKvDemo('nats_kv_put_version', { bucket: 'b', key: 'k', value: '2' }) as number
    expect(r2).toBe(r1 + 1)
    natsKvDemo('nats_kv_delete', { bucket: 'b', key: 'k' })
    const hist = natsKvDemo('nats_kv_history', { bucket: 'b', key: 'k' }) as NatsKvEntry[]
    expect(hist.map((x) => x.operation)).toEqual(['put', 'delete'])
    expect((natsKvDemo('nats_kv_entry', { bucket: 'b', key: 'k' }) as NatsKvEntry).operation).toBe('delete')
    expect(natsKvDemo('nats_kv_keys', { bucket: 'b' })).toEqual([])
    natsKvDemo('nats_kv_purge', { bucket: 'b', key: 'k' })
    expect((natsKvDemo('nats_kv_history', { bucket: 'b', key: 'k' }) as NatsKvEntry[]).map((x) => x.operation)).toEqual(['purge'])
  })

  it('watchers hear changes of their bucket only', async () => {
    const seen: string[] = []
    natsKvDemoSubscribe('s1', (e) => seen.push(`${e.key}=${e.value}`))
    natsKvDemo('nats_kv_watch', { session: 's1', bucket: 'config', pattern: '>' })
    natsKvDemo('nats_kv_put', { bucket: 'config', key: 'a', value: '1' })
    natsKvDemo('nats_kv_put', { bucket: 'sessions', key: 'b', value: '2' })
    await new Promise((r) => setTimeout(r, 60))
    expect(seen).toEqual(['a=1'])
    natsKvDemo('nats_kv_unwatch', { session: 's1' })
    natsKvDemo('nats_kv_put', { bucket: 'config', key: 'a', value: '3' })
    await new Promise((r) => setTimeout(r, 60))
    expect(seen).toEqual(['a=1'])
  })

  it('refuses a duplicate bucket and an unknown bucket', () => {
    expect(() => natsKvDemo('nats_kv_create_bucket', { config: { bucket: 'config' } })).toThrow(/already in use/)
    expect(() => natsKvDemo('nats_kv_status', { bucket: 'nope' })).toThrow(/could not be opened/)
    const acc = natsDemoAccount([{ bytes: 100, storage: 'File' }], 2)
    expect(acc.enabled).toBe(true)
    expect(acc.streams).toBe(3)
  })
})
