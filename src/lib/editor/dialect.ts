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

/**
 * Every SQL system gets its OWN monarch language id, registered in
 * $lib/editor/monarch with the dialect's vocabulary merged in (see
 * mergeMonarchKeywords). MongoDB holds mongosh, so it stays on JavaScript.
 */
export function editorLanguageId(system: string): string {
  return system === 'mongodb' ? 'javascript' : `ds-${SQL_SYSTEMS.includes(system) ? system : 'sql'}`
}

/** Systems that get a dialect-flavoured SQL language of their own. */
export const SQL_SYSTEMS = [
  'postgres',
  'mysql',
  'mariadb',
  'mssql',
  'sqlite',
  'oracle',
  'cassandra',
  'clickhouse',
]

/** Keywords + type names the dialect declares, lower-cased and de-duplicated. */
export function dialectVocabulary(system: string): string[] {
  const spec = sqlDialectFor(system).spec
  const raw = `${spec.keywords ?? ''} ${spec.types ?? ''}`.toLowerCase().split(/\s+/)
  return [...new Set(raw.filter(Boolean))]
}

/**
 * Monarch keyword list for a system: Monaco's own list UNION the dialect's
 * vocabulary. A union only ever adds colour — dropping a word Monaco used to
 * paint would be a regression, and the two lists cover different ground
 * (Monaco's pgsql list has ~100 words, lang-sql's PostgreSQL dialect ~830).
 */
export function mergeMonarchKeywords(base: readonly string[], system: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of [...base, ...dialectVocabulary(system)]) {
    const k = w.toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(w)
  }
  return out
}
