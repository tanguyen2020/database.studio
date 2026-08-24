import { describe, expect, it } from 'vitest'
import { MSSQL, MySQL, PostgreSQL, SQLite, StandardSQL, PLSQL, Cassandra } from '@codemirror/lang-sql'
import { clickHouseDialect } from '$lib/sql/ch-editor-dialect'
import { sqlDialectFor } from './dialect'

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
