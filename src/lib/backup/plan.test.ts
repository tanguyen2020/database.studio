import { beforeEach, describe, expect, it } from 'vitest'
import {
  BACKUP_SYSTEMS,
  baseConnectionId,
  defaultFileName,
  describeBackupFile,
  extFor,
  fileFilters,
  fileName,
  folderOf,
  formatDuration,
  formatsFor,
  hasContentChoice,
  joinPath,
  loadToolDir,
  restoreImpact,
  restoreToggles,
  safeName,
  saveToolDir,
  supportsBackup,
  targetNoun,
  withExtension,
} from './plan'

describe('backup plan — per engine', () => {
  it('covers every database engine and no message broker', () => {
    for (const s of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'sqlite', 'duckdb', 'clickhouse', 'mongodb', 'cassandra', 'redis']) {
      expect(supportsBackup(s), s).toBe(true)
      expect(formatsFor(s).length, s).toBeGreaterThan(0)
    }
    for (const s of ['kafka', 'nats', 'rabbitmq', 'elasticsearch', '']) expect(supportsBackup(s), s).toBe(false)
    expect(BACKUP_SYSTEMS).toHaveLength(11)
  })

  it('formats and extensions', () => {
    expect(formatsFor('postgres').map((f) => f.id)).toEqual(['plain', 'custom'])
    expect(extFor('postgres', 'custom')).toBe('dump')
    expect(extFor('postgres', undefined)).toBe('sql')
    expect(extFor('mongodb', 'gzip')).toBe('archive.gz')
    expect(extFor('mssql')).toBe('bak')
    expect(extFor('redis')).toBe('redis.jsonl')
    expect(hasContentChoice('postgres') && hasContentChoice('mariadb') && !hasContentChoice('mssql')).toBe(true)
  })

  it('default file names are dated, safe and per engine', () => {
    const now = new Date(2026, 9, 19, 9, 5)
    expect(defaultFileName('postgres', 'app', 'plain', now)).toBe('app_2026-10-19_0905.sql')
    expect(defaultFileName('mysql', 'crm.example.com', undefined, now)).toBe('crm.example.com_2026-10-19_0905.sql')
    expect(defaultFileName('redis', '3', undefined, now)).toBe('redis_db3_2026-10-19_0905.redis.jsonl')
    expect(defaultFileName('mssql', 'my db:2', undefined, now)).toBe('my_db_2_2026-10-19_0905.bak')
    expect(safeName('Đào tạo')).toBe('Đào_tạo') // accents kept
    expect(safeName('../..')).toBe('backup')
  })

  it('paths', () => {
    expect(joinPath('C:\\Users\\me\\Backups\\', 'a.sql')).toBe('C:\\Users\\me\\Backups\\a.sql')
    expect(joinPath('/home/me/Backups', 'a.sql')).toBe('/home/me/Backups/a.sql')
    expect(joinPath('', 'a.sql')).toBe('a.sql')
    expect(fileName('C:\\x\\y\\a.dump')).toBe('a.dump')
    expect(folderOf('/var/opt/mssql/data/a.bak')).toBe('/var/opt/mssql/data')
    // switching format swaps a known extension and keeps the typed name
    expect(withExtension('C:\\b\\nightly.sql', 'postgres', 'custom')).toBe('C:\\b\\nightly.dump')
    expect(withExtension('/b/x.archive.gz', 'mongodb', 'archive')).toBe('/b/x.archive')
    expect(withExtension('/b/x', 'postgres', 'plain')).toBe('/b/x.sql')
  })

  it('dialog filters accept what each engine restores', () => {
    expect(fileFilters('postgres', 'restore')[0].extensions).toEqual(expect.arrayContaining(['sql', 'dump', 'backup']))
    expect(fileFilters('sqlite', 'restore')[0].extensions).toEqual(expect.arrayContaining(['db', 'sqlite']))
    expect(fileFilters('postgres', 'backup')[0].extensions).not.toContain('backup')
  })

  it('restore options and impact text', () => {
    expect(restoreToggles('postgres').map((t) => t.key)).toEqual(['clean', 'singleTransaction'])
    expect(restoreToggles('redis')[0].label).toBe('Replace existing keys')
    expect(restoreToggles('mssql')).toEqual([])
    expect(restoreImpact('mssql', 'app')).toContain('disconnected')
    expect(targetNoun('cassandra')).toBe('keyspace')
    expect(describeBackupFile('postgres', 'a.dump')).toContain('pg_restore')
    expect(describeBackupFile('postgres', 'a.sql')).toContain('psql')
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(1840)).toBe('1.8 s')
    expect(formatDuration(125_000)).toBe('2 min 5 s')
  })
})

describe('connection id + tool folder (localStorage)', () => {
  beforeEach(() => localStorage.clear())

  it('reads the BASE connection of a derived id', () => {
    expect(baseConnectionId('c1::analytics')).toBe('c1')
    expect(baseConnectionId('c1#tab-3')).toBe('c1')
  })

  it('remembers the tool folder per engine family', () => {
    saveToolDir('mariadb', 'C:\\mysql\\bin')
    expect(loadToolDir('mysql')).toBe('C:\\mysql\\bin') // same client family
    saveToolDir('mysql', '')
    expect(loadToolDir('mariadb')).toBe('')
  })
})
