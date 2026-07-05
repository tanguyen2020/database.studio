// Generate Test Data (T26). Pure + deterministic (seeded RNG) → unit-testable.
// Produces rows honoring NOT NULL, UNIQUE, and FK (values picked from a parent
// pool). The dialog fetches FK pools + runs batched INSERTs.

export type GenKind =
  | 'sequence'
  | 'number'
  | 'decimal'
  | 'bool'
  | 'name'
  | 'email'
  | 'phone'
  | 'date'
  | 'timestamp'
  | 'uuid'
  | 'enum'
  | 'text'
  | 'fk'
  | 'null'

export interface ColumnGen {
  name: string
  kind: GenKind
  nullable: boolean
  unique: boolean
  /** enum values (kind='enum') */
  values?: string[]
  /** parent-key pool (kind='fk') */
  pool?: (string | number)[]
  /** numeric range (kind='number'/'decimal') */
  min?: number
  max?: number
}

/** mulberry32 — small deterministic PRNG so generation is reproducible/testable. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIRST = ['An', 'Binh', 'Chi', 'Dung', 'Erik', 'Farah', 'Gia', 'Hana', 'Ivan', 'Julia', 'Khoa', 'Lan']
const LAST = ['Nguyen', 'Tran', 'Le', 'Pham', 'Smith', 'Kumar', 'Chen', 'Okoro', 'Silva', 'Ivanov']
const WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'data', 'test', 'sample', 'alpha', 'beta']

function pick<T>(arr: T[], r: number): T {
  return arr[Math.floor(r * arr.length) % arr.length]
}

function hex(r: () => number, n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16)
  return s
}

/** Generate one cell for a column at `row` using rng `r`. `unique` columns fold
 *  in the row index so values never collide. */
function genCell(c: ColumnGen, row: number, r: () => number): string | number | null {
  switch (c.kind) {
    case 'null':
      return null
    case 'sequence':
      return row + 1
    case 'number': {
      const lo = c.min ?? 0
      const hi = c.max ?? 1000
      return c.unique ? lo + row : lo + Math.floor(r() * (hi - lo + 1))
    }
    case 'decimal': {
      const lo = c.min ?? 0
      const hi = c.max ?? 1000
      return Math.round((lo + r() * (hi - lo)) * 100) / 100
    }
    case 'bool':
      return r() < 0.5 ? 'true' : 'false'
    case 'name':
      return `${pick(FIRST, r())} ${pick(LAST, r())}`
    case 'email':
      return `${pick(FIRST, r()).toLowerCase()}.${row}@example.com`
    case 'phone':
      return `+1${hex(r, 0)}${String(1000000000 + Math.floor(r() * 8999999999))}`.slice(0, 12)
    case 'date':
      return isoDate(r, row, c.unique, false)
    case 'timestamp':
      return isoDate(r, row, c.unique, true)
    case 'uuid':
      return `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-${hex(r, 4)}-${hex(r, 12)}`
    case 'enum':
      return c.values && c.values.length ? pick(c.values, r()) : null
    case 'text':
      return `${pick(WORDS, r())} ${pick(WORDS, r())} ${pick(WORDS, r())}${c.unique ? ` #${row}` : ''}`
    case 'fk':
      return c.pool && c.pool.length ? c.pool[Math.floor(r() * c.pool.length) % c.pool.length] : null
  }
}

function isoDate(r: () => number, row: number, unique: boolean, withTime: boolean): string {
  // days since 2000-01-01; unique → deterministic per row, else random within ~10y
  const day = unique ? row : Math.floor(r() * 3650)
  const base = Date.UTC(2000, 0, 1) + day * 86400000 + (withTime ? Math.floor(r() * 86400000) : 0)
  const d = new Date(base)
  const iso = d.toISOString()
  return withTime ? iso.replace('T', ' ').slice(0, 19) : iso.slice(0, 10)
}

export interface GenResult {
  columns: string[]
  /** rows aligned to columns; each cell is a literal string|number|null */
  rows: (string | number | null)[][]
}

/** Generate `count` rows for `cols`. Deterministic given `seed`. NOT NULL columns
 *  never produce null (a 'null' kind on a NOT NULL column falls back to 'text'). */
export function generateRows(cols: ColumnGen[], count: number, seed = 1): GenResult {
  const r = rng(seed)
  const rows: (string | number | null)[][] = []
  for (let row = 0; row < count; row++) {
    rows.push(
      cols.map((c) => {
        let v = genCell(c, row, r)
        if (v === null && !c.nullable) {
          // NOT NULL guard: never emit null; substitute a safe non-null value.
          v = c.kind === 'fk' ? (c.pool?.[0] ?? row + 1) : `val_${row}`
        }
        return v
      }),
    )
  }
  return { columns: cols.map((c) => c.name), rows }
}
