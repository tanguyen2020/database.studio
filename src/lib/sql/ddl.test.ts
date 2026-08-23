// Unit test SQL generators cho context menu Explorer (ddl.ts) — quoting theo
// dialect, MSSQL dùng TOP, ClickHouse UPDATE/DELETE là ALTER TABLE … mutation.

import { describe, expect, it } from 'vitest'
import { genAlterTable, genCreate, genCreateDatabase, genCreateSchema, genDelete, genDrop, genDropDatabase, genDropSchema, genForeignKey, genInsert, genRename, genRenameDatabase, genRenameSchema, genSelect, genTruncate, genUpdate, hasRealSchemas } from './ddl'
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

describe('hasRealSchemas', () => {
  it('is true only where a schema is its own object inside a database', () => {
    for (const s of ['postgres', 'mssql', 'oracle']) expect(hasRealSchemas(s), s).toBe(true)
    // these call their DATABASES "schemas" — the node keeps database operations
    for (const s of ['mysql', 'mariadb', 'clickhouse', 'sqlite', 'redis']) expect(hasRealSchemas(s), s).toBe(false)
  })
})

describe('genRenameSchema', () => {
  it('PostgreSQL renames in one statement', () => {
    expect(genRenameSchema('postgres', 'app', 'app_v2')).toBe('ALTER SCHEMA "app" RENAME TO "app_v2";')
    // no target given → the ready-to-edit placeholder
    expect(genRenameSchema('postgres', 'app')).toBe('ALTER SCHEMA "app" RENAME TO "app_new";')
  })
  it('MSSQL and Oracle explain instead of emitting a statement that cannot work', () => {
    expect(genRenameSchema('mssql', 'sales')).toMatch(/^-- MSSQL cannot rename a schema/)
    expect(genRenameSchema('mssql', 'sales')).toContain('TRANSFER')
    expect(genRenameSchema('oracle', 'APP')).toMatch(/^-- In Oracle a schema IS a user/)
  })
  it('schema-as-database engines reuse the database statement', () => {
    expect(genRenameSchema('clickhouse', 'app', 'app2')).toBe('RENAME DATABASE `app` TO `app2`;')
    expect(genRenameSchema('mysql', 'app', 'app2')).toMatch(/^-- MySQL\/MariaDB cannot rename/)
  })
  it('quotes the identifier (no injection through a crafted name)', () => {
    expect(genRenameSchema('postgres', 'a"b', 'c"d')).toBe('ALTER SCHEMA "a""b" RENAME TO "c""d";')
  })
})

describe('genDropSchema', () => {
  it('PostgreSQL defaults to RESTRICT and only cascades when asked', () => {
    expect(genDropSchema('postgres', 'app')).toBe('DROP SCHEMA IF EXISTS "app" RESTRICT;')
    expect(genDropSchema('postgres', 'app', true)).toBe('DROP SCHEMA IF EXISTS "app" CASCADE;')
  })
  it('MSSQL has no CASCADE — the statement is the same either way', () => {
    expect(genDropSchema('mssql', 'sales')).toBe('DROP SCHEMA IF EXISTS [sales];')
    expect(genDropSchema('mssql', 'sales', true)).toBe('DROP SCHEMA IF EXISTS [sales];')
  })
  it('an Oracle schema is a user', () => {
    expect(genDropSchema('oracle', 'APP')).toBe('DROP USER "APP";')
    expect(genDropSchema('oracle', 'APP', true)).toBe('DROP USER "APP" CASCADE;')
  })
  it('schema-as-database engines reuse DROP DATABASE', () => {
    expect(genDropSchema('mysql', 'app')).toBe('DROP DATABASE IF EXISTS `app`;')
    expect(genDropSchema('clickhouse', 'app', true)).toBe('DROP DATABASE IF EXISTS `app`;')
  })
  it('SQLite has no schemas', () => {
    expect(genDropSchema('sqlite', 'main')).toMatch(/^-- SQLite has no schemas/)
  })
})

describe('genCreateSchema', () => {
  it('PostgreSQL and MSSQL create a real schema (T-SQL has no IF NOT EXISTS)', () => {
    expect(genCreateSchema('postgres', 'app')).toBe('CREATE SCHEMA IF NOT EXISTS "app";')
    expect(genCreateSchema('mssql', 'sales')).toBe('CREATE SCHEMA [sales];')
  })
  it('an Oracle schema is a user: create + grants + quota, with the given password', () => {
    const sql = genCreateSchema('oracle', 'APP', { password: 'S3cret' })
    expect(sql.split('\n')).toEqual([
      'CREATE USER "APP" IDENTIFIED BY "S3cret";',
      'GRANT CONNECT, RESOURCE TO "APP";',
      'ALTER USER "APP" QUOTA UNLIMITED ON USERS;',
    ])
    // a double quote cannot live inside a quoted password — it is dropped, never
    // emitted as something that would break out of the literal
    expect(genCreateSchema('oracle', 'APP', { password: 'a"b' })).toContain('IDENTIFIED BY "ab";')
  })
  it('schema-as-database engines reuse CREATE DATABASE', () => {
    expect(genCreateSchema('mysql', 'app')).toBe('CREATE DATABASE `app`;')
    expect(genCreateSchema('clickhouse', 'app')).toBe('CREATE DATABASE `app`;')
  })
  it('SQLite has no schemas', () => {
    expect(genCreateSchema('sqlite', 'main')).toMatch(/^-- SQLite has no schemas/)
  })
  it('quotes the identifier', () => {
    expect(genCreateSchema('postgres', 'a"b')).toBe('CREATE SCHEMA IF NOT EXISTS "a""b";')
  })
})
