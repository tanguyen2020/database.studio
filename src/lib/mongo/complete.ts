// MongoDB query-editor autocomplete helpers (pure). The editor runs mongosh-style
// statements (`db.<collection>.<method>({...})`); these parse the collection a
// statement targets so the completion source can suggest its sampled fields, and
// detect the `db.` prefix for collection-name completion.

/** The collection referenced by a mongosh statement — the `<coll>` in
 *  `db.<coll>.<method>(…)`. Returns the FIRST match, or null when absent. Also
 *  matches `db.getCollection("name")`. */
export function parseMongoCollection(query: string): string | null {
  const gc = query.match(/\bdb\.getCollection\(\s*["']([^"']+)["']/)
  if (gc) return gc[1]
  const m = query.match(/\bdb\.([A-Za-z_$][\w$]*)\s*\.\s*[A-Za-z_$]/)
  return m ? m[1] : null
}

/** True when the text immediately before the cursor is a `db.` collection prefix
 *  (`db.` or `db.partialName`) — the point to offer collection-name completions. */
export function isCollectionPrefix(before: string): boolean {
  return /\bdb\.[A-Za-z_$][\w$]*$|\bdb\.$/.test(before)
}

/** True at a method-access point: `db.<collection>.<partial>` (two dots) — offer
 *  collection methods (find, aggregate, updateOne, …). */
export function isMethodContext(before: string): boolean {
  return /\bdb\.[A-Za-z_$][\w$]*\.[\w$]*$/.test(before)
}

/** True while typing an operator: the token before the cursor starts with `$`
 *  (`$`, `$g`, `$se`) — offer query/update/aggregation operators. */
export function isOperatorContext(before: string): boolean {
  return /\$[\w]*$/.test(before)
}
