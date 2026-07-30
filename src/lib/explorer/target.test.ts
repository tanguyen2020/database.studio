import { describe, expect, it } from 'vitest'
import { foreignOfTreeKey, schemaOfTreeKey } from './target'

const SCHEMAS = ['public', 'reporting', 'crm.example.com']

describe('schemaOfTreeKey — schema of any node in the current database', () => {
  it('schema + folder nodes', () => {
    expect(schemaOfTreeKey('s:public', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('f:public:tables', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('f:reporting:seqs', SCHEMAS)).toBe('reporting')
  })

  it('object nodes — table / view / procedure / function / trigger / sequence', () => {
    expect(schemaOfTreeKey('t:public.students', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('v:public.v_active', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('p:reporting.sp_sync', SCHEMAS)).toBe('reporting')
    expect(schemaOfTreeKey('fn:public.add_one', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('tg:public.trg_audit', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('sq:public.students_id_seq', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('dic:public.dim_users', SCHEMAS)).toBe('public')
  })

  it('nested detail rows — columns, indexes, constraints, partitions', () => {
    expect(schemaOfTreeKey('col:public.students.first_name', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('vcol:public.v_active.id', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('ix:public.students.idx_students_email', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('ct:public.students.students_pkey', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('pt:public.events.p2026', SCHEMAS)).toBe('public')
    expect(schemaOfTreeKey('six:public.students.idx_a', SCHEMAS)).toBe('public')
  })

  it('dotted schema/database names resolve by longest known schema, not the first dot', () => {
    // a MySQL database named `crm.example.com` holding table `orders`
    expect(schemaOfTreeKey('t:crm.example.com.orders', SCHEMAS)).toBe('crm.example.com')
    expect(schemaOfTreeKey('s:crm.example.com', SCHEMAS)).toBe('crm.example.com')
    // unknown schema list → fall back to the first segment
    expect(schemaOfTreeKey('t:sales.orders', [])).toBe('sales')
  })

  it('non-schema keys → null (no clobbering of the previous binding target)', () => {
    expect(schemaOfTreeKey('curdb', SCHEMAS)).toBeNull()
    expect(schemaOfTreeKey('file', SCHEMAS)).toBeNull()
    expect(schemaOfTreeKey('fdb:analytics', SCHEMAS)).toBeNull()
    expect(schemaOfTreeKey('kafka:t:orders', SCHEMAS)).toBeNull()
    expect(schemaOfTreeKey('sec:pg:roles', SCHEMAS)).toBeNull()
    expect(schemaOfTreeKey('', SCHEMAS)).toBeNull()
  })
})

describe('foreignOfTreeKey — another database on the same server', () => {
  it('database node alone', () => {
    expect(foreignOfTreeKey('fdb:analytics')).toEqual({ database: 'analytics' })
  })

  it('schema, folder and object nodes carry database + schema', () => {
    expect(foreignOfTreeKey('fdb:analytics:s:public')).toEqual({ database: 'analytics', schema: 'public' })
    expect(foreignOfTreeKey('fdb:analytics:s:public:t')).toEqual({ database: 'analytics', schema: 'public' })
    expect(foreignOfTreeKey('fdb:analytics:s:reporting:v:v_daily')).toEqual({
      database: 'analytics',
      schema: 'reporting',
    })
    expect(foreignOfTreeKey('fdb:analytics:s:public:t:students:col:id')).toEqual({
      database: 'analytics',
      schema: 'public',
    })
  })

  it('main-tree keys are not foreign', () => {
    expect(foreignOfTreeKey('t:public.students')).toBeNull()
    expect(foreignOfTreeKey('s:public')).toBeNull()
    expect(foreignOfTreeKey('curdb')).toBeNull()
  })
})
