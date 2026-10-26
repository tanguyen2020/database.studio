// Unit test Color Identity System — 10 hệ + orphan.
// Kỳ vọng lấy từ map SYS trong Database Studio.dc.html (qua systems.gen.ts
// sinh tự động). Test fail nếu badge/màu lệch nguồn.

import { describe, expect, it } from 'vitest'
import VALKEY_ICON_D from './__fixtures__/valkey-icon.d.txt?raw'
import OPENSEARCH_PARTS from './__fixtures__/opensearch-icon.parts.json'
import REDPANDA_ICON from './__fixtures__/redpanda-icon.parts.json'
import FERRETDB_ICON_D from './__fixtures__/ferretdb-icon.d.txt?raw'
import DOCUMENTDB_ICON from './__fixtures__/documentdb-icon.json'
import { render } from '@testing-library/svelte'
import SystemBadge from './SystemBadge.svelte'
import SystemIcon from './SystemIcon.svelte'
import { BRAND_MARKS, brandViewBox } from '$lib/brand-icons'
import ConnectionIndicator from './ConnectionIndicator.svelte'
import { SYSTEMS, SYSTEM_ORDER, systemMeta } from '$lib/systems'
import { SYS_GEN } from '$lib/systems.gen'

// jsdom chuẩn hóa style attribute (space sau `:`, hex → rgb) — so qua helper
const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

// Bảng kỳ vọng độc lập (từ HTML + quyết định đã chốt) — nếu systems.gen.ts
// bị sinh sai thì bảng này bắt được.
const EXPECTED: Record<string, [badge: string, accent: string]> = {
  postgres: ['PG', '#336791'],
  mysql: ['MY', '#F29111'],
  mariadb: ['MA', '#C0765A'],
  mssql: ['MS', '#CC2927'],
  sqlite: ['SL', '#0F80CC'],
  clickhouse: ['CH', '#FFCC00'],
  cassandra: ['CS', '#1287B1'],
  redis: ['RE', '#D82C20'], // RE — không phải RD (SPEC_v2 ghi sai)
  kafka: ['KF', '#8B5CF6'],
  nats: ['NT', '#27AE60'], // NT — không phải NA
  mongodb: ['MG', '#00ED64'],
  oracle: ['OR', '#C74634'],
  rabbitmq: ['RB', '#FF6600'],
  duckdb: ['DK', '#FFF000'],
  elasticsearch: ['ES', '#00BFB3'],
}

