//! SQL Server driver — tiberius over tokio TCP (rustls).

use serde_json::{json, Map, Value};
use std::time::Instant;
use tiberius::{AuthMethod, Client, ColumnType, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use crate::drivers::types::*;
use crate::drivers::util;
use crate::error::{ErrorPosition, QueryError};

pub struct MssqlDriver {
    client: Client<Compat<TcpStream>>,
}

pub struct MssqlConnParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: String,
    pub ssl: bool,
    /// CA cert path (empty = trust server cert, phù hợp self-signed nội bộ).
    pub ssl_ca: String,
    /// "sql" (default) | "windows"
    pub auth: String,
}

impl MssqlDriver {
    pub async fn connect(p: &MssqlConnParams) -> Result<Self, QueryError> {
        let mut config = Config::new();
        config.host(&p.host);
        config.port(p.port);
        if !p.database.is_empty() {
            config.database(&p.database);
        }
        if p.auth == "windows" {
            #[cfg(windows)]
            config.authentication(AuthMethod::Integrated);
            #[cfg(not(windows))]
            return Err(QueryError::new(
                "mssql",
                "Windows Authentication is only available on Windows",
                "integrated auth unsupported on this OS",
            ));
        } else if p.auth == "aad-sp" {
            // Azure AD Service Principal (T31): user = "clientId@tenant",
            // password = client secret → acquire an access token → aad_token.
            let (client_id, tenant) = crate::connections::aad::parse_sp_user(&p.user).ok_or_else(|| {
                QueryError::new("mssql", "Azure AD Service Principal user must be \"clientId@tenant\"", "aad user format")
            })?;
            let token = crate::connections::aad::acquire_sp_token(&tenant, &client_id, &p.password).await?;
            config.authentication(AuthMethod::aad_token(token));
        } else {
            config.authentication(AuthMethod::sql_server(&p.user, &p.password));
        }
        if p.ssl {
            config.encryption(EncryptionLevel::Required);
        } else {
            config.encryption(EncryptionLevel::NotSupported);
        }
        // Có CA path → xác thực chuỗi cert với CA đó; không thì trust server cert
        // (self-signed nội bộ là phổ biến với desktop client).
        if !p.ssl_ca.is_empty() {
            config.trust_cert_ca(&p.ssl_ca);
        } else {
            config.trust_cert();
        }

        let tcp = TcpStream::connect((p.host.as_str(), p.port))
            .await
            .map_err(|e| QueryError::new("mssql", format!("Failed to connect to {}:{} — {e}", p.host, p.port), e.to_string()))?;
        tcp.set_nodelay(true)
            .map_err(|e| QueryError::new("mssql", e.to_string(), e.to_string()))?;
        let client = Client::connect(config, tcp.compat_write())
            .await
            .map_err(|e| map_error(&e))?;
        Ok(Self { client })
    }

