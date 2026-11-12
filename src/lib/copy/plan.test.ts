import { describe, expect, it } from 'vitest'
import { clearStatement, planTransfer, type TransferTable } from './plan'
import type { ColumnInfo } from '$lib/types'
import type { ForeignKey } from '$lib/ipc'

const col = (name: string, data_type = 'text'): ColumnInfo =>
  ({ name, data_type, nullable: true, is_pk: false, is_fk: false }) as ColumnInfo

const tbl = (name: string, over: Partial<TransferTable> = {}): TransferTable => ({
  name,
  cols: [col('id', 'integer'), col('label')],
  ...over,
})

const fk = (from_table: string, to_table: string): ForeignKey => ({
  name: `${from_table}_${to_table}_fk`,
  from_table,
  from_column: 'x',
  to_table,
  to_column: 'id',
})

describe('planTransfer ordering', () => {
  it('creates a referenced parent before the table that points at it', () => {
    const steps = planTransfer({
      tables: [tbl('orders'), tbl('customers')],
      foreignKeys: [fk('orders', 'customers')],
      destSystem: 'postgres',
      destSchema: 'public',
      mode: 'create',
      copyData: true,
    })
    expect(steps.map((s) => s.srcTable)).toEqual(['customers', 'orders'])
  })

  it('ignores FKs to tables not in the selection', () => {
    const steps = planTransfer({
      tables: [tbl('orders')],
      foreignKeys: [fk('orders', 'customers')], // customers not picked
      destSystem: 'postgres',
      destSchema: 'public',
      mode: 'create',
      copyData: true,
    })
    expect(steps.map((s) => s.srcTable)).toEqual(['orders'])
  })

  it('a self-referencing table does not create a cycle', () => {
    const steps = planTransfer({
      tables: [tbl('employees')],
      foreignKeys: [fk('employees', 'employees')],
      destSystem: 'postgres',
      destSchema: 'public',
      mode: 'create',
      copyData: true,
    })
    expect(steps.map((s) => s.srcTable)).toEqual(['employees'])
  })
})

describe('planTransfer per-step', () => {
  it('create builds DDL in the destination dialect; columns carry through', () => {
    const [s] = planTransfer({
      tables: [tbl('t')],
      foreignKeys: [],
      destSystem: 'mysql',
      destSchema: 'app',
      mode: 'create',
      copyData: true,
    })
    expect(s.ddl).toContain('CREATE TABLE')
    expect(s.ddl).toContain('`app`.`t`')
    expect(s.columns).toEqual(['id', 'label'])
    expect(s.clearSql).toBe('')
  })

  it('append never emits DDL (destination must exist)', () => {
    const [s] = planTransfer({
      tables: [tbl('t')],
      foreignKeys: [],
      destSystem: 'postgres',
      destSchema: 'public',
      mode: 'append',
      copyData: true,
    })
    expect(s.ddl).toBe('')
    expect(s.clearSql).toBe('')
  })

  it('replace emits a clear statement and the create DDL', () => {
    const [s] = planTransfer({
      tables: [tbl('t')],
      foreignKeys: [],
      destSystem: 'postgres',
      destSchema: 'public',
      mode: 'replace',
      copyData: true,
    })
    expect(s.clearSql).toBe('TRUNCATE TABLE "public"."t";')
    expect(s.ddl).toContain('CREATE TABLE')
  })

  it('destName and where carry into the step; copyData=false keeps DDL but no data', () => {
    const [s] = planTransfer({
      tables: [tbl('src', { destName: 'dst', where: 'id > 10' })],
      foreignKeys: [],
      destSystem: 'postgres',
      destSchema: 'public',
      mode: 'create',
      copyData: false,
    })
    expect(s.destTable).toBe('dst')
    expect(s.where).toBe('id > 10')
    expect(s.copyData).toBe(false)
    expect(s.ddl).toContain('"public"."dst"')
  })
})

describe('clearStatement', () => {
  it('TRUNCATE for most engines, DELETE for SQLite', () => {
    expect(clearStatement('postgres', 'public', 't')).toBe('TRUNCATE TABLE "public"."t";')
    expect(clearStatement('mysql', 'app', 't')).toBe('TRUNCATE TABLE `app`.`t`;')
    expect(clearStatement('sqlite', 'main', 't')).toBe('DELETE FROM "t";')
  })
})
