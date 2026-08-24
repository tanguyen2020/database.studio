// Dialect-flavoured SQL highlighting, plus a JSON language for the cell editor.
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

import type { MonacoApi } from './monaco'
import { SQL_SYSTEMS, editorLanguageId, mergeMonarchKeywords } from './dialect'

/** Language id for the JSON cell editor (Monaco's JSON support is a language
 *  service + worker; a plain monarch keeps the bundle lean and needs no worker). */
export const DS_JSON = 'ds-json'

let registered = false

/** Register the editor's languages. Safe to call more than once. */
export async function registerSqlMonarch(m: MonacoApi) {
  if (registered) return
  registered = true

  const [sql, mysql, pgsql] = await Promise.all([
    import('monaco-editor/esm/vs/basic-languages/sql/sql.js'),
    import('monaco-editor/esm/vs/basic-languages/mysql/mysql.js'),
    import('monaco-editor/esm/vs/basic-languages/pgsql/pgsql.js'),
  ])

  /** Closest Monaco tokenizer to build on: it knows the engine's quoting rules. */
  const baseFor = (system: string) => {
    switch (system) {
      case 'postgres':
        return pgsql
      case 'mysql':
      case 'mariadb':
        return mysql
      default:
        return sql
    }
  }

  for (const system of SQL_SYSTEMS) {
    const id = editorLanguageId(system)
    const base = baseFor(system)
    m.languages.register({ id })
    m.languages.setLanguageConfiguration(id, base.conf)
    m.languages.setMonarchTokensProvider(id, {
      ...base.language,
      keywords: mergeMonarchKeywords(base.language.keywords ?? [], system),
    })
  }

  registerJson(m)
}

/** Minimal JSON tokenizer: keys, strings, numbers, literals, punctuation. */
function registerJson(m: MonacoApi) {
  m.languages.register({ id: DS_JSON })
  m.languages.setLanguageConfiguration(DS_JSON, {
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  })
  m.languages.setMonarchTokensProvider(DS_JSON, {
    tokenizer: {
      root: [
        // a string immediately followed by a colon is a key
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
        [/"(?:[^"\\]|\\.)*"/, 'string.value'],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\],:]/, 'delimiter'],
        [/\s+/, 'white'],
      ],
    },
  })
}