describe('SYSTEMS metadata (từ systems.gen.ts)', () => {
  it('đủ 15 hệ + orphan', () => {
    expect(SYSTEM_ORDER).toHaveLength(15)
    expect(Object.keys(SYSTEMS)).toHaveLength(16)
  })

  for (const [key, [badge, accent]] of Object.entries(EXPECTED)) {
    it(`${key}: badge ${badge}, accent ${accent}`, () => {
      expect(SYSTEMS[key as keyof typeof SYSTEMS].badge).toBe(badge)
      expect(SYSTEMS[key as keyof typeof SYSTEMS].accent).toBe(accent)
    })
  }

  it('orphan: badge ⚠, accent #5b6473', () => {
    expect(SYSTEMS.orphan.badge).toBe('⚠')
    expect(SYSTEMS.orphan.accent).toBe('#5b6473')
  })

  it('systemMeta fallback về orphan cho hệ lạ/null', () => {
    expect(systemMeta('couchdb').key).toBe('orphan')
    expect(systemMeta(null).key).toBe('orphan')
  })

  it('mỗi hệ đủ 4 token màu bg/border/fg/accent (từ file sinh)', () => {
    for (const key of Object.keys(SYS_GEN)) {
      const s = SYS_GEN[key as keyof typeof SYS_GEN]
      for (const c of [s.accent, s.bg, s.border, s.fg]) {
        expect(c).toMatch(/^#[0-9a-fA-F]{6}$/)
      }
    }
  })
})

describe('SystemBadge (port dòng 873 HTML)', () => {
  for (const key of SYSTEM_ORDER) {
    it(`render ${key}: đúng ký tự + bg/fg/border`, () => {
      const { container } = render(SystemBadge, { system: key })
      const span = container.querySelector('span')!
      const meta = SYSTEMS[key]
      expect(span.textContent?.trim()).toBe(meta.badge)
      expect(span.style.background).toBe(rgb(meta.bg))
      expect(span.style.color).toBe(rgb(meta.fg))
      // border chứa var() nên jsdom giữ nguyên hex
      expect(span.getAttribute('style')).toContain(`solid ${meta.border}`)
      expect(span.getAttribute('title')).toBe(meta.label)
    })
  }

  it('border=false: pill không viền (dòng 1180 HTML)', () => {
    const { container } = render(SystemBadge, { system: 'postgres', border: false })
    expect(container.querySelector('span')!.getAttribute('style')).not.toContain('border:')
  })

  it('số đo khớp HTML: 9px/700/radius 3px/padding 1px 6px (qua token)', () => {
    const { container } = render(SystemBadge, { system: 'postgres' })
    const s = container.querySelector('span')!.style
    expect(s.fontSize).toBe('var(--px-9)')
    expect(s.fontWeight).toBe('700')
    expect(s.borderRadius).toBe('var(--px-3)')
    expect(s.padding).toBe('var(--px-1) var(--px-6)')
  })
})

describe('SystemIcon (port dbIcon() HTML dòng 3883)', () => {
  // MySQL/MSSQL use the raster PNG logo; PostgreSQL (elephant + cylinder) and
  // MariaDB (sea lion) use hand-built SVG logos in public/assets/.
  it.each([
    ['postgres', 'svg'],
    ['mssql', 'png'],
    ['mariadb', 'svg'],
    ['oracle', 'svg'],
    ['nats', 'svg'], // NATS brand mark — same asset as the Explorer's broker tree
  ])('%s dùng logo assets/ (%s)', (key, ext) => {
    const { container } = render(SystemIcon, { system: key, size: 16 })
    const img = container.querySelector('img')!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe(`/assets/db-${key}.${ext}`)
    expect(img.getAttribute('width')).toBe('16')
  })

  // The engines that used hand-drawn stand-ins now show their official mark: the
  // simple-icons path, verbatim, in the brand colour (theme-safe where noted).
  it.each(['clickhouse', 'redis', 'kafka', 'cassandra', 'mongodb', 'sqlite', 'rabbitmq', 'mysql'])(
    '%s shows its official brand mark (simple-icons path, verbatim)',
    (key) => {
      const { container } = render(SystemIcon, { system: key, size: 16 })
      const svg = container.querySelector('svg')!
      expect(svg.getAttribute('data-logo')).toBe(key)
      expect(svg.getAttribute('viewBox')).toBe(brandViewBox(key))
      expect(svg.getAttribute('width')).toBe('16')
      const path = svg.querySelector('path')!
      expect(path.getAttribute('d')).toBe(BRAND_MARKS[key].d)
      expect(path.getAttribute('fill')).toBe(BRAND_MARKS[key].fill)
      // no hand-drawn stroke icon left behind
      expect(svg.getAttribute('stroke')).toBeNull()
    },
  )

  it('clickhouse sits on its black tile (yellow on white would be unreadable)', () => {
    const { container } = render(SystemIcon, { system: 'clickhouse' })
    expect(container.querySelector('rect')?.getAttribute('fill')).toBe(BRAND_MARKS.clickhouse.tile)
  })

  it('mysql keeps only the dolphin — the tiny MySQL wordmark is dropped and the view crops to it', () => {
    // simple-icons draws eye, wordmark, dolphin as three sub-paths; the wordmark one is gone
    expect(BRAND_MARKS.mysql.d.split(/(?=M)/)).toHaveLength(2)
    expect(brandViewBox('mysql')).not.toBe('0 0 24 24')
  })

  it('kafka (near-black brand ink) follows the text colour so it shows in dark mode', () => {
    expect(BRAND_MARKS.kafka.fill).toBe('var(--text)')
  })

  it('every brand mark is a real path, not a stand-in', () => {
    for (const [key, m] of Object.entries(BRAND_MARKS)) {
      // a multi-colour mark carries its sub-paths in `parts` — the mark as a whole must be
      // real (a small part such as one stroke of the Redpanda paw can be short)
      const ds = m.parts ? m.parts.map((p) => p.d) : [m.d]
      expect(ds.join('').length, key).toBeGreaterThan(100)
      for (const d of ds) expect(d.startsWith('M'), key).toBe(true)
    }
  })
})

describe('ConnectionIndicator (port dòng 117 HTML)', () => {
  it('thanh 3px màu accent, radius 2px, margin row', () => {
    const { container } = render(ConnectionIndicator, { system: 'postgres' })
    const s = container.querySelector('span')!.style
    expect(s.width).toBe('var(--px-3)')
    expect(s.borderRadius).toBe('var(--px-2)')
    expect(s.background).toBe(rgb(SYSTEMS.postgres.accent))
    expect(s.margin).toBe('var(--px-1) 0 var(--px-1) var(--px-4)')
    expect(s.alignSelf).toBe('stretch')
  })

  it('không bao giờ xám cho hệ đã biết — orphan mới dùng màu xám', () => {
    for (const key of SYSTEM_ORDER) {
      expect(SYSTEMS[key].accent).not.toBe(SYSTEMS.orphan.accent)
    }
  })
})

describe('ScyllaDB brand (a flavor of the Cassandra engine — SPEC-SCYLLADB.md §3.4)', () => {
  it('shows the official ScyllaDB mark (simple-icons scylladb, verbatim) in a theme-aware cyan', () => {
    const { container } = render(SystemIcon, { system: 'scylladb', size: 16 })
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('data-logo')).toBe('scylladb')
    // no tile: on a dark square the fine mark is unreadable at 16px
    expect(container.querySelector('rect')).toBeNull()
    const path = svg.querySelector('path')!
    expect(path.getAttribute('d')).toBe(BRAND_MARKS.scylladb.d)
    expect(path.getAttribute('fill')).toBe('var(--brand-scylla)')
    expect(BRAND_MARKS.scylladb.slug).toBe('scylladb')
  })

  it('is not a SystemKey — the Cassandra engine metadata is unchanged', () => {
    expect(SYS_GEN.scylladb).toMatchObject({ badge: 'SC', accent: '#6CD5E7', label: 'ScyllaDB' })
    expect(SYSTEM_ORDER).not.toContain('scylladb')
    expect(systemMeta('cassandra').label).toBe('Cassandra')
  })
})

