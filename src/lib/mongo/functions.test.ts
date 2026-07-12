import { describe, expect, it } from 'vitest'
import { MONGO_METHODS, MONGO_OPERATORS } from './functions'

describe('MONGO_METHODS', () => {
  it('covers the core collection methods', () => {
    const names = MONGO_METHODS.map((m) => m.name)
    for (const m of ['find', 'aggregate', 'countDocuments', 'insertOne', 'updateMany', 'deleteOne', 'createIndex']) {
      expect(names).toContain(m)
    }
  })
  it('every entry has a name + signature + detail, and names are unique', () => {
    expect(MONGO_METHODS.every((m) => m.name && m.signature && m.detail)).toBe(true)
    expect(new Set(MONGO_METHODS.map((m) => m.name)).size).toBe(MONGO_METHODS.length)
  })
})

describe('MONGO_OPERATORS', () => {
  it('covers query / update / aggregation operators, all $-prefixed', () => {
    const names = MONGO_OPERATORS.map((o) => o.name)
    for (const o of ['$gt', '$in', '$or', '$exists', '$set', '$unset', '$inc', '$push', '$match', '$group']) {
      expect(names).toContain(o)
    }
    expect(MONGO_OPERATORS.every((o) => o.name.startsWith('$'))).toBe(true)
  })
  it('names are unique and each has a signature + detail', () => {
    expect(new Set(MONGO_OPERATORS.map((o) => o.name)).size).toBe(MONGO_OPERATORS.length)
    expect(MONGO_OPERATORS.every((o) => o.signature && o.detail)).toBe(true)
  })
})
