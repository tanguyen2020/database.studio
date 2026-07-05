import { describe, expect, it } from 'vitest'
import { createTemplate } from './create-templates'

describe('createTemplate', () => {
  it('view is CREATE VIEW … AS SELECT for every relational dialect', () => {
    for (const sys of ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse']) {
      const t = createTemplate(sys, 'view', 'public')
      expect(t).toMatch(/^CREATE VIEW /)
      expect(t).toContain('SELECT * FROM')
    }
  })

  it('postgres procedure/function use $$ body; mysql uses BEGIN…END', () => {
    expect(createTemplate('postgres', 'procedure', 'public')).toContain('AS $$')
    expect(createTemplate('postgres', 'function', 'public')).toContain('RETURNS void')
    expect(createTemplate('mysql', 'procedure', 'app')).toMatch(/BEGIN[\s\S]*END;/)
    expect(createTemplate('mysql', 'function', 'app')).toContain('RETURNS INT')
  })

  it('mssql procedure/function wrap SET NOCOUNT / RETURN in BEGIN…END', () => {
    expect(createTemplate('mssql', 'procedure', 'dbo')).toContain('BEGIN')
    expect(createTemplate('mssql', 'function', 'dbo')).toContain('RETURNS INT')
  })

  it('postgres trigger emits BOTH the trigger function and the trigger', () => {
    const t = createTemplate('postgres', 'trigger', 'public')
    expect(t).toContain('CREATE OR REPLACE FUNCTION')
    expect(t).toContain('RETURNS trigger')
    expect(t).toContain('CREATE TRIGGER')
    expect(t).toContain('EXECUTE FUNCTION')
  })

  it('mysql/sqlite triggers are single CREATE TRIGGER statements', () => {
    expect(createTemplate('mysql', 'trigger', 'app')).toMatch(/^CREATE TRIGGER/)
    expect(createTemplate('sqlite', 'trigger', 'main')).toMatch(/^CREATE TRIGGER/)
  })

  it('sequence is Postgres-only; others return an explanatory comment', () => {
    expect(createTemplate('postgres', 'sequence', 'public')).toContain('CREATE SEQUENCE')
    expect(createTemplate('mysql', 'sequence', 'app')).toMatch(/^-- .*does not support/)
  })

  it('procedures/functions unsupported on clickhouse/sqlite → comment, no DDL', () => {
    expect(createTemplate('clickhouse', 'procedure', 'default')).toMatch(/^-- /)
    expect(createTemplate('sqlite', 'function', 'main')).toMatch(/^-- /)
  })

  it('sqlite view is schemaless (no schema-qualified name)', () => {
    const t = createTemplate('sqlite', 'view', 'main')
    expect(t).toContain('CREATE VIEW "new_view"')
    expect(t).not.toContain('"main".')
  })

  it('mssql uses [bracket] quoting for the qualified name', () => {
    expect(createTemplate('mssql', 'view', 'dbo')).toContain('CREATE VIEW [dbo].[new_view]')
  })
})
