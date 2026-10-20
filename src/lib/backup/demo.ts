// Demo (browser) mock of the Backup & Restore commands — same shapes as
// commands/backup.rs. Seams (demo only, like ?slowIntrospect):
//   ?backupNoTool=1   → the client tool is "not installed" (tool engines)
//   ?slowBackup=<ms>  → backup/restore take that long (cancel can be exercised)
//   ?backupFail=1     → the tool fails with a real-looking pg_dump error
//   ?backupTables=<n> → the database has n tables (progress counts through them)
import type { BackupOptions, BackupOutcome, BackupPlan, BackupProgress } from '$lib/ipc'

const SYSTEM_OF: Record<string, string> = {
  c1: 'postgres',
  c2: 'mysql',
  c3: 'mssql',
  c4: 'redis',
  c5: 'kafka',
  c6: 'nats',
  c7: 'postgres',
  c8: 'clickhouse',
  c9: 'mariadb',
  c10: 'sqlite',
  c11: 'cassandra',
  c12: 'mongodb',
  c13: 'oracle',
  dk1: 'duckdb',
}
const DB_OF: Record<string, string> = {
  c1: 'app',
  c2: 'library_db',
  c3: 'exams_reporting',
  c4: '0',
  c7: 'sis_staging',
  c8: 'analytics',
  c9: 'shop',
  c10: '',
  c11: 'library_ks',
  c12: 'analytics',
  c13: 'APP_USER',
  dk1: 'main',
}

function param(name: string): string | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search).get(name)
}

const cancelled = new Set<string>()
let toolDirPicked = ''

function base(id: string): string {
  return id.split('#')[0].split('::')[0]
}

function sysOf(connId: string): string {
  return SYSTEM_OF[base(connId)] ?? 'postgres'
}

