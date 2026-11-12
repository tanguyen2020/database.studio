import { describe, expect, it } from 'vitest'
import {
  buildDataSync,
  canon,
  classifyRows,
  duplicateKeys,
  keyedSelect,
  makeKeyed,
  type Row,
} from './data-diff'

const keyed = (rows: Row[], keyCols: string[], cmpCols: string[]) => makeKeyed(rows, keyCols, cmpCols)

describe('classifyRows', () => {
  it('splits into onlySrc / onlyTgt / different / same', () => {
    const cmp = ['name', 'score']
    const src = keyed(
      [
        { id: 1, name: 'A', score: 10 }, // same
        { id: 2, name: 'B', score: 20 }, // different (score)
        { id: 3, name: 'C', score: 30 }, // only in source
      ],
      ['id'],
      cmp,
    )
    const tgt = keyed(
      [
        { id: 1, name: 'A', score: 10 },
        { id: 2, name: 'B', score: 25 },
        { id: 4, name: 'D', score: 40 }, // only in target
      ],
      ['id'],
      cmp,
    )
    const d = classifyRows(src, tgt, cmp)
    expect(d.same).toBe(1)
    expect(d.onlySrc.map((r) => r.row.id)).toEqual([3])
    expect(d.onlyTgt.map((r) => r.row.id)).toEqual([4])
    expect(d.different).toHaveLength(1)
    expect(d.different[0].key).toBe(src[1].key)
    expect(d.different[0].cells).toEqual([{ col: 'score', src: 20, tgt: 25 }])
  })

  it('works regardless of input order (sorts by key)', () => {
    const cmp = ['v']
    const src = keyed([{ id: 3, v: 'c' }, { id: 1, v: 'a' }], ['id'], cmp)
    const tgt = keyed([{ id: 1, v: 'a' }, { id: 2, v: 'b' }], ['id'], cmp)
    const d = classifyRows(src, tgt, cmp)
    expect(d.same).toBe(1)
    expect(d.onlySrc.map((r) => r.row.id)).toEqual([3])
    expect(d.onlyTgt.map((r) => r.row.id)).toEqual([2])
  })

  it('matches on a composite key', () => {
    const cmp = ['qty']
    const src = keyed(
      [
        { a: 1, b: 'x', qty: 5 },
        { a: 1, b: 'y', qty: 6 },
      ],
      ['a', 'b'],
      cmp,
    )
    const tgt = keyed(
      [
        { a: 1, b: 'x', qty: 5 },
        { a: 1, b: 'y', qty: 9 },
      ],
      ['a', 'b'],
      cmp,
    )
    const d = classifyRows(src, tgt, cmp)
    expect(d.same).toBe(1)
    expect(d.different).toHaveLength(1)
    expect(d.different[0].cells).toEqual([{ col: 'qty', src: 6, tgt: 9 }])
  })

  it('treats NULL in a key as its own identity, distinct from empty string', () => {
    const cmp = ['v']
    const src = keyed([{ id: null, v: 'a' }, { id: '', v: 'b' }], ['id'], cmp)
    const tgt = keyed([{ id: null, v: 'a' }], ['id'], cmp)
    const d = classifyRows(src, tgt, cmp)
    expect(d.same).toBe(1) // the NULL-keyed row matches
    expect(d.onlySrc.map((r) => r.row.v)).toEqual(['b']) // the ''-keyed row is source-only
  })

  it('NULL vs empty string in a compared column counts as different', () => {
    const cmp = ['note']
    const src = keyed([{ id: 1, note: null }], ['id'], cmp)
    const tgt = keyed([{ id: 1, note: '' }], ['id'], cmp)
    const d = classifyRows(src, tgt, cmp)
    expect(d.same).toBe(0)
    expect(d.different[0].cells).toEqual([{ col: 'note', src: null, tgt: '' }])
  })

  it('compares json/object columns structurally', () => {
    const cmp = ['meta']
    const src = keyed([{ id: 1, meta: { a: 1, b: 2 } }], ['id'], cmp)
    const tgt = keyed([{ id: 1, meta: { a: 1, b: 2 } }], ['id'], cmp)
    expect(classifyRows(src, tgt, cmp).same).toBe(1)
  })
})

