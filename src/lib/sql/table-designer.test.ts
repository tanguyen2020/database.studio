import { describe, expect, it } from 'vitest'
import {
  alterColumn,
  buildTableDdl,
  buildTrigger,
  columnChanged,
  columnDef,
  columnRenamed,
  renameColumn,
  indexChanged,
  uniqueChanged,
  fkChanged,
  type TableModel,
} from './table-designer'

function model(o: Partial<TableModel>): TableModel {
  return {
    schema: 'public',
    table: 'users',
    columns: [
      { name: 'id', type: 'int4', len: '', pk: true, nullable: false, dflt: '' },
      { name: 'email', type: 'varchar', len: '255', pk: false, nullable: false, dflt: '' },
    ],
    indexes: [],
    foreignKeys: [],
    uniques: [],
    checks: [],
    triggers: [],
    ...o,
  }
}

describe('columnDef', () => {
  it('emits type, length, NOT NULL, DEFAULT (non-PK)', () => {
    expect(columnDef('postgres', { name: 'email', type: 'varchar', len: '255', pk: false, nullable: false, dflt: "''" })).toBe(
      '"email" varchar(255) NOT NULL DEFAULT \'\'',
    )
  })
  it('PK column omits NOT NULL (the table-level PK enforces it)', () => {
    expect(columnDef('postgres', { name: 'id', type: 'int4', len: '', pk: true, nullable: false, dflt: '' })).toBe('"id" int4')
  })
})

describe('buildTableDdl — new table column handling', () => {
  it('skips a trailing blank row (the designer keeps one empty row for entry)', () => {
    const { statements } = buildTableDdl(
      'postgres',
      model({
        table: 't',
        columns: [
          { name: 'id', type: 'int4', len: '', pk: true, nullable: false, dflt: '' },
          { name: 'name', type: 'text', len: '', pk: false, nullable: true, dflt: '' },
          { name: '', type: 'int4', len: '', pk: false, nullable: true, dflt: '' }, // blank → skipped
        ],
      }),
      true,
    )
    const create = statements[0]
    expect(create).toContain('"id" int4')
    expect(create).toContain('"name" text')
    // only the two real columns are emitted (blank row skipped, in order)
    const colDefs = [...create.matchAll(/^\s+"(\w+)"\s+\w+/gm)].map((m) => m[1])
    expect(colDefs).toEqual(['id', 'name'])
  })

  it('emits columns in model (drag-reorder) order', () => {
    const { statements } = buildTableDdl(
      'postgres',
      model({
        table: 't',
        columns: [
          { name: 'b', type: 'int4', len: '', pk: false, nullable: true, dflt: '' },
          { name: 'a', type: 'int4', len: '', pk: false, nullable: true, dflt: '' },
        ],
      }),
      true,
    )
    expect(statements[0].indexOf('"b"')).toBeLessThan(statements[0].indexOf('"a"'))
  })
})

