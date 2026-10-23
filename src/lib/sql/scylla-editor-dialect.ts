// ScyllaDB dialect for the CQL editor: lang-sql's Cassandra dialect plus the
// words ScyllaDB adds to CQL (SPEC-SCYLLADB.md §3.5, probe P8). Used ONLY for
// Cassandra-engine connections whose server is ScyllaDB — a Cassandra tab keeps
// the plain Cassandra dialect, so it is never offered syntax Cassandra rejects.
import { Cassandra, SQLDialect } from '@codemirror/lang-sql'

// SELECT … BYPASS CACHE · SELECT … USING TIMEOUT 5s · PRUNE MATERIALIZED VIEW ·
// CREATE KEYSPACE … AND tablets = {…} · WITH cdc = {…} · tombstone_gc ·
// service levels (ATTACH/DETACH/LIST SERVICE LEVEL).
export const SCYLLA_KEYWORDS =
  'bypass cache timeout prune tablets cdc tombstone_gc service level levels attached effective'

const cs = Cassandra.spec

export const scyllaDialect = SQLDialect.define({
  ...cs,
  keywords: `${cs.keywords ?? ''} ${SCYLLA_KEYWORDS}`,
})
