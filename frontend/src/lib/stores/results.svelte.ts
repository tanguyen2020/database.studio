// Per-tab query execution state: multi-statement sub-results, Messages log,
// sequential run (stop-at-error), cancel. Results are runtime-only state —
// they are never persisted with the tab.

import * as ipc from '$lib/ipc'
import type { SplitStatement } from '$lib/sql/statements'
import type { QueryError, QueryResultSet } from '$lib/types'
import { connections } from './connections.svelte'
import { toasts } from './toast.svelte'

export interface SubResult {
  index: number // 1-based statement number (#N)
  label: string
  kind: 'rows' | 'affected' | 'ok' | 'error'
  result?: QueryResultSet
  affected?: number
  error?: QueryError
  durationMs: number
  statement: SplitStatement
}

export interface MessageEntry {
  index: number
  ok: boolean
  text: string
  durationMs: number
  error?: QueryError
  statement: SplitStatement
}

export interface TabExecution {
  running: boolean
  cancelled: boolean
  subResults: SubResult[]
  messages: MessageEntry[]
  activeSub: number // index into subResults, or -1 for Messages
  /** wall-clock summary for the status bar */
  totalMs: number
  lastRowCount: number | null
}

/** Table name heuristic for the sub-tab label (`#N orders · X rows`). */
function mainTableOf(sql: string): string {
  const m = /\bfrom\s+((?:[\w"`\[\]$.]+))/i.exec(sql)
  if (!m) return 'result'
  const raw = m[1].split('.').pop() ?? m[1]
  return raw.replace(/^["`\[]|["`\]]$/g, '')
}

class ResultsStore {
  byTab = $state<Record<string, TabExecution>>({})

  get(tabId: string): TabExecution | undefined {
    return this.byTab[tabId]
  }

  clear(tabId: string) {
    delete this.byTab[tabId]
  }

  /**
   * Runs statements sequentially against the tab's connection.
   * Stops at the first error (default behavior per spec).
   */
  async run(tabId: string, connId: string, statements: SplitStatement[]): Promise<void> {
    if (statements.length === 0) return
    const profile = connections.byId(connId)
    if (!profile) {
      toasts.error('Tab chưa gắn connection')
      return
    }
    if (!profile.connected) {
      const ok = await connections.connect(connId)
      if (!ok) return
    }

    const exec: TabExecution = {
      running: true,
      cancelled: false,
      subResults: [],
      messages: [],
      activeSub: 0,
      totalMs: 0,
      lastRowCount: null,
    }
    this.byTab[tabId] = exec

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]
      const index = i + 1
      let response
      try {
        response = await ipc.execStatement(connId, stmt.sql, index)
      } catch (e) {
        // IPC/infra-level failure (not a QueryError)
        const err: QueryError = {
          system: profile.system,
          statement_index: index,
          message: String(e),
          severity: 'error',
          raw: String(e),
        }
        exec.subResults.push({
          index,
          label: `#${index} ✗ error`,
          kind: 'error',
          error: err,
          durationMs: 0,
          statement: stmt,
        })
        exec.messages.push({
          index,
          ok: false,
          text: String(e),
          durationMs: 0,
          error: err,
          statement: stmt,
        })
        break
      }

      exec.totalMs += response.duration_ms

      if (response.ok) {
        if (response.result) {
          const table = mainTableOf(stmt.sql)
          exec.subResults.push({
            index,
            label: `#${index} ${table} · ${response.result.total.toLocaleString()} rows`,
            kind: 'rows',
            result: response.result,
            durationMs: response.duration_ms,
            statement: stmt,
          })
          exec.messages.push({
            index,
            ok: true,
            text: `SELECT ${response.result.total.toLocaleString()} rows`,
            durationMs: response.duration_ms,
            statement: stmt,
          })
          exec.lastRowCount = response.result.total
        } else if (response.affected != null) {
          exec.subResults.push({
            index,
            label: `#${index} ✓ ${response.affected.toLocaleString()} affected`,
            kind: 'affected',
            affected: response.affected,
            durationMs: response.duration_ms,
            statement: stmt,
          })
          exec.messages.push({
            index,
            ok: true,
            text: `${response.affected.toLocaleString()} rows affected`,
            durationMs: response.duration_ms,
            statement: stmt,
          })
          exec.lastRowCount = response.affected
        } else {
          exec.subResults.push({
            index,
            label: `#${index} ✓ OK`,
            kind: 'ok',
            durationMs: response.duration_ms,
            statement: stmt,
          })
          exec.messages.push({
            index,
            ok: true,
            text: 'OK',
            durationMs: response.duration_ms,
            statement: stmt,
          })
        }
        // show the newest result as it arrives (sequential feel)
        exec.activeSub = exec.subResults.length - 1
      } else if (response.error) {
        const err = response.error
        exec.subResults.push({
          index,
          label: `#${index} ✗ error`,
          kind: 'error',
          error: err,
          durationMs: response.duration_ms,
          statement: stmt,
        })
        exec.messages.push({
          index,
          ok: false,
          text: err.message,
          durationMs: response.duration_ms,
          error: err,
          statement: stmt,
        })
        exec.activeSub = exec.subResults.length - 1
        if (err.code === 'CANCELLED') {
          exec.cancelled = true
          toasts.show('Đã hủy query', { system: profile.system })
        } else {
          toasts.error(`#${index}: ${err.message}`, profile.system)
        }
        break // sequential execution stops at the failing statement
      }
    }

    exec.running = false
    if (!exec.cancelled && exec.subResults.every((s) => s.kind !== 'error')) {
      const n = exec.subResults.length
      toasts.success(`Đã chạy ${n} statement · ${exec.totalMs} ms`, profile.system)
    }
  }

  async cancel(tabId: string, connId: string) {
    const exec = this.byTab[tabId]
    if (!exec?.running) return
    try {
      await ipc.cancelQuery(connId)
    } catch (e) {
      toasts.error(`Cancel thất bại: ${e}`)
    }
  }
}

export const results = new ResultsStore()