const TOOLS: Record<string, { b: string; r: string[]; path: string; ver: string }> = {
  postgres: { b: 'pg_dump', r: ['pg_restore', 'psql'], path: 'C:\\Program Files\\PostgreSQL\\16\\bin', ver: 'pg_dump (PostgreSQL) 16.4' },
  mysql: { b: 'mysqldump', r: ['mysql'], path: 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin', ver: 'mysqldump  Ver 8.0.36 for Win64' },
  mariadb: { b: 'mariadb-dump', r: ['mariadb'], path: 'C:\\Program Files\\MariaDB 11.4\\bin', ver: 'mariadb-dump from 11.4.2-MariaDB' },
  mongodb: { b: 'mongodump', r: ['mongorestore'], path: 'C:\\Program Files\\MongoDB\\Tools\\100\\bin', ver: 'mongodump version: 100.9.4' },
  oracle: { b: 'expdp', r: ['impdp'], path: 'C:\\oracle\\instantclient_23_0', ver: 'Export: Release 23.0.0.0.0' },
}

function plan(connId: string, database: string | null, toolDir: string | null): BackupPlan {
  const system = sysOf(connId)
  const db = database || (connId.includes('::') ? connId.split('::')[1] : DB_OF[base(connId)] ?? '')
  const tool = TOOLS[system]
  const missing = !!tool && param('backupNoTool') !== null && !toolDir && !toolDirPicked
  // ?backupBundled=1 — the copies shipped inside the installer (what a fresh
  // install uses when the machine has no client of its own)
  const bundled = !!tool && param('backupBundled') !== null && !toolDir && !toolDirPicked
  const fam = system === 'mysql' ? 'mariadb' : system
  const dir = bundled
    ? system === 'oracle'
      ? 'C:\\Program Files\\Database Studio\\resources\\instantclient'
      : `C:\\Program Files\\Database Studio\\resources\\tools\\${fam}\\bin`
    : toolDir || toolDirPicked || tool?.path || ''
  const info = (name: string, ver: string) =>
    missing
      ? { name, path: null, version: null, found: false, bundled: false }
      : { name, path: `${dir}\\${name}.exe`, version: ver, found: true, bundled }
  const p: BackupPlan = {
    system,
    database: db,
    method: 'unsupported',
    method_label: '',
    server_side: false,
    backup_tool: null,
    restore_tools: [],
    backup_ready: false,
    restore_ready: false,
    default_dir: 'C:\\Users\\demo\\Documents\\Database Studio\\Backups',
    local_dir: 'C:\\Users\\demo\\Documents\\Database Studio\\Backups',
    server_version: null,
    warnings: [],
    install_hint: null,
    recent: [],
    disks: [],
    needs_connection: false,
    connected: true,
  }
  if (tool) {
    p.method = 'tool'
    p.method_label = tool.b
    p.backup_tool = info(tool.b, tool.ver)
    p.restore_tools = tool.r.map((n) => info(n, tool.ver.replace(tool.b, n)))
    p.backup_ready = !missing
    p.restore_ready = !missing
    if (missing) p.install_hint = `Install the ${system} client tools, then press Check again — or pick the folder that contains ${tool.b} with Locate….`
    if (system === 'postgres') p.server_version = 'PostgreSQL 16'
    if (system === 'oracle') {
      p.server_side = true
      p.needs_connection = true
      p.default_dir = '/opt/oracle/admin/FREE/dpdump'
      p.method_label = 'Data Pump (expdp / impdp)'
    }
  } else if (system === 'mssql') {
    // .bacpac to this computer: the SqlPackage shipped with the app
    const sqlpackage =
      param('backupNoTool') !== null
        ? { name: 'sqlpackage', path: null, version: null, found: false, bundled: false }
        : { name: 'sqlpackage', path: 'C:\\Program Files\\Database Studio\\resources\\tools\\sqlpackage\\sqlpackage.exe', version: '170.4.83.3', found: true, bundled: true }
    if (!sqlpackage.found) p.install_hint = 'Saving to this computer (.bacpac) needs SqlPackage.'
    p.backup_tool = sqlpackage
    p.restore_tools = [sqlpackage]
    Object.assign(p, {
      method: 'server',
      method_label: 'Native BACKUP DATABASE',
      server_side: true,
      needs_connection: true,
      backup_ready: true,
      restore_ready: true,
      default_dir: '/var/opt/mssql/data',
      recent: [{ path: `/var/opt/mssql/data/${db}_2026-10-18_2300.bak`, finished: '2026-10-18 23:00:12', size: 48_234_496 }],
    })
  } else if (system === 'clickhouse') {
    Object.assign(p, {
      method: 'server',
      method_label: 'Native BACKUP DATABASE',
      server_side: true,
      needs_connection: true,
      backup_ready: true,
      restore_ready: true,
      default_dir: '',
      disks: ['backups', 'default'],
    })
  } else if (system === 'sqlite' || system === 'duckdb') {
    Object.assign(p, { method: 'in-process', method_label: system === 'sqlite' ? 'SQLite online backup' : 'DuckDB copy', needs_connection: true, backup_ready: true, restore_ready: true })
  } else if (system === 'cassandra' || system === 'redis') {
    Object.assign(p, {
      method: 'built-in',
      method_label: system === 'cassandra' ? 'Built-in CQL dump' : 'Built-in DUMP / RESTORE',
      needs_connection: true,
      backup_ready: true,
      restore_ready: true,
      warnings: [
        system === 'cassandra'
          ? 'Rows are written as INSERT … JSON. Counter tables are skipped (counters cannot be inserted), and remaining TTLs are not carried over.'
          : 'Backs up one logical database. The file restores on the same Redis version or newer.',
      ],
    })
  }
  return p
}

type Emit = ((p: BackupProgress) => void) | null

/** What each engine reports while it runs (same units the backend sends). */
function progressShape(system: string, kind: 'backup' | 'restore', path: string, o: BackupOptions): { stage: string; total: number | null; unit: string; name: (i: number) => string | null } {
  const n = Math.max(1, Number(param('backupTables') ?? '42') || 42)
  const stage = kind === 'backup' ? 'Backing up' : 'Restoring'
  const bacpac = system === 'mssql' && (o.format === 'bacpac' || /\.bacpac$/i.test(path))
  const table = (i: number) => `public.table_${String(i + 1).padStart(4, '0')}`
  if (system === 'mssql' && !bacpac) return { stage, total: 100, unit: '%', name: () => null }
  if (system === 'clickhouse' || system === 'sqlite' || system === 'duckdb') return { stage, total: null, unit: '', name: () => null }
  // pg_dump names no table for a structure-only custom archive: counted by its catalog steps (as the real backend)
  if (system === 'postgres' && kind === 'backup' && o.content === 'schema' && o.format === 'custom') {
    const steps = ['reading extensions', 'reading schemas', 'reading user-defined tables', 'reading user-defined functions', 'reading user-defined types', 'reading indexes', 'reading constraints', 'reading triggers', 'saving encoding', 'saving search_path']
    return { stage: 'Reading the catalog', total: 50, unit: 'steps', name: (i) => steps[i % steps.length] }
  }
  if (system === 'redis') return { stage, total: kind === 'backup' ? 1284 : 18_874_368, unit: kind === 'backup' ? 'keys' : 'bytes', name: () => null }
  if (kind === 'restore' && system !== 'cassandra' && system !== 'mongodb' && !bacpac) return { stage, total: 18_874_368, unit: 'bytes', name: () => null }
  if (system === 'cassandra') return { stage, total: n, unit: kind === 'backup' ? 'tables' : 'statements', name: (i) => (kind === 'backup' ? `library_ks.t${i + 1}` : null) }
  if (system === 'mongodb') return { stage, total: n, unit: 'collections', name: (i) => `analytics.c${i + 1}` }
  return { stage: bacpac ? (kind === 'backup' ? 'Exporting' : 'Importing') : stage, total: n, unit: 'tables', name: table }
}

function wait(ms: number, jobId: string | undefined, emit: Emit = null, shape?: ReturnType<typeof progressShape>): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let last = 0
    const send = (frac: number) => {
      if (!emit || !shape) return
      const total = shape.total
      const done = total == null ? Math.round(frac * 30) : Math.min(total, Math.round(frac * total))
      emit({ jobId: jobId ?? '', stage: shape.stage, done, total, unit: shape.unit, current: done > 0 ? shape.name(done - 1) : null })
    }
    if (emit && shape) emit({ jobId: jobId ?? '', stage: 'Preparing', done: 0, total: null, unit: shape.unit, current: null })
    const tick = () => {
      if (jobId && cancelled.has(jobId)) {
        cancelled.delete(jobId)
        reject('Cancelled — nothing more was written.')
        return
      }
      const t = Date.now() - started
      if (t >= ms) {
        send(1)
        resolve()
        return
      }
      if (t - last >= 160) {
        last = t
        send(t / ms)
      }
      setTimeout(tick, 40)
    }
    tick()
  })
}

