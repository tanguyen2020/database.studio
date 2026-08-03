//! Driver layer: one adapter per system, unified behind `LiveConnection`.

pub mod backup;
pub mod cancel;
pub mod cassandra;
pub mod clickhouse;
pub mod grid;
pub mod index_scan;
pub mod kafka;
pub mod mongo;
pub mod mssql;
pub mod mysql;
pub mod nats;
pub mod oracle;
pub mod plan;
pub mod postgres;
pub mod redis;
pub mod schema_registry;
pub mod sqlite;
pub mod types;
pub mod util;

use crate::connections::profile::{ConnectionProfile, SqliteMode};
use crate::drivers::types::*;
use crate::error::QueryError;

use cassandra::{CassandraConnParams, CassandraDriver};
use clickhouse::{ChConnParams, ChDriver};
use kafka::{KafkaConnParams, KafkaDriver};
use mongo::{MongoConnParams, MongoDriver};
use mssql::{MssqlConnParams, MssqlDriver};
use mysql::{MySqlConnParams, MySqlDriver};
use nats::{NatsConnParams, NatsDriver};
use oracle::{OracleConnParams, OracleDriver};
use postgres::{PgConnParams, PgDriver};
use redis::{RedisConnParams, RedisDriver};
use sqlite::{SqliteConnParams, SqliteDriver};

/// Effective network endpoint: profile host/port, or the local end of an SSH
/// tunnel when one is active.
#[derive(Clone)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

pub enum LiveConnection {
    Clickhouse(ChDriver),
    Postgres(PgDriver),
    MySql(MySqlDriver),
    Mssql(MssqlDriver),
    Sqlite(SqliteDriver),
    Redis(RedisDriver),
    Nats(NatsDriver),
    Kafka(KafkaDriver),
    Cassandra(CassandraDriver),
    Mongo(MongoDriver),
    Oracle(OracleDriver),
}

fn pg_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> PgConnParams {
    PgConnParams {
        host: ep.host.clone(),
        port: ep.port,
        database: p.database.clone(),
        user: p.user.clone(),
        password: password.to_string(),
        ssl: p.ssl,
        ssl_ca: p.ssl_ca.clone(),
        ssl_cert: p.ssl_cert.clone(),
        ssl_key: p.ssl_key.clone(),
    }
}

fn mysql_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> MySqlConnParams {
    MySqlConnParams {
        host: ep.host.clone(),
        port: ep.port,
        database: p.database.clone(),
        user: p.user.clone(),
        password: password.to_string(),
        ssl: p.ssl,
        ssl_ca: p.ssl_ca.clone(),
        ssl_cert: p.ssl_cert.clone(),
        ssl_key: p.ssl_key.clone(),
    }
}

fn mssql_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> MssqlConnParams {
    MssqlConnParams {
        host: ep.host.clone(),
        port: ep.port,
        database: p.database.clone(),
        user: p.user.clone(),
        password: password.to_string(),
        ssl: p.ssl,
        ssl_ca: p.ssl_ca.clone(),
        auth: if p.mssql_auth.is_empty() { "sql".into() } else { p.mssql_auth.clone() },
    }
}

fn ch_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> ChConnParams {
    ChConnParams {
        host: ep.host.clone(),
        port: ep.port,
        database: if p.database.is_empty() { "default".into() } else { p.database.clone() },
        user: if p.user.is_empty() { "default".into() } else { p.user.clone() },
        password: password.to_string(),
        ssl: p.ssl,
    }
}

fn sqlite_params(p: &ConnectionProfile) -> SqliteConnParams {
    SqliteConnParams {
        path: p.sqlite_path.clone(),
        mode: if p.sqlite_path.is_empty() { SqliteMode::InMemory } else { p.sqlite_mode },
    }
}

fn redis_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> RedisConnParams {
    RedisConnParams {
        host: ep.host.clone(),
        port: ep.port,
        password: password.to_string(),
        // DB index dùng lại field `database` (chuỗi "0".."15"); mặc định 0.
        db: p.database.trim().parse::<i64>().unwrap_or(0),
        ssl: p.ssl,
        ssl_ca: p.ssl_ca.clone(),
    }
}

