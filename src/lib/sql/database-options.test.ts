import { describe, expect, it } from 'vitest'
import {
  buildAllCollationsQuery,
  buildCharsetsQuery,
  buildMssqlCollationsQuery,
  buildMssqlServerCollationQuery,
  buildOracleCharsetQuery,
  buildPgDefaultsQuery,
  buildPgEncodingsQuery,
  buildPgLocalesFallbackQuery,
  buildPgLocalesQuery,
  buildServerCharsetQuery,
  collationsFor,
  databaseOptionClause,
  databaseOptionKind,
  formatOracleCharset,
  parseCharsets,
  parseCollations,
  parseServerDefaults,
  pluck,
  serverDefaultLabel,
} from './database-options'
import { genCreateDatabase } from './ddl'

describe('databaseOptionKind', () => {
  it('offers what each engine really accepts on CREATE DATABASE', () => {
    expect(databaseOptionKind('mysql')).toBe('charset-collation')
    expect(databaseOptionKind('mariadb')).toBe('charset-collation')
    expect(databaseOptionKind('mssql')).toBe('collation')
    expect(databaseOptionKind('postgres')).toBe('encoding-locale')
    expect(databaseOptionKind('oracle')).toBe('server-charset')
    // no database-level charset/collation on these
    for (const s of ['clickhouse', 'sqlite', 'mongodb', 'cassandra', 'redis', 'kafka', 'nats']) {
      expect(databaseOptionKind(s)).toBe('none')
    }
  })
})

