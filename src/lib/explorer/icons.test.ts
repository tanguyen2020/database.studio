import { describe, expect, it } from 'vitest'
import { dbIcon, partitionedTableIcon, rowIcon } from './icons'

// Every glyph the tree still passes. If a row is given a new glyph and nobody adds it
// here, the row silently falls back to rendering the character — this list is what
// stops that going unnoticed.
const GLYPHS = ['▦', '◫', '▸', '⌗', 'ƒ', '⚙', '⚡', '#', '⊞', '▢', '🔐', '▤', '✉']
const NAMES = [
  'database', 'schema', 'folder', 'table', 'view', 'column', 'index', 'constraint',
  'function', 'procedure', 'trigger', 'sequence', 'dictionary', 'udt', 'security',
  'partition', 'subject', 'settings',
]

describe('dbIcon', () => {
  it('draws every named mark as a self-contained svg', () => {
    for (const n of NAMES) {
      const svg = dbIcon(n)
      expect(svg, n).toBeTruthy()
      expect(svg, n).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/)
      expect(svg!.endsWith('</svg>'), n).toBe(true)
      // the row owns the colour: nothing may hard-code one
      expect(svg, n).toContain('stroke="currentColor"')
      expect(svg!.replace(/currentColor/g, ''), n).not.toMatch(/#[0-9a-f]{3,6}/i)
    }
  })

  it('sizes to the box it is given', () => {
    expect(dbIcon('table', 14)).toContain('width="14" height="14"')
    expect(dbIcon('table', 52)).toContain('width="52" height="52"')
  })

  it('returns nothing for a name it does not know, so the caller can fall back', () => {
    expect(dbIcon('nope')).toBeUndefined()
    expect(dbIcon(undefined)).toBeUndefined()
  })

  it('gives each object type a mark of its own — no two are the same drawing', () => {
    const drawn = NAMES.filter((n) => n !== 'folder').map((n) => dbIcon(n))
    expect(new Set(drawn).size).toBe(drawn.length)
  })
})

describe('rowIcon', () => {
  it('maps every glyph still used in the tree', () => {
    for (const g of GLYPHS) expect(rowIcon(undefined, g), g).toBeTruthy()
  })

  it('lets a row name its mark when the glyph is ambiguous', () => {
    // ⌗ is an index by default; the Constraints rows ask for the chain instead
    expect(rowIcon(undefined, '⌗')).toBe(dbIcon('index'))
    expect(rowIcon('constraint', '⌗')).toBe(dbIcon('constraint'))
    // ▤ is a folder by default; Columns / schema / Tables rows say what they are
    expect(rowIcon(undefined, '▤')).toBe(dbIcon('folder'))
    expect(rowIcon('column', '▤')).toBe(dbIcon('column'))
    expect(rowIcon('schema', '▤')).toBe(dbIcon('schema'))
    expect(rowIcon('database', '')).toBe(dbIcon('database'))
  })

  it('leaves placeholder rows alone (they keep their character)', () => {
    expect(rowIcon(undefined, '·')).toBeUndefined()
    expect(rowIcon(undefined, '')).toBeUndefined()
  })
})

describe('partitionedTableIcon', () => {
  it('is the table mark plus a badge, so a partitioned table still reads as a table', () => {
    const svg = partitionedTableIcon()
    const table = dbIcon('table')!
    // the drawing inside the table icon appears verbatim in the badged one
    const body = table.slice(table.indexOf('>') + 1, -'</svg>'.length)
    expect(svg).toContain(body)
    expect(svg).toContain('data-badge="partitioned"')
    expect(svg).toContain('aria-label="Partitioned table"')
    // the badge colour is a token, and the ring that lifts it off the outline is --bg
    expect(svg).toContain('var(--badge-part)')
    expect(svg).toContain('var(--bg)')
  })
})
