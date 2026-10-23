import { describe, expect, it } from 'vitest'
import { brandKey, brandMeta, isScylla } from './brand'
import { systemMeta } from '$lib/systems'
import { SYS_GEN } from '$lib/systems.gen'
import { scyllaDemoTree } from './demo'

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