/// Lỗi dùng chung cho các thao tác SQL gọi nhầm trên Redis (key-value store).
fn redis_not_sql() -> QueryError {
    QueryError::new(
        "redis",
        "Redis is a key-value store — use Key Explorer / CLI, not SQL",
        "sql operation not applicable to redis",
    )
}

fn nats_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> NatsConnParams {
    NatsConnParams {
        host: ep.host.clone(),
        port: ep.port,
        user: p.user.clone(),
        password: password.to_string(),
        ssl: p.ssl,
    }
}

/// Lỗi cho thao tác SQL gọi nhầm trên NATS (messaging).
fn nats_not_sql() -> QueryError {
    QueryError::new(
        "nats",
        "NATS is messaging — use Subscriber / Publish / JetStream, not SQL",
        "sql operation not applicable to nats",
    )
}

fn kafka_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> KafkaConnParams {
    // bootstrap: giữ nguyên nếu đã có ':'/',' (list host:port); nếu không, ghép host:port.
    let bootstrap = if ep.host.contains(':') || ep.host.contains(',') {
        ep.host.clone()
    } else {
        format!("{}:{}", ep.host, ep.port)
    };
    // mssql_auth tái dùng làm "auth mode": với Kafka là SASL mechanism.
    let sasl_mechanism = match p.mssql_auth.as_str() {
        m @ ("PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512") => m.to_string(),
        _ => String::new(),
    };
    KafkaConnParams {
        bootstrap,
        sasl_mechanism,
        user: p.user.clone(),
        password: password.to_string(),
        ssl: p.ssl,
    }
}

fn kafka_not_sql() -> QueryError {
    QueryError::new(
        "kafka",
        "Kafka is streaming — use Topic Browser / Consumer / Producer, not SQL",
        "sql operation not applicable to kafka",
    )
}

fn cassandra_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> CassandraConnParams {
    // Host field có thể là danh sách contact points phân tách bằng dấu phẩy
    // (prototype dùng 1 field Host). Mỗi điểm gắn port của profile nếu thiếu.
    let contact_points: Vec<String> = ep
        .host
        .split(',')
        .map(|h| h.trim())
        .filter(|h| !h.is_empty())
        .map(|h| if h.contains(':') { h.to_string() } else { format!("{}:{}", h, ep.port) })
        .collect();
    CassandraConnParams {
        contact_points: if contact_points.is_empty() {
            vec![format!("{}:{}", ep.host, ep.port)]
        } else {
            contact_points
        },
        user: p.user.clone(),
        password: password.to_string(),
        datacenter: p.cassandra_dc.clone(),
        consistency: if p.cassandra_consistency.is_empty() {
            "LOCAL_QUORUM".to_string()
        } else {
            p.cassandra_consistency.clone()
        },
        keyspace: p.database.clone(),
        ssl: p.ssl,
        ssl_ca: p.ssl_ca.clone(),
    }
}

fn oracle_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> OracleConnParams {
    // O0: reuse existing profile fields — `database` = service name (or SID), and
    // `mssql_auth == "sid"` selects SID mode (dedicated oracle_* fields land later).
    OracleConnParams {
        host: ep.host.clone(),
        port: ep.port,
        service: p.database.clone(),
        use_sid: p.mssql_auth.eq_ignore_ascii_case("sid"),
        user: p.user.clone(),
        password: password.to_string(),
        ssl: p.ssl,
        ssl_ca: p.ssl_ca.clone(),
    }
}

fn mongo_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> MongoConnParams {
    MongoConnParams {
        host: ep.host.clone(),
        port: ep.port,
        database: p.database.clone(),
        user: p.user.clone(),
        password: password.to_string(),
        ssl: p.ssl,
        ssl_ca: p.ssl_ca.clone(),
    }
}

