import { describe, expect, it } from 'vitest'
import { isConnectionLost, lostReason } from './lost'

describe('isConnectionLost', () => {
  it('trusts the typed code the backend sends', () => {
    expect(isConnectionLost({ code: 'CONNECTION_LOST', message: 'anything' })).toBe(true)
    expect(isConnectionLost({ code: 'CANCELLED', message: 'Query was cancelled' })).toBe(false)
  })

  it('recognises the untyped failures too (commands that reject before running)', () => {
    // AppError string from the IPC layer — no QueryError, no code.
    expect(isConnectionLost('not connected: c1#tab-3')).toBe(true)
    expect(isConnectionLost('error communicating with database: connection reset by peer')).toBe(true)
    expect(isConnectionLost('MySQL server has gone away')).toBe(true)
    expect(
      isConnectionLost('The client was disconnected by the server because of inactivity.'),
    ).toBe(true)
    expect(isConnectionLost('ORA-03113: end-of-file on communication channel')).toBe(true)
  })

  it('leaves ordinary SQL failures alone — they must not close the connection', () => {
    for (const msg of [
      'relation "students" does not exist',
      'syntax error at or near "slect"',
      'permission denied for table students',
      'duplicate key value violates unique constraint "pk_students"',
      'division by zero',
    ]) {
      expect(isConnectionLost({ message: msg }), msg).toBe(false)
      expect(isConnectionLost(msg), msg).toBe(false)
    }
  })

  it('handles empty input', () => {
    expect(isConnectionLost(null)).toBe(false)
    expect(isConnectionLost(undefined)).toBe(false)
    expect(isConnectionLost('')).toBe(false)
    expect(isConnectionLost({})).toBe(false)
  })
})

describe('lostReason', () => {
  it('uses the message, falling back to a generic label', () => {
    expect(lostReason({ code: 'CONNECTION_LOST', message: 'Connection lost — the server closed it' }))
      .toBe('Connection lost — the server closed it')
    expect(lostReason('not connected: c1')).toBe('not connected: c1')
    expect(lostReason({ code: 'CONNECTION_LOST' })).toBe('Connection lost')
  })
})
