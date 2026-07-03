// Unit test Color Identity System — 10 hệ + orphan.
// Kỳ vọng lấy từ map SYS trong Database Studio.dc.html (qua systems.gen.ts
// sinh tự động). Test fail nếu badge/màu lệch nguồn.

import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/svelte'
import SystemBadge from './SystemBadge.svelte'
import SystemIcon from './SystemIcon.svelte'
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
}

describe('SYSTEMS metadata (từ systems.gen.ts)', () => {
  it('đủ 10 hệ + orphan', () => {
    expect(SYSTEM_ORDER).toHaveLength(10)
    expect(Object.keys(SYSTEMS)).toHaveLength(11)
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
    expect(systemMeta('mongodb').key).toBe('orphan')
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
  it.each(['postgres', 'mysql', 'mssql'])('%s dùng logo raster assets/', (key) => {
    const { container } = render(SystemIcon, { system: key, size: 16 })
    const img = container.querySelector('img')!
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe(`/assets/db-${key}.png`)
    expect(img.getAttribute('width')).toBe('16')
  })

  it.each(['redis', 'kafka', 'nats', 'mariadb', 'cassandra', 'sqlite'])(
    '%s dùng SVG stroke accent, viewBox 24, strokeWidth 1.9',
    (key) => {
      const { container } = render(SystemIcon, { system: key })
      const svg = container.querySelector('svg')!
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
      expect(svg.getAttribute('stroke')).toBe(SYSTEMS[key as keyof typeof SYSTEMS].accent)
      expect(svg.getAttribute('stroke-width')).toBe('1.9')
    },
  )

  it('clickhouse dùng SVG fill (4 thanh cột), không stroke', () => {
    const { container } = render(SystemIcon, { system: 'clickhouse' })
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('fill')).toBe(SYSTEMS.clickhouse.accent)
    expect(svg.getAttribute('stroke')).toBe('none')
    expect(svg.querySelectorAll('rect')).toHaveLength(4)
  })

  it('cassandra: ring 7 circle + 6 nan hoa', () => {
    const { container } = render(SystemIcon, { system: 'cassandra' })
    const svg = container.querySelector('svg')!
    expect(svg.querySelectorAll('circle')).toHaveLength(7)
    expect(svg.querySelectorAll('path')).toHaveLength(6)
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