impl LiveConnection {
    pub async fn connect(
        profile: &ConnectionProfile,
        endpoint: &Endpoint,
        password: &str,
    ) -> Result<Self, QueryError> {
        match profile.system {
            SystemType::Postgres => Ok(Self::Postgres(
                PgDriver::connect(&pg_params(profile, endpoint, password)).await?,
            )),
            SystemType::Mysql => Ok(Self::MySql(
                MySqlDriver::connect(&mysql_params(profile, endpoint, password), "mysql").await?,
            )),
            SystemType::Mariadb => Ok(Self::MySql(
                MySqlDriver::connect(&mysql_params(profile, endpoint, password), "mariadb").await?,
            )),
            SystemType::Mssql => Ok(Self::Mssql(
                MssqlDriver::connect(&mssql_params(profile, endpoint, password)).await?,
            )),
            SystemType::Clickhouse => Ok(Self::Clickhouse(
                ChDriver::connect(&ch_params(profile, endpoint, password)).await?,
            )),
            SystemType::Sqlite => Ok(Self::Sqlite(
                SqliteDriver::connect(&sqlite_params(profile)).await?,
            )),
            SystemType::Redis => Ok(Self::Redis(
                RedisDriver::connect(&redis_params(profile, endpoint, password)).await?,
            )),
            SystemType::Nats => Ok(Self::Nats(
                NatsDriver::connect(&nats_params(profile, endpoint, password)).await?,
            )),
            SystemType::Kafka => Ok(Self::Kafka(
                KafkaDriver::connect(&kafka_params(profile, endpoint, password)).await?,
            )),
            SystemType::Cassandra => Ok(Self::Cassandra(
                CassandraDriver::connect(&cassandra_params(profile, endpoint, password)).await?,
            )),
            SystemType::Mongodb => Ok(Self::Mongo(
                MongoDriver::connect(&mongo_params(profile, endpoint, password)).await?,
            )),
            SystemType::Oracle => Ok(Self::Oracle(
                OracleDriver::connect(&oracle_params(profile, endpoint, password)).await?,
            )),
            #[allow(unreachable_patterns)]
            other => Err(QueryError::new(
                other.as_str(),
                format!("System {} is not supported yet", other.as_str()),
                "unsupported system",
            )),
        }
    }

    pub async fn test(
        profile: &ConnectionProfile,
        endpoint: &Endpoint,
        password: &str,
    ) -> TestResult {
        match profile.system {
            SystemType::Postgres => PgDriver::test(&pg_params(profile, endpoint, password)).await,
            SystemType::Mysql => {
                MySqlDriver::test(&mysql_params(profile, endpoint, password), "mysql").await
            }
            SystemType::Mariadb => {
                MySqlDriver::test(&mysql_params(profile, endpoint, password), "mariadb").await
            }
            SystemType::Mssql => MssqlDriver::test(&mssql_params(profile, endpoint, password)).await,
            SystemType::Clickhouse => ChDriver::test(&ch_params(profile, endpoint, password)).await,
            SystemType::Sqlite => SqliteDriver::test(&sqlite_params(profile)).await,
            SystemType::Redis => RedisDriver::test(&redis_params(profile, endpoint, password)).await,
            SystemType::Nats => NatsDriver::test(&nats_params(profile, endpoint, password)).await,
            SystemType::Kafka => KafkaDriver::test(&kafka_params(profile, endpoint, password)).await,
            SystemType::Cassandra => {
                CassandraDriver::test(&cassandra_params(profile, endpoint, password)).await
            }
            SystemType::Mongodb => {
                MongoDriver::test(&mongo_params(profile, endpoint, password)).await
            }
            SystemType::Oracle => {
                OracleDriver::test(&oracle_params(profile, endpoint, password)).await
            }
            #[allow(unreachable_patterns)]
            other => TestResult {
                ok: false,
                latency_ms: None,
                server_version: None,
                error: Some(format!("System {} is not supported yet", other.as_str())),
            },
        }
    }

    /// Boxed to erase the drivers' opaque future types — awaiting the sqlx
    /// futures directly inside a tokio::spawn'ed future trips a compiler
    /// limitation ("implementation of Executor is not general enough").
    pub fn exec<'a>(
        &'a mut self,
        sql: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<StatementOutcome, QueryError>> {
        match self {
            Self::Postgres(d) => Box::pin(d.exec(sql)),
            Self::MySql(d) => Box::pin(d.exec(sql)),
            Self::Mssql(d) => Box::pin(d.exec(sql)),
            Self::Sqlite(d) => Box::pin(d.exec(sql)),
            Self::Clickhouse(d) => Box::pin(d.exec(sql)),
            Self::Redis(_) => Box::pin(async { Err(redis_not_sql()) }),
            Self::Nats(_) => Box::pin(async { Err(nats_not_sql()) }),
            Self::Kafka(_) => Box::pin(async { Err(kafka_not_sql()) }),
            // CQL editor: first page only via generic exec (paging + warnings
            // qua command cql_exec chuyên biệt).
            Self::Cassandra(d) => Box::pin(async move { d.exec_cql(sql, None, None).await.map(|o| o.outcome) }),
            // Mongo editor: first page only via generic exec (paging + warnings
            // đi qua command mongo_exec chuyên biệt).
            Self::Mongo(d) => Box::pin(async move { d.exec_mongo(sql, None, None).await.map(|o| o.outcome) }),
            Self::Oracle(d) => Box::pin(d.exec(sql)),
        }
    }

