import { describe, expect, it } from 'vitest'
import { foreignReloadPlan, mainReloadPlan } from './reload'
import { tableOfTreeKey } from './target'

describe('tableOfTreeKey', () => {
  it('reads table and view rows', () => {
    expect(tableOfTreeKey('t:public.students', ['public'])).toEqual({ schema: 'public', table: 'students' })
    expect(tableOfTreeKey('v:public.vw_active', ['public'])).toEqual({ schema: 'public', table: 'vw_active' })
  })
  it('keeps dotted schema names whole (MySQL database `crm.example.com`)', () => {
    expect(tableOfTreeKey('t:crm.example.com.orders', ['crm.example.com'])).toEqual({
      schema: 'crm.example.com',
      table: 'orders',
    })
  })
  it('ignores rows that carry no table detail', () => {
    for (const k of ['s:public', 'f:public:tables', 'col:public.students.id', 'curdb', 'fdb:analytics', 'tg:public.trg', ''])
      expect(tableOfTreeKey(k, ['public'])).toBeNull()
  })
})

describe('mainReloadPlan', () => {
  const schemas = ['public', 'reporting']

  it('re-reads the schemas behind every open row, once each, in order', () => {
    const plan = mainReloadPlan(
      ['s:public', 'f:public:tables', 'f:public:views', 's:reporting', 'f:reporting:tables'],
      schemas,
    )
    expect(plan.schemas).toEqual(['public', 'reporting'])
    expect(plan.tables).toEqual([])
  })

  it('re-reads the detail of open table/view rows (deduped)', () => {
    const plan = mainReloadPlan(
      ['f:public:tables', 't:public.students', 't:public.students', 'v:public.vw_active', 'col:public.students.id'],
      schemas,
    )
    expect(plan.schemas).toEqual(['public'])
    expect(plan.tables).toEqual([
      { schema: 'public', table: 'students' },
      { schema: 'public', table: 'vw_active' },
    ])
  })

  it('skips schemas that no longer exist on the server', () => {
    // `staging` was dropped since the last read — reloading it would resurrect a dead node
    expect(mainReloadPlan(['s:staging', 'f:staging:tables', 's:public'], schemas).schemas).toEqual(['public'])
  })

  it('ignores foreign-database rows (they live on a sub-connection)', () => {
    const plan = mainReloadPlan(['fdb:analytics', 'fdb:analytics:s:public', 'fdb:analytics:s:public:t:orders'], schemas)
    expect(plan).toEqual({ schemas: [], tables: [] })
  })

  it('is empty when nothing is open, or when the schema list is empty', () => {
    expect(mainReloadPlan([], schemas)).toEqual({ schemas: [], tables: [] })
    expect(mainReloadPlan(['s:public', 't:public.students'], [])).toEqual({ schemas: [], tables: [] })
  })
})

describe('foreignReloadPlan', () => {
  const schemas = ['public', 'reporting']

  it('re-reads the open schemas of that database only', () => {
    const expanded = [
      'fdb:analytics',
      'fdb:analytics:s:public',
      'fdb:analytics:s:reporting',
      'fdb:other:s:public', // another database → its own plan
      's:public', // main tree
    ]
    expect(foreignReloadPlan(expanded, 'analytics', schemas).schemas).toEqual(['public', 'reporting'])
    expect(foreignReloadPlan(expanded, 'other', schemas).schemas).toEqual(['public'])
  })

  it('re-reads open Tables/Views rows, and only those folders', () => {
    const plan = foreignReloadPlan(
      [
        'fdb:analytics:s:public:t',
        'fdb:analytics:s:public:t:students',
        'fdb:analytics:s:public:v:vw_active',
        'fdb:analytics:s:public:p:sp_x', // procedure row — no detail to read
        'fdb:analytics:s:public:tg:trg_x',
      ],
      'analytics',
      schemas,
    )
    expect(plan.schemas).toEqual(['public'])
    expect(plan.tables).toEqual([
      { schema: 'public', table: 'students' },
      { schema: 'public', table: 'vw_active' },
    ])
  })

  it('does not confuse a schema that is a prefix of another', () => {
    const plan = foreignReloadPlan(
      ['fdb:app:s:rep:t:a', 'fdb:app:s:reporting:t:b'],
      'app',
      ['rep', 'reporting'],
    )
    expect(plan.tables).toEqual([
      { schema: 'rep', table: 'a' },
      { schema: 'reporting', table: 'b' },
    ])
  })
})
