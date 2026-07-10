// ClickHouse dialect for the CodeMirror SQL editor. @codemirror/lang-sql ships
// PostgreSQL/MySQL/MSSQL/SQLite but NOT ClickHouse, so ClickHouse previously fell
// back to StandardSQL (its ENGINE / LowCardinality / toYYYYMM… keywords weren't
// highlighted or keyword-suggested). This defines a proper ClickHouse dialect —
// used ONLY for ClickHouse connections (see SqlEditor.dialectFor); every other
// engine keeps its own lang-sql dialect. Matching is case-insensitive, so the
// token lists are lowercase (covers `Int64`, `LowCardinality`, `toYYYYMM`, …).
import { SQLDialect } from '@codemirror/lang-sql'

// Statement/clause keywords: common SQL + ClickHouse-specific (ENGINE, PARTITION,
// SETTINGS, PREWHERE, FINAL, TTL, materialized view / dictionary DDL, …).
export const CH_KEYWORDS =
  'select from where group by having order limit offset union all distinct as on using natural join inner left right full outer cross and or not in is null between like ilike exists case when then else end with recursive insert into values update set delete create drop alter attach detach rename truncate table view materialized dictionary database temporary if exists add modify clear column comment index constraint asc desc primary key foreign references default check unique cast extract interval true false ' +
  'engine settings partition sample ttl to volume disk codec alias ephemeral prewhere final deduplicate freeze unfreeze move fetch optimize cluster replica shard replicated format array arrayjoin lateral qualify window over partition_by order_by source layout lifetime population system reload flush kill mutation grant revoke role user quota profile show describe explain'

// ClickHouse data types.
export const CH_TYPES =
  'int8 int16 int32 int64 int128 int256 uint8 uint16 uint32 uint64 uint128 uint256 ' +
  'float32 float64 bfloat16 decimal decimal32 decimal64 decimal128 decimal256 ' +
  'string fixedstring uuid date date32 datetime datetime64 time ' +
  'enum enum8 enum16 array tuple map nested nullable lowcardinality bool boolean ' +
  'ipv4 ipv6 json object point ring polygon multipolygon interval nothing ' +
  'aggregatefunction simpleaggregatefunction'

// Common ClickHouse builtin functions (highlighted as builtins).
export const CH_FUNCTIONS =
  'count sum avg min max any anylast uniq uniqexact uniqcombined grouparray groupuniqarray argmin argmax median quantile quantiles ' +
  'toyear tomonth toyyyymm toyyyymmdd todate todate32 todatetime todatetime64 tostartofmonth tostartofday tostartofhour tostartofminute tostartofweek ' +
  'now today yesterday formatdatetime datediff dateadd tostring toint8 toint16 toint32 toint64 touint8 touint16 touint32 touint64 tofloat32 tofloat64 todecimal64 ' +
  'length empty notempty lower upper lowerutf8 upperutf8 substring substr splitbychar splitbystring concat trim ' +
  'arrayjoin arraymap arrayfilter arrayreduce arraysum arraysort arrayelement has hasall hasany indexof ' +
  'if multiif coalesce ifnull nullif assumenotnull cast accuratecast reinterpret round floor ceil trunc abs greatest least ' +
  'dictget dictgetordefault dictgetstring dicthas formatreadablesize formatreadablequantity generateuuidv4 rand rand64 cityhash64 bitand bitor bitxor'

// ClickHouse SQL dialect for the editor: backtick-quoted identifiers, dash + block
// comments, and backslash escapes in strings (all ClickHouse behaviours).
export const clickHouseDialect = SQLDialect.define({
  keywords: CH_KEYWORDS,
  types: CH_TYPES,
  builtin: CH_FUNCTIONS,
  identifierQuotes: '`',
  backslashEscapes: true,
  slashComments: true,
  hashComments: false,
})
