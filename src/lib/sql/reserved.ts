// Reserved-word aware identifier quoting for autocomplete.
//
// A table/column whose name collides with a SQL keyword (e.g. `order`, `desc`,
// `key`, `group`, `user`) must be quoted or the query fails — most painfully in
// SELECT lists and JOIN conditions. `quoteIfReserved` quotes such names (and any
// name that isn't a plain bare identifier) using the dialect's quote character,
// and leaves ordinary names untouched so completions stay readable.

import { quoteIdent } from './dialect'

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
    'concurrently', 'do', 'freeze', 'ilike', 'isnull', 'lateral', 'leading',
    'natural', 'notnull', 'offset', 'only', 'overlaps', 'placing', 'returning',
    'similar', 'symmetric', 'tablesample', 'trailing', 'variadic', 'verbose',
    'window',
  ],
  mysql: [
    'accessible', 'auto_increment', 'binary', 'blob', 'both', 'call', 'change',
    'condition', 'database', 'databases', 'day_hour', 'day_minute',
    'day_second', 'declare', 'delayed', 'describe', 'distinctrow', 'div',
    'dual', 'each', 'elseif', 'enclosed', 'escaped', 'exit', 'explain',
    'float', 'force', 'fulltext', 'generated', 'high_priority', 'ignore',
    'infile', 'int', 'integer', 'interval', 'iterate', 'keys', 'kill',
    'leading', 'leave', 'lines', 'load', 'lock', 'long', 'loop', 'match',
    'mod', 'modifies', 'natural', 'no_write_to_binlog', 'offset', 'optimize',
    'option', 'optionally', 'out', 'outfile', 'partition', 'purge', 'range',
    'read', 'reads', 'regexp', 'rename', 'repeat', 'replace', 'require',
    'restrict', 'return', 'rlike', 'schema', 'schemas', 'separator', 'signal',
    'spatial', 'sql', 'sqlexception', 'sqlstate', 'sqlwarning', 'ssl',
    'starting', 'stored', 'straight_join', 'terminated', 'trailing', 'trigger',
    'undo', 'unlock', 'unsigned', 'usage', 'utc_date', 'utc_time',
    'utc_timestamp', 'varbinary', 'varchar', 'varying', 'virtual', 'while',
    'write', 'xor', 'zerofill', 'rank', 'row', 'rows',
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
}
BY_SYSTEM.mariadb = BY_SYSTEM.mysql

const CACHE: Record<string, Set<string>> = {}

function reservedSet(system: string): Set<string> {
  if (!CACHE[system]) {
    CACHE[system] = new Set([...CORE, ...(BY_SYSTEM[system] ?? [])])
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
