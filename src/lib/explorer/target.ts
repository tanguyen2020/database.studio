// Object Explorer tree-key → (database, schema) resolution. Pure → unit-testable.
//
// Every tree row carries a `key` that encodes where the node lives:
//   s:<schema>                             schema (or a schema-as-database) node
//   f:<schema>:<folder>                    object folder (Tables/Views/…)
//   t|v|p|fn|tg|sq|dic:<schema>.<name>     an object under a schema
//   col|vcol:<schema>.<table>.<col>        a column
//   i|c|ix|ct|p|pt|six:<schema>.<table>…   index/constraint/partition rows
//   curdb                                  PG/MSSQL current-database header
//   fdb:<db>[:s:<schema>[:<folder>[:<name>…]]]   another database (sub-connection)
//
// A NEW Query Editor tab binds to whatever database/schema the selection sits in,
// so picking a TABLE (not just its schema node) is enough — that's what this maps.

/** Prefixes of rows that live *inside* a schema (name follows as `<schema>.…`). */
const OBJECT_PREFIXES = new Set([
  't', // table
  'v', // view
  'p', // procedure — and the per-table "Partitions" folder (same shape)
  'fn', // function / TVF / scalar
  'tg', // trigger
  'sq', // sequence
  'seq', // sequence (alias used by the Properties panel)
  'dic', // ClickHouse dictionary
  'col', // table column
  'vcol', // view column
  'i', // per-table Indexes folder
  'ix', // index row
  'c', // per-table Constraints folder
  'ct', // constraint row
  'pt', // partition row
  'six', // schema-wide index row
])

/** Longest known schema that `rest` starts with — schema names may contain dots
 *  (e.g. the MySQL database `crm.example.com`), so a blind split is wrong. */
function schemaPrefixOf(rest: string, schemas: string[]): string {
  let best = ''
  for (const s of schemas) {
    if ((rest === s || rest.startsWith(`${s}.`)) && s.length > best.length) best = s
  }
  if (best) return best
  const dot = rest.indexOf('.')
  return dot > 0 ? rest.slice(0, dot) : rest
}

/** Schema a main-tree (current-database) row belongs to, or null when the key
 *  points at nothing schema-scoped (a foreign database, the connection root, …). */
export function schemaOfTreeKey(key: string, schemas: string[] = []): string | null {
  if (!key || key.startsWith('fdb:')) return null
  if (key.startsWith('s:')) return key.slice(2) || null
  if (key.startsWith('f:')) {
    // `f:<schema>:<folder>` — the folder segment is the last one; schema may hold dots.
    const rest = key.slice(2)
    const cut = rest.lastIndexOf(':')
    return (cut > 0 ? rest.slice(0, cut) : rest) || null
  }
  const cut = key.indexOf(':')
  if (cut < 0) return null
  const prefix = key.slice(0, cut)
  if (!OBJECT_PREFIXES.has(prefix)) return null
  const rest = key.slice(cut + 1)
  return rest ? schemaPrefixOf(rest, schemas) : null
}

/** Database (+ schema, when the key reaches that deep) of a foreign-database row.
 *  Foreign keys are `fdb:<db>` / `fdb:<db>:s:<schema>[:…]`. */
export function foreignOfTreeKey(key: string): { database: string; schema?: string } | null {
  if (!key.startsWith('fdb:')) return null
  const rest = key.slice(4)
  if (!rest) return null
  const m = rest.match(/^(.+?):s:(.+)$/)
  if (!m) return { database: rest }
  const tail = m[2]
  const cut = tail.indexOf(':')
  const schema = cut < 0 ? tail : tail.slice(0, cut)
  return schema ? { database: m[1], schema } : { database: m[1] }
}
