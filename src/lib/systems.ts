// Color Identity System — metadata cho 10 hệ + trạng thái orphaned.
// Màu/badge/label lấy từ src/lib/systems.gen.ts (SINH TỰ ĐỘNG từ map SYS
// trong Database Studio.dc.html — npm run tokens). File này chỉ bổ sung
// metadata phi-visual: category, port mặc định, quoting, phase availability.

import type { SystemType } from './types'
import { SYS_GEN, ENV_GEN, type SysGenKey } from './systems.gen'

export type SystemKey = SystemType | 'orphan'

export type SystemCategory =
  | 'RELATIONAL'
  | 'ANALYTICAL'
  | 'WIDE COLUMN'
  | 'CACHE'
  | 'STREAMING'
  | 'EMBEDDED'

export interface SystemMeta {
  key: SystemKey
  label: string
  badge: string
  accent: string
  bg: string
  border: string
  fg: string
  category: SystemCategory | null
  defaultPort: number | null
  /** identifier quoting style for the dialect */
  quote: 'double' | 'backtick' | 'bracket' | null
  /** implemented in the current phase (drives the new-connection picker) */
  available: boolean
}

// Metadata phi-visual per hệ (port từ openConnNew + qid + category map trong .dc.html)
const EXTRA: Record<
  SystemKey,
  Pick<SystemMeta, 'category' | 'defaultPort' | 'quote' | 'available'>
> = {
  postgres: { category: 'RELATIONAL', defaultPort: 5432, quote: 'double', available: true },
  mysql: { category: 'RELATIONAL', defaultPort: 3306, quote: 'backtick', available: true },
  mariadb: { category: 'RELATIONAL', defaultPort: 3306, quote: 'backtick', available: true },
  mssql: { category: 'RELATIONAL', defaultPort: 1433, quote: 'bracket', available: true },
  sqlite: { category: 'EMBEDDED', defaultPort: null, quote: 'double', available: true },
  clickhouse: { category: 'ANALYTICAL', defaultPort: 8123, quote: 'backtick', available: false }, // Phase 2
  cassandra: { category: 'WIDE COLUMN', defaultPort: 9042, quote: 'double', available: false }, // Phase Cassandra
  redis: { category: 'CACHE', defaultPort: 6379, quote: null, available: false }, // Phase 3
  kafka: { category: 'STREAMING', defaultPort: 9092, quote: null, available: false }, // Phase 4
  nats: { category: 'STREAMING', defaultPort: 4222, quote: null, available: false }, // Phase 3-4
  orphan: { category: null, defaultPort: null, quote: null, available: false },
}

export const SYSTEMS: Record<SystemKey, SystemMeta> = Object.fromEntries(
  (Object.keys(EXTRA) as SystemKey[]).map((key) => {
    const gen = SYS_GEN[key as SysGenKey]
    return [key, { key, ...gen, ...EXTRA[key] }]
  }),
) as Record<SystemKey, SystemMeta>

export function systemMeta(key: string | null | undefined): SystemMeta {
  return SYSTEMS[(key ?? 'orphan') as SystemKey] ?? SYSTEMS.orphan
}

/** Sidebar group order: categories then systems within (prototype order). */
export const CATEGORY_ORDER: SystemCategory[] = [
  'RELATIONAL',
  'ANALYTICAL',
  'WIDE COLUMN',
  'CACHE',
  'STREAMING',
  'EMBEDDED',
]

export const SYSTEM_ORDER: SystemKey[] = [
  'postgres',
  'mysql',
  'mariadb',
  'mssql',
  'clickhouse',
  'cassandra',
  'redis',
  'kafka',
  'nats',
  'sqlite',
]

/** Env tag — port từ map ENV trong .dc.html: [label, bg, fg] */
export interface EnvMeta {
  label: string
  bg: string
  fg: string
}

export const ENVS: Record<string, EnvMeta> = ENV_GEN

export function envMeta(key: string | null | undefined): EnvMeta {
  return ENVS[key ?? 'development'] ?? ENVS.development
}
