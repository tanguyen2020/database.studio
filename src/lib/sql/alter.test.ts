import { describe, expect, it } from 'vitest'
import { toAlterStatement } from './alter'

describe('toAlterStatement — postgres', () => {
  it('view: wraps the pg_get_viewdef SELECT body as CREATE OR REPLACE VIEW', () => {
    expect(toAlterStatement('postgres', 'view', 'public', 'v_active', 'SELECT id FROM users WHERE active;')).toBe(
      'CREATE OR REPLACE VIEW "public"."v_active" AS\nSELECT id FROM users WHERE active;',
    )
  })
  it('function: pg_get_functiondef is already CREATE OR REPLACE → kept', () => {
    const def = 'CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'
    expect(toAlterStatement('postgres', 'function', 'public', 'f', def)).toBe(`${def};`)
  })
  it('trigger: CREATE TRIGGER → CREATE OR REPLACE TRIGGER', () => {
    expect(toAlterStatement('postgres', 'trigger', 'public', 'trg', 'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()')).toBe(
      'CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();',
    )
  })
})

describe('toAlterStatement — mysql', () => {
  it('view: leading CREATE → CREATE OR REPLACE', () => {
    expect(toAlterStatement('mysql', 'view', 'app', 'v', 'CREATE ALGORITHM=UNDEFINED VIEW `v` AS select 1')).toBe(
      'CREATE OR REPLACE ALGORITHM=UNDEFINED VIEW `v` AS select 1;',
    )
  })
  it('procedure: DROP IF EXISTS then the CREATE', () => {
    const def = 'CREATE DEFINER=`root`@`%` PROCEDURE `p`() BEGIN SELECT 1; END'
    expect(toAlterStatement('mysql', 'procedure', 'app', 'p', def)).toBe(
      'DROP PROCEDURE IF EXISTS `app`.`p`;\n\n' + def + ';',
    )
  })
  it('trigger: DROP TRIGGER IF EXISTS then CREATE', () => {
    const def = 'CREATE DEFINER=`root`@`%` TRIGGER `trg` BEFORE INSERT ON `t` FOR EACH ROW SET @x=1'
    expect(toAlterStatement('mariadb', 'trigger', 'app', 'trg', def)).toContain('DROP TRIGGER IF EXISTS `app`.`trg`;')
  })
})

describe('toAlterStatement — mssql', () => {
  it('leading CREATE → CREATE OR ALTER (proc/view/func/trigger)', () => {
    expect(toAlterStatement('mssql', 'procedure', 'dbo', 'p', 'CREATE PROCEDURE dbo.p AS SELECT 1')).toBe(
      'CREATE OR ALTER PROCEDURE dbo.p AS SELECT 1',
    )
    expect(toAlterStatement('mssql', 'view', 'dbo', 'v', 'CREATE VIEW dbo.v AS SELECT 1')).toBe('CREATE OR ALTER VIEW dbo.v AS SELECT 1')
  })
})

describe('toAlterStatement — sqlite', () => {
  it('view/trigger: DROP IF EXISTS then CREATE', () => {
    expect(toAlterStatement('sqlite', 'view', 'main', 'v', 'CREATE VIEW v AS SELECT 1')).toBe(
      'DROP VIEW IF EXISTS "v";\n\nCREATE VIEW v AS SELECT 1;',
    )
    expect(toAlterStatement('sqlite', 'trigger', 'main', 'trg', 'CREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END')).toBe(
      'DROP TRIGGER IF EXISTS "trg";\n\nCREATE TRIGGER trg AFTER INSERT ON t BEGIN SELECT 1; END;',
    )
  })
})

describe('toAlterStatement — clickhouse', () => {
  it('view: SHOW CREATE (CREATE VIEW …) → CREATE OR REPLACE VIEW', () => {
    expect(toAlterStatement('clickhouse', 'view', 'analytics', 'v', 'CREATE VIEW analytics.v AS SELECT 1')).toBe(
      'CREATE OR REPLACE VIEW analytics.v AS SELECT 1;',
    )
  })
  it('materialized view: leading CREATE → CREATE OR REPLACE (best-effort)', () => {
    expect(toAlterStatement('clickhouse', 'view', 'analytics', 'mv', 'CREATE MATERIALIZED VIEW analytics.mv TO t AS SELECT 1')).toBe(
      'CREATE OR REPLACE MATERIALIZED VIEW analytics.mv TO t AS SELECT 1;',
    )
  })
  it('table: no CREATE OR REPLACE — DDL surfaced with a note', () => {
    const out = toAlterStatement('clickhouse', 'table' as never, 'analytics', 't', 'CREATE TABLE analytics.t (id UInt64) ENGINE = MergeTree ORDER BY id')
    expect(out).toContain('no CREATE OR REPLACE for tables')
    expect(out).toContain('CREATE TABLE analytics.t')
  })
})
