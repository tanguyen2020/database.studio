import { describe, expect, it } from 'vitest'
import { boolLiteral, generateRows, type ColumnGen } from './generate'

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

  it('boolLiteral is dialect-correct (PG quoted true/false, others numeric 1/0)', () => {
    expect(boolLiteral('postgres', true)).toBe('true')
    expect(boolLiteral('postgres', false)).toBe('false')
    for (const sys of ['mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse']) {
      expect(boolLiteral(sys, true)).toBe(1)
      expect(boolLiteral(sys, false)).toBe(0)
    }
  })

  it('bool kind renders per-dialect literals', () => {
    const pg = generateRows([col('flag', 'bool')], 40, 3, 'postgres')
    expect(pg.rows.every((row) => row[0] === 'true' || row[0] === 'false')).toBe(true)
    const my = generateRows([col('flag', 'bool')], 40, 3, 'mysql')
    expect(my.rows.every((row) => row[0] === 1 || row[0] === 0)).toBe(true)
    const ms = generateRows([col('flag', 'bool')], 40, 3, 'mssql')
    expect(ms.rows.every((row) => row[0] === 1 || row[0] === 0)).toBe(true)
  })

  it('bool kind with explicit values picks only from that set (e.g. int 0/1/2)', () => {
    const values = ['0', '1', '2']
    const r = generateRows([col('status', 'bool', { values })], 60, 5, 'mssql')
    expect(r.rows.every((row) => values.includes(String(row[0])))).toBe(true)
  })

  it('fk explicit values override the parent pool', () => {
    const pool = [10, 20, 30]
    const values = ['aaa', 'bbb']
    const r = generateRows([col('ref', 'fk', { pool, values })], 40)
    // explicit values win — pool is ignored
    expect(r.rows.every((row) => values.includes(row[0] as string))).toBe(true)
    expect(r.rows.some((row) => pool.includes(row[0] as number))).toBe(false)
  })
})
