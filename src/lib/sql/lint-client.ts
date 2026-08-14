// Client của lint tầng 1: gọi command `lint_sql` (parse-only, debounce do
// CodeMirror linter đảm nhiệm) + cảnh báo schema-aware từ cache autocomplete
// (addendum §1.3 — squiggle VÀNG advisory, schema cache có thể cũ).

import type { Diagnostic } from '@codemirror/lint'
import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI } from '$lib/demo'
import { lineColToOffset } from './statements'

export interface LintDiagnosticIpc {
  severity: 'error' | 'warning' | 'info'
  message: string
  from: { line: number; col: number }
  to: { line: number; col: number }
  rule: string
  quickfix?: string
}

export async function lintSql(system: string, sql: string): Promise<LintDiagnosticIpc[]> {
  if (!IS_TAURI) return [] // demo/browser: không có backend parser
  try {
    return await invoke<LintDiagnosticIpc[]>('lint_sql', { system, sql })
  } catch {
    return [] // lint là advisory — lỗi IPC thì im lặng
  }
}

export function toCmDiagnostics(doc: string, lints: LintDiagnosticIpc[]): Diagnostic[] {
  return lints.map((l) => {
    const from = lineColToOffset(doc, l.from.line, l.from.col)
    const to = Math.max(lineColToOffset(doc, l.to.line, l.to.col), from + 1)
    return {
      from,
      to: Math.min(to, doc.length) || from + 1,
      severity: l.severity === 'info' ? 'info' : l.severity,
      message: l.quickfix ? `${l.message}\n💡 ${l.quickfix}` : l.message,
      source: l.rule,
    }
  })
}

/**
 * Cảnh báo schema-aware (tầng 1, §1.3): tên bảng sau FROM/JOIN/UPDATE/INTO
 * không có trong schema cache → squiggle vàng + gợi ý fuzzy. Advisory —
 * cache có thể cũ nên chỉ warning, không error.
 */
export function schemaLints(doc: string, knownTables: string[]): Diagnostic[] {
  if (knownTables.length === 0) return []
  const known = new Set(knownTables.map((t) => t.toLowerCase()))
  const out: Diagnostic[] = []
  // One fuzzy search per DISTINCT unknown name. Without this, a long script that
  // references the same missing table 500 times ran 500 full scans of the schema
  // (500 × every known table) on every lint pass — the same "rescan per item"
  // shape that made the statement splitter quadratic.
  const suggestFor = new Map<string, string | null>()
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[\w$.]+))/gi
  for (const m of doc.matchAll(re)) {
    const raw = m[1]
    // bỏ qua subquery / định danh có schema prefix phức tạp
    if (raw.startsWith('(')) continue
    const bare = raw.replace(/^["`\[]|["`\]]$/g, '')
    const name = (bare.split('.').pop() ?? bare).toLowerCase()
    if (known.has(name)) continue
    const start = (m.index ?? 0) + m[0].length - raw.length
    if (!suggestFor.has(name)) suggestFor.set(name, fuzzyClosest(name, knownTables))
    const suggestion = suggestFor.get(name) ?? null
    out.push({
      from: start,
      to: start + raw.length,
      severity: 'warning',
      message: `Table "${bare}" not found in the schema cache${suggestion ? ` — did you mean "${suggestion}"?` : ''}`,
      source: 'schema.unknown_table',
    })
  }
  return out
}

/** Gợi ý gần đúng đơn giản (khoảng cách Levenshtein ≤ 2). */
export function fuzzyClosest(name: string, candidates: string[]): string | null {
  let best: string | null = null
  let bestDist = 3
  for (const c of candidates) {
    const d = levenshtein(name, c.toLowerCase())
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length]
}