    pub async fn ping(&mut self) -> bool {
        match self {
            Self::Postgres(d) => d.ping().await,
            Self::MySql(d) => d.ping().await,
            Self::Mssql(d) => d.ping().await,
            Self::Sqlite(d) => d.ping().await,
            Self::Clickhouse(d) => d.ping().await,
            Self::Redis(d) => d.ping().await,
            Self::Nats(d) => d.ping().await,
            Self::Kafka(d) => d.ping().await,
            Self::Cassandra(d) => d.ping().await,
            Self::Mongo(d) => d.ping().await,
            Self::Oracle(d) => d.ping().await,
        }
    }

    /// SELECT tham số hóa (filter builder / pagination). ClickHouse: fallback
    /// build literal (không có positional param HTTP) — Phase 2 tắt filter cho CH.
    pub async fn exec_params(
        &mut self,
        sql: &str,
        params: &[serde_json::Value],
    ) -> Result<StatementOutcome, QueryError> {
        match self {
            Self::Postgres(d) => d.exec_params(sql, params).await,
            Self::MySql(d) => d.exec_params(sql, params).await,
            Self::Mssql(d) => d.exec_params(sql, params).await,
            Self::Sqlite(d) => d.exec_params(sql, params.to_vec()).await,
            Self::Clickhouse(_) => Err(QueryError::new(
                "clickhouse",
                "Filter builder does not support ClickHouse in Phase 2",
                "clickhouse param select not supported yet",
            )),
            Self::Redis(_) => Err(redis_not_sql()),
            Self::Nats(_) => Err(nats_not_sql()),
            Self::Kafka(_) => Err(kafka_not_sql()),
            // CQL không dùng positional param của filter builder ở đây; editor
            // tự viết literal, path tham số hóa (nếu có) đi qua prepared statement.
            Self::Cassandra(_) => Err(QueryError::new(
                "cassandra",
                "Filter builder does not support Cassandra — use the CQL editor with WHERE on the key",
                "cassandra param select not supported",
            )),
            Self::Mongo(_) => Err(QueryError::new(
                "mongodb",
                "Filter builder does not support MongoDB — use the query editor with a find() filter",
                "mongodb param select not supported",
            )),
            Self::Oracle(d) => d.exec_params(sql, params).await,
        }
    }

    /// Editable grid Apply — chạy pending changes trong transaction.
    /// ClickHouse KHÔNG hỗ trợ (mutation async — Phase 5); Cassandra không có ở đây.
    pub async fn apply_grid_changes(
        &mut self,
        changes: &[grid::GridChange],
    ) -> Result<u64, QueryError> {
        match self {
            Self::Postgres(d) => d.apply_changes(changes).await,
            Self::MySql(d) => d.apply_changes(changes).await,
            Self::Mssql(d) => d.apply_changes(changes).await,
            Self::Sqlite(d) => d.apply_changes(changes.to_vec()).await,
            Self::Clickhouse(_) => Err(QueryError::new(
                "clickhouse",
                "ClickHouse: data changes are async mutations (ALTER TABLE … UPDATE/DELETE) — used in Phase 5, not committed OLTP-style",
                "editable grid not applicable to clickhouse",
            )),
            Self::Redis(_) => Err(redis_not_sql()),
            Self::Nats(_) => Err(nats_not_sql()),
            Self::Kafka(_) => Err(kafka_not_sql()),
            // Editable grid = INSERT/UPDATE/DELETE by full primary key, run as CQL
            // (no OLTP transaction — statements applied sequentially).
            Self::Cassandra(d) => d.apply_grid(changes).await,
            // Mongo: insert/update/delete document by `_id` (no OLTP transaction).
            Self::Mongo(d) => d.apply_grid(changes).await,
            Self::Oracle(d) => d.apply_changes(changes).await,
        }
    }

