import { describe, expect, it } from 'vitest'
import { statementPreview, statementVerb } from './statement-verb'

describe('statementVerb', () => {
  it('names DML and DDL the way people say them', () => {
    expect(statementVerb('select * from t')).toBe('SELECT')
    expect(statementVerb('  -- note\n/* x */ INSERT INTO t VALUES (1)')).toBe('INSERT')
    expect(statementVerb('UPDATE t SET a = 1')).toBe('UPDATE')
    expect(statementVerb('DELETE FROM t')).toBe('DELETE')
    expect(statementVerb('TRUNCATE TABLE t')).toBe('TRUNCATE TABLE')
    expect(statementVerb('TRUNCATE t')).toBe('TRUNCATE')
    expect(statementVerb('DROP TABLE IF EXISTS t')).toBe('DROP TABLE')
    expect(statementVerb('CREATE OR REPLACE VIEW v AS SELECT 1')).toBe('CREATE VIEW')
    expect(statementVerb('CREATE UNIQUE INDEX ix ON t (a)')).toBe('CREATE INDEX')
    expect(statementVerb('create materialized view mv as select 1')).toBe('CREATE MATERIALIZED VIEW')
    expect(statementVerb('ALTER TABLE t ADD COLUMN b int')).toBe('ALTER TABLE')
    expect(statementVerb('CREATE PROC p AS SELECT 1')).toBe('CREATE PROCEDURE')
    expect(statementVerb('EXEC sp_who')).toBe('EXECUTE')
    expect(statementVerb('(SELECT 1) UNION (SELECT 2)')).toBe('SELECT')
  })

  it('reads the main verb behind a CTE', () => {
    expect(statementVerb('WITH x AS (SELECT 1) UPDATE t SET a = 1')).toBe('UPDATE')
    expect(statementVerb('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('SELECT')
  })

  it('handles empty input', () => {
    expect(statementVerb('  -- only a comment')).toBe('STATEMENT')
  })
})

describe('statementPreview', () => {
  it('collapses the statement to one line and trims it', () => {
    expect(statementPreview('UPDATE t\n   SET a = 1 -- why\n WHERE id = 2')).toBe('UPDATE t SET a = 1 WHERE id = 2')
    expect(statementPreview('SELECT ' + 'x, '.repeat(100), 20)).toHaveLength(20)
  })
})
