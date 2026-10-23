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

describe('ScyllaDB keyspace template (SPEC-SCYLLADB.md §3.5)', () => {
  it('a ScyllaDB keyspace template names tablets and what tablets cannot hold', () => {
    const t = createTemplate('keyspace', 'ks', undefined, { scylla: true })
    expect(t).toContain("AND tablets = {'enabled': true}")
    expect(t).toContain("AND tablets = {'enabled': false}")
    expect(t).toMatch(/CDC.*counters/)
  })

  it('the Cassandra template is unchanged', () => {
    const plain = createTemplate('keyspace', 'ks')
    expect(plain).toBe(
      "CREATE KEYSPACE new_keyspace WITH replication = {\n  'class': 'NetworkTopologyStrategy',\n  'datacenter1': 3\n};",
    )
    expect(createTemplate('keyspace', 'ks', undefined, { scylla: false })).toBe(plain)
    // only the keyspace template differs
    expect(createTemplate('table', 'ks', undefined, { scylla: true })).toBe(createTemplate('table', 'ks'))
  })
})

describe('Explorer wording for a keyspace', () => {
  it('replication in plain words', async () => {
    const { replicationSummary } = await import('./cassandra')
    expect(replicationSummary("{ 'class': 'NetworkTopologyStrategy', 'datacenter1': '3' }")).toBe('3 copies in datacenter1')
    expect(replicationSummary("{ 'class': 'org.apache.cassandra.locator.NetworkTopologyStrategy', 'dc1': '3', 'dc2': '1' }")).toBe(
      '3 copies in dc1 · 1 in dc2',
    )
    expect(replicationSummary("{ 'class': 'SimpleStrategy', 'replication_factor': '1' }")).toBe('1 copy')
    expect(replicationSummary('something else')).toBe('something else')
  })
  it('data distribution in plain words', async () => {
    const { distributionLabel } = await import('./cassandra')
    expect(distributionLabel('vnodes')).toBe('Token ring (vnodes)')
    expect(distributionLabel('tablets')).toBe('Tablets')
    expect(distributionLabel('tablets · initial 8')).toBe('Tablets · 8 to start')
  })
})

describe('replication, short form for the tree', () => {
  it('one datacenter → copies only; several → total + datacenters', async () => {
    const { replicationShort } = await import('./cassandra')
    expect(replicationShort("{ 'class': 'NetworkTopologyStrategy', 'datacenter1': '3' }")).toBe('3 copies')
    expect(replicationShort("{ 'class': 'NetworkTopologyStrategy', 'dc1': '3', 'dc2': '2' }")).toBe('5 copies · 2 datacenters')
    expect(replicationShort("{ 'class': 'SimpleStrategy', 'replication_factor': '1' }")).toBe('1 copy')
    expect(replicationShort('???')).toBe('???')
  })
})
