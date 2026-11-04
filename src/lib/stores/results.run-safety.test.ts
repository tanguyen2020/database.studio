// Run-loop safety of the Query Editor (results store):
//  * a large result is attached only once EVERY chunk has arrived (a chunk can
//    land after the command's own reply on the desktop channel),
//  * a second run while one is running is refused (it used to run twice),
//  * Cancel between two statements stops the script,
//  * closing the tab mid-run stops it quietly (no "connection lost" for the base),
//  * a cancelled statement drops the transaction badge (the session is reset),
//  * a finished statement is shown while the next one is still running,
//  * Settings → Continue on error runs the rest of the script.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RowChunk } from '$lib/ipc'
import type { SplitStatement } from '$lib/sql/statements'
import type { ExecResponse, ProfilePublic } from '$lib/types'

type StreamFn = (connId: string, sql: string, index: number | undefined, onChunk: (c: RowChunk) => void) => Promise<ExecResponse>

const ok: ExecResponse = { ok: true, affected: 1, duration_ms: 1 }
let stream: StreamFn = async () => ok
const calls: string[] = []
const errorToast = vi.fn()
const showToast = vi.fn()

vi.mock('$lib/ipc', () => ({
  execStatement: vi.fn(async () => ok),
  execStatementStream: (c: string, sql: string, i: number | undefined, cb: (x: RowChunk) => void) => {
    calls.push(sql)
    return stream(c, sql, i, cb)
  },
  cancelQuery: vi.fn(async () => ({ cancelled: false })),
}))
vi.mock('./toast.svelte', () => ({
  toasts: { error: (m: string) => errorToast(m), show: (m: string) => showToast(m), success: vi.fn() },
}))

import { connections } from './connections.svelte'
import { MESSAGES_TAB, results } from './results.svelte'
import { settings } from './settings.svelte'

const profile = (id: string): ProfilePublic => ({ ...connections.makeBlankProfile('postgres'), id, name: `Conn ${id}`, connected: true })
const stmt = (sql: string): SplitStatement => ({ sql, from: 0, to: sql.length, startLine: 1, startCol: 1 })
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  connections.profiles = [profile('c1')]
  results.byTab = {}
  results.txnOpen = {}
  stream = async () => ok
  calls.length = 0
  errorToast.mockClear()
  showToast.mockClear()
  settings.value.continueOnError = false
})

