import { describe, it, expect } from 'vitest'
import {
  partitionOps,
  buildPartitionCreate,
  supportsPartitioning,
  addPartitionTemplate,
  buildAddPartition,
  buildConvertToPartitioned,
  canConvertToPartitioned,
  parsePartitionMethod,
  partitionKeyColumns,
} from './partitions'

describe('partitionOps', () => {
  it('Postgres acts on the child table (detach/truncate/drop)', () => {
    const ops = partitionOps('postgres', 'public', 'events', { name: 'events_2024', method: 'RANGE' })
    expect(ops.map((o) => o.label)).toEqual(['Detach partition', 'Truncate partition', 'Drop partition'])
    expect(ops[0].sql).toBe('ALTER TABLE "public"."events" DETACH PARTITION "public"."events_2024";')
    expect(ops[2].sql).toBe('DROP TABLE "public"."events_2024";')
    expect(ops[2].danger).toBe(true)
  })

  it('MySQL offers DROP only for RANGE/LIST', () => {
    const range = partitionOps('mysql', 'app', 'logs', { name: 'p2024', method: 'RANGE' })
    expect(range.some((o) => o.label === 'Drop partition')).toBe(true)
    expect(range.find((o) => o.label === 'Truncate partition')?.sql).toBe(
      'ALTER TABLE `app`.`logs` TRUNCATE PARTITION `p2024`;',
    )
    const hash = partitionOps('mysql', 'app', 'logs', { name: 'p0', method: 'HASH' })
    expect(hash.some((o) => o.label === 'Drop partition')).toBe(false)
  })

  it('MSSQL truncates by partition number', () => {
    const ops = partitionOps('mssql', 'dbo', 'sales', { name: 'Partition 3', method: 'RANGE', position: 3 })
    expect(ops[0].sql).toBe('TRUNCATE TABLE [dbo].[sales] WITH (PARTITIONS (3));')
  })

  it('ClickHouse uses the partition value expression', () => {
    const ops = partitionOps('clickhouse', 'default', 'hits', { name: '202406', method: 'EXPRESSION', expression: '202406' })
    expect(ops.map((o) => o.label)).toContain('Freeze (backup) partition')
    expect(ops.find((o) => o.label === 'Drop partition')?.sql).toBe(
      'ALTER TABLE `default`.`hits` DROP PARTITION 202406;',
    )
  })

  it('Cassandra / SQLite have no partition maintenance', () => {
    expect(partitionOps('cassandra', 'ks', 't', { name: 'x', method: 'PARTITION KEY' })).toEqual([])
    expect(partitionOps('sqlite', 'main', 't', { name: 'x', method: '' })).toEqual([])
  })
})

describe('buildPartitionCreate', () => {
  it('Postgres: PARTITION BY clause + child partition statements', () => {
    const r = buildPartitionCreate('postgres', 'public', 'events', {
      strategy: 'RANGE',
      columns: ['created_at'],
      partitions: [{ name: 'events_2024', bound: "FROM ('2024-01-01') TO ('2025-01-01')" }],
    })
    expect(r.clause).toBe('PARTITION BY RANGE ("created_at")')
    expect(r.post[0]).toBe(
      `CREATE TABLE "public"."events_2024" PARTITION OF "public"."events" FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');`,
    )
  })

  it('Postgres HASH emits modulus/remainder children', () => {
    const r = buildPartitionCreate('postgres', 'public', 't', { strategy: 'HASH', columns: ['id'], hashCount: 2 })
    expect(r.post).toHaveLength(2)
    expect(r.post[0]).toContain('FOR VALUES WITH (MODULUS 2, REMAINDER 0)')
  })

  it('MySQL: inline RANGE partition list', () => {
    const r = buildPartitionCreate('mysql', 'app', 'logs', {
      strategy: 'RANGE',
      columns: ['YEAR(ts)'],
      partitions: [
        { name: 'p2023', bound: '2024' },
        { name: 'p2024', bound: '2025' },
      ],
    })
    expect(r.clause).toContain('PARTITION BY RANGE (YEAR(ts))')
    expect(r.clause).toContain('PARTITION `p2023` VALUES LESS THAN (2024)')
    expect(r.post).toHaveLength(0)
  })

  it('MySQL HASH uses PARTITIONS n', () => {
    const r = buildPartitionCreate('mysql', 'app', 't', { strategy: 'HASH', columns: ['id'], hashCount: 4 })
    expect(r.clause).toBe('PARTITION BY HASH (id)\nPARTITIONS 4')
  })

  it('ClickHouse: expression PARTITION BY', () => {
    const r = buildPartitionCreate('clickhouse', 'default', 'hits', {
      strategy: 'RANGE',
      columns: ['toYYYYMM(ts)'],
    })
    expect(r.clause).toBe('PARTITION BY toYYYYMM(ts)')
  })

  it('MSSQL: partition function + scheme in pre; ON scheme in clause', () => {
    const r = buildPartitionCreate(
      'mssql',
      'dbo',
      'sales',
      { strategy: 'RANGE', columns: ['sale_date'], partitions: [{ name: 'p1', bound: "'2024-01-01'" }] },
      'date',
    )
    expect(r.pre[0]).toContain('CREATE PARTITION FUNCTION [pf_sales] (date)')
    expect(r.pre[0]).toContain("AS RANGE RIGHT FOR VALUES ('2024-01-01')")
    expect(r.pre[1]).toContain('CREATE PARTITION SCHEME [ps_sales]')
    expect(r.clause).toBe('ON [ps_sales] ([sale_date])')
  })

  it('MSSQL warns when asked for LIST/HASH', () => {
    const r = buildPartitionCreate('mssql', 'dbo', 't', { strategy: 'LIST', columns: ['c'] }, 'int')
    expect(r.warnings.join(' ')).toMatch(/no LIST partitioning/)
  })
})

