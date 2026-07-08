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
