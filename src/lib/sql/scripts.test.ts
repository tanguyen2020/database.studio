import { describe, expect, it } from 'vitest'
import { generateScript, orderObjects, type DbObject } from './scripts'

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

  it('empty input → empty string', () => {
    expect(generateScript([], 'both')).toBe('')
  })
})
