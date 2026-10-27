// The structure part of one table's script (Generate Scripts on a table's context
// menu): CREATE TABLE with its PRIMARY KEY / UNIQUE constraints, then every index.
// The Generate Scripts dialog does the same for many tables with one index read
// per schema (indexesByTable + genCreate there).

import * as ipc from '$lib/ipc'
import type { ColumnInfo } from '$lib/types'
import { genCreate } from './ddl'
import { indexesByTable } from './scripts'

export interface TableStructure {
  createSql: string
  indexSql: string[]
  /** a SQL comment when the indexes could not be read ('' otherwise) */
  warning: string
}

export async function tableStructure(
  connId: string,
  system: string,
  schema: string,
  table: string,
  cols: ColumnInfo[],
): Promise<TableStructure> {
  if (system === 'clickhouse') {
    // ClickHouse keeps engine, ORDER BY and data-skipping indexes in its own DDL.
    const ddl = await ipc.objectDefinition(connId, schema, 'table', table).catch(() => null)
    if (ddl) return { createSql: ddl.trimEnd().replace(/;?$/, ';'), indexSql: [], warning: '' }
    return { createSql: genCreate(system, schema, table, cols), indexSql: [], warning: '' }
  }
  try {
    const ix = indexesByTable(await ipc.listIndexDdl(connId, schema)).get(table)
    return {
      createSql: genCreate(system, schema, table, cols, { primaryKey: ix?.primaryKey, clauses: ix?.clauses }),
      indexSql: ix?.statements ?? [],
      warning: '',
    }
  } catch (e) {
    return {
      createSql: genCreate(system, schema, table, cols),
      indexSql: [],
      warning: `-- WARNING: the indexes of ${table} could not be read (${String(e).replace(/\s+/g, ' ')}).\n-- This script creates the table WITHOUT its indexes.\n\n`,
    }
  }
}
