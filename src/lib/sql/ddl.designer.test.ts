import { describe, expect, it } from 'vitest'
import { designerDdl, designerTypes, type DesignerCol } from './ddl'

const col = (o: Partial<DesignerCol>): DesignerCol => ({
  name: 'c',
  type: 'int4',
  len: '',
  pk: false,
  nullable: true,
  dflt: '',
  ...o,
})

describe('designerDdl', () => {
  it('postgres: PK, NOT NULL, length, default', () => {
    const ddl = designerDdl('postgres', 'public', 'users', [
      col({ name: 'id', type: 'int4', pk: true, nullable: false }),
      col({ name: 'email', type: 'varchar', len: '255', nullable: false }),
      col({ name: 'created', type: 'timestamptz', dflt: 'now()' }),
    ])
    expect(ddl).toContain('CREATE TABLE "public"."users"')
    expect(ddl).toContain('"id" int4 PRIMARY KEY')
    expect(ddl).toContain('"email" varchar(255) NOT NULL')
    expect(ddl).toContain('"created" timestamptz DEFAULT now()')
    expect(ddl.endsWith(';')).toBe(true)
  })

  it('mysql: backtick quoting, no schema prefix wart', () => {
    const ddl = designerDdl('mysql', '', 'orders', [col({ name: 'id', type: 'int', pk: true, nullable: false })])
    expect(ddl).toContain('CREATE TABLE `orders`')
    expect(ddl).toContain('`id` int PRIMARY KEY')
  })

  it('clickhouse: appends ENGINE = MergeTree ORDER BY pk', () => {
    const ddl = designerDdl('clickhouse', '', 'events', [
      col({ name: 'id', type: 'UInt32', pk: true, nullable: false }),
      col({ name: 'ts', type: 'DateTime' }),
    ])
    expect(ddl).toContain('ENGINE = MergeTree')
    expect(ddl).toContain('ORDER BY (`id`)')
  })

  it('designerTypes varies by dialect', () => {
    expect(designerTypes('postgres')).toContain('jsonb')
    expect(designerTypes('mysql')).toContain('bigint')
    expect(designerTypes('sqlite')).toContain('INTEGER')
    expect(designerTypes('clickhouse')).toContain('String')
  })
})