describe('buildTableDdl — partitioning (new table)', () => {
  it('postgres: appends PARTITION BY and CREATE TABLE … PARTITION OF children', () => {
    const { statements } = buildTableDdl(
      'postgres',
      model({
        table: 'events',
        columns: [
          { name: 'id', type: 'bigint', len: '', pk: false, nullable: false, dflt: '' },
          { name: 'created_at', type: 'date', len: '', pk: false, nullable: false, dflt: '' },
        ],
        partition: {
          strategy: 'RANGE',
          columns: ['created_at'],
          partitions: [{ name: 'events_2024', bound: "FROM ('2024-01-01') TO ('2025-01-01')" }],
        },
      }),
      true,
    )
    expect(statements[0]).toContain('PARTITION BY RANGE ("created_at")')
    expect(statements[1]).toBe(
      `CREATE TABLE "public"."events_2024" PARTITION OF "public"."events" FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');`,
    )
  })

  it('mysql: inline PARTITION BY list on the CREATE', () => {
    const { statements } = buildTableDdl(
      'mysql',
      model({
        schema: '',
        table: 'logs',
        columns: [{ name: 'ts', type: 'datetime', len: '', pk: false, nullable: false, dflt: '' }],
        partition: { strategy: 'RANGE', columns: ['YEAR(ts)'], partitions: [{ name: 'p2024', bound: '2025' }] },
      }),
      true,
    )
    expect(statements[0]).toContain('PARTITION BY RANGE (YEAR(ts))')
    expect(statements[0]).toContain('PARTITION `p2024` VALUES LESS THAN (2025)')
  })

  it('clickhouse: PARTITION BY sits between ENGINE and ORDER BY', () => {
    const { statements } = buildTableDdl(
      'clickhouse',
      model({
        schema: '',
        table: 'hits',
        columns: [{ name: 'ts', type: 'DateTime', len: '', pk: true, nullable: false, dflt: '' }],
        partition: { strategy: 'RANGE', columns: ['toYYYYMM(ts)'] },
      }),
      true,
    )
    expect(statements[0]).toMatch(/ENGINE = MergeTree\nPARTITION BY toYYYYMM\(ts\)\nORDER BY/)
  })

  it('mssql: partition function + scheme precede the CREATE, table lands ON the scheme', () => {
    const { statements } = buildTableDdl(
      'mssql',
      model({
        schema: 'dbo',
        table: 'sales',
        columns: [{ name: 'sale_date', type: 'date', len: '', pk: false, nullable: false, dflt: '' }],
        partition: { strategy: 'RANGE', columns: ['sale_date'], partitions: [{ name: 'p1', bound: "'2024-01-01'" }] },
      }),
      true,
    )
    expect(statements[0]).toContain('CREATE PARTITION FUNCTION [pf_sales] (date)')
    expect(statements[1]).toContain('CREATE PARTITION SCHEME [ps_sales]')
    expect(statements[2]).toContain('ON [ps_sales] ([sale_date])')
  })
})

describe('buildTableDdl — new table, per dialect', () => {
  it('postgres: table-level PK + inline UNIQUE/CHECK/FK, then CREATE INDEX', () => {
    const { statements } = buildTableDdl(
      'postgres',
      model({
        uniques: [{ name: '', columns: ['email'] }],
        checks: [{ name: 'ck_age', expression: 'age >= 0' }],
        foreignKeys: [{ name: '', columns: ['org_id'], refTable: 'orgs', refColumns: ['id'], onDelete: 'CASCADE' }],
        indexes: [{ name: '', columns: ['email'], method: 'btree' }],
      }),
      true,
    )
    const create = statements[0]
    expect(create).toContain('CREATE TABLE "public"."users"')
    expect(create).toContain('PRIMARY KEY ("id")')
    expect(create).toContain('CONSTRAINT "uq_users_email" UNIQUE ("email")')
    expect(create).toContain('CONSTRAINT "ck_age" CHECK (age >= 0)')
    expect(create).toContain('CONSTRAINT "fk_users_org_id" FOREIGN KEY ("org_id") REFERENCES "public"."orgs" ("id") ON DELETE CASCADE')
    expect(statements[1]).toBe('CREATE INDEX "idx_users_email" ON "public"."users" USING btree ("email");')
  })

  it('mysql: backtick quoting, no schema wart, USING after cols', () => {
    const { statements } = buildTableDdl(
      'mysql',
      model({
        schema: '',
        table: 'orders',
        columns: [{ name: 'id', type: 'int', len: '', pk: true, nullable: false, dflt: '' }],
        indexes: [{ name: 'ix_id', columns: ['id'], method: 'btree' }],
      }),
      true,
    )
    expect(statements[0]).toContain('CREATE TABLE `orders`')
    expect(statements[0]).toContain('PRIMARY KEY (`id`)')
    expect(statements[1]).toBe('CREATE INDEX `ix_id` ON `orders` (`id`) USING BTREE;')
  })

  it('mssql: bracket quoting', () => {
    const { statements } = buildTableDdl('mssql', model({ schema: 'dbo' }), true)
    expect(statements[0]).toContain('CREATE TABLE [dbo].[users]')
    expect(statements[0]).toContain('PRIMARY KEY ([id])')
  })

  it('sqlite: no schema prefix for main, inline UNIQUE/CHECK', () => {
    const { statements } = buildTableDdl(
      'sqlite',
      model({
        schema: 'main',
        columns: [{ name: 'id', type: 'INTEGER', len: '', pk: true, nullable: false, dflt: '' }],
        uniques: [{ name: 'uq_email', columns: ['email'] }],
      }),
      true,
    )
    expect(statements[0]).toContain('CREATE TABLE "users"')
    expect(statements[0]).not.toContain('"main"')
    expect(statements[0]).toContain('CONSTRAINT "uq_email" UNIQUE ("email")')
  })

  it('clickhouse: ENGINE MergeTree + ORDER BY pk, skips constraints with a warning', () => {
    const { statements, warnings } = buildTableDdl(
      'clickhouse',
      model({
        schema: '',
        table: 'events',
        columns: [
          { name: 'id', type: 'UInt32', len: '', pk: true, nullable: false, dflt: '' },
          { name: 'ts', type: 'DateTime', len: '', pk: false, nullable: true, dflt: '' },
        ],
        foreignKeys: [{ name: '', columns: ['id'], refTable: 'x', refColumns: ['id'] }],
      }),
      true,
    )
    expect(statements[0]).toContain('ENGINE = MergeTree')
    expect(statements[0]).toContain('ORDER BY (`id`)')
    expect(statements[0]).not.toContain('FOREIGN KEY')
    expect(warnings.join(' ')).toMatch(/ClickHouse has no/)
  })

  it('composite primary key becomes one table-level PRIMARY KEY', () => {
    const { statements } = buildTableDdl(
      'postgres',
      model({
        columns: [
          { name: 'a', type: 'int4', len: '', pk: true, nullable: false, dflt: '' },
          { name: 'b', type: 'int4', len: '', pk: true, nullable: false, dflt: '' },
        ],
      }),
      true,
    )
    expect(statements[0]).toContain('PRIMARY KEY ("a", "b")')
    expect((statements[0].match(/PRIMARY KEY/g) || []).length).toBe(1)
  })
})