describe('Valkey brand (a flavor of the Redis engine — SPEC-VALKEY.md §4)', () => {
  // the official mark, as published in svg-logos "valkey-icon" (CC0) — never redrawn
  const OFFICIAL_D = VALKEY_ICON_D.trim()

  it('shows the official Valkey mark verbatim in the brand periwinkle', () => {
    const { container } = render(SystemIcon, { system: 'valkey', size: 16 })
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('data-logo')).toBe('valkey')
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 295')
    const path = svg.querySelector('path')!
    expect(path.getAttribute('d')).toBe(OFFICIAL_D)
    expect(path.getAttribute('fill')).toBe('#6983FF')
    expect(BRAND_MARKS.valkey.slug).toBe('valkey-icon')
  })

  it('is not a SystemKey — the Redis engine metadata is unchanged', () => {
    expect(SYS_GEN.valkey).toMatchObject({ badge: 'VK', accent: '#6983FF', label: 'Valkey' })
    expect(SYSTEM_ORDER).not.toContain('valkey')
    expect(systemMeta('redis').label).toBe('Redis')
  })
})

describe('OpenSearch brand (a flavor of the Elasticsearch engine — SPEC-OPENSEARCH.md)', () => {
  // the official two-tone mark, as published in svg-logos "opensearch-icon" (CC0) — never redrawn
  it('shows the official OpenSearch mark verbatim, its navy part theme-aware', () => {
    const { container } = render(SystemIcon, { system: 'opensearch', size: 16 })
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('data-logo')).toBe('opensearch')
    expect(svg.getAttribute('viewBox')).toBe('0 0 256 256')
    const paths = [...svg.querySelectorAll('path')]
    expect(paths.map((p) => p.getAttribute('d'))).toEqual(OPENSEARCH_PARTS.map((p) => p.d))
    // brand blue as published; the navy #003b5c follows the theme so it never vanishes on dark
    expect(paths.map((p) => p.getAttribute('fill'))).toEqual(
      OPENSEARCH_PARTS.map((p) => (p.fill === '#003b5c' ? 'var(--brand-opensearch-ink)' : p.fill.toUpperCase())),
    )
  })

  it('is not a SystemKey — the Elasticsearch engine metadata is unchanged', () => {
    expect(SYS_GEN.opensearch).toMatchObject({ badge: 'OS', accent: '#005EB8', label: 'OpenSearch' })
    expect(SYSTEM_ORDER).not.toContain('opensearch')
    expect(systemMeta('elasticsearch').label).toBe('Elasticsearch')
  })
})

