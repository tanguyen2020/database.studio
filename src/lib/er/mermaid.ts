// ER Diagram helpers (Phase 5 · T8) — sinh Mermaid erDiagram + SVG export.
// Thuần (không phụ thuộc SvelteFlow) → unit-test được.
import type { ForeignKey } from '$lib/ipc'

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

/** Kích thước 1 node table theo số cột (cho layout + SVG). */
export function tableSize(t: ErTable): { w: number; h: number } {
  const w = 200
  const h = 30 + t.columns.length * 20 + 8
  return { w, h }
}

/** Sinh SVG standalone từ tables + FKs + vị trí (đã layout). Dùng cho export
 *  SVG/PNG (không phụ thuộc DOM của SvelteFlow). */
export function toSvg(
  tables: ErTable[],
  fks: ForeignKey[],
  pos: Record<string, { x: number; y: number }>,
): string {
  const pad = 40
  let maxX = 0
  let maxY = 0
  for (const t of tables) {
    const p = pos[t.name] ?? { x: 0, y: 0 }
    const s = tableSize(t)
    maxX = Math.max(maxX, p.x + s.w)
    maxY = Math.max(maxY, p.y + s.h)
  }
  const width = maxX + pad
  const height = maxY + pad

  const boxes: string[] = []
  const centers: Record<string, { cx: number; cy: number; w: number; h: number }> = {}
  for (const t of tables) {
    const p = pos[t.name] ?? { x: 0, y: 0 }
    const s = tableSize(t)
    centers[t.name] = { cx: p.x + s.w / 2, cy: p.y + s.h / 2, w: s.w, h: s.h }
    let y = p.y
    boxes.push(
      `<rect x="${p.x}" y="${p.y}" width="${s.w}" height="${s.h}" rx="8" fill="#1b1f2a" stroke="#333b4d"/>`,
    )
    boxes.push(
      `<rect x="${p.x}" y="${p.y}" width="${s.w}" height="26" rx="8" fill="#222838"/>` +
        `<text x="${p.x + 10}" y="${p.y + 17}" fill="#e6e9f0" font-size="12" font-weight="700" font-family="monospace">${escapeXml(t.name)}</text>`,
    )
    y += 30
    for (const c of t.columns) {
      const badge = c.pk ? '🔑' : c.fk ? '🔗' : ''
      boxes.push(
        `<text x="${p.x + 10}" y="${y + 4}" fill="#aab2c4" font-size="11" font-family="monospace">${badge} ${escapeXml(c.name)}</text>` +
          `<text x="${p.x + s.w - 10}" y="${y + 4}" text-anchor="end" fill="#6b7486" font-size="10" font-family="monospace">${escapeXml(c.type)}</text>`,
      )
      y += 20
    }
  }

  const edges: string[] = []
  for (const fk of fks) {
    const a = centers[fk.from_table]
    const b = centers[fk.to_table]
    if (!a || !b) continue
    edges.push(
      `<line x1="${a.cx}" y1="${a.cy}" x2="${b.cx}" y2="${b.cy}" stroke="#5b7cff" stroke-width="1.5"/>`,
    )
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="#0f1219"/>` +
    edges.join('') +
    boxes.join('') +
    `</svg>`
  )
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
