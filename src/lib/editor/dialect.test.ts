import { describe, expect, it } from 'vitest'
import { MSSQL, MySQL, PostgreSQL, SQLite, StandardSQL, PLSQL, Cassandra } from '@codemirror/lang-sql'
import { clickHouseDialect } from '$lib/sql/ch-editor-dialect'
import { SQL_SYSTEMS, dialectVocabulary, editorLanguageId, mergeMonarchKeywords, sqlDialectFor } from './dialect'

// The dialect drives keyword completion and how the text is tokenized for the
// schema source, so a system falling through to StandardSQL silently loses its
// own keywords (Oracle's PL/SQL and Cassandra's CQL used to do exactly that).
describe('sqlDialectFor', () => {
  it('maps every supported SQL system to its own dialect', () => {
    expect(sqlDialectFor('postgres')).toBe(PostgreSQL)
    expect(sqlDialectFor('mysql')).toBe(MySQL)
    expect(sqlDialectFor('mariadb')).toBe(MySQL) // MySQL superset for the editor
    expect(sqlDialectFor('mssql')).toBe(MSSQL)
    expect(sqlDialectFor('sqlite')).toBe(SQLite)
    expect(sqlDialectFor('oracle')).toBe(PLSQL)
    expect(sqlDialectFor('cassandra')).toBe(Cassandra)
    expect(sqlDialectFor('clickhouse')).toBe(clickHouseDialect)
  })

  it('falls back to StandardSQL only for systems without a SQL dialect', () => {
    expect(sqlDialectFor('mongodb')).toBe(StandardSQL)
    expect(sqlDialectFor('redis')).toBe(StandardSQL)
    expect(sqlDialectFor('')).toBe(StandardSQL)
  })

  it('gives Oracle and Cassandra the vocabulary their own dialect carries', () => {
    const words = (d: { spec: { keywords?: string; types?: string; builtin?: string } }) =>
      new Set(`${d.spec.keywords ?? ''} ${d.spec.types ?? ''} ${d.spec.builtin ?? ''}`.toLowerCase().split(/\s+/))
    // PL/SQL knows Oracle's own vocabulary; the fallback dialect declares none
    const oracle = words(sqlDialectFor('oracle'))
    expect(oracle.has('varchar2')).toBe(true)
    expect(oracle.size).toBeGreaterThan(100)
    expect(words(StandardSQL).has('varchar2')).toBe(false)
    // CQL words (keyspace, allow) only exist in the Cassandra dialect
    const cql = words(sqlDialectFor('cassandra'))
    expect(cql.has('keyspace')).toBe(true)
    expect(cql.has('allow')).toBe(true)
    expect(words(StandardSQL).has('keyspace')).toBe(false)
  })
})

describe('monarch language ids', () => {
  it('gives every SQL system its own language, and MongoDB JavaScript', () => {
    expect(editorLanguageId('postgres')).toBe('ds-postgres')
    expect(editorLanguageId('clickhouse')).toBe('ds-clickhouse')
    expect(editorLanguageId('oracle')).toBe('ds-oracle')
    expect(editorLanguageId('mongodb')).toBe('javascript')
    // an unknown/non-SQL system still gets a valid, registered id
    expect(editorLanguageId('redis')).toBe('ds-sql')
    expect(SQL_SYSTEMS.map(editorLanguageId)).toContain('ds-mssql')
  })

  it('ids are unique and all registered systems are covered', () => {
    const ids = SQL_SYSTEMS.map(editorLanguageId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(8)
  })
})

describe('mergeMonarchKeywords', () => {
  it('is a union: nothing Monaco used to colour is dropped', () => {
    const base = ['SELECT', 'FROM', 'ZZZ_ONLY_IN_MONACO']
    const merged = mergeMonarchKeywords(base, 'oracle')
    for (const w of base) expect(merged).toContain(w)
  })

  it('adds the dialect vocabulary Monaco is missing', () => {
    expect(mergeMonarchKeywords(['SELECT'], 'oracle')).toContain('varchar2')
    expect(mergeMonarchKeywords(['SELECT'], 'cassandra')).toContain('keyspace')
    expect(mergeMonarchKeywords(['SELECT'], 'clickhouse')).toContain('lowcardinality')
  })

  it('de-duplicates case-insensitively (monarch matches ignoring case)', () => {
    const merged = mergeMonarchKeywords(['SELECT', 'select'], 'postgres')
    const lower = merged.map((w) => w.toLowerCase())
    expect(new Set(lower).size).toBe(lower.length)
    expect(lower.filter((w) => w === 'select')).toHaveLength(1)
  })

  it('every SQL system contributes a non-trivial vocabulary', () => {
    for (const sys of SQL_SYSTEMS) expect(dialectVocabulary(sys).length, sys).toBeGreaterThan(50)
  })
})
