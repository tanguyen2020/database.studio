import { describe, expect, it } from 'vitest'
import { extraLanes, mapPool } from './pool'

const tick = () => new Promise((r) => setTimeout(r, 1))

describe('mapPool', () => {
  it('keeps input order even when jobs finish out of order', async () => {
    const out = await mapPool([30, 1, 20, 5, 10], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms * 2
    })
    expect(out).toEqual([60, 2, 40, 10, 20])
  })

  it('never runs more than `lanes` jobs at once and uses every lane', async () => {
    let live = 0
    let peak = 0
    const used = new Set<number>()
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async (_, lane) => {
      used.add(lane)
      peak = Math.max(peak, ++live)
      await tick()
      live--
    })
    expect(peak).toBe(4)
    expect([...used].sort()).toEqual([0, 1, 2, 3])
  })

  it('stops starting new jobs after an error and re-throws it', async () => {
    const started: number[] = []
    await expect(
      mapPool([0, 1, 2, 3, 4, 5], 1, async (i) => {
        started.push(i)
        if (i === 2) throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(started).toEqual([0, 1, 2])
  })

  it('handles empty input and silly lane counts', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([])
    expect(await mapPool([1, 2], 0, async (x) => x)).toEqual([1, 2])
  })
})

describe('extraLanes', () => {
  it('only helps socket engines with enough work', () => {
    expect(extraLanes('postgres', 10)).toBe(0)
    expect(extraLanes('postgres', 16)).toBe(1)
    expect(extraLanes('mysql', 500)).toBe(3)
    expect(extraLanes('sqlite', 500)).toBe(0)
    expect(extraLanes('duckdb', 500)).toBe(0)
  })
})
