// Unit test SQL generators cho context menu Explorer (ddl.ts) — quoting theo
// dialect, MSSQL dùng TOP, ClickHouse UPDATE/DELETE là ALTER TABLE … mutation.

import { describe, expect, it } from 'vitest'
import { genAlterTable, genCreate, genCreateDatabase, genDelete, genDrop, genDropDatabase, genForeignKey, genInsert, genRename, genRenameDatabase, genSelect, genTruncate, genUpdate } from './ddl'
import type { ColumnInfo } from '$lib/types'

function col(name: string, data_type: string, opts: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, data_type, nullable: true, is_pk: false, is_fk: false, ordinal: 0, ...opts }
}

const cols: ColumnInfo[] = [
  col('id', 'int4', { is_pk: true, nullable: false }),
  col('name', 'varchar(255)', { nullable: false }),
  col('created_at', 'timestamptz'),
]

describe('genSelect', () => {
  it('PG liệt kê cột + LIMIT, quote double, sqlite main bỏ schema', () => {
    expect(genSelect('postgres', 'public', 'users', cols)).toBe(
      'SELECT "id", "name", "created_at"\nFROM "public"."users"\nLIMIT 100;',
    )
    expect(genSelect('sqlite', 'main', 'users', cols)).toBe(
      'SELECT "id", "name", "created_at"\nFROM "users"\nLIMIT 100;',
    )
  })

  it('MSSQL dùng TOP 100 + bracket quoting', () => {
    expect(genSelect('mssql', 'dbo', 'users', cols)).toBe(
      'SELECT TOP 100 [id], [name], [created_at]\nFROM [dbo].[users];',
    )
  })

  it('không có cột → SELECT *', () => {
    expect(genSelect('postgres', 'public', 'users', [])).toContain('SELECT *')
  })
})

describe('genInsert', () => {
  it('bỏ cột PK, sinh sample theo kiểu, MySQL backtick', () => {
    expect(genInsert('mysql', 'app', 'users', cols)).toBe(
      'INSERT INTO `app`.`users` (`name`, `created_at`)\nVALUES (\'\', \'2026-01-01\');',
    )
  })
})

describe('genUpdate', () => {
  it('WHERE theo PK, set các cột non-PK', () => {
    expect(genUpdate('postgres', 'public', 'users', cols)).toBe(
      'UPDATE "public"."users"\nSET "name" = \'\',\n    "created_at" = \'2026-01-01\'\nWHERE "id" = 0;',
    )
  })

  it('ClickHouse → ALTER TABLE … UPDATE (mutation)', () => {
    const out = genUpdate('clickhouse', 'db', 'events', cols)
    expect(out.startsWith('ALTER TABLE `db`.`events`')).toBe(true)
    expect(out).toContain('UPDATE')
    expect(out).toContain('WHERE `id` = 0;')
  })
})

describe('genDelete', () => {
  it('WHERE theo PK', () => {
    expect(genDelete('postgres', 'public', 'users', cols)).toBe(
      'DELETE FROM "public"."users"\nWHERE "id" = 0;',
    )
  })

  it('ClickHouse → ALTER TABLE … DELETE WHERE', () => {
    expect(genDelete('clickhouse', 'db', 'events', cols)).toBe(
      'ALTER TABLE `db`.`events`\n    DELETE WHERE `id` = 0;',
    )
  })
})

describe('genCreate', () => {
  it('NOT NULL + PRIMARY KEY từ ColumnInfo', () => {
    expect(genCreate('postgres', 'public', 'users', cols)).toBe(
      'CREATE TABLE "public"."users" (\n' +
        '  "id" int4 NOT NULL PRIMARY KEY,\n' +
        '  "name" varchar(255) NOT NULL,\n' +
        '  "created_at" timestamptz\n);',
    )
  })
})

describe('genRename / genTruncate / genDrop', () => {
  it('rename thêm hậu tố _new', () => {
    expect(genRename('postgres', 'public', 'users')).toBe(
      'ALTER TABLE "public"."users" RENAME TO "users_new";',
    )
  })

  it('truncate + drop IF EXISTS', () => {
    expect(genTruncate('mysql', 'app', 'users')).toBe('TRUNCATE TABLE `app`.`users`;')
    expect(genDrop('mysql', 'app', 'users')).toBe('DROP TABLE IF EXISTS `app`.`users`;')
  })
})

