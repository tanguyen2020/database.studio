import { describe, expect, it } from 'vitest'
import { dataTypes, defaultColumnType } from './datatypes'
import { designerTypes } from './ddl'

describe('dataTypes', () => {
  it('returns a rich, non-trivial catalog for each relational engine', () => {
    for (const sys of ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse']) {
      const types = dataTypes(sys)
      expect(types.length, `${sys} should have many types`).toBeGreaterThan(15)
      // no empties, no duplicates
      expect(types.every((t) => t.trim().length > 0)).toBe(true)
      expect(new Set(types).size, `${sys} has duplicate types`).toBe(types.length)
    }
  })

  it('includes engine-specific signature types', () => {
    expect(dataTypes('postgres')).toEqual(expect.arrayContaining(['jsonb', 'uuid', 'timestamptz', 'serial', 'bytea', 'inet']))
    expect(dataTypes('mysql')).toEqual(expect.arrayContaining(['tinyint', 'mediumint', 'longtext', 'enum', 'set', 'json', 'year']))
    expect(dataTypes('mssql')).toEqual(expect.arrayContaining(['nvarchar', 'nvarchar(max)', 'uniqueidentifier', 'datetime2', 'datetimeoffset', 'sql_variant']))
    expect(dataTypes('sqlite')).toEqual(expect.arrayContaining(['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC']))
    expect(dataTypes('clickhouse')).toEqual(expect.arrayContaining(['Int64', 'UInt64', 'Float64', 'String', 'DateTime64', 'LowCardinality']))
  })

  it('MariaDB extends the MySQL set with its own extras (uuid, inet6)', () => {
    expect(dataTypes('mariadb')).toEqual(expect.arrayContaining(['uuid', 'inet4', 'inet6', 'json']))
    // still MySQL-compatible
    expect(dataTypes('mariadb')).toEqual(expect.arrayContaining(['tinyint', 'longtext', 'datetime']))
  })

  it('returns an empty list for non-relational / unknown systems', () => {
    expect(dataTypes('redis')).toEqual([])
    expect(dataTypes('nats')).toEqual([])
    expect(dataTypes('nope')).toEqual([])
  })

  it('designerTypes delegates to dataTypes (single source of truth)', () => {
    for (const sys of ['postgres', 'mysql', 'mssql', 'sqlite', 'clickhouse']) {
      expect(designerTypes(sys)).toEqual(dataTypes(sys))
    }
  })

  it('defaultColumnType is a plain integer type present in that engine catalog', () => {
    for (const sys of ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse']) {
      const dflt = defaultColumnType(sys)
      expect(dflt.length, `${sys} default`).toBeGreaterThan(0)
      // the default must be a real, selectable type for that engine
      expect(dataTypes(sys), `${sys} catalog should contain its default`).toContain(dflt)
    }
    expect(defaultColumnType('postgres')).toBe('integer')
    expect(defaultColumnType('mysql')).toBe('int')
    expect(defaultColumnType('sqlite')).toBe('INTEGER')
  })
})
