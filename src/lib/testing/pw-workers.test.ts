import { describe, expect, it } from 'vitest'
import { MAX_WORKERS, pickWorkers } from './pw-workers'

describe('pickWorkers', () => {
  it('keeps cores for the dev server: 8 CPUs with plenty of RAM → 3 workers', () => {
    const p = pickWorkers({ cpus: 8, totalGB: 32, freeGB: 20 })
    expect(p.workers).toBe(3)
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
    expect(pickWorkers({ cpus: 8, totalGB: 16, freeGB: 8, override: '5' }).workers).toBe(5)
    expect(pickWorkers({ cpus: 8, totalGB: 16, freeGB: 8, override: 'abc' }).workers).toBe(3)
    expect(pickWorkers({ cpus: 8, totalGB: 16, freeGB: 8, override: '0' }).workers).toBe(3)
  })
})