    // ---- introspection dispatch ---------------------------------------------

    pub async fn schemas(&mut self) -> Result<Vec<SchemaInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.schemas().await,
            Self::MySql(d) => d.schemas().await,
            Self::Mssql(d) => d.schemas().await,
            Self::Sqlite(d) => d.schemas().await,
            Self::Clickhouse(d) => d.schemas().await,
            Self::Redis(_) => Ok(Vec::new()),
            Self::Nats(_) => Ok(Vec::new()),
            Self::Kafka(_) => Ok(Vec::new()),
            // Cassandra: cây keyspace lấy qua command cassandra_tree chuyên biệt.
            Self::Cassandra(_) => Ok(Vec::new()),
            // Mongo: cây database→collection lấy qua command mongo_* chuyên biệt.
            Self::Mongo(_) => Ok(Vec::new()),
            Self::Oracle(d) => d.schemas().await,
        }
    }

    /// Databases on the server. Postgres/MSSQL bind one DB per connection, so the
    /// Explorer lists them all and opens another as its own connection. MySQL/
    /// MariaDB expose every database as a schema already, so they return none here.
    pub async fn databases(&mut self) -> Result<Vec<DatabaseInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.databases().await,
            Self::Mssql(d) => d.databases().await,
            Self::Mongo(d) => d.databases().await,
            Self::Oracle(d) => d.databases().await,
            _ => Ok(Vec::new()),
        }
    }

    pub async fn tables(&mut self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.tables(schema).await,
            Self::MySql(d) => d.tables(schema).await,
            Self::Mssql(d) => d.tables(schema).await,
            Self::Sqlite(d) => d.tables(schema).await,
            Self::Clickhouse(d) => d.tables(schema).await,
            Self::Redis(_) => Ok(Vec::new()),
            Self::Nats(_) => Ok(Vec::new()),
            Self::Kafka(_) => Ok(Vec::new()),
            Self::Cassandra(_) => Ok(Vec::new()),
            // Mongo: "schema" = database, "table" = collection.
            Self::Mongo(d) => d.collections(schema).await,
            Self::Oracle(d) => d.tables(schema).await,
        }
    }

    pub async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.columns(schema, table).await,
            Self::MySql(d) => d.columns(schema, table).await,
            Self::Mssql(d) => d.columns(schema, table).await,
            Self::Sqlite(d) => d.columns(schema, table).await,
            Self::Clickhouse(d) => d.columns(schema, table).await,
            Self::Redis(_) => Ok(Vec::new()),
            Self::Nats(_) => Ok(Vec::new()),
            Self::Kafka(_) => Ok(Vec::new()),
            Self::Cassandra(_) => Ok(Vec::new()),
            Self::Mongo(d) => d.collection_fields(schema, table).await,
            Self::Oracle(d) => d.columns(schema, table).await,
        }
    }

    pub async fn indexes(&mut self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.indexes(schema, table).await,
            Self::MySql(d) => d.indexes(schema, table).await,
            Self::Mssql(d) => d.indexes(schema, table).await,
            Self::Sqlite(d) => d.indexes(schema, table).await,
            Self::Clickhouse(_) => Ok(Vec::new()), // data-skipping index → Phase 5 Index Scanner
            Self::Redis(_) => Ok(Vec::new()),
            Self::Nats(_) => Ok(Vec::new()),
            Self::Kafka(_) => Ok(Vec::new()),
            Self::Cassandra(_) => Ok(Vec::new()),
            Self::Mongo(d) => d.indexes(schema, table).await,
            Self::Oracle(d) => d.indexes(schema, table).await,
        }
    }

    pub async fn constraints(&mut self, schema: &str, table: &str) -> Result<Vec<ConstraintInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.constraints(schema, table).await,
            Self::MySql(d) => d.constraints(schema, table).await,
            Self::Mssql(d) => d.constraints(schema, table).await,
            // SQLite: PK/unique come from indexes; FKs from foreign_key_list.
            Self::Sqlite(_) => Ok(Vec::new()),
            Self::Clickhouse(_) => Ok(Vec::new()),
            Self::Redis(_) => Ok(Vec::new()),
            Self::Nats(_) => Ok(Vec::new()),
            Self::Kafka(_) => Ok(Vec::new()),
            Self::Cassandra(_) => Ok(Vec::new()),
            Self::Mongo(_) => Ok(Vec::new()),
            Self::Oracle(d) => d.constraints(schema, table).await,
        }
    }

    pub async fn routines(&mut self, schema: &str) -> Result<Vec<RoutineInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.routines(schema).await,
            Self::MySql(d) => d.routines(schema).await,
            Self::Mssql(d) => d.routines(schema).await,
            Self::Sqlite(_) => Ok(Vec::new()), // SQLite has no stored routines
            Self::Clickhouse(_) => Ok(Vec::new()), // UDF → Phase 5
            Self::Redis(_) => Ok(Vec::new()),
            Self::Nats(_) => Ok(Vec::new()),
            Self::Kafka(_) => Ok(Vec::new()),
            Self::Cassandra(_) => Ok(Vec::new()),
            Self::Mongo(_) => Ok(Vec::new()),
            Self::Oracle(d) => d.routines(schema).await,
        }
    }

    /// Callable functions for Query Editor autocomplete. PG/SQLite/ClickHouse
    /// enumerate the full catalog (built-ins + extensions); MySQL/MSSQL return
    /// only user-defined functions (built-ins are supplied statically on the
    /// frontend). Non-relational engines return an empty list.
    pub async fn functions(&mut self, schema: &str) -> Result<Vec<FunctionInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.functions(schema).await,
            Self::Sqlite(d) => d.functions().await,
            Self::Clickhouse(d) => d.functions().await,
            Self::MySql(d) => d.functions(schema).await,
            Self::Mssql(d) => d.functions(schema).await,
            Self::Redis(_) => Ok(Vec::new()),
            Self::Nats(_) => Ok(Vec::new()),
            Self::Kafka(_) => Ok(Vec::new()),
            Self::Cassandra(_) => Ok(Vec::new()),
            Self::Mongo(_) => Ok(Vec::new()),
            Self::Oracle(d) => d.functions(schema).await,
        }
    }

    pub async fn triggers(&mut self, schema: &str) -> Result<Vec<TriggerInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.triggers(schema).await,
            Self::MySql(d) => d.triggers(schema).await,
            Self::Mssql(d) => d.triggers(schema).await,
            Self::Sqlite(d) => d.triggers(schema).await,
            Self::Clickhouse(_) => Ok(Vec::new()),
            Self::Redis(_) => Ok(Vec::new()),
            Self::Nats(_) => Ok(Vec::new()),
            Self::Kafka(_) => Ok(Vec::new()),
            Self::Cassandra(_) => Ok(Vec::new()),
            Self::Mongo(_) => Ok(Vec::new()),
            Self::Oracle(d) => d.triggers(schema).await,
        }
    }

    pub async fn sequences(&mut self, schema: &str) -> Result<Vec<SequenceInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.sequences(schema).await,
            Self::Oracle(d) => d.sequences(schema).await,
            // MySQL/MariaDB/MSSQL(Phase1)/SQLite: no sequences node
            _ => Ok(Vec::new()),
        }
    }

    /// Foreign keys của schema (ER Diagram · Phase 5). Hệ không quan hệ / không FK → rỗng.
    pub async fn foreign_keys(&mut self, schema: &str) -> Result<Vec<ForeignKey>, QueryError> {
        match self {
            Self::Postgres(d) => d.foreign_keys(schema).await,
            Self::MySql(d) => d.foreign_keys(schema).await,
            Self::Mssql(d) => d.foreign_keys(schema).await,
            Self::Sqlite(d) => d.foreign_keys(schema).await,
            Self::Oracle(d) => d.foreign_keys(schema).await,
            _ => Ok(Vec::new()),
        }
    }

    /// Partitions of a table (declarative partitioning). Non-partitioned tables
    /// and engines without partitioning return an empty list.
    pub async fn partitions(
        &mut self,
        schema: &str,
        table: &str,
    ) -> Result<Vec<PartitionInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.partitions(schema, table).await,
            Self::MySql(d) => d.partitions(schema, table).await,
            Self::Mssql(d) => d.partitions(schema, table).await,
            Self::Clickhouse(d) => d.partitions(schema, table).await,
            Self::Cassandra(d) => d.partitions(schema, table).await,
            Self::Sqlite(_) => Ok(Vec::new()),
            Self::Redis(_) => Ok(Vec::new()),
            Self::Nats(_) => Ok(Vec::new()),
            Self::Kafka(_) => Ok(Vec::new()),
            // Mongo sharding ≠ declarative partitioning (ngoài parity core).
            Self::Mongo(_) => Ok(Vec::new()),
            Self::Oracle(d) => d.partitions(schema, table).await,
        }
    }

    /// Index Scanner (Phase 5 · T7b): quét index toàn schema + tính cờ sức khỏe.
    pub async fn scan_indexes(
        &mut self,
        schema: &str,
    ) -> Result<index_scan::IndexScanResult, QueryError> {
        let (system, mut rows, suggestions) = match self {
            Self::Postgres(d) => (
                "postgres",
                d.scan_indexes(schema).await?,
                d.missing_indexes(schema).await.unwrap_or_default(),
            ),
            Self::MySql(d) => (d.system_name(), d.scan_indexes(schema).await?, Vec::new()),
            Self::Sqlite(d) => ("sqlite", d.scan_indexes(schema).await?, Vec::new()),
            Self::Mssql(d) => (
                "mssql",
                d.scan_indexes(schema).await?,
                d.missing_indexes(schema).await.unwrap_or_default(),
            ),
            Self::Clickhouse(d) => ("clickhouse", d.scan_indexes(schema).await?, Vec::new()),
            Self::Cassandra(d) => ("cassandra", d.scan_indexes(schema).await?, Vec::new()),
            Self::Mongo(d) => ("mongodb", d.scan_indexes(schema).await?, Vec::new()),
            Self::Oracle(d) => ("oracle", d.scan_indexes(schema).await?, Vec::new()),
            #[allow(unreachable_patterns)]
            _ => {
                return Ok(index_scan::IndexScanResult {
                    system: "unknown".into(),
                    scope: schema.to_string(),
                    indexes: Vec::new(),
                    summary: index_scan::compute_flags(&mut []),
                    suggestions: Vec::new(),
                })
            }
        };
        let summary = index_scan::compute_flags(&mut rows);
        Ok(index_scan::IndexScanResult {
            system: system.to_string(),
            scope: schema.to_string(),
            indexes: rows,
            summary,
            suggestions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::profile::{Environment, SqliteMode, SshConfig};

    fn tls_profile(system: SystemType) -> ConnectionProfile {
        ConnectionProfile {
            id: "t".into(),
            name: "t".into(),
            system,
            host: "h".into(),
            port: 1234,
            database: "db".into(),
            user: "u".into(),
            password_enc: String::new(),
            group: String::new(),
            env: Environment::Development,
            ssh: SshConfig::default(),
            ssl: true,
            ssl_ca: "/ca.pem".into(),
            ssl_cert: "/client.crt".into(),
            ssl_key: "/client.key".into(),
            sqlite_path: String::new(),
            sqlite_mode: SqliteMode::ReadWrite,
            mssql_auth: String::new(),
            schema_registry_url: String::new(),
            cassandra_dc: String::new(),
            cassandra_consistency: String::new(),
        }
    }

    fn ep() -> Endpoint {
        Endpoint { host: "h".into(), port: 1234 }
    }

    // Phase 3 · T1: cert paths phải chảy từ profile → ConnParams của mọi driver.
    #[test]
    fn tls_cert_paths_propagate_to_conn_params() {
        let pg = pg_params(&tls_profile(SystemType::Postgres), &ep(), "pw");
        assert_eq!((pg.ssl, pg.ssl_ca.as_str(), pg.ssl_cert.as_str(), pg.ssl_key.as_str()),
                   (true, "/ca.pem", "/client.crt", "/client.key"));

        let my = mysql_params(&tls_profile(SystemType::Mysql), &ep(), "pw");
        assert_eq!((my.ssl, my.ssl_ca.as_str(), my.ssl_cert.as_str(), my.ssl_key.as_str()),
                   (true, "/ca.pem", "/client.crt", "/client.key"));

        // MSSQL: chỉ CA (tiberius không mTLS).
        let ms = mssql_params(&tls_profile(SystemType::Mssql), &ep(), "pw");
        assert!(ms.ssl);
        assert_eq!(ms.ssl_ca, "/ca.pem");
    }
}
