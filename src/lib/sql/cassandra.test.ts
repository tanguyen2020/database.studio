import { describe, it, expect } from 'vitest'
import { createTemplate, dropStatement, truncateStatement } from './cassandra'

describe('cassandra CQL builders', () => {
  it('createTemplate: keyspace uses NetworkTopologyStrategy', () => {
    const s = createTemplate('keyspace', 'ignored')
    expect(s).toContain('CREATE KEYSPACE new_keyspace')
    expect(s).toContain("'class': 'NetworkTopologyStrategy'")
  })

  it('createTemplate: table has composite PK + clustering order', () => {
    const s = createTemplate('table', 'campus')
    expect(s).toContain('CREATE TABLE campus.new_table')
    expect(s).toContain('PRIMARY KEY ((id))')
    expect(s).toContain('CLUSTERING ORDER BY')
  })

  it('createTemplate: type + materialized view (base table) + index (target table)', () => {
    expect(createTemplate('type', 'ks')).toContain('CREATE TYPE ks.new_type')
    const mv = createTemplate('materialized-view', 'ks', 'students')
    expect(mv).toContain('CREATE MATERIALIZED VIEW ks.new_view AS')
    expect(mv).toContain('FROM ks.students')
    expect(createTemplate('index', 'ks', 'orders')).toBe('CREATE INDEX ON ks.orders (column_name);')
  })

  it('dropStatement: per-kind DROP syntax', () => {
    expect(dropStatement('keyspace', 'ks', 'ks')).toBe('DROP KEYSPACE ks;')
    expect(dropStatement('table', 'ks', 't')).toBe('DROP TABLE ks.t;')
    expect(dropStatement('view', 'ks', 'v')).toBe('DROP MATERIALIZED VIEW ks.v;')
    expect(dropStatement('type', 'ks', 'ty')).toBe('DROP TYPE ks.ty;')
    expect(dropStatement('index', 'ks', 'i')).toBe('DROP INDEX ks.i;')
    expect(dropStatement('function', 'ks', 'f')).toBe('DROP FUNCTION ks.f;')
    expect(dropStatement('aggregate', 'ks', 'a')).toBe('DROP AGGREGATE ks.a;')
  })

  it('truncateStatement', () => {
    expect(truncateStatement('ks', 't')).toBe('TRUNCATE ks.t;')
  })
})
