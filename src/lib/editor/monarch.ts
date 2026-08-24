// Dialect-flavoured SQL highlighting.
//
// Monaco ships three SQL monarch tokenizers (sql, mysql, pgsql), so MSSQL,
// SQLite, ClickHouse, Oracle and Cassandra all fell back to the generic `sql`
// list — their own vocabulary (`LowCardinality`, `varchar2`, `keyspace`, …) was
// painted as a plain identifier. Here every SQL system gets its own language id
// whose keyword list is Monaco's list UNION the dialect's (see
// mergeMonarchKeywords): the tokenizer RULES stay Monaco's — only the words grow,
// so nothing that used to be coloured stops being coloured.
//
// This is display only. Completion comes from the lang-sql sources (see
// cm-headless), and feeding function names to a *tokenizer* is what once broke
// table completion, so the lists here never reach it.

import { conf as sqlConf, language as sqlLang } from 'monaco-editor/esm/vs/basic-languages/sql/sql.js'
import { conf as mysqlConf, language as mysqlLang } from 'monaco-editor/esm/vs/basic-languages/mysql/mysql.js'
import { conf as pgsqlConf, language as pgsqlLang } from 'monaco-editor/esm/vs/basic-languages/pgsql/pgsql.js'
import { monaco } from './monaco'
import { SQL_SYSTEMS, editorLanguageId, mergeMonarchKeywords } from './dialect'

type MonarchBase = { conf: monaco.languages.LanguageConfiguration; lang: monaco.languages.IMonarchLanguage }

/** Closest Monaco tokenizer to build on: it knows the engine's quoting rules. */
function baseFor(system: string): MonarchBase {
  switch (system) {
    case 'postgres':
      return { conf: pgsqlConf, lang: pgsqlLang }
    case 'mysql':
    case 'mariadb':
      return { conf: mysqlConf, lang: mysqlLang }
    default:
      return { conf: sqlConf, lang: sqlLang }
  }
}

let registered = false

/** Register one language per SQL system. Safe to call more than once. */
export function registerSqlMonarch() {
  if (registered) return
  registered = true
  for (const system of SQL_SYSTEMS) {
    const id = editorLanguageId(system)
    const { conf, lang } = baseFor(system)
    const base = (lang as { keywords?: string[] }).keywords ?? []
    monaco.languages.register({ id })
    monaco.languages.setLanguageConfiguration(id, conf)
    monaco.languages.setMonarchTokensProvider(id, { ...lang, keywords: mergeMonarchKeywords(base, system) })
  }
}
