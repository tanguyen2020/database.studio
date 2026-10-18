import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []
let inFlight = 0
let peak = 0
const opened: string[] = []
const closed: string[] = []

const delay = async <T>(v: T, ms = 5): Promise<T> => {
  inFlight++
  peak = Math.max(peak, inFlight)
  await new Promise((r) => setTimeout(r, ms))
  inFlight--
  return v
}

const TABLES = Array.from({ length: 20 }, (_, i) => ({ name: `t${String(i).padStart(2, '0')}`, kind: i === 3 ? 'view' : 'table' }))

vi.mock('$lib/ipc', () => ({
  listSchemas: async () => [{ name: 'public', is_default: true }],
  listTables: async () => [...TABLES, { name: 'pg_sys', kind: 'system' }],
  listRoutines: async () => [{ name: 'f1', kind: 'function' }, { name: 'p1', kind: 'procedure' }],
  listTriggers: async () => [{ name: 'tg1', table: 't01' }],
  listSequences: async () => [{ name: 's1' }],
  listColumns: async (id: string, _s: string, t: string) => {
    calls.push(`cols:${id}:${t}`)
    if (t === 't05') throw new Error('permission denied')
    return delay([{ name: 'id', data_type: 'int', nullable: false, is_pk: true }])
  },
  listIndexes: async (id: string, _s: string, t: string) => {
    calls.push(`idx:${id}:${t}`)
    return delay([
      { name: `${t}_pkey`, columns: ['id'], unique: true, primary: true },
      { name: `${t}_ix`, columns: ['id'], unique: false, primary: false },
    ])
  },
  objectDefinition: async (_id: string, _s: string, kind: string, name: string) => delay(`CREATE ${kind} ${name}`),
  scanIndexes: async () => ({ indexes: [] }),
  openTabConnection: async (base: string, tab: string) => {
    const id = `${base}#tab-${tab}`
    opened.push(id)
    return id
  },
  closeTabConnection: async (id: string) => {
    closed.push(id)
  },
}))
vi.mock('$lib/demo', () => ({ IS_TAURI: false }))
vi.mock('$lib/stores/connections.svelte', () => ({ connections: { databaseOf: () => 'app' } }))

import { takeSnapshot } from './snapshot'

beforeEach(() => {
  calls.length = 0
  opened.length = 0
  closed.length = 0
  inFlight = 0
  peak = 0
})

describe('takeSnapshot', () => {
  it('reads every object, keeps the catalog order and skips system tables', async () => {
    const s = await takeSnapshot('c1', 'postgres')
    expect(s.tables.map((t) => t.name)).toEqual(TABLES.map((t) => t.name))
    expect(s.tables[3].kind).toBe('view')
    expect(s.routines?.map((r) => `${r.kind}:${r.name}`)).toEqual(['function:f1', 'procedure:p1', 'trigger:tg1'])
    expect(s.routines?.find((r) => r.name === 'tg1')?.table).toBe('t01')
    expect(s.sequences).toEqual(['s1'])
    // primary keys are not compared as indexes; views have none
    expect(s.indexes?.every((i) => !i.name.endsWith('_pkey'))).toBe(true)
    expect(calls).not.toContain('idx:c1:t03')
  })

  it('a failing object does not wipe the comparison', async () => {
    const s = await takeSnapshot('c1', 'postgres')
    expect(s.tables.find((t) => t.name === 't05')?.columns).toEqual([])
    expect(s.tables.find((t) => t.name === 't06')?.columns).toHaveLength(1)
  })

  it('reports progress up to the total amount of work', async () => {
    const seen: { done: number; total: number }[] = []
    await takeSnapshot('c1', 'postgres', { onProgress: (p) => seen.push({ done: p.done, total: p.total }) })
    const last = seen.at(-1)!
    // 19 tables × 2 + 1 view × 1 + 3 routines/triggers
    expect(last).toEqual({ done: 42, total: 42 })
    expect(seen.map((p) => p.done)).toEqual([...seen.map((p) => p.done)].sort((a, b) => a - b))
  })

  it('opens extra connections for a big schema, overlaps the reads and closes them', async () => {
    await takeSnapshot('c1', 'postgres', { parallelConnections: true })
    expect(opened.length).toBeGreaterThan(1)
    expect(peak).toBeGreaterThan(1)
    // reads really went through the worker connections, not only the base one
    expect(calls.some((c) => c.includes('#tab-'))).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(closed.sort()).toEqual([...opened].sort())
  })

  it('stays on one connection for local engines', async () => {
    await takeSnapshot('c1', 'sqlite', { parallelConnections: true })
    expect(opened).toEqual([])
  })
})
