import { describe, expect, it } from 'vitest'
import { functionSignatures } from './functions'

describe('functionSignatures', () => {
  it('includes common aggregates for every dialect', () => {
    for (const sys of ['postgres', 'mysql', 'sqlite', 'clickhouse']) {
      const names = functionSignatures(sys).map((f) => f.name)
      expect(names).toContain('count')
      expect(names).toContain('coalesce')
    }
  })
  it('per-dialect specifics', () => {
    expect(functionSignatures('postgres').map((f) => f.name)).toContain('generate_series')
    expect(functionSignatures('mysql').map((f) => f.name)).toContain('group_concat')
    expect(functionSignatures('mssql').map((f) => f.name)).toContain('isnull')
    expect(functionSignatures('clickhouse').map((f) => f.name)).toContain('uniqExact')
  })
  it('every entry carries a signature string', () => {
    for (const f of functionSignatures('postgres')) {
      expect(f.signature).toContain('(')
    }
  })
  it('unknown system → common only', () => {
    expect(functionSignatures('redis').every((f) => f.detail !== undefined)).toBe(true)
    expect(functionSignatures('redis').length).toBeGreaterThan(0)
  })
})
