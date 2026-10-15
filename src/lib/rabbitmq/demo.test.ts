import { beforeEach, describe, expect, it } from 'vitest'
import { rabbitDemo, rabbitDemoSubscribe, resetRabbitDemo, topicMatches } from './demo'
import type { RabbitMessage, RabbitQueue } from '$lib/ipc'

// The demo stands in for the broker in every e2e, so it must route like RabbitMQ —
// otherwise a "routed / not routed" assertion would be testing the mock, not the UI.
describe('rabbitmq demo broker', () => {
  beforeEach(() => resetRabbitDemo())

  it('matches AMQP topic patterns (* = one word, # = zero or more)', () => {
    expect(topicMatches('order.created.*', 'order.created.eu')).toBe(true)
    expect(topicMatches('order.created.*', 'order.created')).toBe(false)
    expect(topicMatches('order.#', 'order')).toBe(true)
    expect(topicMatches('order.#', 'order.a.b.c')).toBe(true)
    expect(topicMatches('#.eu', 'order.created.eu')).toBe(true)
    expect(topicMatches('order.*.eu', 'order.created.us')).toBe(false)
  })

  it('routes publishes like the broker and reports unroutable ones', () => {
    const before = (rabbitDemo('rabbit_queue', { vhost: '/', queue: 'orders.created' }) as RabbitQueue).messages
    expect(rabbitDemo('rabbit_publish', { vhost: '/', exchange: 'orders', routingKey: 'order.created.jp', payload: '{}' })).toEqual({ routed: true })
    expect(rabbitDemo('rabbit_publish', { vhost: '/', exchange: '', routingKey: 'orders.created', payload: 'x' })).toEqual({ routed: true })
    expect(rabbitDemo('rabbit_publish', { vhost: '/', exchange: 'orders', routingKey: 'invoice.paid', payload: 'x' })).toEqual({ routed: false })
    const after = (rabbitDemo('rabbit_queue', { vhost: '/', queue: 'orders.created' }) as RabbitQueue).messages
    expect(after).toBe((before ?? 0) + 2)
  })

  it('peek keeps messages (marked redelivered), consume removes them', () => {
    const peek = rabbitDemo('rabbit_get_messages', { vhost: '/', queue: 'orders.created', count: 2, mode: 'requeue' }) as RabbitMessage[]
    expect(peek).toHaveLength(2)
    const again = rabbitDemo('rabbit_get_messages', { vhost: '/', queue: 'orders.created', count: 10, mode: 'requeue' }) as RabbitMessage[]
    expect(again).toHaveLength(4)
    expect(again[0].redelivered).toBe(true)
    rabbitDemo('rabbit_get_messages', { vhost: '/', queue: 'orders.created', count: 1, mode: 'ack' })
    expect((rabbitDemo('rabbit_queue', { vhost: '/', queue: 'orders.created' }) as RabbitQueue).messages).toBe(3)
  })

  it('refuses to delete built-in exchanges and drops bindings with a deleted queue', () => {
    expect(() => rabbitDemo('rabbit_delete_exchange', { vhost: '/', exchange: 'amq.topic' })).toThrow(/Built-in/)
    rabbitDemo('rabbit_delete_queue', { vhost: '/', queue: 'orders.created' })
    expect(rabbitDemo('rabbit_exchange_bindings', { vhost: '/', exchange: 'orders' })).toEqual([])
    expect(() => rabbitDemo('rabbit_queue', { vhost: '/', queue: 'orders.created' })).toThrow(/Not found/)
  })
})

describe('rabbitmq demo broker — live sessions', () => {
  beforeEach(() => resetRabbitDemo())
  const tick = () => new Promise((r) => setTimeout(r, 5))

  it('watch copies matching traffic and leaves the queue its own message', async () => {
    const got: string[] = []
    rabbitDemoSubscribe('w1', (b) => got.push(...b.msgs.map((m) => m.routing_key)), () => {})
    const info = rabbitDemo('rabbit_live_start', { request: { session: 'w1', mode: 'watch', vhost: '/', exchange: 'orders', routing_keys: ['order.*.eu'] } }) as { tap_queue: string }
    expect(info.tap_queue).toMatch(/^dbstudio\.tap\./)
    rabbitDemo('rabbit_publish', { vhost: '/', exchange: 'orders', routingKey: 'order.created.eu', payload: '{}' })
    rabbitDemo('rabbit_publish', { vhost: '/', exchange: 'orders', routingKey: 'order.created.us', payload: '{}' })
    await tick()
    expect(got).toEqual(['order.created.eu'])
    expect((rabbitDemo('rabbit_queue', { vhost: '/', queue: 'orders.created' }) as RabbitQueue).messages).toBe(6)
  })

  it('consume drains what is waiting and takes new messages', async () => {
    let n = 0
    rabbitDemoSubscribe('c1', (b) => (n = b.received), () => {})
    rabbitDemo('rabbit_live_start', { request: { session: 'c1', mode: 'consume', vhost: '/', queue: 'orders.created' } })
    rabbitDemo('rabbit_publish', { vhost: '/', exchange: '', routingKey: 'orders.created', payload: 'x' })
    await tick()
    expect(n).toBe(5)
    expect((rabbitDemo('rabbit_queue', { vhost: '/', queue: 'orders.created' }) as RabbitQueue).messages).toBe(0)
  })

  it('refuses what the broker would refuse', () => {
    expect(() => rabbitDemo('rabbit_live_start', { request: { session: 'x', mode: 'watch', vhost: '/', queue: 'billing.invoices' } })).toThrow(/default exchange/)
    rabbitDemo('rabbit_declare_exchange', { vhost: '/', name: 'd', exchangeType: 'direct' })
    expect(() => rabbitDemo('rabbit_live_start', { request: { session: 'y', mode: 'watch', vhost: '/', exchange: 'd' } })).toThrow(/direct exchange/)
    expect(() => rabbitDemo('rabbit_live_start', { request: { session: 'z', mode: 'watch', vhost: '/', exchange: '' } })).toThrow(/default exchange/)
  })
})
