import { describe, expect, it } from 'vitest'
import { truncateOptions, genTruncateStatements } from './truncate'

describe('truncateOptions — only what each engine supports', () => {
  it('postgres: plain + cascade + restart', () => {
    expect(truncateOptions('postgres').map((o) => o.variant)).toEqual(['plain', 'cascade', 'restart'])
  })
  it('sqlite: plain + restart (no cascade)', () => {
    expect(truncateOptions('sqlite').map((o) => o.variant)).toEqual(['plain', 'restart'])
  })
  it('mysql/mariadb/mssql/clickhouse: plain only', () => {
    for (const s of ['mysql', 'mariadb', 'mssql', 'clickhouse']) {
      expect(truncateOptions(s).map((o) => o.variant)).toEqual(['plain'])
    }
  })
})

describe('genTruncateStatements — exact per-dialect SQL', () => {
  it('postgres variants use real keywords', () => {
    expect(genTruncateStatements('postgres', 'public', 'orders', 'plain')).toEqual(['TRUNCATE TABLE "public"."orders";'])
    expect(genTruncateStatements('postgres', 'public', 'orders', 'cascade')).toEqual([
      'TRUNCATE TABLE "public"."orders" CASCADE;',
    ])
    expect(genTruncateStatements('postgres', 'public', 'orders', 'restart')).toEqual([
      'TRUNCATE TABLE "public"."orders" RESTART IDENTITY;',
    ])
  })
  it('mysql / mariadb use backticks, plain TRUNCATE', () => {
    expect(genTruncateStatements('mysql', 'app', 't', 'plain')).toEqual(['TRUNCATE TABLE `app`.`t`;'])
    expect(genTruncateStatements('mariadb', 'app', 't', 'plain')).toEqual(['TRUNCATE TABLE `app`.`t`;'])
  })
  it('mssql uses brackets', () => {
    expect(genTruncateStatements('mssql', 'dbo', 't', 'plain')).toEqual(['TRUNCATE TABLE [dbo].[t];'])
  })
  it('clickhouse plain (backtick-quoted)', () => {
    expect(genTruncateStatements('clickhouse', 'db', 't', 'plain')).toEqual(['TRUNCATE TABLE `db`.`t`;'])
  })
  it('cassandra: CQL TRUNCATE, plain only', () => {
    expect(truncateOptions('cassandra').map((o) => o.variant)).toEqual(['plain'])
    expect(genTruncateStatements('cassandra', 'campus_ks', 'students', 'plain')).toEqual([
      'TRUNCATE campus_ks.students;',
    ])
  })
  it('sqlite: DELETE (main → bare); restart also clears sqlite_sequence', () => {
    expect(genTruncateStatements('sqlite', 'main', 'todos', 'plain')).toEqual(['DELETE FROM "todos";'])
    expect(genTruncateStatements('sqlite', 'main', 'todos', 'restart')).toEqual([
      'DELETE FROM "todos";',
      "DELETE FROM sqlite_sequence WHERE name = 'todos';",
    ])
  })
})
