// Result Grid column widths, computed ONCE per result set from a sample of rows.
// The grid draws only the rows on screen (virtualised), so letting the browser
// size columns from what is drawn makes every column jump as you scroll. Widths
// are worked out from the data instead and then kept fixed. Pure → unit-tested.

/** Row indices to measure: the first `head` rows plus `spread` rows spaced evenly
 *  over the rest, so long values further down the result still widen a column. */
export function sampleRows(rowCount: number, head = 300, spread = 300): number[] {
  const out: number[] = []
  const top = Math.min(rowCount, head)
  for (let i = 0; i < top; i++) out.push(i)
  const rest = rowCount - top
  if (rest <= 0) return out
  const n = Math.min(rest, spread)
  for (let k = 0; k < n; k++) out.push(top + Math.floor((k * rest) / n))
  return out
}

export interface WidthLimits {
  /** Narrowest a data column may be. */
  min: number
  /** Widest a column is sized automatically (longer values are cut with "…"). */
  max: number
}

/**
 * One width per column: the widest of its header and its sampled cells, kept
 * within `limits`. `header(ci)` and `cell(row, ci)` return the full width the
 * header / cell needs (text plus padding and badges), in px.
 */
export function columnWidths(
  columnCount: number,
  rows: readonly number[],
  header: (ci: number) => number,
  cell: (row: number, ci: number) => number,
  limits: WidthLimits,
): number[] {
  const out: number[] = []
  for (let ci = 0; ci < columnCount; ci++) {
    let w = header(ci)
    for (const r of rows) {
      if (w >= limits.max) break
      const c = cell(r, ci)
      if (c > w) w = c
    }
    out.push(Math.round(Math.max(limits.min, Math.min(limits.max, w))))
  }
  return out
}

/** Long values only need measuring up to the point where they hit the cap. */
export function clipForMeasure(text: string, maxChars = 120): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text
}
