// Query Editor safety: statement boundaries, the delete-confirm, the transaction
// badge, the "table not found" hint and error titles — each case here once ran
// the wrong thing or said the wrong thing.

import { describe, expect, it } from 'vitest'
import { splitStatements, statementAtOffset } from './statements'
import { classifyDanger, dangerousStatements } from './danger'
import { schemaLints } from './lint-client'
import { explainQueryError } from './error-explain'
import type { QueryError } from '$lib/types'

const S = (doc: string, sys?: string) => splitStatements(doc, sys).map((s) => s.sql)

describe('statement boundaries per dialect', () => {
  it('a CASE … END inside a routine does not close the routine', () => {
    expect(S('CREATE PROCEDURE p() BEGIN SET @v = CASE WHEN 1 THEN 1 ELSE 2 END; SELECT @v; END; SELECT 1;', 'mysql')).toEqual([
      'CREATE PROCEDURE p() BEGIN SET @v = CASE WHEN 1 THEN 1 ELSE 2 END; SELECT @v; END',
      'SELECT 1',
    ])
    // a CASE *statement* (END CASE) too, and a SQLite trigger
    expect(S('CREATE PROCEDURE p() BEGIN CASE x WHEN 1 THEN SELECT 1; END CASE; END; SELECT 2;', 'mysql')).toHaveLength(2)
    expect(S("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE b SET c = CASE WHEN 1 THEN 'x' END; END; SELECT 1;", 'sqlite')).toHaveLength(2)
  })

  it('SQL Server: BEGIN TRAN inside a procedure does not swallow the next statement', () => {
    const doc = 'CREATE PROCEDURE p AS BEGIN BEGIN TRAN; UPDATE t SET a=1; COMMIT; END;\nDELETE FROM audit_log;'
    expect(S(doc, 'mssql')).toEqual([
      'CREATE PROCEDURE p AS BEGIN BEGIN TRAN; UPDATE t SET a=1; COMMIT; END',
      'DELETE FROM audit_log',
    ])
    // …so the confirm sees the DELETE
    expect(dangerousStatements(splitStatements(doc, 'mssql'), 'mssql').map((d) => d.index)).toEqual([1])
  })

  it('SQL Server: IF … BEGIN … END is one statement, GO separates batches', () => {
    expect(S('IF 1 = 1 BEGIN SELECT 1; SELECT 2; END;\nSELECT 3;', 'mssql')).toEqual(['IF 1 = 1 BEGIN SELECT 1; SELECT 2; END', 'SELECT 3'])
    expect(S('CREATE TABLE t(a int)\nGO\nINSERT INTO t VALUES(1)\ngo 2\nSELECT 1', 'mssql')).toEqual([
      'CREATE TABLE t(a int)',
      'INSERT INTO t VALUES(1)',
      'SELECT 1',
    ])
    // a column named GO inside a line is not a separator
    expect(S('SELECT go FROM t;', 'mssql')).toEqual(['SELECT go FROM t'])
  })

  it('a backslash is an escape only where the engine says so', () => {
    // PostgreSQL / SQLite / SQL Server / Oracle: 'C:\' is a complete literal
    for (const sys of ['postgres', 'sqlite', 'mssql', 'oracle', 'duckdb']) {
      expect(S("SELECT 'C:\\';\nDELETE FROM logs;", sys), sys).toEqual(["SELECT 'C:\\'", 'DELETE FROM logs'])
    }
    // PostgreSQL E'…' strings do honour it
    expect(S("SELECT E'it\\'s';SELECT 2", 'postgres')).toEqual(["SELECT E'it\\'s'", 'SELECT 2'])
    // MySQL: \\ is an escaped backslash, \" inside a "…" string
    expect(S("SELECT REPLACE(p,'\\\\','/');SELECT 2", 'mysql')).toEqual(["SELECT REPLACE(p,'\\\\','/')", 'SELECT 2'])
    expect(S('SELECT "a\\"b";SELECT 2', 'mysql')).toEqual(['SELECT "a\\"b"', 'SELECT 2'])
  })

  it('MySQL # comments and DELIMITER scripts', () => {
    // the apostrophe inside the comment no longer opens a string that swallows the
    // rest; the comment stays attached to the statement after it (like `--`)
    expect(S("SELECT 1; # it's done\nSELECT 2;", 'mysql')).toEqual(['SELECT 1', "# it's done\nSELECT 2"])
    const doc = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();\nSELECT 3;'
    expect(S(doc, 'mysql')).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()', 'SELECT 3'])
  })

  it('Oracle: PL/SQL blocks with a leading comment, and a column named type', () => {
    expect(S('-- fix\nBEGIN\n  UPDATE t SET a = 1;\n  UPDATE t SET b = 2;\nEND;\n/\nSELECT 1 FROM dual', 'oracle')).toEqual([
      '-- fix\nBEGIN\n  UPDATE t SET a = 1;\n  UPDATE t SET b = 2;\nEND;',
      'SELECT 1 FROM dual',
    ])
    expect(S('CREATE TABLE t (id NUMBER, type VARCHAR2(10));\nINSERT INTO t VALUES (1, 2);\nSELECT * FROM t;', 'oracle')).toHaveLength(3)
  })

  it('Ctrl+Enter inside an Oracle block runs the whole block', () => {
    const doc = 'BEGIN\n UPDATE t SET a=1;\n UPDATE t SET b=2;\nEND;\n/'
    expect(statementAtOffset(doc, doc.indexOf('b=2'), 'oracle')?.sql).toBe('BEGIN\n UPDATE t SET a=1;\n UPDATE t SET b=2;\nEND;')
  })

  it('PostgreSQL nested block comments', () => {
    expect(S('/* a /* b */ c; */ SELECT 1; SELECT 2', 'postgres')).toEqual(['/* a /* b */ c; */ SELECT 1', 'SELECT 2'])
  })

  it('a statement made only of comments is not run, and Ctrl+Enter on it picks the previous one', () => {
    expect(S('SELECT 1;\n-- done', 'postgres')).toEqual(['SELECT 1'])
    expect(S('SELECT 1;\n/* x */;', 'postgres')).toEqual(['SELECT 1'])
    expect(S("SELECT 1;\n# note\n", 'mysql')).toEqual(['SELECT 1'])
    const doc = 'SELECT 1;\n-- next: cleanup'
    expect(statementAtOffset(doc, doc.length, 'postgres')?.sql).toBe('SELECT 1')
  })
})

