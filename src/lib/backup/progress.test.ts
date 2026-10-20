import { describe, expect, it } from 'vitest'
import { etaText, formatBytes, progressView, pushSample, type Sample } from './progress'
import type { BackupProgress } from '$lib/ipc'

const p = (o: Partial<BackupProgress>): BackupProgress => ({
  jobId: 'j',
  stage: 'Backing up',
  done: 0,
  total: null,
  unit: 'tables',
  current: null,
  ...o,
})

describe('backup progress view', () => {
  it('counts objects out of a known total', () => {
    const v = progressView(p({ done: 1240, total: 3000, current: 'public.orders' }), [])
    expect(v.percent).toBeCloseTo(41.33, 1)
    expect(v.amount).toBe('1,240 of 3,000 tables')
    expect(v.current).toBe('public.orders')
  })

  it('has no percent when the total is unknown (indeterminate)', () => {
    const v = progressView(p({ done: 12, total: null }), [])
    expect(v.percent).toBeNull()
    expect(v.amount).toBe('12 tables')
    expect(progressView(p({ done: 0, unit: '' }), []).amount).toBe('')
  })

  it('never shows "0 of 0": a total of 0 is unknown', () => {
    const v = progressView(p({ done: 7, total: 0, current: 'public.t_7' }), [])
    expect(v.percent).toBeNull()
    expect(v.amount).toBe('7 tables')
    expect(progressView(p({ done: 0, total: 0 }), []).amount).toBe('')
  })

  it('counts the steps of a run that names no object', () => {
    const v = progressView(p({ stage: 'Reading the catalog', done: 23, total: 50, unit: 'steps', current: 'reading user-defined types' }), [])
    expect(v.percent).toBe(46)
    expect(v.amount).toBe('23 of 50 steps')
    // the step is named without repeating the stage
    expect(v.current).toBe('user-defined types')
    expect(progressView(p({ stage: 'Reading the catalog', current: 'saving encoding' }), []).current).toBe('saving encoding')
  })

  it('reads bytes and server percent', () => {
    expect(progressView(p({ unit: 'bytes', done: 50 * 1024 * 1024, total: 200 * 1024 * 1024 }), []).amount).toBe('50.0 MB of 200 MB')
    const pc = progressView(p({ unit: '%', done: 42, total: 100 }), [])
    expect(pc.percent).toBe(42)
    expect(pc.amount).toBe('42%')
  })

  it('never shows more than 100%', () => {
    expect(progressView(p({ done: 3100, total: 3000 }), []).percent).toBe(100)
  })

  it('rate and time left come from the recent samples', () => {
    let s: Sample[] = []
    s = pushSample(s, { at: 0, done: 0 })
    s = pushSample(s, { at: 2000, done: 200 })
    const v = progressView(p({ done: 200, total: 3000 }), s)
    expect(v.rate).toBe('100 tables/s')
    expect(v.eta).toBe('less than a minute left') // 2,800 left at 100/s = 28 s
    expect(progressView(p({ done: 200, total: 200_000 }), s).eta).toBe('about 33 min left')
  })

  it('a new stage (counter back to 0) restarts the rate', () => {
    let s: Sample[] = [{ at: 0, done: 0 }, { at: 1000, done: 900 }]
    s = pushSample(s, { at: 1200, done: 3 })
    expect(s).toEqual([{ at: 1200, done: 3 }])
    expect(progressView(p({ done: 3, total: 10 }), s).rate).toBeNull()
  })

  it('old samples fall out of the window', () => {
    let s: Sample[] = []
    for (let t = 0; t <= 20_000; t += 1000) s = pushSample(s, { at: t, done: t })
    expect(s[0].at).toBeGreaterThanOrEqual(14_000)
  })

  it('formats', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(etaText(30)).toBe('less than a minute left')
    expect(etaText(90 * 60)).toBe('about 1 h 30 min left')
  })
})
