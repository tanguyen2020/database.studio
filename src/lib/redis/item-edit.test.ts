import { describe, expect, it } from 'vitest'
import { draftOf, itemDeleteOp, itemEditable, itemEditText, planItemEdit, type ItemRef } from './item-edit'

const hash: ItemRef = { kind: 'hash', name: 'email', value: 'an@acme.io' }
const list: ItemRef = { kind: 'list', index: 1, value: 'x' }
const set: ItemRef = { kind: 'set', name: 'redis', value: 'redis' }
const zset: ItemRef = { kind: 'zset', name: 'an', value: 'an', score: 980 }

describe('planItemEdit', () => {
  it('hash: value change and rename both go through one hReplace', () => {
    expect(planItemEdit(hash, { ...draftOf(hash), value: 'new@acme.io' })).toEqual({ op: { op: 'hReplace', from: 'email', to: 'email', value: 'new@acme.io' } })
    expect(planItemEdit(hash, { ...draftOf(hash), name: 'mail' })).toEqual({ op: { op: 'hReplace', from: 'email', to: 'mail', value: 'an@acme.io' } })
    expect(planItemEdit(hash, { ...draftOf(hash), name: '' })).toEqual({ error: 'Type a field name.' })
    expect(planItemEdit(hash, draftOf(hash))).toEqual({ error: 'Nothing changed.' })
  })

  it('list: edits by position and carries the value it read (stale guard)', () => {
    expect(planItemEdit(list, { ...draftOf(list), value: 'y' })).toEqual({ op: { op: 'lSetAt', index: 1, expected: 'x', value: 'y' } })
    expect(planItemEdit(list, draftOf(list))).toEqual({ error: 'Nothing changed.' })
  })

  it('set and sorted set: member rename, score must be a number', () => {
    expect(planItemEdit(set, { ...draftOf(set), name: 'valkey' })).toEqual({ op: { op: 'sReplace', from: 'redis', to: 'valkey' } })
    expect(planItemEdit(zset, { ...draftOf(zset), score: '990.5' })).toEqual({ op: { op: 'zReplace', from: 'an', to: 'an', score: 990.5 } })
    expect(planItemEdit(zset, { ...draftOf(zset), name: 'anh' })).toEqual({ op: { op: 'zReplace', from: 'an', to: 'anh', score: 980 } })
    expect(planItemEdit(zset, { ...draftOf(zset), score: 'abc' })).toHaveProperty('error')
    expect(planItemEdit(zset, { ...draftOf(zset), score: '' })).toHaveProperty('error')
    expect(planItemEdit(zset, draftOf(zset))).toEqual({ error: 'Nothing changed.' })
  })

  it('stream entries are never editable', () => {
    expect(itemEditable('stream')).toBe(false)
    expect(planItemEdit({ kind: 'stream', name: '1-0', value: '{}' }, { name: '', value: '', score: '' })).toHaveProperty('error')
    expect(itemEditText(list).title).toBe('Edit item 1')
  })
})

describe('itemDeleteOp', () => {
  it('removes one list item by position, not every duplicate by value', () => {
    expect(itemDeleteOp(list)).toEqual({ op: 'lDelAt', index: 1, expected: 'x' })
    expect(itemDeleteOp(hash)).toEqual({ op: 'hDel', field: 'email' })
    expect(itemDeleteOp(set)).toEqual({ op: 'sRem', member: 'redis' })
    expect(itemDeleteOp(zset)).toEqual({ op: 'zRem', member: 'an' })
    expect(itemDeleteOp({ kind: 'stream', name: '1-0', value: '' })).toEqual({ op: 'xDel', id: '1-0' })
  })
})
