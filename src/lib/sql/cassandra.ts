// Pure CQL builders for Cassandra object management (Phase C5). Create/Alter open
// as editable CQL templates (review + run in the editor); Drop/Truncate produce
// the exact one-liner run behind an in-app confirm. Cassandra-only — never used by
// other engines. Kept pure so it is unit-testable without a cluster.

/** Objects a keyspace folder can create. */
export type CassCreateKind = 'table' | 'type' | 'materialized-view' | 'index' | 'keyspace'

/** Objects that can be dropped. */
export type CassDropKind =
  | 'keyspace'
  | 'table'
  | 'view'
  | 'type'
  | 'index'
  | 'function'
  | 'aggregate'

/**
 * A guided CQL skeleton for creating an object. `table` is required for `index`
 * (the target table) and used as the base for a materialized view.
 */
export function createTemplate(
  kind: CassCreateKind,
  keyspace: string,
  table?: string,
  opts: { scylla?: boolean } = {},
): string {
  switch (kind) {
    case 'keyspace':
      if (opts.scylla)
        // ScyllaDB (SPEC-SCYLLADB.md §3.5): tablets is the default on 6.x, and a
        // tablets keyspace cannot hold CDC, LWT (IF …) or counter tables.
        return (
          `CREATE KEYSPACE new_keyspace WITH replication = {\n` +
          `  'class': 'NetworkTopologyStrategy',\n` +
          `  'datacenter1': 3\n` +
          `} AND tablets = {'enabled': true};\n` +
          `-- tablets cannot hold CDC, lightweight transactions (IF …) or counters;\n` +
          `-- for those use: AND tablets = {'enabled': false}`
        )
      return (
        `CREATE KEYSPACE new_keyspace WITH replication = {\n` +
        `  'class': 'NetworkTopologyStrategy',\n` +
        `  'datacenter1': 3\n` +
        `};`
      )
    case 'table':
      return (
        `CREATE TABLE ${keyspace}.new_table (\n` +
        `  id uuid,\n` +
        `  created_at timestamp,\n` +
        `  -- add columns here\n` +
        `  PRIMARY KEY ((id))\n` +
        `) WITH CLUSTERING ORDER BY (created_at DESC);`
      )
    case 'type':
      return `CREATE TYPE ${keyspace}.new_type (\n  street text,\n  city text\n);`
    case 'materialized-view':
      return (
        `CREATE MATERIALIZED VIEW ${keyspace}.new_view AS\n` +
        `  SELECT *\n` +
        `  FROM ${keyspace}.${table ?? 'base_table'}\n` +
        `  WHERE partition_key IS NOT NULL AND clustering_key IS NOT NULL\n` +
        `  PRIMARY KEY (partition_key, clustering_key);`
      )
    case 'index':
      return `CREATE INDEX ON ${keyspace}.${table ?? 'table_name'} (column_name);`
  }
}

/** The exact `DROP …` statement (run behind a confirm). */
export function dropStatement(kind: CassDropKind, keyspace: string, name: string): string {
  switch (kind) {
    case 'keyspace':
      return `DROP KEYSPACE ${name};`
    case 'table':
      return `DROP TABLE ${keyspace}.${name};`
    case 'view':
      return `DROP MATERIALIZED VIEW ${keyspace}.${name};`
    case 'type':
      return `DROP TYPE ${keyspace}.${name};`
    case 'index':
      return `DROP INDEX ${keyspace}.${name};`
    case 'function':
      return `DROP FUNCTION ${keyspace}.${name};`
    case 'aggregate':
      return `DROP AGGREGATE ${keyspace}.${name};`
  }
}

/** `TRUNCATE ks.table;` — removes all rows, keeps the table. */
export function truncateStatement(keyspace: string, table: string): string {
  return `TRUNCATE ${keyspace}.${table};`
}

/**
 * A keyspace's replication map in plain words for the Explorer:
 * `{ 'class': 'NetworkTopologyStrategy', 'dc1': '3', 'dc2': '2' }` → "3 copies in dc1 · 2 in dc2",
 * SimpleStrategy rf 3 → "3 copies". Anything it cannot read comes back unchanged.
 */
export function replicationSummary(raw: string): string {
  const pairs = [...raw.matchAll(/'([^']+)'\s*:\s*'?([^',}]+)'?/g)].map((m) => [m[1], m[2].trim()] as const)
  if (!pairs.length) return raw
  const cls = (pairs.find(([k]) => k === 'class')?.[1] ?? '').split('.').pop() ?? ''
  const copies = (n: string) => `${n} ${n === '1' ? 'copy' : 'copies'}`
  if (cls === 'SimpleStrategy') {
    const rf = pairs.find(([k]) => k === 'replication_factor')?.[1]
    return rf ? copies(rf) : raw
  }
  const dcs = pairs.filter(([k]) => k !== 'class' && k !== 'replication_factor')
  if (!dcs.length) return raw
  return dcs.map(([dc, n], i) => (i === 0 ? `${copies(n)} in ${dc}` : `${n} in ${dc}`)).join(' · ')
}

/** ScyllaDB data distribution (`CassKeyspaceTree.tablets`) as a label. */
export function distributionLabel(tablets: string): string {
  if (tablets === 'vnodes') return 'Token ring (vnodes)'
  const initial = /initial (\d+)/.exec(tablets)?.[1]
  return initial ? `Tablets · ${initial} to start` : 'Tablets'
}

/** The short form for a narrow tree row: "3 copies" (one datacenter) or
 *  "5 copies · 2 datacenters". The full sentence goes in the tooltip. */
export function replicationShort(raw: string): string {
  const full = replicationSummary(raw)
  if (full === raw) return raw
  const counts = [...full.matchAll(/(\d+)(?: cop(?:y|ies))? in /g)].map((m) => Number(m[1]))
  if (counts.length <= 1) return full.replace(/ in .*$/, '')
  const total = counts.reduce((a, b) => a + b, 0)
  return `${total} copies · ${counts.length} datacenters`
}
