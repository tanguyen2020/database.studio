// Properties footer for the Cassandra / ScyllaDB keyspace tree. Its row keys
// (`cass:t:<ks>:<table>`…) used to fall through the relational parser and show
// the raw key ("cass t:campus_ks:orders"). Folder / setting rows are navigation,
// not objects, so they show nothing.

export interface CassProps {
  type: string
  /** keyspace the object lives in ('' for a keyspace itself) */
  schema: string
  name: string
  scopeLabel: 'keyspace'
}

const KINDS: Record<string, string> = {
  t: 'Table',
  v: 'Materialized view',
  u: 'Type',
  f: 'Function',
  i: 'Index',
  cdc: 'Change log',
}

export function cassandraProps(key: string): CassProps | null {
  if (!key.startsWith('cass:')) return null
  const parts = key.split(':')
  const kind = parts[1]
  if (kind === 'ks') return { type: 'Keyspace', schema: '', name: parts.slice(2).join(':'), scopeLabel: 'keyspace' }
  const ks = parts[2] ?? ''
  const rest = parts.slice(3).join(':')
  if (kind === 'c') {
    // cass:c:<ks>:<table>.<column>
    const dot = rest.lastIndexOf('.')
    return { type: 'Column', schema: ks, name: dot >= 0 ? `${rest.slice(0, dot)}.${rest.slice(dot + 1)}` : rest, scopeLabel: 'keyspace' }
  }
  const type = KINDS[kind]
  if (!type || !rest) return null
  // functions are keyed by their signature: show the name only
  const name = kind === 'f' ? rest.replace(/\(.*$/, '') : rest
  return { type, schema: ks, name, scopeLabel: 'keyspace' }
}
