// Which SQL dialect drives the editor's completion for a connection type.
//
// The dialect decides two things: the keyword/type list offered by
// `keywordCompletionSource`, and how the SQL grammar tokenizes the text the
// schema source resolves against (so `alias.column`, quoted identifiers and
// comment syntax are read correctly). It is NOT what paints the text — that is
// Monaco's monarch tokenizer (see $lib/editor/monaco.monacoLanguage).
import {
  Cassandra,
  MSSQL,
  MySQL,
  PLSQL,
  PostgreSQL,
  SQLDialect,
  SQLite,
  StandardSQL,
} from '@codemirror/lang-sql'
import { clickHouseDialect } from '$lib/sql/ch-editor-dialect'

export function sqlDialectFor(system: string): SQLDialect {
  switch (system) {
    case 'postgres':
      return PostgreSQL
    case 'mysql':
    // MariaDB is a MySQL superset for everything the editor cares about, and
    // lang-sql's MariaSQL list is narrower — keep MySQL so MariaDB tabs keep the
    // full keyword set (its extra functions come from the function catalog).
    case 'mariadb':
      return MySQL
    case 'mssql':
      return MSSQL
    case 'sqlite':
      return SQLite
    case 'oracle':
      return PLSQL
    case 'cassandra':
      return Cassandra
    case 'clickhouse':
      return clickHouseDialect // lang-sql has no ClickHouse dialect → our own
    default:
      return StandardSQL
  }
}
