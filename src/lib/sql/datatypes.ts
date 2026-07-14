// Per-dialect data type catalogs for the Table Designer type dropdown (T3 / item 8).
// Pure → unit-testable. These are the concrete SQL types each relational engine
// accepts in a column definition; the dropdown is a searchable combobox over them.
//
// Types that take a length/precision are listed in their "bare" form (e.g. `varchar`,
// `decimal`); the designer's separate Length column supplies the `(n)` / `(p,s)`.
// A few common parameterized spellings people expect to pick directly (e.g.
// `nvarchar(max)`, `varchar(255)`) are included verbatim for convenience.

/** A sensible default column type for a new/blank row in the Table Designer, per
 *  engine (a plain integer — good for an id/PK — rather than the first alphabetical
 *  or narrowest type). */
export function defaultColumnType(system: string): string {
  switch (system) {
    case 'mysql':
    case 'mariadb':
      return 'int'
    case 'mssql':
      return 'int'
    case 'sqlite':
      return 'INTEGER'
    case 'clickhouse':
      return 'Int64'
    case 'oracle':
      return 'NUMBER'
    default:
      return 'integer' // postgres
  }
}

/** Full list of column data types for a relational engine, ordered roughly by
 *  how commonly they're used (numeric → string → date/time → misc). */
export function dataTypes(system: string): string[] {
  switch (system) {
    case 'mysql':
      return MYSQL_TYPES
    case 'mariadb':
      return MARIADB_TYPES
    case 'mssql':
      return MSSQL_TYPES
    case 'sqlite':
      return SQLITE_TYPES
    case 'clickhouse':
      return CLICKHOUSE_TYPES
    case 'oracle':
      return ORACLE_TYPES
    case 'postgres':
      return POSTGRES_TYPES
    default:
      // Non-relational or unknown → no curated list.
      return []
  }
}

const POSTGRES_TYPES = [
  // integers (+ int2/int4/int8 aliases) / serials
  'smallint', 'int2', 'integer', 'int', 'int4', 'bigint', 'int8',
  'smallserial', 'serial2', 'serial', 'serial4', 'bigserial', 'serial8',
  // exact / floating numeric
  'decimal', 'numeric', 'real', 'float4', 'double precision', 'float8', 'money',
  // character
  'varchar', 'character varying', 'char', 'character', 'bpchar', 'text', 'name', 'citext', '"char"',
  // boolean
  'boolean', 'bool',
  // date / time
  'timestamp', 'timestamp without time zone', 'timestamptz', 'timestamp with time zone',
  'date', 'time', 'time without time zone', 'timetz', 'time with time zone', 'interval',
  // uuid / json / xml
  'uuid', 'json', 'jsonb', 'jsonpath', 'xml',
  // binary / bit
  'bytea', 'bit', 'bit varying', 'varbit',
  // network
  'inet', 'cidr', 'macaddr', 'macaddr8',
  // geometric
  'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle',
  // ranges
  'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange',
  // multiranges (PG 14+)
  'int4multirange', 'int8multirange', 'nummultirange', 'tsmultirange', 'tstzmultirange', 'datemultirange',
  // full-text / key-value / misc
  'tsvector', 'tsquery', 'hstore', 'oid', 'pg_lsn', 'txid_snapshot',
]

const MYSQL_TYPES = [
  // integers (+ common unsigned variants people pick directly)
  'tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint',
  'tinyint unsigned', 'smallint unsigned', 'mediumint unsigned', 'int unsigned', 'bigint unsigned',
  // fixed / floating numeric
  'decimal', 'dec', 'numeric', 'fixed', 'float', 'double', 'double precision', 'real', 'bit',
  // boolean (alias of tinyint(1))
  'bool', 'boolean',
  // character
  'char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext',
  // binary
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob',
  // date / time
  'date', 'datetime', 'timestamp', 'time', 'year',
  // enum / set / json
  'enum', 'set', 'json',
  // spatial
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon',
  'geometrycollection',
]

