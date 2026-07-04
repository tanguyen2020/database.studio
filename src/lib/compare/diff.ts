// Schema Compare (Phase 5 · T9) — diff engine + migration generator. Thuần
// (không I/O) → unit-test được. So sánh cấu trúc (tables/columns), KHÔNG so data.
import { quoteIdent } from '$lib/sql/dialect'

export interface CmpColumn {
  name: string
  type: string
  nullable: boolean
  pk: boolean
}
export interface CmpTable {
  name: string
  kind: 'table' | 'view'
  columns: CmpColumn[]
}
export interface SchemaSnapshot {
  tables: CmpTable[]
}

export type DiffStatus = 'identical' | 'different' | 'src_only' | 'tgt_only'

export interface ColDiff {
  name: string
  status: DiffStatus
  srcType?: string
  tgtType?: string
}
export interface ObjectDiff {
  kind: 'table' | 'view'
  name: string
  status: DiffStatus
  columns: ColDiff[]
}

function colKey(c: CmpColumn): string {
  return `${c.type}|${c.nullable ? 'null' : 'notnull'}|${c.pk ? 'pk' : ''}`
}

/** So sánh 2 snapshot → danh sách ObjectDiff (theo tên bảng, hợp nhất 2 phía). */
export function compareSchemas(src: SchemaSnapshot, tgt: SchemaSnapshot): ObjectDiff[] {
  const srcMap = new Map(src.tables.map((t) => [t.name, t]))
  const tgtMap = new Map(tgt.tables.map((t) => [t.name, t]))
  const names = [...new Set([...srcMap.keys(), ...tgtMap.keys()])].sort()

  return names.map((name) => {
    const s = srcMap.get(name)
    const t = tgtMap.get(name)
    if (s && !t) return { kind: s.kind, name, status: 'src_only', columns: colDiffs(s, undefined) }
    if (!s && t) return { kind: t.kind, name, status: 'tgt_only', columns: colDiffs(undefined, t) }
    const cols = colDiffs(s, t)
    const status: DiffStatus = cols.some((c) => c.status !== 'identical') ? 'different' : 'identical'
    return { kind: (s ?? t)!.kind, name, status, columns: cols }
  })
}

function colDiffs(s?: CmpTable, t?: CmpTable): ColDiff[] {
  const sMap = new Map((s?.columns ?? []).map((c) => [c.name, c]))
  const tMap = new Map((t?.columns ?? []).map((c) => [c.name, c]))
  const names = [...new Set([...sMap.keys(), ...tMap.keys()])]
  return names.map((name) => {
    const sc = sMap.get(name)
    const tc = tMap.get(name)
    let status: DiffStatus
    if (sc && !tc) status = 'src_only'
    else if (!sc && tc) status = 'tgt_only'
    else status = colKey(sc!) === colKey(tc!) ? 'identical' : 'different'
    return { name, status, srcType: sc?.type, tgtType: tc?.type }
  })
}

/** Đếm add/changed/delete để hiển thị badge (theo hướng đồng bộ TARGET ← SOURCE). */
export function diffCounts(diffs: ObjectDiff[]): { add: number; changed: number; del: number } {
  let add = 0
  let changed = 0
  let del = 0
  for (const d of diffs) {
    if (d.status === 'src_only') add++
    else if (d.status === 'tgt_only') del++
    else if (d.status === 'different') changed++
  }
  return { add, changed, del }
}

/** Sinh migration SQL để TARGET khớp SOURCE (chỉ các object được chọn). */
export function genMigration(diffs: ObjectDiff[], system: string, selected?: Set<string>): string {
  const q = (n: string) => quoteIdent(system, n)
  const pick = (d: ObjectDiff) => !selected || selected.has(d.name)
  const out: string[] = ['-- Migration: đồng bộ TARGET theo SOURCE', '-- Review kỹ trước khi chạy.', '']

  for (const d of diffs.filter(pick)) {
    if (d.status === 'src_only') {
      const cols = d.columns.map((c) => `  ${q(c.name)} ${c.srcType ?? 'text'}`).join(',\n')
      out.push(`CREATE TABLE ${q(d.name)} (\n${cols}\n);`)
    } else if (d.status === 'tgt_only') {
      out.push(`DROP TABLE ${q(d.name)};`)
    } else if (d.status === 'different') {
      for (const c of d.columns) {
        if (c.status === 'src_only') {
          out.push(`ALTER TABLE ${q(d.name)} ADD COLUMN ${q(c.name)} ${c.srcType ?? 'text'};`)
        } else if (c.status === 'tgt_only') {
          out.push(`ALTER TABLE ${q(d.name)} DROP COLUMN ${q(c.name)};`)
        } else if (c.status === 'different') {
          const clause =
            system === 'mysql' || system === 'mariadb'
              ? `MODIFY COLUMN ${q(c.name)} ${c.srcType ?? 'text'}`
              : system === 'mssql'
                ? `ALTER COLUMN ${q(c.name)} ${c.srcType ?? 'text'}`
                : `ALTER COLUMN ${q(c.name)} TYPE ${c.srcType ?? 'text'}`
          out.push(`ALTER TABLE ${q(d.name)} ${clause};`)
        }
      }
    }
  }
  return out.join('\n')
}
