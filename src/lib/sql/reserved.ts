// Reserved-word aware identifier quoting for autocomplete.
//
// A table/column whose name collides with a SQL keyword (e.g. `order`, `desc`,
// `key`, `group`, `user`) must be quoted or the query fails — most painfully in
// SELECT lists and JOIN conditions. `quoteIfReserved` quotes such names (and any
// name that isn't a plain bare identifier) using the dialect's quote character,
// and leaves ordinary names untouched so completions stay readable.

import { quoteIdent } from './dialect'
import { PostgreSQL, MySQL, MSSQL, SQLite, type SQLDialect } from '@codemirror/lang-sql'

// Core reserved words shared across the SQL dialects we target. Curated toward
// the words people actually name columns/tables (not an exhaustive grammar dump).
const CORE = [
  'add', 'all', 'alter', 'and', 'any', 'as', 'asc', 'begin', 'between', 'by',
  'case', 'cast', 'check', 'collate', 'column', 'commit', 'constraint', 'create',
  'cross', 'current', 'current_date', 'current_time', 'current_timestamp',
  'current_user', 'default', 'delete', 'desc', 'distinct', 'drop', 'else', 'end',
  'except', 'exists', 'false', 'fetch', 'for', 'foreign', 'from', 'full',
  'grant', 'group', 'having', 'in', 'index', 'inner', 'insert', 'intersect',
  'into', 'is', 'join', 'key', 'left', 'like', 'limit', 'not', 'null', 'on',
  'or', 'order', 'outer', 'primary', 'references', 'revoke', 'right', 'rollback',
  'select', 'set', 'table', 'then', 'to', 'true', 'union', 'unique', 'update',
  'user', 'using', 'values', 'when', 'where', 'with',
]

// Dialect-specific additions (words that are reserved in that engine and commonly
// clash with real column/table names).
const BY_SYSTEM: Record<string, string[]> = {
  postgres: [
    'analyse', 'analyze', 'array', 'asymmetric', 'authorization', 'both',
    'collation', 'concurrently', 'current_catalog', 'current_role',
    'current_schema', 'do', 'freeze', 'ilike', 'isnull', 'lateral', 'leading',
    'localtime', 'localtimestamp', 'natural', 'notnull', 'offset', 'only',
    'overlaps', 'placing', 'returning', 'session_user', 'similar', 'some',
    'symmetric', 'tablesample', 'trailing', 'variadic', 'verbose', 'window',
  ],
  mysql: [
    'accessible', 'asensitive', 'auto_increment', 'before', 'binary', 'blob',
    'both', 'call', 'change', 'condition', 'cube', 'cume_dist', 'database',
    'databases', 'day_hour', 'day_minute', 'day_second', 'declare', 'delayed',
    'dense_rank', 'describe', 'distinctrow', 'div', 'dual', 'each', 'elseif',
    'empty', 'enclosed', 'escaped', 'exit', 'explain', 'first_value', 'float',
    'force', 'fulltext', 'function', 'generated', 'get', 'grouping', 'groups',
    'high_priority', 'ignore', 'infile', 'int', 'integer', 'interval', 'iterate',
    'json_table', 'keys', 'kill', 'lag', 'last_value', 'lateral', 'lead',
    'leading', 'leave', 'lines', 'load', 'lock', 'long', 'loop', 'match',
    'mod', 'modifies', 'natural', 'no_write_to_binlog', 'nth_value', 'ntile',
    'of', 'offset', 'optimize', 'option', 'optionally', 'out', 'outfile',
    'over', 'partition', 'percent_rank', 'purge', 'range', 'rank', 'read',
    'reads', 'recursive', 'regexp', 'rename', 'repeat', 'replace', 'require',
    'resignal', 'restrict', 'return', 'rlike', 'row', 'row_number', 'rows',
    'schema', 'schemas', 'sensitive', 'separator', 'signal', 'spatial',
    'specific', 'sql', 'sqlexception', 'sqlstate', 'sqlwarning', 'ssl',
    'starting', 'stored', 'straight_join', 'system', 'terminated', 'trailing',
    'trigger', 'undo', 'unlock', 'unsigned', 'usage', 'utc_date', 'utc_time',
    'utc_timestamp', 'varbinary', 'varchar', 'varying', 'virtual', 'while',
    'window', 'write', 'xor', 'zerofill',
  ],
  mssql: [
    'authorization', 'backup', 'break', 'browse', 'bulk', 'checkpoint',
    'clustered', 'coalesce', 'compute', 'contains', 'containstable', 'continue',
    'convert', 'database', 'dbcc', 'deallocate', 'declare', 'deny', 'disk',
    'distributed', 'double', 'dump', 'errlvl', 'escape', 'exec', 'execute',
    'exit', 'external', 'file', 'fillfactor', 'freetext', 'freetexttable',
    'function', 'goto', 'holdlock', 'identity', 'identity_insert', 'identitycol',
    'if', 'kill', 'lineno', 'load', 'merge', 'national', 'nocheck',
    'nonclustered', 'nullif', 'of', 'off', 'offsets', 'open', 'opendatasource',
    'openquery', 'openrowset', 'openxml', 'option', 'over', 'percent', 'pivot',
    'plan', 'precision', 'print', 'proc', 'procedure', 'public', 'raiserror',
    'read', 'readtext', 'reconfigure', 'replication', 'restore', 'restrict',
    'return', 'rowcount', 'rowguidcol', 'rule', 'save', 'schema',
    'securityaudit', 'semantickeyphrasetable', 'semanticsimilaritydetailstable',
    'semanticsimilaritytable', 'session_user', 'setuser', 'shutdown', 'some',
    'statistics', 'system_user', 'textsize', 'top', 'tran', 'transaction',
    'trigger', 'truncate', 'try_convert', 'tsequal', 'updatetext', 'use',
    'varying', 'view', 'waitfor', 'while', 'writetext',
  ],
  clickhouse: [
    'array', 'attach', 'cluster', 'database', 'detach', 'dictionary', 'final',
    'format', 'global', 'materialized', 'offset', 'optimize', 'partition',
    'prewhere', 'sample', 'settings', 'ttl', 'view',
  ],
  sqlite: [
    'abort', 'action', 'after', 'analyze', 'attach', 'autoincrement', 'before',
    'cascade', 'conflict', 'deferrable', 'deferred', 'detach', 'each', 'escape',
    'exclusive', 'explain', 'fail', 'glob', 'ignore', 'immediate', 'indexed',
    'initially', 'instead', 'isnull', 'natural', 'notnull', 'offset', 'pragma',
    'raise', 'recursive', 'regexp', 'reindex', 'release', 'rename', 'replace',
    'restrict', 'returning', 'savepoint', 'temp', 'temporary', 'transaction',
    'trigger', 'vacuum', 'view', 'virtual', 'without',
  ],
}
BY_SYSTEM.mariadb = BY_SYSTEM.mysql