describe('buildTableDdl — existing table (ALTER additions)', () => {
  const base = () =>
    model({
      columns: [
        { name: 'id', type: 'int4', len: '', pk: true, nullable: false, dflt: '', existing: true },
        { name: 'nickname', type: 'varchar', len: '50', pk: false, nullable: true, dflt: '' }, // new
      ],
      uniques: [
        { name: 'uq_old', columns: ['email'], existing: true },
        { name: 'uq_nick', columns: ['nickname'] }, // new
      ],
      checks: [{ name: 'ck_len', expression: 'length(nickname) > 0' }],
      foreignKeys: [{ name: 'fk_org', columns: ['org_id'], refTable: 'orgs', refColumns: ['id'] }],
      indexes: [{ name: 'ix_nick', columns: ['nickname'] }],
    })

  it('postgres: only NEW items → ADD COLUMN / ADD CONSTRAINT / CREATE INDEX', () => {
    const { statements } = buildTableDdl('postgres', base(), false)
    const joined = statements.join('\n')
    expect(joined).toContain('ALTER TABLE "public"."users" ADD COLUMN "nickname" varchar(50)')
    expect(joined).toContain('ALTER TABLE "public"."users" ADD CONSTRAINT "uq_nick" UNIQUE ("nickname")')
    expect(joined).toContain('ALTER TABLE "public"."users" ADD CONSTRAINT "ck_len" CHECK (length(nickname) > 0)')
    expect(joined).toContain('ALTER TABLE "public"."users" ADD CONSTRAINT "fk_org" FOREIGN KEY ("org_id") REFERENCES "public"."orgs" ("id")')
    expect(joined).toContain('CREATE INDEX "ix_nick" ON "public"."users" ("nickname");')
    // seeded (existing) items are never re-emitted
    expect(joined).not.toContain('uq_old')
    expect(joined).not.toContain('"id" int4') // existing column not re-added
  })

  it('mssql: ADD (no COLUMN keyword)', () => {
    const { statements } = buildTableDdl('mssql', model({ schema: 'dbo', columns: [{ name: 'note', type: 'nvarchar', len: '100', pk: false, nullable: true, dflt: '' }] }), false)
    expect(statements[0]).toBe('ALTER TABLE [dbo].[users] ADD [note] nvarchar(100);')
  })

  it('sqlite: UNIQUE degrades to a UNIQUE INDEX; CHECK/FK warn (cannot ALTER-ADD)', () => {
    const { statements, warnings } = buildTableDdl('sqlite', { ...base(), schema: 'main' }, false)
    const joined = statements.join('\n')
    expect(joined).toContain('CREATE UNIQUE INDEX "uq_nick" ON "users" ("nickname");')
    expect(joined).not.toContain('ADD CONSTRAINT')
    expect(warnings.join(' ')).toMatch(/cannot ADD a CHECK/)
    expect(warnings.join(' ')).toMatch(/cannot ADD a FOREIGN KEY/)
  })
})

