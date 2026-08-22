// New Database → character set / collation options. Pure → unit-testable.
//
// SCOPE: this module only feeds the "New Database" dialog. Every value offered in
// the UI is READ FROM THE SERVER (catalog/query below) — nothing is hard-coded, so
// the lists always match the engine and version actually connected.
//
// Per engine, what `CREATE DATABASE` accepts:
//   • MySQL / MariaDB → CHARACTER SET + COLLATE           (bare identifiers)
//   • MSSQL           → COLLATE                            (bare identifier)
//   • PostgreSQL      → ENCODING + LC_COLLATE + LC_CTYPE   (quoted strings; needs
//                       TEMPLATE template0 when they differ from the default
//                       template, so we always emit it once an option is set)
//   • ClickHouse      → no charset/collation at database level
//   • Oracle          → a "database" is a user/schema; the character set is
//                       instance-wide (NLS_CHARACTERSET) → read-only info
//   • SQLite / Mongo / streaming → not applicable
//
// Leaving every field on "server default" emits the plain `CREATE DATABASE <name>;`
// exactly as before, so the existing behaviour is untouched.

/** What the New Database dialog can offer for this engine. */
export type DbOptionKind = 'charset-collation' | 'collation' | 'encoding-locale' | 'server-charset' | 'none'

export function databaseOptionKind(system: string): DbOptionKind {
  switch (system) {
    case 'mysql':
    case 'mariadb':
      return 'charset-collation'
    case 'mssql':
      return 'collation'
    case 'postgres':
      return 'encoding-locale'
    case 'oracle':
      // instance-wide character set — shown read-only, not settable per user/schema
      return 'server-charset'
    default:
      return 'none'
  }
}

/** Options chosen in the dialog. Every field optional → unset means "server default". */
export interface DatabaseOptions {
  /** MySQL/MariaDB CHARACTER SET */
  charset?: string
  /** MySQL/MariaDB + MSSQL COLLATE */
  collation?: string
  /** PostgreSQL ENCODING */
  encoding?: string
  /** PostgreSQL LC_COLLATE */
  lcCollate?: string
  /** PostgreSQL LC_CTYPE */
  lcCtype?: string
}

/** Bare identifiers we are willing to splice into DDL unquoted (charset/collation
 *  names from the server catalogs are all of this shape). Anything else is dropped
 *  rather than emitted, so a hostile value can never reach the statement. */
const BARE = /^[A-Za-z0-9_]+$/
/** PostgreSQL encodings/locales go inside single quotes; allow the punctuation real
 *  locale names use (en_US.utf8, en-US-x-icu, C.UTF-8) and nothing else. */
const QUOTED = /^[A-Za-z0-9_.\-@]+$/

function bare(v: string | undefined): string | null {
  const s = (v ?? '').trim()
  return s && BARE.test(s) ? s : null
}
function quoted(v: string | undefined): string | null {
  const s = (v ?? '').trim()
  return s && QUOTED.test(s) ? `'${s}'` : null
}

/** The clause appended to CREATE DATABASE for this engine, or '' for none. */
export function databaseOptionClause(system: string, opts: DatabaseOptions | undefined): string {
  if (!opts) return ''
  switch (databaseOptionKind(system)) {
    case 'charset-collation': {
      const cs = bare(opts.charset)
      const co = bare(opts.collation)
      const parts: string[] = []
      if (cs) parts.push(`CHARACTER SET ${cs}`)
      if (co) parts.push(`COLLATE ${co}`)
      return parts.length ? ` ${parts.join(' ')}` : ''
    }
    case 'collation': {
      const co = bare(opts.collation)
      return co ? ` COLLATE ${co}` : ''
    }
    case 'encoding-locale': {
      const enc = quoted(opts.encoding)
      const coll = quoted(opts.lcCollate)
      const ctype = quoted(opts.lcCtype)
      if (!enc && !coll && !ctype) return ''
      // template1 may already carry a different encoding/locale; only template0
      // accepts new ones, so it is mandatory as soon as anything is set.
      const parts = ['TEMPLATE template0']
      if (enc) parts.push(`ENCODING ${enc}`)
      if (coll) parts.push(`LC_COLLATE ${coll}`)
      if (ctype) parts.push(`LC_CTYPE ${ctype}`)
      return `\n  ${parts.join('\n  ')}`
    }
    default:
      return ''
  }
}

// ── Server queries ────────────────────────────────────────────────────────────
// Read-only. MySQL 8 types information_schema string columns as the *binary*
// charset, which the generic exec path hex-encodes → CAST(... AS CHAR) forces a
// text column (same precedent as sql/collation.ts).

/** MySQL/MariaDB: every character set the server supports + its default collation. */
export function buildCharsetsQuery(): string {
  return `SELECT CAST(CHARACTER_SET_NAME AS CHAR) AS name, CAST(DEFAULT_COLLATE_NAME AS CHAR) AS default_collation
FROM information_schema.CHARACTER_SETS
ORDER BY CHARACTER_SET_NAME`
}

/** MySQL/MariaDB: every collation the server supports (charset kept for filtering). */
export function buildAllCollationsQuery(): string {
  return `SELECT CAST(COLLATION_NAME AS CHAR) AS name, CAST(CHARACTER_SET_NAME AS CHAR) AS charset, IS_DEFAULT AS is_default
FROM information_schema.COLLATIONS
ORDER BY CHARACTER_SET_NAME, COLLATION_NAME`
}

