//! Driver layer: one adapter per system, unified behind `LiveConnection`.

pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod sqlite;
pub mod types;
pub mod util;

use crate::connections::profile::{ConnectionProfile, SqliteMode};
use crate::drivers::types::*;
use crate::error::QueryError;

use mssql::{MssqlConnParams, MssqlDriver};
use mysql::{MySqlConnParams, MySqlDriver};
use postgres::{PgConnParams, PgDriver};
use sqlite::{SqliteConnParams, SqliteDriver};

/// Effective network endpoint: profile host/port, or the local end of an SSH
/// tunnel when one is active.
#[derive(Clone)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}

pub enum LiveConnection {
    Postgres(PgDriver),
    MySql(MySqlDriver),
    Mssql(MssqlDriver),
    Sqlite(SqliteDriver),
}

fn pg_params(p: &ConnectionProfile, ep: &Endpoint, password: &str) -> PgConnParams {
    PgConnParams {
        host: ep.host.clone(),
        port: ep.port,
        database: p.database.clone(),
        user: p.user.clone(),
        password: password.to_string(),
        ssl: p.ssl,
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
        auth: if p.mssql_auth.is_empty() { "sql".into() } else { p.mssql_auth.clone() },
    }
}

fn sqlite_params(p: &ConnectionProfile) -> SqliteConnParams {
    SqliteConnParams {
        path: p.sqlite_path.clone(),
        mode: if p.sqlite_path.is_empty() { SqliteMode::InMemory } else { p.sqlite_mode },
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
            SystemType::Sqlite => Ok(Self::Sqlite(
                SqliteDriver::connect(&sqlite_params(profile)).await?,
            )),
            other => Err(QueryError::new(
                other.as_str(),
                format!("Hệ {} chưa được hỗ trợ ở Phase 1", other.as_str()),
                "unsupported system in phase 1",
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
            SystemType::Sqlite => SqliteDriver::test(&sqlite_params(profile)).await,
            other => TestResult {
                ok: false,
                latency_ms: None,
                server_version: None,
                error: Some(format!("Hệ {} chưa được hỗ trợ ở Phase 1", other.as_str())),
            },
        }
    }

    pub async fn exec(&mut self, sql: &str) -> Result<StatementOutcome, QueryError> {
        match self {
            Self::Postgres(d) => d.exec(sql).await,
            Self::MySql(d) => d.exec(sql).await,
            Self::Mssql(d) => d.exec(sql).await,
            Self::Sqlite(d) => d.exec(sql).await,
        }
    }

    pub async fn ping(&mut self) -> bool {
        match self {
            Self::Postgres(d) => d.ping().await,
            Self::MySql(d) => d.ping().await,
            Self::Mssql(d) => d.ping().await,
            Self::Sqlite(d) => d.ping().await,
        }
    }

    // ---- introspection dispatch ---------------------------------------------

    pub async fn schemas(&mut self) -> Result<Vec<SchemaInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.schemas().await,
            Self::MySql(d) => d.schemas().await,
            Self::Mssql(d) => d.schemas().await,
            Self::Sqlite(d) => d.schemas().await,
        }
    }

    pub async fn tables(&mut self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.tables(schema).await,
            Self::MySql(d) => d.tables(schema).await,
            Self::Mssql(d) => d.tables(schema).await,
            Self::Sqlite(d) => d.tables(schema).await,
        }
    }

    pub async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.columns(schema, table).await,
            Self::MySql(d) => d.columns(schema, table).await,
            Self::Mssql(d) => d.columns(schema, table).await,
            Self::Sqlite(d) => d.columns(schema, table).await,
        }
    }

    pub async fn indexes(&mut self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.indexes(schema, table).await,
            Self::MySql(d) => d.indexes(schema, table).await,
            Self::Mssql(d) => d.indexes(schema, table).await,
            Self::Sqlite(d) => d.indexes(schema, table).await,
        }
    }

    pub async fn constraints(&mut self, schema: &str, table: &str) -> Result<Vec<ConstraintInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.constraints(schema, table).await,
            Self::MySql(d) => d.constraints(schema, table).await,
            Self::Mssql(d) => d.constraints(schema, table).await,
            // SQLite: PK/unique come from indexes; FKs from foreign_key_list.
            Self::Sqlite(_) => Ok(Vec::new()),
        }
    }

    pub async fn routines(&mut self, schema: &str) -> Result<Vec<RoutineInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.routines(schema).await,
            Self::MySql(d) => d.routines(schema).await,
            Self::Mssql(d) => d.routines(schema).await,
            Self::Sqlite(_) => Ok(Vec::new()), // SQLite has no stored routines
        }
    }

    pub async fn triggers(&mut self, schema: &str) -> Result<Vec<TriggerInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.triggers(schema).await,
            Self::MySql(d) => d.triggers(schema).await,
            Self::Mssql(d) => d.triggers(schema).await,
            Self::Sqlite(d) => d.triggers(schema).await,
        }
    }

    pub async fn sequences(&mut self, schema: &str) -> Result<Vec<SequenceInfo>, QueryError> {
        match self {
            Self::Postgres(d) => d.sequences(schema).await,
            // MySQL/MariaDB/MSSQL(Phase1)/SQLite: no sequences node
            _ => Ok(Vec::new()),
        }
    }
}
