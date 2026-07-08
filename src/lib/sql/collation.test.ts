import { describe, expect, it } from 'vitest'
import {
  buildAuditQuery,
  buildCollationsQuery,
  buildDefaultCollationQuery,
  buildUnifySql,
  buildUnifyStatements,
  charsetOf,
  columnCollations,
  distinctCollations,
  isMysqlFamily,
  needsConvert,
  tablesToConvert,
  type TableCollationRow,
} from './collation'

describe('charsetOf', () => {
  it('strips the collation suffix to the charset prefix', () => {
    expect(charsetOf('utf8mb4_0900_ai_ci')).toBe('utf8mb4')
    expect(charsetOf('utf8mb4_general_ci')).toBe('utf8mb4')
    expect(charsetOf('utf8mb3_unicode_ci')).toBe('utf8mb3')
    expect(charsetOf('latin1_swedish_ci')).toBe('latin1')
  })
})

describe('isMysqlFamily', () => {
  it('is true only for mysql/mariadb', () => {
    expect(isMysqlFamily('mysql')).toBe(true)
    expect(isMysqlFamily('mariadb')).toBe(true)
    expect(isMysqlFamily('postgres')).toBe(false)
    expect(isMysqlFamily('clickhouse')).toBe(false)
  })
})

const rows: TableCollationRow[] = [
  { table_name: 'sequences', table_collation: 'utf8mb4_0900_ai_ci', column_collations: 'utf8mb4_0900_ai_ci' },
  { table_name: 'logs', table_collation: 'utf8mb4_general_ci', column_collations: 'utf8mb4_general_ci' },
  { table_name: 'events', table_collation: 'utf8mb4_0900_ai_ci', column_collations: 'utf8mb4_0900_ai_ci,utf8mb4_general_ci' },
  { table_name: 'metrics', table_collation: 'utf8mb4_0900_ai_ci', column_collations: null },
]

describe('needsConvert / tablesToConvert', () => {
  it('flags a table whose default collation differs', () => {
    expect(needsConvert(rows[1], 'utf8mb4_0900_ai_ci')).toBe(true)
  })
  it('flags a table whose column collation differs even if default matches', () => {
    expect(needsConvert(rows[2], 'utf8mb4_0900_ai_ci')).toBe(true)
  })
  it('leaves an already-uniform table alone', () => {
    expect(needsConvert(rows[0], 'utf8mb4_0900_ai_ci')).toBe(false)
    expect(needsConvert(rows[3], 'utf8mb4_0900_ai_ci')).toBe(false)
  })
  it('returns exactly the mismatched table names', () => {
    expect(tablesToConvert(rows, 'utf8mb4_0900_ai_ci')).toEqual(['logs', 'events'])
    // targeting general_ci flips which tables are off-target; metrics has no text
    // columns but its table default (0900_ai_ci) still differs → converted too.
    expect(tablesToConvert(rows, 'utf8mb4_general_ci')).toEqual(['sequences', 'events', 'metrics'])
  })
})

describe('columnCollations / distinctCollations', () => {
  it('splits and trims the GROUP_CONCAT list', () => {
    expect(columnCollations(rows[2])).toEqual(['utf8mb4_0900_ai_ci', 'utf8mb4_general_ci'])
    expect(columnCollations(rows[3])).toEqual([])
  })
  it('collects every distinct collation present, sorted', () => {
    expect(distinctCollations(rows)).toEqual(['utf8mb4_0900_ai_ci', 'utf8mb4_general_ci'])
  })
})

describe('buildUnifyStatements', () => {
  it('wraps FK checks, alters the DB, then converts each table (backtick-quoted)', () => {
    expect(buildUnifyStatements('mysql', 'ismart-eco', 'utf8mb4_0900_ai_ci', ['logs', 'events'])).toEqual([
      'SET FOREIGN_KEY_CHECKS = 0;',
      'ALTER DATABASE `ismart-eco` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
      'ALTER TABLE `ismart-eco`.`logs` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
      'ALTER TABLE `ismart-eco`.`events` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
      'SET FOREIGN_KEY_CHECKS = 1;',
    ])
  })
  it('honors opts (no FK wrap, no ALTER DATABASE)', () => {
    expect(
      buildUnifyStatements('mariadb', 'app', 'utf8mb4_general_ci', ['t'], { disableFkChecks: false, alterDatabase: false }),
    ).toEqual(['ALTER TABLE `app`.`t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;'])
  })
  it('still emits ALTER DATABASE when there are no tables to convert', () => {
    expect(buildUnifyStatements('mysql', 'app', 'utf8mb4_0900_ai_ci', [])).toEqual([
      'SET FOREIGN_KEY_CHECKS = 0;',
      'ALTER DATABASE `app` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;',
      'SET FOREIGN_KEY_CHECKS = 1;',
    ])
  })
  it('returns nothing for a non-MySQL system', () => {
    expect(buildUnifyStatements('postgres', 'app', 'utf8mb4_0900_ai_ci', ['t'])).toEqual([])
    expect(buildUnifyStatements('mysql', '', 'utf8mb4_0900_ai_ci', ['t'])).toEqual([])
  })
})

describe('buildUnifySql', () => {
  it('prepends a header and joins the statements', () => {
    const sql = buildUnifySql('mysql', 'app', 'utf8mb4_0900_ai_ci', ['t'])
    expect(sql).toContain('-- Unify collation of database `app` → utf8mb4_0900_ai_ci')
    expect(sql).toContain('NOT modified')
    expect(sql).toContain('ALTER TABLE `app`.`t` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;')
  })
  it('explains when the system is unsupported', () => {
    expect(buildUnifySql('postgres', 'app', 'x', ['t'])).toContain('MySQL/MariaDB only')
  })
})

describe('audit / helper queries', () => {
  it('audit query targets base tables of the given schema, escaping the name', () => {
    const q = buildAuditQuery("is'mart")
    expect(q).toContain("t.TABLE_SCHEMA = 'is''mart'")
    expect(q).toContain("t.TABLE_TYPE = 'BASE TABLE'")
    expect(q).toContain('GROUP_CONCAT(DISTINCT c.COLLATION_NAME')
  })
  it('collations query filters by charset', () => {
    expect(buildCollationsQuery('utf8mb4')).toContain("CHARACTER_SET_NAME = 'utf8mb4'")
  })
  it('default-collation query reads information_schema.SCHEMATA', () => {
    expect(buildDefaultCollationQuery('app')).toContain("SCHEMA_NAME = 'app'")
  })
})
