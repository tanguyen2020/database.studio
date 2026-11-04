// The Query Editor's statement splitter, checked against REAL engines.
//
// Each case is a script a user could type. The statements the splitter cuts it
// into are written to src-tauri/tests/fixtures/editor-scripts.json; the Rust
// integration test (tests/editor_scripts_integration.rs) runs exactly those
// statements, one by one like the editor does, on a container of that engine and
// then runs the checks. A wrong cut (a DELETE hidden inside a procedure body, a
// routine chopped at an inner `;`) fails there.
//
// After an intentional change: WRITE_SPLIT_FIXTURE=1 npx vitest run src/lib/sql/editor-scripts
// rewrites the fixture; then run the integration test.

import { describe, expect, it } from 'vitest'
import fixtureText from '../../../src-tauri/tests/fixtures/editor-scripts.json?raw'
import { dangerousStatements } from './danger'
import { splitStatements } from './statements'

interface Case {
  system: 'postgres' | 'mysql' | 'mssql' | 'oracle'
  name: string
  script: string
  /** first cell of the first row of `sql`, as text */
  checks: { sql: string; expect: string }[]
  /** statements the delete-confirm must flag (0-based) */
  dangerous?: number[]
}

const CASES: Case[] = [
  {
    system: 'postgres',
    name: "a backslash before the closing quote does not hide the next statement",
    script: "CREATE TABLE pg_logs (p text);\nINSERT INTO pg_logs VALUES ('C:\\'), ('x');\nSELECT 'C:\\';\nDELETE FROM pg_logs WHERE p = 'x';",
    checks: [
      { sql: 'SELECT count(*) FROM pg_logs', expect: '1' },
      { sql: 'SELECT p FROM pg_logs', expect: 'C:\\' },
    ],
  },
  {
    system: 'postgres',
    name: 'nested comments, dollar-quoted bodies and E-strings',
    script:
      "/* setup /* nested */ still a comment; */ CREATE FUNCTION f_one() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql;\nCREATE TABLE pg_e (s text);\nINSERT INTO pg_e VALUES (E'it\\'s');\n-- trailing note",
    checks: [
      { sql: 'SELECT f_one()', expect: '1' },
      { sql: 'SELECT s FROM pg_e', expect: "it's" },
    ],
  },
  {
    system: 'postgres',
    name: 'a DELETE inside a CTE is flagged',
    script: 'CREATE TABLE pg_d (id int);\nINSERT INTO pg_d VALUES (1), (2);\nWITH gone AS (DELETE FROM pg_d RETURNING *) SELECT count(*) FROM gone;',
    checks: [{ sql: 'SELECT count(*) FROM pg_d', expect: '0' }],
    dangerous: [2],
  },
  {
    system: 'mysql',
    name: 'DELIMITER, CASE inside a procedure, # comments and backslash escapes',
    script: [
      'CREATE TABLE my_t (a int);',
      'DELIMITER $$',
      'CREATE PROCEDURE p_case(IN x INT) BEGIN',
      '  DECLARE v INT;',
      '  SET v = CASE WHEN x > 0 THEN 1 ELSE 2 END;',
      '  CASE v WHEN 1 THEN INSERT INTO my_t VALUES (10); ELSE INSERT INTO my_t VALUES (20); END CASE;',
      'END$$',
      'DELIMITER ;',
      "# it's a comment with an apostrophe",
      'CALL p_case(5);',
      "INSERT INTO my_t VALUES (CHAR_LENGTH('a\\'b'));",
      "INSERT INTO my_t VALUES (CHAR_LENGTH(REPLACE('x\\\\y', '\\\\', '/')));",
    ].join('\n'),
    checks: [{ sql: 'SELECT GROUP_CONCAT(a ORDER BY a) FROM my_t', expect: '3,3,10' }],
  },
  {
    system: 'mysql',
    name: 'a CASE expression inside a routine body without DELIMITER',
    script: 'CREATE TABLE my_c (a int);\nCREATE PROCEDURE p_inline() BEGIN INSERT INTO my_c VALUES (CASE WHEN 1 THEN 7 ELSE 8 END); END;\nCALL p_inline();',
    checks: [{ sql: 'SELECT a FROM my_c', expect: '7' }],
  },
  {
    system: 'mssql',
    name: 'BEGIN TRAN inside a procedure does not swallow the DELETE after it',
    script:
      'CREATE TABLE audit_log (id int);\nINSERT INTO audit_log VALUES (1), (2);\nGO\nCREATE PROCEDURE p_tran AS BEGIN BEGIN TRAN; UPDATE audit_log SET id = id; COMMIT; END;\nDELETE FROM audit_log WHERE id = 1;',
    checks: [
      { sql: 'SELECT COUNT(*) FROM audit_log', expect: '1' },
      { sql: "SELECT CASE WHEN OBJECT_DEFINITION(OBJECT_ID('p_tran')) LIKE '%audit_log WHERE%' THEN 'leaked' ELSE 'clean' END", expect: 'clean' },
    ],
  },
  {
    system: 'mssql',
    name: 'IF … BEGIN … END is one statement and GO separates batches',
    script: 'CREATE TABLE ms_t (a int)\nGO\nIF 1 = 1 BEGIN INSERT INTO ms_t VALUES (1); INSERT INTO ms_t VALUES (2); END\nGO\nINSERT INTO ms_t VALUES (3)',
    checks: [{ sql: 'SELECT COUNT(*) FROM ms_t', expect: '3' }],
  },
  {
    system: 'oracle',
    name: 'a PL/SQL block with a leading comment, and a column named TYPE',
    script: [
      '-- create the table from PL/SQL',
      'BEGIN',
      "  EXECUTE IMMEDIATE 'CREATE TABLE ora_t (id NUMBER, type VARCHAR2(10))';",
      'END;',
      '/',
      "INSERT INTO ora_t VALUES (1, 'a');",
      "INSERT INTO ora_t VALUES (2, 'b');",
      'CREATE TABLE ora_u (id NUMBER, type VARCHAR2(10));',
      "INSERT INTO ora_u VALUES (1, 'x');",
    ].join('\n'),
    checks: [
      { sql: 'SELECT COUNT(*) FROM ora_t', expect: '2' },
      { sql: 'SELECT COUNT(*) FROM ora_u', expect: '1' },
    ],
  },
]

