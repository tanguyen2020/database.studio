// ScyllaDB demo (opt-in `?scylla=1`) — a Cassandra-engine connection whose server
// is ScyllaDB (SPEC-SCYLLADB.md §5). Its keyspace tree has the two ScyllaDB-only
// shapes the Explorer must handle: a CDC log under its base table and the
// tablets / vnodes replication mode.
import type { CassKeyspaceTree } from '$lib/ipc'

export const SCYLLA_DEMO_ID = 'sc1'

export function scyllaDemoEnabled(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('scylla') === '1'
}

/** True for the demo connection and any id derived from it (`sc1#tab-…`, `sc1::…`). */
export function isScyllaDemo(args: Record<string, unknown> | undefined): boolean {
  const id = String(args?.connId ?? '')
  return id === SCYLLA_DEMO_ID || id.startsWith(`${SCYLLA_DEMO_ID}#`) || id.startsWith(`${SCYLLA_DEMO_ID}::`)
}

const col = (name: string, data_type: string, kind = 'regular', position = -1, clustering_order = '') => ({
  name,
  data_type,
  kind,
  clustering_order,
  position,
})

export function scyllaDemoTree(keyspace: string): CassKeyspaceTree {
  return {
    keyspace,
    replication: "{ 'class': 'NetworkTopologyStrategy', 'datacenter1': '3' }",
    tablets: 'vnodes',
    tables: [
      { name: 'orders', columns: [col('order_id', 'uuid', 'partition_key', 0), col('customer', 'text'), col('total', 'decimal')] },
      {
        name: 'orders_scylla_cdc_log',
        cdc_of: 'orders',
        columns: [
          col('cdc$stream_id', 'blob', 'partition_key', 0),
          col('cdc$time', 'timeuuid', 'clustering', 0, 'asc'),
          col('cdc$batch_seq_no', 'int', 'clustering', 1, 'asc'),
          col('cdc$operation', 'tinyint'),
          col('order_id', 'uuid'),
          col('total', 'decimal'),
        ],
      },
      { name: 'page_hits', columns: [col('page', 'text', 'partition_key', 0), col('hits', 'counter')] },
    ],
    views: [{ name: 'orders_by_customer', base_table: 'orders' }],
    types: [],
    functions: [],
    indexes: [{ name: 'orders_total', table: 'orders', kind: 'COMPOSITES', target: 'total' }],
  }
}