    pub async fn test(p: &MssqlConnParams) -> TestResult {
        let started = Instant::now();
        match Self::connect(p).await {
            Ok(mut drv) => {
                let version = drv.scalar_string("SELECT @@VERSION").await;
                TestResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u64),
                    server_version: version.map(|v| v.lines().next().unwrap_or_default().to_string()),
                    error: None,
                }
            }
            Err(e) => TestResult { ok: false, latency_ms: None, server_version: None, error: Some(e.message) },
        }
    }

    async fn scalar_string(&mut self, sql: &str) -> Option<String> {
        let stream = self.client.simple_query(sql).await.ok()?;
        let row = stream.into_row().await.ok()??;
        row.get::<&str, _>(0).map(|s| s.to_string())
    }

    pub async fn exec(&mut self, sql: &str) -> Result<StatementOutcome, QueryError> {
        if util::returns_rows(sql) {
            let mut stream = self.client.simple_query(sql).await.map_err(|e| map_error(&e))?;
            let cols_meta = stream
                .columns()
                .await
                .map_err(|e| map_error(&e))?
                .map(|cols| {
                    cols.iter()
                        .map(|c| (c.name().to_string(), type_name(c.column_type())))
                        .collect::<Vec<ColumnDef>>()
                })
                .unwrap_or_default();
            let results = stream.into_results().await.map_err(|e| map_error(&e))?;
            let rows_flat: Vec<tiberius::Row> = results.into_iter().flatten().collect();
            let mut out_rows: Vec<Value> = Vec::new();
            for row in &rows_flat {
                let mut obj = Map::new();
                for (i, col) in row.columns().iter().enumerate() {
                    obj.insert(col.name().to_string(), decode_value(row, i, col.column_type()));
                }
                out_rows.push(Value::Object(obj));
            }
            let total = out_rows.len() as u64;
            Ok(StatementOutcome::Rows {
                result: QueryResultSet { cols: cols_meta, rows: out_rows, total },
            })
        } else if sql.trim_start().get(..4).map(|s| s.eq_ignore_ascii_case("set ")).unwrap_or(false) {
            // Session options (SET SHOWPLAN_XML/NOCOUNT/…) phải chạy như raw batch
            // để giữ trạng thái trên connection. `execute()` dùng sp_executesql →
            // SET nằm trong scope riêng, KHÔNG persist sang statement kế tiếp.
            self.client
                .simple_query(sql)
                .await
                .map_err(|e| map_error(&e))?
                .into_results()
                .await
                .map_err(|e| map_error(&e))?;
            Ok(StatementOutcome::Ok)
        } else {
            let res = self.client.execute(sql, &[]).await.map_err(|e| map_error(&e))?;
            if util::is_dml(sql) {
                Ok(StatementOutcome::Affected { affected: res.total() })
            } else {
                Ok(StatementOutcome::Ok)
            }
        }
    }

    pub async fn ping(&mut self) -> bool {
        self.client.simple_query("SELECT 1").await.is_ok()
    }

    /// SELECT tham số hóa (filter builder / pagination).
    pub async fn exec_params(
        &mut self,
        sql: &str,
        params: &[Value],
    ) -> Result<StatementOutcome, QueryError> {
        let owned: Vec<MssqlParam> = params.iter().map(MssqlParam::from_json).collect();
        let refs: Vec<&dyn tiberius::ToSql> = owned.iter().map(|p| p as &dyn tiberius::ToSql).collect();
        let stream = self.client.query(sql, &refs).await.map_err(|e| map_error(&e))?;
        let rows = stream.into_first_result().await.map_err(|e| map_error(&e))?;
        let mut cols: Vec<ColumnDef> = Vec::new();
        if let Some(first) = rows.first() {
            for c in first.columns() {
                cols.push((c.name().to_string(), type_name(c.column_type())));
            }
        }
        let mut out_rows: Vec<Value> = Vec::new();
        for row in &rows {
            let mut obj = Map::new();
            for (i, col) in row.columns().iter().enumerate() {
                obj.insert(col.name().to_string(), decode_value(row, i, col.column_type()));
            }
            out_rows.push(Value::Object(obj));
        }
        let total = out_rows.len() as u64;
        Ok(StatementOutcome::Rows { result: QueryResultSet { cols, rows: out_rows, total } })
    }

    /// Editable grid: pending changes trong 1 transaction (BEGIN TRAN/COMMIT/
    /// ROLLBACK). Param @P1.. bind qua tiberius ToSql (không nối chuỗi).
    pub async fn apply_changes(
        &mut self,
        changes: &[crate::drivers::grid::GridChange],
    ) -> Result<u64, QueryError> {
        self.client
            .simple_query("BEGIN TRANSACTION")
            .await
            .map_err(|e| map_error(&e))?;
        let mut total = 0u64;
        for ch in changes {
            let stmt = crate::drivers::grid::build("mssql", ch);
            let owned: Vec<MssqlParam> = stmt.params.iter().map(MssqlParam::from_json).collect();
            let refs: Vec<&dyn tiberius::ToSql> =
                owned.iter().map(|p| p as &dyn tiberius::ToSql).collect();
            match self.client.execute(&stmt.sql, &refs).await {
                Ok(res) => total += res.total(),
                Err(e) => {
                    let _ = self.client.simple_query("ROLLBACK").await;
                    return Err(map_error(&e));
                }
            }
        }
        self.client
            .simple_query("COMMIT")
            .await
            .map_err(|e| map_error(&e))?;
        Ok(total)
    }

    // ---- introspection ------------------------------------------------------

    pub async fn schemas(&mut self) -> Result<Vec<SchemaInfo>, QueryError> {
        let stream = self
            .client
            .simple_query(
                "SELECT s.name, CASE WHEN s.name = SCHEMA_NAME() THEN 1 ELSE 0 END
                 FROM sys.schemas s
                 WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin',
                   'db_securityadmin','db_ddladmin','db_backupoperator','db_datareader','db_datawriter',
                   'db_denydatareader','db_denydatawriter')
                 ORDER BY s.name",
            )
            .await
            .map_err(|e| map_error(&e))?;
        let rows = stream.into_first_result().await.map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| SchemaInfo {
                name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                is_default: r.get::<i32, _>(1).unwrap_or(0) == 1,
            })
            .collect())
    }

    /// All databases on the server (MSSQL can cross-query, but the Explorer opens
    /// each as its own connection like Postgres). Excludes the system databases.
    pub async fn databases(&mut self) -> Result<Vec<DatabaseInfo>, QueryError> {
        let stream = self
            .client
            .simple_query(
                "SELECT name, CASE WHEN name = DB_NAME() THEN 1 ELSE 0 END
                 FROM sys.databases
                 WHERE database_id > 4 AND state = 0
                 ORDER BY name",
            )
            .await
            .map_err(|e| map_error(&e))?;
        let rows = stream.into_first_result().await.map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| DatabaseInfo {
                name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                current: r.get::<i32, _>(1).unwrap_or(0) == 1,
            })
            .collect())
    }

    pub async fn tables(&mut self, schema: &str) -> Result<Vec<TableInfo>, QueryError> {
        let rows = self
            .client
            .query(
                "SELECT o.name,
                        CASE o.type WHEN 'V' THEN 'view' ELSE 'table' END,
                        COALESCE(p.row_count, 0)
                 FROM sys.objects o
                 LEFT JOIN (
                   SELECT object_id, SUM(rows) AS row_count
                   FROM sys.partitions WHERE index_id IN (0, 1) GROUP BY object_id
                 ) p ON p.object_id = o.object_id
                 WHERE o.type IN ('U','V') AND SCHEMA_NAME(o.schema_id) = @P1
                 ORDER BY o.name",
                &[&schema],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| TableInfo {
                schema: schema.to_string(),
                name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                kind: r.get::<&str, _>(1).unwrap_or("table").to_string(),
                row_estimate: r.get::<i64, _>(2),
                locked: false,
                engine: None,
            })
            .collect())
    }

    pub async fn columns(&mut self, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, QueryError> {
        let rows = self
            .client
            .query(
                "SELECT c.name,
                        CONCAT(ty.name,
                          CASE WHEN ty.name IN ('varchar','char','varbinary','binary')
                               THEN CONCAT('(', IIF(c.max_length = -1, 'max', CAST(c.max_length AS varchar(10))), ')')
                               WHEN ty.name IN ('nvarchar','nchar')
                               THEN CONCAT('(', IIF(c.max_length = -1, 'max', CAST(c.max_length / 2 AS varchar(10))), ')')
                               WHEN ty.name IN ('decimal','numeric')
                               THEN CONCAT('(', c.precision, ',', c.scale, ')')
                               ELSE '' END),
                        c.is_nullable,
                        OBJECT_DEFINITION(c.default_object_id),
                        IIF(pk.column_id IS NOT NULL, 1, 0),
                        IIF(fk.parent_column_id IS NOT NULL, 1, 0),
                        c.column_id
                 FROM sys.columns c
                 JOIN sys.objects o ON o.object_id = c.object_id
                 JOIN sys.types ty ON ty.user_type_id = c.user_type_id
                 LEFT JOIN (
                   SELECT ic.object_id, ic.column_id
                   FROM sys.index_columns ic
                   JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                   WHERE i.is_primary_key = 1
                 ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
                 LEFT JOIN sys.foreign_key_columns fk
                   ON fk.parent_object_id = c.object_id AND fk.parent_column_id = c.column_id
                 WHERE SCHEMA_NAME(o.schema_id) = @P1 AND o.name = @P2
                 ORDER BY c.column_id",
                &[&schema, &table],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| ColumnInfo {
                name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                data_type: r.get::<&str, _>(1).unwrap_or_default().to_string(),
                nullable: r.get::<bool, _>(2).unwrap_or(true),
                default: r.get::<&str, _>(3).map(|s| s.to_string()),
                is_pk: r.get::<i32, _>(4).unwrap_or(0) == 1,
                is_fk: r.get::<i32, _>(5).unwrap_or(0) == 1,
                ordinal: r.get::<i32, _>(6).unwrap_or(0),
            })
            .collect())
    }

    pub async fn indexes(&mut self, schema: &str, table: &str) -> Result<Vec<IndexInfo>, QueryError> {
        let rows = self
            .client
            .query(
                "SELECT i.name, i.type_desc, i.is_unique, i.is_primary_key, c.name
                 FROM sys.indexes i
                 JOIN sys.objects o ON o.object_id = i.object_id
                 JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                 WHERE SCHEMA_NAME(o.schema_id) = @P1 AND o.name = @P2 AND i.name IS NOT NULL
                 ORDER BY i.name, ic.key_ordinal",
                &[&schema, &table],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        let mut out: Vec<IndexInfo> = Vec::new();
        for r in &rows {
            let name = r.get::<&str, _>(0).unwrap_or_default().to_string();
            let col = r.get::<&str, _>(4).unwrap_or_default().to_string();
            if let Some(existing) = out.iter_mut().find(|i| i.name == name) {
                existing.columns.push(col);
            } else {
                out.push(IndexInfo {
                    name,
                    method: r.get::<&str, _>(1).unwrap_or_default().to_string(),
                    unique: r.get::<bool, _>(2).unwrap_or(false),
                    primary: r.get::<bool, _>(3).unwrap_or(false),
                    columns: vec![col],
                });
            }
        }
        Ok(out)
    }

    pub async fn constraints(&mut self, schema: &str, table: &str) -> Result<Vec<ConstraintInfo>, QueryError> {
        let rows = self
            .client
            .query(
                "SELECT kc.name,
                        CASE kc.type WHEN 'PK' THEN 'PK' WHEN 'UQ' THEN 'UNIQUE' ELSE kc.type END,
                        NULL
                 FROM sys.key_constraints kc
                 JOIN sys.objects o ON o.object_id = kc.parent_object_id
                 WHERE SCHEMA_NAME(o.schema_id) = @P1 AND o.name = @P2
                 UNION ALL
                 SELECT fk.name, 'FK', NULL
                 FROM sys.foreign_keys fk
                 JOIN sys.objects o ON o.object_id = fk.parent_object_id
                 WHERE SCHEMA_NAME(o.schema_id) = @P1 AND o.name = @P2
                 UNION ALL
                 SELECT cc.name, 'CHECK', cc.definition
                 FROM sys.check_constraints cc
                 JOIN sys.objects o ON o.object_id = cc.parent_object_id
                 WHERE SCHEMA_NAME(o.schema_id) = @P1 AND o.name = @P2
                 ORDER BY 1",
                &[&schema, &table],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| ConstraintInfo {
                name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                kind: r.get::<&str, _>(1).unwrap_or_default().to_string(),
                definition: r.get::<&str, _>(2).map(|s| s.to_string()),
            })
            .collect())
    }

    pub async fn routines(&mut self, schema: &str) -> Result<Vec<RoutineInfo>, QueryError> {
        let rows = self
            .client
            .query(
                "SELECT o.name,
                        CASE o.type
                          WHEN 'P'  THEN 'procedure'
                          WHEN 'FN' THEN 'scalar_function'
                          WHEN 'IF' THEN 'table_function'
                          WHEN 'TF' THEN 'table_function'
                          ELSE 'function' END
                 FROM sys.objects o
                 WHERE o.type IN ('P','FN','IF','TF') AND SCHEMA_NAME(o.schema_id) = @P1
                 ORDER BY o.name",
                &[&schema],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        let metas: Vec<(String, String)> = rows
            .iter()
            .map(|r| {
                (
                    r.get::<&str, _>(0).unwrap_or_default().to_string(),
                    r.get::<&str, _>(1).unwrap_or_default().to_string(),
                )
            })
            .collect();
        let mut out = Vec::new();
        for (name, kind) in metas {
            let params = self.routine_params(schema, &name).await.unwrap_or_default();
            let return_type = params
                .iter()
                .find(|p| p.name.is_empty())
                .map(|p| p.data_type.clone());
            let params: Vec<ParamInfo> = params.into_iter().filter(|p| !p.name.is_empty()).collect();
            out.push(RoutineInfo { schema: schema.to_string(), name, kind, params, return_type });
        }
        Ok(out)
    }

    async fn routine_params(&mut self, schema: &str, routine: &str) -> Result<Vec<ParamInfo>, QueryError> {
        let rows = self
            .client
            .query(
                "SELECT COALESCE(p.name, ''), ty.name, IIF(p.is_output = 1, 'OUT', 'IN')
                 FROM sys.parameters p
                 JOIN sys.objects o ON o.object_id = p.object_id
                 JOIN sys.types ty ON ty.user_type_id = p.user_type_id
                 WHERE SCHEMA_NAME(o.schema_id) = @P1 AND o.name = @P2
                 ORDER BY p.parameter_id",
                &[&schema, &routine],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| ParamInfo {
                name: r.get::<&str, _>(0).unwrap_or_default().trim_start_matches('@').to_string(),
                data_type: r.get::<&str, _>(1).unwrap_or_default().to_string(),
                mode: r.get::<&str, _>(2).unwrap_or("IN").to_string(),
                default: None,
            })
            .collect())
    }

    pub async fn triggers(&mut self, schema: &str) -> Result<Vec<TriggerInfo>, QueryError> {
        let rows = self
            .client
            .query(
                // FOR XML PATH concat instead of STRING_AGG (which needs SQL Server 2017+).
                "SELECT t.name, OBJECT_NAME(t.parent_id),
                        STUFF((SELECT ',' + te.type_desc
                               FROM sys.trigger_events te WHERE te.object_id = t.object_id
                               FOR XML PATH('')), 1, 1, '')
                 FROM sys.triggers t
                 JOIN sys.objects o ON o.object_id = t.object_id
                 WHERE SCHEMA_NAME(o.schema_id) = @P1 AND t.parent_class = 1
                 ORDER BY t.name",
                &[&schema],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| TriggerInfo {
                schema: schema.to_string(),
                name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                table: r.get::<&str, _>(1).unwrap_or_default().to_string(),
                event: r.get::<&str, _>(2).unwrap_or_default().to_string(),
            })
            .collect())
    }

    pub async fn scan_indexes(&mut self, schema: &str) -> Result<Vec<crate::drivers::index_scan::IndexScanRow>, QueryError> {
        let rows = self
            .client
            .query(
                "SELECT i.name, t.name AS tbl,
                        (SELECT STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal)
                         FROM sys.index_columns ic
                         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0),
                        i.type_desc, i.is_unique, i.is_primary_key,
                        ISNULL(us.user_seeks + us.user_scans + us.user_lookups, 0) AS usage
                 FROM sys.indexes i
                 JOIN sys.tables t ON t.object_id = i.object_id
                 LEFT JOIN sys.dm_db_index_usage_stats us ON us.object_id = i.object_id AND us.index_id = i.index_id
                 WHERE SCHEMA_NAME(t.schema_id) = @P1 AND i.type <> 0 AND i.name IS NOT NULL
                 ORDER BY t.name, i.name",
                &[&schema],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| crate::drivers::index_scan::IndexScanRow {
                name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                table: r.get::<&str, _>(1).unwrap_or_default().to_string(),
                columns: r
                    .get::<&str, _>(2)
                    .unwrap_or_default()
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect(),
                index_type: r.get::<&str, _>(3).unwrap_or("").to_string(),
                unique: r.get::<bool, _>(4).unwrap_or(false),
                primary: r.get::<bool, _>(5).unwrap_or(false),
                usage: r.get::<i64, _>(6),
                size_bytes: None,
                fragmentation_pct: None,
                valid: true,
                flags: Vec::new(),
            })
            .collect())
    }

    /// Missing-index gợi ý từ DMV sys.dm_db_missing_index_* — T17.
    pub async fn missing_indexes(
        &mut self,
        schema: &str,
    ) -> Result<Vec<crate::drivers::index_scan::MissingIndexSuggestion>, QueryError> {
        let rows = self
            .client
            .query(
                "SELECT OBJECT_NAME(d.object_id) AS tbl,
                        ISNULL(d.equality_columns, '') +
                          CASE WHEN d.inequality_columns IS NOT NULL
                               THEN ',' + d.inequality_columns ELSE '' END AS cols,
                        CAST(gs.avg_user_impact AS float) AS impact,
                        CAST(gs.user_seeks AS bigint) AS seeks
                 FROM sys.dm_db_missing_index_details d
                 JOIN sys.dm_db_missing_index_groups g ON g.index_handle = d.index_handle
                 JOIN sys.dm_db_missing_index_group_stats gs ON gs.group_handle = g.index_group_handle
                 WHERE d.database_id = DB_ID() AND OBJECT_SCHEMA_NAME(d.object_id) = @P1
                 ORDER BY gs.avg_user_impact DESC",
                &[&schema],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| {
                let impact = r.get::<f64, _>(2).unwrap_or(0.0);
                let seeks = r.get::<i64, _>(3).unwrap_or(0);
                crate::drivers::index_scan::MissingIndexSuggestion {
                    table: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                    columns: r
                        .get::<&str, _>(1)
                        .unwrap_or_default()
                        .replace(['[', ']'], "")
                        .split(',')
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| s.trim().to_string())
                        .collect(),
                    reason: format!("missing index (impact {impact:.0}%, {seeks} seeks)"),
                    estimated_benefit: Some(impact),
                }
            })
            .collect())
    }

    pub async fn foreign_keys(&mut self, schema: &str) -> Result<Vec<ForeignKey>, QueryError> {
        let rows = self
            .client
            .query(
                "SELECT fk.name, OBJECT_NAME(fkc.parent_object_id), pc.name,
                        OBJECT_NAME(fkc.referenced_object_id), rc.name
                 FROM sys.foreign_keys fk
                 JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
                 JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
                 JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                 WHERE SCHEMA_NAME(fk.schema_id) = @P1
                 ORDER BY OBJECT_NAME(fkc.parent_object_id), fk.name",
                &[&schema],
            )
            .await
            .map_err(|e| map_error(&e))?
            .into_first_result()
            .await
            .map_err(|e| map_error(&e))?;
        Ok(rows
            .iter()
            .map(|r| ForeignKey {
                name: r.get::<&str, _>(0).unwrap_or_default().to_string(),
                from_table: r.get::<&str, _>(1).unwrap_or_default().to_string(),
                from_column: r.get::<&str, _>(2).unwrap_or_default().to_string(),
                to_table: r.get::<&str, _>(3).unwrap_or_default().to_string(),
                to_column: r.get::<&str, _>(4).unwrap_or_default().to_string(),
            })
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

fn type_name(t: ColumnType) -> String {
    let name = match t {
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 => "int",
        ColumnType::Int8 | ColumnType::Intn => "bigint",
        ColumnType::Float4 => "real",
        ColumnType::Float8 | ColumnType::Floatn => "float",
        ColumnType::Money | ColumnType::Money4 => "money",
        ColumnType::Decimaln | ColumnType::Numericn => "decimal",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::Datetime | ColumnType::Datetime4 | ColumnType::Datetimen => "datetime",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::BigVarChar | ColumnType::Text => "varchar",
        ColumnType::BigChar => "char",
        ColumnType::NVarchar | ColumnType::NText => "nvarchar",
        ColumnType::NChar => "nchar",
        ColumnType::BigVarBin | ColumnType::Image => "varbinary",
        ColumnType::BigBinary => "binary",
        ColumnType::Xml => "xml",
        ColumnType::Null => "null",
        _ => "sql_variant",
    };
    name.to_string()
}

fn decode_value(row: &tiberius::Row, idx: usize, t: ColumnType) -> Value {
    match t {
        ColumnType::Bit | ColumnType::Bitn => row
            .try_get::<bool, _>(idx)
            .ok()
            .flatten()
            .map(Value::Bool)
            .unwrap_or(Value::Null),
        ColumnType::Int1 => row
            .try_get::<u8, _>(idx)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        ColumnType::Int2 => row
            .try_get::<i16, _>(idx)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        ColumnType::Int4 => row
            .try_get::<i32, _>(idx)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        ColumnType::Int8 => row
            .try_get::<i64, _>(idx)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        ColumnType::Intn => row
            .try_get::<i64, _>(idx)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .or_else(|| row.try_get::<i32, _>(idx).ok().flatten().map(|v| json!(v)))
            .or_else(|| row.try_get::<i16, _>(idx).ok().flatten().map(|v| json!(v)))
            .or_else(|| row.try_get::<u8, _>(idx).ok().flatten().map(|v| json!(v)))
            .unwrap_or(Value::Null),
        ColumnType::Float4 => row
            .try_get::<f32, _>(idx)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        ColumnType::Float8 | ColumnType::Floatn => row
            .try_get::<f64, _>(idx)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .or_else(|| row.try_get::<f32, _>(idx).ok().flatten().map(|v| json!(v)))
            .unwrap_or(Value::Null),
        ColumnType::Decimaln | ColumnType::Numericn | ColumnType::Money | ColumnType::Money4 => row
            .try_get::<rust_decimal::Decimal, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::String(v.to_string()))
            .or_else(|| row.try_get::<f64, _>(idx).ok().flatten().map(|v| json!(v)))
            .unwrap_or(Value::Null),
        ColumnType::Guid => row
            .try_get::<uuid::Uuid, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        ColumnType::Datetime
        | ColumnType::Datetime4
        | ColumnType::Datetimen
        | ColumnType::Datetime2 => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::String(v.format("%Y-%m-%dT%H:%M:%S%.f").to_string()))
            .unwrap_or(Value::Null),
        ColumnType::DatetimeOffsetn => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::String(v.to_rfc3339()))
            .unwrap_or(Value::Null),
        ColumnType::Daten => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        ColumnType::Timen => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null),
        ColumnType::BigVarBin | ColumnType::BigBinary | ColumnType::Image => row
            .try_get::<&[u8], _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::String(format!("0x{}", v.iter().map(|b| format!("{b:02x}")).collect::<String>())))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<&str, _>(idx)
            .ok()
            .flatten()
            .map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null),
    }
}

