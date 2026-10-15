import { describe, expect, it } from 'vitest'
import { addHelper, emptyRow, hasDurabilityChoice, parseArgs, planBindings, queueArgHelpers, routingKeyHint, usesRoutingKey, withTrailingEmpty, type ArgRow } from './arguments'

const row = (key: string, value: string, type: ArgRow['type'] = 'string'): ArgRow => ({ key, value, type })

describe('rabbitmq create-form arguments', () => {
  it('offers the management UI quick links per queue type', () => {
    const keys = (t: string) => queueArgHelpers(t).map((h) => h.key)
    expect(keys('classic')).toContain('x-max-priority')
    expect(keys('classic')).not.toContain('x-delivery-limit')
    expect(keys('quorum')).toContain('x-delivery-limit')
    expect(keys('quorum')).not.toContain('x-max-priority')
    expect(keys('stream')).toEqual(expect.arrayContaining(['x-max-age', 'x-max-length-bytes']))
    expect(keys('stream')).not.toContain('x-message-ttl')
    expect(keys('')).toEqual(keys('classic'))
    expect(hasDurabilityChoice('classic')).toBe(true)
    expect(hasDurabilityChoice('')).toBe(true)
    expect(hasDurabilityChoice('quorum')).toBe(false)
    expect(hasDurabilityChoice('stream')).toBe(false)
  })

  it('types the values like the UI does', () => {
    const r = parseArgs([
      row('x-message-ttl', '60000', 'number'),
      row('x-single-active-consumer', 'true', 'boolean'),
      row('x-dead-letter-exchange', 'dlx'),
      row('tags', 'a, b ,,c', 'list'),
      emptyRow(),
    ])
    expect(r).toEqual({ ok: true, args: { 'x-message-ttl': 60000, 'x-single-active-consumer': true, 'x-dead-letter-exchange': 'dlx', tags: ['a', 'b', 'c'] } })
  })

  it('names the problem instead of sending something the broker rejects', () => {
    expect(parseArgs([row('x-max-length', '10k', 'number')])).toEqual({ ok: false, error: 'x-max-length must be a number' })
    expect(parseArgs([row('x-max-length', '', 'number')])).toMatchObject({ ok: false })
    expect(parseArgs([row('', 'orphan')])).toMatchObject({ ok: false })
    expect(parseArgs([row('a', '1'), row('a', '2')])).toEqual({ ok: false, error: 'Argument a is given twice' })
    expect(parseArgs([row('flag', 'yes', 'boolean')])).toMatchObject({ ok: false })
  })

  it('quick-add fills a blank row, keeps one blank row, never duplicates', () => {
    let rows = withTrailingEmpty([])
    expect(rows).toHaveLength(1)
    rows = addHelper(rows, queueArgHelpers('classic').find((h) => h.key === 'x-message-ttl')!)
    expect(rows).toEqual([row('x-message-ttl', '', 'number'), emptyRow()])
    rows = addHelper(rows, queueArgHelpers('classic').find((h) => h.key === 'x-single-active-consumer')!)
    expect(rows[1]).toEqual(row('x-single-active-consumer', 'true', 'boolean'))
    expect(rows).toHaveLength(3)
    expect(addHelper(rows, queueArgHelpers('classic').find((h) => h.key === 'x-message-ttl')!)).toBe(rows)
    expect(withTrailingEmpty([emptyRow(), emptyRow(), emptyRow()])).toHaveLength(1)
  })
})

describe('rabbitmq create-form bindings', () => {
  const types: Record<string, string> = { orders: 'topic', events: 'fanout', direct1: 'direct', hdr: 'headers' }
  const typeOf = (x: string) => types[x]

  it('plans only chosen exchanges, drops ignored keys, collapses duplicates', () => {
    expect(
      planBindings(
        [
          { exchange: 'orders', routingKey: ' order.*.eu ' },
          { exchange: '', routingKey: 'forgotten' },
          { exchange: 'events', routingKey: 'ignored' },
          { exchange: 'orders', routingKey: 'order.*.eu' },
          { exchange: 'direct1', routingKey: '' },
        ],
        typeOf,
      ),
    ).toEqual([
      { exchange: 'orders', routingKey: 'order.*.eu' },
      { exchange: 'events', routingKey: '' },
      { exchange: 'direct1', routingKey: '' },
    ])
  })

  it('says how each exchange type uses the routing key', () => {
    expect(usesRoutingKey('topic')).toBe(true)
    expect(usesRoutingKey('direct')).toBe(true)
    expect(usesRoutingKey('fanout')).toBe(false)
    expect(usesRoutingKey('headers')).toBe(false)
    expect(routingKeyHint('topic')).toContain('#')
    expect(routingKeyHint('fanout')).toContain('ignored')
  })
})
