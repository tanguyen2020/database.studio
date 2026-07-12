import { describe, expect, it } from 'vitest'
import { parseMongoCollection, isCollectionPrefix, isMethodContext, isOperatorContext } from './complete'

describe('parseMongoCollection', () => {
  it('extracts the collection from db.<coll>.<method>()', () => {
    expect(parseMongoCollection('db.users.find({})')).toBe('users')
    expect(parseMongoCollection('db.order_items.aggregate([])')).toBe('order_items')
    expect(parseMongoCollection('  db.students .find( { age: 1 } )')).toBe('students')
  })
  it('supports db.getCollection("name")', () => {
    expect(parseMongoCollection('db.getCollection("my-coll").find({})')).toBe('my-coll')
  })
  it('returns null when there is no db.<coll>.<method>', () => {
    expect(parseMongoCollection('db.')).toBeNull()
    expect(parseMongoCollection('db.users')).toBeNull() // no trailing method access yet
    expect(parseMongoCollection('find({})')).toBeNull()
    expect(parseMongoCollection('')).toBeNull()
  })
})

describe('isCollectionPrefix', () => {
  it('true when the text ends at a db. collection prefix', () => {
    expect(isCollectionPrefix('db.')).toBe(true)
    expect(isCollectionPrefix('db.us')).toBe(true)
    expect(isCollectionPrefix('  db.users')).toBe(true)
  })
  it('false otherwise (after a method dot, mid-word, etc.)', () => {
    expect(isCollectionPrefix('db.users.')).toBe(false)
    expect(isCollectionPrefix('db.users.find(')).toBe(false)
    expect(isCollectionPrefix('users')).toBe(false)
    expect(isCollectionPrefix('')).toBe(false)
  })
})

describe('isMethodContext', () => {
  it('true after db.<collection>. (method access)', () => {
    expect(isMethodContext('db.users.')).toBe(true)
    expect(isMethodContext('db.users.fin')).toBe(true)
    expect(isMethodContext('  db.order_items.agg')).toBe(true)
  })
  it('false for the collection prefix or a bare word', () => {
    expect(isMethodContext('db.')).toBe(false)
    expect(isMethodContext('db.users')).toBe(false)
    expect(isMethodContext('find')).toBe(false)
  })
})

describe('isOperatorContext', () => {
  it('true while typing a $ operator token', () => {
    expect(isOperatorContext('$')).toBe(true)
    expect(isOperatorContext('$g')).toBe(true)
    expect(isOperatorContext('{ age: { $gt')).toBe(true)
    expect(isOperatorContext('{ $set')).toBe(true)
  })
  it('false without a trailing $token', () => {
    expect(isOperatorContext('age')).toBe(false)
    expect(isOperatorContext('$gt: 5')).toBe(false) // not at the cursor end
    expect(isOperatorContext('')).toBe(false)
  })
})
