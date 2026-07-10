// ER diagram membership + drop-position math (AUDIT-3 · item 1). Pure → unit-testable.
// A diagram either shows ALL tables of the schema (`included === undefined`, the
// default "View ER Diagram") or a chosen SUBSET (`included` is an array, possibly
// empty for a blank canvas built up by dragging tables in from the sidebar).

export interface XY {
  x: number
  y: number
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** Tables to render, honoring the included-set model. */
export function visibleTables<T extends { name: string }>(all: T[], included?: string[]): T[] {
  if (included === undefined) return all
  const set = new Set(included)
  return all.filter((t) => set.has(t.name))
}

/** Add a table to the diagram. In all-tables mode (undefined) it's already shown,
 *  so this is a no-op; in subset mode it unions the name in. */
export function addTable(included: string[] | undefined, name: string): string[] | undefined {
  if (included === undefined) return undefined
  return included.includes(name) ? included : [...included, name]
}

/** Remove a table. All-tables mode materializes to "all except this one". */
export function removeTable(
  included: string[] | undefined,
  allNames: string[],
  name: string,
): string[] {
  const base = included ?? allNames
  return base.filter((n) => n !== name)
}

/** A hand-drawn connection from SvelteFlow's `onconnect` (source/target = table
 *  node ids; *Handle = column anchor ids). */
export interface RelConnection {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

/** A relationship (child.from_column → parent.to_column). */
export interface Rel {
  from_table: string
  from_column: string
  to_table: string
  to_column: string
}

/** Validate a hand-drawn connection (Phase 3) into a relationship, or return null
 *  when it's incomplete (a node-level / anchor-less drop) or a duplicate of an
 *  existing schema FK or an already-pending relationship. Pure → unit-testable.
 *  Self-referencing (same table) is allowed as long as the columns differ. */
export function relationshipFromConnection(conn: RelConnection, existing: Rel[], pending: Rel[]): Rel | null {
  const from_table = conn.source
  const to_table = conn.target
  const from_column = conn.sourceHandle ?? ''
  const to_column = conn.targetHandle ?? ''
  if (!from_table || !to_table || !from_column || !to_column) return null
  if (from_table === to_table && from_column === to_column) return null
  const same = (r: Rel) =>
    r.from_table === from_table && r.from_column === from_column && r.to_table === to_table && r.to_column === to_column
  if (existing.some(same) || pending.some(same)) return null
  return { from_table, from_column, to_table, to_column }
}

/** Convert a screen drop point to flow-canvas coordinates given the pane rect
 *  and the current viewport (pan x/y + zoom). Mirrors xyflow's screenToFlow. */
export function flowPosition(clientX: number, clientY: number, rect: { left: number; top: number }, vp: Viewport): XY {
  const zoom = vp.zoom || 1
  return {
    x: (clientX - rect.left - vp.x) / zoom,
    y: (clientY - rect.top - vp.y) / zoom,
  }
}
