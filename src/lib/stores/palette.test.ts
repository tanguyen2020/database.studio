import { describe, expect, it } from 'vitest'
import { fuzzyScore } from './palette.svelte'

describe('fuzzyScore', () => {
  it('empty query matches everything with score 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('subsequence match returns a score', () => {
    expect(fuzzyScore('ot', 'Open table')).not.toBeNull()
    expect(fuzzyScore('opentable', 'Open table')).not.toBeNull()
  })

  it('non-subsequence returns null', () => {
    expect(fuzzyScore('zzz', 'Open table')).toBeNull()
    // out of order → null
    expect(fuzzyScore('tabelo', 'Open table')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(fuzzyScore('OPEN', 'open table')).not.toBeNull()
  })

  it('ranks contiguous / word-start matches higher', () => {
    // "orders" contiguous should outscore scattered letters in a longer label
    const contiguous = fuzzyScore('orders', 'Open table: public.orders')!
    const scattered = fuzzyScore('optb', 'Open table: public.orders')!
    expect(contiguous).toBeGreaterThan(0)
    expect(scattered).toBeGreaterThan(0)
    // exact word beats scattered initials for the same query length is not
    // directly comparable; assert word-start bonus makes "orders" strong
    const weak = fuzzyScore('orders', 'ohrhdhehrhs')
    expect(weak === null || weak < contiguous).toBe(true)
  })
})