describe('duplicateKeys', () => {
  it('flags repeated keys (ambiguous identity)', () => {
    const rows = keyed([{ id: 1, v: 'a' }, { id: 1, v: 'b' }, { id: 2, v: 'c' }], ['id'], ['v'])
    expect(duplicateKeys(rows)).toEqual([rows[0].key])
  })
  it('returns nothing for unique keys', () => {
    const rows = keyed([{ id: 1 }, { id: 2 }], ['id'], [])
    expect(duplicateKeys(rows)).toEqual([])
  })
})

describe('keyedSelect', () => {
  it('selects key + compared columns, ordered by key, with a WHERE', () => {
    const sql = keyedSelect('postgres', 'public', 'students', ['id'], ['name', 'score'], 'score > 0')
    expect(sql).toBe('SELECT "id", "name", "score" FROM "public"."students" WHERE score > 0 ORDER BY "id"')
  })
  it('does not list a key column twice when it is also compared', () => {
    const sql = keyedSelect('mysql', '', 'orders', ['id'], ['id', 'total'], '')
    expect(sql).toBe('SELECT `id`, `total` FROM `orders` ORDER BY `id`')
  })
})

describe('buildDataSync', () => {
  const base = () => {
    const cmp = ['name', 'score']
    const src = keyed(
      [
        { id: 2, name: 'B', score: 20 },
        { id: 3, name: 'C', score: 30 },
      ],
      ['id'],
      cmp,
    )
    const tgt = keyed(
      [
        { id: 2, name: 'B', score: 25 },
        { id: 4, name: 'D', score: 40 },
      ],
      ['id'],
      cmp,
    )
    return { diff: classifyRows(src, tgt, cmp), opts: { system: 'postgres', schema: 'public', table: 't', keyCols: ['id'], cmpCols: cmp } }
  }

  it('emits INSERT, UPDATE and DELETE by key', () => {
    const { diff, opts } = base()
    const sql = buildDataSync(diff, opts, { insert: true, update: true, del: true })
    expect(sql).toContain('INSERT INTO "public"."t" ("id", "name", "score") VALUES (3, \'C\', 30);')
    expect(sql).toContain('UPDATE "public"."t" SET "name" = \'B\', "score" = 20 WHERE "id" = 2;')
    expect(sql).toContain('DELETE FROM "public"."t" WHERE "id" = 4;')
  })

  it('omits a bucket when its flag is off', () => {
    const { diff, opts } = base()
    const sql = buildDataSync(diff, opts, { insert: true, update: true, del: false })
    expect(sql).toContain('INSERT INTO')
    expect(sql).toContain('UPDATE')
    expect(sql).not.toContain('DELETE')
  })

  it('writes IS NULL in the key predicate when a key value is NULL', () => {
    const cmp = ['v']
    const src = keyed([], ['id'], cmp)
    const tgt = keyed([{ id: null, v: 'x' }], ['id'], cmp)
    const diff = classifyRows(src, tgt, cmp)
    const sql = buildDataSync(diff, { system: 'postgres', schema: '', table: 't', keyCols: ['id'], cmpCols: cmp }, { insert: false, update: false, del: true })
    expect(sql).toContain('DELETE FROM "t" WHERE "id" IS NULL;')
  })

  it('UPDATE sets only non-key compared columns', () => {
    const cmp = ['id', 'total'] // id is both key and (accidentally) compared
    const src = keyed([{ id: 1, total: 100 }], ['id'], cmp)
    const tgt = keyed([{ id: 1, total: 90 }], ['id'], cmp)
    const diff = classifyRows(src, tgt, cmp)
    const sql = buildDataSync(diff, { system: 'postgres', schema: '', table: 't', keyCols: ['id'], cmpCols: cmp }, { insert: false, update: true, del: false })
    expect(sql).toContain('UPDATE "t" SET "total" = 100 WHERE "id" = 1;')
    expect(sql).not.toContain('"id" = 1,') // id not in SET
  })
})

describe('canon', () => {
  it('distinguishes null, empty string and 0', () => {
    expect(new Set([canon(null), canon(''), canon(0)]).size).toBe(3)
  })
})
