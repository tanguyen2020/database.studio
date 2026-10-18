// Per-tab query execution state: multi-statement sub-results, Messages log,
// sequential run (stop-at-error), cancel. Results are runtime-only state —
// they are never persisted with the tab.

import { isConnectionLost, lostReason } from '$lib/connection/lost'
import * as ipc from '$lib/ipc'
import type { SplitStatement } from '$lib/sql/statements'
import { supportsTxn, txnEffect } from '$lib/sql/txn'
import type { QueryError, QueryResultSet } from '$lib/types'
import { failureToast, successToast } from '$lib/results/run-summary'
import { mapErrorToDocument } from '$lib/sql/errors'
import { connections, baseConnId as baseOf } from './connections.svelte'
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
  /** tên bảng chính (heuristic FROM) — statusObject của status bar */
  table?: string
  /** Cassandra only — base64 paging token của trang kế (null/undefined = hết trang).
   *  Cho phép "Load next page" append thêm rows qua fetchMoreCql. */
  cqlNextPage?: string | null
  /** Cassandra only — consistency đã dùng, để fetch trang kế cùng mức. */
  cqlConsistency?: string
}

export interface MessageEntry {
  index: number
  ok: boolean
  text: string
  durationMs: number
  error?: QueryError
  statement: SplitStatement
  /** What the statement produced — drives the Messages view (rows link to their
   *  result tab, affected counts are summed, warnings are not statements). */
  kind?: 'rows' | 'affected' | 'ok' | 'error' | 'warning'
  rows?: number
  affected?: number
}

/** `activeSub` value that shows the Messages view instead of a result tab.
 *
 *  Only statements that RETURN ROWS get a result tab of their own. INSERT /
 *  UPDATE / DELETE / TRUNCATE / DDL report a count or "done" — one tab per such
 *  statement turned a 30-line script into 30 tabs of "✓ 1 affected", so they are
 *  listed together in Messages instead (DataGrip "Output", SSMS "Messages"). */
export const MESSAGES_TAB = -1

/** How often a running script hands its buffered outcomes to the UI. */
const FLUSH_MS = 100

/** Query-plan state shown inside the Result panel (not a separate tab). One per
 *  SQL tab; replaced on each Explain. */
export interface ExplainState {
  loading: boolean
  plan?: ipc.QueryPlan
  error?: string
  sql: string
  actual: boolean
  connId: string
}

export interface TabExecution {
  running: boolean
  cancelled: boolean
  /** Cancel was requested and we are waiting for the statement to unwind. */
  cancelling: boolean
  /** Rows received so far on the streaming path — progress for a big result. */
  receivedRows: number
  subResults: SubResult[]
  messages: MessageEntry[]
  activeSub: number // index into subResults, or -1 for Messages
  /** wall-clock summary for the status bar */
  totalMs: number
  lastRowCount: number | null
  /** epoch ms khi bắt đầu chạy (cho hiển thị "running Ns" — T11) */
  startedAt: number
  /** connection id this tab last executed against (base or `{base}::{db}` sub-id) —
   *  used to cancel the right in-flight query when the tab is closed (item 6). */
  connId: string
  /** how many statements this run was given — the ones never reached (stop at the
   *  first error / cancel) are reported as "not run" instead of silently missing */
  total?: number
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
  /** Query plan per tab — rendered as a sub-view of the Result panel (Explain). */
  explainByTab = $state<Record<string, ExplainState>>({})
  /** Connections the editor left inside an OPEN transaction (keyed by the exact
   *  run-connection id). A pinned transaction is the one way a working driver
   *  still shows "cached" rows — under REPEATABLE READ the snapshot is frozen
   *  and the writes stay invisible to everyone else — so the workspace surfaces
   *  it with a badge + Commit/Rollback instead of leaving it silent. */
  txnOpen = $state<Record<string, boolean>>({})

