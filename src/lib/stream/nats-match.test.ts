import { describe, expect, it } from 'vitest'
import { publishProblem, subjectMatches, subjectProblem } from './nats-match'

describe('subjectMatches', () => {
  it('follows the NATS token rules', () => {
    expect(subjectMatches('orders.eu', 'orders.eu')).toBe(true)
    expect(subjectMatches('orders.*', 'orders.eu')).toBe(true)
    expect(subjectMatches('orders.*', 'orders.eu.paid')).toBe(false)
    expect(subjectMatches('orders.>', 'orders.eu.paid')).toBe(true)
    expect(subjectMatches('orders.>', 'orders')).toBe(false)
    expect(subjectMatches('>', 'anything.at.all')).toBe(true)
    expect(subjectMatches('*.paid', 'orders.paid')).toBe(true)
    expect(subjectMatches('orders.eu', 'orders.us')).toBe(false)
    expect(subjectMatches('orders.eu', 'orders.eu.x')).toBe(false)
  })
})

describe('subjectProblem / publishProblem', () => {
  it('accepts valid subjects and explains invalid ones', () => {
    for (const s of ['orders.>', 'orders.*.paid', '>', '_INBOX.abc']) expect(subjectProblem(s), s).toBeNull()
    expect(subjectProblem('')).toMatch(/Type a subject/)
    expect(subjectProblem('a b')).toMatch(/spaces/)
    expect(subjectProblem('a..b')).toMatch(/\.\./)
    expect(subjectProblem('a.>.b')).toMatch(/last part/)
    expect(subjectProblem('ord*ers')).toMatch(/stand alone/)
  })
  it('publishing needs a concrete subject', () => {
    expect(publishProblem('orders.eu')).toBeNull()
    expect(publishProblem('orders.*')).toMatch(/wildcards/)
    expect(publishProblem('')).toMatch(/subject to send/)
  })
})
