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
export function createTemplate(kind: CassCreateKind, keyspace: string, table?: string): string {
  switch (kind) {
    case 'keyspace':
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
