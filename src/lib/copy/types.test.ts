import { describe, expect, it } from 'vitest'
import { buildCopyDdl, classifyType, mapColumnType, mapColumns } from './types'
import type { ColumnInfo } from '$lib/types'

const col = (name: string, data_type: string, is_pk = false): ColumnInfo => ({
  name,
  data_type,
  nullable: !is_pk,
  is_pk,
  is_fk: false,
  ordinal: 0,
})

describe('classifyType', () => {
  it('maps PG/MySQL/MSSQL types to families', () => {
    expect(classifyType('int4')).toBe('int')
    expect(classifyType('bigint')).toBe('bigint')
    expect(classifyType('varchar(80)')).toBe('text')
    expect(classifyType('timestamptz')).toBe('timestamp')
    expect(classifyType('numeric(10,2)')).toBe('decimal')
    expect(classifyType('boolean')).toBe('bool')
    expect(classifyType('jsonb')).toBe('json')
    expect(classifyType('uuid')).toBe('uuid')
    expect(classifyType('bytea')).toBe('bytes')
    expect(classifyType('date')).toBe('date')
  })
})

describe('mapColumnType', () => {
  it('PG → SQLite: affinity types', () => {
    expect(mapColumnType('int4', 'sqlite')).toBe('INTEGER')
    expect(mapColumnType('varchar(80)', 'sqlite')).toBe('TEXT')
    expect(mapColumnType('timestamptz', 'sqlite')).toBe('TEXT')
    expect(mapColumnType('double precision', 'sqlite')).toBe('REAL')
    expect(mapColumnType('bytea', 'sqlite')).toBe('BLOB')
  })
  it('PG → MySQL / MSSQL', () => {
    expect(mapColumnType('boolean', 'mysql')).toBe('TINYINT(1)')
    expect(mapColumnType('jsonb', 'mssql')).toBe('nvarchar(max)')
    expect(mapColumnType('uuid', 'mysql')).toBe('CHAR(36)')
  })
  it('unknown dialect falls back to postgres types', () => {
    expect(mapColumnType('int4', 'weird')).toBe('integer')
  })
})

describe('mapColumns / buildCopyDdl', () => {
  const src = [col('id', 'int4', true), col('name', 'varchar(80)'), col('created', 'timestamptz')]

  it('mapColumns rewrites types + drops FK flag', () => {
    const out = mapColumns(src, 'sqlite')
    expect(out.map((c) => c.data_type)).toEqual(['INTEGER', 'TEXT', 'TEXT'])
    expect(out.every((c) => !c.is_fk)).toBe(true)
  })

  it('buildCopyDdl produces valid destination CREATE TABLE (PG → SQLite)', () => {
    const ddl = buildCopyDdl('sqlite', 'main', 'users', src)
    expect(ddl).toContain('CREATE TABLE')
    expect(ddl).toContain('"id" INTEGER NOT NULL PRIMARY KEY')
    expect(ddl).toContain('"name" TEXT')
    expect(ddl).toContain('"created" TEXT')
  })
})
