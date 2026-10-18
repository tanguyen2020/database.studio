// What a run did, in one line — used by the toast and the Messages headline so
// both say the same thing. "Ran 3 statement(s) · 45 ms" told nobody whether rows
// were written or how many came back; this names the outcome.
// Pure → unit-testable.

import { explainQueryError } from '$lib/sql/error-explain'
import type { QueryError } from '$lib/types'

export interface OutcomeLike {
  ok: boolean
  kind?: 'rows' | 'affected' | 'ok' | 'error' | 'warning'
  rows?: number
  affected?: number
  index: number
  error?: QueryError
}

export interface RunCounts {
  /** statements that finished (ok or failed) — warnings are not statements */
  done: number
  succeeded: number
  failed: number
  /** statements in the script that never ran because an earlier one failed/was cancelled */
  notRun: number
  affected: number
  resultSets: number
  rowsReturned: number
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

export function countRun(messages: OutcomeLike[], total?: number): RunCounts {
  const stmts = messages.filter((m) => m.kind !== 'warning')
  const failed = stmts.filter((m) => !m.ok).length
  return {
    done: stmts.length,
    succeeded: stmts.length - failed,
    failed,
    notRun: total != null ? Math.max(0, total - stmts.length) : 0,
    affected: stmts.reduce((n, m) => n + (m.affected ?? 0), 0),
    resultSets: stmts.filter((m) => m.kind === 'rows').length,
    rowsReturned: stmts.reduce((n, m) => n + (m.kind === 'rows' ? (m.rows ?? 0) : 0), 0),
  }
}

/** What the run produced, without the "succeeded" part: "14 rows affected · 2 result sets". */
export function outcomeFacts(c: RunCounts): string[] {
  const facts: string[] = []
  if (c.affected) facts.push(`${plural(c.affected, 'row')} affected`)
  if (c.resultSets === 1) facts.push(`${plural(c.rowsReturned, 'row')} returned`)
  else if (c.resultSets > 1) facts.push(plural(c.resultSets, 'result set'))
  return facts
}

/** Toast text for a run that finished without errors. */
export function successToast(messages: OutcomeLike[], totalMs: number): string {
  const c = countRun(messages)
  const ms = `${totalMs.toLocaleString('en-US')} ms`
  if (c.done === 1) {
    const m = messages.find((x) => x.kind !== 'warning')
    if (m?.kind === 'rows') return `Query returned ${plural(m.rows ?? 0, 'row')} · ${ms}`
    if (m?.kind === 'affected') return `${plural(m.affected ?? 0, 'row')} affected · ${ms}`
    return `Statement completed · ${ms}`
  }
  return [`${plural(c.succeeded, 'statement')} succeeded`, ...outcomeFacts(c), ms].join(' · ')
}

/** Toast text for a failed statement: which one, what kind of error, the server's words. */
export function failureToast(failed: OutcomeLike, total: number, line?: number): string {
  const ex = failed.error ? explainQueryError(failed.error) : null
  const where = total > 1 ? `Statement #${failed.index}` : 'Query'
  const at = line != null ? ` (line ${line})` : ''
  if (!ex) return `${where} failed${at}`
  return `${where} failed${at} — ${ex.title}: ${ex.message}`
}