  inTransaction(connId: string | null | undefined): boolean {
    return !!connId && !!this.txnOpen[connId]
  }

  /** Forget transaction state for a connection (disconnect / reconnect). */
  clearTxn(connId: string) {
    delete this.txnOpen[connId]
    for (const id of Object.keys(this.txnOpen)) {
      if (baseOf(id) === baseOf(connId)) delete this.txnOpen[id]
    }
  }

  /** A statement failed because the connection is gone (idle timeout, server
   *  restart, dropped tunnel — the backend types this as `CONNECTION_LOST`).
   *  Mark the profile closed so the sidebar dot goes red and the tab shows its
   *  Reconnect banner, and drop the transaction state we can no longer trust:
   *  a new connection is never inside the old one's transaction. */
  noteConnectionLost(connId: string, err: QueryError | string) {
    connections.markLost(connId, lostReason(err))
    this.clearTxn(connId)
  }

  get(tabId: string): TabExecution | undefined {
    return this.byTab[tabId]
  }

  explainOf(tabId: string): ExplainState | undefined {
    return this.explainByTab[tabId]
  }

  clear(tabId: string) {
    delete this.byTab[tabId]
    delete this.explainByTab[tabId]
  }

  clearExplain(tabId: string) {
    delete this.explainByTab[tabId]
  }

  /** Run EXPLAIN for a statement and stash the plan in the tab's Result panel.
   *  Does NOT open a new tab. `connId` is the tab's resolved run-connection so the
   *  plan targets the same database/schema the query runs on. */
  async runExplain(tabId: string, connId: string, sql: string, actual: boolean): Promise<void> {
    this.explainByTab[tabId] = { loading: true, sql, actual, connId }
    const st = this.explainByTab[tabId] as ExplainState
    try {
      st.plan = await ipc.explainPlan(connId, sql, actual)
      st.error = undefined
    } catch (e) {
      st.error = String(e)
      st.plan = undefined
    } finally {
      st.loading = false
    }
  }

  /** Cancel a tab's in-flight query (if any) and drop its execution state. Called
   *  when a tab is closed so a running query on that tab is stopped, not orphaned
   *  (item 6 — "closing a tab ends its running task"). */
  cancelAndClear(tabId: string) {
    const exec = this.byTab[tabId]
    if (exec?.running && exec.connId) {
      void ipc.cancelQuery(exec.connId).catch(() => {})
    }
    delete this.byTab[tabId]
    delete this.explainByTab[tabId]
  }