describe('edit existing objects (rename / drop+recreate)', () => {
  it('columnRenamed + renameColumn per dialect', () => {
    const c = { name: 'full_name', type: 'text', len: '', pk: false, nullable: true, dflt: '', existing: true, orig: { name: 'name', type: 'text', len: '', nullable: true, dflt: '' } }
    expect(columnRenamed(c)).toBe(true)
    expect(renameColumn('postgres', 'public', 'users', 'name', 'full_name')).toBe('ALTER TABLE "public"."users" RENAME COLUMN "name" TO "full_name";')
    expect(renameColumn('mssql', 'dbo', 'users', 'name', 'full_name')).toBe(`EXEC sp_rename 'dbo.users.name', 'full_name', 'COLUMN';`)
  })

  it('renamed existing column emits RENAME before the type ALTER', () => {
    const { statements } = buildTableDdl(
      'postgres',
      model({
        columns: [{ name: 'full_name', type: 'varchar', len: '100', pk: false, nullable: false, dflt: '', existing: true, orig: { name: 'name', type: 'text', len: '', nullable: true, dflt: '' } }],
      }),
      false,
    )
    const joined = statements.join('\n')
    expect(statements[0]).toBe('ALTER TABLE "public"."users" RENAME COLUMN "name" TO "full_name";')
    expect(joined).toContain('ALTER COLUMN "full_name" TYPE varchar(100)')
  })

  it('edited existing index → DROP then CREATE', () => {
    const ix = { name: 'ix_a', columns: ['a', 'b'], method: 'btree', existing: true, orig: { columns: ['a'], method: 'btree' } }
    expect(indexChanged(ix)).toBe(true)
    const { statements } = buildTableDdl('postgres', model({ indexes: [ix] }), false)
    const joined = statements.join('\n')
    expect(joined).toContain('DROP INDEX IF EXISTS "public"."ix_a";')
    expect(joined).toContain('CREATE INDEX "ix_a" ON "public"."users" USING btree ("a", "b");')
  })

  it('unchanged existing index/unique/fk is NOT re-emitted', () => {
    expect(indexChanged({ name: 'ix', columns: ['a'], existing: true, orig: { columns: ['a'] } })).toBe(false)
    expect(uniqueChanged({ name: 'uq', columns: ['a'], existing: true, orig: { columns: ['a'] } })).toBe(false)
    expect(fkChanged({ name: 'fk', columns: ['a'], refTable: 'o', refColumns: ['id'], existing: true, orig: { columns: ['a'], refTable: 'o', refColumns: ['id'] } })).toBe(false)
  })

  it('edited existing FK → DROP then ADD (with ON UPDATE)', () => {
    const fk = { name: 'fk_o', columns: ['org_id'], refTable: 'orgs', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'SET NULL', existing: true, orig: { columns: ['org_id'], refTable: 'orgs', refColumns: ['id'], onDelete: '', onUpdate: '' } }
    expect(fkChanged(fk)).toBe(true)
    const { statements } = buildTableDdl('postgres', model({ foreignKeys: [fk] }), false)
    const joined = statements.join('\n')
    expect(joined).toContain('ALTER TABLE "public"."users" DROP CONSTRAINT "fk_o";')
    expect(joined).toContain('ON DELETE CASCADE ON UPDATE SET NULL')
  })

  it('edited existing unique → DROP CONSTRAINT then ADD CONSTRAINT', () => {
    const u = { name: 'uq_e', columns: ['email', 'org_id'], existing: true, orig: { columns: ['email'] } }
    expect(uniqueChanged(u)).toBe(true)
    const { statements } = buildTableDdl('postgres', model({ uniques: [u] }), false)
    const joined = statements.join('\n')
    expect(joined).toContain('DROP CONSTRAINT "uq_e";')
    expect(joined).toContain('ADD CONSTRAINT "uq_e" UNIQUE ("email", "org_id");')
  })
})

