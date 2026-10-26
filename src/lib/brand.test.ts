import { describe, expect, it } from 'vitest'
import { brandKey, brandLabel, brandMeta, isDocumentDB, isFerretDB, isRedpanda, isScylla, isValkey, withFlavorBrands } from './brand'
import { systemMeta } from '$lib/systems'
import { SYS_GEN } from '$lib/systems.gen'
import { scyllaDemoTree } from '$lib/scylla/demo'

describe('ScyllaDB brand on the Cassandra engine', () => {
  it('only a cassandra profile with flavor scylla is ScyllaDB', () => {
    expect(isScylla({ system: 'cassandra', cassandra_flavor: 'scylla' })).toBe(true)
    expect(isScylla({ system: 'cassandra', cassandra_flavor: 'cassandra' })).toBe(false)
    expect(isScylla({ system: 'cassandra', cassandra_flavor: '' })).toBe(false)
    expect(isScylla({ system: 'cassandra' })).toBe(false)
    // the flavor field means nothing on another engine
    expect(isScylla({ system: 'postgres', cassandra_flavor: 'scylla' })).toBe(false)
    expect(isScylla(null)).toBe(false)
  })

  it('brandKey keeps every other connection on its own system key', () => {
    expect(brandKey({ system: 'cassandra', cassandra_flavor: 'scylla' })).toBe('scylladb')
    for (const system of ['cassandra', 'postgres', 'redis', 'mongodb']) expect(brandKey({ system })).toBe(system)
    expect(brandKey(undefined)).toBe('orphan')
  })

  it('brandMeta(scylladb) = ScyllaDB colours from the prototype map + Cassandra engine metadata', () => {
    const m = brandMeta('scylladb')
    expect(m.label).toBe('ScyllaDB')
    expect(m.badge).toBe('SC')
    expect(m.accent).toBe(SYS_GEN.scylladb.accent)
    expect(m.accent).toBe('#6CD5E7')
    const c = systemMeta('cassandra')
    expect([m.key, m.category, m.defaultPort, m.quote, m.available]).toEqual([c.key, c.category, c.defaultPort, c.quote, c.available])
    // other keys are exactly systemMeta
    expect(brandMeta('cassandra')).toEqual(c)
    expect(brandMeta('postgres')).toEqual(systemMeta('postgres'))
  })

  it('demo tree carries the two ScyllaDB-only shapes the Explorer handles', () => {
    const t = scyllaDemoTree('campus_ks')
    expect(t.tablets).toBe('vnodes')
    expect(t.tables.find((x) => x.cdc_of)?.cdc_of).toBe('orders')
  })
})

describe('Valkey brand on the Redis engine (SPEC-VALKEY.md)', () => {
  it('only a redis profile with flavor valkey is Valkey', () => {
    expect(isValkey({ system: 'redis', cassandra_flavor: 'valkey' })).toBe(true)
    expect(isValkey({ system: 'redis', cassandra_flavor: 'redis' })).toBe(false)
    expect(isValkey({ system: 'redis' })).toBe(false)
    // the flavor field means nothing on another engine
    expect(isValkey({ system: 'cassandra', cassandra_flavor: 'valkey' })).toBe(false)
    expect(isScylla({ system: 'redis', cassandra_flavor: 'scylla' })).toBe(false)
    expect(brandKey({ system: 'redis', cassandra_flavor: 'valkey' })).toBe('valkey')
    expect(brandLabel({ system: 'redis', cassandra_flavor: 'valkey' })).toBe('Valkey')
    expect(brandLabel({ system: 'redis' })).toBe('Redis')
  })

  it('brandMeta(valkey) = Valkey colours from the prototype map + Redis engine metadata', () => {
    const m = brandMeta('valkey')
    expect([m.label, m.badge, m.accent]).toEqual(['Valkey', 'VK', SYS_GEN.valkey.accent])
    const r = systemMeta('redis')
    expect([m.key, m.category, m.defaultPort, m.available]).toEqual([r.key, r.category, r.defaultPort, r.available])
    expect(brandMeta('redis')).toEqual(r)
  })

  it('flavor brands sit right after their engine, in order', () => {
    expect(withFlavorBrands(['postgres', 'redis', 'kafka', 'cassandra', 'sqlite'])).toEqual(['postgres', 'redis', 'valkey', 'kafka', 'redpanda', 'cassandra', 'scylladb', 'sqlite'])
  })
})

describe('Redpanda brand on the Kafka engine (SPEC-REDPANDA.md)', () => {
  it('only a kafka profile with flavor redpanda is Redpanda', () => {
    expect(isRedpanda({ system: 'kafka', cassandra_flavor: 'redpanda' })).toBe(true)
    expect(isRedpanda({ system: 'kafka', cassandra_flavor: 'kafka' })).toBe(false)
    expect(isRedpanda({ system: 'kafka' })).toBe(false)
    expect(isRedpanda({ system: 'redis', cassandra_flavor: 'redpanda' })).toBe(false)
    expect(brandKey({ system: 'kafka', cassandra_flavor: 'redpanda' })).toBe('redpanda')
    expect(brandLabel({ system: 'kafka', cassandra_flavor: 'redpanda' })).toBe('Redpanda')
    expect(brandLabel({ system: 'kafka' })).toBe('Kafka')
  })

  it('brandMeta(redpanda) = Redpanda colours + Kafka engine metadata', () => {
    const m = brandMeta('redpanda')
    expect([m.label, m.badge, m.accent]).toEqual(['Redpanda', 'RP', SYS_GEN.redpanda.accent])
    const k = systemMeta('kafka')
    expect([m.key, m.category, m.defaultPort, m.available]).toEqual([k.key, k.category, k.defaultPort, k.available])
  })
})

describe('FerretDB and Amazon DocumentDB on the MongoDB engine (SPEC-FERRETDB-DOCUMENTDB.md)', () => {
  it('only a mongodb profile with that flavor wears the brand', () => {
    expect(isFerretDB({ system: 'mongodb', cassandra_flavor: 'ferretdb' })).toBe(true)
    expect(isDocumentDB({ system: 'mongodb', cassandra_flavor: 'documentdb' })).toBe(true)
    expect(isFerretDB({ system: 'mongodb', cassandra_flavor: 'mongodb' })).toBe(false)
    expect(isFerretDB({ system: 'redis', cassandra_flavor: 'ferretdb' })).toBe(false)
    expect(brandKey({ system: 'mongodb', cassandra_flavor: 'documentdb' })).toBe('documentdb')
    expect(brandLabel({ system: 'mongodb', cassandra_flavor: 'ferretdb' })).toBe('FerretDB')
    expect(brandLabel({ system: 'mongodb', cassandra_flavor: 'documentdb' })).toBe('Amazon DocumentDB')
    expect(brandLabel({ system: 'mongodb' })).toBe('MongoDB')
  })

  it('both sit right after MongoDB and keep its engine metadata', () => {
    expect(withFlavorBrands(['mongodb', 'sqlite'])).toEqual(['mongodb', 'ferretdb', 'documentdb', 'sqlite'])
    const m = systemMeta('mongodb')
    for (const k of ['ferretdb', 'documentdb']) {
      const b = brandMeta(k)
      expect([b.key, b.category, b.defaultPort]).toEqual([m.key, m.category, m.defaultPort])
    }
    expect(brandMeta('ferretdb').badge).toBe('FD')
    expect(brandMeta('documentdb').accent).toBe(SYS_GEN.documentdb.accent)
  })
})