  /**
   * Runs statements sequentially against the tab's connection.
   * Stops at the first error (default behavior per spec).
   */
  async run(
    tabId: string,
    connId: string,
    statements: SplitStatement[],
    opts?: { consistency?: string; database?: string },
  ): Promise<void> {
    if (statements.length === 0) return
    // `connId` may be a per-tab connection (`{base}#tab-{id}`, item 6) and/or a
    // per-database sub-connection (`{base}::{db}`, attach_database). Strip both
    // suffixes to find the base profile; still execute against the full `connId`
    // (the backend registry has that connection live).
    const baseId = baseOf(connId)
    const profile = connections.byId(baseId)
    if (!profile) {
      toasts.error('Tab has no connection')
      return
    }
    // The connection must be OPEN to execute. A base connection that was
    // disconnected — and therefore every per-tab (`{id}#…`) / per-database
    // (`{id}::…`) connection derived from it, which `disconnect` sweeps — blocks
    // execution with a clear "reopen" message instead of silently reconnecting,
    // so a closed connection is explicit and the user must Open Connection again.
    if (!profile.connected) {
      toasts.error(`Connection "${profile.name}" is closed. Please open the connection again.`)
      return
    }

    const seed: TabExecution = {
      running: true,
      cancelled: false,
      cancelling: false,
      receivedRows: 0,
      subResults: [],
      messages: [],
      activeSub: MESSAGES_TAB,
      totalMs: 0,
      lastRowCount: null,
      startedAt: Date.now(),
      connId,
      total: statements.length,
    }
    this.byTab[tabId] = seed
    // Re-acquire the $state proxy: subsequent mutations (subResults.push,
    // activeSub, running) must go through the proxy to trigger reactivity.
    // Mutating the raw `seed` object would bypass the proxy → view never updates.
    const exec = this.byTab[tabId] as TabExecution

    const isCassandra = profile.system === 'cassandra'
    const isMongo = profile.system === 'mongodb'

    // Statement outcomes are buffered and handed to the reactive state at most every
    // FLUSH_MS. Pushing each one straight into $state made the Result panel re-render
    // and re-layout the whole growing Messages list after EVERY statement — a
    // 1,000-line INSERT script spent minutes redrawing (measured: 300 statements
    // ≈ 1.8 s of pure rendering with an instant backend). Long scripts still show
    // progress; the final state is identical.
    const buf = {
      subs: [] as SubResult[],
      msgs: [] as MessageEntry[],
      active: undefined as number | undefined,
      totalMs: 0,
      lastRowCount: undefined as number | undefined,
    }
    let lastFlush = performance.now()
    const flush = () => {
      if (buf.subs.length) exec.subResults.push(...buf.subs.splice(0))
      if (buf.msgs.length) exec.messages.push(...buf.msgs.splice(0))
      if (buf.totalMs) {
        exec.totalMs += buf.totalMs
        buf.totalMs = 0
      }
      if (buf.lastRowCount !== undefined) {
        exec.lastRowCount = buf.lastRowCount
        buf.lastRowCount = undefined
      }
      if (buf.active !== undefined) {
        exec.activeSub = buf.active
        buf.active = undefined
      }
      lastFlush = performance.now()
    }

    for (let i = 0; i < statements.length; i++) {
      // the longer the list already on screen, the costlier each redraw — space
      // the redraws out as it grows (100 ms → ~0.5 s at 2,000 statements)
      if (performance.now() - lastFlush >= FLUSH_MS + exec.messages.length * 0.2) flush()
      const stmt = statements[i]
      const index = i + 1
      let response
      // Cassandra runs through the dedicated `cql_exec` command (paging state +
      // server warnings). Every other engine keeps the generic `exec_statement`
      // path unchanged. `cqlWarnings`/`cqlNextPage` are populated only here.
      let cqlWarnings: string[] = []
      let cqlNextPage: string | null | undefined
      try {
        if (isCassandra) {
          const c = await ipc.cqlExec(connId, stmt.sql, undefined, undefined, opts?.consistency)
          cqlWarnings = c.warnings ?? []
          cqlNextPage = c.next_page ?? null
          response = {
            ok: c.ok,
            result: c.result as QueryResultSet | undefined,
            affected: undefined,
            duration_ms: c.duration_ms,
            error: c.error
              ? ({
                  system: 'cassandra',
                  statement_index: c.error.statement_index ?? index,
                  message: c.error.message,
                  severity: 'error',
                  raw: c.error.detail ?? c.error.message,
                } satisfies QueryError)
              : undefined,
          }
        } else if (isMongo) {
          // MongoDB runs through the dedicated `mongo_exec` command (mongosh-style
          // parser + Extended JSON). Warnings and a cursor token share the same
          // fields as Cassandra so the Result panel wiring is unchanged.
          const m = await ipc.mongoExec(connId, stmt.sql, opts?.database)
          cqlWarnings = m.warnings ?? []
          // Mongo editor has no cursor paging (backend always returns None); keep
          // cqlNextPage null so the shared "Load next page" (cql_exec) never fires.
          cqlNextPage = null
          response = {
            ok: m.ok,
            result: m.result,
            affected: m.affected,
            duration_ms: m.duration_ms,
            error: m.error
              ? ({ ...m.error, statement_index: m.error.statement_index ?? index } satisfies QueryError)
              : undefined,
          }
        } else {
          // Large results come back in chunks so the webview's UI thread is never
          // blocked by one huge payload — that block is what froze every other tab
          // and made the Cancel button unclickable. Rows are accumulated in a
          // plain array (never a $state proxy) and attached to the response.
          const streamed: Record<string, unknown>[] = []
          exec.receivedRows = 0
          response = await ipc.execStatementStream(connId, stmt.sql, index, (chunk) => {
            for (const row of chunk.rows) streamed.push(row)
            exec.receivedRows = chunk.received
          })
          if (response.streamed && response.result) response.result.rows = streamed
        }
      } catch (e) {
        // IPC/infra-level failure (not a QueryError) — a command that rejected
        // before the statement ran ("not connected: …") also means the
        // connection is gone, so it gets the same Reconnect treatment.
        if (isConnectionLost(String(e))) this.noteConnectionLost(connId, String(e))
        const err: QueryError = {
          system: profile.system,
          statement_index: index,
          message: String(e),
          severity: 'error',
          raw: String(e),
        }
        buf.subs.push({
          index,
          label: `#${index} ✗ error`,
          kind: 'error',
          error: err,
          durationMs: 0,
          statement: stmt,
        })
        buf.msgs.push({
          index,
          ok: false,
          text: String(e),
          durationMs: 0,
          error: err,
          statement: stmt,
          kind: 'error',
        })
        buf.active = MESSAGES_TAB
        toasts.error(failureToast({ ok: false, index, error: err }, statements.length), profile.system)
        break
      }

      buf.totalMs += response.duration_ms

      // Track whether this statement left the connection inside a transaction —
      // a pinned snapshot (REPEATABLE READ) or uncommitted writes are exactly
      // what "the editor shows stale data" looks like, so it must be visible.
      if (response.ok && supportsTxn(profile.system)) {
        const eff = txnEffect(stmt.sql, profile.system)
        if (eff) this.txnOpen[connId] = eff === 'begin'
      }

      // Cassandra server warnings (e.g. ALLOW FILTERING full-scan) are non-fatal —
      // log them to Messages and toast, without failing the statement.
      for (const w of cqlWarnings) {
        buf.msgs.push({ index, ok: true, text: `⚠ ${w}`, durationMs: 0, statement: stmt, kind: 'warning' })
        toasts.show(w, { system: profile.system })
      }

      if (response.ok) {
        if (response.result) {
          // Freeze the rows array so Svelte does NOT deep-proxy it. Result rows are
          // an immutable snapshot (grid edits live in a separate Map; a new query
          // replaces the whole object), and a proxied 1M-row array makes every view
          // that scans rows — Chart's aggregation, JSON serialize — pay a proxy trap
          // on each element access (measured: Chart froze ~3.5s at 1M rows). Frozen
          // objects are Svelte's opt-out: `data.rows[i]` stays a raw object.
          Object.freeze(response.result.rows)
          const table = mainTableOf(stmt.sql)
          buf.subs.push({
            index,
            label: `#${index} ${table} · ${response.result.total.toLocaleString()} rows`,
            kind: 'rows',
            result: response.result,
            durationMs: response.duration_ms,
            statement: stmt,
            table,
            cqlNextPage,
            cqlConsistency: opts?.consistency,
          })
          buf.msgs.push({
            index,
            ok: true,
            text: `${response.result.total.toLocaleString()} ${response.result.total === 1 ? 'row' : 'rows'} returned`,
            durationMs: response.duration_ms,
            statement: stmt,
            kind: 'rows',
            rows: response.result.total,
          })
          // a result set gets its own tab — show the newest one as it arrives
          buf.active = exec.subResults.length + buf.subs.length - 1
          buf.lastRowCount = response.result.total
        } else if (response.affected != null) {
          buf.subs.push({
            index,
            label: `#${index} ✓ ${response.affected.toLocaleString()} affected`,
            kind: 'affected',
            affected: response.affected,
            durationMs: response.duration_ms,
            statement: stmt,
          })
          buf.msgs.push({
            index,
            ok: true,
            text: `${response.affected.toLocaleString()} ${response.affected === 1 ? 'row' : 'rows'} affected`,
            durationMs: response.duration_ms,
            statement: stmt,
            kind: 'affected',
            affected: response.affected,
          })
          buf.lastRowCount = response.affected
        } else {
          buf.subs.push({
            index,
            label: `#${index} ✓ OK`,
            kind: 'ok',
            durationMs: response.duration_ms,
            statement: stmt,
          })
          buf.msgs.push({
            index,
            ok: true,
            text: 'Completed',
            durationMs: response.duration_ms,
            statement: stmt,
            kind: 'ok',
          })
        }
      } else if (response.error) {
        const err = response.error
        buf.subs.push({
          index,
          label: `#${index} ✗ error`,
          kind: 'error',
          error: err,
          durationMs: response.duration_ms,
          statement: stmt,
        })
        buf.msgs.push({
          index,
          ok: false,
          text: err.message,
          durationMs: response.duration_ms,
          error: err,
          statement: stmt,
          kind: 'error',
        })
        // the failure must be visible: Messages lists it with its line + hint
        buf.active = MESSAGES_TAB
        if (err.code === 'CANCELLED') {
          exec.cancelled = true
          toasts.show('Query cancelled', { system: profile.system })
        } else {
          if (isConnectionLost(err)) this.noteConnectionLost(connId, err)
          const line = err.position ? mapErrorToDocument(stmt, err).line : undefined
          toasts.error(failureToast({ ok: false, index, error: err }, statements.length, line), profile.system)
        }
        break // sequential execution stops at the failing statement
      }
    }

    flush()
    exec.running = false
    exec.cancelling = false
    if (!exec.cancelled && exec.subResults.every((s) => s.kind !== 'error')) {
      toasts.success(successToast(exec.messages, exec.totalMs), profile.system)
    }
  }

