import { describe, expect, it } from 'vitest'
import { filterByName, objectFilterMatch } from './filter'

describe('objectFilterMatch', () => {
  it('blank query matches everything', () => {
    expect(objectFilterMatch('', 'get_user')).toBe(true)
    expect(objectFilterMatch('   ', 'anything')).toBe(true)
  })
  it('case-insensitive substring', () => {
    expect(objectFilterMatch('user', 'GetUserById')).toBe(true)
    expect(objectFilterMatch('USER', 'get_user')).toBe(true)
    expect(objectFilterMatch('xyz', 'get_user')).toBe(false)
  })
})

describe('filterByName', () => {
  const items = [{ name: 'sp_get_user' }, { name: 'sp_list_orders' }, { name: 'v_active_users' }]
  it('filters by case-insensitive substring; blank → all', () => {
    expect(filterByName('', items)).toHaveLength(3)
    expect(filterByName('user', items).map((i) => i.name)).toEqual(['sp_get_user', 'v_active_users'])
    expect(filterByName('ORDER', items).map((i) => i.name)).toEqual(['sp_list_orders'])
    expect(filterByName('zzz', items)).toHaveLength(0)
  })
  it('clearing the query (→ "") restores the full list after a filter', () => {
    const filtered = filterByName('user', items)
    expect(filtered).toHaveLength(2)
    // "clear" = empty query → every item matches again
    expect(filterByName('', items)).toEqual(items)
  })
})
