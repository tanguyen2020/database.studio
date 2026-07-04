// Unit test folder grouping (Section 8): nhóm theo group field, sort hệ→tên,
// "Ungrouped" xếp cuối.

import { describe, expect, it } from 'vitest'
import { groupByFolder } from './grouping'
import type { ProfilePublic } from '$lib/types'

const ORDER = ['postgres', 'mysql', 'mssql', 'sqlite', 'clickhouse'] as const

function p(name: string, system: string, group: string): ProfilePublic {
  return {
    id: name,
    name,
    system: system as ProfilePublic['system'],
    host: 'h',
    port: 1,
    database: '',
    user: '',
    group,
    env: 'development',
    ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', key_path: '' },
    ssl: false,
    ssl_ca: '',
    ssl_cert: '',
    ssl_key: '',
    sqlite_path: '',
    sqlite_mode: 'read-write',
    mssql_auth: 'sql',
    schema_registry_url: '',
    cassandra_dc: '',
    cassandra_consistency: '',
    has_password: false,
    connected: false,
  }
}

describe('groupByFolder', () => {
  it('nhóm theo group field, folder sort alphabet, Ungrouped cuối', () => {
    const out = groupByFolder(
      [p('a', 'postgres', 'Prod'), p('b', 'mysql', ''), p('c', 'mssql', 'Analytics')],
      ORDER,
    )
    expect(out.map((f) => f.name)).toEqual(['Analytics', 'Prod', 'Ungrouped'])
  })

  it('group rỗng/whitespace → Ungrouped', () => {
    const out = groupByFolder([p('a', 'postgres', '   '), p('b', 'mysql', '')], ORDER)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Ungrouped')
    expect(out[0].items).toHaveLength(2)
  })

  it('trong folder sort theo thứ tự hệ rồi tên', () => {
    const out = groupByFolder(
      [p('z', 'postgres', 'G'), p('a', 'mysql', 'G'), p('b', 'postgres', 'G')],
      ORDER,
    )
    // postgres (rank 0) trước mysql (rank 1); trong postgres 'b' trước 'z'
    expect(out[0].items.map((i) => i.name)).toEqual(['b', 'z', 'a'])
  })

  it('hệ không có trong order xếp sau cùng', () => {
    const out = groupByFolder([p('x', 'unknown', 'G'), p('y', 'postgres', 'G')], ORDER)
    expect(out[0].items.map((i) => i.name)).toEqual(['y', 'x'])
  })
})
