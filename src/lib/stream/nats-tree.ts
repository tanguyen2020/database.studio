// NATS Streams list as a parent → child tree: each stream row, then its subjects
// indented under it (SPEC-NATS-WORKSPACE.md §3). Pure, so the order, the filter and
// the collapse state are unit-tested; the table only renders what this returns.

export interface StreamLike {
  name: string
  subjects: string[]
}

export type TreeNode<R extends StreamLike> =
  | { kind: 'stream'; key: string; row: R; depth: 0; childCount: number; expanded: boolean }
  | { kind: 'subject'; key: string; row: R; depth: 1; subject: string }

/** A subject row's key: stream names cannot contain spaces, so a space separates. */
export function subjectKey(stream: string, subject: string): string {
  return `${stream} ${subject}`
}

/** One stream-level node per stream (what the table counts and sorts). */
export function streamNodes<R extends StreamLike>(rows: R[], collapsed: ReadonlySet<string>): TreeNode<R>[] {
  return rows.map((row) => ({
    kind: 'stream',
    key: row.name,
    row,
    depth: 0,
    childCount: row.subjects.length,
    expanded: !collapsed.has(row.name),
  }))
}

/**
 * Flatten sorted stream nodes into stream → subject order.
 * - Subjects sit right under their stream, alphabetically, whatever the stream sort.
 * - Filter: a stream whose name matches keeps all its subjects; otherwise only the
 *   subjects that match are shown, under their stream, and the stream opens so the
 *   match is visible even if it was collapsed. Case-insensitive "contains".
 */
export function arrangeTree<R extends StreamLike>(
  nodes: TreeNode<R>[],
  query: string,
  sortStreams: (nodes: TreeNode<R>[]) => TreeNode<R>[],
): TreeNode<R>[] {
  const q = query.trim().toLowerCase()
  const out: TreeNode<R>[] = []
  for (const node of sortStreams(nodes.filter((n) => n.kind === 'stream'))) {
    if (node.kind !== 'stream') continue
    const subjects = [...new Set(node.row.subjects)].sort((a, b) => a.localeCompare(b))
    const nameHit = !q || node.row.name.toLowerCase().includes(q)
    const shown = nameHit ? subjects : subjects.filter((s) => s.toLowerCase().includes(q))
    if (!nameHit && shown.length === 0) continue
    const open = node.expanded || (!nameHit && shown.length > 0)
    out.push({ ...node, expanded: open })
    if (!open) continue
    for (const subject of shown) {
      out.push({ kind: 'subject', key: subjectKey(node.row.name, subject), row: node.row, depth: 1, subject })
    }
  }
  return out
}
