import { describe, expect, it } from 'vitest'
import { toMermaid, toSvg, tableSize, ER_CARD, ER_SVG_LIGHT, type ErTable } from './mermaid'
import { erRoute, manyEnd, oneEnd } from './edge-geometry'
import type { ForeignKey } from '$lib/ipc'

const tables: ErTable[] = [
  {
    name: 'students',
    columns: [
      { name: 'id', type: 'int4', pk: true, fk: false },
      { name: 'name', type: 'varchar(80)', pk: false, fk: false },
    ],
  },
  {
    name: 'enrollments',
    columns: [
      { name: 'id', type: 'int4', pk: true, fk: false },
      { name: 'student_id', type: 'int4', pk: false, fk: true },
    ],
  },
]
const fks: ForeignKey[] = [
  { name: 'fk1', from_table: 'enrollments', from_column: 'student_id', to_table: 'students', to_column: 'id' },
]

describe('toMermaid', () => {
  it('emits erDiagram with table blocks + PK/FK keys', () => {
    const m = toMermaid(tables, fks)
    expect(m.startsWith('erDiagram')).toBe(true)
    expect(m).toContain('students {')
    expect(m).toContain('int4 id PK')
    expect(m).toContain('int4 student_id FK')
    // strips length from type
    expect(m).toContain('varchar name')
  })

  it('emits parent ||--o{ child relationship with fk column label', () => {
    const m = toMermaid(tables, fks)
    expect(m).toContain('students ||--o{ enrollments : "student_id"')
  })

  it('sanitizes identifiers starting with a digit', () => {
    const m = toMermaid([{ name: '1tbl', columns: [] }], [])
    expect(m).toContain('t_1tbl {')
  })
})

describe('toSvg', () => {
  const pos = { students: { x: 300, y: 0 }, enrollments: { x: 0, y: 0 } }

  it('produces a standalone svg containing table names + edges', () => {
    const svg = toSvg(tables, fks, pos)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('students')
    expect(svg).toContain('student_id')
  })

  it('draws relationships like the canvas: orthogonal rounded route + crow\'s foot, from the FK row to the PK row', () => {
    const svg = toSvg(tables, fks, pos, { sizes: { enrollments: { w: 180 }, students: { w: 180 } } })
    // never the old straight centre-to-centre line, never a bezier
    expect(svg).not.toMatch(/<line[^>]*stroke="#5b7cff"/)
    const g = /<g fill="none" stroke="[^"]+"[^>]*><title>enrollments\.student_id → students\.id<\/title><path d="([^"]+)"\/><path d="([^"]+)"\/><path d="([^"]+)"\/><\/g>/.exec(svg)
    expect(g).not.toBeNull()
    const [, route, many, one] = g!
    expect(route).not.toMatch(/C/)
    // shared geometry: identical to the canvas edge for the same anchors.
    // padding 40 + the 40px route margin → x shifted by 80; y by 40.
    // FK row student_id is the 2nd row: 40 + 1 + 32 + 25 + 12.5 = 110.5
    const sx = 80 + 180 + ER_CARD.anchorOut
    const tx = 80 + 300 - ER_CARD.anchorOut
    const sy = 40 + 1 + 32 + 25 + 12.5
    const ty = 40 + 1 + 32 + 12.5
    expect(route).toBe(erRoute(sx, sy, 1, tx, ty, -1).d)
    expect(many).toBe(manyEnd(sx, sy, 1))
    expect(one).toBe(oneEnd(tx, ty, -1))
  })

  it('shifts negative positions into view (tables dragged above/left of the origin)', () => {
    const svg = toSvg(tables, fks, { students: { x: -500, y: -300 }, enrollments: { x: -900, y: -300 } })
    const xs = [...svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])])
    expect(xs.length).toBeGreaterThan(0)
    for (const [x, y] of xs) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
    }
  })

  it('exports the canvas state: unsaved relationships dashed, PK+FK-only rows, rendered width, theme colours', () => {
    const pending: ForeignKey[] = [{ name: 'p', from_table: 'enrollments', from_column: 'id', to_table: 'students', to_column: 'id' }]
    const palette = { ...ER_SVG_LIGHT, edge: '#123456', pending: '#00aa00', bg: '#fefefe' }
    const svg = toSvg(tables, fks, pos, { pending, showAll: false, sizes: { students: { w: 260 } }, palette })
    expect(svg).toMatch(/stroke="#00aa00"[^>]*>.*?<path d="[^"]+" stroke-dasharray="6 4"\/>/)
    expect(svg).toContain('stroke="#123456"')
    expect(svg).toContain('fill="#fefefe"')
    // "name" is neither PK nor FK → hidden; the PK row stays
    expect(svg).not.toContain('>name<')
    expect(svg).toContain('width="260"')
  })
})

describe('tableSize', () => {
  it('grows height with column count', () => {
    const a = tableSize({ name: 'a', columns: [] })
    const b = tableSize(tables[0])
    expect(b.h).toBeGreaterThan(a.h)
  })
})
