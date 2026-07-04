//! Internal application storage (connections / tabs / query history).
//!
//! Uses `rusqlite` purely as the app's own persistence layer. This is
//! deliberately separate from `drivers::sqlite`, which connects to *user*
//! SQLite databases — the two roles must never be mixed.

pub mod crypto;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::connections::profile::ConnectionProfile;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub connection_id: String,
    pub system: String,
    pub sql: String,
    pub duration_ms: Option<i64>,
    pub row_count: Option<i64>,
    pub ok: bool,
    pub error: Option<String>,
    pub executed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub system: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

pub struct Storage {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS connections (
    id          TEXT PRIMARY KEY,
    profile     TEXT NOT NULL,             -- JSON ConnectionProfile (password encrypted)
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tabs (
    id          TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,             -- JSON tab state (connectionId, type, title, query, ...)
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_pinned   INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS query_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    system        TEXT NOT NULL,
    sql           TEXT NOT NULL,
    duration_ms   INTEGER,
    row_count     INTEGER,
    ok            INTEGER NOT NULL DEFAULT 1,
    error         TEXT,
    executed_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_conn ON query_history(connection_id, executed_at DESC);

CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snippets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sql         TEXT NOT NULL,
    system      TEXT,               -- optional dialect hint
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

impl Storage {
    pub fn open(dir: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Other(format!("cannot create data dir: {e}")))?;
        let conn = Connection::open(dir.join("studio.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ---- connections -------------------------------------------------------

    pub fn list_connections(&self) -> AppResult<Vec<ConnectionProfile>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT profile FROM connections ORDER BY sort_order, created_at")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            let json = row?;
            let profile: ConnectionProfile = serde_json::from_str(&json)
                .map_err(|e| AppError::Other(format!("corrupt profile row: {e}")))?;
            out.push(profile);
        }
        Ok(out)
    }

    pub fn get_connection(&self, id: &str) -> AppResult<ConnectionProfile> {
        let conn = self.conn.lock().unwrap();
        let json: String = conn
            .query_row("SELECT profile FROM connections WHERE id = ?1", params![id], |r| r.get(0))
            .map_err(|_| AppError::ConnectionNotFound(id.to_string()))?;
        serde_json::from_str(&json).map_err(|e| AppError::Other(format!("corrupt profile row: {e}")))
    }

    pub fn save_connection(&self, profile: &ConnectionProfile) -> AppResult<()> {
        let json = serde_json::to_string(profile)
            .map_err(|e| AppError::Other(format!("serialize profile: {e}")))?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO connections (id, profile) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET profile = ?2, updated_at = datetime('now')",
            params![profile.id, json],
        )?;
        Ok(())
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM connections WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- tabs --------------------------------------------------------------

    pub fn replace_tabs(&self, tabs: &[(String, String, i64, bool)]) -> AppResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM tabs", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO tabs (id, payload, sort_order, is_pinned) VALUES (?1, ?2, ?3, ?4)",
            )?;
            for (id, payload, order, pinned) in tabs {
                stmt.execute(params![id, payload, order, *pinned as i64])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_tabs(&self) -> AppResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT payload FROM tabs ORDER BY is_pinned DESC, sort_order")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // ---- query history ------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn add_history(
        &self,
        connection_id: &str,
        system: &str,
        sql: &str,
        duration_ms: Option<u64>,
        row_count: Option<u64>,
        ok: bool,
        error: Option<&str>,
    ) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO query_history (connection_id, system, sql, duration_ms, row_count, ok, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                connection_id,
                system,
                sql,
                duration_ms.map(|v| v as i64),
                row_count.map(|v| v as i64),
                ok as i64,
                error
            ],
        )?;
        Ok(())
    }

    // ---- query history (Ctrl+H panel) ---------------------------------------

