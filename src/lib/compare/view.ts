// Presentation rules for Schema Compare — words, grouping and per-object scripts.
// Pure (no Svelte, no IPC) so every rule the screen relies on is unit-tested.
//
// Vocabulary: the comparison always syncs TARGET to look like SOURCE, so every
// status is phrased as what happens to the target:
//   src_only  → "New"      (created in the target)
//   different → "Changed"  (altered in the target)
//   tgt_only  → "Extra"    (only in the target — dropped)
//   identical → "Same"

import { columnKey, genMigration, objectKey, type DiffStatus, type ObjectDiff, type ObjectKind } from './diff'

export type Tone = 'new' | 'changed' | 'extra' | 'same'

export const STATUS: Record<DiffStatus, { label: string; tone: Tone; action: string }> = {
  src_only: { label: 'New', tone: 'new', action: 'Exists only in the source — it will be created in the target.' },
  different: { label: 'Changed', tone: 'changed', action: 'Differs between source and target — the target will be altered.' },
  tgt_only: { label: 'Extra', tone: 'extra', action: 'Exists only in the target — it will be dropped.' },
  identical: { label: 'Same', tone: 'same', action: 'Identical in both — nothing to do.' },
}

export const KIND_LABEL: Record<ObjectKind, { one: string; many: string }> = {
  table: { one: 'Table', many: 'Tables' },
  view: { one: 'View', many: 'Views' },
  procedure: { one: 'Procedure', many: 'Stored procedures' },
  function: { one: 'Function', many: 'Functions' },
  trigger: { one: 'Trigger', many: 'Triggers' },
  sequence: { one: 'Sequence', many: 'Sequences' },
  index: { one: 'Index', many: 'Indexes' },
}

/** Top-level groups of the object list; indexes/triggers nest under their table. */
export const LIST_KINDS: ObjectKind[] = ['table', 'view', 'procedure', 'function', 'sequence']

export type StatusFilter = 'changes' | 'src_only' | 'different' | 'tgt_only' | 'identical' | 'all'

export interface Children {
  indexes: ObjectDiff[]
  triggers: ObjectDiff[]
}

/** Indexes + triggers owned by `table`. */
export function childrenOf(diffs: ObjectDiff[], table: string): Children {
  return {
    indexes: diffs.filter((d) => d.kind === 'index' && d.idxTable === table),
    triggers: diffs.filter((d) => d.kind === 'trigger' && d.idxTable === table),
  }
}

const passes = (s: DiffStatus, f: StatusFilter) => (f === 'all' ? true : f === 'changes' ? s !== 'identical' : s === f)

/** Does a top-level object belong in the list for this filter + search text?
 *  A table also shows when one of its columns/indexes/triggers matches, so a
 *  changed index is never hidden behind an otherwise identical table. */
export function listed(d: ObjectDiff, kids: Children, filter: StatusFilter, query: string): boolean {
  const q = query.trim().toLowerCase()
  const nameHit = !q || d.name.toLowerCase().includes(q)
  const kidList = [...kids.indexes, ...kids.triggers]
  const kidHit = kidList.some((k) => passes(k.status, filter) && (!q || k.name.toLowerCase().includes(q)))
  return (passes(d.status, filter) && nameHit) || kidHit
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Short "what changed" for a list row: "2 columns changed · 1 new index". */
export function changeSummary(d: ObjectDiff, kids: Children): string {
  const parts: string[] = []
  if (d.status === 'different' && d.columns.length) {
    const add = d.columns.filter((c) => c.status === 'src_only').length
    const del = d.columns.filter((c) => c.status === 'tgt_only').length
    const chg = d.columns.filter((c) => c.status === 'different').length
    if (add) parts.push(`${plural(add, 'new column')}`)
    if (chg) parts.push(`${plural(chg, 'column')} changed`)
    if (del) parts.push(`${plural(del, 'extra column')}`)
  }
  if (d.status === 'src_only' || d.status === 'tgt_only') {
    if (d.columns.length) parts.push(plural(d.columns.length, 'column'))
  }
  const childNote = (list: ObjectDiff[], noun: string) => {
    const changed = list.filter((k) => k.status !== 'identical').length
    if (changed) parts.push(`${plural(changed, noun, noun === 'index' ? 'indexes' : `${noun}s`)} to sync`)
  }
  childNote(kids.indexes, 'index')
  childNote(kids.triggers, 'trigger')
  if (!parts.length && (d.srcDdl != null || d.tgtDdl != null) && d.status === 'different') parts.push('definition differs')
  return parts.join(' · ')
}

/** Every selection key that belongs to an object: itself, its changed columns and
 *  its non-identical indexes/triggers. Used for "select this object" + its script. */
export function keysOf(d: ObjectDiff, kids: Children): string[] {
  const keys = [objectKey(d)]
  for (const c of d.columns) if (c.status !== 'identical') keys.push(columnKey(d.name, c.name))
  for (const k of [...kids.indexes, ...kids.triggers]) if (k.status !== 'identical') keys.push(objectKey(k))
  return keys
}

/** The statements this one object contributes to the migration (ignoring the
 *  current check boxes) — shown in the detail pane so a person sees exactly what
 *  would run for it. Empty string when the object needs nothing. */
export function objectScript(d: ObjectDiff, kids: Children, system: string): string {
  const keys = new Set(keysOf(d, kids))
  const sql = genMigration([d, ...kids.indexes, ...kids.triggers], system, keys)
  return sql
    .split('\n')
    .filter((l) => !/^-- (Migration: sync TARGET|Review carefully)/.test(l))
    .join('\n')
    .trim()
}

/** Counts per status for the summary cards (indexes/triggers included). */
export function statusCounts(diffs: ObjectDiff[]): Record<DiffStatus, number> {
  const out: Record<DiffStatus, number> = { src_only: 0, different: 0, tgt_only: 0, identical: 0 }
  for (const d of diffs) out[d.status]++
  return out
}

/** Statements of a migration that destroy data — called out before applying. */
export function destructiveCount(statements: string[]): number {
  // a split statement can still carry the comment lines above it (the migration
  // header sticks to the first one) — ignore comments before looking at the verb
  const code = (s: string) => s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  return statements.filter((s) => /^\s*drop\s+(table|sequence)\b/i.test(code(s)) || /\bdrop\s+column\b/i.test(code(s))).length
}