describe('Redpanda brand (a flavor of the Kafka engine — SPEC-REDPANDA.md)', () => {
  // the official mark from Redpanda's own UI kit (@redpanda-data/ui Logos.redpandaIconColorSvg) — never redrawn
  it('shows the official Redpanda mark verbatim in brand red', () => {
    const { container } = render(SystemIcon, { system: 'redpanda', size: 16 })
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('data-logo')).toBe('redpanda')
    expect(svg.getAttribute('viewBox')).toBe(REDPANDA_ICON.viewBox)
    const paths = [...svg.querySelectorAll('path')]
    expect(paths.map((p) => p.getAttribute('d'))).toEqual(REDPANDA_ICON.d)
    expect(paths.every((p) => p.getAttribute('fill') === '#E14226')).toBe(true)
  })

  it('is not a SystemKey — the Kafka engine metadata is unchanged', () => {
    expect(SYS_GEN.redpanda).toMatchObject({ badge: 'RP', accent: '#E14226', label: 'Redpanda' })
    expect(SYSTEM_ORDER).not.toContain('redpanda')
    expect(systemMeta('kafka').label).toBe('Kafka')
  })
})

describe('FerretDB and Amazon DocumentDB brands (flavors of MongoDB — SPEC-FERRETDB-DOCUMENTDB.md)', () => {
  it('FerretDB: the official simple-icons mark verbatim, its navy theme-aware', () => {
    const { container } = render(SystemIcon, { system: 'ferretdb', size: 16 })
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('data-logo')).toBe('ferretdb')
    const path = svg.querySelector('path')!
    expect(path.getAttribute('d')).toBe(FERRETDB_ICON_D.trim())
    expect(path.getAttribute('fill')).toBe('var(--brand-ferretdb-ink)')
  })

  it('Amazon DocumentDB: the official AWS icon verbatim, gradient id unique per drawing', () => {
    const a = render(SystemIcon, { system: 'documentdb', size: 16 }).container.querySelector('svg')!
    const b = render(SystemIcon, { system: 'documentdb', size: 16 }).container.querySelector('svg')!
    expect(a.getAttribute('data-logo')).toBe('documentdb')
    expect(a.getAttribute('viewBox')).toBe(DOCUMENTDB_ICON.viewBox)
    expect([...a.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual(DOCUMENTDB_ICON.parts.map((p) => p.d))
    const ida = a.querySelector('linearGradient')!.getAttribute('id')!
    const idb = b.querySelector('linearGradient')!.getAttribute('id')!
    expect(ida).not.toBe(idb)
    // the tile is painted with this drawing's own gradient
    expect(a.querySelector('path')!.getAttribute('fill')).toBe(`url(#${ida})`)
    expect(a.querySelectorAll('path')[1].getAttribute('fill')).toBe('#fff')
  })

  it('neither is a SystemKey — the MongoDB engine metadata is unchanged', () => {
    expect(SYS_GEN.ferretdb).toMatchObject({ badge: 'FD', label: 'FerretDB' })
    expect(SYS_GEN.documentdb).toMatchObject({ badge: 'DD', accent: '#527FFF', label: 'Amazon DocumentDB' })
    expect(SYSTEM_ORDER).not.toContain('ferretdb')
    expect(SYSTEM_ORDER).not.toContain('documentdb')
    expect(systemMeta('mongodb').label).toBe('MongoDB')
  })
})
