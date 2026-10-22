import { describe, expect, it } from 'vitest'
import { arrangeTree, streamNodes, subjectKey } from './nats-tree'

const rows = [
  { name: 'ORDERS', subjects: ['orders.us', 'orders.eu'] },
  { name: 'EVENTS', subjects: ['events.>'] },
  { name: 'INBOX', subjects: ['_INBOX.>'] },
]
const byName = <T extends { row: { name: string } }>(ns: T[]) => [...ns].sort((a, b) => a.row.name.localeCompare(b.row.name))
const labels = (ns: ReturnType<typeof arrangeTree>) => ns.map((n) => (n.kind === 'stream' ? n.row.name : `  ${n.subject}`))

describe('NATS stream → subject tree', () => {
  it('puts each stream first, then its subjects alphabetically under it', () => {
    const out = arrangeTree(streamNodes(rows, new Set()), '', byName)
    expect(labels(out)).toEqual(['EVENTS', '  events.>', 'INBOX', '  _INBOX.>', 'ORDERS', '  orders.eu', '  orders.us'])
    expect(out.find((n) => n.kind === 'subject' && n.subject === 'orders.eu')?.key).toBe(subjectKey('ORDERS', 'orders.eu'))
  })

  it('keeps subjects under their own stream whatever the stream sort', () => {
    const desc = <T extends { row: { name: string } }>(ns: T[]) => byName(ns).reverse()
    expect(labels(arrangeTree(streamNodes(rows, new Set()), '', desc))).toEqual(['ORDERS', '  orders.eu', '  orders.us', 'INBOX', '  _INBOX.>', 'EVENTS', '  events.>'])
  })

  it('a collapsed stream hides its subjects but stays listed', () => {
    const out = arrangeTree(streamNodes(rows, new Set(['ORDERS'])), '', byName)
    expect(labels(out)).toEqual(['EVENTS', '  events.>', 'INBOX', '  _INBOX.>', 'ORDERS'])
    expect(out.at(-1)).toMatchObject({ kind: 'stream', expanded: false, childCount: 2 })
  })

  it('filters by stream name (all its subjects) or by subject (only the matches, stream opened)', () => {
    expect(labels(arrangeTree(streamNodes(rows, new Set()), 'order', byName))).toEqual(['ORDERS', '  orders.eu', '  orders.us'])
    // "eu" matches a subject only — its stream opens even when collapsed
    const out = arrangeTree(streamNodes(rows, new Set(['ORDERS'])), 'EU', byName)
    expect(labels(out)).toEqual(['ORDERS', '  orders.eu'])
    expect(out[0]).toMatchObject({ kind: 'stream', expanded: true })
    expect(arrangeTree(streamNodes(rows, new Set()), 'zzz', byName)).toEqual([])
  })
})
