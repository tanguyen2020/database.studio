// Unit test results store — the connection-open guard: a Query Editor tab
// executes ONLY while its connection is open. A disconnected connection blocks
// execution with a "reopen" toast instead of silently reconnecting; reopening
// the connection restores normal execution.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SplitStatement } from '$lib/sql/statements'
import type { ProfilePublic } from '$lib/types'

const execStatement = vi.fn(async (_c: string, _sql: string, _i?: number) => ({
  ok: true,
  affected: 1,
  duration_ms: 1,
}))
const errorToast = vi.fn()

vi.mock('$lib/ipc', () => ({
  execStatement: (c: string, sql: string, i?: number) => execStatement(c, sql, i),
  cancelQuery: vi.fn(async () => {}),
}))
vi.mock('./toast.svelte', () => ({
  toasts: { error: (m: string) => errorToast(m), show: vi.fn(), success: vi.fn() },
}))

import { connections } from './connections.svelte'
import { results } from './results.svelte'

function profile(id: string, connected: boolean): ProfilePublic {
  return { ...connections.makeBlankProfile('postgres'), id, name: `Conn ${id}`, connected }
}

const stmt = (sql: string): SplitStatement => ({ sql, from: 0, to: sql.length, startLine: 1, startCol: 1 })

beforeEach(() => {
  connections.profiles = []
  results.byTab = {}
  execStatement.mockClear()
  errorToast.mockClear()
})

describe('run — connection-open guard', () => {
  it('blocks execution + toasts a reopen message when the connection is closed', async () => {
    connections.profiles = [profile('c1', false)]
    await results.run('tab-1', 'c1', [stmt('SELECT 1')])
    expect(execStatement).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toMatch(/closed.*open the connection again/i)
    // no execution state seeded for a blocked run
    expect(results.get('tab-1')).toBeUndefined()
  })

  it('blocks a per-tab / per-database derived id when its base is disconnected', async () => {
    connections.profiles = [profile('c1', false)]
    await results.run('tab-1', 'c1#tab-tab-1', [stmt('SELECT 1')])
    expect(execStatement).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledTimes(1)
  })

  it('executes normally once the connection is open again', async () => {
    connections.profiles = [profile('c1', true)]
    await results.run('tab-1', 'c1', [stmt('SELECT 1')])
    expect(execStatement).toHaveBeenCalledTimes(1)
    expect(errorToast).not.toHaveBeenCalled()
    expect(results.get('tab-1')).toBeDefined()
  })

  it('errors when the tab has no matching profile at all', async () => {
    await results.run('tab-1', 'missing', [stmt('SELECT 1')])
    expect(execStatement).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledWith('Tab has no connection')
  })
})