describe('buildTrigger — per dialect', () => {
  it('postgres: EXECUTE FUNCTION, appends () if missing', () => {
    const { sql } = buildTrigger('postgres', 'public', 'users', { name: 'aud', timing: 'BEFORE', event: 'INSERT', body: 'audit_fn' })
    expect(sql).toBe('CREATE TRIGGER "aud" BEFORE INSERT ON "public"."users"\nFOR EACH ROW EXECUTE FUNCTION audit_fn();')
  })
  it('postgres: no body → warning, no sql', () => {
    const r = buildTrigger('postgres', 'public', 'users', { name: 'aud', timing: 'BEFORE', event: 'INSERT', body: '' })
    expect(r.sql).toBeUndefined()
    expect(r.warning).toMatch(/PostgreSQL needs a function/)
  })
  it('mysql: FOR EACH ROW <body>', () => {
    const { sql } = buildTrigger('mysql', '', 'users', { name: 'aud', timing: 'AFTER', event: 'UPDATE', body: 'SET NEW.updated = NOW()' })
    expect(sql).toBe('CREATE TRIGGER `aud` AFTER UPDATE ON `users`\nFOR EACH ROW SET NEW.updated = NOW();')
  })
  it('mssql: ON table AFTER event AS body; BEFORE downgraded to AFTER with a warning', () => {
    const { sql, warning } = buildTrigger('mssql', 'dbo', 'users', { name: 'aud', timing: 'BEFORE', event: 'DELETE', body: 'SELECT 1' })
    expect(sql).toBe('CREATE TRIGGER [aud] ON [dbo].[users]\nAFTER DELETE\nAS\nSELECT 1;')
    expect(warning).toMatch(/no BEFORE triggers/)
  })
  it('sqlite: wraps body in BEGIN … END and terminates it', () => {
    const { sql } = buildTrigger('sqlite', 'main', 'users', { name: 'aud', timing: 'AFTER', event: 'INSERT', body: 'UPDATE t SET n = n + 1' })
    expect(sql).toBe('CREATE TRIGGER "aud" AFTER INSERT ON "users"\nBEGIN\n  UPDATE t SET n = n + 1;\nEND;')
  })
  it('clickhouse: warns (no triggers)', () => {
    const r = buildTrigger('clickhouse', '', 'events', { name: 'x', timing: 'AFTER', event: 'INSERT', body: 'y' })
    expect(r.sql).toBeUndefined()
    expect(r.warning).toMatch(/not supported/)
  })
})

describe('buildTableDdl — DROP existing objects (edit/delete across tabs)', () => {
  const existing = () =>
    model({
      columns: [
        { name: 'id', type: 'int4', len: '', pk: true, nullable: false, dflt: '', existing: true },
        { name: 'old_col', type: 'text', len: '', pk: false, nullable: true, dflt: '', existing: true, dropped: true },
      ],
      indexes: [{ name: 'ix_old', columns: ['old_col'], existing: true, dropped: true }],
      foreignKeys: [{ name: 'fk_old', columns: ['org_id'], refTable: 'orgs', refColumns: ['id'], existing: true, dropped: true }],
      uniques: [{ name: 'uq_old', columns: ['email'], existing: true, dropped: true }],
      checks: [{ name: 'ck_old', expression: 'x > 0', existing: true, dropped: true }],
      triggers: [{ name: 'trg_old', timing: 'BEFORE', event: 'INSERT', body: '', table: 'users', existing: true, dropped: true }],
    })

  it('postgres: drops column/index/fk/unique/check/trigger', () => {
    const j = buildTableDdl('postgres', existing(), false).statements.join('\n')
    expect(j).toContain('ALTER TABLE "public"."users" DROP COLUMN "old_col";')
    expect(j).toContain('DROP INDEX IF EXISTS "public"."ix_old";')
    expect(j).toContain('ALTER TABLE "public"."users" DROP CONSTRAINT "fk_old";')
    expect(j).toContain('ALTER TABLE "public"."users" DROP CONSTRAINT "uq_old";')
    expect(j).toContain('ALTER TABLE "public"."users" DROP CONSTRAINT "ck_old";')
    expect(j).toContain('DROP TRIGGER IF EXISTS "trg_old" ON "public"."users";')
  })

  it('mysql: DROP INDEX for unique, DROP CHECK, DROP FOREIGN KEY, DROP TRIGGER', () => {
    const j = buildTableDdl('mysql', { ...existing(), schema: '' }, false).statements.join('\n')
    expect(j).toContain('ALTER TABLE `users` DROP INDEX `uq_old`;')
    expect(j).toContain('ALTER TABLE `users` DROP CHECK `ck_old`;')
    expect(j).toContain('ALTER TABLE `users` DROP FOREIGN KEY `fk_old`;')
    expect(j).toContain('DROP TRIGGER IF EXISTS `trg_old`;')
    expect(j).toContain('ALTER TABLE `users` DROP COLUMN `old_col`;')
  })

  it('sqlite: DROP COLUMN + DROP unique index; CHECK/FK drop warn', () => {
    const { statements, warnings } = buildTableDdl('sqlite', { ...existing(), schema: 'main' }, false)
    const j = statements.join('\n')
    expect(j).toContain('ALTER TABLE "users" DROP COLUMN "old_col";')
    expect(j).toContain('DROP INDEX IF EXISTS "uq_old";')
    expect(warnings.join(' ')).toMatch(/cannot DROP a CHECK/)
    expect(warnings.join(' ')).toMatch(/cannot DROP a FOREIGN KEY/)
  })
})

