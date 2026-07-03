// Error-position mapping (addendum §2.3): the backend reports positions
// *within a statement*; the editor owns each statement's offset in the
// document. Never guess — when the driver gave no position, anchor at the
// statement start.

import type { SplitStatement } from './statements'
import type { QueryError } from '$lib/types'

export function mapErrorToDocument(
  stmt: SplitStatement,
  error: QueryError,
): { line: number; col: number } {
  if (!error.position) {
    return { line: stmt.startLine, col: stmt.startCol }
  }
  const { line, col } = error.position
  if (line === 1) {
    // first statement line sits after the statement's start column
    return { line: stmt.startLine, col: stmt.startCol + col - 1 }
  }
  return { line: stmt.startLine + line - 1, col }
}
