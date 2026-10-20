import { describe, expect, it } from 'vitest'
import { MAX_WORKERS, cpuBudget, e2eAffinityMask, pickWorkers } from './pw-workers'

describe('pickWorkers', () => {
  it('keeps cores for the dev server: 8 CPUs with plenty of RAM → 3 workers', () => {
    const p = pickWorkers({ cpus: 8, totalGB: 32, freeGB: 20 })
    expect(p.workers).toBe(4) // exactly half the cores
    expect(p.timeout).toBe(30_000)
    expect(p.reason).toMatch(/limited by CPU/)
  })

  it('drops to what free memory can hold so the machine does not page', () => {
    const p = pickWorkers({ cpus: 16, totalGB: 16, freeGB: 2.5 })
    expect(p.workers).toBe(2)
    expect(p.reason).toMatch(/free memory/)
  })

  it('runs one worker with a longer timeout on a starved machine', () => {
    const p = pickWorkers({ cpus: 8, totalGB: 16, freeGB: 0.4 })
    expect(p).toMatchObject({ workers: 1, timeout: 90_000 })
  })

  it('never goes below 1 or above the cap', () => {
    expect(pickWorkers({ cpus: 1, totalGB: 2, freeGB: 0 }).workers).toBe(1)
    expect(pickWorkers({ cpus: 128, totalGB: 512, freeGB: 400 }).workers).toBe(MAX_WORKERS)
  })

  it('honours PW_WORKERS, ignoring junk', () => {
    expect(pickWorkers({ cpus: 8, totalGB: 16, freeGB: 8, override: '2' }).workers).toBe(2)
    // an override can never exceed half the cores
    expect(pickWorkers({ cpus: 8, totalGB: 16, freeGB: 8, override: '5' }).workers).toBe(4)
    expect(pickWorkers({ cpus: 8, totalGB: 16, freeGB: 8, override: 'abc' }).workers).toBe(4)
    expect(pickWorkers({ cpus: 8, totalGB: 16, freeGB: 8, override: '0' }).workers).toBe(4)
  })
})

describe('e2e CPU pinning — half the cores', () => {
  it('pins the run to the UPPER half of the cores (core 0 stays free for the OS)', () => {
    expect(cpuBudget(8)).toBe(4)
    expect(e2eAffinityMask(8)).toBe(0b1111_0000n)
    expect(e2eAffinityMask(16)).toBe(0xff00n)
    expect(e2eAffinityMask(6)).toBe(0b111_000n)
    expect(e2eAffinityMask(5)).toBe(0b11_000n) // odd count rounds down
    expect(e2eAffinityMask(2)).toBe(0b10n)
  })

  it('does not pin where it cannot', () => {
    expect(e2eAffinityMask(1)).toBeNull()
    expect(e2eAffinityMask(65)).toBeNull() // beyond one Windows processor group
  })

  it('never plans more workers than the cores the run is pinned to', () => {
    for (const cpus of [2, 4, 6, 8, 12, 16, 32, 64]) {
      const { workers } = pickWorkers({ cpus, totalGB: 256, freeGB: 200 })
      expect(workers, `${cpus} cpus`).toBeLessThanOrEqual(cpuBudget(cpus))
    }
  })
})