// ---------------------------------------------------------------------------
// Error mapping — MSSQL provides error number + line within the batch
// ---------------------------------------------------------------------------

fn map_error(e: &tiberius::error::Error) -> QueryError {
    match e {
        tiberius::error::Error::Server(te) => {
            let mut qe = QueryError::new("mssql", te.message().to_string(), format!("{te:?}"));
            qe.code = Some(te.code().to_string());
            let line = te.line();
            if line > 0 {
                qe.position = Some(ErrorPosition { line: line as u32, col: 1 });
            }
            qe.hint = hint_for_code(te.code());
            qe
        }
        other => QueryError::new("mssql", other.to_string(), other.to_string()),
    }
}

fn hint_for_code(code: u32) -> Option<String> {
    let hint = match code {
        208 => "Table or object does not exist. Check the name and schema (dbo.*).",
        207 => "Column does not exist. Check the column name.",
        102 | 156 => "T-SQL syntax error. Note MSSQL uses TOP instead of LIMIT.",
        18456 => "Login failed — wrong user/password or the user is locked.",
        4060 => "Failed to open database. Check the database name and permissions.",
        2627 | 2601 => "UNIQUE/PRIMARY KEY constraint violation.",
        547 => "Foreign key or CHECK constraint violation.",
        515 => "NOT NULL column cannot be empty.",
        _ => return None,
    };
    Some(hint.to_string())
}

