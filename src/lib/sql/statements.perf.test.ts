// Anti-regression gate for the shape of the statement splitter's cost.
//
// History: `splitStatements` converted every statement's start offset with a
// helper that re-scanned the document from position 0, making the whole function
// O(n²). The Query Editor calls it on EVERY keystroke (autocomplete resolves the
// statement under the cursor), so a 10k-line script blocked the UI thread for
// ~190ms per keystroke. The fix indexes line starts once and looks them up.
//
// This test fails if anyone reintroduces a per-item full-document scan: it checks
// the SCALING (8× the input must not cost anywhere near 8² the time), which is a
// property of the algorithm, not of the machine — so it holds on slow CI too.

import { describe, expect, it } from 'vitest'
import { splitStatements, statementAtOffset, offsetToLineCol, lineColToOffset } from './statements'

const STMT = `SELECT u.id, u.first_name, o.total
FROM public.users u
JOIN public.orders o ON o.user_id = u.id
WHERE u.created_at > now() AND o.total > 100
ORDER BY o.total DESC LIMIT 50;

`

/** Best-of-N wall time (ms) — the minimum is the least noisy estimator here. */
function best(runs: number, fn: () => unknown): number {
  let min = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    min = Math.min(min, performance.now() - t0)
  }
  return min
}

describe('splitStatements cost scales linearly (not quadratically)', () => {
  const small = STMT.repeat(100) // ~25k chars
  const big = STMT.repeat(800) // ~200k chars, 8× the size

  it('8× the document costs far less than 8² the time', () => {
    const tSmall = best(5, () => splitStatements(small))
    const tBig = best(5, () => splitStatements(big))
    const ratio = tBig / Math.max(tSmall, 0.05) // guard against a 0ms floor
    // linear ≈ 8, the old quadratic version measured ≈ 60. 20 leaves generous
    // headroom for timer noise while still failing hard on a reintroduced O(n²).
    expect(ratio, `8× input took ${ratio.toFixed(1)}× the time (${tSmall.toFixed(2)}ms → ${tBig.toFixed(2)}ms)`).toBeLessThan(20)
  })

  it('a 200k-character script splits well under a frame budget', () => {
    // the old implementation needed ~280ms here (≈ 17 dropped frames)
    expect(best(5, () => splitStatements(big))).toBeLessThan(120)
  })

  it('statementAtOffset (runs on every keystroke) stays cheap at the end of a big script', () => {
    expect(best(5, () => statementAtOffset(big, big.length - 20))).toBeLessThan(120)
  })

  it('converting many offsets in a loop is not quadratic (showErrors / lint diagnostics)', () => {
    const offsets = Array.from({ length: 2000 }, (_, i) => Math.floor((i / 2000) * big.length))
    const t = best(3, () => {
      for (const o of offsets) {
        const { line, col } = offsetToLineCol(big, o)
        lineColToOffset(big, line, col)
      }
    })
    // 2000 conversions over a 200k document: ~1ms indexed, ~seconds when each
    // conversion rescans the document.
    expect(t, `2000 conversions took ${t.toFixed(1)}ms`).toBeLessThan(150)
  })
})