const proc = (globalThis as { process?: { env?: Record<string, string | undefined>; cwd?: () => string } }).process
const env = proc?.env ?? {}
// run from the repo root (npx vitest …)
const FIXTURE = `${proc?.cwd?.() ?? '.'}/src-tauri/tests/fixtures/editor-scripts.json`

function built() {
  return CASES.map((c) => {
    const statements = splitStatements(c.script, c.system).map((s) => s.sql)
    return { ...c, statements, dangerous: dangerousStatements(statements.map((sql) => ({ sql })), c.system).map((d) => d.index) }
  })
}

describe('editor scripts = the fixture the real engines run', () => {
  const fixture = JSON.parse(fixtureText) as { cases: ReturnType<typeof built> }
  const now = built()

  if (env.WRITE_SPLIT_FIXTURE) {
    it('rewrites the fixture', async () => {
      const fsName = 'node:fs'
      const fs = (await import(/* @vite-ignore */ fsName)) as { writeFileSync: (p: string, d: string) => void }
      fs.writeFileSync(FIXTURE, JSON.stringify({ cases: now }, null, 2) + '\n')
    })
    return
  }

  it('the splitter still cuts every script the way the fixture (and the engines) expect', () => {
    expect(now).toEqual(fixture.cases)
  })

  it('the delete-confirm flags exactly the cases that say so', () => {
    for (const c of now) expect(c.dangerous, c.name).toEqual(CASES.find((x) => x.name === c.name)!.dangerous ?? [])
  })
})
