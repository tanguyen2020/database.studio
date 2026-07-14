//! O0 live spike — verify the pure-Rust `oracle-rs` driver actually connects to a
//! real Oracle and decodes a dynamic result set into the locked contract.
//! Run against a `gvenzl/oracle-free` container:
//!   docker run -d --name ora-o0 -p 1521:1521 -e ORACLE_PASSWORD=Oracle123 gvenzl/oracle-free:23-slim-faststart
//!   cargo test --test oracle_o0 -- --nocapture --test-threads=1

use database_studio_lib::commands::{admin, schema};
use database_studio_lib::drivers::grid::{self, Col, GridChange, SortSpec};
use database_studio_lib::drivers::oracle::{OracleConnParams, OracleDriver};
use database_studio_lib::drivers::plan;
use database_studio_lib::drivers::types::StatementOutcome;
use serde_json::json;

fn params() -> OracleConnParams {
    OracleConnParams {
        host: "127.0.0.1".into(),
        port: 1521,
        service: "FREEPDB1".into(),
        use_sid: false,
        user: "system".into(),
        password: "Oracle123".into(),
        ssl: false,
        ssl_ca: String::new(),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a live Oracle container (gvenzl/oracle-free) — run with --ignored"]
async fn o0_connect_exec_decode() {
    let mut d = OracleDriver::connect(&params()).await.expect("connect to Oracle");

    // Idempotent drop (ignore "table does not exist").
    let _ = d
        .exec("BEGIN EXECUTE IMMEDIATE 'DROP TABLE o0_t'; EXCEPTION WHEN OTHERS THEN NULL; END;")
        .await;

    d.exec("CREATE TABLE o0_t (id NUMBER, name VARCHAR2(50), amount NUMBER(10,2), created DATE)")
        .await
        .expect("create table");

    let ins = d
        .exec("INSERT INTO o0_t (id, name, amount, created) VALUES (1, 'Ann', 12.50, DATE '2026-01-02')")
        .await
        .expect("insert");
    assert!(matches!(ins, StatementOutcome::Affected { affected: 1 }), "insert affected 1, got {ins:?}");

    let out = d
        .exec("SELECT id, name, amount, created FROM o0_t ORDER BY id")
        .await
        .expect("select");

    match out {
        StatementOutcome::Rows { result } => {
            println!("cols = {:?}", result.cols);
            println!("row0 = {}", serde_json::to_string(&result.rows[0]).unwrap());
            assert_eq!(result.total, 1, "one row");
            assert_eq!(result.cols.len(), 4, "four columns");
            let row = &result.rows[0];
            assert_eq!(row["NAME"], serde_json::json!("Ann"));
            // NUMBER(10,2) keeps full precision (string), integer NUMBER may be int/number.
            let amount = row["AMOUNT"].to_string();
            assert!(amount.contains("12.5"), "amount decoded: {amount}");
            // DATE decodes to a non-empty string.
            assert!(row["CREATED"].as_str().map(|s| !s.is_empty()).unwrap_or(false), "created decoded: {}", row["CREATED"]);
        }
        other => panic!("expected Rows, got {other:?}"),
    }

    // FETCH FIRST paging (the dialect form the frontend generates for Oracle).
    let paged = d.exec("SELECT id FROM o0_t FETCH FIRST 1 ROWS ONLY").await.expect("fetch first");
    assert!(matches!(paged, StatementOutcome::Rows { .. }), "FETCH FIRST returns rows");

    let _ = d.exec("DROP TABLE o0_t").await;
    println!("O0 LIVE OK — connect + DDL + DML + dynamic decode + FETCH FIRST verified");
}

/// O1: real introspection (ALL_* catalog views) against a seeded schema.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a live Oracle container (gvenzl/oracle-free) — run with --ignored"]
async fn o1_introspection() {
    let mut d = OracleDriver::connect(&params()).await.expect("connect");
    let drop_user = "BEGIN EXECUTE IMMEDIATE 'DROP USER appo1 CASCADE'; EXCEPTION WHEN OTHERS THEN NULL; END;";
    let _ = d.exec(drop_user).await;

    for sql in [
        "CREATE USER appo1 IDENTIFIED BY Appo1Pw123",
        "ALTER USER appo1 QUOTA UNLIMITED ON USERS",
        "CREATE TABLE appo1.dept (id NUMBER PRIMARY KEY, name VARCHAR2(50) NOT NULL)",
        "CREATE TABLE appo1.emp (id NUMBER PRIMARY KEY, dept_id NUMBER, sal NUMBER(10,2) DEFAULT 0, CONSTRAINT emp_dept_fk FOREIGN KEY (dept_id) REFERENCES appo1.dept(id))",
        "CREATE INDEX appo1.emp_sal_ix ON appo1.emp (sal)",
        "CREATE VIEW appo1.v_emp AS SELECT id, sal FROM appo1.emp",
        "CREATE SEQUENCE appo1.emp_seq START WITH 1 INCREMENT BY 1",
        "CREATE OR REPLACE TRIGGER appo1.emp_bi BEFORE INSERT ON appo1.emp FOR EACH ROW BEGIN NULL; END;",
        "CREATE OR REPLACE FUNCTION appo1.f_double(n NUMBER) RETURN NUMBER AS BEGIN RETURN n*2; END;",
        "CREATE OR REPLACE PROCEDURE appo1.p_noop AS BEGIN NULL; END;",
        "CREATE TABLE appo1.sales (id NUMBER, sold DATE) PARTITION BY RANGE (sold) (PARTITION p2025 VALUES LESS THAN (DATE '2026-01-01'), PARTITION pmax VALUES LESS THAN (MAXVALUE))",
    ] {
        d.exec(sql).await.unwrap_or_else(|e| panic!("setup failed [{sql}]: {}", e.message));
    }

    let schemas = d.schemas().await.expect("schemas");
    assert!(schemas.iter().any(|s| s.name == "APPO1"), "APPO1 in schemas: {schemas:?}");

    let tables = d.tables("APPO1").await.expect("tables");
    assert!(tables.iter().any(|t| t.name == "EMP" && t.kind == "table"), "EMP table: {tables:?}");
    assert!(tables.iter().any(|t| t.name == "V_EMP" && t.kind == "view"), "V_EMP view");

    let cols = d.columns("APPO1", "EMP").await.expect("columns");
    assert!(cols.iter().find(|c| c.name == "ID").expect("ID col").is_pk, "ID is PK");
    assert!(cols.iter().find(|c| c.name == "DEPT_ID").expect("DEPT_ID").is_fk, "DEPT_ID is FK");
    let sal = cols.iter().find(|c| c.name == "SAL").expect("SAL");
    assert_eq!(sal.data_type, "NUMBER(10,2)", "SAL type built");
    assert!(sal.default.as_deref().map(|d| d.contains('0')).unwrap_or(false), "SAL default (LONG via crate A): {:?}", sal.default);

    let idx = d.indexes("APPO1", "EMP").await.expect("indexes");
    assert!(idx.iter().any(|i| i.name == "EMP_SAL_IX" && i.columns == vec!["SAL"]), "EMP_SAL_IX: {idx:?}");
    assert!(idx.iter().any(|i| i.primary), "a primary index present");

    let cons = d.constraints("APPO1", "EMP").await.expect("constraints");
    assert!(cons.iter().any(|c| c.kind == "PK"), "PK constraint");
    assert!(cons.iter().any(|c| c.kind == "FK"), "FK constraint");

    let fks = d.foreign_keys("APPO1").await.expect("fks");
    assert!(
        fks.iter().any(|f| f.from_table == "EMP" && f.from_column == "DEPT_ID" && f.to_table == "DEPT" && f.to_column == "ID"),
        "EMP.DEPT_ID → DEPT.ID: {fks:?}"
    );

    assert!(d.sequences("APPO1").await.expect("seq").iter().any(|s| s.name == "EMP_SEQ"), "EMP_SEQ");
    assert!(d.triggers("APPO1").await.expect("trg").iter().any(|t| t.name == "EMP_BI" && t.table == "EMP"), "EMP_BI");

    let rt = d.routines("APPO1").await.expect("routines");
    let f = rt.iter().find(|r| r.name == "F_DOUBLE" && r.kind == "function").expect("F_DOUBLE fn");
    assert_eq!(f.params.len(), 1, "F_DOUBLE has 1 param: {:?}", f.params);
    assert_eq!(f.params[0].name, "N", "param name");
    assert!(f.return_type.is_some(), "F_DOUBLE return type: {:?}", f.return_type);
    assert!(rt.iter().any(|r| r.name == "P_NOOP" && r.kind == "procedure"), "P_NOOP proc");
    assert!(d.functions("APPO1").await.expect("fns").iter().any(|f| f.name == "F_DOUBLE"), "F_DOUBLE in functions");

    // Show Definition — DBMS_METADATA.GET_DDL returns a CLOB (verify inline decode).
    let ddl_sql = schema::definition_query("oracle", "view", "APPO1", "V_EMP").expect("def sql");
    match d.exec(&ddl_sql).await.expect("get_ddl") {
        StatementOutcome::Rows { result } => {
            let cell = result.rows.first().and_then(|r| r.as_object()).and_then(|o| o.values().next()).and_then(|v| v.as_str()).unwrap_or("");
            assert!(cell.to_uppercase().contains("V_EMP"), "view DDL from GET_DDL (CLOB): {cell:?}");
        }
        o => panic!("expected DDL rows: {o:?}"),
    }

    let parts = d.partitions("APPO1", "SALES").await.expect("partitions");
    assert_eq!(parts.len(), 2, "two partitions: {parts:?}");
    assert!(parts.iter().all(|p| p.method == "RANGE"), "RANGE method");
    assert_eq!(parts[0].key.as_deref(), Some("SOLD"), "partition key SOLD");
    assert!(parts.iter().any(|p| p.expression.is_some()), "partition bound (HIGH_VALUE/LONG via crate A): {parts:?}");

    let scan = d.scan_indexes("APPO1").await.expect("scan");
    assert!(scan.iter().any(|i| i.name == "EMP_SAL_IX" && i.valid), "EMP_SAL_IX scanned valid: {scan:?}");

    let _ = d.exec(drop_user).await;
    println!("O1 INTROSPECTION OK — schemas/tables/columns/indexes/constraints/FKs/sequences/triggers/routines/functions/partitions/scan verified");
}

/// O2: editable grid (apply_changes) + FETCH paging + query plan + admin.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a live Oracle container (gvenzl/oracle-free) — run with --ignored"]
async fn o2_grid_plan_admin() {
    let mut d = OracleDriver::connect(&params()).await.expect("connect");
    let _ = d.exec("BEGIN EXECUTE IMMEDIATE 'DROP TABLE o2_t'; EXCEPTION WHEN OTHERS THEN NULL; END;").await;
    d.exec("CREATE TABLE o2_t (id NUMBER PRIMARY KEY, name VARCHAR2(50))").await.expect("create");

    let col = |n: &str, v: serde_json::Value| Col { name: n.into(), value: v, col_type: None };
    let ins = |id: i64, name: &str| GridChange::Insert {
        schema: Some("SYSTEM".into()),
        table: "O2_T".into(),
        values: vec![col("ID", json!(id)), col("NAME", json!(name))],
    };
    assert_eq!(d.apply_changes(&[ins(1, "Ann"), ins(2, "Bob")]).await.expect("insert"), 2, "2 inserted");

    let upd = GridChange::Update {
        schema: Some("SYSTEM".into()),
        table: "O2_T".into(),
        pk: vec![col("ID", json!(1))],
        set: vec![col("NAME", json!("Ann2"))],
    };
    assert_eq!(d.apply_changes(&[upd]).await.expect("update"), 1, "1 updated");

    let del = GridChange::Delete { schema: Some("SYSTEM".into()), table: "O2_T".into(), pk: vec![col("ID", json!(2))] };
    assert_eq!(d.apply_changes(&[del]).await.expect("delete"), 1, "1 deleted");

    match d.exec("SELECT id, name FROM o2_t").await.expect("select") {
        StatementOutcome::Rows { result } => {
            assert_eq!(result.total, 1, "one row left");
            assert_eq!(result.rows[0]["NAME"], json!("Ann2"), "update applied");
        }
        o => panic!("expected rows: {o:?}"),
    }

    // build_select → Oracle FETCH paging, bound params.
    let bs = grid::build_select("oracle", &Some("SYSTEM".into()), "O2_T", &[], false, &[SortSpec { col: "ID".into(), desc: false }], 10, 0);
    assert!(bs.sql.contains("FETCH NEXT 10 ROWS ONLY"), "FETCH paging: {}", bs.sql);
    assert!(matches!(d.exec_params(&bs.sql, &bs.params).await.expect("paged select"), StatementOutcome::Rows { .. }));

    // EXPLAIN PLAN → PLAN_TABLE → parse_oracle.
    let _ = d.exec("DELETE FROM plan_table WHERE statement_id = 't2'").await;
    d.exec("EXPLAIN PLAN SET STATEMENT_ID = 't2' FOR SELECT * FROM o2_t WHERE id = 1").await.expect("explain plan");
    match d
        .exec("SELECT id, parent_id, operation AS op, options AS opts, object_name AS obj, cardinality AS card, cost AS cost FROM plan_table WHERE statement_id = 't2' ORDER BY id")
        .await
        .expect("read plan")
    {
        StatementOutcome::Rows { result } => {
            let qp = plan::parse_oracle(&result.rows);
            let root = qp.root.expect("plan root");
            println!("plan root op = {} (native {})", root.operation, root.native_op);
            assert!(!root.children.is_empty() || !root.native_op.is_empty(), "plan has structure");
        }
        o => panic!("expected plan rows: {o:?}"),
    }

    // Admin: sessions query exposes a `pid` column; kill block runs (no-op on bogus sid).
    let sess_sql = admin::admin_query("oracle", "sessions").expect("sessions sql");
    match d.exec(&sess_sql).await.expect("sessions") {
        StatementOutcome::Rows { result } => {
            assert!(result.cols.iter().any(|(n, _)| n == "pid"), "pid column present: {:?}", result.cols);
        }
        o => panic!("expected session rows: {o:?}"),
    }
    let kill = admin::kill_query("oracle", 999_999).expect("kill sql");
    d.exec(&kill).await.expect("kill block runs");

    let _ = d.exec("DROP TABLE o2_t").await;
    println!("O2 OK — grid apply (insert/update/delete) + FETCH paging + EXPLAIN PLAN parse + admin sessions/kill verified");
}

/// Crate-A pivot: verify result sets are NOT truncated (oracle-rs capped at ~100).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a live Oracle container (gvenzl/oracle-free) + Instant Client — run with --ignored"]
async fn a_full_resultset_no_100_cap() {
    let mut d = OracleDriver::connect(&params()).await.expect("connect");
    let _ = d.exec("BEGIN EXECUTE IMMEDIATE 'DROP TABLE a_big'; EXCEPTION WHEN OTHERS THEN NULL; END;").await;
    d.exec("CREATE TABLE a_big (id NUMBER, name VARCHAR2(20))").await.expect("create");
    d.exec("INSERT INTO a_big SELECT LEVEL, 'r' || LEVEL FROM DUAL CONNECT BY LEVEL <= 2500").await.expect("seed");
    let _ = d.exec("COMMIT").await;
    match d.exec("SELECT id, name FROM a_big ORDER BY id").await.expect("select") {
        StatementOutcome::Rows { result } => {
            assert_eq!(result.total, 2500, "crate A returns the full result set (no 100-row cap)");
            assert_eq!(result.rows[0]["ID"], serde_json::json!("1"));
            assert_eq!(result.rows[2499]["NAME"], serde_json::json!("r2500"));
        }
        o => panic!("expected rows: {o:?}"),
    }
    let _ = d.exec("DROP TABLE a_big").await;
    println!("A OK — full 2500-row result set returned (100-row cap gone)");
}
