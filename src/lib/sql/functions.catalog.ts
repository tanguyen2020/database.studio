// Static built-in function catalogs for engines whose built-ins are NOT
// enumerable from the server catalog: MySQL, MariaDB, MSSQL. (PostgreSQL,
// SQLite and ClickHouse expose their full function list via introspection —
// `list_functions` — so they don't need a static set.)
//
// These are merged with the introspected user-defined functions and the curated
// signature set in `functions.ts::functionCatalog`. Grouped by category so each
// completion carries a useful `detail` label. Pure data → unit-testable.

import type { FnSig } from './functions'

type Catalog = Record<string, string[]>

// ---------------------------------------------------------------------------
// MySQL 8 built-in functions (https://dev.mysql.com/doc/refman/8.0/en/functions.html)
// ---------------------------------------------------------------------------
const MYSQL: Catalog = {
  string: [
    'ascii', 'bin', 'bit_length', 'char', 'char_length', 'character_length', 'concat', 'concat_ws',
    'elt', 'export_set', 'field', 'find_in_set', 'format', 'from_base64', 'hex', 'insert', 'instr',
    'lcase', 'left', 'length', 'load_file', 'locate', 'lower', 'lpad', 'ltrim', 'make_set', 'mid',
    'oct', 'octet_length', 'ord', 'position', 'quote', 'regexp_instr', 'regexp_like', 'regexp_replace',
    'regexp_substr', 'repeat', 'replace', 'reverse', 'right', 'rpad', 'rtrim', 'soundex', 'space',
    'strcmp', 'substr', 'substring', 'substring_index', 'to_base64', 'trim', 'ucase', 'unhex', 'upper',
    'weight_string',
  ],
  numeric: [
    'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'ceiling', 'conv', 'cos', 'cot', 'crc32', 'degrees',
    'exp', 'floor', 'ln', 'log', 'log10', 'log2', 'mod', 'pi', 'pow', 'power', 'radians', 'rand', 'round',
    'sign', 'sin', 'sqrt', 'tan', 'truncate',
  ],
  datetime: [
    'adddate', 'addtime', 'convert_tz', 'curdate', 'curtime', 'current_date', 'current_time',
    'current_timestamp', 'date', 'datediff', 'date_add', 'date_format', 'date_sub', 'day', 'dayname',
    'dayofmonth', 'dayofweek', 'dayofyear', 'extract', 'from_days', 'from_unixtime', 'get_format', 'hour',
    'last_day', 'localtime', 'localtimestamp', 'makedate', 'maketime', 'microsecond', 'minute', 'month',
    'monthname', 'now', 'period_add', 'period_diff', 'quarter', 'sec_to_time', 'second', 'str_to_date',
    'subdate', 'subtime', 'sysdate', 'time', 'timediff', 'timestamp', 'timestampadd', 'timestampdiff',
    'time_format', 'time_to_sec', 'to_days', 'to_seconds', 'unix_timestamp', 'utc_date', 'utc_time',
    'utc_timestamp', 'week', 'weekday', 'weekofyear', 'year', 'yearweek',
  ],
  aggregate: [
    'avg', 'bit_and', 'bit_or', 'bit_xor', 'count', 'group_concat', 'json_arrayagg', 'json_objectagg',
    'max', 'min', 'std', 'stddev', 'stddev_pop', 'stddev_samp', 'sum', 'var_pop', 'var_samp', 'variance',
  ],
  window: [
    'cume_dist', 'dense_rank', 'first_value', 'lag', 'last_value', 'lead', 'nth_value', 'ntile',
    'percent_rank', 'rank', 'row_number',
  ],
  json: [
    'json_array', 'json_array_append', 'json_array_insert', 'json_contains', 'json_contains_path',
    'json_depth', 'json_extract', 'json_insert', 'json_keys', 'json_length', 'json_merge',
    'json_merge_patch', 'json_merge_preserve', 'json_object', 'json_overlaps', 'json_pretty', 'json_quote',
    'json_remove', 'json_replace', 'json_search', 'json_set', 'json_table', 'json_type', 'json_unquote',
    'json_valid', 'json_value', 'member_of',
  ],
  control: ['coalesce', 'greatest', 'if', 'ifnull', 'isnull', 'interval', 'least', 'nullif'],
  system: [
    'aes_decrypt', 'aes_encrypt', 'benchmark', 'bit_count', 'compress', 'connection_id', 'current_role',
    'current_user', 'database', 'found_rows', 'last_insert_id', 'md5', 'random_bytes', 'row_count',
    'schema', 'session_user', 'sha', 'sha1', 'sha2', 'system_user', 'uncompress', 'user', 'uuid',
    'uuid_short', 'values', 'version',
  ],
  conversion: ['cast', 'convert', 'binary'],
}

