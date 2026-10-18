// Running DuckDB workspace statements over the normal query path
// (`exec_statement`): results as plain rows, errors as thrown messages the
// screens show verbatim (with the missing-extension hint when there is one).

import * as ipc from '$lib/ipc'
import type { ExecResponse } from '$lib/types'
import { missingExtension } from './sql'

export class DuckError extends Error {
  /** extension the error asks for (INSTALL/LOAD offer), if any */
  extension: string | null
  constructor(message: string) {
    super(message)
    this.extension = missingExtension(message)
  }
}

function fail(r: ExecResponse): never {
  throw new DuckError(r.error?.message ?? 'Statement failed')
}

/** Rows of a query (throws DuckError). */
export async function duckRows<T = Record<string, unknown>>(connId: string, sql: string): Promise<T[]> {
  const r = await ipc.execStatement(connId, sql)
  if (!r.ok) fail(r)
  return (r.result?.rows ?? []) as T[]
}

/** Run one statement; the affected row count when DuckDB reports one. */
export async function duckRun(connId: string, sql: string): Promise<{ affected: number | null; ms: number }> {
  const r = await ipc.execStatement(connId, sql)
  if (!r.ok) fail(r)
  return { affected: typeof r.affected === 'number' ? r.affected : null, ms: r.duration_ms }
}

/** Run statements in order, stopping at the first error. */
export async function duckRunAll(connId: string, sqls: string[]): Promise<void> {
  for (const s of sqls) await duckRun(connId, s)
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
