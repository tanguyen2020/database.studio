import { describe, expect, it } from 'vitest'
import { parseSeq, peekErrorText, seqRangeHint } from './nats-peek'

describe('open a NATS message by sequence', () => {
  it('accepts the ways people type a number', () => {
    expect(parseSeq('1042')).toEqual({ seq: 1042 })
    expect(parseSeq(' #1,042 ')).toEqual({ seq: 1042 })
    expect(parseSeq('1 042', { first: 1, last: 2000 })).toEqual({ seq: 1042 })
  })

  it('refuses what cannot be a sequence, saying why', () => {
    expect(parseSeq('')).toEqual({ error: 'Type a sequence number.' })
    expect(parseSeq('abc')).toEqual({ error: 'A sequence is a whole number, like 1042.' })
    expect(parseSeq('1.5')).toEqual({ error: 'A sequence is a whole number, like 1042.' })
    expect(parseSeq('0')).toEqual({ error: 'Sequences start at 1.' })
    expect(parseSeq('5000', { first: 1, last: 1000 })).toEqual({ error: 'The newest message is #1,000.' })
    // below the first kept sequence is still asked: a gap is the server's answer to give
    expect(parseSeq('3', { first: 10, last: 1000 })).toEqual({ seq: 3 })
  })

  it('explains a missing message instead of echoing the server', () => {
    expect(peekErrorText('Failed to peek seq 7: no message found', 'ORDERS', 7, { first: 10, last: 1000 })).toBe(
      'There is no message #7 in ORDERS. It was deleted or expired by the stream\'s limits; the stream holds 10–1,000.',
    )
    expect(peekErrorText('Error: timed out', 'ORDERS', 7)).toBe('Could not read message #7: timed out')
    expect(seqRangeHint({ first: 1, last: 1000 })).toBe('This stream holds 1–1,000')
    expect(seqRangeHint({ first: 0, last: 0 })).toBe('')
  })
})
