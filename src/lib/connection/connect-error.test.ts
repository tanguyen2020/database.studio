import { describe, expect, it } from 'vitest'
import { cleanConnectMessage, explainConnectError } from './connect-error'

const redis = { system: 'redis', host: '10.0.0.5', port: 6379 }

describe('explainConnectError', () => {
  it('strips transport prefixes but keeps the server words', () => {
    expect(cleanConnectMessage('driver error: Connection refused (os error 10061)')).toBe('Connection refused (os error 10061)')
    expect(cleanConnectMessage('ssh tunnel error: auth failed')).toBe('auth failed')
  })

  it('refused: names the address and the usual port of the engine', () => {
    const f = explainConnectError(redis, 'driver error: Connection refused (os error 10061)')
    expect(f.kind).toBe('refused')
    expect(f.detail).toContain('10.0.0.5:6379')
    expect(f.tips.join(' ')).toContain('6379')
    const r = explainConnectError({ system: 'rabbitmq', host: 'mq', port: 5672 }, 'driver error: error sending request: connection refused')
    expect(r.tips.join(' ')).toContain('15672')
  })

  it('an SSH failure is reported as the tunnel, even when it mentions authentication', () => {
    const f = explainConnectError({ ...redis, ssh: { enabled: true, host: 'bastion' } }, 'ssh tunnel error: authentication failed')
    expect(f.kind).toBe('ssh')
    expect(f.detail).toContain('bastion')
    expect(f.message).toBe('authentication failed')
  })

  it('recognises sign-in rejections per engine', () => {
    expect(explainConnectError(redis, 'driver error: WRONGPASS invalid username-password pair').kind).toBe('auth')
    expect(explainConnectError({ system: 'nats' }, 'driver error: nats: Authorization Violation').kind).toBe('auth')
    expect(explainConnectError({ system: 'kafka' }, 'driver error: SASL authentication error').kind).toBe('auth')
  })

  it('timeouts, unknown hosts, TLS and lost connections', () => {
    expect(explainConnectError(redis, 'driver error: connection timed out').kind).toBe('timeout')
    expect(explainConnectError(redis, 'driver error: failed to lookup address information').kind).toBe('dns')
    expect(explainConnectError(redis, 'driver error: invalid peer certificate: UnknownIssuer').kind).toBe('tls')
    expect(explainConnectError(redis, 'Connection lost — the server closed it').kind).toBe('lost')
  })

  it('Kafka broker failures and RabbitMQ virtual hosts get their own advice', () => {
    const k = explainConnectError({ system: 'kafka', host: 'k', port: 9092 }, 'driver error: Meta data fetch error: BrokerTransportFailure')
    expect(k.kind).toBe('brokers')
    expect(k.tips.join(' ')).toContain('advertised.listeners')
    expect(explainConnectError({ system: 'rabbitmq' }, "driver error: Virtual host 'x' does not exist").kind).toBe('vhost')
  })

  it('unknown text falls back without inventing a cause', () => {
    const f = explainConnectError(redis, 'driver error: something odd')
    expect(f.kind).toBe('other')
    expect(f.title).toBe('Could not connect')
    expect(f.message).toBe('something odd')
  })
})
