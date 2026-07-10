import { describe, expect, it } from 'vitest'
import { CH_KEYWORDS, CH_TYPES, CH_FUNCTIONS, clickHouseDialect } from './ch-editor-dialect'

// The ClickHouse editor dialect must cover ClickHouse-specific keywords/types/
// functions so the editor highlights + keyword-suggests them (StandardSQL didn't).

describe('ClickHouse editor dialect', () => {
  const kw = new Set(CH_KEYWORDS.split(/\s+/))
  const ty = new Set(CH_TYPES.split(/\s+/))
  const fn = new Set(CH_FUNCTIONS.split(/\s+/))

  it('keywords include common SQL + ClickHouse-specific clauses', () => {
    for (const k of ['select', 'from', 'where', 'engine', 'settings', 'prewhere', 'final', 'ttl', 'materialized', 'dictionary', 'partition']) {
      expect(kw.has(k), `keyword ${k}`).toBe(true)
    }
  })

  it('types include ClickHouse data types (lowercased for case-insensitive match)', () => {
    for (const t of ['int64', 'uint64', 'float64', 'lowcardinality', 'nullable', 'datetime64', 'array', 'map', 'uuid', 'decimal256']) {
      expect(ty.has(t), `type ${t}`).toBe(true)
    }
  })

  it('functions include common ClickHouse builtins', () => {
    for (const f of ['toyyyymm', 'formatreadablesize', 'arrayjoin', 'uniqexact', 'todatetime64']) {
      expect(fn.has(f), `function ${f}`).toBe(true)
    }
  })

  it('exports a defined SQLDialect', () => {
    expect(clickHouseDialect).toBeTruthy()
    expect(typeof clickHouseDialect.language).toBe('object')
  })
})