  /** Cassandra "Load next page": fetch the next paging window for a rows sub-result
   *  and append it in place (never LIMIT/OFFSET). No-op for other engines / no token. */
  async fetchMoreCql(tabId: string, subIndex: number): Promise<void> {
    const exec = this.byTab[tabId]
    const sub = exec?.subResults[subIndex]
    if (!exec || !sub || sub.kind !== 'rows' || !sub.result || !sub.cqlNextPage) return
    try {
      const c = await ipc.cqlExec(exec.connId, sub.statement.sql, undefined, sub.cqlNextPage, sub.cqlConsistency)
      if (c.error) {
        toasts.error(c.error.message)
        return
      }
      if (c.result) {
        sub.result.rows = Object.freeze([...sub.result.rows, ...c.result.rows]) as Record<string, unknown>[]
        sub.result.total = sub.result.rows.length
        sub.label = `#${sub.index} ${sub.table ?? 'result'} · ${sub.result.total.toLocaleString()} rows`
      }
      sub.cqlNextPage = c.next_page ?? null
      for (const w of c.warnings ?? []) toasts.show(w)
    } catch (e) {
      toasts.error(`Load next page failed: ${e}`)
    }
  }

  async cancel(tabId: string, connId?: string) {
    const exec = this.byTab[tabId]
    if (!exec?.running) return
    // Cancel the connection the run actually went to. The caller's `connId` can
    // still be the base profile id — a per-tab (`{base}#tab-…`) or per-database
    // (`{base}::{db}`) connection is resolved asynchronously *after* Run is
    // pressed — and cancelling the base id aborts nothing at all.
    const target = exec.connId || connId
    if (!target) return
    exec.cancelling = true
    try {
      await ipc.cancelQuery(target)
    } catch (e) {
      exec.cancelling = false
      toasts.error(`Cancel failed: ${e}`)
    }
  }
}

export const results = new ResultsStore()