// MariaDB shares MySQL's set and adds a handful of its own.
const MARIADB_EXTRA: Catalog = {
  string: ['sformat', 'natural_sort_key', 'to_char'],
  json: ['json_compact', 'json_detailed', 'json_exists', 'json_query', 'json_value', 'json_equals', 'json_normalize'],
  control: ['decode_oracle'],
  system: ['sys_guid', 'rownum'],
}

// ---------------------------------------------------------------------------
// MSSQL / T-SQL built-in functions
// (https://learn.microsoft.com/sql/t-sql/functions/functions)
// ---------------------------------------------------------------------------
const MSSQL: Catalog = {
  string: [
    'ascii', 'char', 'charindex', 'concat', 'concat_ws', 'difference', 'format', 'left', 'len', 'lower',
    'ltrim', 'nchar', 'patindex', 'quotename', 'replace', 'replicate', 'reverse', 'right', 'rtrim',
    'soundex', 'space', 'str', 'string_agg', 'string_escape', 'string_split', 'stuff', 'substring',
    'translate', 'trim', 'unicode', 'upper',
  ],
  numeric: [
    'abs', 'acos', 'asin', 'atan', 'atn2', 'ceiling', 'cos', 'cot', 'degrees', 'exp', 'floor', 'log',
    'log10', 'pi', 'power', 'radians', 'rand', 'round', 'sign', 'sin', 'sqrt', 'square', 'tan',
  ],
  datetime: [
    'current_timestamp', 'current_timezone', 'current_timezone_id', 'dateadd', 'datediff', 'datediff_big',
    'datefromparts', 'datename', 'datepart', 'datetime2fromparts', 'datetimefromparts',
    'datetimeoffsetfromparts', 'day', 'eomonth', 'getdate', 'getutcdate', 'isdate', 'month',
    'smalldatetimefromparts', 'switchoffset', 'sysdatetime', 'sysdatetimeoffset', 'sysutcdatetime',
    'timefromparts', 'todatetimeoffset', 'year',
  ],
  aggregate: [
    'approx_count_distinct', 'avg', 'checksum_agg', 'count', 'count_big', 'grouping', 'grouping_id', 'max',
    'min', 'stdev', 'stdevp', 'string_agg', 'sum', 'var', 'varp',
  ],
  window: [
    'cume_dist', 'dense_rank', 'first_value', 'lag', 'last_value', 'lead', 'ntile', 'percent_rank',
    'percentile_cont', 'percentile_disc', 'rank', 'row_number',
  ],
  control: ['choose', 'coalesce', 'iif', 'isnull', 'nullif'],
  conversion: ['cast', 'convert', 'parse', 'try_cast', 'try_convert', 'try_parse'],
  json: [
    'isjson', 'json_array', 'json_modify', 'json_object', 'json_path_exists', 'json_query', 'json_value',
    'openjson',
  ],
  system: [
    'app_name', 'coalesce', 'current_user', 'db_id', 'db_name', 'error_line', 'error_message',
    'error_number', 'error_procedure', 'error_severity', 'error_state', 'hashbytes', 'host_id', 'host_name',
    'isnumeric', 'newid', 'newsequentialid', 'object_id', 'object_name', 'pwdcompare', 'pwdencrypt',
    'schema_id', 'schema_name', 'scope_identity', 'session_user', 'suser_name', 'suser_sname',
    'system_user', 'user_name', 'xact_state',
  ],
}