describe('delete-confirm', () => {
  it('flags a DELETE without its own WHERE wherever it sits', () => {
    for (const q of [
      'DELETE FROM orders',
      'WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d',
      'WITH x AS (SELECT 1) DELETE FROM orders',
      'EXPLAIN ANALYZE DELETE FROM orders',
      'EXPLAIN (ANALYZE, BUFFERS) DELETE FROM orders',
      'DELETE FROM orders USING (SELECT id FROM vip WHERE id > 0) v',
      'DELETE FROM t RETURNING $$where$$',
      'IF 1 = 1 BEGIN SELECT 1 END\nDELETE FROM audit_log',
    ]) {
      expect(classifyDanger(q, 'postgres'), q).toBe('delete')
    }
  })

  it('does not flag what deletes nothing on its own', () => {
    for (const q of [
      'DELETE FROM orders WHERE id = 1',
      'WITH d AS (DELETE FROM orders WHERE id = 1 RETURNING *) SELECT * FROM d',
      'EXPLAIN DELETE FROM orders', // plans, does not run
      'CREATE TABLE a (b int REFERENCES c ON DELETE CASCADE)',
      'GRANT SELECT, INSERT, DELETE ON t TO u',
      'CREATE TRIGGER x AFTER INSERT OR DELETE ON t FOR EACH ROW EXECUTE FUNCTION f()',
      "SELECT 'delete from orders'",
      'SELECT 1 -- delete from orders',
    ]) {
      expect(classifyDanger(q, 'postgres'), q).toBeNull()
    }
    expect(classifyDanger('GRANT TRUNCATE ON t TO u', 'postgres')).toBeNull()
    expect(classifyDanger('TRUNCATE TABLE t', 'postgres')).toBe('truncate')
  })
})

describe('table-not-found hint', () => {
  const hits = (doc: string, sys = 'postgres') => schemaLints(doc, ['students'], sys).map((d) => doc.slice(d.from, d.to))
  it('ignores functions, CTEs, clauses, comments and strings', () => {
    expect(hits('SELECT EXTRACT(YEAR FROM created_at), TRIM(BOTH \' \' FROM name) FROM students')).toEqual([])
    expect(hits('WITH recent AS (SELECT 1) SELECT * FROM recent')).toEqual([])
    expect(hits('INSERT INTO students VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 1')).toEqual([])
    expect(hits('INSERT INTO students VALUES (1) ON DUPLICATE KEY UPDATE qty = 1', 'mysql')).toEqual([])
    expect(hits('SELECT * FROM students FOR UPDATE NOWAIT')).toEqual([])
    expect(hits("SELECT 'copied from backup' FROM students -- select from archive")).toEqual([])
    expect(hits('SELECT a IS DISTINCT FROM b FROM students')).toEqual([])
  })
  it('still flags a real unknown table, at the right place', () => {
    expect(hits('SELECT * FROM studnets')).toEqual(['studnets'])
    expect(hits('-- a comment first\nUPDATE ghost SET a = 1')).toEqual(['ghost'])
  })
})

describe('error titles', () => {
  const title = (e: Partial<QueryError>) => explainQueryError({ system: 'sqlite', severity: 'error', raw: '', message: '', ...e } as QueryError).title
  it('a column named "cancelled" is not a cancelled query', () => {
    expect(title({ message: 'NOT NULL constraint failed: orders.cancelled' })).not.toBe('Query cancelled')
    expect(title({ system: 'mysql', code: '23000', message: "Duplicate entry '7' for key 'orders.cancelled'" })).not.toBe('Query cancelled')
  })
  it('a real cancel still is', () => {
    expect(title({ code: 'CANCELLED', message: 'cancelled' })).toBe('Query cancelled')
    expect(title({ system: 'postgres', message: 'canceling statement due to user request' })).toBe('Query cancelled')
    expect(title({ system: 'duckdb', message: 'INTERRUPT Error: Interrupted!' })).toBe('Query cancelled')
  })
})
