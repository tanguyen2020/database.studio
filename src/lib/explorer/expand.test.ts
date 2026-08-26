// The "schema list hangs off a root node" rule. The key strings here are the
// contract with ObjectExplorer's render: `curdb` / `file` are the node keys it
// renders, and a root node is what keeps a freshly opened connection collapsed.

import { describe, expect, it } from 'vitest'
import { rootNodeKey } from './expand'

describe('rootNodeKey', () => {
  it('one-database-per-connection engines nest their schemas under a header node', () => {
    expect(rootNodeKey('postgres')).toBe('curdb')
    expect(rootNodeKey('mssql')).toBe('curdb')
    expect(rootNodeKey('oracle')).toBe('curdb')
  })
  it('SQLite nests under its file node', () => {
    expect(rootNodeKey('sqlite')).toBe('file')
  })
  it('schema-as-database engines list databases at the root (no wrapper)', () => {
    expect(rootNodeKey('mysql')).toBeNull()
    expect(rootNodeKey('mariadb')).toBeNull()
    expect(rootNodeKey('clickhouse')).toBeNull()
  })
  it('non-relational engines have no schema list', () => {
    for (const s of ['redis', 'kafka', 'nats', 'cassandra', 'mongodb']) expect(rootNodeKey(s)).toBeNull()
  })
  it('an unknown system is treated as "no wrapper node"', () => {
    expect(rootNodeKey('')).toBeNull()
  })
})
