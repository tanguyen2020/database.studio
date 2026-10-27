import { describe, expect, it } from 'vitest'
import { generateScript, indexesByTable, orderObjects, type DbObject } from './scripts'

// parent ← child (FK) ; view v depends on child
const parent: DbObject = { name: 'parent', kind: 'table', createSql: 'CREATE TABLE parent (...);', deps: [] }
const child: DbObject = {
  name: 'child',
  kind: 'table',
  createSql: 'CREATE TABLE child (...);',
  deps: ['parent'],
  fkAlters: ['ALTER TABLE child ADD CONSTRAINT fk FOREIGN KEY (pid) REFERENCES parent(id);'],
  dataSql: 'INSERT INTO child VALUES (1);',
}
const view: DbObject = { name: 'v', kind: 'view', createSql: 'CREATE VIEW v AS SELECT * FROM child;', deps: ['child'] }

describe('orderObjects', () => {
  it('child after parent, view after its base — regardless of input order', () => {
    const ordered = orderObjects([view, child, parent]).map((o) => o.name)
    expect(ordered.indexOf('parent')).toBeLessThan(ordered.indexOf('child'))
    expect(ordered.indexOf('child')).toBeLessThan(ordered.indexOf('v'))
  })

  it('cycle-safe (mutual deps do not loop forever)', () => {
    const a: DbObject = { name: 'a', kind: 'table', createSql: 'A', deps: ['b'] }
    const b: DbObject = { name: 'b', kind: 'table', createSql: 'B', deps: ['a'] }
    const ordered = orderObjects([a, b]).map((o) => o.name)
    expect(ordered.sort()).toEqual(['a', 'b'])
  })

  it('deps outside the set are ignored', () => {
    const x: DbObject = { name: 'x', kind: 'table', createSql: 'X', deps: ['nonexistent'] }
    expect(orderObjects([x]).map((o) => o.name)).toEqual(['x'])
  })
})

describe('generateScript', () => {
  it('structure: CREATEs in dep order, FK ALTERs LAST, no INSERTs', () => {
    const sql = generateScript([view, child, parent], 'structure')
    const iParent = sql.indexOf('CREATE TABLE parent')
    const iChild = sql.indexOf('CREATE TABLE child')
    const iView = sql.indexOf('CREATE VIEW v')
    const iFk = sql.indexOf('ADD CONSTRAINT fk')
    expect(iParent).toBeGreaterThanOrEqual(0)
    expect(iParent).toBeLessThan(iChild)
    expect(iChild).toBeLessThan(iView)
    expect(iView).toBeLessThan(iFk) // FK after all CREATEs (incl. the view)
    expect(sql).not.toContain('INSERT INTO')
  })

  it('data: only INSERTs (no CREATE)', () => {
    const sql = generateScript([child, parent], 'data')
    expect(sql).toContain('INSERT INTO child')
    expect(sql).not.toContain('CREATE TABLE')
    expect(sql).not.toContain('ADD CONSTRAINT')
  })

  it('both: structure then data', () => {
    const sql = generateScript([child, parent], 'both')
    expect(sql.indexOf('CREATE TABLE parent')).toBeLessThan(sql.indexOf('ADD CONSTRAINT fk'))
    expect(sql.indexOf('ADD CONSTRAINT fk')).toBeLessThan(sql.indexOf('INSERT INTO child'))
  })

  it('indexes come after every CREATE and before the foreign keys (structure + both, not data)', () => {
    const withIx: DbObject = { ...child, indexSql: ['CREATE INDEX ix_pid ON child (pid);'] }
    const sql = generateScript([withIx, parent, view], 'structure')
    const iIx = sql.indexOf('CREATE INDEX ix_pid')
    expect(iIx).toBeGreaterThan(sql.indexOf('CREATE VIEW v'))
    expect(iIx).toBeLessThan(sql.indexOf('ADD CONSTRAINT fk'))
    expect(generateScript([withIx, parent], 'both')).toContain('CREATE INDEX ix_pid')
    expect(generateScript([withIx, parent], 'data')).not.toContain('CREATE INDEX')
  })

  it('empty input → empty string', () => {
    expect(generateScript([], 'both')).toBe('')
  })
})

describe('indexesByTable', () => {
  it('splits a schema into CREATE TABLE clauses and statements per table, losing none', () => {
    const map = indexesByTable([
      { table: 'a', name: 'a_pk', role: 'primary', ddl: 'CONSTRAINT a_pk PRIMARY KEY (id)', columns: ['id'] },
      { table: 'a', name: 'a_u', role: 'constraint', ddl: 'CONSTRAINT a_u UNIQUE (code)', columns: ['code'] },
      { table: 'a', name: 'a_ix', role: 'index', ddl: 'CREATE INDEX a_ix ON s.a (x)', columns: ['x'] },
      { table: 'a', name: 'a_ix2', role: 'index', ddl: 'CREATE INDEX a_ix2 ON s.a (y);', columns: ['y'] },
      { table: 'b', name: 'hx', role: 'note', ddl: '-- Index [hx] … is not scripted.', columns: [] },
    ])
    expect(map.get('a')).toEqual({
      primaryKey: 'CONSTRAINT a_pk PRIMARY KEY (id)',
      clauses: ['CONSTRAINT a_u UNIQUE (code)'],
      statements: ['CREATE INDEX a_ix ON s.a (x);', 'CREATE INDEX a_ix2 ON s.a (y);'],
    })
    expect(map.get('b')?.statements).toEqual(['-- Index [hx] … is not scripted.'])
  })
})
