// Clipboard data extractors (AUDIT-3 · item 5). Turn a selection of grid rows
// (objects keyed by column name) into the format the user asks for. Pure →
// unit-testable; the component only handles the actual navigator.clipboard write.
import { toCsv, toJson, toSqlInsert, sqlLiteral } from './rows'

export type ClipFormat = 'tsv' | 'csv' | 'json' | 'sql-insert' | 'sql-update' | 'markdown'

export interface CopyInput {
  headers: string[]
  rows: Record<string, unknown>[]
  /** Table name for SQL INSERT/UPDATE (falls back to a placeholder). */
  table?: string
  /** Key columns for the UPDATE … WHERE clause; falls back to all columns. */
  keyColumns?: string[]
}

/** Raw scalar text of a cell (objects → JSON). NULL → empty string. */
export function rawCell(v: unknown): string {
  if (v == null) return ''
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** Tab-separated (Excel/Sheets friendly). Tabs/newlines in cells are flattened
 *  to spaces so the row/column grid stays intact on paste. */
export function toTsv(headers: string[], rows: Record<string, unknown>[], includeHeader = true): string {
  const esc = (v: unknown) => rawCell(v).replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
  const body = rows.map((r) => headers.map((h) => esc(r[h])).join('\t')).join('\n')
  return includeHeader ? [headers.join('\t'), body].filter((s) => s !== '').join('\n') : body
}

/** GitHub-flavored Markdown table. `|` escaped, newlines → <br>. */
export function toMarkdownTable(headers: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => rawCell(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${headers.map((h) => esc(r[h])).join(' | ')} |`).join('\n')
  return [head, sep, body].filter((s) => s !== '').join('\n')
}

/** `UPDATE <table> SET … WHERE <key…>;` per row. Non-key columns go in SET,
 *  key columns in WHERE. With no key columns, every column keys the WHERE. */
export function toSqlUpdate(
  table: string,
  headers: string[],
  rows: Record<string, unknown>[],
  keyColumns?: string[],
): string {
  const keys = keyColumns && keyColumns.length ? keyColumns.filter((k) => headers.includes(k)) : headers
  const setCols = headers.filter((h) => !keys.includes(h))
  return rows
    .map((r) => {
      const set = (setCols.length ? setCols : headers)
        .map((h) => `"${h}" = ${sqlLiteral(r[h])}`)
        .join(', ')
      const where = keys.map((k) => `"${k}" = ${sqlLiteral(r[k])}`).join(' AND ')
      return `UPDATE "${table}" SET ${set} WHERE ${where};`
    })
    .join('\n')
}

/** Only the chosen headers, in order, as plain objects (drop extra columns). */
function pick(rows: Record<string, unknown>[], headers: string[]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(headers.map((h) => [h, r[h]])))
}

/** Single entry point used by the Result Grid "Copy as ▸" menu. */
export function formatClipboard(fmt: ClipFormat, input: CopyInput): string {
  const table = input.table && input.table.trim() ? input.table : 'table'
  switch (fmt) {
    case 'tsv':
      return toTsv(input.headers, input.rows)
    case 'csv':
      return toCsv(input.headers, input.rows)
    case 'json':
      return toJson(pick(input.rows, input.headers))
    case 'sql-insert':
      return toSqlInsert(table, input.headers, input.rows)
    case 'sql-update':
      return toSqlUpdate(table, input.headers, input.rows, input.keyColumns)
    case 'markdown':
      return toMarkdownTable(input.headers, input.rows)
  }
}