// Authoritative keyword lists from `@codemirror/lang-sql` (the same lists the
// editor highlights with) — the most complete per-dialect coverage available,
// so an identifier that collides with ANY built-in keyword of that engine
// (e.g. MySQL `schedule`) is quoted on autocomplete insert. ClickHouse/Cassandra
// have no lang-sql dialect here → they fall back to CORE + BY_SYSTEM only.
function langKeywords(dialect: SQLDialect | undefined): string[] {
  const kw = (dialect?.spec?.keywords ?? '') as string
  return kw.toLowerCase().split(/\s+/).filter(Boolean)
}
const LANG_BY_SYSTEM: Record<string, string[]> = {
  postgres: langKeywords(PostgreSQL),
  mysql: langKeywords(MySQL),
  mariadb: langKeywords(MySQL),
  mssql: langKeywords(MSSQL),
  sqlite: langKeywords(SQLite),
}

// Extremely common column identifiers that appear as NON-reserved keywords in
// some dialects' full keyword lists but are perfectly legal unquoted. We never
// auto-quote these — quoting them would only add noise to everyday queries
// (`id`, `name`, `value`, `date`…). None of these are truly reserved in any
// engine we target, so leaving them bare never breaks a statement.
const SAFE = new Set([
  'id', 'name', 'value', 'type', 'status', 'code', 'count', 'level', 'state',
  'comment', 'data', 'date', 'time', 'datetime', 'timestamp', 'text', 'number',
  'description', 'title', 'content', 'label', 'position', 'source', 'target',
  'result', 'action', 'role', 'owner', 'parent', 'path', 'mode', 'size',
  'format', 'priority', 'version', 'language', 'location', 'amount', 'price',
  'total', 'message', 'category', 'tag', 'note', 'notes', 'address', 'phone',
])

const CACHE: Record<string, Set<string>> = {}

function reservedSet(system: string): Set<string> {
  if (!CACHE[system]) {
    const set = new Set([...CORE, ...(BY_SYSTEM[system] ?? []), ...(LANG_BY_SYSTEM[system] ?? [])])
    for (const w of SAFE) set.delete(w)
    CACHE[system] = set
  }
  return CACHE[system]
}

export function isReserved(system: string, name: string): boolean {
  return reservedSet(system).has(name.toLowerCase())
}

// A plain, unquoted-safe identifier: starts with a letter/underscore, followed by
// letters/digits/underscore/$ (the common bare-identifier grammar). Anything else
// (spaces, punctuation, a leading digit) must be quoted regardless of keywords.
const BARE = /^[A-Za-z_][A-Za-z0-9_$]*$/

/** Quote `name` for `system` only when it needs it — a reserved keyword or a
 *  non-bare identifier. Ordinary names are returned unchanged. */
export function quoteIfReserved(system: string, name: string): string {
  if (!BARE.test(name) || isReserved(system, name)) return quoteIdent(system, name)
  return name
}
