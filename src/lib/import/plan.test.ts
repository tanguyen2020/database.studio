import { describe, expect, it } from 'vitest'
import {
  buildInsert,
  chunk,
  conflictSuffix,
  conflictSupported,
  insertPrefix,
  parseJson,
  sqlLiteral,
} from './plan'

describe('conflict handling per dialect', () => {
  it('conflictSupported: PG/MySQL/MariaDB/SQLite yes; CH/MSSQL no', () => {
    expect(conflictSupported('postgres')).toBe(true)
    expect(conflictSupported('mysql')).toBe(true)
    expect(conflictSupported('mariadb')).toBe(true)
    expect(conflictSupported('sqlite')).toBe(true)
    expect(conflictSupported('clickhouse')).toBe(false)
    expect(conflictSupported('mssql')).toBe(false)
  })

  it('skip → correct prefix/suffix shape per dialect', () => {
    // Postgres: plain prefix + trailing ON CONFLICT
    expect(insertPrefix('postgres', 'skip')).toBe('INSERT INTO')
    expect(conflictSuffix('postgres', 'skip')).toBe(' ON CONFLICT DO NOTHING')
    // MySQL / MariaDB: INSERT IGNORE prefix, no suffix
    expect(insertPrefix('mysql', 'skip')).toBe('INSERT IGNORE INTO')
    expect(insertPrefix('mariadb', 'skip')).toBe('INSERT IGNORE INTO')
    expect(conflictSuffix('mysql', 'skip')).toBe('')
    // SQLite: INSERT OR IGNORE prefix
    expect(insertPrefix('sqlite', 'skip')).toBe('INSERT OR IGNORE INTO')
    expect(conflictSuffix('sqlite', 'skip')).toBe('')
  })

  it('error mode → plain INSERT everywhere', () => {
    for (const sys of ['postgres', 'mysql', 'sqlite', 'clickhouse']) {
      expect(insertPrefix(sys, 'error')).toBe('INSERT INTO')
      expect(conflictSuffix(sys, 'error')).toBe('')
    }
  })
})

describe('buildInsert', () => {
  const base = { columns: ['id', 'name'], rows: [['1', 'An'], ['2', "O'Brien"]] as string[][] }

  it('Postgres skip → schema-qualified, double-quoted, ON CONFLICT', () => {
    const sql = buildInsert({ system: 'postgres', schema: 'public', table: 'students', mode: 'skip', ...base })
    expect(sql).toContain('INSERT INTO "public"."students" ("id", "name") VALUES')
    expect(sql).toContain("(1, 'An')")
    expect(sql).toContain("(2, 'O''Brien')") // '' escaping
    expect(sql.trimEnd().endsWith('ON CONFLICT DO NOTHING;')).toBe(true)
  })

  it('MySQL skip → backticks + INSERT IGNORE, no suffix', () => {
    const sql = buildInsert({ system: 'mysql', schema: 'library_db', table: 'books', mode: 'skip', ...base })
    expect(sql).toContain('INSERT IGNORE INTO `library_db`.`books` (`id`, `name`) VALUES')
    expect(sql).not.toContain('ON CONFLICT')
  })

  it('SQLite → no schema qualifier, INSERT OR IGNORE', () => {
    const sql = buildInsert({ system: 'sqlite', schema: 'main', table: 't', mode: 'skip', ...base })
    expect(sql.startsWith('INSERT OR IGNORE INTO "t"')).toBe(true)
    expect(sql).not.toContain('main')
  })

  it('ClickHouse coerces skip → plain INSERT (conflict unsupported)', () => {
    const sql = buildInsert({ system: 'clickhouse', schema: 'lms', table: 'events', mode: 'skip', ...base })
    expect(sql).toContain('INSERT INTO `lms`.`events`')
    expect(sql).not.toContain('IGNORE')
    expect(sql).not.toContain('ON CONFLICT')
  })
})

describe('sqlLiteral', () => {
  it('null/empty → NULL, numeric unquoted, text quoted+escaped', () => {
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral('')).toBe('NULL')
    expect(sqlLiteral('42')).toBe('42')
    expect(sqlLiteral('-3.14')).toBe('-3.14')
    expect(sqlLiteral('hi')).toBe("'hi'")
    expect(sqlLiteral("a'b")).toBe("'a''b'")
    expect(sqlLiteral('007')).toBe('007') // still numeric-shaped → unquoted
  })
})

describe('chunk', () => {
  it('splits into batches; remainder kept', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
    expect(chunk([1, 2, 3], 0)).toEqual([[1, 2, 3]]) // <=0 → single batch
  })

  it('exact 100k rows split into 20 batches of 5000', () => {
    const rows = Array.from({ length: 100_000 }, (_, i) => i)
    const batches = chunk(rows, 5000)
    expect(batches.length).toBe(20)
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(100_000)
  })
})

describe('parseJson', () => {
  it('array of objects → union headers + aligned rows', () => {
    const { headers, rows } = parseJson('[{"id":1,"name":"An"},{"id":2,"gpa":3.9}]')
    expect(headers).toEqual(['id', 'name', 'gpa'])
    expect(rows).toEqual([
      ['1', 'An', ''],
      ['2', '', '3.9'],
    ])
  })

  it('nested object → JSON-stringified cell', () => {
    const { rows } = parseJson('[{"meta":{"a":1}}]')
    expect(rows[0][0]).toBe('{"a":1}')
  })

  it('non-array throws', () => {
    expect(() => parseJson('{"id":1}')).toThrow()
  })
})
