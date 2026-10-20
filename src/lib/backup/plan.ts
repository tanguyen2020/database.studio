// Backup & Restore — pure UI rules per engine (formats, file names, filters,
// restore options, history). No I/O except the guarded localStorage helpers.
import { formatBytes } from '$lib/format/bytes'

/** Every engine the Backup & Restore dialog handles. */
export const BACKUP_SYSTEMS = [
  'postgres',
  'mysql',
  'mariadb',
  'mssql',
  'oracle',
  'sqlite',
  'duckdb',
  'clickhouse',
  'mongodb',
  'cassandra',
  'redis',
] as const

export function supportsBackup(system: string): boolean {
  return (BACKUP_SYSTEMS as readonly string[]).includes(system)
}

export interface FormatChoice {
  id: string
  label: string
  desc: string
  ext: string
}

export function formatsFor(system: string): FormatChoice[] {
  switch (system) {
    case 'postgres':
      return [
        { id: 'plain', label: 'SQL script', desc: 'A readable text file (.sql) you can open, edit or run on any PostgreSQL.', ext: 'sql' },
        { id: 'custom', label: 'Custom archive', desc: 'A compressed file (.dump) — smaller, faster to restore, and single tables can be restored on their own.', ext: 'dump' },
      ]
    case 'mongodb':
      return [
        { id: 'archive', label: 'Archive', desc: 'Every collection in one archive file.', ext: 'archive' },
        { id: 'gzip', label: 'Compressed archive', desc: 'The same archive, compressed — much smaller.', ext: 'archive.gz' },
      ]
    case 'mysql':
    case 'mariadb':
      return [{ id: 'sql', label: 'SQL script', desc: 'A readable text file (.sql) with the tables and their rows.', ext: 'sql' }]
    case 'mssql':
      return [
        { id: 'bak', label: 'Backup on the server (.bak)', desc: 'Written to the server\'s disk — the fastest way to back up and restore SQL Server.', ext: 'bak' },
        { id: 'bacpac', label: 'Export to this computer (.bacpac)', desc: 'Saved on this computer — import it into any SQL Server or Azure SQL.', ext: 'bacpac' },
      ]
    case 'oracle':
      return [{ id: 'dmp', label: 'Data Pump dump (.dmp)', desc: 'Oracle Data Pump export of the schema, written on the database server.', ext: 'dmp' }]
    case 'sqlite':
      return [{ id: 'db', label: 'SQLite database file', desc: 'A complete copy you can open directly.', ext: 'db' }]
    case 'duckdb':
      return [{ id: 'duckdb', label: 'DuckDB database file', desc: 'A complete copy you can open or attach.', ext: 'duckdb' }]
    case 'clickhouse':
      return [{ id: 'zip', label: 'ClickHouse backup (.zip)', desc: 'Native ClickHouse backup, written to a backup disk on the server.', ext: 'zip' }]
    case 'cassandra':
      return [{ id: 'cql', label: 'CQL script', desc: 'The keyspace definition plus every row, as a CQL script.', ext: 'cql' }]
    case 'redis':
      return [{ id: 'jsonl', label: 'Key dump', desc: 'Every key with its value and remaining time-to-live, one per line.', ext: 'redis.jsonl' }]
    default:
      return []
  }
}

export function extFor(system: string, format?: string): string {
  const fs = formatsFor(system)
  return (fs.find((f) => f.id === format) ?? fs[0])?.ext ?? 'bak'
}

/** PostgreSQL / MySQL / MariaDB can back up schema only or data only. */
export function hasContentChoice(system: string): boolean {
  return system === 'postgres' || system === 'mysql' || system === 'mariadb'
}

/** What the "database" of this engine is called in the UI. */
export function targetNoun(system: string): string {
  switch (system) {
    case 'cassandra':
      return 'keyspace'
    case 'oracle':
      return 'schema'
    case 'redis':
      return 'logical database'
    case 'sqlite':
    case 'duckdb':
      return 'database file'
    default:
      return 'database'
  }
}

/** Display name of a database value (Redis keeps an index). */
export function databaseLabel(system: string, db: string): string {
  if (system === 'redis') return `db${db || '0'}`
  return db
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

/** File-system safe name part (keeps letters incl. accents, digits, - _ .). */
export function safeName(s: string): string {
  const cleaned = s
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
  return cleaned || 'backup'
}

export function defaultFileName(system: string, database: string, format: string | undefined, now = new Date()): string {
  const base = system === 'redis' ? `redis_db${database || '0'}` : safeName(database || system)
  return `${base}_${stamp(now)}.${extFor(system, format)}`
}

/** Join a folder and a file name with the folder's own separator. */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i > 0 ? path.slice(0, i) : ''
}

/** Swap the extension when the user switches format (keeps the name they typed). */
export function withExtension(path: string, system: string, format: string | undefined): string {
  const exts = formatsFor(system).map((f) => f.ext).sort((a, b) => b.length - a.length)
  let p = path
  for (const e of exts) {
    if (p.toLowerCase().endsWith('.' + e)) {
      p = p.slice(0, -(e.length + 1))
      break
    }
  }
  return `${p}.${extFor(system, format)}`
}

