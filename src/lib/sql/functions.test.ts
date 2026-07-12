import { describe, expect, it } from 'vitest'
import { functionSignatures, functionCatalog } from './functions'
import { staticFunctions } from './functions.catalog'

describe('functionSignatures', () => {
  it('includes common aggregates for every dialect', () => {
    for (const sys of ['postgres', 'mysql', 'sqlite', 'clickhouse']) {
      const names = functionSignatures(sys).map((f) => f.name)
      expect(names).toContain('count')
      expect(names).toContain('coalesce')
    }
  })
  it('per-dialect specifics', () => {
    expect(functionSignatures('postgres').map((f) => f.name)).toContain('generate_series')
    expect(functionSignatures('mysql').map((f) => f.name)).toContain('group_concat')
    expect(functionSignatures('mssql').map((f) => f.name)).toContain('isnull')
    expect(functionSignatures('clickhouse').map((f) => f.name)).toContain('uniqExact')
  })
  it('every entry carries a signature string', () => {
    for (const f of functionSignatures('postgres')) {
      expect(f.signature).toContain('(')
    }
  })
  it('unknown system → common only', () => {
    expect(functionSignatures('redis').every((f) => f.detail !== undefined)).toBe(true)
    expect(functionSignatures('redis').length).toBeGreaterThan(0)
  })
})

describe('staticFunctions (built-in catalogs)', () => {
  it('MySQL / MariaDB / MSSQL ship comprehensive built-in lists', () => {
    expect(staticFunctions('mysql').length).toBeGreaterThan(150)
    expect(staticFunctions('mariadb').length).toBeGreaterThan(staticFunctions('mysql').length)
    expect(staticFunctions('mssql').length).toBeGreaterThan(120)
  })
  it('names are unique per engine and carry a detail category', () => {
    for (const sys of ['mysql', 'mariadb', 'mssql']) {
      const list = staticFunctions(sys)
      expect(new Set(list.map((f) => f.name)).size).toBe(list.length)
      expect(list.every((f) => f.detail && f.signature)).toBe(true)
    }
  })
  it('covers functions the curated set + lang-sql keywords miss', () => {
    // These were shown missing in the review (no signature + not in lang-sql keywords).
    const my = staticFunctions('mysql').map((f) => f.name)
    for (const f of ['json_extract', 'date_format', 'str_to_date', 'lpad', 'regexp_replace', 'row_number'])
      expect(my).toContain(f)
    const ms = staticFunctions('mssql').map((f) => f.name)
    for (const f of ['len', 'getdate', 'charindex', 'datediff', 'string_agg', 'iif'])
      expect(ms).toContain(f)
    // MariaDB-only extras on top of MySQL
    expect(staticFunctions('mariadb').map((f) => f.name)).toContain('to_char')
  })
  it('PG/SQLite/ClickHouse have NO static set (live introspection covers them)', () => {
    expect(staticFunctions('postgres')).toEqual([])
    expect(staticFunctions('sqlite')).toEqual([])
    expect(staticFunctions('clickhouse')).toEqual([])
  })
})

describe('functionCatalog (merge)', () => {
  it('merges static built-ins + curated for MySQL, deduped case-insensitively', () => {
    const names = functionCatalog('mysql').map((f) => f.name)
    expect(names).toContain('count') // curated/common
    expect(names).toContain('json_extract') // static built-in
    expect(names).toContain('group_concat')
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length)
  })
  it('curated signature beats the static placeholder', () => {
    // static ships group_concat with a "…" placeholder; curated has the real args.
    const gc = functionCatalog('mysql').find((f) => f.name === 'group_concat')!
    expect(gc.signature).toContain('SEPARATOR')
  })
  it('merges dynamic (introspected) functions and upgrades bare names with real signatures', () => {
    const dyn = [
      { name: 'to_char', signature: 'to_char(timestamp, text)', detail: 'function' },
      { name: 'my_udf', signature: 'my_udf()', detail: 'user' },
    ]
    const cat = functionCatalog('postgres', dyn)
    const names = cat.map((f) => f.name)
    expect(names).toContain('to_char') // came from dynamic (not in curated/static)
    expect(names).toContain('my_udf')
    expect(cat.find((f) => f.name === 'to_char')!.signature).toBe('to_char(timestamp, text)')
  })
  it('is sorted and never empty for a relational engine', () => {
    const cat = functionCatalog('mssql')
    const names = cat.map((f) => f.name)
    expect(names.length).toBeGreaterThan(120)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
  })
})
