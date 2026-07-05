import { describe, expect, it } from 'vitest'
import { generateRows, type ColumnGen } from './generate'

const col = (name: string, kind: ColumnGen['kind'], extra: Partial<ColumnGen> = {}): ColumnGen => ({
  name,
  kind,
  nullable: false,
  unique: false,
  ...extra,
})

describe('generateRows', () => {
  it('produces the requested row count aligned to columns', () => {
    const r = generateRows([col('id', 'sequence'), col('name', 'name')], 5)
    expect(r.columns).toEqual(['id', 'name'])
    expect(r.rows).toHaveLength(5)
    expect(r.rows[0]).toHaveLength(2)
  })

  it('is deterministic for a given seed', () => {
    const specs = [col('id', 'sequence'), col('email', 'email'), col('n', 'number')]
    expect(generateRows(specs, 10, 42)).toEqual(generateRows(specs, 10, 42))
  })

  it('different seeds diverge', () => {
    const specs = [col('n', 'number', { min: 0, max: 1_000_000 })]
    expect(generateRows(specs, 20, 1)).not.toEqual(generateRows(specs, 20, 2))
  })

  it('sequence + unique columns never collide', () => {
    const r = generateRows([col('id', 'sequence', { unique: true }), col('email', 'email', { unique: true })], 200)
    const ids = r.rows.map((row) => row[0])
    const emails = r.rows.map((row) => row[1])
    expect(new Set(ids).size).toBe(200)
    expect(new Set(emails).size).toBe(200)
  })

  it('NOT NULL columns never emit null (even for null kind)', () => {
    const r = generateRows([col('x', 'null', { nullable: false })], 10)
    expect(r.rows.every((row) => row[0] !== null)).toBe(true)
  })

  it('nullable null kind emits null', () => {
    const r = generateRows([col('x', 'null', { nullable: true })], 5)
    expect(r.rows.every((row) => row[0] === null)).toBe(true)
  })

  it('fk values come only from the parent pool', () => {
    const pool = [10, 20, 30]
    const r = generateRows([col('parent_id', 'fk', { pool })], 50)
    expect(r.rows.every((row) => pool.includes(row[0] as number))).toBe(true)
  })

  it('enum values come only from the given set', () => {
    const values = ['active', 'inactive', 'pending']
    const r = generateRows([col('status', 'enum', { values })], 50)
    expect(r.rows.every((row) => values.includes(row[0] as string))).toBe(true)
  })

  it('numbers respect the min/max range', () => {
    const r = generateRows([col('age', 'number', { min: 18, max: 65 })], 100)
    expect(r.rows.every((row) => (row[0] as number) >= 18 && (row[0] as number) <= 65)).toBe(true)
  })
})
