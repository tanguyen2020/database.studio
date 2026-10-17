import { describe, expect, it } from 'vitest'
import {
  buildProperties,
  exchangeLabel,
  filterByName,
  formatPayloadBytes,
  isBuiltinExchange,
  payloadPreview,
  payloadView,
  payloadText,
  queueMeta,
  queueTypeBadge,
  sortExchanges,
} from './format'
import type { RabbitExchange } from '$lib/ipc'

const ex = (name: string): RabbitExchange => ({
  name,
  vhost: '/',
  exchange_type: 'direct',
  durable: true,
  auto_delete: false,
  internal: false,
  arguments: {},
})

describe('rabbitmq names', () => {
  it('labels the default exchange and knows the built-ins', () => {
    expect(exchangeLabel('')).toBe('(AMQP default)')
    expect(exchangeLabel('orders')).toBe('orders')
    expect(isBuiltinExchange('')).toBe(true)
    expect(isBuiltinExchange('amq.topic')).toBe(true)
    expect(isBuiltinExchange('orders')).toBe(false)
  })

  it('sorts the default exchange first and amq.* last', () => {
    const names = sortExchanges([ex('amq.topic'), ex('orders'), ex(''), ex('billing')]).map((e) => e.name)
    expect(names).toEqual(['', 'billing', 'orders', 'amq.topic'])
  })

  it('badges queue types and reports unknown counts as "?"', () => {
    expect(queueTypeBadge('classic')).toBe('C')
    expect(queueTypeBadge('quorum')).toBe('Q')
    expect(queueTypeBadge('stream')).toBe('S')
    expect(queueMeta({ messages: 1234, consumers: 2 })).toBe('1,234 msg · 2 cons')
    expect(queueMeta({ messages: 0, consumers: 0 })).toBe('0 msg')
    expect(queueMeta({ messages: null, consumers: null })).toBe('? msg')
  })

  it('filters by name, case-insensitively', () => {
    const list = ['Orders.EU', 'orders.us', 'billing']
    expect(filterByName(list, 'ORDERS', (s) => s)).toEqual(['Orders.EU', 'orders.us'])
    expect(filterByName(list, '  ', (s) => s)).toEqual(list)
  })
})

describe('rabbitmq payloads', () => {
  it('pretty-prints JSON, keeps text, decodes base64 text and flags binary', () => {
    expect(payloadView({ payload: '{"id":1}', payload_encoding: 'string' })).toEqual({
      text: '{\n  "id": 1\n}',
      isJson: true,
      binary: false,
    })
    expect(payloadView({ payload: 'hello', payload_encoding: 'string' })).toMatchObject({ text: 'hello', isJson: false })
    // a bare JSON scalar is shown as text, not "pretty-printed"
    expect(payloadView({ payload: '42', payload_encoding: 'string' }).isJson).toBe(false)
    // base64 of UTF-8 text (Vietnamese) decodes
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode('{"ten":"Nguyễn"}')))
    expect(payloadView({ payload: b64, payload_encoding: 'base64' })).toMatchObject({ isJson: true, binary: false })
    // invalid UTF-8 stays base64
    const bin = btoa(String.fromCharCode(0xff, 0xfe, 0x00, 0x01))
    expect(payloadView({ payload: bin, payload_encoding: 'base64' })).toEqual({ text: bin, isJson: false, binary: true })
  })

  it('previews on one line and truncates', () => {
    expect(payloadPreview({ payload: '{\n "a": 1\n}', payload_encoding: 'string' })).toBe('{"a":1}')
    expect(payloadPreview({ payload: 'x'.repeat(200), payload_encoding: 'string' }, 10)).toBe('xxxxxxxxxx…')
  })

  it('builds publish properties and rejects headers that are not an object', () => {
    expect(buildProperties({ contentType: 'application/json', persistent: true, headers: '' })).toEqual({
      content_type: 'application/json',
      delivery_mode: 2,
    })
    expect(buildProperties({ contentType: '', persistent: false, headers: '{"src":"studio"}' })).toEqual({
      delivery_mode: 1,
      headers: { src: 'studio' },
    })
    expect(() => buildProperties({ contentType: '', persistent: false, headers: '[1]' })).toThrow(/JSON object/)
    expect(() => buildProperties({ contentType: '', persistent: false, headers: '{oops' })).toThrow(/JSON object/)
  })

  it('formats sizes', () => {
    expect(formatPayloadBytes(512)).toBe('512 B')
    expect(formatPayloadBytes(2048)).toBe('2.0 KB')
    expect(formatPayloadBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('payloadText', () => {
  it('keeps the payload as received; base64 text is decoded, binary stays base64', () => {
    expect(payloadText({ payload: '{"id":1}', payload_encoding: 'string' })).toEqual({ text: '{"id":1}', binary: false })
    expect(payloadText({ payload: btoa('hi there'), payload_encoding: 'base64' })).toEqual({ text: 'hi there', binary: false })
    expect(payloadText({ payload: btoa(String.fromCharCode(0xff, 0xfe, 0x00)), payload_encoding: 'base64' })).toMatchObject({ binary: true })
  })
})