function flatten(cat: Catalog): FnSig[] {
  const out: FnSig[] = []
  const seen = new Set<string>()
  for (const [detail, names] of Object.entries(cat)) {
    for (const name of names) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, signature: `${name}(…)`, detail })
    }
  }
  return out
}

function merge(base: Catalog, extra: Catalog): Catalog {
  const out: Catalog = {}
  for (const [k, v] of Object.entries(base)) out[k] = [...v]
  for (const [k, v] of Object.entries(extra)) out[k] = [...(out[k] ?? []), ...v]
  return out
}

// ---------------------------------------------------------------------------
// Oracle Database built-in (SQL) functions. Oracle's built-ins live in the SYS
// STANDARD package and are NOT enumerable like PG/SQLite/ClickHouse, so — as with
// MySQL/MSSQL — a curated static catalog is the pragmatic source.
// ---------------------------------------------------------------------------
const ORACLE: Catalog = {
  string: [
    'ascii', 'chr', 'concat', 'initcap', 'instr', 'instrb', 'length', 'lengthb',
    'lower', 'lpad', 'ltrim', 'nls_initcap', 'nls_lower', 'nls_upper', 'nlssort',
    'regexp_count', 'regexp_instr', 'regexp_replace', 'regexp_substr', 'replace',
    'rpad', 'rtrim', 'soundex', 'substr', 'substrb', 'translate', 'trim', 'upper',
  ],
  numeric: [
    'abs', 'acos', 'asin', 'atan', 'atan2', 'bitand', 'ceil', 'cos', 'cosh', 'exp',
    'floor', 'ln', 'log', 'mod', 'power', 'remainder', 'round', 'sign', 'sin', 'sinh',
    'sqrt', 'tan', 'tanh', 'trunc', 'width_bucket',
  ],
  datetime: [
    'add_months', 'current_date', 'current_timestamp', 'dbtimezone', 'extract',
    'from_tz', 'last_day', 'localtimestamp', 'months_between', 'new_time', 'next_day',
    'numtodsinterval', 'numtoyminterval', 'sessiontimezone', 'sysdate', 'systimestamp',
    'to_dsinterval', 'to_timestamp', 'to_timestamp_tz', 'to_yminterval', 'tz_offset',
  ],
  conversion: [
    'asciistr', 'bin_to_num', 'cast', 'chartorowid', 'convert', 'hextoraw', 'rawtohex',
    'rowidtochar', 'to_char', 'to_clob', 'to_date', 'to_lob', 'to_nclob', 'to_number',
    'to_single_byte', 'to_multi_byte', 'unistr', 'validate_conversion',
  ],
  'null handling': ['coalesce', 'decode', 'lnnvl', 'nanvl', 'nullif', 'nvl', 'nvl2'],
  aggregate: [
    'avg', 'collect', 'corr', 'count', 'covar_pop', 'covar_samp', 'cume_dist',
    'dense_rank', 'grouping', 'grouping_id', 'listagg', 'max', 'median', 'min',
    'percentile_cont', 'percentile_disc', 'percent_rank', 'rank', 'stddev',
    'stddev_pop', 'stddev_samp', 'sum', 'var_pop', 'var_samp', 'variance',
  ],
  analytic: [
    'first_value', 'lag', 'last_value', 'lead', 'nth_value', 'ntile',
    'ratio_to_report', 'row_number',
  ],
  system: [
    'dump', 'greatest', 'least', 'ora_hash', 'sys_context', 'sys_guid', 'uid',
    'user', 'userenv', 'vsize',
  ],
}

const CATALOGS: Record<string, FnSig[]> = {
  mysql: flatten(MYSQL),
  mariadb: flatten(merge(MYSQL, MARIADB_EXTRA)),
  mssql: flatten(MSSQL),
  oracle: flatten(ORACLE),
}

/**
 * Static built-in functions for engines that cannot enumerate them from the
 * catalog (MySQL/MariaDB/MSSQL). Returns [] for PG/SQLite/ClickHouse — those are
 * covered by live introspection instead.
 */
export function staticFunctions(system: string): FnSig[] {
  return CATALOGS[system] ?? []
}
