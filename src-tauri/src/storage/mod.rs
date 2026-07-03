//! Internal application storage (connections / tabs / query history).
//!
//! Uses `rusqlite` purely as the app's own persistence layer. This is
//! deliberately separate from `drivers::sqlite`, which connects to *user*
//! SQLite databases — the two roles must never be mixed.

pub mod crypto;

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::connections::profile::ConnectionProfile;
use crate::error::{AppError, AppResult};

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
            sqlite_path: String::new(),
            sqlite_mode: SqliteMode::ReadWrite,
            mssql_auth: String::new(),
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
