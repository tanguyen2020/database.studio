// Generate Scripts — whole-schema / multi-object script assembly (Phase 5 · T15).
// Pure + dialect-agnostic: takes an abstract object model and emits a script in
// dependency-correct order (parent/base objects first, views after their base
// tables, foreign keys emitted LAST as trailing ALTERs so cyclic/forward refs
// never break). Structure / data / both modes.

export type ScriptMode = 'structure' | 'data' | 'both'

export interface DbObject {
  name: string
  kind: 'table' | 'view'
  /** CREATE TABLE / CREATE VIEW statement (no trailing FK) */
  createSql: string
  /** names of other objects this depends on (parent tables, view base tables) */
  deps: string[]
  /** ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY statements — emitted after all CREATEs */
  fkAlters?: string[]
  /** INSERT statements for data-only / both modes (tables only) */
  dataSql?: string
}

/** Topological sort so every object appears after the objects it depends on.
 *  Stable (input order preserved among independent objects); cycle-safe (a back
 *  edge is simply skipped — FKs are emitted separately so cycles don't matter). */
export function orderObjects(objs: DbObject[]): DbObject[] {
  const byName = new Map(objs.map((o) => [o.name, o]))
  const visited = new Set<string>()
  const out: DbObject[] = []
  const visit = (o: DbObject, stack: Set<string>) => {
    if (visited.has(o.name) || stack.has(o.name)) return
    stack.add(o.name)
    for (const d of o.deps) {
      const dep = byName.get(d)
      if (dep) visit(dep, stack)
    }
    stack.delete(o.name)
    visited.add(o.name)
    out.push(o)
  }
  for (const o of objs) visit(o, new Set())
  return out
}

/** Assemble the full script. Order: CREATE TABLEs/VIEWs (dependency order,
 *  views after their base tables) → all FK ALTERs → INSERT data (table order). */
export function generateScript(objs: DbObject[], mode: ScriptMode): string {
  const ordered = orderObjects(objs)
  const parts: string[] = []

  if (mode === 'structure' || mode === 'both') {
    for (const o of ordered) parts.push(o.createSql)
    for (const o of ordered) for (const fk of o.fkAlters ?? []) parts.push(fk)
  }
  if (mode === 'data' || mode === 'both') {
    for (const o of ordered) {
      if (o.kind === 'table' && o.dataSql) parts.push(o.dataSql)
    }
  }
  return parts.join('\n\n') + (parts.length ? '\n' : '')
}
