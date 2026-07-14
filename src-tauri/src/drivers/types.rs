use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::QueryError;

/// The 10 supported systems. Phase 1 implements the 5 relational/embedded ones;
/// the rest are declared so profiles/UI stay forward-compatible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemType {
    Postgres,
    Mysql,
    Mariadb,
    Mssql,
    Sqlite,
    Clickhouse,
    Cassandra,
    Redis,
    Kafka,
    Nats,
    Mongodb,
    Oracle,
}

impl SystemType {
    pub fn as_str(&self) -> &'static str {
        match self {
            SystemType::Postgres => "postgres",
            SystemType::Mysql => "mysql",
            SystemType::Mariadb => "mariadb",
            SystemType::Mssql => "mssql",
            SystemType::Sqlite => "sqlite",
            SystemType::Clickhouse => "clickhouse",
            SystemType::Cassandra => "cassandra",
            SystemType::Redis => "redis",
            SystemType::Kafka => "kafka",
            SystemType::Nats => "nats",
            SystemType::Mongodb => "mongodb",
            SystemType::Oracle => "oracle",
        }
    }

    /// Systems that speak SQL through the Phase-1 driver layer.
    pub fn is_phase1_sql(&self) -> bool {
        matches!(
            self,
            SystemType::Postgres
                | SystemType::Mysql
                | SystemType::Mariadb
                | SystemType::Mssql
                | SystemType::Sqlite
                | SystemType::Oracle
        )
    }
}

/// Column descriptor: [name, type] pairs per the locked result contract.
pub type ColumnDef = (String, String);

/// The result shape the UI depends on:
/// `{ ok, result?: { cols: [[name,type]], rows: object[], total }, error? }`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResultSet {
    pub cols: Vec<ColumnDef>,
    pub rows: Vec<Value>,
    pub total: u64,
}

/// Outcome of a single statement execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum StatementOutcome {
    /// SELECT-like: a result set.
    Rows { result: QueryResultSet },
    /// DML: number of affected rows.
    Affected { affected: u64 },
    /// DDL / statements with no result.
    Ok,
}

/// Envelope returned by exec commands. Mirrors the prototype contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<QueryResultSet>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<QueryError>,
    /// Server-side execution time in milliseconds.
    pub duration_ms: u64,
}

impl ExecResponse {
    pub fn from_outcome(outcome: StatementOutcome, duration_ms: u64) -> Self {
        match outcome {
            StatementOutcome::Rows { result } => Self {
                ok: true,
                result: Some(result),
                affected: None,
                error: None,
                duration_ms,
            },
            StatementOutcome::Affected { affected } => Self {
                ok: true,
                result: None,
                affected: Some(affected),
                error: None,
                duration_ms,
            },
            StatementOutcome::Ok => Self {
                ok: true,
                result: None,
                affected: None,
                error: None,
                duration_ms,
            },
        }
    }

    pub fn from_error(error: QueryError, duration_ms: u64) -> Self {
        Self {
            ok: false,
            result: None,
            affected: None,
            error: Some(error),
            duration_ms,
        }
    }
}

/// Result of a connection test: real handshake latency or a specific error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Schema introspection types (Object Explorer)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
    /// The database this connection is currently attached to.
    pub current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    /// "table" | "view" | "system"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_estimate: Option<i64>,
    /// SQLite internal tables (sqlite_master, sqlite_sequence) are locked.
    pub locked: bool,
    /// ClickHouse engine (MergeTree, ReplacingMergeTree, …) for the explorer badge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// On-disk data size in bytes (MySQL DATA_LENGTH / PG pg_total_relation_size).
    /// Best-effort — `None` on engines where it isn't cheaply available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_length: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    pub is_pk: bool,
    pub is_fk: bool,
    pub ordinal: i32,
    /// Server-generated identity/auto-increment column (PG serial/IDENTITY,
    /// MySQL AUTO_INCREMENT, MSSQL IDENTITY, SQLite INTEGER PRIMARY KEY rowid).
    /// Such columns should be omitted from generated INSERTs.
    #[serde(default)]
    pub auto_increment: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub method: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConstraintInfo {
    pub name: String,
    /// PK | FK | UNIQUE | CHECK
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamInfo {
    pub name: String,
    pub data_type: String,
    /// IN | OUT | INOUT
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutineInfo {
    pub schema: String,
    pub name: String,
    /// "procedure" | "function" | "table_function" | "scalar_function"
    pub kind: String,
    pub params: Vec<ParamInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub schema: String,
    pub name: String,
    pub table: String,
    /// e.g. "BEFORE UPDATE"
    pub event: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequenceInfo {
    pub schema: String,
    pub name: String,
}

/// A callable function available on the server (Query Editor autocomplete).
/// Introspected where the engine exposes a catalog (PostgreSQL `pg_proc`,
/// SQLite `pragma_function_list`, ClickHouse `system.functions`) or user-defined
/// routines (MySQL/MSSQL). Built-in lists for MySQL/MariaDB/MSSQL — which are not
/// enumerable from the catalog — are merged in on the frontend from a static set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionInfo {
    pub name: String,
    /// e.g. "to_char(timestamp, text)" when the catalog exposes arguments.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Short kind label ("function" | "aggregate" | "window" | "user").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// A single partition of a partitioned table (Explorer "Partitions" node).
/// `method`/`key` describe the parent table's partitioning; the remaining
/// per-partition fields describe this one partition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartitionInfo {
    /// Partition name (PG child relation, MySQL partition name, MSSQL "Partition N",
    /// ClickHouse partition id).
    pub name: String,
    /// Parent strategy: RANGE | LIST | HASH | KEY | "" (ClickHouse: "EXPRESSION").
    pub method: String,
    /// Parent partition key/expression, same for every row of a table
    /// (e.g. "created_at", "toYYYYMM(ts)", "(a, b)").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// This partition's bound/value (PG "FOR VALUES …", MySQL description,
    /// MSSQL boundary, ClickHouse partition value).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    /// Estimated / actual row count for this partition, when the engine exposes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<i64>,
    /// 1-based partition ordinal (MySQL, MSSQL) when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
}

/// Foreign-key relationship (ER Diagram + Schema Compare).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ForeignKey {
    pub name: String,
    pub from_table: String,
    pub from_column: String,
    pub to_table: String,
    pub to_column: String,
}
