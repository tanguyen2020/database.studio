// FerretDB / Amazon DocumentDB demos (opt-in `?ferretdb=1`, `?documentdb=1`) —
// MongoDB-engine connections whose server is FerretDB or DocumentDB
// (SPEC-FERRETDB-DOCUMENTDB.md). Collections, documents and queries come from the
// shared MongoDB mock; this file answers only what differs, as measured on
// ferretdb-eval:2 (v2.7.0): buildInfo names FerretDB, users carry fixed roles that are
// not enforced (plus the extension's own background user), role commands do not exist.

export const FERRET_DEMO_ID = 'fd1'
export const DOCDB_DEMO_ID = 'dd1'

function param(name: string): string | null {
  return typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(name)
}
export const ferretDemoEnabled = () => param('ferretdb') === '1'
export const docdbDemoEnabled = () => param('documentdb') === '1'

const base = (args: Record<string, unknown> | undefined) => String(args?.connId ?? '').split(/::|#/)[0]
export const isFerretDemo = (args: Record<string, unknown> | undefined) => base(args) === FERRET_DEMO_ID
export const isDocdbDemo = (args: Record<string, unknown> | undefined) => base(args) === DOCDB_DEMO_ID

/** Commands that differ on the demo FerretDB / DocumentDB connections, or undefined. */
export function mongoFlavorDemo(cmd: string, args: Record<string, unknown>): unknown {
  if (cmd === 'mongo_server_info') {
    if (isFerretDemo(args)) return { flavor: 'ferretdb', version: 'v2.7.0', compat: '7.0.77', label: 'FerretDB v2.7.0 (MongoDB 7.0 compatible)' }
    if (isDocdbDemo(args)) return { flavor: 'documentdb', version: '5.0.0', compat: '5.0.0', label: 'Amazon DocumentDB 5.0.0' }
    return { flavor: 'mongodb', version: '7.0.14', compat: '7.0.14', label: 'MongoDB 7.0.14' }
  }
  if (isFerretDemo(args)) {
    if (cmd === 'mongo_users')
      // FerretDB lists every user on admin with readWriteAnyDatabase + clusterAdmin, whatever
      // roles were asked for — and its own background user
      return {
        cols: [['user', 'text'], ['db', 'text'], ['roles', 'text'], ['mechanisms', 'text']],
        rows: [
          { user: 'documentdb_bg_worker_role', db: 'admin', roles: 'readWriteAnyDatabase@admin, clusterAdmin@admin', mechanisms: '' },
          { user: 'app', db: 'admin', roles: 'readWriteAnyDatabase@admin, clusterAdmin@admin', mechanisms: 'SCRAM-SHA-256' },
          { user: 'reporting', db: 'admin', roles: 'readWriteAnyDatabase@admin, clusterAdmin@admin', mechanisms: 'SCRAM-SHA-256' },
        ],
        total: 3,
      }
    if (cmd === 'mongo_roles' || cmd === 'mongo_grant_roles' || cmd === 'mongo_revoke_roles') throw new Error("no such command: '" + (cmd === 'mongo_roles' ? 'rolesInfo' : 'grantRolesToUser') + "'")
  }
  return undefined
}
