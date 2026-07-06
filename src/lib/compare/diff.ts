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
/** Routine/trigger so sánh theo text DDL (procedure/function/trigger) — T19. */
export interface CmpRoutine {
  name: string
  kind: 'procedure' | 'function' | 'trigger'
  ddl: string
}
export interface SchemaSnapshot {
  tables: CmpTable[]
  routines?: CmpRoutine[]
  sequences?: string[]
}

export type DiffStatus = 'identical' | 'different' | 'src_only' | 'tgt_only'
export type ObjectKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'sequence'

export interface ColDiff {
  name: string
  status: DiffStatus
  srcType?: string
  tgtType?: string
}
export interface ObjectDiff {
  kind: ObjectKind
  name: string
  status: DiffStatus
  columns: ColDiff[]
  /** DDL 2 phía (routine/trigger) — cho panel diff cạnh nhau + migration. */
  srcDdl?: string
  tgtDdl?: string
}

/** Chuẩn hóa DDL để so sánh (bỏ khoảng trắng thừa, hạ chữ thường) — tránh khác
 *  biệt vô nghĩa (indent/space). */
function normDdl(ddl: string): string {
  return ddl.replace(/\s+/g, ' ').trim().toLowerCase()
}

function colKey(c: CmpColumn): string {
  return `${c.type}|${c.nullable ? 'null' : 'notnull'}|${c.pk ? 'pk' : ''}`
}

/** So sánh 2 snapshot → danh sách ObjectDiff (theo tên bảng, hợp nhất 2 phía). */
export function compareSchemas(src: SchemaSnapshot, tgt: SchemaSnapshot): ObjectDiff[] {
  const srcMap = new Map(src.tables.map((t) => [t.name, t]))
  const tgtMap = new Map(tgt.tables.map((t) => [t.name, t]))
  const names = [...new Set([...srcMap.keys(), ...tgtMap.keys()])].sort()

  const tableDiffs: ObjectDiff[] = names.map((name) => {
    const s = srcMap.get(name)
    const t = tgtMap.get(name)
    if (s && !t) return { kind: s.kind, name, status: 'src_only', columns: colDiffs(s, undefined) }
    if (!s && t) return { kind: t.kind, name, status: 'tgt_only', columns: colDiffs(undefined, t) }
    const cols = colDiffs(s, t)
    const status: DiffStatus = cols.some((c) => c.status !== 'identical') ? 'different' : 'identical'
    return { kind: (s ?? t)!.kind, name, status, columns: cols }
  })

  // Routines/triggers — so theo text DDL.
  const srcR = new Map((src.routines ?? []).map((r) => [`${r.kind}:${r.name}`, r]))
  const tgtR = new Map((tgt.routines ?? []).map((r) => [`${r.kind}:${r.name}`, r]))
  const rKeys = [...new Set([...srcR.keys(), ...tgtR.keys()])].sort()
  const routineDiffs: ObjectDiff[] = rKeys.map((key) => {
    const s = srcR.get(key)
    const t = tgtR.get(key)
    const kind = (s ?? t)!.kind
    const name = (s ?? t)!.name
    const base = { kind, name, columns: [] as ColDiff[], srcDdl: s?.ddl, tgtDdl: t?.ddl }
    if (s && !t) return { ...base, status: 'src_only' }
    if (!s && t) return { ...base, status: 'tgt_only' }
    return { ...base, status: normDdl(s!.ddl) === normDdl(t!.ddl) ? 'identical' : 'different' }
  })

  // Sequences — compared by existence (name), no structural diff.
  const srcS = new Set(src.sequences ?? [])
  const tgtS = new Set(tgt.sequences ?? [])
  const seqDiffs: ObjectDiff[] = [...new Set([...srcS, ...tgtS])].sort().map((name) => {
    const status: DiffStatus = srcS.has(name) && !tgtS.has(name) ? 'src_only' : !srcS.has(name) && tgtS.has(name) ? 'tgt_only' : 'identical'
    return { kind: 'sequence', name, status, columns: [] }
  })

  return [...tableDiffs, ...routineDiffs, ...seqDiffs]
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
  const out: string[] = ['-- Migration: sync TARGET to match SOURCE', '-- Review carefully before running.', '']

  for (const d of diffs.filter(pick)) {
    if (d.kind === 'sequence') {
      if (d.status === 'src_only') out.push(`CREATE SEQUENCE ${q(d.name)};`)
      else if (d.status === 'tgt_only') out.push(`DROP SEQUENCE IF EXISTS ${q(d.name)};`)
      continue
    }
    // Routines/triggers: đồng bộ bằng chính DDL nguồn (CREATE OR REPLACE) / DROP.
    if (d.kind === 'procedure' || d.kind === 'function' || d.kind === 'trigger') {
      const kw = d.kind === 'trigger' ? 'TRIGGER' : d.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION'
      if (d.status === 'tgt_only') {
        out.push(`DROP ${kw} IF EXISTS ${q(d.name)};`)
      } else if ((d.status === 'src_only' || d.status === 'different') && d.srcDdl) {
        if (d.status === 'different') out.push(`-- ${kw} ${d.name}: TARGET differs from SOURCE, replacing with source definition`)
        out.push(d.srcDdl.trim().endsWith(';') ? d.srcDdl.trim() : `${d.srcDdl.trim()};`)
      }
      continue
    }
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

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/** Line-diff đơn giản (LCS) cho panel DDL cạnh nhau: dòng chỉ có ở TARGET = del,
 *  chỉ có ở SOURCE = add, chung = same. Thuần → test được. */
export function lineDiff(tgt: string, src: string): DiffLine[] {
  const a = tgt.split('\n')
  const b = src.split('\n')
  const n = a.length
  const m = b.length
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i] }) // chỉ có ở TARGET
      i++
    } else {
      out.push({ type: 'add', text: b[j] }) // chỉ có ở SOURCE
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}
