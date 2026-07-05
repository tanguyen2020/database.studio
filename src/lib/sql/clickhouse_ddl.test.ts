import { describe, expect, it } from 'vitest'
import { buildCreateDictionary, buildCreateMaterializedView } from './clickhouse_ddl'

describe('buildCreateMaterializedView', () => {
  it('TO target form', () => {
    expect(buildCreateMaterializedView({ db: 'analytics', name: 'mv', to: 'analytics.dst', select: 'SELECT * FROM src' })).toBe(
      'CREATE MATERIALIZED VIEW analytics.mv TO analytics.dst\nAS SELECT * FROM src;',
    )
  })
  it('ENGINE + POPULATE form; strips trailing semicolon in SELECT', () => {
    const out = buildCreateMaterializedView({ db: '', name: 'mv', engine: 'MergeTree() ORDER BY id', populate: true, select: 'SELECT id FROM src;' })
    expect(out).toBe('CREATE MATERIALIZED VIEW mv ENGINE = MergeTree() ORDER BY id POPULATE\nAS SELECT id FROM src;')
  })
  it('rejects TO + ENGINE together, and missing name/select', () => {
    expect(() => buildCreateMaterializedView({ db: '', name: 'mv', to: 't', engine: 'e', select: 'SELECT 1' })).toThrow(/not both/)
    expect(() => buildCreateMaterializedView({ db: '', name: '', select: 'SELECT 1' })).toThrow(/name is required/)
    expect(() => buildCreateMaterializedView({ db: '', name: 'mv', select: '' })).toThrow(/SELECT/)
  })
})

describe('buildCreateDictionary', () => {
  it('builds full CREATE DICTIONARY with source/layout/lifetime', () => {
    const out = buildCreateDictionary({
      db: 'analytics',
      name: 'dict_users',
      columns: [{ name: 'id', type: 'UInt64' }, { name: 'name', type: 'String' }],
      primaryKey: 'id',
      source: "HTTP(url 'http://x/users' format 'JSONEachRow')",
      layout: 'HASHED',
      lifetimeMin: 300,
      lifetimeMax: 3600,
    })
    expect(out).toContain('CREATE DICTIONARY analytics.dict_users (')
    expect(out).toContain('  id UInt64,\n  name String')
    expect(out).toContain('PRIMARY KEY id')
    expect(out).toContain("SOURCE(HTTP(url 'http://x/users' format 'JSONEachRow'))")
    expect(out).toContain('LAYOUT(HASHED())')
    expect(out).toContain('LIFETIME(MIN 300 MAX 3600);')
  })
  it('validates required fields', () => {
    const base = { db: '', name: 'd', columns: [{ name: 'id', type: 'UInt64' }], primaryKey: 'id', source: 'NULL()', layout: 'FLAT' as const, lifetimeMin: 0, lifetimeMax: 0 }
    expect(() => buildCreateDictionary({ ...base, name: '' })).toThrow(/name is required/)
    expect(() => buildCreateDictionary({ ...base, columns: [] })).toThrow(/column/)
    expect(() => buildCreateDictionary({ ...base, primaryKey: '' })).toThrow(/PRIMARY KEY/)
    expect(() => buildCreateDictionary({ ...base, source: '' })).toThrow(/SOURCE/)
  })
})
