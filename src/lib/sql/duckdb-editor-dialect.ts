// DuckDB dialect for the SQL completion sources. @codemirror/lang-sql has no
// DuckDB dialect; DuckDB's grammar is PostgreSQL-derived (double-quoted
// identifiers, `::` casts, `$$` strings), so this extends lang-sql's PostgreSQL
// dialect with DuckDB's own statements, clauses and types. Used ONLY for DuckDB
// connections (see $lib/editor/dialect.sqlDialectFor).
import { PostgreSQL, SQLDialect } from '@codemirror/lang-sql'

// DuckDB-only statements / clauses / join kinds (lower-case: matching is
// case-insensitive).
export const DUCKDB_KEYWORDS =
  'attach detach use summarize describe pivot unpivot pivot_wider pivot_longer qualify exclude replace columns ' +
  'asof positional anti semi lambda macro install load force checkpoint export import pragma ' +
  'read_only database databases schemas tables show sample using_sample reservoir bernoulli system ' +
  'struct_pack list_value map union_value try_cast'

// DuckDB native types and aliases.
export const DUCKDB_TYPES =
  'tinyint smallint integer int bigint hugeint utinyint usmallint uinteger ubigint uhugeint bignum varint ' +
  'float double real decimal numeric boolean bool varchar text string char bpchar blob bytea varbinary bit bitstring ' +
  'uuid json date time timetz timestamp timestamptz timestamp_s timestamp_ms timestamp_ns datetime interval ' +
  'list struct map union enum array'

const pg = PostgreSQL.spec

export const duckDbDialect = SQLDialect.define({
  ...pg,
  keywords: `${pg.keywords ?? ''} ${DUCKDB_KEYWORDS}`,
  types: `${pg.types ?? ''} ${DUCKDB_TYPES}`,
})
