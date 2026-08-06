// Explorer store — item 4: expanding a table must show its columns on every
// engine, even when index/constraint introspection fails (Promise.allSettled).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ColumnInfo } from '$lib/types'

const listColumns = vi.fn()
const listIndexes = vi.fn()
const listConstraints = vi.fn()
const listPartitions = vi.fn()

vi.mock('$lib/ipc', () => ({
  listColumns: (...a: unknown[]) => listColumns(...a),
  listIndexes: (...a: unknown[]) => listIndexes(...a),
  listConstraints: (...a: unknown[]) => listConstraints(...a),
  listPartitions: (...a: unknown[]) => listPartitions(...a),
}))

import { explorer } from './explorer.svelte'

const col = (name: string): ColumnInfo => ({ name, data_type: 'int', nullable: false, default: undefined, is_pk: name === 'id', is_fk: false, ordinal: 1 })

describe('explorer.loadTableDetail resilience (item 4)', () => {
  beforeEach(() => {
    listColumns.mockReset()
    listIndexes.mockReset()
    listConstraints.mockReset()
    listPartitions.mockReset()
    listPartitions.mockResolvedValue([])
  })

  it('keeps columns even when index/constraint introspection rejects', async () => {
    listColumns.mockResolvedValue([col('id'), col('name')])
    listIndexes.mockRejectedValue(new Error('indexes not supported on this engine'))
    listConstraints.mockRejectedValue(new Error('constraints failed'))

    await explorer.loadTableDetail('c-item4', 'public', 'students')

    const detail = explorer.cache['c-item4']?.bySchema['public']?.tableDetails['students']
    expect(detail?.columns?.map((c) => c.name)).toEqual(['id', 'name'])
    // the failed calls degrade to empty lists, not a wiped-out detail
    expect(detail?.indexes ?? []).toEqual([])
    expect(detail?.constraints ?? []).toEqual([])
  })

  it('stores columns + indexes + constraints when all succeed', async () => {
    listColumns.mockResolvedValue([col('id')])
    listIndexes.mockResolvedValue([{ name: 'pk', primary: true, unique: true, method: 'btree', columns: ['id'] }])
    listConstraints.mockResolvedValue([{ name: 'pk', kind: 'PK', definition: undefined }])

    await explorer.loadTableDetail('c-item4b', 'public', 't')

    const detail = explorer.cache['c-item4b']?.bySchema['public']?.tableDetails['t']
    expect(detail?.columns?.length).toBe(1)
    expect(detail?.indexes?.length).toBe(1)
    expect(detail?.constraints?.length).toBe(1)
  })
})

// Autocomplete asks for the same table on every keystroke while the first answer
// is still in flight, and each call is 4 round-trips. Requests must coalesce —
// without breaking the forced reload that Refresh depends on.
describe('explorer.loadTableDetail request coalescing', () => {
  beforeEach(() => {
    listColumns.mockReset()
    listIndexes.mockReset()
    listConstraints.mockReset()
    listPartitions.mockReset()
    listIndexes.mockResolvedValue([])
    listConstraints.mockResolvedValue([])
    listPartitions.mockResolvedValue([])
  })

  it('collapses concurrent requests for the same table into one fetch', async () => {
    let release: (v: ColumnInfo[]) => void = () => {}
    listColumns.mockReturnValue(new Promise<ColumnInfo[]>((r) => (release = r)))

    const calls = [
      explorer.loadTableDetail('c-dedupe', 'public', 't'),
      explorer.loadTableDetail('c-dedupe', 'public', 't'),
      explorer.loadTableDetail('c-dedupe', 'public', 't'),
    ]
    expect(listColumns).toHaveBeenCalledTimes(1)

    release([col('id')])
    await Promise.all(calls)
    // every caller sees the loaded columns, not just the first one
    expect(explorer.cache['c-dedupe']?.bySchema['public']?.tableDetails['t']?.columns?.length).toBe(1)
    expect(listColumns).toHaveBeenCalledTimes(1)
  })

  it('does not coalesce different tables', async () => {
    listColumns.mockResolvedValue([col('id')])
    await Promise.all([
      explorer.loadTableDetail('c-dedupe2', 'public', 'a'),
      explorer.loadTableDetail('c-dedupe2', 'public', 'b'),
    ])
    expect(listColumns).toHaveBeenCalledTimes(2)
  })

  it('still refetches on force (Refresh) after the first load settled', async () => {
    listColumns.mockResolvedValue([col('id')])
    await explorer.loadTableDetail('c-dedupe3', 'public', 't')
    expect(listColumns).toHaveBeenCalledTimes(1)

    // cached → no fetch
    await explorer.loadTableDetail('c-dedupe3', 'public', 't')
    expect(listColumns).toHaveBeenCalledTimes(1)

    listColumns.mockResolvedValue([col('id'), col('added_later')])
    await explorer.loadTableDetail('c-dedupe3', 'public', 't', true)
    expect(listColumns).toHaveBeenCalledTimes(2)
    expect(
      explorer.cache['c-dedupe3']?.bySchema['public']?.tableDetails['t']?.columns?.map((c) => c.name),
    ).toEqual(['id', 'added_later'])
  })

  it('force reload wins even while a plain load is still in flight', async () => {
    let release: (v: ColumnInfo[]) => void = () => {}
    listColumns.mockReturnValueOnce(new Promise<ColumnInfo[]>((r) => (release = r)))

    const slow = explorer.loadTableDetail('c-dedupe4', 'public', 't')
    listColumns.mockResolvedValue([col('fresh')])
    const forced = explorer.loadTableDetail('c-dedupe4', 'public', 't', true)
    expect(listColumns).toHaveBeenCalledTimes(2) // the forced one is a real second fetch

    release([col('stale')])
    await Promise.all([slow, forced])
    // and a later request is not silently joined to an already-finished promise
    listColumns.mockResolvedValue([col('newest')])
    await explorer.loadTableDetail('c-dedupe4', 'public', 't', true)
    expect(
      explorer.cache['c-dedupe4']?.bySchema['public']?.tableDetails['t']?.columns?.map((c) => c.name),
    ).toEqual(['newest'])
  })
})
