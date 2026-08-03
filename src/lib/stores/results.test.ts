// Unit test results store:
//  * the connection-open guard — a Query Editor tab executes ONLY while its
//    connection is open; a closed one blocks with a "reopen" toast instead of
//    silently reconnecting,
//  * chunked delivery — a large result arrives over the chunk channel and is
//    reassembled into the sub-result (nothing dropped, progress reported),
//  * Cancel targeting — the cancel goes to the connection the run *actually*
//    used (per-tab / per-database id), not to the base profile id.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RowChunk } from '$lib/ipc'
import type { SplitStatement } from '$lib/sql/statements'
import type { ExecResponse, ProfilePublic } from '$lib/types'

type StreamFn = (
  connId: string,
  sql: string,
  index: number | undefined,
  onChunk: (c: RowChunk) => void,
) => Promise<ExecResponse>

const affectedOnce: ExecResponse = { ok: true, affected: 1, duration_ms: 1 }
let stream: StreamFn = async () => affectedOnce
const execStatementStream = vi.fn<StreamFn>((c, sql, i, onChunk) => stream(c, sql, i, onChunk))
const cancelQuery = vi.fn(async (_connId: string) => ({ cancelled: true }))
const errorToast = vi.fn()

vi.mock('$lib/ipc', () => ({
  execStatement: vi.fn(async () => affectedOnce),
  execStatementStream: (c: string, sql: string, i: number | undefined, cb: (x: RowChunk) => void) =>
    execStatementStream(c, sql, i, cb),
  cancelQuery: (c: string) => cancelQuery(c),
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
const row = (i: number) => ({ id: i, name: `n${i}` })

beforeEach(() => {
  connections.profiles = []
  results.byTab = {}
  stream = async () => affectedOnce
  execStatementStream.mockClear()
  cancelQuery.mockClear()
  errorToast.mockClear()
})

describe('run — connection-open guard', () => {
  it('blocks execution + toasts a reopen message when the connection is closed', async () => {
    connections.profiles = [profile('c1', false)]
    await results.run('tab-1', 'c1', [stmt('SELECT 1')])
    expect(execStatementStream).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toMatch(/closed.*open the connection again/i)
    // no execution state seeded for a blocked run
    expect(results.get('tab-1')).toBeUndefined()
  })

  it('blocks a per-tab / per-database derived id when its base is disconnected', async () => {
    connections.profiles = [profile('c1', false)]
    await results.run('tab-1', 'c1#tab-tab-1', [stmt('SELECT 1')])
    expect(execStatementStream).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledTimes(1)
  })

  it('executes normally once the connection is open again', async () => {
    connections.profiles = [profile('c1', true)]
    await results.run('tab-1', 'c1', [stmt('SELECT 1')])
    expect(execStatementStream).toHaveBeenCalledTimes(1)
    expect(errorToast).not.toHaveBeenCalled()
    expect(results.get('tab-1')).toBeDefined()
  })

  it('errors when the tab has no matching profile at all', async () => {
    await results.run('tab-1', 'missing', [stmt('SELECT 1')])
    expect(execStatementStream).not.toHaveBeenCalled()
    expect(errorToast).toHaveBeenCalledWith('Tab has no connection')
  })
})

describe('run — chunked delivery of a large result', () => {
  it('reassembles every chunk into the sub-result and reports progress', async () => {
    connections.profiles = [profile('c1', true)]
    stream = async (_c, _sql, _i, onChunk) => {
      onChunk({ cols: [['id', 'int4']], rows: [row(1), row(2)], received: 2, total: 5 })
      onChunk({ rows: [row(3), row(4)], received: 4, total: 5 })
      onChunk({ rows: [row(5)], received: 5, total: 5 })
      // rows travelled over the channel → the response carries an empty array
      return {
        ok: true,
        streamed: true,
        result: { cols: [['id', 'int4'], ['name', 'text']], rows: [], total: 5 },
        duration_ms: 7,
      }
    }
    await results.run('tab-1', 'c1', [stmt('SELECT * FROM big')])

    const exec = results.get('tab-1')!
    expect(exec.receivedRows).toBe(5)
    const sub = exec.subResults[0]
    expect(sub.kind).toBe('rows')
    expect(sub.result!.rows).toHaveLength(5)
    expect(sub.result!.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
    expect(sub.result!.total).toBe(5)
    expect(sub.label).toContain('5 rows')
  })

  it('keeps the non-streamed response shape untouched (small result)', async () => {
    connections.profiles = [profile('c1', true)]
    stream = async () => ({
      ok: true,
      result: { cols: [['id', 'int4']], rows: [row(1)], total: 1 },
      duration_ms: 2,
    })
    await results.run('tab-1', 'c1', [stmt('SELECT 1')])
    const sub = results.get('tab-1')!.subResults[0]
    expect(sub.result!.rows).toEqual([row(1)])
    expect(results.get('tab-1')!.receivedRows).toBe(0)
  })
})

describe('cancel — targets the connection the run used', () => {
  it('cancels the per-tab connection, not the base profile id', async () => {
    connections.profiles = [profile('c1', true)]
    let release!: (r: ExecResponse) => void
    stream = () => new Promise<ExecResponse>((res) => (release = res))

    const running = results.run('tab-1', 'c1#tab-tab-1', [stmt('SELECT pg_sleep(30)')])
    await Promise.resolve() // let run() reach the await
    expect(results.get('tab-1')!.running).toBe(true)

    // The workspace may still only know the base id when Cancel is pressed.
    await results.cancel('tab-1', 'c1')
    expect(cancelQuery).toHaveBeenCalledWith('c1#tab-tab-1')
    expect(results.get('tab-1')!.cancelling).toBe(true)

    release({
      ok: false,
      error: { system: 'postgres', message: 'Query was cancelled', code: 'CANCELLED', severity: 'error', raw: '' },
      duration_ms: 3,
    })
    await running
    const exec = results.get('tab-1')!
    expect(exec.cancelled).toBe(true)
    expect(exec.running).toBe(false)
    expect(exec.cancelling).toBe(false)
  })

  it('does nothing when the tab is not running', async () => {
    await results.cancel('tab-none', 'c1')
    expect(cancelQuery).not.toHaveBeenCalled()
  })
})
