// ClickHouse Materialized View + Dictionary DDL (T30). Pure → unit-testable.
// Guided-form builders with validation of required fields.

export interface MvSpec {
  db: string
  name: string
  /** target table (TO) — mutually exclusive with engine/populate. */
  to?: string
  /** engine for an implicit target (e.g. "MergeTree() ORDER BY id"). */
  engine?: string
  populate?: boolean
  select: string
}

function ident(db: string, name: string): string {
  return db ? `${db}.${name}` : name
}

/** CREATE MATERIALIZED VIEW … [TO t | ENGINE = e [POPULATE]] AS SELECT …
 *  Throws on missing name/select or TO+ENGINE conflict. */
export function buildCreateMaterializedView(s: MvSpec): string {
  if (!s.name.trim()) throw new Error('Materialized view name is required')
  if (!s.select.trim()) throw new Error('SELECT query is required')
  if (s.to && s.engine) throw new Error('Use either TO <table> or ENGINE, not both')
  let head = `CREATE MATERIALIZED VIEW ${ident(s.db, s.name)}`
  if (s.to) {
    head += ` TO ${s.to}`
  } else if (s.engine) {
    head += ` ENGINE = ${s.engine}`
    if (s.populate) head += ' POPULATE'
  }
  return `${head}\nAS ${s.select.trim().replace(/;\s*$/, '')};`
}

export interface DictColumn {
  name: string
  type: string
}

export type DictLayout = 'FLAT' | 'HASHED' | 'COMPLEX_KEY_HASHED' | 'CACHE' | 'DIRECT'

export interface DictSpec {
  db: string
  name: string
  columns: DictColumn[]
  primaryKey: string
  /** raw SOURCE(...) body, e.g. `HTTP(url 'http://x' format 'JSONEachRow')`. */
  source: string
  layout: DictLayout
  lifetimeMin: number
  lifetimeMax: number
}

/** CREATE DICTIONARY … (cols) PRIMARY KEY … SOURCE(…) LAYOUT(…) LIFETIME(…).
 *  Throws on missing name/columns/primaryKey/source. */
export function buildCreateDictionary(s: DictSpec): string {
  if (!s.name.trim()) throw new Error('Dictionary name is required')
  if (s.columns.length === 0) throw new Error('At least one column is required')
  if (!s.primaryKey.trim()) throw new Error('PRIMARY KEY is required')
  if (!s.source.trim()) throw new Error('SOURCE is required')
  const cols = s.columns.map((c) => `  ${c.name} ${c.type}`).join(',\n')
  const min = Number.isFinite(s.lifetimeMin) ? s.lifetimeMin : 0
  const max = Number.isFinite(s.lifetimeMax) ? s.lifetimeMax : 3600
  return [
    `CREATE DICTIONARY ${ident(s.db, s.name)} (`,
    cols,
    `)`,
    `PRIMARY KEY ${s.primaryKey}`,
    `SOURCE(${s.source.trim()})`,
    `LAYOUT(${s.layout}())`,
    `LIFETIME(MIN ${min} MAX ${max});`,
  ].join('\n')
}
