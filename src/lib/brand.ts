// Brands that run on another engine (a "flavor"): same SystemType, same driver,
// their own name and logo. ScyllaDB is a flavor of Cassandra (SPEC-SCYLLADB.md),
// Valkey a flavor of Redis (SPEC-VALKEY.md), OpenSearch a flavor of Elasticsearch
// (SPEC-OPENSEARCH.md), Redpanda a flavor of Kafka (SPEC-REDPANDA.md), FerretDB and Amazon
// DocumentDB flavors of MongoDB (SPEC-FERRETDB-DOCUMENTDB.md). Everything visual — logo, label,
// accent, sidebar group — goes through `brandKey`, so a plain Cassandra or Redis
// profile is never affected.
import { systemMeta, type SystemMeta } from '$lib/systems'
import { SYS_GEN } from '$lib/systems.gen'

export type BrandKey = string

interface FlavorCarrier {
  system?: string | null
  /** the profile's generic "server flavor" field (named after its first user) */
  cassandra_flavor?: string | null
}

/** brand key → the engine it runs on */
export const FLAVOR_BRANDS: Record<string, { engine: string; flavor: string }> = {
  scylladb: { engine: 'cassandra', flavor: 'scylla' },
  valkey: { engine: 'redis', flavor: 'valkey' },
  opensearch: { engine: 'elasticsearch', flavor: 'opensearch' },
  redpanda: { engine: 'kafka', flavor: 'redpanda' },
  ferretdb: { engine: 'mongodb', flavor: 'ferretdb' },
  documentdb: { engine: 'mongodb', flavor: 'documentdb' },
}

/** Every brand a sidebar group / picker card exists for, right after its engine. */
export function withFlavorBrands(keys: readonly string[]): string[] {
  return keys.flatMap((k) => [k, ...Object.entries(FLAVOR_BRANDS).filter(([, b]) => b.engine === k).map(([brand]) => brand)])
}

export function isScylla(p: FlavorCarrier | null | undefined): boolean {
  return !!p && p.system === 'cassandra' && p.cassandra_flavor === 'scylla'
}

export function isValkey(p: FlavorCarrier | null | undefined): boolean {
  return !!p && p.system === 'redis' && p.cassandra_flavor === 'valkey'
}

/** FerretDB — MongoDB protocol on PostgreSQL (SPEC-FERRETDB-DOCUMENTDB.md). */
export function isFerretDB(p: FlavorCarrier | null | undefined): boolean {
  return !!p && p.system === 'mongodb' && p.cassandra_flavor === 'ferretdb'
}

/** Amazon DocumentDB — MongoDB-compatible AWS service (SPEC-FERRETDB-DOCUMENTDB.md). */
export function isDocumentDB(p: FlavorCarrier | null | undefined): boolean {
  return !!p && p.system === 'mongodb' && p.cassandra_flavor === 'documentdb'
}

export function isRedpanda(p: FlavorCarrier | null | undefined): boolean {
  return !!p && p.system === 'kafka' && p.cassandra_flavor === 'redpanda'
}

export function isOpenSearch(p: FlavorCarrier | null | undefined): boolean {
  return !!p && p.system === 'elasticsearch' && p.cassandra_flavor === 'opensearch'
}

/** 'scylladb' / 'valkey' / 'opensearch' for a flavored connection, otherwise the plain system key. */
export function brandKey(p: FlavorCarrier | null | undefined): BrandKey {
  if (!p) return 'orphan'
  for (const [brand, b] of Object.entries(FLAVOR_BRANDS)) if (p.system === b.engine && p.cassandra_flavor === b.flavor) return brand
  return p.system ?? 'orphan'
}

/** The product name for a connection — "ScyllaDB", "Valkey", "Redis"… */
export function brandLabel(p: FlavorCarrier | null | undefined): string {
  return brandMeta(brandKey(p)).label
}

/** systemMeta() that also knows the flavor brands (same category/port/quoting as the engine). */
export function brandMeta(key: BrandKey | null | undefined): SystemMeta {
  const flavor = key ? FLAVOR_BRANDS[key] : undefined
  const gen = key ? SYS_GEN[key as keyof typeof SYS_GEN] : undefined
  if (flavor && gen) {
    const base = systemMeta(flavor.engine)
    return { ...base, key: base.key, label: gen.label, badge: gen.badge, accent: gen.accent, bg: gen.bg, border: gen.border, fg: gen.fg }
  }
  return systemMeta(key)
}

/** The engine has flavor brands (Cassandra, Redis, Elasticsearch) — its connections may wear one. */
export function hasFlavors(system: string | null | undefined): boolean {
  return !!system && Object.values(FLAVOR_BRANDS).some((b) => b.engine === system)
}