describe('genAlterTable', () => {
  it('PG/MySQL use ADD COLUMN; MSSQL uses ADD', () => {
    expect(genAlterTable('postgres', 'public', 'users')).toBe('ALTER TABLE "public"."users"\n  ADD COLUMN "new_column" integer;')
    expect(genAlterTable('mysql', 'app', 'users')).toBe('ALTER TABLE `app`.`users`\n  ADD COLUMN `new_column` INT;')
    expect(genAlterTable('mssql', 'dbo', 'users')).toBe('ALTER TABLE [dbo].[users]\n  ADD [new_column] INT;')
  })
})

describe('genCreateDatabase', () => {
  it('CREATE DATABASE per relational dialect (quoted)', () => {
    expect(genCreateDatabase('postgres', 'app')).toBe('CREATE DATABASE "app";')
    expect(genCreateDatabase('mysql', 'app')).toBe('CREATE DATABASE `app`;')
    expect(genCreateDatabase('mssql', 'app')).toBe('CREATE DATABASE [app];')
    expect(genCreateDatabase('clickhouse', 'app')).toBe('CREATE DATABASE `app`;')
  })
  it('sqlite returns a comment (file-based)', () => {
    expect(genCreateDatabase('sqlite', 'app')).toMatch(/^-- SQLite databases are files/)
  })
})

describe('genDropDatabase', () => {
  it('DROP DATABASE IF EXISTS per relational dialect (quoted)', () => {
    expect(genDropDatabase('postgres', 'app')).toBe('DROP DATABASE IF EXISTS "app";')
    expect(genDropDatabase('mysql', 'app')).toBe('DROP DATABASE IF EXISTS `app`;')
    expect(genDropDatabase('mariadb', 'app')).toBe('DROP DATABASE IF EXISTS `app`;')
    expect(genDropDatabase('mssql', 'app')).toBe('DROP DATABASE IF EXISTS [app];')
    expect(genDropDatabase('clickhouse', 'app')).toBe('DROP DATABASE IF EXISTS `app`;')
  })
  it('sqlite returns a comment (file-based)', () => {
    expect(genDropDatabase('sqlite', 'app')).toMatch(/^-- SQLite databases are files/)
  })
})

describe('genRenameDatabase', () => {
  it('postgres ALTER DATABASE … RENAME TO', () => {
    expect(genRenameDatabase('postgres', 'app')).toBe('ALTER DATABASE "app" RENAME TO "app_new";')
  })
  it('mssql ALTER DATABASE … MODIFY NAME', () => {
    expect(genRenameDatabase('mssql', 'app')).toBe('ALTER DATABASE [app] MODIFY NAME = [app_new];')
  })
  it('clickhouse RENAME DATABASE', () => {
    expect(genRenameDatabase('clickhouse', 'app')).toBe('RENAME DATABASE `app` TO `app_new`;')
  })
  it('mysql/mariadb + sqlite return an explanatory comment (no DDL)', () => {
    expect(genRenameDatabase('mysql', 'app')).toMatch(/^-- MySQL\/MariaDB cannot rename/)
    expect(genRenameDatabase('mariadb', 'app')).toMatch(/^-- MySQL\/MariaDB cannot rename/)
    expect(genRenameDatabase('sqlite', 'app')).toMatch(/^-- SQLite databases are files/)
  })
})

describe('genForeignKey', () => {
  it('dialect-aware ALTER ADD CONSTRAINT … FK (Postgres)', () => {
    expect(
      genForeignKey('postgres', 'public', {
        name: 'fk_enroll_student',
        from_table: 'enrollments',
        from_column: 'student_id',
        to_table: 'students',
        to_column: 'id',
      }),
    ).toBe(
      'ALTER TABLE "public"."enrollments" ADD CONSTRAINT "fk_enroll_student" FOREIGN KEY ("student_id") REFERENCES "public"."students" ("id");',
    )
  })

  it('MySQL backtick quoting', () => {
    const sql = genForeignKey('mysql', 'app', {
      name: 'fk1',
      from_table: 'a',
      from_column: 'b_id',
      to_table: 'b',
      to_column: 'id',
    })
    expect(sql).toBe('ALTER TABLE `app`.`a` ADD CONSTRAINT `fk1` FOREIGN KEY (`b_id`) REFERENCES `app`.`b` (`id`);')
  })
})
