import { describe, expect, it } from 'vitest'
import { genAddForeignKey, genCreateIndex, genDropForeignKey, genDropIndex } from './indexes'

describe('genCreateIndex', () => {
  it('PG: UNIQUE + USING method before columns', () => {
    expect(genCreateIndex('postgres', 'public', 'users', { name: 'ix_email', columns: ['email'], unique: true, method: 'btree' })).toBe(
      'CREATE UNIQUE INDEX "ix_email" ON "public"."users" USING btree ("email");',
    )
  })
  it('MySQL: USING method after columns, backtick quoting', () => {
    expect(genCreateIndex('mysql', 'app', 'users', { name: 'ix_name', columns: ['first', 'last'], unique: false, method: 'btree' })).toBe(
      'CREATE INDEX `ix_name` ON `app`.`users` (`first`, `last`) USING BTREE;',
    )
  })
  it('SQLite: no schema qualification', () => {
    expect(genCreateIndex('sqlite', 'main', 't', { name: 'ix', columns: ['a'], unique: false })).toBe(
      'CREATE INDEX "ix" ON "t" ("a");',
    )
  })
})

describe('genDropIndex', () => {
  it('MySQL/MSSQL need the table', () => {
    expect(genDropIndex('mysql', 'app', 'users', 'ix_name')).toBe('DROP INDEX `ix_name` ON `app`.`users`;')
    expect(genDropIndex('mssql', 'dbo', 'users', 'ix_name')).toBe('DROP INDEX [ix_name] ON [dbo].[users];')
  })
  it('PG: schema-qualified index, no table', () => {
    expect(genDropIndex('postgres', 'public', 'users', 'ix_name')).toBe('DROP INDEX IF EXISTS "public"."ix_name";')
  })
  it('SQLite: bare index name', () => {
    expect(genDropIndex('sqlite', 'main', 't', 'ix')).toBe('DROP INDEX IF EXISTS "ix";')
  })
})

describe('foreign keys', () => {
  const fk = { name: 'fk_o_c', from_table: 'orders', from_column: 'cust_id', to_table: 'customers', to_column: 'id' }
  it('add FK (PG)', () => {
    expect(genAddForeignKey('postgres', 'public', fk)).toBe(
      'ALTER TABLE "public"."orders" ADD CONSTRAINT "fk_o_c" FOREIGN KEY ("cust_id") REFERENCES "public"."customers" ("id");',
    )
  })
  it('drop FK: MySQL uses DROP FOREIGN KEY, others DROP CONSTRAINT', () => {
    expect(genDropForeignKey('mysql', 'app', 'orders', 'fk_o_c')).toBe('ALTER TABLE `app`.`orders` DROP FOREIGN KEY `fk_o_c`;')
    expect(genDropForeignKey('postgres', 'public', 'orders', 'fk_o_c')).toBe('ALTER TABLE "public"."orders" DROP CONSTRAINT "fk_o_c";')
    expect(genDropForeignKey('mssql', 'dbo', 'orders', 'fk_o_c')).toBe('ALTER TABLE [dbo].[orders] DROP CONSTRAINT [fk_o_c];')
  })
})
