// Data Transfer (multi-table, cross-connection) — pure planning on top of the
// Copy Table (T25) building blocks. Given the picked source tables, their
// columns, the source FKs (for order) and the destination options, produce the
// ordered list of steps the dialog runs (create DDL + per-table clear/append).
// Pure → unit-testable; the dialog runs each step with the same paged
// read→insert→verify loop Copy Table already uses.
import type { ColumnInfo } from '$lib/types'
import type { ForeignKey } from '$lib/ipc'
import { buildCopyDdl } from '$lib/copy/types'
import { orderObjects, type DbObject } from '$lib/sql/scripts'
import { qualified, quoteIdent } from '$lib/sql/dialect'

/** What to do with each destination table. */
export type TransferMode =
  | 'create' // CREATE TABLE (fails if it already exists)
  | 'create-if-missing' // create only when the destination table is absent
  | 'append' // table must exist; just insert rows
  | 'replace' // clear the destination table first, then insert (create if missing)

export interface TransferTable {
  name: string
  cols: ColumnInfo[]
  /** destination table name (defaults to the source name) */
  destName?: string
  /** per-table WHERE body (no WHERE keyword); blank → all rows */
  where?: string
}

export interface TransferPlanInput {
  tables: TransferTable[]
  /** foreign keys of the SOURCE schema — used to order parents before children */
  foreignKeys: ForeignKey[]
  destSystem: string
  destSchema: string
  mode: TransferMode
  /** false → create structure only, copy no rows */
  copyData: boolean
}

export interface TransferStep {
  srcTable: string
  destTable: string
  mode: TransferMode
  /** CREATE TABLE DDL (empty for a pure append) */
  ddl: string
  /** statement that empties the destination before inserting (replace only) */
  clearSql: string
  where: string
  copyData: boolean
  /** columns to copy, in order */
  columns: string[]
}

/** Statement that empties a table before a replace. SQLite has no TRUNCATE. */
export function clearStatement(system: string, schema: string, table: string): string {
  const t = system === 'sqlite' && schema === 'main' ? quoteIdent(system, table) : qualified(system, schema, table)
  return system === 'sqlite' ? `DELETE FROM ${t};` : `TRUNCATE TABLE ${t};`
}

/**
 * Order the picked tables so a referenced (parent) table is created before the
 * table that points at it, then build each step. Only FKs between picked tables
 * matter (a reference to an un-picked table is ignored — the user did not ask to
 * copy it). Cycle-safe (orderObjects skips back edges).
 */
export function planTransfer(input: TransferPlanInput): TransferStep[] {
  const picked = new Set(input.tables.map((t) => t.name))
  const byName = new Map(input.tables.map((t) => [t.name, t]))

  // deps[child] = {parents it references among the picked tables}
  const deps = new Map<string, Set<string>>()
  for (const t of input.tables) deps.set(t.name, new Set())
  for (const fk of input.foreignKeys) {
    if (fk.from_table === fk.to_table) continue // self-reference: no ordering constraint
    if (picked.has(fk.from_table) && picked.has(fk.to_table)) {
      deps.get(fk.from_table)!.add(fk.to_table)
    }
  }

  const objs: DbObject[] = input.tables.map((t) => ({
    name: t.name,
    kind: 'table',
    createSql: '',
    deps: [...(deps.get(t.name) ?? [])],
  }))
  const ordered = orderObjects(objs)

  const createDdl = input.mode === 'append'
  return ordered.map((o): TransferStep => {
    const t = byName.get(o.name)!
    const destTable = (t.destName ?? t.name).trim() || t.name
    const needsDdl = !createDdl // append = never create
    return {
      srcTable: t.name,
      destTable,
      mode: input.mode,
      ddl: needsDdl ? buildCopyDdl(input.destSystem, input.destSchema, destTable, t.cols) : '',
      clearSql: input.mode === 'replace' ? clearStatement(input.destSystem, input.destSchema, destTable) : '',
      where: (t.where ?? '').trim(),
      copyData: input.copyData,
      columns: t.cols.map((c) => c.name),
    }
  })
}