/// Owned param cho tiberius (homogeneous slice) — bind JSON scalar.
enum MssqlParam {
    Null,
    Int(i64),
    Float(f64),
    Bool(bool),
    Str(String),
}

impl MssqlParam {
    fn from_json(v: &Value) -> Self {
        match v {
            Value::Null => MssqlParam::Null,
            Value::Bool(b) => MssqlParam::Bool(*b),
            Value::Number(n) if n.is_i64() => MssqlParam::Int(n.as_i64().unwrap()),
            Value::Number(n) if n.is_u64() => MssqlParam::Int(n.as_u64().unwrap() as i64),
            Value::Number(n) => MssqlParam::Float(n.as_f64().unwrap()),
            Value::String(s) => MssqlParam::Str(s.clone()),
            other => MssqlParam::Str(other.to_string()),
        }
    }
}

impl tiberius::ToSql for MssqlParam {
    fn to_sql(&self) -> tiberius::ColumnData<'_> {
        use std::borrow::Cow;
        use tiberius::ColumnData;
        match self {
            MssqlParam::Null => ColumnData::String(None),
            MssqlParam::Int(i) => ColumnData::I64(Some(*i)),
            MssqlParam::Float(f) => ColumnData::F64(Some(*f)),
            MssqlParam::Bool(b) => ColumnData::Bit(Some(*b)),
            MssqlParam::Str(s) => ColumnData::String(Some(Cow::Borrowed(s.as_str()))),
        }
    }
}
