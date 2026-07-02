// Color Identity System — metadata for all 10 systems + orphaned state.
// Values mirror the prototype's SYS map (source of truth: Database Studio.dc.html)
// and the CSS variables in app.css. Badges are exactly 2 characters.

import type { SystemType } from './types'

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

export const SYSTEMS: Record<SystemKey, SystemMeta> = {
  postgres: {
    key: 'postgres',
    label: 'PostgreSQL',
    badge: 'PG',
    accent: '#336791',
    bg: '#1a3a52',
    border: '#2a5a7a',
    fg: '#7ec8f0',
    category: 'RELATIONAL',
    defaultPort: 5432,
    quote: 'double',
    available: true,
  },
  mysql: {
    key: 'mysql',
    label: 'MySQL',
    badge: 'MY',
    accent: '#F29111',
    bg: '#3d2800',
    border: '#6b4400',
    fg: '#f5b84a',
    category: 'RELATIONAL',
    defaultPort: 3306,
    quote: 'backtick',
    available: true,
  },
  mariadb: {
    key: 'mariadb',
    label: 'MariaDB',
    badge: 'MA',
    accent: '#C0765A',
    bg: '#2e1a12',
    border: '#5c3020',
    fg: '#e8a882',
    category: 'RELATIONAL',
    defaultPort: 3306,
    quote: 'backtick',
    available: true,
  },
  mssql: {
    key: 'mssql',
    label: 'SQL Server',
    badge: 'MS',
    accent: '#CC2927',
    bg: '#3d0a09',
    border: '#6b1515',
    fg: '#f08080',
    category: 'RELATIONAL',
    defaultPort: 1433,
    quote: 'bracket',
    available: true,
  },
  sqlite: {
    key: 'sqlite',
    label: 'SQLite',
    badge: 'SL',
    accent: '#0F80CC',
    bg: '#0a1e35',
    border: '#12406a',
    fg: '#60b8f5',
    category: 'EMBEDDED',
    defaultPort: null,
    quote: 'double',
    available: true,
  },
  clickhouse: {
    key: 'clickhouse',
    label: 'ClickHouse',
    badge: 'CH',
    accent: '#FFCC00',
    bg: '#33290a',
    border: '#665514',
    fg: '#ffe066',
    category: 'ANALYTICAL',
    defaultPort: 8123,
    quote: 'backtick',
    available: false, // Phase 2
  },
  cassandra: {
    key: 'cassandra',
    label: 'Cassandra',
    badge: 'CS',
    accent: '#1287B1',
    bg: '#0a2030',
    border: '#134f72',
    fg: '#5cc4e8',
    category: 'WIDE COLUMN',
    defaultPort: 9042,
    quote: 'double',
    available: false, // Cassandra phase
  },
  redis: {
    key: 'redis',
    label: 'Redis',
    badge: 'RE',
    accent: '#D82C20',
    bg: '#3d0c08',
    border: '#6b1a14',
    fg: '#f07070',
    category: 'CACHE',
    defaultPort: 6379,
    quote: null,
    available: false, // Phase 3
  },
  kafka: {
    key: 'kafka',
    label: 'Kafka',
    badge: 'KF',
    accent: '#8B5CF6',
    bg: '#1e1a2e',
    border: '#3d2f6b',
    fg: '#c4b5fd',
    category: 'STREAMING',
    defaultPort: 9092,
    quote: null,
    available: false, // Phase 4
  },
  nats: {
    key: 'nats',
    label: 'NATS',
    badge: 'NT',
    accent: '#27AE60',
    bg: '#0d2e1a',
    border: '#1a5c35',
    fg: '#6ee7a0',
    category: 'STREAMING',
    defaultPort: 4222,
    quote: null,
    available: false, // Phase 3-4
  },
  orphan: {
    key: 'orphan',
    label: 'Orphaned',
    badge: '⚠',
    accent: '#5b6473',
    bg: '#2a2f3a',
    border: '#3a4150',
    fg: '#9aa4b8',
    category: null,
    defaultPort: null,
    quote: null,
    available: false,
  },
}

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

export const ENV_COLORS: Record<string, string> = {
  production: 'var(--env-production)',
  staging: 'var(--env-staging)',
  development: 'var(--env-development)',
  local: 'var(--env-local)',
}

export const ENV_LABELS: Record<string, string> = {
  production: 'PROD',
  staging: 'STG',
  development: 'DEV',
  local: 'LOCAL',
}
