import { describe, expect, it } from 'vitest'
import { toMermaid, toSvg, tableSize, type ErTable } from './mermaid'
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
  it('produces a standalone svg containing table names + edges', () => {
    const pos = { students: { x: 0, y: 0 }, enrollments: { x: 300, y: 0 } }
    const svg = toSvg(tables, fks, pos)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('students')
    expect(svg).toContain('<line')
  })
})

describe('tableSize', () => {
  it('grows height with column count', () => {
    const a = tableSize({ name: 'a', columns: [] })
    const b = tableSize(tables[0])
    expect(b.h).toBeGreaterThan(a.h)
  })
})
