import { describe, expect, it } from 'vitest'
import { buildFieldOp, buildFieldOps, isValidOp, type MongoFieldOp } from './design'

describe('buildFieldOp', () => {
  it('add → updateMany $set only where the field is missing', () => {
    expect(buildFieldOp('users', { kind: 'add', field: 'active', value: true })).toBe(
      'db.users.updateMany({ "active": { "$exists": false } }, { "$set": { "active": true } })',
    )
    expect(buildFieldOp('users', { kind: 'add', field: 'score', value: 0 })).toContain('"$set": { "score": 0 }')
    expect(buildFieldOp('users', { kind: 'add', field: 'note', value: '' })).toContain('"note": ""')
  })
  it('rename → updateMany $rename', () => {
    expect(buildFieldOp('users', { kind: 'rename', from: 'name', to: 'fullName' })).toBe(
      'db.users.updateMany({}, { "$rename": { "name": "fullName" } })',
    )
  })
  it('drop → updateMany $unset', () => {
    expect(buildFieldOp('users', { kind: 'drop', field: 'temp' })).toBe(
      'db.users.updateMany({}, { "$unset": { "temp": "" } })',
    )
  })
})

describe('isValidOp', () => {
  it('requires non-empty field names; rename must actually change', () => {
    expect(isValidOp({ kind: 'add', field: 'x', value: 1 })).toBe(true)
    expect(isValidOp({ kind: 'add', field: '  ', value: 1 })).toBe(false)
    expect(isValidOp({ kind: 'drop', field: 'x' })).toBe(true)
    expect(isValidOp({ kind: 'drop', field: '' })).toBe(false)
    expect(isValidOp({ kind: 'rename', from: 'a', to: 'b' })).toBe(true)
    expect(isValidOp({ kind: 'rename', from: 'a', to: 'a' })).toBe(false) // no-op
    expect(isValidOp({ kind: 'rename', from: 'a', to: '' })).toBe(false)
  })
})

describe('buildFieldOps', () => {
  it('filters invalid ops and orders add → rename → drop', () => {
    const ops: MongoFieldOp[] = [
      { kind: 'drop', field: 'old' },
      { kind: 'rename', from: 'a', to: 'b' },
      { kind: 'add', field: 'c', value: 1 },
      { kind: 'rename', from: 'x', to: 'x' }, // invalid → dropped
    ]
    const cmds = buildFieldOps('col', ops)
    expect(cmds).toHaveLength(3)
    expect(cmds[0]).toContain('$set') // add first
    expect(cmds[1]).toContain('$rename') // then rename
    expect(cmds[2]).toContain('$unset') // then drop
  })
  it('empty / all-invalid → []', () => {
    expect(buildFieldOps('col', [])).toEqual([])
    expect(buildFieldOps('col', [{ kind: 'add', field: '', value: 1 }])).toEqual([])
  })
})