// MariaDB is MySQL-compatible + a few extras (native UUID/INET types from 10.7+).
const MARIADB_TYPES = [
  ...MYSQL_TYPES.filter((t) => t !== 'json'),
  'json', 'uuid', 'inet4', 'inet6',
]

const MSSQL_TYPES = [
  // integers
  'tinyint', 'smallint', 'int', 'bigint', 'bit',
  // exact / floating numeric / money
  'decimal', 'numeric', 'money', 'smallmoney', 'float', 'real',
  // character (ANSI + Unicode, incl. (max) LOB spellings)
  'char', 'varchar', 'varchar(max)', 'text', 'nchar', 'nvarchar', 'nvarchar(max)', 'ntext',
  // date / time
  'date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'time',
  // binary
  'binary', 'varbinary', 'varbinary(max)', 'image', 'rowversion', 'timestamp',
  // misc
  'uniqueidentifier', 'xml', 'json', 'sql_variant', 'hierarchyid', 'geometry', 'geography',
  'cursor', 'table',
]

// SQLite uses type affinity — any token is accepted — but these are the canonical
// storage classes plus the common aliases people expect to pick.
const SQLITE_TYPES = [
  // INTEGER affinity
  'INTEGER', 'INT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'BIGINT', 'UNSIGNED BIG INT', 'INT2', 'INT8',
  // REAL affinity
  'REAL', 'DOUBLE', 'DOUBLE PRECISION', 'FLOAT',
  // NUMERIC affinity
  'NUMERIC', 'DECIMAL', 'BOOLEAN', 'DATE', 'DATETIME',
  // TEXT affinity
  'TEXT', 'CHARACTER', 'VARCHAR', 'VARYING CHARACTER', 'NCHAR', 'NATIVE CHARACTER', 'NVARCHAR', 'CLOB',
  // BLOB affinity
  'BLOB',
]

// Oracle Database. Types that take length/precision listed bare (VARCHAR2, NUMBER);
// the designer's Length column supplies (n)/(p,s). No AUTO_INCREMENT (use IDENTITY
// 12c+ or a sequence); no native BOOLEAN before 23c.
const ORACLE_TYPES = [
  // numeric
  'NUMBER', 'INTEGER', 'INT', 'SMALLINT', 'FLOAT', 'BINARY_FLOAT', 'BINARY_DOUBLE',
  'DECIMAL', 'DEC', 'NUMERIC', 'REAL', 'DOUBLE PRECISION',
  // character
  'VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'VARCHAR', 'LONG',
  // large objects
  'CLOB', 'NCLOB', 'BLOB', 'BFILE',
  // date / time / interval
  'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH LOCAL TIME ZONE',
  'INTERVAL YEAR TO MONTH', 'INTERVAL DAY TO SECOND',
  // binary / rowid
  'RAW', 'LONG RAW', 'ROWID', 'UROWID',
  // modern (version-gated) / misc
  'JSON', 'BOOLEAN', 'XMLTYPE', 'SDO_GEOMETRY',
]

const CLICKHOUSE_TYPES = [
  // signed / unsigned integers
  'Int8', 'Int16', 'Int32', 'Int64', 'Int128', 'Int256',
  'UInt8', 'UInt16', 'UInt32', 'UInt64', 'UInt128', 'UInt256',
  // floating / decimal / bool
  'Float32', 'Float64', 'BFloat16', 'Decimal', 'Decimal32', 'Decimal64', 'Decimal128', 'Decimal256', 'Bool',
  // strings
  'String', 'FixedString',
  // date / time
  'Date', 'Date32', 'DateTime', 'DateTime64',
  // uuid / enum
  'UUID', 'Enum8', 'Enum16',
  // ip
  'IPv4', 'IPv6',
  // json / composite / wrappers
  'JSON', 'Array', 'Tuple', 'Map', 'Nullable', 'LowCardinality', 'Nested', 'Nothing',
  // aggregate state
  'AggregateFunction', 'SimpleAggregateFunction',
  // geo
  'Point', 'Ring', 'Polygon', 'MultiPolygon',
]
