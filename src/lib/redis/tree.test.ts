// Unit test Redis prefix-tree builder + flatten (Phase 3 · T3).

import { describe, expect, it } from 'vitest'
import { buildRedisTree, flattenRedisTree, keysUnderPrefix, mergeRedisKeys, type RedisKeyInfo } from './tree'

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

  // The path lookup was moved from children.find(...) to a Map (O(n²) → O(n) when
  // thousands of keys share a level). Same shape, same sort order, no dupes.
  it('nhiều key cùng một cấp: mỗi segment đúng một node, vẫn sort alphabet', () => {
    const names = Array.from({ length: 500 }, (_, i) => `evt:${String(i).padStart(3, '0')}`)
    const tree = buildRedisTree(names.map((n) => k(n)))
    expect(tree).toHaveLength(1)
    const evt = tree[0]
    expect(evt.children).toHaveLength(500)
    expect(new Set(evt.children.map((c) => c.path)).size).toBe(500) // no duplicated node
    expect(evt.children[0].path).toBe('evt:000')
    expect(evt.children[499].path).toBe('evt:499')
    expect(evt.children.every((c) => c.key !== undefined)).toBe(true)
  })

  it('cùng một segment ở hai nhánh khác nhau không bị gộp (path mới là khóa)', () => {
    const tree = buildRedisTree([k('a:x:1'), k('b:x:1')])
    expect(tree.map((n) => n.segment)).toEqual(['a', 'b'])
    expect(tree[0].children[0].path).toBe('a:x')
    expect(tree[1].children[0].path).toBe('b:x')
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

  // countKeys is memoised per node (toggling a folder re-flattens the whole tree);
  // repeated flattens of the same tree must keep reporting the same counts.
  it('count nhánh lồng đúng và không đổi qua nhiều lần flatten (memo)', () => {
    const tree = buildRedisTree([k('user'), k('user:1'), k('user:2:role'), k('session:a')])
    const first = flattenRedisTree(tree, new Set())
    expect(first.find((r) => r.path === 'user')).toMatchObject({ kind: 'folder', count: 3 })

    const opened = flattenRedisTree(tree, new Set(['user', 'user:2']))
    expect(opened.find((r) => r.path === 'user')).toMatchObject({ count: 3 })
    expect(opened.find((r) => r.path === 'user:2')).toMatchObject({ kind: 'folder', count: 1 })
    expect(flattenRedisTree(tree, new Set()).find((r) => r.path === 'user')?.count).toBe(3)
  })
})

// "Scan more" continues a capped walk from the cursor it stopped at, and Redis SCAN is
// allowed to hand back a key it already returned — appending must not duplicate rows.
describe('mergeRedisKeys', () => {
  it('bỏ trùng theo tên, giữ thứ tự xuất hiện đầu tiên', () => {
    const merged = mergeRedisKeys([k('a'), k('b')], [k('b'), k('c')])
    expect(merged.map((x) => x.name)).toEqual(['a', 'b', 'c'])
  })

  it('bản ghi mới thắng (type/TTL tươi hơn)', () => {
    const merged = mergeRedisKeys([k('a', 'string', -1)], [k('a', 'string', 30)])
    expect(merged).toHaveLength(1)
    expect(merged[0].ttl).toBe(30)
  })

  it('lượt đầu / lượt rỗng vẫn đúng', () => {
    expect(mergeRedisKeys([], [k('a')]).map((x) => x.name)).toEqual(['a'])
    expect(mergeRedisKeys([k('a')], []).map((x) => x.name)).toEqual(['a'])
  })

  it('cây dựng từ danh sách đã gộp không có node trùng', () => {
    const merged = mergeRedisKeys([k('user:1'), k('user:2')], [k('user:2'), k('user:3')])
    const user = buildRedisTree(merged)[0]
    expect(user.children.map((c) => c.path)).toEqual(['user:1', 'user:2', 'user:3'])
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
