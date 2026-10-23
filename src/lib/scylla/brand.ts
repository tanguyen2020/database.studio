// ScyllaDB is a flavor of the Cassandra engine (SPEC-SCYLLADB.md §0): same
// SystemType, same driver, its own brand. These helpers decide which brand a
// connection wears — everything visual (logo, label, accent, sidebar group)
// goes through `brandKey`, so a Cassandra profile is never affected.
import { systemMeta, type SystemMeta } from '$lib/systems'
import { SYS_GEN } from '$lib/systems.gen'

export type BrandKey = string

interface FlavorCarrier {
  system?: string | null
  cassandra_flavor?: string | null
}

export function isScylla(p: FlavorCarrier | null | undefined): boolean {
  return !!p && p.system === 'cassandra' && p.cassandra_flavor === 'scylla'
}

/** 'scylladb' for a ScyllaDB connection, otherwise the plain system key. */
export function brandKey(p: FlavorCarrier | null | undefined): BrandKey {
  if (isScylla(p)) return 'scylladb'
  return p?.system ?? 'orphan'
}

/** systemMeta() that also knows the ScyllaDB brand (same category/port/quoting as Cassandra). */
export function brandMeta(key: BrandKey | null | undefined): SystemMeta {
  if (key === 'scylladb') {
    const base = systemMeta('cassandra')
    const gen = SYS_GEN.scylladb
    return { ...base, key: 'cassandra', label: gen.label, badge: gen.badge, accent: gen.accent, bg: gen.bg, border: gen.border, fg: gen.fg }
  }
  return systemMeta(key)
}
