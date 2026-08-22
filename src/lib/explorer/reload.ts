// What a tree refresh has to RE-READ, derived from the rows currently open.
//
// `explorer.refresh(connId, { kind: 'connection' })` only re-reads the schema LIST
// and throws away every schema's children. On its own that makes Refresh *empty*
// the folders the user had open instead of reloading them — the tree keeps the
// expanded keys, but the object lists behind them are gone until the node is
// clicked again. So Refresh must also re-read the children of every open schema and
// the detail of every open table/view.
//
// The plan is derived from the EXPANDED KEYS (what is on screen), not from the cache
// contents: the Connections-toolbar Refresh drops the whole cache before asking the
// tree to reload, and the work stays bounded by what the user can actually see.
import { foreignOfTreeKey, schemaOfTreeKey, tableOfTreeKey } from './target'

export interface ReloadPlan {
  /** schemas whose object lists (tables/views/routines/triggers/sequences) to re-read */
  schemas: string[]
  /** table/view rows whose detail (columns/indexes/constraints/partitions) to re-read */
  tables: { schema: string; table: string }[]
}

const EMPTY: ReloadPlan = { schemas: [], tables: [] }

function collect(
  keys: Iterable<string>,
  schemas: string[],
  resolve: (key: string) => { schema: string | null; table?: string },
): ReloadPlan {
  const known = new Set(schemas)
  const outSchemas: string[] = []
  const seenSchema = new Set<string>()
  const outTables: { schema: string; table: string }[] = []
  const seenTable = new Set<string>()
  for (const key of keys) {
    const { schema, table } = resolve(key)
    // A schema that no longer exists on the server (dropped since the last read)
    // must NOT be re-read — that would resurrect a dead node / log an error.
    if (!schema || !known.has(schema)) continue
    if (!seenSchema.has(schema)) {
      seenSchema.add(schema)
      outSchemas.push(schema)
    }
    if (!table) continue
    const k = `${schema}.${table}`
    if (seenTable.has(k)) continue
    seenTable.add(k)
    outTables.push({ schema, table })
  }
  return { schemas: outSchemas, tables: outTables }
}

/** Main tree (the connection's current database): keys are `s:…`, `f:…:tables`,
 *  `t:<schema>.<name>`, `col:…` and so on. Foreign-database rows are skipped —
 *  they live on their own sub-connection (see `foreignReloadPlan`). */
export function mainReloadPlan(expanded: Iterable<string>, schemas: string[]): ReloadPlan {
  if (!schemas.length) return EMPTY
  return collect(expanded, schemas, (key) => {
    if (key.startsWith('fdb:')) return { schema: null }
    const t = tableOfTreeKey(key, schemas)
    if (t) return { schema: t.schema, table: t.table }
    return { schema: schemaOfTreeKey(key, schemas) }
  })
}

/** One foreign database's subtree (`fdb:<db>:s:<schema>[:<folder>[:<name>]]`),
 *  whose rows are read over the attached sub-connection `{base}::{db}`. Only the
 *  Tables (`t`) and Views (`v`) folders hold rows with a detail to re-read. */
export function foreignReloadPlan(expanded: Iterable<string>, db: string, schemas: string[]): ReloadPlan {
  if (!schemas.length) return EMPTY
  const marker = `fdb:${db}:s:`
  // longest match first: a schema name may itself contain ':' or be a prefix of another
  const byLength = [...schemas].sort((a, b) => b.length - a.length)
  return collect(expanded, schemas, (key) => {
    const fo = foreignOfTreeKey(key)
    if (!fo || fo.database !== db) return { schema: null }
    if (!key.startsWith(marker)) return { schema: fo.schema ?? null }
    const rest = key.slice(marker.length)
    const schema = byLength.find((s) => rest === s || rest.startsWith(`${s}:`))
    if (!schema) return { schema: fo.schema ?? null }
    const tail = rest.slice(schema.length).split(':').filter(Boolean)
    // tail: [] = schema node · [folder] = folder node · [folder, name…] = object row
    if (tail.length < 2 || (tail[0] !== 't' && tail[0] !== 'v')) return { schema }
    return { schema, table: tail.slice(1).join(':') }
  })
}