describe('chunked results', () => {
  it('waits for a chunk that arrives after the command replied', async () => {
    stream = async (_c, _s, _i, onChunk) => {
      onChunk({ cols: [['id', 'int4']], rows: [{ id: 1 }, { id: 2 }], received: 2, total: 5 })
      // the last chunk lands AFTER the reply (async fetch path on the desktop)
      setTimeout(() => onChunk({ rows: [{ id: 3 }, { id: 4 }, { id: 5 }], received: 5, total: 5 }), 30)
      return { ok: true, streamed: true, duration_ms: 3, result: { cols: [['id', 'int4']], rows: [], total: 5 } }
    }
    await results.run('t', 'c1', [stmt('SELECT * FROM big')])
    const sub = results.get('t')!.subResults[0]
    expect(sub.result!.rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
    expect(sub.result!.total).toBe(5)
  })
})

describe('one run per tab', () => {
  it('refuses a second run while the first is still running', async () => {
    let release!: () => void
    stream = () => new Promise((r) => (release = () => r(ok)))
    const first = results.run('t', 'c1', [stmt('INSERT INTO t VALUES (1)'), stmt('INSERT INTO t VALUES (2)')])
    await tick(5)
    await results.run('t', 'c1', [stmt('INSERT INTO t VALUES (9)')])
    expect(showToast.mock.calls.at(-1)?.[0]).toMatch(/already running/)
    stream = async () => ok
    release()
    await first
    expect(calls).toEqual(['INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)']) // 9 never sent, nothing twice
  })
})

describe('cancel', () => {
  it('stops the script when Cancel lands between two statements', async () => {
    stream = async (_c, sql) => {
      if (sql.endsWith('1)')) await results.cancel('t', 'c1') // nothing in flight server-side
      return ok
    }
    await results.run('t', 'c1', ['1)', '2)', '3)'].map((n) => stmt(`INSERT INTO t VALUES (${n}`)))
    expect(calls).toHaveLength(1)
    const exec = results.get('t')!
    expect(exec.cancelled).toBe(true)
    expect(exec.running).toBe(false)
    expect(showToast).toHaveBeenCalledWith('Query cancelled')
  })

  it('a cancelled statement drops the transaction badge', async () => {
    stream = async (_c, sql) =>
      sql === 'BEGIN'
        ? ok
        : { ok: false, duration_ms: 1, error: { system: 'postgres', code: 'CANCELLED', message: 'cancelled', severity: 'error', raw: '' } }
    await results.run('t', 'c1', [stmt('BEGIN'), stmt('UPDATE t SET a = 1')])
    expect(results.inTransaction('c1')).toBe(false)
  })
})

describe('closing the tab mid-run', () => {
  it('stops quietly and does not mark the connection lost', async () => {
    stream = async (_c, sql) => {
      if (sql === 'S1') {
        results.cancelAndClear('t')
        return ok
      }
      throw new Error('not connected: c1#tab-t')
    }
    await results.run('t', 'c1#tab-t', [stmt('S1'), stmt('S2'), stmt('S3')])
    expect(calls).toEqual(['S1'])
    expect(connections.byId('c1')!.connected).toBe(true)
    expect(errorToast).not.toHaveBeenCalled()
    expect(results.get('t')).toBeUndefined()
  })
})

describe('progress while a long statement runs', () => {
  it('shows a finished statement before the next one returns', async () => {
    let release!: () => void
    stream = async (_c, sql) => (sql === 'SELECT 1' ? ok : new Promise((r) => (release = () => r(ok))))
    const run = results.run('t', 'c1', [stmt('SELECT 1'), stmt('SELECT pg_sleep(600)')])
    await tick(250)
    expect(results.get('t')!.messages.map((m) => m.index)).toEqual([1])
    release()
    await run
  })
})

describe('Settings → Continue on error', () => {
  const failing = async (_c: string, sql: string): Promise<ExecResponse> =>
    sql.startsWith('BAD')
      ? { ok: false, duration_ms: 1, error: { system: 'postgres', message: `syntax error at ${sql}`, severity: 'error', raw: '' } }
      : ok

  it('off (default): the script stops at the first error', async () => {
    stream = failing
    await results.run('t', 'c1', [stmt('S1'), stmt('BAD1'), stmt('S2')])
    expect(calls).toEqual(['S1', 'BAD1'])
  })

  it('on: every statement runs, failures are reported at the end and Messages opens', async () => {
    settings.value.continueOnError = true
    stream = failing
    await results.run('t', 'c1', [stmt('S1'), stmt('BAD1'), stmt('S2'), stmt('BAD2'), stmt('S3')])
    expect(calls).toEqual(['S1', 'BAD1', 'S2', 'BAD2', 'S3'])
    const exec = results.get('t')!
    expect(exec.messages.filter((m) => m.kind === 'error').map((m) => m.index)).toEqual([2, 4])
    expect(exec.activeSub).toBe(MESSAGES_TAB)
    expect(errorToast).toHaveBeenCalledTimes(1)
    expect(errorToast.mock.calls[0][0]).toMatch(/^2 statements failed/)
  })

  it('on: a lost connection still stops the run', async () => {
    settings.value.continueOnError = true
    stream = async (_c, sql) =>
      sql === 'S2'
        ? { ok: false, duration_ms: 1, error: { system: 'postgres', code: 'CONNECTION_LOST', message: 'server closed the connection', severity: 'error', raw: '' } }
        : ok
    await results.run('t', 'c1', [stmt('S1'), stmt('S2'), stmt('S3')])
    expect(calls).toEqual(['S1', 'S2'])
  })
})