describe('addPartitionTemplate', () => {
  it('Postgres emits CREATE TABLE … PARTITION OF', () => {
    expect(addPartitionTemplate('postgres', 'public', 'events')).toContain(
      'PARTITION OF "public"."events"',
    )
  })
  it('MySQL emits ALTER TABLE … ADD PARTITION', () => {
    expect(addPartitionTemplate('mysql', 'app', 'logs')).toContain('ADD PARTITION (PARTITION pNEW')
  })
  it('MSSQL emits SPLIT RANGE on the function', () => {
    expect(addPartitionTemplate('mssql', 'dbo', 'sales')).toContain('SPLIT RANGE')
  })
  it('ClickHouse notes automatic partitions + ATTACH', () => {
    expect(addPartitionTemplate('clickhouse', 'default', 'hits')).toContain('ATTACH PARTITION')
  })
})

describe('buildAddPartition (existing table)', () => {
  it('Postgres creates a child PARTITION OF', () => {
    const r = buildAddPartition('postgres', 'public', 'events', 'RANGE', {
      name: 'events_2026',
      bound: "FROM ('2026-01-01') TO ('2027-01-01')",
    })
    expect(r.sql).toBe(
      `CREATE TABLE "public"."events_2026" PARTITION OF "public"."events" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`,
    )
  })
  it('MySQL emits ALTER … ADD PARTITION VALUES LESS THAN', () => {
    const r = buildAddPartition('mysql', 'app', 'logs', 'RANGE', { name: 'p2026', bound: '2027' })
    expect(r.sql).toBe('ALTER TABLE `app`.`logs` ADD PARTITION (PARTITION `p2026` VALUES LESS THAN (2027));')
  })
  it('LIST uses VALUES IN', () => {
    const r = buildAddPartition('mysql', 'app', 't', 'LIST', { name: 'pw', bound: "'x','y'" })
    expect(r.sql).toContain("VALUES IN ('x','y')")
  })
  it('MSSQL / ClickHouse warn instead of emitting SQL', () => {
    expect(buildAddPartition('mssql', 'dbo', 't', 'RANGE', { name: 'p', bound: '1' }).sql).toBeUndefined()
    expect(buildAddPartition('clickhouse', 'd', 't', 'RANGE', { name: 'p', bound: '1' }).warning).toBeTruthy()
  })
})

