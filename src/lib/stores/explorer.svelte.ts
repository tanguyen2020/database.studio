// Object Explorer cache — lazy-loaded catalog data per connection, with
// per-node refresh (no full-tree reloads).

import * as ipc from '$lib/ipc'
import { toasts } from '$lib/stores/toast.svelte'
import type {
  ColumnInfo,
  ConstraintInfo,
  IndexInfo,
  PartitionInfo,
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
  partitions?: PartitionInfo[]
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

/** Streaming (Kafka/NATS) explorer cache — topics / JetStream streams per conn. */
export interface StreamingCache {
  kafkaTopics?: ipc.KafkaTopic[]
  natsStreams?: ipc.NatsJsStream[]
  loading: boolean
  error?: string
}

class ExplorerStore {
  cache = $state<Record<string, ConnCache>>({})
  streaming = $state<Record<string, StreamingCache>>({})
  // Redis: a per-connection tick the sidebar key browser watches so it reloads the
  // key list after a mutation from a key-viewer tab (delete / add / TTL change).
  redisTick = $state<Record<string, number>>({})
  bumpRedis(connId: string) {
    this.redisTick[connId] = (this.redisTick[connId] ?? 0) + 1
  }
  // NATS: a per-(conn,stream,subject) tick the open subject-messages tab watches so it
  // reloads (→ shows empty) after the sidebar purges that subject's messages.
  natsMsgTick = $state<Record<string, number>>({})
  bumpNatsSubject(connId: string, stream: string, subject: string) {
    const k = `${connId}:${stream}:${subject}`
    this.natsMsgTick[k] = (this.natsMsgTick[k] ?? 0) + 1
  }
  // The schema/database node currently selected in the tree (public / dbo / a database).
  // Drives the enabled state of the sidebar "View ER" / "Generate Scripts" toolbar
  // buttons: `connId` is the connection to act on (a sub-connection for a foreign
  // database), `base` is the owning sidebar connection used to match the selection.
  selectedSchema = $state<{ connId: string; base: string; system: string; schema: string } | null>(null)

  // The database the current tree selection points at, for binding a NEW Query
  // Editor tab (sidebar "New query console"). Resolved from the selection's name
  // alone — no sub-connection needed — so it works on single-click of any node.
  // `base` is the owning sidebar connection used to match the selection.
  selectedDatabase = $state<{ base: string; database: string } | null>(null)

  /** Load Kafka topics / NATS streams for the streaming explorer tree. */
  async loadStreaming(connId: string, system: string, force = false) {
    const cur = this.streaming[connId]
    if (cur && (cur.kafkaTopics || cur.natsStreams) && !force) return
    this.streaming[connId] = { ...(cur ?? {}), loading: true, error: undefined }
    try {
      if (system === 'kafka') {
        const kafkaTopics = await ipc.kafkaTopics(connId)
        this.streaming[connId] = { kafkaTopics, loading: false }
      } else if (system === 'nats') {
        const natsStreams = await ipc.natsJsStreams(connId)
        this.streaming[connId] = { natsStreams, loading: false }
      } else {
        this.streaming[connId] = { loading: false }
      }
    } catch (e) {
      this.streaming[connId] = { ...(this.streaming[connId] ?? { loading: false }), loading: false, error: String(e) }
    }
  }

  /** Reload streaming metadata (after create/delete/purge). */
  refreshStreaming(connId: string) {
    const system = this.streaming[connId]?.kafkaTopics ? 'kafka' : this.streaming[connId]?.natsStreams ? 'nats' : ''
    if (system) void this.loadStreaming(connId, system, true)
  }

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
    if (force) sc.tableDetails = {}
    await this.track(connId, `schema:${schema}`, async () => {
      // Load each object list INDEPENDENTLY and assign as soon as it resolves:
      //  - tables appear immediately (don't wait for slower routines/triggers),
      //  - one failing query (e.g. MSSQL triggers on SQL Server < 2017) doesn't
      //    blank the rest — it just falls back to [] and reports which failed.
      const failed: string[] = []
      const load = <T>(label: string, assign: (v: T[]) => void, p: Promise<T[]>): Promise<void> =>
        p.then(assign, (e) => {
          failed.push(label)
          console.error(`loadSchemaChildren ${label} failed:`, e)
          assign([])
        })
      await Promise.all([
        load('tables', (v) => (sc.tables = v), ipc.listTables(connId, schema)),
        load('routines', (v) => (sc.routines = v), ipc.listRoutines(connId, schema)),
        load('triggers', (v) => (sc.triggers = v), ipc.listTriggers(connId, schema)),
        load('sequences', (v) => (sc.sequences = v), ipc.listSequences(connId, schema)),
      ])
      if (failed.length) toasts.error(`Some objects failed to load (${failed.join(', ')})`)
    })
  }

  async loadTableDetail(connId: string, schema: string, table: string, force = false) {
    const sc = this.schema(connId, schema)
    if (sc.tableDetails[table]?.columns && !force) return
    await this.track(connId, `table:${schema}.${table}`, async () => {
      // allSettled, NOT Promise.all: index/constraint introspection can fail on some
      // engines/servers, and Promise.all would then discard the columns that loaded
      // fine — so a table would expand to nothing. Columns are what matter most; keep
      // them even when indexes/constraints error (item 4 — columns for every engine).
      const [colsR, idxR, consR, partR] = await Promise.allSettled([
        ipc.listColumns(connId, schema, table),
        ipc.listIndexes(connId, schema, table),
        ipc.listConstraints(connId, schema, table),
        ipc.listPartitions(connId, schema, table),
      ])
      sc.tableDetails[table] = {
        columns: colsR.status === 'fulfilled' ? colsR.value : [],
        indexes: idxR.status === 'fulfilled' ? idxR.value : [],
        constraints: consR.status === 'fulfilled' ? consR.value : [],
        partitions: partR.status === 'fulfilled' ? partR.value : [],
      }
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
