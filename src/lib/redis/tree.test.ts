// Unit test Redis prefix-tree builder + flatten (Phase 3 · T3).

import { describe, expect, it } from 'vitest'
import { buildRedisTree, flattenRedisTree, keysUnderPrefix, type RedisKeyInfo } from './tree'

const k = (name: string, key_type = 'string', ttl = -1): RedisKeyInfo => ({ name, key_type, ttl })

describe('buildRedisTree', () => {
  it('nhóm theo ":" — user:1, user:2 → folder user với 2 con', () => {
    const tree = buildRedisTree([k('user:1'), k('user:2'), k('session:abc')])
    expect(tree.map((n) => n.segment)).toEqual(['session', 'user']) // sort alphabet
    const user = tree.find((n) => n.segment === 'user')!
    expect(user.key).toBeUndefined() // folder thuần, không phải key
    expect(user.children.map((c) => c.path)).toEqual(['user:1', 'user:2'])
    expect(user.children[0].key).toEqual(k('user:1'))
  })

  it('key không có ":" → leaf ở cấp gốc', () => {
    const tree = buildRedisTree([k('flag')])
    expect(tree).toHaveLength(1)
    expect(tree[0].key).toEqual(k('flag'))
    expect(tree[0].children).toHaveLength(0)
  })

  it('prefix vừa là folder vừa là key (user + user:1)', () => {
    const tree = buildRedisTree([k('user'), k('user:1')])
    const user = tree[0]
    expect(user.key).toEqual(k('user')) // chính nó là key
    expect(user.children).toHaveLength(1) // và có con
  })
})

describe('flattenRedisTree', () => {
  it('folder đóng → ẩn con; mở → hiện con với depth', () => {
    const tree = buildRedisTree([k('user:1'), k('user:2')])
    const closed = flattenRedisTree(tree, new Set())
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ kind: 'folder', segment: 'user', depth: 0, expanded: false, count: 2 })

    const open = flattenRedisTree(tree, new Set(['user']))
    expect(open.map((r) => r.path)).toEqual(['user', 'user:1', 'user:2'])
    expect(open[1]).toMatchObject({ kind: 'key', depth: 1 })
  })
})

describe('keysUnderPrefix', () => {
  const keys = [k('user'), k('user:1'), k('user:2'), k('user:2:role'), k('userdata'), k('session:abc')]

  it('collects the prefix key itself + everything under prefix:', () => {
    expect(keysUnderPrefix(keys, 'user').sort()).toEqual(['user', 'user:1', 'user:2', 'user:2:role'].sort())
  })

  it('does not match a sibling that merely starts with the same text', () => {
    expect(keysUnderPrefix(keys, 'user')).not.toContain('userdata')
  })

  it('nested prefix returns only its own subtree', () => {
    expect(keysUnderPrefix(keys, 'user:2').sort()).toEqual(['user:2', 'user:2:role'].sort())
  })

  it('unknown prefix → empty', () => {
    expect(keysUnderPrefix(keys, 'nope')).toEqual([])
  })
})