    /// Lịch sử query, mới nhất trước. `search` lọc theo SQL (substring, không
    /// phân biệt hoa/thường); `conn_id` None = tất cả connection.
    pub fn list_history(
        &self,
        conn_id: Option<&str>,
        search: Option<&str>,
        limit: i64,
    ) -> AppResult<Vec<HistoryEntry>> {
        let conn = self.conn.lock().unwrap();
        let like = search.map(|s| format!("%{}%", s.replace('%', "\\%").replace('_', "\\_")));
        let mut sql = String::from(
            "SELECT connection_id, system, sql, duration_ms, row_count, ok, error, executed_at
             FROM query_history",
        );
        let mut clauses = Vec::new();
        if conn_id.is_some() {
            clauses.push("connection_id = ?1");
        }
        if like.is_some() {
            clauses.push(if conn_id.is_some() { "sql LIKE ?2 ESCAPE '\\'" } else { "sql LIKE ?1 ESCAPE '\\'" });
        }
        if !clauses.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(" AND "));
        }
        sql.push_str(" ORDER BY executed_at DESC, id DESC LIMIT ");
        sql.push_str(&limit.to_string());

        let mut stmt = conn.prepare(&sql)?;
        let map_row = |r: &rusqlite::Row| -> rusqlite::Result<HistoryEntry> {
            Ok(HistoryEntry {
                connection_id: r.get(0)?,
                system: r.get(1)?,
                sql: r.get(2)?,
                duration_ms: r.get(3)?,
                row_count: r.get(4)?,
                ok: r.get::<_, i64>(5)? != 0,
                error: r.get(6)?,
                executed_at: r.get(7)?,
            })
        };
        let rows = match (conn_id, &like) {
            (Some(c), Some(l)) => stmt.query_map(params![c, l], map_row)?.collect::<Result<Vec<_>, _>>(),
            (Some(c), None) => stmt.query_map(params![c], map_row)?.collect::<Result<Vec<_>, _>>(),
            (None, Some(l)) => stmt.query_map(params![l], map_row)?.collect::<Result<Vec<_>, _>>(),
            (None, None) => stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>(),
        }?;
        Ok(rows)
    }

    // ---- snippets (Ctrl+S saved queries) ------------------------------------

    pub fn list_snippets(&self) -> AppResult<Vec<Snippet>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, sql, system, updated_at FROM snippets ORDER BY updated_at DESC")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Snippet {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    sql: r.get(2)?,
                    system: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn save_snippet(&self, s: &Snippet) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO snippets (id, name, sql, system) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = ?2, sql = ?3, system = ?4, updated_at = datetime('now')",
            params![s.id, s.name, s.sql, s.system],
        )?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- app state (key/value) ----------------------------------------------

    pub fn get_state(&self, key: &str) -> AppResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM app_state WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn set_state(&self, key: &str, value: &str) -> AppResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::profile::{ConnectionProfile, Environment, SqliteMode, SshConfig};
    use crate::drivers::types::SystemType;

    fn profile(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.into(),
            name: name.into(),
            system: SystemType::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: "db".into(),
            user: "u".into(),
            password_enc: "ct".into(),
            group: "Dev".into(),
            env: Environment::Development,
            ssh: SshConfig::default(),
            ssl: false,
            ssl_ca: String::new(),
            ssl_cert: String::new(),
            ssl_key: String::new(),
            sqlite_path: String::new(),
            sqlite_mode: SqliteMode::ReadWrite,
            mssql_auth: String::new(),
            schema_registry_url: String::new(),
            cassandra_dc: String::new(),
            cassandra_consistency: String::new(),
        }
    }

    #[test]
    fn connection_crud_round_trip() {
        let s = Storage::open_in_memory().unwrap();
        s.save_connection(&profile("c1", "Prod PG")).unwrap();
        s.save_connection(&profile("c2", "Dev PG")).unwrap();
        assert_eq!(s.list_connections().unwrap().len(), 2);
        assert_eq!(s.get_connection("c1").unwrap().name, "Prod PG");

        // upsert giữ nguyên id, đổi name
        s.save_connection(&profile("c1", "Renamed")).unwrap();
        assert_eq!(s.list_connections().unwrap().len(), 2);
        assert_eq!(s.get_connection("c1").unwrap().name, "Renamed");

        s.delete_connection("c1").unwrap();
        assert_eq!(s.list_connections().unwrap().len(), 1);
        assert!(s.get_connection("c1").is_err());
    }

    #[test]
    fn profile_serde_preserves_sqlite_fields() {
        let mut p = profile("c1", "SQLite local");
        p.system = SystemType::Sqlite;
        p.sqlite_path = "D:/data/local.db".into();
        p.sqlite_mode = SqliteMode::ReadOnly;
        let s = Storage::open_in_memory().unwrap();
        s.save_connection(&p).unwrap();
        let back = s.get_connection("c1").unwrap();
        assert_eq!(back.sqlite_path, "D:/data/local.db");
        assert_eq!(back.sqlite_mode, SqliteMode::ReadOnly);
    }

    #[test]
    fn tabs_replace_and_ordering_pinned_first() {
        let s = Storage::open_in_memory().unwrap();
        s.replace_tabs(&[
            ("t1".into(), r#"{"title":"a"}"#.into(), 0, false),
            ("t2".into(), r#"{"title":"b"}"#.into(), 1, true),
            ("t3".into(), r#"{"title":"c"}"#.into(), 2, false),
        ])
        .unwrap();
        let tabs = s.list_tabs().unwrap();
        assert_eq!(tabs.len(), 3);
        // pinned trước (spec: restore pinned tabs trước)
        assert_eq!(tabs[0], r#"{"title":"b"}"#);

        // replace toàn bộ
        s.replace_tabs(&[("t9".into(), r#"{"title":"z"}"#.into(), 0, false)]).unwrap();
        assert_eq!(s.list_tabs().unwrap().len(), 1);
    }

    #[test]
    fn history_and_app_state() {
        let s = Storage::open_in_memory().unwrap();
        s.add_history("c1", "postgres", "SELECT 1", Some(12), Some(1), true, None).unwrap();
        s.add_history("c1", "postgres", "SELEC 1", None, None, false, Some("syntax error"))
            .unwrap();

        assert_eq!(s.get_state("theme").unwrap(), None);
        s.set_state("theme", "dark").unwrap();
        s.set_state("theme", "light").unwrap(); // upsert
        assert_eq!(s.get_state("theme").unwrap().as_deref(), Some("light"));
    }
}