async function run(kind: 'backup' | 'restore', connId: string, path: string, o: BackupOptions, emit: Emit = null): Promise<BackupOutcome> {
  const system = sysOf(connId)
  const p = plan(connId, o.database ?? null, o.toolDir ?? null)
  // SQL Server .bacpac: a file on this computer, written / read by SqlPackage
  if (system === 'mssql' && (o.format === 'bacpac' || /\.bacpac$/i.test(path.trim()))) {
    Object.assign(p, { server_side: false, method: 'tool', backup_ready: !!p.backup_tool?.found })
  }
  const lag = Number(param('slowBackup') ?? '0')
  await wait(Number.isFinite(lag) && lag > 0 ? Math.min(lag, 8000) : 60, o.jobId, emit, progressShape(system, kind, path, o))
  if (!path.trim()) throw kind === 'backup' ? 'Choose where to save the backup.' : 'Choose the backup file to restore.'
  if (p.method === 'tool' && !p.backup_ready) throw p.install_hint ?? 'tool missing'
  if (param('backupFail') !== null) {
    throw 'pg_dump failed (exit code 1).\n\nThis pg_dump is older than the server. pg_dump must be the same major version as the server or newer — install a newer PostgreSQL client and pick its folder with "Locate…".\n\npg_dump: error: aborting because of server version mismatch\npg_dump: detail: server version: 17.0; pg_dump version: 16.4'
  }
  if (!p.server_side && !/^([a-zA-Z]:[\\/]|\/)/.test(path)) throw `Choose a full path for the backup file (Browse…) — "${path}" is not one.`
  const db = p.database || 'database'
  const verb = kind === 'backup' ? 'Backed up' : 'Restored'
  const how = p.backup_tool?.name ? ` with ${kind === 'backup' ? p.backup_tool.name : p.restore_tools[0]?.name}` : ''
  return {
    message: p.server_side ? `${verb} ${db} on the server` : system === 'redis' ? `${verb} 1,284 key(s) of db${db}` : `${verb} ${db}${how}`,
    path: system === 'clickhouse' ? `Disk('${o.disk || 'backups'}', '${path.split(/[\\/]/).pop()}')` : path,
    bytes: p.server_side && system !== 'mssql' ? null : 18_874_368,
    duration_ms: 1840,
    server_side: p.server_side,
    log: '',
    notes: system === 'cassandra' && kind === 'backup' ? ['Skipped the data of counter table page_views (counters cannot be restored with INSERT).'] : [],
    items: system === 'redis' ? 1284 : system === 'cassandra' ? 4210 : null,
  }
}

/** Returns undefined for commands this module does not own. */
export function backupDemo(cmd: string, args: Record<string, unknown>): unknown | Promise<unknown> | undefined {
  switch (cmd) {
    case 'backup_plan':
      return plan(String(args.connId ?? ''), (args.database as string | null) ?? null, (args.toolDir as string | null) ?? null)
    case 'backup_tool_status': {
      const p = plan(String(args.connId ?? ''), null, null)
      return { tool: p.backup_tool?.name ?? p.method_label, available: p.backup_ready }
    }
    case 'backup_database':
      return run('backup', String(args.connId ?? ''), String(args.dest ?? ''), (args.options as BackupOptions) ?? {}, (args.onProgress as Emit) ?? null)
    case 'restore_database':
      return run('restore', String(args.connId ?? ''), String(args.src ?? ''), (args.options as BackupOptions) ?? {}, (args.onProgress as Emit) ?? null)
    case 'cancel_backup':
      cancelled.add(String(args.jobId ?? ''))
      return true
    case 'reveal_path':
      return null
    default:
      return undefined
  }
}

/** Test hook: "Locate…" in the browser has no file dialog. */
export function demoPickToolDir(dir: string): void {
  toolDirPicked = dir
}
