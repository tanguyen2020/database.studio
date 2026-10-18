// Reads one side of a Schema Compare: tables + columns, secondary indexes,
// routines/triggers (with their DDL) and sequences of the default schema.
//
// Speed: the old reader walked every table one after the other — two round-trips
// per table (columns, indexes) and one per routine, all serial. On a remote
// server that is N × RTT before anything shows. This reader:
//   * fetches the object lists (tables / routines / triggers / sequences) at once,
//   * runs the per-object reads through `mapPool`, and for a big schema on a
//     socket-per-connection engine opens a few EXTRA worker connections (same as
//     Generate Scripts) so the round-trips really overlap on the server,
//   * reports progress so the UI can show a bar instead of a frozen "Comparing…".
// Every per-object read stays best-effort: one failing object never wipes the
// comparison (it just compares as having no columns / no DDL).

import * as ipc from '$lib/ipc'
import { IS_TAURI } from '$lib/demo'
import { connections } from '$lib/stores/connections.svelte'
import { extraLanes, mapPool } from '$lib/util/pool'
import type { CmpIndex, CmpRoutine, CmpTable, SchemaSnapshot } from './diff'

export interface SnapshotProgress {
  done: number
  total: number
  label: string
}

export interface SnapshotOptions {
  onProgress?: (p: SnapshotProgress) => void
  /** Allow opening extra worker connections (off in unit tests / browser demo). */
  parallelConnections?: boolean
}

async function openLanes(connId: string, system: string, work: number, allowed: boolean): Promise<{ lanes: string[]; extra: string[] }> {
  const n = allowed ? extraLanes(system, work, 4) : 0
  if (!n) return { lanes: [connId], extra: [] }
  const tag = `compare-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const database = connections.databaseOf(connId) ?? ''
  const opened = await Promise.allSettled(Array.from({ length: n }, (_, i) => ipc.openTabConnection(connId, `${tag}-${i}`, database)))
  const extra = opened.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  return { lanes: [connId, ...extra], extra }
}

export async function takeSnapshot(connId: string, system: string, opts: SnapshotOptions = {}): Promise<SchemaSnapshot> {
  const report = opts.onProgress ?? (() => {})
  report({ done: 0, total: 0, label: 'Reading schema…' })
  const schemas = await ipc.listSchemas(connId).catch(() => [])
  const schema = schemas.find((s) => s.is_default)?.name ?? schemas[0]?.name ?? 'public'

  // The four object lists are independent — fetch them together.
  const [tblsAll, rs, tgs, seqs] = await Promise.all([
    ipc.listTables(connId, schema).catch(() => []),
    ipc.listRoutines(connId, schema).catch(() => []),
    ipc.listTriggers(connId, schema).catch(() => []),
    ipc.listSequences(connId, schema).catch(() => []),
  ])
  const tbls = tblsAll.filter((t) => t.kind !== 'system')

  const work = tbls.reduce((n, t) => n + (t.kind === 'view' ? 1 : 2), 0) + rs.length + tgs.length
  let done = 0
  const step = (label: string) => {
    done++
    report({ done, total: work, label })
  }
  report({ done, total: work, label: `Reading ${tbls.length} tables…` })

  const { lanes, extra } = await openLanes(connId, system, work, opts.parallelConnections ?? IS_TAURI)
  try {
    const tableParts = await mapPool(tbls, lanes.length, async (t, lane) => {
      const id = lanes[lane]
      const cols = await ipc.listColumns(id, schema, t.name).catch(() => [])
      step(`Columns of ${t.name}`)
      const table: CmpTable = {
        name: t.name,
        kind: t.kind === 'view' ? 'view' : 'table',
        columns: cols.map((c) => ({ name: c.name, type: c.data_type, nullable: c.nullable, pk: c.is_pk })),
      }
      const indexes: CmpIndex[] = []
      if (t.kind !== 'view') {
        // secondary indexes only — the primary key is part of the table itself
        const ix = await ipc.listIndexes(id, schema, t.name).catch(() => [])
        step(`Indexes of ${t.name}`)
        for (const i of ix) if (!i.primary) indexes.push({ name: i.name, table: t.name, columns: i.columns, unique: i.unique })
      }
      return { table, indexes }
    })

    const routineJobs: { name: string; kind: CmpRoutine['kind']; table?: string }[] = [
      ...rs.map((r) => ({ name: r.name, kind: (r.kind === 'procedure' ? 'procedure' : 'function') as CmpRoutine['kind'] })),
      ...tgs.map((t) => ({ name: t.name, kind: 'trigger' as const, table: t.table })),
    ]
    const routines = await mapPool(routineJobs, lanes.length, async (r, lane) => {
      const ddl = await ipc.objectDefinition(lanes[lane], schema, r.kind, r.name).catch(() => '')
      step(`Definition of ${r.name}`)
      const out: CmpRoutine = { name: r.name, kind: r.kind, ddl }
      if (r.table) out.table = r.table
      return out
    })

    const indexes = tableParts.flatMap((p) => p.indexes)
    // ClickHouse keeps data-skipping indexes in system.data_skipping_indices (not in
    // list_indexes) — read them from the Index Scanner. CH-only.
    if (system === 'clickhouse') {
      const scan = await ipc.scanIndexes(connId, schema).catch(() => null)
      for (const i of scan?.indexes ?? []) if (!i.primary) indexes.push({ name: i.name, table: i.table, columns: i.columns, unique: i.unique })
    }

    return {
      tables: tableParts.map((p) => p.table),
      indexes,
      routines,
      sequences: seqs.map((s) => s.name),
    }
  } finally {
    for (const id of extra) void ipc.closeTabConnection(id).catch(() => {})
  }
}