describe('databaseOptionClause', () => {
  it('MySQL/MariaDB emit CHARACTER SET and/or COLLATE', () => {
    expect(databaseOptionClause('mysql', { charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' })).toBe(
      ' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
    )
    expect(databaseOptionClause('mysql', { charset: 'utf8mb4' })).toBe(' CHARACTER SET utf8mb4')
    expect(databaseOptionClause('mariadb', { collation: 'utf8mb4_general_ci' })).toBe(' COLLATE utf8mb4_general_ci')
  })

  it('MSSQL emits COLLATE only', () => {
    expect(databaseOptionClause('mssql', { collation: 'Latin1_General_CI_AS' })).toBe(' COLLATE Latin1_General_CI_AS')
    // charset is not a thing on MSSQL → ignored
    expect(databaseOptionClause('mssql', { charset: 'utf8mb4' })).toBe('')
  })

  it('PostgreSQL emits TEMPLATE template0 + ENCODING/LC_* (quoted)', () => {
    const c = databaseOptionClause('postgres', { encoding: 'UTF8', lcCollate: 'en_US.utf8', lcCtype: 'en_US.utf8' })
    expect(c).toContain('TEMPLATE template0')
    expect(c).toContain("ENCODING 'UTF8'")
    expect(c).toContain("LC_COLLATE 'en_US.utf8'")
    expect(c).toContain("LC_CTYPE 'en_US.utf8'")
    // template0 is mandatory as soon as ANY option is set (template1 may differ)
    expect(databaseOptionClause('postgres', { encoding: 'LATIN1' })).toContain('TEMPLATE template0')
  })

  it('is empty when nothing is picked, and for engines without the concept', () => {
    expect(databaseOptionClause('mysql', undefined)).toBe('')
    expect(databaseOptionClause('mysql', {})).toBe('')
    expect(databaseOptionClause('postgres', {})).toBe('')
    expect(databaseOptionClause('clickhouse', { charset: 'utf8mb4', collation: 'x' })).toBe('')
    expect(databaseOptionClause('sqlite', { collation: 'BINARY' })).toBe('')
  })

  it('drops values that are not plain catalog names (no DDL injection)', () => {
    expect(databaseOptionClause('mysql', { charset: 'utf8mb4; DROP DATABASE x' })).toBe('')
    expect(databaseOptionClause('mssql', { collation: "a' OR 1=1" })).toBe('')
    expect(databaseOptionClause('postgres', { encoding: "UTF8'; DROP DATABASE x --" })).toBe('')
    // real locale punctuation stays allowed
    expect(databaseOptionClause('postgres', { lcCollate: 'C.UTF-8' })).toContain("LC_COLLATE 'C.UTF-8'")
    expect(databaseOptionClause('postgres', { lcCollate: 'en-US-x-icu' })).toContain("LC_COLLATE 'en-US-x-icu'")
  })
})

describe('genCreateDatabase with options', () => {
  it('keeps the plain statement when no option is given (unchanged behaviour)', () => {
    expect(genCreateDatabase('postgres', 'app')).toBe('CREATE DATABASE "app";')
    expect(genCreateDatabase('mysql', 'app')).toBe('CREATE DATABASE `app`;')
    expect(genCreateDatabase('mssql', 'app')).toBe('CREATE DATABASE [app];')
    expect(genCreateDatabase('mysql', 'app', {})).toBe('CREATE DATABASE `app`;')
  })

  it('appends the engine-correct clause', () => {
    expect(genCreateDatabase('mysql', 'shop', { charset: 'utf8mb4', collation: 'utf8mb4_general_ci' })).toBe(
      'CREATE DATABASE `shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;',
    )
    expect(genCreateDatabase('mssql', 'shop', { collation: 'Vietnamese_CI_AS' })).toBe(
      'CREATE DATABASE [shop] COLLATE Vietnamese_CI_AS;',
    )
    const pg = genCreateDatabase('postgres', 'shop', { encoding: 'UTF8', lcCollate: 'C', lcCtype: 'C' })
    expect(pg.startsWith('CREATE DATABASE "shop"')).toBe(true)
    expect(pg.endsWith(';')).toBe(true)
    expect(pg).toContain("TEMPLATE template0")
    // engines without the concept ignore options entirely
    expect(genCreateDatabase('clickhouse', 'shop', { charset: 'utf8mb4' })).toBe('CREATE DATABASE `shop`;')
    expect(genCreateDatabase('oracle', 'APP', { collation: 'x' })).toContain('CREATE USER')
  })
})

describe('server queries', () => {
  it('MySQL reads the real catalogs and CASTs to CHAR (binary-charset columns)', () => {
    expect(buildCharsetsQuery()).toContain('information_schema.CHARACTER_SETS')
    expect(buildCharsetsQuery()).toContain('CAST(CHARACTER_SET_NAME AS CHAR)')
    expect(buildAllCollationsQuery()).toContain('information_schema.COLLATIONS')
    expect(buildAllCollationsQuery()).toContain('CAST(COLLATION_NAME AS CHAR)')
    expect(buildServerCharsetQuery()).toContain('@@character_set_server')
    expect(buildServerCharsetQuery()).toContain('@@collation_server')
  })

  it('MSSQL uses fn_helpcollations + SERVERPROPERTY', () => {
    expect(buildMssqlCollationsQuery()).toContain('sys.fn_helpcollations()')
    expect(buildMssqlServerCollationQuery()).toContain("SERVERPROPERTY('Collation')")
  })

  it('PostgreSQL asks the server for encodings, locales and template1 defaults', () => {
    expect(buildPgEncodingsQuery()).toContain('pg_encoding_to_char')
    expect(buildPgLocalesQuery()).toContain('pg_collation')
    expect(buildPgLocalesQuery()).toContain('pg_database')
    expect(buildPgLocalesFallbackQuery()).toContain('pg_database')
    expect(buildPgLocalesFallbackQuery()).not.toContain('pg_collation')
    expect(buildPgDefaultsQuery()).toContain("datname = 'template1'")
  })

  it('Oracle reads the instance NLS character sets', () => {
    expect(buildOracleCharsetQuery()).toContain('nls_database_parameters')
    expect(buildOracleCharsetQuery()).toContain('NLS_CHARACTERSET')
  })
})

describe('row parsing', () => {
  it('pluck keeps order and drops empties/duplicates', () => {
    expect(pluck([{ name: 'a' }, { name: '' }, { name: 'b' }, { name: 'a' }, { name: null }], 'name')).toEqual(['a', 'b'])
  })

  it('parseCharsets / parseCollations', () => {
    expect(
      parseCharsets([
        { name: 'utf8mb4', default_collation: 'utf8mb4_0900_ai_ci' },
        { name: 'latin1', default_collation: 'latin1_swedish_ci' },
        { name: 'utf8mb4', default_collation: 'dup' },
      ]),
    ).toEqual([
      { name: 'utf8mb4', defaultCollation: 'utf8mb4_0900_ai_ci' },
      { name: 'latin1', defaultCollation: 'latin1_swedish_ci' },
    ])
    const colls = parseCollations([
      { name: 'utf8mb4_general_ci', charset: 'utf8mb4' },
      { name: 'latin1_swedish_ci', charset: 'latin1' },
      { name: '', charset: 'x' },
    ])
    expect(colls).toHaveLength(2)
    expect(collationsFor(colls, 'utf8mb4')).toEqual(['utf8mb4_general_ci'])
    // no charset filter (MSSQL-style lists) → everything
    expect(collationsFor(colls, '')).toEqual(['utf8mb4_general_ci', 'latin1_swedish_ci'])
  })

  it('parseServerDefaults picks up only the fields the query returned', () => {
    expect(parseServerDefaults([{ charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }])).toEqual({
      charset: 'utf8mb4',
      collation: 'utf8mb4_0900_ai_ci',
      encoding: undefined,
      lcCollate: undefined,
      lcCtype: undefined,
    })
    expect(parseServerDefaults([{ encoding: 'UTF8', lc_collate: 'en_US.utf8', lc_ctype: 'en_US.utf8' }])).toMatchObject({
      encoding: 'UTF8',
      lcCollate: 'en_US.utf8',
      lcCtype: 'en_US.utf8',
    })
    expect(parseServerDefaults([])).toEqual({})
  })

  it('formatOracleCharset / serverDefaultLabel', () => {
    expect(
      formatOracleCharset([
        { parameter: 'NLS_CHARACTERSET', value: 'AL32UTF8' },
        { parameter: 'NLS_NCHAR_CHARACTERSET', value: 'AL16UTF16' },
      ]),
    ).toBe('NLS_CHARACTERSET AL32UTF8 · NLS_NCHAR_CHARACTERSET AL16UTF16')
    expect(serverDefaultLabel('utf8mb4')).toBe('Server default (utf8mb4)')
    expect(serverDefaultLabel(undefined)).toBe('Server default')
  })
})
