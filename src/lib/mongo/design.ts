// Design Document (MongoDB) — edit a collection's field structure across all its
// documents. MongoDB is schemaless, so "designing" a collection means applying
// bulk field operations with updateMany: add a field with a default, rename a
// field, or drop a field. Pure command builders → unit-testable; the dialog runs
// each returned mongosh statement via mongo_exec.

export type MongoFieldOp =
  | { kind: 'add'; field: string; value: unknown }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'drop'; field: string }

/** Build one mongosh `updateMany` statement for a single field op. Field names go
 *  through JSON.stringify so dotted/quoted names stay valid. */
export function buildFieldOp(collection: string, op: MongoFieldOp): string {
  const c = collection
  switch (op.kind) {
    case 'add':
      // only set on docs that don't already have the field (don't clobber values)
      return `db.${c}.updateMany({ ${JSON.stringify(op.field)}: { "$exists": false } }, { "$set": { ${JSON.stringify(op.field)}: ${JSON.stringify(op.value)} } })`
    case 'rename':
      return `db.${c}.updateMany({}, { "$rename": { ${JSON.stringify(op.from)}: ${JSON.stringify(op.to)} } })`
    case 'drop':
      return `db.${c}.updateMany({}, { "$unset": { ${JSON.stringify(op.field)}: "" } })`
  }
}

/** Build the full ordered list of statements for a set of field ops. Renames run
 *  before drops so a "rename A→B then drop A" pair can't cancel out, and adds run
 *  first so a rename onto a just-added field is possible. Empty ops → []. */
export function buildFieldOps(collection: string, ops: MongoFieldOp[]): string[] {
  const order = (k: MongoFieldOp['kind']) => (k === 'add' ? 0 : k === 'rename' ? 1 : 2)
  return [...ops]
    .filter((o) => isValidOp(o))
    .sort((a, b) => order(a.kind) - order(b.kind))
    .map((o) => buildFieldOp(collection, o))
}

/** An op is applied only when its field names are non-empty (and rename actually
 *  changes the name). Guards the dialog from emitting no-op/invalid statements. */
export function isValidOp(op: MongoFieldOp): boolean {
  if (op.kind === 'add') return op.field.trim().length > 0
  if (op.kind === 'drop') return op.field.trim().length > 0
  return op.from.trim().length > 0 && op.to.trim().length > 0 && op.from.trim() !== op.to.trim()
}
