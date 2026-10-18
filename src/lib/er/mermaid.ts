// ER Diagram helpers (Phase 5 · T8) — sinh Mermaid erDiagram + SVG export.
// Thuần (không phụ thuộc SvelteFlow) → unit-test được.
import type { ForeignKey } from '$lib/ipc'
import { laneOffsets } from './diagram'
import { erRoute, manyEnd, oneEnd } from './edge-geometry'

export interface ErColumn {
  name: string
  type: string
  pk: boolean
  fk: boolean
}
export interface ErTable {
  name: string
  columns: ErColumn[]
}

/** Mermaid định danh: chỉ [A-Za-z0-9_], không bắt đầu bằng số. */
function mermaidId(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[0-9]/.test(clean) ? `t_${clean}` : clean
}

/** Kiểu Mermaid attr: bỏ ngoặc/độ dài (varchar(80) → varchar). */
function mermaidType(t: string): string {
  return t.replace(/\(.*/, '').replace(/[^A-Za-z0-9_]/g, '_') || 'text'
}

/** Sinh cú pháp `erDiagram` từ tables + FKs (copy/paste vào GitHub/Mermaid Live). */
export function toMermaid(tables: ErTable[], fks: ForeignKey[]): string {
  const lines: string[] = ['erDiagram']
  for (const t of tables) {
    lines.push(`  ${mermaidId(t.name)} {`)
    for (const c of t.columns) {
      const key = c.pk ? ' PK' : c.fk ? ' FK' : ''
      lines.push(`    ${mermaidType(c.type)} ${c.name.replace(/[^A-Za-z0-9_]/g, '_')}${key}`)
    }
    lines.push('  }')
  }
  // Parent ||--o{ Child : "fk_col"  (child giữ FK trỏ tới parent)
  for (const fk of fks) {
    lines.push(`  ${mermaidId(fk.to_table)} ||--o{ ${mermaidId(fk.from_table)} : "${fk.from_column}"`)
  }
  return lines.join('\n')
}

/** Geometry of a table card — the SAME numbers the canvas node (ErTableNode)
 *  renders at, measured in the app: 1px border, 32px header, 25px per column row,
 *  and the relationship anchors sit 3px outside the card edge. The SVG export
 *  draws with these so it lines up with what was on screen. */
export const ER_CARD = { border: 1, header: 32, row: 25, anchorOut: 3, padX: 11, minW: 130 } as const

/** Kích thước 1 node table theo số cột (cho layout + SVG). */
export function tableSize(t: ErTable): { w: number; h: number } {
  const w = 200
  const h = ER_CARD.border * 2 + ER_CARD.header + t.columns.length * ER_CARD.row
  return { w, h }
}

/** Colours of the export — the app passes its current theme (resolved CSS
 *  variables) so the picture matches the canvas; these are the fallbacks. */
export interface ErSvgPalette {
  bg: string
  grid: string
  card: string
  header: string
  border: string
  rowBorder: string
  text: string
  muted: string
  edge: string
  pending: string
  pk: string
  fk: string
}

export const ER_SVG_LIGHT: ErSvgPalette = {
  bg: '#f4f5f7',
  grid: '#d3d8e1',
  card: '#f8f9fb',
  header: '#ffffff',
  border: '#d5d9e0',
  rowBorder: '#e5e7eb',
  text: '#1c2230',
  muted: '#646c7b',
  edge: '#8a95a8',
  pending: '#27ae60',
  pk: '#b7791f',
  fk: '#646c7b',
}

export const ER_SVG_DARK: ErSvgPalette = {
  bg: '#111318',
  grid: '#2a2e38',
  card: '#1b1e25',
  header: '#22252e',
  border: '#343846',
  rowBorder: '#2a2e38',
  text: '#e6e8ee',
  muted: '#868d9c',
  edge: '#5d6578',
  pending: '#27ae60',
  pk: '#e0b341',
  fk: '#868d9c',
}

export interface ErSvgOptions {
  /** rendered card widths (and heights) per table — the canvas measures them */
  sizes?: Record<string, { w: number; h?: number }>
  /** relationships drawn on the canvas but not saved yet (dashed, like on screen) */
  pending?: ForeignKey[]
  /** false = only PK/FK rows, like the canvas "PK+FK only" toggle */
  showAll?: boolean
  palette?: ErSvgPalette
  /** dotted background grid, like the canvas (default on) */
  grid?: boolean
}

const FONT = "'JetBrains Mono', ui-monospace, Consolas, monospace"

/** Sinh SVG standalone từ tables + FKs + vị trí (đã layout). Dùng cho export
 *  SVG/PNG (không phụ thuộc DOM của SvelteFlow). Cards, relationship routes and
 *  crow's-foot ends are drawn exactly as on the canvas (shared edge geometry). */
export function toSvg(
  tables: ErTable[],
  fks: ForeignKey[],
  pos: Record<string, { x: number; y: number }>,
  opts: ErSvgOptions = {},
): string {
  const pal = opts.palette ?? ER_SVG_DARK
  const showAll = opts.showAll ?? true
  const pad = 40

  // card boxes in diagram coordinates
  interface Card {
    t: ErTable
    x: number
    y: number
    w: number
    h: number
    rows: ErColumn[]
  }
  const cards = new Map<string, Card>()
  for (const t of tables) {
    const p = pos[t.name]
    if (!p) continue
    const rows = showAll ? t.columns : t.columns.filter((c) => c.pk || c.fk)
    const w = Math.max(ER_CARD.minW, opts.sizes?.[t.name]?.w ?? tableSize(t).w)
    const h = ER_CARD.border * 2 + ER_CARD.header + rows.length * ER_CARD.row
    cards.set(t.name, { t, x: p.x, y: p.y, w, h, rows })
  }
  if (cards.size === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${pad * 2}" height="${pad * 2}" viewBox="0 0 ${pad * 2} ${pad * 2}"><rect width="100%" height="100%" fill="${pal.bg}"/></svg>`
  }

  // the column's anchor (row middle); a hidden/unknown column falls back to the
  // card's vertical middle — the node-level handle the canvas uses then
  const anchorY = (c: Card, col: string) => {
    const i = c.rows.findIndex((r) => r.name === col)
    return i < 0 ? c.y + c.h / 2 : c.y + ER_CARD.border + ER_CARD.header + i * ER_CARD.row + ER_CARD.row / 2
  }

  const rels = [
    ...fks.map((fk, i) => ({ fk, id: `fk-${i}`, pending: false })),
    ...(opts.pending ?? []).map((fk, i) => ({ fk, id: `pfk-${i}`, pending: true })),
  ].filter((r) => cards.has(r.fk.from_table) && cards.has(r.fk.to_table))
  const lanes = laneOffsets(
    rels.map((r): [string, string, string] => [r.id, r.fk.from_table, r.fk.from_column]),
    (table, col) => cards.get(table)?.t.columns.findIndex((c) => c.name === col) ?? 0,
  )

  // bounds — cards plus anything a route sticks out with (routes step 22px out)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of cards.values()) {
    minX = Math.min(minX, c.x - 40)
    minY = Math.min(minY, c.y)
    maxX = Math.max(maxX, c.x + c.w + 40)
    maxY = Math.max(maxY, c.y + c.h)
  }
  const ox = pad - minX
  const oy = pad - minY
  const width = Math.ceil(maxX - minX + pad * 2)
  const height = Math.ceil(maxY - minY + pad * 2)
  const X = (x: number) => x + ox
  const Y = (y: number) => y + oy

  const edges: string[] = []
  for (const r of rels) {
    const a = cards.get(r.fk.from_table)!
    const b = cards.get(r.fk.to_table)!
    const sx = X(a.x + a.w + ER_CARD.anchorOut)
    const sy = Y(anchorY(a, r.fk.from_column))
    const tx = X(b.x - ER_CARD.anchorOut)
    const ty = Y(anchorY(b, r.fk.to_column))
    const lane = lanes[r.id] ?? 0
    const route = erRoute(sx, sy, 1, tx, ty, -1, { centerX: lane && tx - sx > 60 ? (sx + tx) / 2 + lane : undefined })
    const color = r.pending ? pal.pending : pal.edge
    const dash = r.pending ? ' stroke-dasharray="6 4"' : ''
    edges.push(
      `<g fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
        `<title>${escapeXml(`${r.fk.from_table}.${r.fk.from_column} → ${r.fk.to_table}.${r.fk.to_column}`)}</title>` +
        `<path d="${route.d}"${dash}/>` +
        `<path d="${manyEnd(sx, sy, 1)}"/>` +
        `<path d="${oneEnd(tx, ty, -1)}"/>` +
        `</g>`,
    )
  }

  const defs: string[] = [
    `<filter id="er-shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#101828" flood-opacity="0.12"/></filter>`,
  ]
  if (opts.grid ?? true) {
    defs.push(
      `<pattern id="er-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="0.9" fill="${pal.grid}"/></pattern>`,
    )
  }

  const boxes: string[] = []
  let ci = 0
  for (const c of cards.values()) {
    const x = X(c.x)
    const y = Y(c.y)
    const clip = `er-c${ci++}`
    defs.push(`<clipPath id="${clip}"><rect x="${x}" y="${y}" width="${c.w}" height="${c.h}" rx="10"/></clipPath>`)
    const parts: string[] = []
    parts.push(`<rect x="${x}" y="${y}" width="${c.w}" height="${c.h}" rx="10" fill="${pal.card}" filter="url(#er-shadow)"/>`)
    parts.push(`<g clip-path="url(#${clip})">`)
    // header band + its bottom rule
    parts.push(`<rect x="${x}" y="${y}" width="${c.w}" height="${ER_CARD.border + ER_CARD.header}" fill="${pal.header}"/>`)
    parts.push(`<line x1="${x}" y1="${y + ER_CARD.header + 0.5}" x2="${x + c.w}" y2="${y + ER_CARD.header + 0.5}" stroke="${pal.rowBorder}"/>`)
    parts.push(
      `<text x="${x + ER_CARD.padX}" y="${y + ER_CARD.border + 21}" fill="${pal.text}" font-size="13" font-weight="700" font-family="${FONT}">${escapeXml(c.t.name)}</text>`,
    )
    let ry = y + ER_CARD.border + ER_CARD.header
    c.rows.forEach((col, i) => {
      const mid = ry + ER_CARD.row / 2
      if (i < c.rows.length - 1) {
        parts.push(`<line x1="${x}" y1="${ry + ER_CARD.row - 0.5}" x2="${x + c.w}" y2="${ry + ER_CARD.row - 0.5}" stroke="${pal.rowBorder}"/>`)
      }
      // PK / FK marker in the canvas's 14px key slot (text badges travel better
      // than the canvas emoji in exported files)
      if (col.pk || col.fk) {
        parts.push(
          `<text x="${x + ER_CARD.padX}" y="${mid + 3}" fill="${col.pk ? pal.pk : pal.fk}" font-size="8" font-weight="700" font-family="${FONT}">${col.pk ? 'PK' : 'FK'}</text>`,
        )
      }
      parts.push(
        `<text x="${x + ER_CARD.padX + 20}" y="${mid + 4}" fill="${pal.text}" font-size="12" font-weight="${col.pk ? 600 : 500}" font-family="${FONT}">${escapeXml(col.name)}</text>`,
      )
      parts.push(
        `<text x="${x + c.w - ER_CARD.padX}" y="${mid + 3}" text-anchor="end" fill="${pal.muted}" font-size="10" font-family="${FONT}">${escapeXml(col.type)}</text>`,
      )
      ry += ER_CARD.row
    })
    parts.push(`</g>`)
    parts.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${c.w - 1}" height="${c.h - 1}" rx="9.5" fill="none" stroke="${pal.border}"/>`)
    boxes.push(`<g>${parts.join('')}</g>`)
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${defs.join('')}</defs>` +
    `<rect width="${width}" height="${height}" fill="${pal.bg}"/>` +
    (opts.grid ?? true ? `<rect width="${width}" height="${height}" fill="url(#er-grid)"/>` : '') +
    edges.join('') +
    boxes.join('') +
    `</svg>`
  )
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
