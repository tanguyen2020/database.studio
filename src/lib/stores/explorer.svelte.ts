// Object Explorer cache — lazy-loaded catalog data per connection, with
// per-node refresh (no full-tree reloads).

import * as ipc from '$lib/ipc'
import { toasts } from '$lib/stores/toast.svelte'
import type {
  ColumnInfo,
  ConstraintInfo,
  IndexInfo,
  RoutineInfo,
  SchemaInfo,
  SequenceInfo,
  TableInfo,
  TriggerInfo,
} from '$lib/types'

export interface TableDetail {
  columns?: ColumnInfo[]
  indexes?: IndexInfo[]
  constraints?: ConstraintInfo[]
}

export interface SchemaCache {
  tables?: TableInfo[]
  routines?: RoutineInfo[]
  triggers?: TriggerInfo[]
  sequences?: SequenceInfo[]
  /** keyed by table name */
  tableDetails: Record<string, TableDetail>
}

export interface ConnCache {
  schemas?: SchemaInfo[]
  /** all databases on the server (Postgres) — `current` marks the connected one */
  databases?: ipc.DatabaseInfo[]
  /** keyed by schema name */
  bySchema: Record<string, SchemaCache>
  loading: Set<string>
  error?: string
}

class ExplorerStore {
  cache = $state<Record<string, ConnCache>>({})

  private conn(connId: string): ConnCache {
    if (!this.cache[connId]) {
      this.cache[connId] = { bySchema: {}, loading: new Set() }
    }
    return this.cache[connId]
  }

  private schema(connId: string, schema: string): SchemaCache {
    const c = this.conn(connId)
    if (!c.bySchema[schema]) {
      c.bySchema[schema] = { tableDetails: {} }
    }
    return c.bySchema[schema]
  }

  isLoading(connId: string, key: string): boolean {
    return this.cache[connId]?.loading.has(key) ?? false
  }

  private async track<T>(connId: string, key: string, work: () => Promise<T>): Promise<T | null> {
    const c = this.conn(connId)
    c.loading = new Set([...c.loading, key])
    c.error = undefined
    try {
      return await work()
    } catch (e) {
      c.error = String(e)
      return null
    } finally {
      const next = new Set(c.loading)
      next.delete(key)
      c.loading = next
    }
  }

  async loadSchemas(connId: string, force = false) {
    const c = this.conn(connId)
    if (c.schemas && !force) return
    await this.track(connId, 'schemas', async () => {
      c.schemas = await ipc.listSchemas(connId)
    })
  }

  /** Load the server's database list (Postgres). Best-effort — failures are
   *  swallowed so a missing privilege doesn't blank the whole tree. */
  async loadDatabases(connId: string, force = false) {
    const c = this.conn(connId)
    if (c.databases && !force) return
    try {
      c.databases = await ipc.listDatabases(connId)
    } catch {
      c.databases = []
    }
  }

  async loadSchemaChildren(connId: string, schema: string, force = false) {
    const sc = this.schema(connId, schema)
    if (sc.tables && !force) return
    await this.track(connId, `schema:${schema}`, async () => {
      // Resilient: one failing introspection query (e.g. MSSQL triggers() uses
      // STRING_AGG which errors on SQL Server < 2017) must NOT blank the whole
      // schema — load each independently and keep what succeeds.
      const failed: string[] = []
      const safe = async <T>(label: string, p: Promise<T[]>): Promise<T[]> => {
        try {
          return await p
        } catch (e) {
          failed.push(label)
          console.error(`loadSchemaChildren ${label} failed:`, e)
          return []
        }
      }
      const [tables, routines, triggers, sequences] = await Promise.all([
        safe('tables', ipc.listTables(connId, schema)),
        safe('routines', ipc.listRoutines(connId, schema)),
        safe('triggers', ipc.listTriggers(connId, schema)),
        safe('sequences', ipc.listSequences(connId, schema)),
      ])
      sc.tables = tables
      sc.routines = routines
      sc.triggers = triggers
      sc.sequences = sequences
      if (force) sc.tableDetails = {}
      if (failed.length) toasts.error(`Some objects failed to load (${failed.join(', ')})`)
    })
  }

  async loadTableDetail(connId: string, schema: string, table: string, force = false) {
    const sc = this.schema(connId, schema)
    if (sc.tableDetails[table]?.columns && !force) return
    await this.track(connId, `table:${schema}.${table}`, async () => {
      const [columns, indexes, constraints] = await Promise.all([
        ipc.listColumns(connId, schema, table),
        ipc.listIndexes(connId, schema, table),
        ipc.listConstraints(connId, schema, table),
      ])
      sc.tableDetails[table] = { columns, indexes, constraints }
    })
  }

  /** Refresh a single node without touching siblings. */
  async refresh(connId: string, node: { kind: 'connection' | 'schema' | 'table'; schema?: string; table?: string }) {
    switch (node.kind) {
      case 'connection': {
        const c = this.conn(connId)
        c.schemas = undefined
        c.bySchema = {}
        await this.loadSchemas(connId, true)
        break
      }
      case 'schema':
        await this.loadSchemaChildren(connId, node.schema!, true)
        break
      case 'table':
        await this.loadTableDetail(connId, node.schema!, node.table!, true)
        break
    }
  }

  /** Drop all cache for a connection (disconnect / reconnect / delete). */
  invalidate(connId: string) {
    delete this.cache[connId]
  }
}

export const explorer = new ExplorerStore()
