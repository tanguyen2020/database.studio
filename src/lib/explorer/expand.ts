// Expand / Collapse All for the Object Explorer tree, plus the rule for which
// node the schema list hangs off.
//
// The tree's expansion state is a flat Set of node keys (see ObjectExplorer's
// `expanded`), so "expand all" is just "which keys would the render show a
// chevron for". Keeping that mapping here — pure and unit-tested — keeps the key
// strings honest: they have to match the ones the component renders, and the
// tests pin them down.

/** The single root node the schema list nests under, per system:
 *  - PG / MSSQL / Oracle bind ONE database per connection → a "current database"
 *    header node (`curdb`), with the connection's schemas below it.
 *  - SQLite is one file → a `file` node.
 *  - Schema-as-database systems (MySQL / MariaDB / ClickHouse) list every database
 *    at the root, so there is no wrapper node.
 *  Non-relational systems have no schema list at all.
 *  A root node means the schema list starts COLLAPSED (nothing is expanded until
 *  the user opens it), which is why this drives both rendering and Expand All. */
export function rootNodeKey(system: string): 'curdb' | 'file' | null {
  switch (system) {
    case 'sqlite':
      return 'file'
    case 'postgres':
    case 'mssql':
    case 'oracle':
      return 'curdb'
    default:
      return null
  }
}

/** Object folders under a schema, in tree order. The key format is
 *  `f:<schema>:<folder>` — mirrored from the ObjectExplorer render. */
export const SCHEMA_FOLDERS = [
  'tables',
  'views',
  'dicts',
  'procs',
  'tvf',
  'scalar',
  'fns',
  'triggers',
  'indexes',
  'seqs',
] as const

export const schemaKey = (schema: string) => `s:${schema}`
export const folderKey = (schema: string, folder: string) => `f:${schema}:${folder}`

/** Cassandra keyspace + its object folders (own key namespace, `cass:*`). */
export const CASS_FOLDERS = ['tables', 'views', 'types', 'fns', 'idx'] as const
export const cassKeyspaceKey = (ks: string) => `cass:ks:${ks}`
export const cassFolderKey = (folder: string, ks: string) => `cass:${folder}:${ks}`

/** NATS JetStream stream node (expands to its subjects). */
export const natsStreamKey = (stream: string) => `nats:s:${stream}`

/** Every key to expand for a relational connection: the root node (if any), each
 *  schema, and each schema's object folders. Table/column-level nodes are left
 *  alone — expanding those would mean a per-table introspection round-trip each. */
export function relationalExpandKeys(system: string, schemas: string[]): string[] {
  const keys: string[] = []
  const root = rootNodeKey(system)
  if (root) keys.push(root)
  for (const s of schemas) {
    keys.push(schemaKey(s))
    for (const f of SCHEMA_FOLDERS) keys.push(folderKey(s, f))
  }
  return keys
}

/** Every key to expand for a Cassandra connection. */
export function cassandraExpandKeys(keyspaces: string[]): string[] {
  const keys: string[] = []
  for (const ks of keyspaces) {
    keys.push(cassKeyspaceKey(ks))
    for (const f of CASS_FOLDERS) keys.push(cassFolderKey(f, ks))
  }
  return keys
}

/** Every key to expand for a NATS connection (streams → subjects). */
export function natsExpandKeys(streams: string[]): string[] {
  return streams.map(natsStreamKey)
}

/** Systems whose tree lives in a child component with its own expansion state
 *  (RedisExplorer / MongoExplorer) — the header's Expand/Collapse cannot reach it,
 *  so the buttons are disabled rather than silently doing nothing. Kafka topics
 *  are leaves (open on click), so there is nothing to expand there either. */
export function supportsExpandAll(system: string | undefined): boolean {
  if (!system) return false
  return !['redis', 'mongodb', 'kafka'].includes(system)
}