/** MySQL/MariaDB: the SERVER default charset+collation — what a bare
 *  CREATE DATABASE would use (character_set_server / collation_server). */
export function buildServerCharsetQuery(): string {
  return `SELECT CAST(@@character_set_server AS CHAR) AS charset, CAST(@@collation_server AS CHAR) AS collation`
}

/** MSSQL: collations this instance supports. */
export function buildMssqlCollationsQuery(): string {
  return `SELECT name FROM sys.fn_helpcollations() ORDER BY name`
}

/** MSSQL: the instance default collation — what a bare CREATE DATABASE inherits. */
export function buildMssqlServerCollationQuery(): string {
  return `SELECT CONVERT(nvarchar(128), SERVERPROPERTY('Collation')) AS collation`
}

/** PostgreSQL: the encodings this server build knows (names come from the server's
 *  own pg_encoding_to_char, so the list can never drift from the binary). */
export function buildPgEncodingsQuery(): string {
  return `SELECT pg_encoding_to_char(i) AS name
FROM generate_series(0, 50) AS i
WHERE pg_encoding_to_char(i) <> ''
ORDER BY 1`
}

/** PostgreSQL: locale names the server actually knows — the collations installed at
 *  initdb time (libc) plus the locales existing databases were created with. */
export function buildPgLocalesQuery(): string {
  return `SELECT locale FROM (
  SELECT DISTINCT collcollate AS locale FROM pg_collation WHERE collcollate IS NOT NULL AND collcollate <> ''
  UNION SELECT DISTINCT collctype FROM pg_collation WHERE collctype IS NOT NULL AND collctype <> ''
  UNION SELECT DISTINCT datcollate FROM pg_database
  UNION SELECT DISTINCT datctype FROM pg_database
) t
ORDER BY locale`
}

/** PostgreSQL fallback: pg_database only — every server version has these columns,
 *  used when the pg_collation query is rejected (column dropped/renamed). */
export function buildPgLocalesFallbackQuery(): string {
  return `SELECT locale FROM (
  SELECT DISTINCT datcollate AS locale FROM pg_database
  UNION SELECT DISTINCT datctype FROM pg_database
) t
ORDER BY locale`
}

/** PostgreSQL: template1's settings — exactly what a bare CREATE DATABASE copies. */
export function buildPgDefaultsQuery(): string {
  return `SELECT pg_encoding_to_char(encoding) AS encoding, datcollate AS lc_collate, datctype AS lc_ctype
FROM pg_database
WHERE datname = 'template1'`
}

/** Oracle: instance character sets (read-only info; not settable per schema). */
export function buildOracleCharsetQuery(): string {
  return `SELECT parameter, value FROM nls_database_parameters
WHERE parameter IN ('NLS_CHARACTERSET', 'NLS_NCHAR_CHARACTERSET')
ORDER BY parameter`
}

// ── Row parsing ───────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

/** Distinct, non-empty, order-preserving list of one column across rows. */
export function pluck(rows: Row[], col: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const v = str(r[col]).trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

export interface CharsetInfo {
  name: string
  defaultCollation: string
}

export function parseCharsets(rows: Row[]): CharsetInfo[] {
  const out: CharsetInfo[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const name = str(r.name).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, defaultCollation: str(r.default_collation).trim() })
  }
  return out
}

export interface CollationInfo {
  name: string
  charset: string
}

export function parseCollations(rows: Row[]): CollationInfo[] {
  const out: CollationInfo[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const name = str(r.name).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, charset: str(r.charset).trim() })
  }
  return out
}

/** Collations belonging to a charset (empty charset → the whole list). */
export function collationsFor(all: CollationInfo[], charset: string): string[] {
  const cs = charset.trim()
  return all.filter((c) => !cs || !c.charset || c.charset === cs).map((c) => c.name)
}

export interface ServerDefaults {
  charset?: string
  collation?: string
  encoding?: string
  lcCollate?: string
  lcCtype?: string
}

/** First row of a defaults query → the fields it carries (missing ones stay unset). */
export function parseServerDefaults(rows: Row[]): ServerDefaults {
  const r = rows[0]
  if (!r) return {}
  const out: ServerDefaults = {}
  const pick = (k: string) => {
    const v = str(r[k]).trim()
    return v || undefined
  }
  out.charset = pick('charset')
  out.collation = pick('collation')
  out.encoding = pick('encoding')
  out.lcCollate = pick('lc_collate')
  out.lcCtype = pick('lc_ctype')
  return out
}

/** Oracle parameter/value rows → "NLS_CHARACTERSET AL32UTF8 · NLS_NCHAR… AL16UTF16". */
export function formatOracleCharset(rows: Row[]): string {
  return rows
    .map((r) => `${str(r.parameter).trim()} ${str(r.value).trim()}`.trim())
    .filter(Boolean)
    .join(' · ')
}

/** Human label for the "no explicit option" choice, e.g. "Server default (utf8mb4)". */
export function serverDefaultLabel(value: string | undefined): string {
  return value ? `Server default (${value})` : 'Server default'
}