describe('columnChanged + alterColumn (edit existing column)', () => {
  const changed = { name: 'price', type: 'numeric', len: '10,2', pk: false, nullable: false, dflt: '0', existing: true, orig: { name: 'price', type: 'int4', len: '', nullable: true, dflt: '' } }
  it('columnChanged detects a real edit vs an untouched existing column', () => {
    expect(columnChanged(changed)).toBe(true)
    expect(columnChanged({ ...changed, type: 'int4', len: '', nullable: true, dflt: '' })).toBe(false)
    expect(columnChanged({ ...changed, existing: false })).toBe(false)
  })
  it('postgres alter: TYPE + SET NOT NULL + SET DEFAULT', () => {
    const { statements } = alterColumn('postgres', 'public', 'products', changed)
    expect(statements[0]).toBe('ALTER TABLE "public"."products" ALTER COLUMN "price" TYPE numeric(10,2);')
    expect(statements[1]).toBe('ALTER TABLE "public"."products" ALTER COLUMN "price" SET NOT NULL;')
    expect(statements[2]).toBe('ALTER TABLE "public"."products" ALTER COLUMN "price" SET DEFAULT 0;')
  })
  it('mysql alter: MODIFY COLUMN one-liner', () => {
    const { statements } = alterColumn('mysql', '', 'products', changed)
    expect(statements[0]).toBe('ALTER TABLE `products` MODIFY COLUMN `price` numeric(10,2) NOT NULL DEFAULT 0;')
  })
  it('mssql alter: ALTER COLUMN with NULL/NOT NULL', () => {
    const { statements } = alterColumn('mssql', 'dbo', 'products', changed)
    expect(statements[0]).toBe('ALTER TABLE [dbo].[products] ALTER COLUMN [price] numeric(10,2) NOT NULL;')
  })
  it('sqlite alter: warns (no column alter)', () => {
    const { statements, warnings } = alterColumn('sqlite', 'main', 'products', changed)
    expect(statements).toHaveLength(0)
    expect(warnings.join(' ')).toMatch(/SQLite cannot ALTER a column/)
  })
  it('buildTableDdl (existing PG) emits alter for a changed column', () => {
    const m = model({
      columns: [
        { name: 'id', type: 'int4', len: '', pk: true, nullable: false, dflt: '', existing: true },
        { name: 'price', type: 'numeric', len: '10,2', pk: false, nullable: false, dflt: '', existing: true, orig: { name: 'price', type: 'int4', len: '', nullable: true, dflt: '' } },
      ],
    })
    const j = buildTableDdl('postgres', m, false).statements.join('\n')
    expect(j).toContain('ALTER COLUMN "price" TYPE numeric(10,2)')
    expect(j).toContain('ALTER COLUMN "price" SET NOT NULL')
  })
})
