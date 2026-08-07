// Expand/Collapse All key mapping + the "schema list hangs off a root node" rule.
// The key strings here are the contract with ObjectExplorer's render: if a folder
// key changes there, these tests must change too (otherwise Expand All silently
// stops opening that folder).

import { describe, expect, it } from 'vitest'
import {
  CASS_FOLDERS,
  SCHEMA_FOLDERS,
  cassFolderKey,
  cassKeyspaceKey,
  cassandraExpandKeys,
  folderKey,
  natsExpandKeys,
  natsStreamKey,
  relationalExpandKeys,
  rootNodeKey,
  schemaKey,
  supportsExpandAll,
} from './expand'

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
})

describe('relationalExpandKeys', () => {
  it('opens the root node, every schema and every object folder', () => {
    const keys = relationalExpandKeys('postgres', ['public', 'reporting'])
    expect(keys[0]).toBe('curdb')
    expect(keys).toContain('s:public')
    expect(keys).toContain('s:reporting')
    for (const f of SCHEMA_FOLDERS) {
      expect(keys).toContain(`f:public:${f}`)
      expect(keys).toContain(`f:reporting:${f}`)
    }
    // root + 2 schemas × (1 + folders)
    expect(keys).toHaveLength(1 + 2 * (1 + SCHEMA_FOLDERS.length))
  })

  it('omits the root node for schema-as-database engines', () => {
    const keys = relationalExpandKeys('mysql', ['app'])
    expect(keys).not.toContain('curdb')
    expect(keys).not.toContain('file')
    expect(keys[0]).toBe('s:app')
  })

  it('uses the file node for SQLite', () => {
    expect(relationalExpandKeys('sqlite', ['main'])[0]).toBe('file')
  })

  it('no schemas → just the root node (nothing to open below it)', () => {
    expect(relationalExpandKeys('postgres', [])).toEqual(['curdb'])
    expect(relationalExpandKeys('mysql', [])).toEqual([])
  })

  it('keeps names with dots/dashes intact (databases like `crm.example.com`)', () => {
    const keys = relationalExpandKeys('mysql', ['crm.example.com', 'ismart-eco'])
    expect(keys).toContain('s:crm.example.com')
    expect(keys).toContain('f:crm.example.com:tables')
    expect(keys).toContain('f:ismart-eco:views')
  })

  it('emits unique keys (a Set built from them keeps every entry)', () => {
    const keys = relationalExpandKeys('postgres', ['public', 'reporting'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('key builders match the emitted strings', () => {
    expect(schemaKey('public')).toBe('s:public')
    expect(folderKey('public', 'tables')).toBe('f:public:tables')
    expect(relationalExpandKeys('postgres', ['public'])).toContain(folderKey('public', 'seqs'))
  })
})

describe('cassandraExpandKeys', () => {
  it('opens each keyspace and its folders', () => {
    const keys = cassandraExpandKeys(['app_ks'])
    expect(keys).toContain(cassKeyspaceKey('app_ks'))
    expect(keys[0]).toBe('cass:ks:app_ks')
    for (const f of CASS_FOLDERS) expect(keys).toContain(cassFolderKey(f, 'app_ks'))
    expect(keys).toHaveLength(1 + CASS_FOLDERS.length)
  })
  it('no keyspaces → nothing to open', () => {
    expect(cassandraExpandKeys([])).toEqual([])
  })
})

describe('natsExpandKeys', () => {
  it('opens each stream', () => {
    expect(natsExpandKeys(['ORDERS', 'EVENTS'])).toEqual(['nats:s:ORDERS', 'nats:s:EVENTS'])
    expect(natsStreamKey('ORDERS')).toBe('nats:s:ORDERS')
  })
})

describe('supportsExpandAll', () => {
  it('is off where the tree is not the header\'s to expand', () => {
    // Redis/Mongo keep their own expansion state inside a child component; Kafka
    // topics are leaves.
    expect(supportsExpandAll('redis')).toBe(false)
    expect(supportsExpandAll('mongodb')).toBe(false)
    expect(supportsExpandAll('kafka')).toBe(false)
    expect(supportsExpandAll(undefined)).toBe(false)
  })
  it('is on for the trees the explorer header owns', () => {
    for (const s of ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'clickhouse', 'oracle', 'cassandra', 'nats'])
      expect(supportsExpandAll(s)).toBe(true)
  })
})
