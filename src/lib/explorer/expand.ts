// Which node the Object Explorer's schema list hangs off, per system.
//
// The tree's expansion state is a flat Set of node keys (see ObjectExplorer's
// `expanded`), and whether there is a root node above the schemas decides whether
// a fresh window shows anything open at all. Keeping that rule here — pure and
// unit-tested — keeps the key strings honest against the render.

/** The single root node the schema list nests under, per system:
 *  - PG / MSSQL / Oracle bind ONE database per connection → a "current database"
 *    header node (`curdb`), with the connection's schemas below it.
 *  - SQLite is one file → a `file` node.
 *  - Schema-as-database systems (MySQL / MariaDB / ClickHouse) list every database
 *    at the root, so there is no wrapper node.
 *  Non-relational systems have no schema list at all.
 *  A root node means the schema list starts COLLAPSED — nothing is expanded until
 *  the user opens it. */
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