export interface DialogFilter {
  name: string
  extensions: string[]
}

export function fileFilters(system: string, purpose: 'backup' | 'restore'): DialogFilter[] {
  const fs = formatsFor(system)
  const exts = fs.map((f) => f.ext.split('.').pop() ?? f.ext)
  const extra: Record<string, string[]> = {
    postgres: ['backup', 'tar'],
    sqlite: ['sqlite', 'sqlite3', 'db3'],
    duckdb: ['ddb', 'db'],
    mongodb: ['gz'],
    redis: ['jsonl'],
  }
  const all = [...new Set([...exts, ...(purpose === 'restore' ? (extra[system] ?? []) : [])])]
  return [{ name: 'Backup files', extensions: all }, { name: 'All files', extensions: ['*'] }]
}

/** Restore option toggles an engine offers (key → label + help). */
export interface RestoreToggle {
  key: 'clean' | 'singleTransaction'
  label: string
  help: string
}

export function restoreToggles(system: string, bacpac = false): RestoreToggle[] {
  if (system === 'mssql' && bacpac) {
    return [{ key: 'clean', label: 'Drop the target database first', help: 'SqlPackage imports only into a new or empty database — on: the existing one is dropped and re-created from the file.' }]
  }
  switch (system) {
    case 'postgres':
      return [
        { key: 'clean', label: 'Drop existing objects first', help: 'DROP … IF EXISTS before re-creating (custom archives; SQL scripts carry their own DROP statements when backed up with them).' },
        { key: 'singleTransaction', label: 'Restore in a single transaction', help: 'All or nothing — an error rolls everything back.' },
      ]
    case 'mongodb':
      return [{ key: 'clean', label: 'Drop collections before restoring', help: 'mongorestore --drop: replaces collections instead of adding to them.' }]
    case 'redis':
      return [{ key: 'clean', label: 'Replace existing keys', help: 'Off: keys that already exist are kept. On: they are overwritten.' }]
    case 'clickhouse':
      return [{ key: 'clean', label: 'Drop the target database first', help: 'RESTORE refuses a database that already has tables.' }]
    default:
      return []
  }
}

/** One line on what a restore does to the target, shown before the confirm box. */
export function restoreImpact(system: string, target: string, bacpac = false): string {
  const t = target || 'the database'
  if (system === 'mssql' && bacpac) return `Imports the .bacpac as ${t}. The database must be new or empty — turn on "drop first" to replace an existing one.`
  switch (system) {
    case 'mssql':
      return `Replaces ${t} entirely. Every open session in it is disconnected while the restore runs.`
    case 'sqlite':
    case 'duckdb':
      return 'Replaces every table, view and index in this database file with the backup.'
    case 'oracle':
      return `Imports into schema ${t}; existing tables are replaced (TABLE_EXISTS_ACTION=REPLACE).`
    case 'clickhouse':
      return `Restores the backup as ${t} on the server.`
    case 'redis':
      return `Writes the backed-up keys into ${t}.`
    case 'cassandra':
      return 'Re-creates the keyspace objects that are missing and writes every row of the backup.'
    default:
      return `Runs the backup into ${t}. Objects in the backup overwrite what is there.`
  }
}

/** What a chosen restore file is (from its name — the backend also checks the bytes). */
export function describeBackupFile(system: string, path: string): string {
  const p = path.toLowerCase()
  switch (system) {
    case 'postgres':
      return p.endsWith('.sql') ? 'SQL script — restored with psql' : 'Custom archive — restored with pg_restore'
    case 'mysql':
    case 'mariadb':
      return 'SQL script — restored with the mysql client'
    case 'mongodb':
      return p.endsWith('.gz') ? 'Compressed mongodump archive' : 'mongodump archive'
    case 'mssql':
      return p.endsWith('.bacpac') ? 'SQL Server .bacpac — imported with SqlPackage' : 'SQL Server backup set (.bak) — restored by the server'
    case 'cassandra':
      return 'CQL script'
    case 'redis':
      return 'Database Studio key dump'
    default:
      return ''
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`
  const m = Math.floor(s / 60)
  return `${m} min ${Math.round(s - m * 60)} s`
}

export function sizeLabel(bytes: number | null | undefined): string {
  return bytes == null ? '' : formatBytes(bytes)
}

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

export function baseConnectionId(id: string): string {
  return id.split('#')[0].split('::')[0]
}

/** Remembered client-tool folder per engine family ("Locate…"). */
export function toolDirKey(system: string): string {
  const family = system === 'mariadb' ? 'mysql' : system
  return `ds-backup-tool-dir:${family}`
}

export function loadToolDir(system: string): string {
  try {
    return localStorage.getItem(toolDirKey(system)) ?? ''
  } catch {
    return ''
  }
}

export function saveToolDir(system: string, dir: string): void {
  try {
    if (dir) localStorage.setItem(toolDirKey(system), dir)
    else localStorage.removeItem(toolDirKey(system))
  } catch {
    /* ignore */
  }
}