describe('buildConvertToPartitioned (existing non-partitioned table)', () => {
  it('MySQL alters in place with PARTITION BY', () => {
    const r = buildConvertToPartitioned('mysql', 'app', 'logs', {
      strategy: 'RANGE',
      columns: ['YEAR(ts)'],
      partitions: [{ name: 'p2024', bound: '2025' }],
    })
    expect(r.post[0]).toContain('ALTER TABLE `app`.`logs`')
    expect(r.post[0]).toContain('PARTITION BY RANGE (YEAR(ts))')
    expect(r.post[0]).toContain('PARTITION `p2024` VALUES LESS THAN (2025)')
    expect(r.pre).toHaveLength(0)
  })

  it('Postgres recreates: rename → CREATE LIKE partitioned → children → copy → drop', () => {
    const r = buildConvertToPartitioned('postgres', 'public', 'events', {
      strategy: 'RANGE',
      columns: ['created_at'],
      partitions: [{ name: 'events_2024', bound: "FROM ('2024-01-01') TO ('2025-01-01')" }],
    })
    expect(r.pre[0]).toBe('ALTER TABLE "public"."events" RENAME TO "events_old";')
    expect(r.pre[1]).toBe('CREATE TABLE "public"."events" (LIKE "public"."events_old" INCLUDING DEFAULTS) PARTITION BY RANGE ("created_at");')
    expect(r.post.some((s) => s.includes('PARTITION OF "public"."events" FOR VALUES FROM'))).toBe(true)
    expect(r.post).toContain('INSERT INTO "public"."events" SELECT * FROM "public"."events_old";')
    expect(r.post).toContain('DROP TABLE "public"."events_old";')
    expect(r.warnings.join(' ')).toMatch(/recreates the table/)
  })

  it('MSSQL creates function + scheme + a clustered index on the scheme', () => {
    const r = buildConvertToPartitioned(
      'mssql',
      'dbo',
      'sales',
      { strategy: 'RANGE', columns: ['sale_date'], partitions: [{ name: 'p1', bound: "'2024-01-01'" }] },
      'date',
    )
    expect(r.pre[0]).toContain('CREATE PARTITION FUNCTION [pf_sales] (date)')
    expect(r.pre[1]).toContain('CREATE PARTITION SCHEME [ps_sales]')
    expect(r.post[0]).toBe('CREATE CLUSTERED INDEX [CIX_sales_partition] ON [dbo].[sales] ([sale_date]) ON [ps_sales] ([sale_date]);')
  })

  it('ClickHouse recreates the table (rename → CREATE AS + PARTITION BY → copy → drop)', () => {
    const r = buildConvertToPartitioned('clickhouse', 'default', 'hits', { strategy: 'RANGE', columns: ['toYYYYMM(d)'] })
    // rename original, then create the partitioned replacement from its structure
    expect(r.pre[0]).toBe('RENAME TABLE `default`.`hits` TO `hits_old`;')
    expect(r.pre[1]).toContain('CREATE TABLE `default`.`hits` AS `default`.`hits_old`')
    expect(r.pre[1]).toContain('PARTITION BY toYYYYMM(d)')
    // copy data then drop the backup
    expect(r.post.some((s) => s.includes('INSERT INTO `default`.`hits` SELECT * FROM `default`.`hits_old`'))).toBe(true)
    expect(r.post.some((s) => s.includes('DROP TABLE `default`.`hits_old`'))).toBe(true)
    expect(r.warnings.join(' ')).toMatch(/adjust ENGINE and ORDER BY/)
  })
})

describe('canConvertToPartitioned', () => {
  it('true for PG/MySQL/MariaDB/MSSQL/ClickHouse, false for SQLite', () => {
    expect(canConvertToPartitioned('postgres')).toBe(true)
    expect(canConvertToPartitioned('mysql')).toBe(true)
    expect(canConvertToPartitioned('mssql')).toBe(true)
    expect(canConvertToPartitioned('clickhouse')).toBe(true)
    expect(canConvertToPartitioned('sqlite')).toBe(false)
  })
})

describe('parsePartitionMethod', () => {
  it('maps RANGE/LIST/HASH and COLUMNS variants', () => {
    expect(parsePartitionMethod('RANGE')).toEqual({ strategy: 'RANGE', columnsMode: false })
    expect(parsePartitionMethod('LIST COLUMNS')).toEqual({ strategy: 'LIST', columnsMode: true })
    expect(parsePartitionMethod('KEY')).toEqual({ strategy: 'HASH', columnsMode: false })
  })
})

describe('partitionKeyColumns', () => {
  it("extracts the key from PG's strategy-prefixed form", () => {
    expect(partitionKeyColumns('RANGE (created_at)')).toBe('created_at')
    expect(partitionKeyColumns('LIST (region)')).toBe('region')
  })
  it('returns a bare expression unchanged (MySQL)', () => {
    expect(partitionKeyColumns('year(`ts`)')).toBe('year(`ts`)')
  })
})

describe('supportsPartitioning', () => {
  it('covers the relational engines but not sqlite/cassandra', () => {
    expect(supportsPartitioning('postgres')).toBe(true)
    expect(supportsPartitioning('clickhouse')).toBe(true)
    expect(supportsPartitioning('sqlite')).toBe(false)
    expect(supportsPartitioning('cassandra')).toBe(false)
  })
})
